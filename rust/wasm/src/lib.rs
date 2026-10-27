//! WASM 构建版的 AST 改写逻辑，供浏览器端 intercept.js 同步调用。
//!
//! 与 `rust/src/rewrite.rs` 中的 `rewrite_ast_in_js` 逻辑完全一致：
//! 用 oxc 解析 JS，改写 `this` 和 7 个作用域标识符（location/window/self/
//! globalThis/document/parent/top）的未绑定全局引用。
//!
//! 编译：`cargo build --release --target wasm32-unknown-unknown`
//! 产物部署到 `public/rewrite.wasm`，由 intercept.js 同步 XHR 加载。

use oxc_allocator::Allocator;
use oxc_ast::ast::{IdentifierReference, ThisExpression};
use oxc_ast_visit::Visit;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::{IsGlobalReference, SemanticBuilder};
use oxc_span::SourceType;

/// 需要改写的 7 个作用域标识符及其替换文本。
/// 与 `rust/src/rewrite.rs` 中的 SCOPE_NAMES 保持一致。
const SCOPE_NAMES: &[(&str, &str)] = &[
    ("location", "__location__"),
    ("window", "__window__"),
    ("self", "__self__"),
    ("globalThis", "__globalThis__"),
    ("document", "__document__"),
    ("parent", "__parent__"),
    ("top", "__top__"),
];

/// `this` 的替换文本。
/// 比较对象用 globalThis 而非 self：裸 `self` 会被局部变量遮蔽
/// （如 jQuery find 里 `var self = this`，导致 this === self 恒真、
/// this 全部错误路由到 __self__）。与 rewrite.rs 的 THIS_REPLACEMENT 保持一致。
const THIS_REPLACEMENT: &str = "(this === globalThis ? __self__ : this)";

struct RewriteCollector {
    spans: Vec<(u32, u32, &'static str)>,
    scoping: *const oxc_semantic::Scoping,
}

// SAFETY: Scoping 在 rewrite_ast_in_js 中存活于整个 visit_program 期间，
// collector 单线程使用，不存在并发访问。
unsafe impl Send for RewriteCollector {}
unsafe impl Sync for RewriteCollector {}

impl<'a> Visit<'a> for RewriteCollector {
    fn visit_this_expression(&mut self, it: &ThisExpression) {
        self.spans.push((it.span.start, it.span.end, THIS_REPLACEMENT));
        oxc_ast_visit::walk::walk_this_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let name = it.name.as_str();
        if let Some(&(_, replacement)) = SCOPE_NAMES.iter().find(|(n, _)| *n == name) {
            let is_global = if self.scoping.is_null() {
                false
            } else {
                // SAFETY: scoping 在 visit 期间存活，且单线程访问
                let scoping = unsafe { &*self.scoping };
                it.is_global_reference(scoping)
            };
            if is_global {
                self.spans.push((it.span.start, it.span.end, replacement));
            }
        }
        oxc_ast_visit::walk::walk_identifier_reference(self, it);
    }
}

/// 用 oxc 解析单段 JS 代码，同时改写 this 和 7 个作用域标识符。
/// 解析失败时返回 None。
///
/// 与 `rust/src/rewrite.rs:rewrite_ast_in_js` 逻辑完全一致。
fn rewrite_ast_in_js(code: &str) -> Option<String> {
    // 快速跳过：不含任何需改写的关键字时无需启动 oxc
    if !code.contains("this") && SCOPE_NAMES.iter().all(|(n, _)| !code.contains(n)) {
        return Some(code.to_string());
    }

    let allocator = Allocator::default();
    let source_type = SourceType::script();
    let options = ParseOptions {
        allow_return_outside_function: true,
        ..ParseOptions::default()
    };
    let ret = Parser::new(&allocator, code, source_type).with_options(options).parse();

    if ret.fatal_error {
        return None;
    }

    let program = &ret.program;

    let semantic_ret = SemanticBuilder::new().with_build_nodes(false).build(program);
    let scoping = semantic_ret.semantic.scoping();

    let mut collector = RewriteCollector {
        spans: Vec::new(),
        scoping: scoping as *const _,
    };
    collector.visit_program(program);

    let mut spans = collector.spans.clone();
    spans.sort_by_key(|&(s, _, _)| s);
    spans.dedup_by(|a, b| a.0 == b.0);

    if spans.is_empty() {
        return Some(code.to_string());
    }

    let mut out = String::with_capacity(code.len() + spans.len() * 30);
    let mut cursor: usize = 0;
    for (start, end, replacement) in spans {
        let s = start as usize;
        let e = end as usize;
        if s < cursor || e < s || e > code.len() {
            continue;
        }
        out.push_str(&code[cursor..s]);
        out.push_str(replacement);
        cursor = e;
    }
    out.push_str(&code[cursor..]);
    Some(out)
}

/// 输入缓冲区：JS 端通过 `alloc_input(len)` 获取指针，然后用
/// `new Uint8Array(memory.buffer, ptr, len).set(bytes)` 写入输入字符串。
/// `rewrite_js` 读取此缓冲区。
use std::cell::UnsafeCell;
use std::sync::OnceLock;

struct InputBuf(UnsafeCell<Vec<u8>>);

// SAFETY: WASM 单线程环境，无并发竞争。
unsafe impl Sync for InputBuf {}

static INPUT_BUF: OnceLock<InputBuf> = OnceLock::new();

fn input_buf() -> &'static InputBuf {
    INPUT_BUF.get_or_init(|| InputBuf(UnsafeCell::new(Vec::new())))
}

/// 分配输入缓冲区，返回指向 WASM 线性内存的指针。
/// JS 端写入输入字符串后调用 `rewrite_js(ptr, len)`。
///
/// 每次调用会复用/扩容同一个缓冲区，避免反复分配。
///
/// # Safety
/// WASM 单线程环境，无并发竞争。调用方必须在下一次 `alloc_input` 之前
/// 用完返回的指针（指针指向 Vec 内部缓冲区，Vec 扩容后旧指针失效）。
#[unsafe(no_mangle)]
pub extern "C" fn alloc_input(len: usize) -> *mut u8 {
    let buf = input_buf();
    // SAFETY: WASM 单线程，无并发访问
    let v = unsafe { &mut *buf.0.get() };
    if v.len() < len {
        v.resize(len, 0);
    }
    v.as_mut_ptr()
}

/// WASM 导出：改写 JS 代码。
///
/// 输入：`ptr` 指向 WASM 线性内存中的 UTF-8 字符串（通常由 `alloc_input` 返回），
///       `len` 为字节长度。
/// 输出：u64，低 32 位为结果字符串的指针，高 32 位为字节长度。
///       返回 0 表示解析失败（调用方应回退到原样执行）。
///
/// 调用方负责用 `free_wasm(ptr, len)` 释放结果内存。
///
/// # Safety
/// `ptr` 必须指向有效的 UTF-8 字符串，长度为 `len`。
#[unsafe(no_mangle)]
pub extern "C" fn rewrite_js(ptr: *const u8, len: usize) -> u64 {
    if ptr.is_null() || len == 0 {
        // 空输入：返回空结果（ptr=1, len=0）。JS 侧检查 resultLen===0 返回 ''。
        // ptr=1 不会是 0（失败标记），且 JS 侧不会在 len=0 时解引用 ptr。
        return 1;
    }
    let code = unsafe { std::slice::from_raw_parts(ptr, len) };
    let code = match std::str::from_utf8(code) {
        Ok(s) => s,
        Err(_) => return 0,
    };

    match rewrite_ast_in_js(code) {
        Some(result) => {
            let boxed = result.into_bytes();
            let result_len = boxed.len();
            let result_ptr = Box::into_raw(boxed.into_boxed_slice()) as *const u8;
            if result_ptr.is_null() {
                return 0;
            }
            (result_ptr as u64) | ((result_len as u64) << 32)
        }
        None => 0,
    }
}

/// 释放 WASM 内存中由 `rewrite_js` 返回的字符串。
///
/// # Safety
/// `ptr` 和 `len` 必须与 `rewrite_js` 返回的值匹配。
#[unsafe(no_mangle)]
pub extern "C" fn free_wasm(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let _ = Box::from_raw(std::slice::from_raw_parts_mut(ptr, len));
        }
    }
}

/// 诊断用：返回 1 表示 oxc 可正常解析，0 表示失败。
#[unsafe(no_mangle)]
pub extern "C" fn test_parse() -> u32 {
    let allocator = Allocator::default();
    let source = "var x = 1; this; location;";
    let source_type = SourceType::script();
    let ret = Parser::new(&allocator, source, source_type).parse();
    if ret.fatal_error { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite(code: &str) -> String {
        rewrite_ast_in_js(code).unwrap_or_else(|| code.to_string())
    }

    #[test]
    fn test_this_replacement() {
        assert_eq!(rewrite("this"), THIS_REPLACEMENT);
        assert_eq!(rewrite("return this.x"), "return (this === globalThis ? __self__ : this).x");
    }

    #[test]
    fn test_this_with_local_self_shadow() {
        // jQuery find 的崩溃场景：局部 var self = this。
        // 注入的比较引用必须是 globalThis，不能被局部 self 遮蔽。
        let out = rewrite("var self = this; ret = this.pushStack('')");
        assert!(out.contains("var self = (this === globalThis ? __self__ : this)"), "got: {out}");
        assert!(out.contains("ret = (this === globalThis ? __self__ : this).pushStack('')"), "got: {out}");
    }

    #[test]
    fn test_scope_identifiers() {
        assert_eq!(rewrite("location.href"), "__location__.href");
        assert_eq!(rewrite("window.open"), "__window__.open");
        assert_eq!(rewrite("self.x"), "__self__.x");
        assert_eq!(rewrite("document.title"), "__document__.title");
        // parent/top 是全局引用，会被改写；后面的 .location 是属性访问，不改写
        assert_eq!(rewrite("parent.location"), "__parent__.location");
        assert_eq!(rewrite("top.location"), "__top__.location");
        assert_eq!(rewrite("globalThis.x"), "__globalThis__.x");
    }

    #[test]
    fn test_local_variables_not_rewritten() {
        assert_eq!(rewrite("var top = 5; top"), "var top = 5; top");
        assert_eq!(rewrite("var location = 1; location"), "var location = 1; location");
    }

    #[test]
    fn test_no_change_needed() {
        assert_eq!(rewrite("var x = 1"), "var x = 1");
        assert_eq!(rewrite("console.log(42)"), "console.log(42)");
    }

    #[test]
    fn test_member_property_not_rewritten() {
        assert_eq!(rewrite("obj.location"), "obj.location");
        assert_eq!(rewrite("a.window.b"), "a.window.b");
    }

    #[test]
    fn test_combined() {
        // this 改写，location 作为全局引用改写，window 改写
        // this.location 中 .location 是属性访问不改写，window.location 中同理
        let result = rewrite("this.location = window.location");
        assert!(result.contains(THIS_REPLACEMENT));
        assert!(result.contains("__window__"));
    }

    #[test]
    fn test_parse_recovery() {
        // oxc 有激进的错误恢复，大多数语法错误不会返回 fatal_error。
        // 关键是不 panic：返回 Some 或 None 都可接受。
        let _ = rewrite_ast_in_js("function {{{{}}}}");
        let _ = rewrite_ast_in_js("var = ;");
    }
}
