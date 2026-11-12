//! WASM 构建版的 AST 改写逻辑，供浏览器端 intercept.js 同步调用。
//!
//! 与 `rust/src/rewrite.rs` 中的 `rewrite_ast_in_js` 逻辑完全一致：
//! 用 oxc 解析 JS，改写 `this` 和 7 个作用域标识符（location/window/self/
//! globalThis/document/parent/top）的未绑定全局引用。
//!
//! 编译：`cargo build --release --target wasm32-unknown-unknown`
//! 产物部署到 `public/rewrite.wasm`，由 intercept.js 同步 XHR 加载。

use oxc_allocator::Allocator;
use oxc_ast::ast::{CallExpression, IdentifierReference, ThisExpression};
use oxc_ast_visit::Visit;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::{IsGlobalReference, SemanticBuilder};
use oxc_span::{GetSpan, SourceType};

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
    // eval 别名收集（var e = eval / e2 = eval 这类变量别名）：
    // 仅收根作用域绑定、初始化为全局 eval 引用的符号 id。间接 eval 本就在全局
    // 作用域执行、无调用者作用域可破坏，包裹其参数是零语义风险的——只改字符串
    // 内容，由运行时 __rewrite_js__ 补上 this / 标识符伪装。
    eval_alias_symbols: Vec<usize>,
    // 未解析的别名名字（`e2 = eval` 无声明，e2 不产生符号）：按名字匹配
    eval_alias_names: Vec<String>,
    // 被重新赋值 / 更新 / 非_eval 重新声明的符号 → 别名作废（保守）
    dirty_symbols: Vec<usize>,
    // 待定的别名调用点：(SymbolId index | usize::MAX 表示按名字, 名字, 参数 start, 参数 end)。
    // 遍历期间 dirty 状态可能尚未定（赋值可能出现在调用点之后），
    // 遍历结束后统一按别名集合 - dirty 解析。
    pending_alias_calls: Vec<(usize, String, u32, u32)>,
}

// SAFETY: Scoping 在 rewrite_ast_in_js 中存活于整个 visit_program 期间，
// collector 单线程使用，不存在并发访问。
unsafe impl Send for RewriteCollector {}
unsafe impl Sync for RewriteCollector {}

/// 直接 eval 首参包裹函数。机制详解见 rust/src/rewrite.rs 的同名常量。
const EVAL_ARG_WRAPPER: &str = "__rewrite_js__(";

/// 与 rust/src/rewrite.rs 的 INDIRECT_EVAL_OBJECTS / is_eval_callee 保持一致。
const INDIRECT_EVAL_OBJECTS: &[&str] = &["window", "globalThis", "top", "self", "parent"];

/// 判断表达式是否为可静态判定的 eval，与 rewrite.rs 的 is_eval_callee 保持一致。
fn is_eval_callee(callee: &oxc_ast::ast::Expression<'_>, scoping: &oxc_semantic::Scoping) -> bool {
    match callee {
        // 直接 eval：裸全局 eval 标识符
        oxc_ast::ast::Expression::Identifier(id) => {
            id.name.as_str() == "eval" && id.is_global_reference(scoping)
        }
        // 间接 eval：window.eval / globalThis.eval / top.eval / self.eval / parent.eval
        oxc_ast::ast::Expression::StaticMemberExpression(member) => {
            member.property.name.as_str() == "eval"
                && matches!(&member.object, oxc_ast::ast::Expression::Identifier(obj)
                    if INDIRECT_EVAL_OBJECTS.contains(&obj.name.as_str())
                        && obj.is_global_reference(scoping))
        }
        _ => false,
    }
}

impl<'a> Visit<'a> for RewriteCollector {
    fn visit_this_expression(&mut self, it: &ThisExpression) {
        self.spans.push((it.span.start, it.span.end, THIS_REPLACEMENT));
        oxc_ast_visit::walk::walk_this_expression(self, it);
    }

    /// 直接/间接/别名 eval 首参包裹，与 rust/src/rewrite.rs 的 visit_call_expression 一致。
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let scoping = unsafe { &*self.scoping };
        if is_eval_callee(&it.callee, scoping) {
            self.push_eval_arg_spans(it);
        } else if let oxc_ast::ast::Expression::Identifier(id) = &it.callee {
            let name = id.name.as_str();
            if name != "eval" {
                // 符号引用（非全局）：可能是 eval 别名变量
                let sym = scoping.get_reference(id.reference_id()).symbol_id();
                let sym_idx = sym.map(|s| s.index());
                if sym_idx.map_or_else(
                    || self.eval_alias_names.iter().any(|n| n == name),
                    |i| self.eval_alias_symbols.contains(&i),
                ) {
                    // 记录待定调用点，dirty 状态待遍历结束确认
                    if let Some(arg) = it.arguments.first() {
                        if !arg.is_spread() {
                            let span = GetSpan::span(arg);
                            self.pending_alias_calls.push((
                                sym_idx.unwrap_or(usize::MAX),
                                name.to_string(),
                                span.start,
                                span.end,
                            ));
                        }
                    }
                }
            }
        }
        oxc_ast_visit::walk::walk_call_expression(self, it);
    }

    /// eval 别名收集（根作用域 var e = eval / var e = window.eval 等），
    /// 与 rust/src/rewrite.rs 的 visit_variable_declarator 一致。
    fn visit_variable_declarator(&mut self, it: &oxc_ast::ast::VariableDeclarator<'a>) {
        if let (Some(init), oxc_ast::ast::BindingPattern::BindingIdentifier(id)) =
            (&it.init, &it.id)
        {
            let scoping = unsafe { &*self.scoping };
            let init_is_eval = is_eval_callee(init, scoping);
            // 传递赋值链 var g = e：init 是已记录的别名变量
            let init_is_alias = match init {
                oxc_ast::ast::Expression::Identifier(init_id) => {
                    if init_id.name.as_str() == "eval" {
                        false
                    } else {
                        let by_sym = scoping
                            .get_reference(init_id.reference_id())
                            .symbol_id()
                            .map(|s| s.index())
                            .map_or(false, |i| self.eval_alias_symbols.contains(&i));
                        by_sym
                            || self
                                .eval_alias_names
                                .iter()
                                .any(|n| n.as_str() == init_id.name.as_str())
                    }
                }
                _ => false,
            };
            if init_is_eval || init_is_alias {
                if let Some(sym) = id.symbol_id.get() {
                    // 仅根作用域声明的别名（顶层/全局），嵌套作用域的别名
                    // 出界即失效，保守不收
                    if scoping.symbol_scope_id(sym) == scoping.root_scope_id() {
                        self.eval_alias_symbols.push(sym.index());
                    }
                } else {
                    // 未解析符号（极端情况）：按名字记录，配合"名字无局部
                    // 绑定"的调用点检查兜底
                    self.eval_alias_names.push(id.name.as_str().to_string());
                }
            }
        }
        oxc_ast_visit::walk::walk_variable_declarator(self, it);
    }

    /// `e2 = eval`（无 var 声明的全局赋值别名）按名字记录。收集必须在 walk
    /// 之后（walk 中 mark_dirty_if_alias 会按名字清空记录，先 walk 后收集
    /// 才能保留"赋值为 eval"的新值）。与 rewrite.rs 的 visit_assignment_expression 一致。
    fn visit_assignment_expression(&mut self, it: &oxc_ast::ast::AssignmentExpression<'a>) {
        oxc_ast_visit::walk::walk_assignment_expression(self, it);
        if let oxc_ast::ast::Expression::Identifier(init_id) = &it.right {
            let scoping = unsafe { &*self.scoping };
            if init_id.name.as_str() == "eval" && init_id.is_global_reference(scoping) {
                if let Some(oxc_ast::ast::SimpleAssignmentTarget::AssignmentTargetIdentifier(id)) =
                    it.left.as_simple_assignment_target()
                {
                    self.eval_alias_names.push(id.name.as_str().to_string());
                }
            }
        }
    }

    /// `e++` / `--e` / `e += 1` 等更新目标写入别名变量 → 作废
    /// （`e = x` 的赋值目标也走 SimpleAssignmentTarget::AssignmentTargetIdentifier）
    fn visit_simple_assignment_target(&mut self, it: &oxc_ast::ast::SimpleAssignmentTarget<'a>) {
        if let oxc_ast::ast::SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = it {
            self.mark_dirty_if_alias(id);
        }
        oxc_ast_visit::walk::walk_simple_assignment_target(self, it);
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

impl RewriteCollector {
    /// 直接 eval 首参包裹：zero-width 插入 `__rewrite_js__(` 与 `)`
    fn push_eval_arg_spans(&mut self, it: &CallExpression<'_>) {
        if let Some(arg) = it.arguments.first() {
            if arg.is_spread() {
                // eval(...spread) 运行时才展开，无法静态包裹首参，跳过
            } else {
                let span = GetSpan::span(arg);
                let (s, e) = (span.start, span.end);
                self.spans.push((s, s, EVAL_ARG_WRAPPER));
                self.spans.push((e, e, ")"));
            }
        }
    }

    /// 写引用（is_write）→ 别名作废；读引用是正常调用点，已在 visit_call_expression 处理。
    /// 未解析引用（`e2 = x` 的 e2 无符号）按名字作废。
    fn mark_dirty_if_alias(&mut self, id: &IdentifierReference<'_>) {
        let scoping = unsafe { &*self.scoping };
        let name = id.name.as_str();
        match scoping.get_reference(id.reference_id()).symbol_id() {
            Some(sym) => {
                let sym_idx = sym.index();
                if self.eval_alias_symbols.contains(&sym_idx)
                    && scoping.get_reference(id.reference_id()).is_write()
                {
                    self.dirty_symbols.push(sym_idx);
                }
            }
            None => {
                if self.eval_alias_names.iter().any(|n| n == name) {
                    self.eval_alias_names.clear();
                }
            }
        }
    }
}

/// 用 oxc 解析单段 JS 代码，同时改写 this 和 7 个作用域标识符。
/// 解析失败时返回 None。
///
/// 与 `rust/src/rewrite.rs:rewrite_ast_in_js` 逻辑完全一致。
fn rewrite_ast_in_js(code: &str) -> Option<String> {
    // 快速跳过：不含任何需改写的关键字时无需启动 oxc。
    // eval( 改为 eval：别名形态 var e = eval; e('x') 不含 'eval('，
    // 漏判会跳过别名收集（与 rewrite.rs / webvpn.js 保持一致）
    if !code.contains("this")
        && !code.contains("eval")
        && SCOPE_NAMES.iter().all(|(n, _)| !code.contains(n))
    {
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
        eval_alias_symbols: Vec::new(),
        eval_alias_names: Vec::new(),
        dirty_symbols: Vec::new(),
        pending_alias_calls: Vec::new(),
    };
    collector.visit_program(program);

    // 遍历结束后解析别名调用点：别名集合 - 作废集合（赋值可能出现在调用点之后，
    // 保守起见只要存在任何写引用就作废该别名的所有调用点）。
    // 名字匹配（usize::MAX）还需通过"该名字在根作用域有别名记录"这一关，
    // 且存在同名局部符号时不可用名字兜底（避免误包遮蔽变量的调用点）。
    let dirty = std::mem::take(&mut collector.dirty_symbols);
    let pending = std::mem::take(&mut collector.pending_alias_calls);
    for (sym, name, s, e) in pending {
        if sym == usize::MAX {
            // 名字兜底仅当该名字没有任何局部符号绑定（有绑定说明是同名局部
            // 变量的调用点，符号机制已精确区分，不能按名字误包）
            let name_has_local_symbol = (0..scoping.symbols_len())
                .any(|i| scoping.symbol_name(oxc_semantic::SymbolId::new(i)) == name);
            if name_has_local_symbol || !collector.eval_alias_names.iter().any(|n| n.as_str() == name) {
                continue;
            }
        } else if dirty.contains(&sym) {
            continue;
        }
        collector.spans.push((s, s, EVAL_ARG_WRAPPER));
        collector.spans.push((e, e, ")"));
    }

    let mut spans = collector.spans.clone();
    spans.sort_by_key(|&(s, _, _)| s);
    // 零宽插入（eval 参数包裹）与标识符替换可能 start 相同（如 eval(location)），
    // 去重必须按 (start, end) 完整 span
    spans.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);

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

    /*
     * ===== 已标明的遗漏点（机制边界，非实现遗漏）=====
     * 与 rust/src/rewrite.rs tests 末尾的遗漏清单保持一致：
     * 1. 对象别名 obj.eval(x)：obj 为任意表达式时指向静态不可判定，不包裹。
     *    已覆盖的子集：obj 为确证全局引用（window/globalThis/top/self/parent，
     *    且未被局部变量遮蔽）时按间接 eval 包裹（见 INDIRECT_EVAL_OBJECTS）；
     *    var e = window.eval 等成员形式初始化的别名同样收集。
     * 2. 过程传递 function f(g){g(x)}; f(eval)：需过程间分析，不做。
     * 3. 跨 <script> 单元的别名：各单元独立编译，信息物理缺失。
     * 4. setTimeout('字符串') / new Function('字符串') 等隐式 eval：静态不可包裹，
     *    已由运行时包装关闭（intercept.js 主线程 + jsWorkerContextCode worker）。
     * 5. eval(...spread)：运行时才展开，跳过。
     * 残余后果：被 eval 的代码在真实全局执行，location/this 伪装缺失。
     * （window.eval 形态现已覆盖；覆盖任意 window.eval 属性写法仍会破坏
     * 直接 eval 闭包，规范互斥，故残余形态维持不覆盖。）
     */

    /// eval 变量别名：根作用域 var e = eval 后的调用点包裹首参
    #[test]
    fn test_eval_alias_wrapped() {
        for code in [
            "var e = eval; e('location.href');",
            "const e = eval; e('location.href');",
            "e2 = eval; e2('location.href');",
            "var e = eval; var g = e; g('location.href');",
        ] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                out.contains("__rewrite_js__("),
                "eval alias call should be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
    }

    /// 间接 eval（obj.eval 形式）：obj 为确证的全局对象别名时包裹首参
    #[test]
    fn test_indirect_eval_wrapped() {
        for code in [
            "window.eval('location.href');",
            "globalThis.eval('location.href');",
            "top.eval('location.href');",
            "self.eval('location.href');",
            "parent.eval('location.href');",
        ] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                out.contains("eval(__rewrite_js__("),
                "indirect eval should be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
    }

    /// obj 被局部变量遮蔽 / 非 eval 属性：静态不可判定或非 eval，不包裹
    #[test]
    fn test_indirect_eval_shadowed_not_wrapped() {
        for code in [
            "function f(self) { self.eval('x'); } f(window);",
            "var top = {}; top.eval('x');",
            "var obj = {}; obj.eval('x');",
        ] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                !out.contains("__rewrite_js__("),
                "shadowed/non-global obj.eval must not be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
    }

    /// 成员形式初始化的别名：var e = window.eval 等，调用点包裹首参
    #[test]
    fn test_eval_member_alias_wrapped() {
        for code in [
            "var e = window.eval; e('location.href');",
            "const e = globalThis.eval; e('location.href');",
            "var e = top.eval; e('location.href');",
            "var e = self.eval; e('location.href');",
            "var e = parent.eval; e('location.href');",
            "var e = window.eval; var g = e; g('location.href');",
        ] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                out.contains("__rewrite_js__("),
                "member-initialized eval alias call should be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
    }

    /// 别名被重新赋值后作废；同名局部变量遮蔽不包裹
    #[test]
    fn test_eval_alias_reassigned_not_wrapped() {
        for code in [
            "var e = eval; e = console.log; e('x');",
            "var e = eval; e++; e('x');",
            "var e = eval; function f() { var e = function(x){return x}; e('x'); } f();",
        ] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                !out.contains("__rewrite_js__("),
                "reassigned/shadowed alias must not be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
    }
}
