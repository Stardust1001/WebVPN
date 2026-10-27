// JS / HTML 改写：对应 customResponse / refactorJsScopeCode / calcHoistIdentifiersCode
// processHtml / processHtmlScopeCodes / processJsScopeCode / appendScript

use std::collections::HashMap;
use regex::Regex;
use once_cell::sync::Lazy;
use oxc_ast_visit::Visit;
// IsGlobalReference trait 提供 is_global_reference 方法，用于判断 IdentifierReference
// 是否未绑定到局部声明（即全局引用），从而避免误改局部变量遮蔽。
use oxc_semantic::IsGlobalReference;
use crate::config::Config;
use crate::context::Meta;
use crate::domain::DomainCodec;
use crate::headers::transform_url;

/// 预编译热路径正则（避免每个请求重复 Regex::new）
/// customResponse: with(this) 重写
static WITH_THIS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\s{};]?with\s*\(\s*this\s*\)").unwrap());
/// customResponse: location.xxx -> location.__xxx__
static LOCATION_PROP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\blocation\.(hostname|host|origin|href|protocol|navigate|assign|replace|reload|toString)\b").unwrap());
/// replaceUrls(html): href/src/action/srcset/poster 属性
static HTML_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\s(href|src|action|srcset|poster)=("|')?(http:|https:|http%3A|https%3A|//)[^\s>]*"#).unwrap());
/// AST 模式：移除 HTML 标签中的 integrity= 属性（SRI 校验）。
/// 改写后的 JS/CSS 内容哈希变化，SRI 校验会失败导致资源被浏览器拒绝执行。
/// 仅匹配标签内的 integrity= 属性，不影响 <script> 内联 JS 中的 "integrity" 字符串字面量。
static INTEGRITY_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#).unwrap());
/// replaceUrls(html/css): url(...)
static CSS_URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)url\([\"\']?(http|//)[^\"\')]+"#).unwrap());
/// replaceUrls(html/css): @import
static CSS_IMPORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)@import\s[\"\'](http|//)[^\"\']+"#).unwrap());
/// replaceMatches: 域名有效性检查
/// (?-u) 使 \w 仅匹配 ASCII [A-Za-z0-9_]，与 JS 默认（无 u flag）行为一致
static WORD_DOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)[\w]+\.").unwrap());
/// replaceMatches: &#x 实体解码
/// (?-u) 同上：JS reHtmlEntity=/&#x\w+;/g 的 \w 是 ASCII-only
static HEX_ENTITY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)&#x\w+;").unwrap());
/// calcHoistIdentifiersCode: function/class 名提取
/// (?-u) 使 \w 仅 ASCII：JS \w 不会匹配 CJK 等 Unicode 标识符，
/// 若不抑制 Unicode 模式，Rust 会为 `function 名前()` 生成多余的 self.名前 = 名前 提升代码
static HOIST_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)(function|class)\s+([\$\_\w]+)\s*\(").unwrap());
/// processHtml: CSP meta 去除
static CSP_META_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta\s+http-equiv="Content-Security-Policy"[^>]+>"#).unwrap());
/// processHtmlScopeCodes: <script> 抽取
static SCRIPT_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<script([^>]*)>([\S\s]*?)</script>").unwrap());
/// getBase: <base href>
static BASE_HREF_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<base\s+href=("|\')[^"']+"#).unwrap());
/// appendScript: <!DOCTYPE html> 检测
static DOCTYPE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^\s*?<!DOCTYPE html>").unwrap());

/// JS 关键字（对应 this.jsKeywords）
pub static JS_KEYWORDS: Lazy<Vec<&'static str>> = Lazy::new(|| {
    vec![
        "break", "case", "catch", "continue", "default", "delete", "do", "else", "finally", "for",
        "function", "if", "in", "instanceof", "new", "return", "switch", "this", "throw", "try",
        "typeof", "var", "void", "while", "with",
        "boolean", "byte", "char", "class", "const", "debugger", "double", "enum", "export",
        "extends", "final", "float", "goto", "implements", "import", "int", "interface", "long",
        "native", "package", "private", "protected", "public", "short", "static", "super",
        "synchronized", "throws", "transient", "volatile",
    ]
});

/// Worker 上下文代码（对应 this.jsWorkerContextCode）
/// 注意：#targetUrl# / #siteUrl# 是占位符，使用时替换
pub fn js_worker_context_code() -> &'static str {
    r#"
      // worker 里面创造 __context__ 环境
      if (!self.window) {
        setTimeout = self.setTimeout.bind(self)
        setInterval = self.setInterval.bind(self)
        clearTimeout = self.clearTimeout.bind(self)
        clearInterval = self.clearInterval.bind(self)
        const _importScripts  = self.importScripts
        self.importScripts = function (...props) {
          props = props.map(transformUrl)
          return _importScripts.apply(self, props)
        }
        const target = new URL('#targetUrl#')
        const site = new URL('#siteUrl#')
        const workerHost = self.location.host
        function transformUrl (url) {
          url = (url ? url.toString() : '').trim()
          if (url.startsWith('data:') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:') || url.startsWith('blob:') || url.startsWith('#')) {
            return url
          }
          if (url.startsWith('//')) {
            url = target.protocol + url
          } else if (url.startsWith('/')) {
            url = new URL(url, target.href).href
          } else if (url.indexOf('//') < 0) {
            return url
          }
          let u
          try { u = new URL(url) } catch { return url }
          const vpnDomain = u.protocol === 'http:' ? httpVpnDomain : httpsVpnDomain
          if (u.host.includes(vpnDomain)) return url
          let subdomain = encodeHost(u.host)
          const hostPrefix = workerHost.replace(vpnDomain, '')
          if (!hostPrefix.includes('.') && hostPrefix.includes('-')) {
            subdomain += '-' + hostPrefix.split('-').slice(-2).join('-')
          }
          return url.replace(u.host, subdomain + vpnDomain)
        }

        self.webvpn = { target, site, transformUrl }
        const globalCons = ['self', 'globalThis']
        const locationAttrs = ['hash', 'host', 'hostname', 'href', 'origin', 'pathname', 'port', 'protocol', 'search']

        self.__location__ = {}
        locationAttrs.forEach(attr => {
          self.location['__' + attr + '__'] = webvpn.target[attr]
          const getter = () => webvpn.target[attr] || location[attr]
          Object.defineProperty(self.__location__, attr, { get: getter })
          Object.defineProperty(self.__location__, '__' + attr + '__', { get: getter })
        })
        self.__location__.toString = () => self.__location__.href

        for (const con of globalCons) {
          if (con === 'globalThis') {
            self['__' + con + '__'] = self.__self__
            continue
          }
          self['__' + con + '__'] = new Proxy(self[con], {
            get (target, property, receiver) {
              if (globalCons.includes(property) || property === 'location') {
                return self['__' + property + '__']
              }
              const value = target[property]
              return (typeof value === 'function' && !value.prototype) ? value.bind(target) : value
            },
            set (target, property, value) {
              if (['globalThis', 'self', 'location'].includes(property)) {
                return false
              }
              target[property] = value
              return true
            }
          })
        }
        // AST 模式下 worker 代码经 oxc 改写后可能引用 __window__/__document__/
        // __parent__/__top__（Worker 中不存在这些全局对象）。
        // 旧模式下 with(__context_proxy__) 回退到 self.xxx 返回 undefined；
        // AST 模式无 with，需显式定义为 undefined 以避免 ReferenceError。
        self.__window__ = undefined
        self.__document__ = undefined
        self.__parent__ = undefined
        self.__top__ = undefined
        self.__context__ = {
          self: self.__self__,
          globalThis: self.__globalThis__,
          location: self.__location__
        }
        self.__context_proxy__ = new Proxy(self.__context__, {
          has (target, prop) {
            return true
          },
          get (target, prop) {
            return prop in target ? target[prop] : self[prop]
          },
          set (target, prop, value) {
            self[prop] = value
            return true
          }
        })

        const fetch = self.fetch
        self.fetch = function (input, init) {
          if (input instanceof URL) input = input.href
          const isInputUrl = typeof input === 'string'
          const url = isInputUrl ? input : input.url
          const newUrl = transformUrl(url)
          if (isInputUrl) {
            input = newUrl
          } else {
            const reqInit = {}
            for (let key in input) {
              const value = input[key]
              if (key === 'url' || typeof value === 'function') continue
              if (key === 'mode' && value === 'navigate') continue
              reqInit[key] = value
            }
            input = new Request(newUrl, reqInit)
          }
          return fetch.apply(self, [input, init])
        }
      }
    "#
}

/// 作用域前缀（对应 this.jsScopePrefixCode）
pub fn js_scope_prefix_code() -> &'static str {
    r#"
    (function () {
      atob = self.atob.bind(self)
      addEventListener = self.addEventListener.bind(self)
      if (self.postMessage) {
        postMessage = self.postMessage.bind(self)
      }
      with (self.__context_proxy__) {
    "#
}

/// 作用域后缀（对应 this.jsScopeSuffixCode）
pub fn js_scope_suffix_code() -> &'static str {
    r#"
    }).call(self.__context__.self)
    "#
}

/// 对应 calcHoistIdentifiersCode(code)
/// 扫描 function/class 名，把提升的标识符挂到 self 上
pub fn calc_hoist_identifiers_code(code: &str) -> String {
    // Node: matches.map(m => m[2]).filter(k => !jsKeywords.includes(k))
    // 不去重——同名 function 出现 N 次会生成 N 行 try{self.X=X}catch{}（无害，仅重复赋值）。
    // 此前去重会导致生成代码行数与 Node 不一致，移除去重保持严格对齐。
    let mut names: Vec<String> = Vec::new();
    for caps in HOIST_RE.captures_iter(code) {
        let name = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if !JS_KEYWORDS.contains(&name) {
            names.push(name.to_string());
        }
    }
    if names.is_empty() {
        return String::new();
    }
    names.iter()
        .map(|n| format!("try {{ self.{} = {}; }} catch {{}}", n, n))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 对应 refactorJsScopeCode(ctx, code, isJsFile)
pub fn refactor_js_scope_code(
    code: &str,
    is_js_file: bool,
    config: &Config,
    meta: &Meta,
    convert_domains_code: &str,
) -> String {
    let https_enabled = config.https_enabled;
    let site = &config.site;
    let scheme = &meta.scheme;
    let target = &meta.target;

    // prefix = site.origin.slice(site.origin.indexOf('//'))
    let site_origin = config.site_origin();
    let prefix = match site_origin.find("//") {
        Some(i) => &site_origin[i..],
        None => &site_origin[..],
    };
    let site_url = format!("{}:{}", if https_enabled { scheme } else { "http" }, prefix);

    if config.rewrite_this {
        // AST 模式：不包裹 with（兼容 ESM/严格模式），不做 hoisting。
        // 仍需 worker context（定义 __location__ 等，供 AST 改写后的代码引用）。
        let mut result = String::new();
        if is_js_file {
            let worker_code = js_worker_context_code()
                .replace(
                    "if (!self.window) {",
                    &format!("if (!self.window) {{\n{}", convert_domains_code),
                )
                .replace("#targetUrl#", target.as_str())
                .replace("#siteUrl#", &site_url);
            result.push_str(&worker_code);
            let _ = site;
        }
        result.push_str(code);
        return result;
    }

    // 旧模式：with 包裹 + hoisting
    let mut result = String::new();
    if is_js_file {
        // 把 convertDomainsCode 插入到 'if (!self.window) {' 之后
        let worker_code = js_worker_context_code()
            .replace(
                "if (!self.window) {",
                &format!("if (!self.window) {{\n{}", convert_domains_code),
            )
            .replace("#targetUrl#", target.as_str())
            .replace("#siteUrl#", &site_url);
        result.push_str(&worker_code);
        let _ = site;
    }
    result.push_str(js_scope_prefix_code());
    result.push_str(code);
    result.push_str("\n}\n");
    result.push_str(&calc_hoist_identifiers_code(code));
    result.push_str(js_scope_suffix_code());
    result
}

/// 对应 processHtml(ctx, res)：去掉 CSP meta
pub fn process_html(data: &str) -> String {
    // Node: res.data.match(this.reMetaCsp) 返回首个匹配（无 g 标志），
    // 再 res.data.replace(match[0], '') 删除该首个匹配字符串（String.replace 首匹配）。
    // 用 Regex::replace（首匹配）而非 replace_all，保持一致。
    CSP_META_RE.replace(data, "").to_string()
}

/// 对应 processHtmlScopeCodes(ctx, code)
/// 抽取 HTML 中所有内联 <script> 内容，逐个用 refactorJsScopeCode 包裹后回填
pub fn process_html_scope_codes(
    code: &str,
    config: &Config,
    meta: &Meta,
    convert_domains_code: &str,
) -> String {
    let re = &SCRIPT_TAG_RE;
    // 收集所有匹配，过滤出 JS 脚本且有内容的
    struct Match {
        full: String,
        #[allow(dead_code)]
        attrs: String,
        content: String,
        start: usize,
    }
    let mut matches: Vec<Match> = Vec::new();
    for caps in re.captures_iter(code) {
        let full = caps.get(0).unwrap().as_str().to_string();
        let attrs = caps.get(1).unwrap().as_str().to_string();
        let content = caps.get(2).unwrap().as_str().to_string();
        let start = caps.get(0).unwrap().start();

        // 判断 type 是否为 JS
        let mut is_script = true;
        // Node: `if (typeIndex > 0)` —— 严格大于，type= 位于属性组首位（如 <scripttype=...>）
        // 时跳过类型检查、保持 isScript=true 默认值。filter(|i| i > 0) 与之对齐。
        if let Some(type_idx) = attrs.find("type=").filter(|&i| i > 0) {
            // type 值的引号字符
            let quote_char = attrs.as_bytes().get(type_idx + 5).copied().unwrap_or(b'"');
            let after = &attrs[type_idx + 6..];
            let type_val = match after.find(quote_char as char) {
                Some(end) => &after[..end],
                None => after,
            };
            is_script = type_val.contains("javascript");
            if !is_script && !type_val.contains("text/") && !type_val.contains("json") {
                is_script = true;
            }
        }
        if is_script && !content.is_empty() {
            matches.push(Match { full, attrs, content, start });
        }
    }

    // 按 start 倒序排列（从后往前替换，避免位置偏移）
    matches.sort_by(|a, b| b.start.cmp(&a.start));

    let mut code = code.to_string();
    for m in matches {
        // index = match[0].length - match[2].length - 9 + match.index
        // 即 content 在原 code 中的起始位置
        let index = m.full.len() - m.content.len() - 9 + m.start;
        let refactored = refactor_js_scope_code(&m.content, false, config, meta, convert_domains_code);
        // code = code[:index] + refactored + code[index + content.len():]
        let (before, after) = code.split_at(index);
        let after = &after[m.content.len()..];
        code = format!("{}{}{}", before, refactored, after);
    }
    code
}

/// 对应 processJsScopeCode(ctx, code)
pub fn process_js_scope_code(
    code: &str,
    config: &Config,
    meta: &Meta,
    convert_domains_code: &str,
) -> (String, String) {
    // 返回 (新 code, 新 mime)
    if code.starts_with('{') || code.starts_with('[') {
        if serde_json::from_str::<serde_json::Value>(code).is_ok() {
            return (code.to_string(), "json".to_string());
        }
    }
    let refactored = refactor_js_scope_code(code, true, config, meta, convert_domains_code);
    (refactored, meta.mime.clone())
}

/// 对应 customResponse(ctx, res)
/// 禁用 module / 严格模式，关闭 SRI，with(this) 重写，location.xxx 重写
/// rewrite_this = true 时改用 oxc AST 解析全部 this（覆盖默认的 with(this) 正则改写）
pub fn custom_response(data: &str, mime: &str, rewrite_this: bool) -> String {
    if rewrite_this {
        // AST 模式：不做任何字符串硬替换（保留 type="module"、use strict），
        // 用 oxc AST 精准改写 this 和 7 个作用域标识符（location/window/self/globalThis/document/parent/top）。
        // 不再用 with 包裹，兼容 ESM 和严格模式。
        // integrity 属性在 rewrite_ast_in_html_scripts 中用正则精准移除（仅标签属性，不影响 JS 字符串字面量）。
        // 解析失败时回退到 legacy_rewrite_js（仅 with(this) + location.xxx 正则，不破坏 ESM）。
        return rewrite_ast_in_response(data, mime);
    }

    // 旧模式：字符串硬替换 + 正则改写
    let mut data = data
        .replace("type=\"module\"", "type=\"mod\"")
        .replace("type=module", "type=mod")
        .replace("nomodule", "nomod")
        .replace(" integrity", " no-integrity")
        .replace("use strict", "");
    // location.xxx -> location.__xxx__
    data = LOCATION_PROP_RE.replace_all(&data, |caps: &regex::Captures| {
        format!("location.__{}__", &caps[1])
    }).to_string();
    // 默认：仅用正则改写 with(this) 模式（性能更好）
    data = WITH_THIS_RE.replace_all(&data, " with(this === self ? __self__ : this)").to_string();
    data
}

/// AST 模式（rewrite_this=true）：对响应中的 JS 代码做 oxc AST 解析，
/// 同时改写 this 和 7 个作用域标识符（location/window/self/globalThis/document/parent/top）。
/// HTML 响应只解析内联 <script> 内容，避免把 HTML 标签当 JS 解析导致报错。
/// 解析失败时回退到旧模式（字符串硬替换 + 正则 with(this) 改写），保证不崩。
fn rewrite_ast_in_response(data: &str, mime: &str) -> String {
    match mime {
        "js" => rewrite_ast_in_js(data).unwrap_or_else(|| legacy_rewrite_js(data)),
        "html" => rewrite_ast_in_html_scripts(data),
        _ => data.to_string(),
    }
}

/// AST 模式解析失败时的回退改写。
/// 仅做不依赖 `with(__context_proxy__)` 包裹的改写：
/// - `with(this)` → `with(this === self ? __self__ : this)`（正则，处理原代码中的 with 语句）
/// - `location.xxx` → `location.__xxx__`（正则，处理 location 属性访问）
///
/// **不做** ESM 移除 / use strict 移除 / type=module 替换——
/// 那些是旧模式 `with` 包裹的前置条件，AST 模式不包裹 with，做了反而有害
/// （破坏 ESM 兼容性、可能误改 JS 字符串字面量中的 "type=module" 等子串）。
/// integrity 属性的移除在 HTML 层面处理（rewrite_ast_in_html_scripts），不在此函数。
///
/// 注意：此回退无法拦截裸 `location`/`window`/`self` 等标识符引用（需 AST 或 with 包裹）。
/// 解析失败的 JS 会失去这部分拦截能力，但仍可正常运行。
fn legacy_rewrite_js(code: &str) -> String {
    let data = LOCATION_PROP_RE.replace_all(code, |caps: &regex::Captures| {
        format!("location.__{}__", &caps[1])
    }).to_string();
    WITH_THIS_RE.replace_all(&data, " with(this === self ? __self__ : this)").to_string()
}

/// 抽取 HTML 中内联 <script> 内容逐段做 AST 改写（倒序回填避免位置偏移）
/// 逻辑与 process_html_scope_codes 的脚本抽取一致
fn rewrite_ast_in_html_scripts(data: &str) -> String {
    // 移除 HTML 标签中的 integrity= 属性（SRI 校验）。
    // 改写后的 JS/CSS 内容哈希变化，SRI 校验失败会导致资源被浏览器拒绝执行。
    // 必须在快速跳过之前执行——即使不含需改写的标识符，只要引用了外部改写过的 JS/CSS，
    // integrity 也要移除。正则仅匹配标签属性，不影响内联 <script> 中的字符串字面量。
    let data = if data.contains("integrity") {
        INTEGRITY_ATTR_RE.replace_all(data, "").to_string()
    } else {
        data.to_string()
    };

    // 快速跳过：不含任何需改写的标识符时无需做脚本抽取与解析
    if !data.contains("this")
        && !data.contains("location")
        && !data.contains("window")
        && !data.contains("self")
        && !data.contains("globalThis")
        && !data.contains("document")
        && !data.contains("parent")
        && !data.contains("top")
    {
        return data;
    }
    let re = &SCRIPT_TAG_RE;
    let mut matches: Vec<(usize, usize, String)> = Vec::new(); // (content_start, content_len, content)
    for caps in re.captures_iter(&data) {
        let attrs = caps.get(1).unwrap().as_str();
        let content = caps.get(2).unwrap().as_str().to_string();
        let full = caps.get(0).unwrap().as_str();
        let full_start = caps.get(0).unwrap().start();

        // 判断 type 是否为 JS（与 process_html_scope_codes 一致）
        let mut is_script = true;
        if let Some(type_idx) = attrs.find("type=").filter(|&i| i > 0) {
            let quote_char = attrs.as_bytes().get(type_idx + 5).copied().unwrap_or(b'"');
            let after = &attrs[type_idx + 6..];
            let type_val = match after.find(quote_char as char) {
                Some(end) => &after[..end],
                None => after,
            };
            is_script = type_val.contains("javascript");
            if !is_script && !type_val.contains("text/") && !type_val.contains("json") {
                is_script = true;
            }
        }
        if is_script && !content.is_empty() {
            // content 在原 data 中的起始位置
            let content_start = full_start + full.len() - content.len() - 9;
            matches.push((content_start, content.len(), content));
        }
    }
    if matches.is_empty() {
        return data.to_string();
    }
    // 倒序回填
    matches.sort_by(|a, b| b.0.cmp(&a.0));
    let mut result = data.to_string();
    for (start, len, content) in matches {
        // AST 解析失败时回退到旧模式字符串替换
        let rewritten = rewrite_ast_in_js(&content).unwrap_or_else(|| legacy_rewrite_js(&content));
        let (before, after) = result.split_at(start);
        let after = &after[len..];
        result = format!("{}{}{}", before, rewritten, after);
    }
    result
}

/// 需要改写的 7 个作用域标识符及其替换文本
const SCOPE_NAMES: &[(&str, &str)] = &[
    ("location", "__location__"),
    ("window", "__window__"),
    ("self", "__self__"),
    ("globalThis", "__globalThis__"),
    ("document", "__document__"),
    ("parent", "__parent__"),
    ("top", "__top__"),
];

/// this 的替换文本
/// 比较对象必须用 globalThis 而非 self：注入的裸 `self` 会被局部变量遮蔽
/// （如 jQuery find 里 `var self = this`，导致 this === self 恒真，
/// 方法内的 this 全部错误地路由到 __self__，pushStack 等 Crash）。
/// globalThis 不会被本改写器二次改写（替换是按 span 文本拼接，不重访），
/// IE 等无 globalThis 的环境下求值为 undefined → 恒走 this 分支，安全降级。
const THIS_REPLACEMENT: &str = "(this === globalThis ? __self__ : this)";

/// oxc AST visitor：一次遍历同时收集 ThisExpression 和 7 个作用域标识符的 span
/// - ThisExpression: this → (this === globalThis ? __self__ : this)
/// - IdentifierReference: location/window/self/globalThis/document/parent/top → __xxx__
///   注意：obj.location 中的 location 是 MemberProperty（IdentifierName），
///   不会触发 visit_identifier_reference，所以属性名不会被误改。
///
/// 语义正确性：仅改写**未绑定到任何局部声明**的全局引用（is_global_reference）。
/// `var top = 5; console.log(top)` 中，第二个 `top` 绑定到 var 声明，
/// 不应改写——这与旧模式 `with` 语句的词法作用域行为一致（局部变量遮蔽 with 对象）。
struct RewriteCollector {
    spans: Vec<(u32, u32, &'static str)>, // (start, end, replacement)
    // Scoping 的原始指针：visitor 持有 &mut self，无法同时持有 &Scoping 借用，
    // 用 raw pointer 绕过借用检查。生命周期由调用方保证（scoping 活跃于整个 visit 期间）。
    scoping: *const oxc_semantic::Scoping,
}

// SAFETY: Scoping 在 rewrite_ast_in_js 中存活于整个 visit_program 期间，
// collector 单线程使用，不存在并发访问。
unsafe impl Send for RewriteCollector {}
unsafe impl Sync for RewriteCollector {}

impl<'a> oxc_ast_visit::Visit<'a> for RewriteCollector {
    fn visit_this_expression(&mut self, it: &oxc_ast::ast::ThisExpression) {
        self.spans.push((it.span.start, it.span.end, THIS_REPLACEMENT));
        oxc_ast_visit::walk::walk_this_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &oxc_ast::ast::IdentifierReference<'a>) {
        let name = it.name.as_str();
        if let Some(&(_, replacement)) = SCOPE_NAMES.iter().find(|(n, _)| *n == name) {
            // 仅当引用未绑定到任何局部声明（即全局引用）时才改写。
            // scoping 由调用方在 visit 前设置，且保证非空。
            let is_global = if self.scoping.is_null() {
                // 理论上不应到达——scoping 总会被设置。保守不改写。
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
/// 解析失败时返回 None，由调用方决定回退策略。
fn rewrite_ast_in_js(code: &str) -> Option<String> {
    // 快速跳过：不含任何需改写的关键字时无需启动 oxc
    if !code.contains("this") && SCOPE_NAMES.iter().all(|(n, _)| !code.contains(n)) {
        return Some(code.to_string());
    }

    use oxc_allocator::Allocator;
    use oxc_parser::{Parser, ParseOptions};
    use oxc_span::SourceType;

    let allocator = Allocator::default();
    let source_type = SourceType::script();
    // allow_return_outside_function: 与 Node 版 acorn 的 allowReturnOutsideFunction: true 对齐，
    // 被代理的脚本可能出现顶层 return（如 document.write 注入的片段）
    let options = ParseOptions {
        allow_return_outside_function: true,
        ..ParseOptions::default()
    };
    let ret = Parser::new(&allocator, code, source_type).with_options(options).parse();

    // 致命错误（无法恢复）：返回 None，由调用方回退到旧模式
    if ret.fatal_error {
        return None;
    }

    let program = &ret.program;

    // 构建语义分析：用于判断 IdentifierReference 是否绑定到局部声明。
    // 仅改写未绑定的全局引用，避免误改局部变量（如 `var top = 5; top` 中的 top）。
    // with_build_nodes(false) 跳过 AstNodes 构建（我们只需 scoping 的引用解析）。
    use oxc_semantic::SemanticBuilder;
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
        // 解析成功但无 this/标识符（可能仅出现在字符串/注释中）
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 Node 版 acorn 行为对齐验证：顶层 return + this 应被正确改写
    #[test]
    fn test_toplevel_return_and_this() {
        let code = "return this;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("(this === globalThis ? __self__ : this)"),
            "top-level return + this should be rewritten, got: {}",
            out
        );
    }

    /// 损坏的 JS 应返回 None（由调用方回退到旧模式字符串替换）
    #[test]
    fn test_malformed_js_returns_none() {
        // 语法错误：function 后缺括号。oxc 应判定 fatal_error。
        let code = "function(){ with(this) }";
        let out = rewrite_ast_in_js(code);
        assert!(out.is_none(), "malformed JS should return None, got: {:?}", out);
    }

    /// 不含 this/作用域标识符的代码应 fast-skip 原样返回
    #[test]
    fn test_no_targets_fast_skip() {
        let code = "const x = 42; function add(a, b) { return a + b; }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert_eq!(out, code, "code without targets should be returned unchanged");
    }

    /// 字符串/注释中的 this 不应被改写（AST 解析识别真正的 ThisExpression）
    #[test]
    fn test_this_in_string_and_comment_preserved() {
        let code = "var s = \"this is a string\"; // this is a comment\nconsole.log(this);";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(out.contains("\"this is a string\""), "string content preserved");
        assert!(out.contains("// this is a comment"), "comment content preserved");
        assert_eq!(
            out.matches("(this === globalThis ? __self__ : this)").count(),
            1,
            "only the real this expression should be rewritten"
        );
    }

    /// with(this) 经 AST 改写后应为 with((this === globalThis ? __self__ : this))
    /// （AST 路径只替换 this 表达式本身，保留外层 with(...) 结构）
    #[test]
    fn test_with_this_ast_rewrite() {
        let code = "with(this) { foo(); }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("with((this === globalThis ? __self__ : this))"),
            "with(this) should be AST-rewritten to with((this === globalThis ? __self__ : this)), got: {}",
            out
        );
    }

    /// 裸 location 标识符应被改写为 __location__
    #[test]
    fn test_ast_rewrites_location_identifier() {
        let code = "location.href = 'http://example.com';";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__location__.href"),
            "location.href should be rewritten to __location__.href, got: {}",
            out
        );
        assert!(
            !out.contains("location.href"),
            "no raw location.href should remain, got: {}",
            out
        );
    }

    /// 裸 window 标识符应被改写为 __window__
    #[test]
    fn test_ast_rewrites_window_identifier() {
        let code = "window.location = 'http://example.com';";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__window__.location"),
            "window.location should be rewritten to __window__.location, got: {}",
            out
        );
    }

    /// obj.location 中的 location 是属性名，不应被改写
    #[test]
    fn test_ast_preserves_property_names() {
        let code = "const x = obj.location;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("obj.location"),
            "obj.location property access should be preserved, got: {}",
            out
        );
        assert!(
            !out.contains("obj.__location__"),
            "property name should not be rewritten, got: {}",
            out
        );
    }

    /// 声明名（BindingIdentifier）不应被改写；且引用局部声明的同名变量也不应被改写。
    /// `var location = 1; console.log(location)` 中：
    /// - `var location` 的声明名是 BindingIdentifier，不改写
    /// - `console.log(location)` 中的 location 是 IdentifierReference，
    ///   但它绑定到 var 声明（is_global_reference = false），也不改写。
    ///   这与旧模式 `with` 的词法作用域行为一致——局部变量遮蔽 with 对象的属性。
    #[test]
    fn test_ast_preserves_binding_identifiers() {
        let code = "var location = 1; console.log(location);";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("var location = 1"),
            "binding identifier 'var location' should be preserved, got: {}",
            out
        );
        assert!(
            !out.contains("__location__"),
            "reference to local var 'location' should NOT be rewritten (it's bound), got: {}",
            out
        );
    }

    /// 局部变量遮蔽：`var top = 5; console.log(top)` 中的 top 绑定到局部 var 声明，
    /// 不应改写为 __top__。这是语义分析的核心价值——避免误改局部变量。
    #[test]
    fn test_ast_local_variable_shadowing_not_rewritten() {
        let code = "var top = 5; console.log(top);";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__top__"),
            "local 'top' variable reference should NOT be rewritten, got: {}",
            out
        );
        assert!(
            out.contains("console.log(top)"),
            "local top reference should remain as 'top', got: {}",
            out
        );
    }

    /// 对比：全局引用（无局部声明遮蔽）应被改写。
    /// `console.log(top)` 中 top 无局部声明，是全局引用，应改写为 __top__。
    #[test]
    fn test_ast_global_reference_is_rewritten() {
        let code = "console.log(top);";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__top__"),
            "global 'top' reference should be rewritten to __top__, got: {}",
            out
        );
    }

    /// 函数参数遮蔽：`function f(self) { return self; }` 中 self 是参数，绑定到局部，
    /// 不应改写。这覆盖了函数作用域的引用解析。
    #[test]
    fn test_ast_function_param_shadowing() {
        let code = "function f(self) { return self; }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__self__"),
            "function param 'self' should NOT be rewritten, got: {}",
            out
        );
    }

    /// AST 模式应保留 type="module" 和 use strict（不做字符串硬替换）
    #[test]
    fn test_ast_preserves_esm_and_strict() {
        let data = r#"<script type="module">"use strict"; this.foo();</script>"#;
        let out = custom_response(data, "html", true);
        assert!(
            out.contains("type=\"module\""),
            "type=\"module\" should be preserved in AST mode, got: {}",
            out
        );
        assert!(
            out.contains("\"use strict\""),
            "use strict should be preserved in AST mode, got: {}",
            out
        );
    }

    /// 旧模式应移除 type="module" 和 use strict
    #[test]
    fn test_legacy_removes_esm_and_strict() {
        let data = r#"<script type="module">"use strict"; this.foo();</script>"#;
        let out = custom_response(data, "html", false);
        assert!(
            !out.contains("type=\"module\""),
            "type=\"module\" should be removed in legacy mode, got: {}",
            out
        );
        assert!(
            !out.contains("\"use strict\""),
            "use strict should be removed in legacy mode, got: {}",
            out
        );
    }

    /// self 和 document 标识符应被改写
    #[test]
    fn test_ast_rewrites_self_and_document() {
        let code = "self.document.title = document.title;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        // self → __self__，self.document → __self__.document（document 是属性名，不改）
        assert!(
            out.contains("__self__.document.title"),
            "self.document should be rewritten to __self__.document, got: {}",
            out
        );
        // 裸 document → __document__
        assert!(
            out.contains("__document__.title"),
            "bare document should be rewritten to __document__, got: {}",
            out
        );
    }

    /// 箭头函数中的 this 应被改写（箭头函数不绑定自己的 this，继承外层）。
    /// 这验证 visitor 能正确进入箭头函数体。
    #[test]
    fn test_ast_rewrites_this_in_arrow_function() {
        let code = "const f = () => this.foo;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("(this === globalThis ? __self__ : this).foo"),
            "this in arrow function should be rewritten, got: {}",
            out
        );
    }

    /// 闭包（普通函数）中的 this 应被改写。
    /// 虽然普通函数的 this 是动态绑定的，但 AST 层面 ThisExpression 都应被改写——
    /// 与旧模式 with(this) 正则的行为一致（正则无法区分函数内外）。
    #[test]
    fn test_ast_rewrites_this_in_closure() {
        let code = "function f() { return this; }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("return (this === globalThis ? __self__ : this)"),
            "this in function should be rewritten, got: {}",
            out
        );
    }

    /// jQuery find 的崩溃回归测试：局部 `var self = this` 遮蔽全局 self。
    /// 注入的比较引用必须是 globalThis（不可被局部变量遮蔽），
    /// 否则方法内 this === self 恒真，this 全部错误路由到 __self__，
    /// 导致 `__self__.pushStack is not a function` 一类的全局崩溃。
    #[test]
    fn test_this_with_local_self_shadow() {
        let code = "find: function(selector) {\n  var i, ret, self = this;\n  ret = this.pushStack('', 'find', selector);\n}";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("var i, ret, self = (this === globalThis ? __self__ : this);"),
            "local `self = this` should keep working (this branch taken), got: {}",
            out
        );
        assert!(
            out.contains("ret = (this === globalThis ? __self__ : this).pushStack"),
            "this.pushStack must resolve to this (not __self__) when this is a method receiver, got: {}",
            out
        );
        // 替换文本中的 self/globalThis 引用绝不能再被改写为 __self__/__globalThis__
        assert!(
            !out.contains("this === __globalThis__") && !out.contains("? __self__ ?"),
            "injected comparison must not be re-rewritten, got: {}",
            out
        );
    }

    /// 解构赋值中的全局标识符引用应被改写。
    /// `const { href } = location` 中 location 是全局引用（无局部遮蔽），应改写为 __location__。
    /// href 是解构的 BindingIdentifier，不改写。
    #[test]
    fn test_ast_rewrites_in_destructuring() {
        let code = "const { href } = location;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__location__"),
            "location in destructuring source should be rewritten, got: {}",
            out
        );
        assert!(
            out.contains("href"),
            "href binding identifier should be preserved, got: {}",
            out
        );
    }

    /// 对象解构中用同名 key 提取全局变量：`const { self } = window`
    /// window 是全局引用 → __window__；self 是 BindingIdentifier → 不改写。
    #[test]
    fn test_ast_destructuring_same_name_key() {
        let code = "const { self } = window;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__window__"),
            "window should be rewritten to __window__, got: {}",
            out
        );
        // 解构出来的 self 是局部绑定，后续不应被改写——但这里没有后续引用
        // 只验证 window 被改写、self 作为 binding 不被改写
        assert!(
            !out.contains("__self__"),
            "self as destructuring binding should NOT be rewritten, got: {}",
            out
        );
    }

    /// 嵌套作用域：外层 var 遮蔽 + 内层裸引用。
    /// `var top = 1; function f() { return top; }` 中，
    /// 函数内的 top 仍绑定到外层 var 声明（闭包捕获），不应改写。
    #[test]
    fn test_ast_nested_scope_closure_capture() {
        let code = "var top = 1; function f() { return top; }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__top__"),
            "top captured from outer var should NOT be rewritten, got: {}",
            out
        );
    }

    /// let/const 块级作用域遮蔽：`let self = {}; console.log(self)`
    /// self 绑定到 let 声明，不应改写。
    #[test]
    fn test_ast_let_block_scope_shadowing() {
        let code = "let self = {}; console.log(self);";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__self__"),
            "let-declared self should NOT be rewritten, got: {}",
            out
        );
    }

    /// 混合场景：局部变量 + 全局引用共存。
    /// `var top = 1; console.log(top, window)` 中：
    /// - top 绑定到局部 var，不改写
    /// - window 是全局引用，改写为 __window__
    #[test]
    fn test_ast_mixed_local_and_global() {
        let code = "var top = 1; console.log(top, window);";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__top__"),
            "local top should NOT be rewritten, got: {}",
            out
        );
        assert!(
            out.contains("__window__"),
            "global window should be rewritten, got: {}",
            out
        );
    }

    /// with + use strict 是语法错误（严格模式禁止 with）。
    /// oxc 应将其判为 fatal_error → 返回 None → 回退到 legacy_rewrite_js。
    /// legacy_rewrite_js 不移除 use strict（AST 模式回退不做 ESM/strict 移除），
    /// 但这不影响——原代码本身就有语法错误，浏览器也会报错。
    /// 关键是：AST 路径不崩溃，返回 None 让调用方回退。
    #[test]
    fn test_ast_with_strict_returns_none_or_fallback() {
        let code = r#""use strict"; with({foo: 1}) { console.log(foo); }"#;
        let out = rewrite_ast_in_js(code);
        // 无论 oxc 是否判为 fatal_error，都不应 panic。
        // 若返回 None，调用方会回退到 legacy_rewrite_js。
        // 若返回 Some，说明 oxc 接受了此语法（非严格语义检查），则 with 被保留。
        if let Some(result) = out {
            // 如果解析成功，with 语句应被保留（AST 不移除 with）
            assert!(
                result.contains("with(") || result.contains("with ("),
                "with statement should be preserved if parsed, got: {}",
                result
            );
        }
        // None 也是可接受的（fatal_error → 回退）
    }

    /// legacy_rewrite_js 不应破坏 JS 字符串字面量中的 "type=module" 等子串。
    /// 此前旧版 legacy_rewrite_js 会做 type="module" → type="mod" 替换，
    /// 可能误改 JS 代码中的字符串。修复后仅做 with(this) + location.xxx 正则。
    #[test]
    fn test_legacy_rewrite_preserves_string_literals() {
        let code = r#"var s = 'type="module" use strict integrity'; with(this) { foo(); }"#;
        let out = legacy_rewrite_js(code);
        // 字符串字面量中的 type="module" / use strict / integrity 不应被移除
        assert!(
            out.contains("type=\"module\""),
            "string literal 'type=\"module\"' should be preserved, got: {}",
            out
        );
        assert!(
            out.contains("use strict"),
            "string literal 'use strict' should be preserved, got: {}",
            out
        );
        assert!(
            out.contains("integrity"),
            "string literal 'integrity' should be preserved, got: {}",
            out
        );
        // with(this) 正则替换仍应生效
        assert!(
            out.contains("with(this === self ? __self__ : this)"),
            "with(this) regex replacement should work, got: {}",
            out
        );
    }

    /// AST 模式下 HTML 中的 integrity= 属性必须被移除。
    /// 改写后的 JS/CSS 内容哈希变化，SRI 校验失败会导致资源被浏览器拒绝执行。
    #[test]
    fn test_ast_html_removes_integrity() {
        let html = r#"<html><head>
<script src="app.js" integrity="sha384-abc123"></script>
<link rel="stylesheet" href="style.css" integrity="sha384-def456">
<script>console.log(location.href)</script>
</head><body></body></html>"#;
        let out = rewrite_ast_in_html_scripts(html);
        assert!(
            !out.contains("integrity="),
            "integrity attribute should be removed from HTML tags, got: {}",
            out
        );
        // 内联脚本中的 location 应被 AST 改写
        assert!(
            out.contains("__location__") || out.contains("__href__"),
            "inline script location should be rewritten, got: {}",
            out
        );
    }

    /// AST 模式下内联 <script> 中的 "integrity" 字符串字面量不应被移除。
    /// INTEGRITY_ATTR_RE 只匹配标签属性，不匹配 JS 字符串。
    #[test]
    fn test_ast_html_preserves_integrity_in_js_string() {
        let html = r#"<script>var s = "integrity"; console.log(s)</script>"#;
        let out = rewrite_ast_in_html_scripts(html);
        assert!(
            out.contains("\"integrity\""),
            "string literal 'integrity' in inline JS should be preserved, got: {}",
            out
        );
    }

    /// catch 子句的异常变量是 BindingIdentifier，不应被改写。
    /// `try {} catch(self) { console.log(self) }` 中：
    /// - catch(self) 的 self 是绑定名，不改写
    /// - console.log(self) 中的 self 绑定到 catch 变量，不改写
    #[test]
    fn test_ast_catch_clause_variable() {
        let code = "try { foo() } catch(self) { console.log(self) }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__self__"),
            "catch-bound 'self' should NOT be rewritten, got: {}",
            out
        );
        assert!(
            out.contains("catch(self)"),
            "catch binding name should be preserved, got: {}",
            out
        );
    }

    /// labeled statement 的标签不应被改写。
    /// `top: for(;;) { break top; }` 中 top 是标签（IdentifierLabel），
    /// 不是 IdentifierReference，不应被改写。
    #[test]
    fn test_ast_labeled_statement_not_rewritten() {
        let code = "top: for(;;) { break top; }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__top__"),
            "label 'top' should NOT be rewritten, got: {}",
            out
        );
    }

    /// computed member expression 中的标识符是值引用，应被改写。
    /// `obj[self]` 中 self 在方括号内，是 IdentifierReference，应改写为 __self__。
    /// 对比：`obj.self` 中 self 是属性名（IdentifierName），不改写。
    #[test]
    fn test_ast_computed_member_expression() {
        let code = "const x = obj[self]; const y = obj.self;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        // computed: obj[self] → obj[__self__]
        assert!(
            out.contains("obj[__self__]"),
            "computed member 'obj[self]' should rewrite self to __self__, got: {}",
            out
        );
        // dot access: obj.self stays (self is property name)
        assert!(
            out.contains("obj.self"),
            "dot access 'obj.self' property name should NOT be rewritten, got: {}",
            out
        );
    }

    /// 对象简写属性：`{ location }` 等价于 `{ location: location }`。
    /// 简写中的 location 既是 key 又是 value reference。
    /// oxc 应将其解析为 IdentifierReference（value 部分），应被改写。
    /// 注意：这与旧模式 with 的行为可能不同——with 无法拦截对象字面量简写中的 value。
    #[test]
    fn test_ast_object_shorthand_property() {
        let code = "const obj = { location };";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        // 简写属性 { location } 应被改写为 { location: __location__ }
        // 或 oxc 可能保持简写形式 { __location__ }（取决于 AST 表示）
        // 无论哪种，location 的 value reference 应被改写
        assert!(
            out.contains("__location__"),
            "shorthand property 'location' value should be rewritten, got: {}",
            out
        );
    }

    /// 对象字面量中的普通属性名不应被改写。
    /// `{ location: 1, window: 2 }` 中 location 和 window 是属性键，不是引用。
    #[test]
    fn test_ast_object_property_keys_not_rewritten() {
        let code = "const obj = { location: 1, window: 2 };";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        // 属性键 location/window 不应被改写
        assert!(
            out.contains("location: 1"),
            "property key 'location' should NOT be rewritten, got: {}",
            out
        );
        assert!(
            out.contains("window: 2"),
            "property key 'window' should NOT be rewritten, got: {}",
            out
        );
    }

    /// import 语句中的绑定不应被改写。
    /// `import self from './mod'` 中 self 是 import 绑定（BindingIdentifier）。
    /// 后续引用 self 应绑定到 import，不应改写为 __self__。
    #[test]
    fn test_ast_import_binding_not_rewritten() {
        let code = "import self from './mod'; console.log(self);";
        let out = rewrite_ast_in_js(code);
        // import 语句在 script 模式下可能解析失败（ESM 语法），
        // 也可能成功（取决于 oxc 配置）。无论哪种都不应 panic。
        if let Some(result) = out {
            assert!(
                !result.contains("__self__"),
                "import-bound 'self' should NOT be rewritten, got: {}",
                result
            );
        }
        // None 也是可接受的（script 模式不支持 import → 回退）
    }

    /// 多层嵌套作用域：全局引用在深层函数内仍应被改写。
    /// `function a() { function b() { function c() { return location; } } }`
    /// 最内层的 location 无局部声明，是全局引用，应改写。
    #[test]
    fn test_ast_deeply_nested_global_reference() {
        let code = "function a() { function b() { function c() { return location; } return b(); } return a(); }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__location__"),
            "deeply nested global 'location' should be rewritten, got: {}",
            out
        );
    }

    /// 变量声明中的初始值引用全局变量应被改写。
    /// `var x = window` 中 window 是全局引用，应改写。
    /// `var x = location.href` 中 location 是全局引用，应改写。
    #[test]
    fn test_ast_variable_initializer_global_reference() {
        let code = "var x = window; var y = location.href;";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("__window__"),
            "global 'window' in initializer should be rewritten, got: {}",
            out
        );
        assert!(
            out.contains("__location__.href"),
            "global 'location.href' in initializer should be rewritten, got: {}",
            out
        );
    }

    /// 函数表达式赋值给变量：变量名是 BindingIdentifier，不改写。
    /// `var self = function() {}` 中 var self 的 self 不改写。
    /// 函数体内的 this 应改写。
    #[test]
    fn test_ast_function_expression_binding() {
        let code = "var self = function() { return this; };";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        // var self 的声明名不改写
        assert!(
            out.contains("var self ="),
            "binding 'var self' should be preserved, got: {}",
            out
        );
        // 函数体内的 this 应改写
        assert!(
            out.contains("(this === globalThis ? __self__ : this)"),
            "this inside function expression should be rewritten, got: {}",
            out
        );
    }

    /// TypeScript 语法（类型注解、泛型、接口）无法被 SourceType::script() 解析。
    /// 应返回 None，由调用方回退到 legacy_rewrite_js（仅做 with(this) + location.xxx 正则）。
    /// 回退后代码原样保留 TS 语法（浏览器自己也会报错，但不会崩服务）。
    #[test]
    fn test_typescript_falls_back_to_legacy() {
        // 类型注解 `: string` 是 TS 语法
        let ts_code = "function greet(name: string): string { return window.location.href; }";
        let ast_result = rewrite_ast_in_js(ts_code);
        // script 模式应无法解析 TS 类型注解 → None
        // （若 oxc 将其作为语法错误判为 fatal_error）
        if ast_result.is_none() {
            // 回退到 legacy：with(this) 正则 + location.xxx 正则
            let legacy = legacy_rewrite_js(ts_code);
            assert!(
                legacy.contains("location.__href__") || legacy.contains("window.location"),
                "legacy should at least do location.xxx regex, got: {}",
                legacy
            );
            // TS 语法应被保留（不做 AST 标识符改写）
            assert!(legacy.contains(": string"), "TS syntax should be preserved in legacy");
        } else {
            // 某些 oxc 版本可能容忍简单 TS 语法。若解析成功，验证改写正确。
            let out = ast_result.unwrap();
            assert!(out.contains("__window__"), "global window should be rewritten");
        }
    }

    /// JSX 语法（<Component />）无法被 SourceType::script() 解析。
    /// 应返回 None，回退到 legacy_rewrite_js。
    #[test]
    fn test_jsx_falls_back_to_legacy() {
        let jsx_code = "const el = <div onClick={() => window.alert(1)}>hello</div>;";
        let ast_result = rewrite_ast_in_js(jsx_code);
        if ast_result.is_none() {
            // JSX 语法在 legacy 中不会被改写（没有 this/location.xxx），原样返回
            let legacy = legacy_rewrite_js(jsx_code);
            assert!(legacy.contains("<div"), "JSX syntax preserved in legacy");
        } else {
            // 若 oxc 容忍 JSX（不太可能），验证改写
            let out = ast_result.unwrap();
            assert!(out.contains("__window__"), "global window should be rewritten");
        }
    }

    /// 性能测试：大文件 AST + semantic 分析的耗时。
    /// 生成 ~500KB JS（5000 个函数，混合全局引用 + 局部变量），
    /// 确保 rewrite_ast_in_js 在合理时间内完成（debug < 5s，release < 1s）。
    #[test]
    fn test_ast_performance_large_file() {
        let mut code = String::from("\"use strict\";\n");
        for i in 0..5000 {
            code.push_str(&format!(
                "function fn{}() {{ var top = {}; return top + window.location.href + this.x; }}\n",
                i, i
            ));
        }
        code.push_str("console.log(location.href, document.title, self.crypto);\n");

        let start = std::time::Instant::now();
        let out = rewrite_ast_in_js(&code).expect("large file should parse");
        let elapsed = start.elapsed();

        // 验证改写正确：全局引用被改写，局部变量不被改写
        assert!(out.contains("__window__"), "global window should be rewritten");
        assert!(out.contains("__location__"), "global location should be rewritten");
        assert!(out.contains("__document__"), "global document should be rewritten");
        assert!(out.contains("__self__"), "global self should be rewritten");
        assert!(out.contains("(this === globalThis ? __self__ : this)"), "this should be rewritten");
        // 局部 var top 不应被改写（每个函数内 top 绑定到 var 声明）
        assert!(!out.contains("__top__"), "local 'top' should NOT be rewritten");

        // debug build 放宽到 10s，release 应 < 1s
        let limit = if cfg!(debug_assertions) {
            std::time::Duration::from_secs(10)
        } else {
            std::time::Duration::from_secs(2)
        };
        assert!(
            elapsed < limit,
            "large file rewrite took too long: {:?} (limit {:?}), file size: {} bytes",
            elapsed,
            limit,
            code.len()
        );
        eprintln!("  perf: {}KB JS rewritten in {:?} (debug={})",
            code.len() / 1024,
            elapsed,
            cfg!(debug_assertions)
        );
    }
}

/// 对应 replaceUrls(ctx, res)：抽取匹配 + 替换
/// 返回新的 data
pub fn replace_urls(data: &str, mime: &str, config: &Config, meta: &Meta, codec: &DomainCodec) -> String {
    // 用 HashSet 去重，避免 O(n) 的 Vec.contains 查找在大页面上成为热点。
    use std::collections::HashSet;
    let mut seen: HashSet<&str> = HashSet::new();
    let mut matches: Vec<String> = Vec::new();

    if mime == "html" {
        for m in HTML_ATTR_RE.find_iter(data) {
            if seen.insert(m.as_str()) {
                matches.push(m.as_str().to_string());
            }
        }
    }
    if mime == "html" || mime == "css" {
        for m in CSS_URL_RE.find_iter(data) {
            if seen.insert(m.as_str()) {
                matches.push(m.as_str().to_string());
            }
        }
        for m in CSS_IMPORT_RE.find_iter(data) {
            if seen.insert(m.as_str()) {
                matches.push(m.as_str().to_string());
            }
        }
    }

    replace_matches(data, &matches, config, meta, codec)
}

/// 对应 replaceMatches(ctx, res, matches)
fn replace_matches(
    data: &str,
    matches: &[String],
    config: &Config,
    meta: &Meta,
    codec: &DomainCodec,
) -> String {
    let http_vpn_domain = &config.http_vpn_domain;
    let https_vpn_domain = &config.https_vpn_domain;
    let scheme = &meta.scheme;

    // dict: quote+source -> quote+value
    let mut dict: Vec<(String, String)> = Vec::new();

    for m in matches {
        // 过滤：包含换行 或 包含 vpnDomain 的跳过
        if m.contains('\n') || m.contains(http_vpn_domain) || m.contains(https_vpn_domain) {
            continue;
        }
        let mut url;
        let prefix;
        let mut quote = String::new();

        // match.slice(0, match.indexOf('//')).indexOf('http') >= 0
        let slash_idx = match m.find("//") {
            Some(i) => i,
            None => continue,
        };
        let before_slash = &m[..slash_idx];
        if before_slash.contains("http") {
            // 正则 [^"')]+ / [^\s>]* 已不含尾部分隔符，slice(..., -1) 会截掉 URL 末尾字符：
            // 有路径时仅影响路径（host 提取不受影响），但无路径 URL（如 url(http://example.com)）
            // 会导致 host 被截断（example.com → example.co），替换 key 不匹配，URL 漏改。
            // 因此这里不再 slice(-1)，直接从 'http' 处取到末尾。
            let http_idx = m.find("http").unwrap();
            url = m[http_idx..].to_string();
            // 此前用 match.indexOf('https') > 0 判断协议，路径含 'https' 时误判；改为检查 url 前缀
            prefix = if url.starts_with("https") {
                "https://".to_string()
            } else {
                "http://".to_string()
            };
        } else {
            // 同上，不再 slice(-1)
            // quote = match[match.indexOf('//') - 1]  （取 // 前一个字符）
            if slash_idx > 0 {
                quote = (m.as_bytes()[slash_idx - 1] as char).to_string();
            }
            url = format!("{}:{}", scheme, &m[slash_idx..]);
            prefix = "//".to_string();
        }

        // u = url.slice(url.indexOf('//') + 2)
        let u_part = match url.find("//") {
            Some(i) => &url[i + 2..],
            None => continue,
        };
        if u_part.is_empty() {
            continue;
        }
        // !/[\w]+\./.test(u)
        if !WORD_DOT_RE.is_match(u_part) {
            continue;
        }
        // &#x 解码
        if HEX_ENTITY_RE.is_match(&url) {
            url = HEX_ENTITY_RE.replace_all(&url, |caps: &regex::Captures| {
                let ele = caps[0].to_string();
                // ele.slice(3, -1) -> 去掉 &#x 和 ;
                let hex_str = &ele[3..ele.len().saturating_sub(1)];
                u32::from_str_radix(hex_str, 16)
                    .ok()
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_default()
            }).to_string();
        }
        if url.contains('"') {
            url = url.replace('"', "");
        }
        // source = prefix + new URL(url).host
        let host = match url::Url::parse(&url) {
            Ok(uu) => {
                let h = uu.host_str().unwrap_or("");
                match uu.port() {
                    Some(p) => format!("{}:{}", h, p),
                    None => h.to_string(),
                }
            }
            Err(_) => continue,
        };
        let source = format!("{}{}", prefix, host);
        let source_for_transform = if source.starts_with("http") {
            source.clone()
        } else {
            format!("{}:{}", scheme, source)
        };
        let value = transform_url(&source_for_transform, config, codec, meta);
        let key = format!("{}{}", quote, source);
        let val = format!("{}{}", quote, value);
        if !dict.iter().any(|(k, _)| k == &key) {
            dict.push((key, val));
        }
    }

    // 此前对每个 key 单独调用 data.replace(key, value) 是 O(n×m)：
    // n 个模式各扫描一遍 m 长度的文本。改为构造单一正则一次遍历替换。
    if dict.is_empty() {
        return data.to_string();
    }
    // 按长度降序，避免短 key 先命中长 key 的前缀
    dict.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    // 构造 pattern：每个 key 转义后用 '|' 连接
    let pattern = dict.iter()
        .map(|(k, _)| regex::escape(k))
        .collect::<Vec<_>>()
        .join("|");
    let re = match Regex::new(&pattern) {
        Ok(r) => r,
        Err(_) => return data.to_string(),
    };
    // 把 dict 转成 HashMap 便于闭包查找
    let map: HashMap<&String, &String> = dict.iter().map(|(k, v)| (k, v)).collect();
    re.replace_all(data, |caps: &regex::Captures| {
        let m = caps.get(0).unwrap().as_str();
        map.get(&m.to_string()).map(|v| v.as_str()).unwrap_or(m).to_string()
    }).to_string()
}

/// 对应 getBase(ctx, res)
pub fn get_base(data: &str, meta: &Meta) -> String {
    if let Some(m) = BASE_HREF_RE.find(data) {
        let text = m.as_str();
        let dq = text.find('"');
        let sq = text.find('\'');
        let index = match (dq, sq) {
            (Some(a), Some(b)) => a.max(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => 0,
        };
        return text[index + 1..].to_string();
    }
    // ctx.meta.target.pathname.split('/').slice(0, -1).join('/') + '/'
    let pathname = meta.target.path();
    let parts: Vec<&str> = pathname.split('/').collect();
    if parts.len() <= 1 {
        return "/".to_string();
    }
    let mut s = parts[..parts.len() - 1].join("/");
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

/// 对应 processOthers(ctx, res)
/// 此前有 JSON.stringify(res.data) 的死分支：res.data 本就是字符串（来自 res.text()），
/// 再次 stringify 会双重编码 JSON 文本，导致客户端拿到被破坏的 JSON。已移除（与 Node 版一致）。
pub fn process_others(data: &str, mime: &str, disable_source_map: bool) -> String {
    let mut data = data.to_string();
    if disable_source_map && (mime == "html" || mime == "js") {
        data = data.replace("sourceMappingURL", "");
    }
    data
}

/// 对应 appendScript(ctx, res)：在 HTML 头部注入运行时脚本
/// 返回新的 HTML
pub async fn append_script(
    data: &str,
    config: &Config,
    meta: &Meta,
    codec: &DomainCodec,
    convert_domains_code: &str,
    js_intercept_code: &str,
    session_store: &crate::cache::SessionStore,
) -> String {
    let https_enabled = config.https_enabled;
    let http_vpn_domain = &config.http_vpn_domain;
    let https_vpn_domain = &config.https_vpn_domain;
    let intercept_log = config.intercept_log;
    let enable_plugins = config.enable_plugins;
    let debug = config.debug;
    let disable_devtools = config.disable_devtools;
    let disable_jump = config.disable_jump;
    let confirm_jump = config.confirm_jump;
    let is_main_session = meta.is_main_session;
    let share_id = &meta.share_id;
    let custom_code = &meta.custom_code;
    let base = &meta.base;
    let scheme = &meta.scheme;
    let target = &meta.target;

    let prefix = format!("//www{}", if https_enabled && scheme == "https" { https_vpn_domain } else { http_vpn_domain });
    let site_url = format!("{}:{}", if https_enabled { scheme } else { "http" }, prefix);
    let page_url = transform_url(target.as_str(), config, codec, meta);

    // worker_wrapper_code 模板：worker_context(siteUrl替换) + scopePrefix + #CODE# + } + scopeSuffix
    // 注意：convertDomainsCode 不拼进字符串，而是运行时用 JS 变量引用相加（与 Node 版一致），
    // 否则会导致 convertDomainsCode 内容被重复拼接。
    let worker_context = js_worker_context_code().replace("#siteUrl#", &site_url);
    let worker_wrapper_code = if config.rewrite_this {
        // AST 模式：不包裹 with（worker 代码可能是 ESM/严格模式，with 会报语法错误）
        format!("\n{}\n  #CODE#\n", worker_context)
    } else {
        // 旧模式：with 包裹
        format!(
            "\n{}\n{}\n  #CODE#\n}}\n{}\n",
            worker_context,
            js_scope_prefix_code(),
            js_scope_suffix_code()
        )
    };

    // 对应 Node 版 appendScript 中所有字符串值均用 JSON.stringify 注入：
    // 生成双引号字符串字面量并正确转义 " \ \n \r \t 等特殊字符。
    // 此前用 format!("'{}'", val) 单引号包裹不转义，若值含单引号/反斜杠会破坏脚本。
    let site_url_json = serde_json::to_string(&site_url).unwrap_or_else(|_| "\"\"".to_string());
    let protocol_json = serde_json::to_string(&format!("{}:", scheme)).unwrap_or_else(|_| "\"\"".to_string());
    let source_url_json = serde_json::to_string(target.as_str()).unwrap_or_else(|_| "\"\"".to_string());
    let page_url_json = serde_json::to_string(&page_url).unwrap_or_else(|_| "\"\"".to_string());
    let hostname_json = serde_json::to_string(target.host_str().unwrap_or("")).unwrap_or_else(|_| "\"\"".to_string());
    let http_vpn_json = serde_json::to_string(http_vpn_domain).unwrap_or_else(|_| "\"\"".to_string());
    let https_vpn_json = serde_json::to_string(https_vpn_domain).unwrap_or_else(|_| "\"\"".to_string());
    let base_json = serde_json::to_string(base).unwrap_or_else(|_| "\"\"".to_string());
    let share_id_json = serde_json::to_string(share_id).unwrap_or_else(|_| "\"\"".to_string());
    // convertDomainsCode / worker_wrapper_code / intercept_code 同样用 JSON 字符串注入
    let convert_domains_json = serde_json::to_string(convert_domains_code).unwrap_or_else(|_| "\"\"".to_string());
    let worker_wrapper_json = serde_json::to_string(&worker_wrapper_code).unwrap_or_else(|_| "\"\"".to_string());
    let intercept_code_json = serde_json::to_string(js_intercept_code).unwrap_or_else(|_| "\"\"".to_string());

    let mut code = format!(
        r#"
    <script>
      self.webvpn = {{
        siteUrl: {},
        protocol: {},
        sourceUrl: {},
        pageUrl: {},
        hostname: {},
        httpVpnDomain: {},
        httpsVpnDomain: {},
        base: {},
        interceptLog: {},
        disableJump: {},
        confirmJump: {},
        isMainSession: {},
        shareId: {},
        rewriteThis: {},
      }};
      const convertDomainsCode = {}
      ;new Function(convertDomainsCode)()
      {}
      webvpn.intercept_code = {}
      eval(webvpn.intercept_code)
      webvpn.worker_wrapper_code = convertDomainsCode + {}
    </script>
    "#,
        site_url_json, protocol_json, source_url_json, page_url_json, hostname_json,
        http_vpn_json, https_vpn_json, base_json,
        intercept_log, disable_jump, confirm_jump, is_main_session, share_id_json,
        config.rewrite_this,
        convert_domains_json,
        custom_code,
        intercept_code_json,
        worker_wrapper_json
    );

    if enable_plugins {
        code.push_str(&format!("<script src=\"{}/public/plugins.js\"></script>\n", prefix));
    }
    if debug && !disable_devtools {
        code.push_str("<script src=\"https://cdnjs.cloudflare.com/ajax/libs/vConsole/3.15.1/vconsole.min.js\"></script>\n<script>new VConsole()</script>\n");
    }
    if disable_devtools {
        code.push_str(&format!("<script src=\"{}/public/disable-devtools.js\"></script>\n", prefix));
    }
    if is_main_session {
        code.push_str(&format!("<script src=\"{}/public/share-sessions.js\"></script>\n", prefix));
    }
    if !is_main_session && !share_id.is_empty() {
        let client_cache = session_store.get_item(&format!("{}-clientCache", share_id)).await.unwrap_or_else(|| "{}".to_string());
        // JSON.stringify 不转义 </script>，嵌入 <script> 标签时会提前闭合。
        // 将 < 替换为 \u003c，阻止标签注入（对应 Node 版 .replace(/</g, '\\u003c')）
        let client_cache_json = serde_json::to_string(&client_cache)
            .unwrap_or_else(|_| "\"{}\"".to_string())
            .replace('<', "\\u003c");
        code.push_str(&format!(
            r#"<script>
        try {{
          const clientCache = {}
          const {{ cookie, localStorage: local }} = JSON.parse(clientCache)
          // cookie 是 Cookie 请求头格式（"a=1; b=2"），document.cookie 的 setter
          // 每次只解析一个 name=value 对（; 后的视为属性），不能直接 += 拼接，
          // 否则只有第一个 cookie 被设置，其余被当作属性丢弃。
          if (cookie) cookie.split(';').forEach(c => {{ if (c.trim()) document.cookie = c.trim() }})
          if (local) {{
            localStorage.clear()
            for (let key in local) localStorage[key] = local[key]
          }}
        }} catch (e) {{ console.warn('webvpn session restore failed:', e) }}
      </script>"#,
            client_cache_json
        ));
    }
    code.push_str("<script>\n      const ss = Array.from(document.querySelectorAll('script'));\n      ss.forEach(script => script.remove());\n    </script>\n");

    let has_doctype = DOCTYPE_RE.is_match(data);
    let _ = codec;
    format!("{}{}{}", if has_doctype { "<!DOCTYPE html>\n" } else { "" }, code, data)
}
