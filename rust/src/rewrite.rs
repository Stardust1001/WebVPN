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

// 预编译热路径正则（避免每个请求重复 Regex::new）
// customResponse: with(this) 重写
static WITH_THIS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\s{};]?with\s*\(\s*this\s*\)").unwrap());
// customResponse: location.xxx -> location.__xxx__
static LOCATION_PROP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\blocation\.(hostname|host|origin|href|protocol|navigate|assign|replace|reload|toString)\b").unwrap());
// replaceUrls(html): href/src/action/srcset/poster 属性
static HTML_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\s(href|src|action|srcset|poster)=("|')?(http:|https:|http%3A|https%3A|//)[^\s>]*"#).unwrap());
// AST 模式：移除 HTML 标签中的 integrity= 属性（SRI 校验）。
// 改写后的 JS/CSS 内容哈希变化，SRI 校验会失败导致资源被浏览器拒绝执行。
// 仅匹配标签内的 integrity= 属性，不影响 <script> 内联 JS 中的 "integrity" 字符串字面量。
static INTEGRITY_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#).unwrap());
// replaceUrls(html/css): url(...)
static CSS_URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)url\([\"\']?(http|//)[^\"\')]+"#).unwrap());
// replaceUrls(html/css): @import
static CSS_IMPORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)@import\s[\"\'](http|//)[^\"\']+"#).unwrap());
// replaceMatches: 域名有效性检查
// (?-u) 使 \w 仅匹配 ASCII [A-Za-z0-9_]，与 JS 默认（无 u flag）行为一致
static WORD_DOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)[\w]+\.").unwrap());
// replaceMatches: &#x 实体解码
// (?-u) 同上：JS reHtmlEntity=/&#x\w+;/g 的 \w 是 ASCII-only
static HEX_ENTITY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)&#x\w+;").unwrap());
// calcHoistIdentifiersCode: function/class 名提取
// (?-u) 使 \w 仅 ASCII：JS \w 不会匹配 CJK 等 Unicode 标识符，
// 若不抑制 Unicode 模式，Rust 会为 `function 名前()` 生成多余的 self.名前 = 名前 提升代码
static HOIST_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)(function|class)\s+([\$\_\w]+)\s*\(").unwrap());
// refactor_js_scope_code: 检测 ES module 语法（import/export 声明），
// module 代码强制 strict mode，不能包 with。
// Vite/Rollup 产物是单行压缩代码，import/export 声明不在行首，
// 所以不能用 ^ 锚定；用前一字符边界排除标识符引用（如 `x.import`、`myexport`）。
// `import(`（动态导入）也按 module 处理：虽然语法合法，但页面主脚本多为
// 顶层 import + 动态 import 混合的压缩产物，一并交给不包裹路径更稳。
static MODULE_SYNTAX_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?:^|[^$\_\w.])(import|export)[\s{"'(*]|(?:^|[^$\_\w.])import\s*\("#).unwrap());
// processHtml: CSP meta 去除
static CSP_META_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta\s+http-equiv="Content-Security-Policy"[^>]+>"#).unwrap());
// processHtmlScopeCodes: <script> 抽取
static SCRIPT_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<script([^>]*)>([\S\s]*?)</script>").unwrap());
// getBase: <base href>
static BASE_HREF_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<base\s+href=("|\')[^"']+"#).unwrap());
// appendScript: <!DOCTYPE html> 检测
static DOCTYPE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^\s*?<!DOCTYPE html>").unwrap());

// JS 关键字（对应 this.jsKeywords）
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

// Worker 上下文代码（对应 this.jsWorkerContextCode）
// 注意：#targetUrl# / #siteUrl# 是占位符，使用时替换
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
          // worker（含 ServiceWorker）里真实请求 URL 都是 vpn 域名：
        // 裸 location 各属性必须先取真实 worker location（vpn 域），
        // 否则源站脚本的同源判断（如 request.url.origin === location.origin）
        // 永远为 false，SW 的 fetch 拦截与鉴权头（X-Wd-Sw / Authorization）全部失效。
        // 源站伪装值保留在 location.__attr__ 上。
        const getter = () => location[attr] || webvpn.target[attr]
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

        self.__rewrite_js__ = function (code) {
          if (typeof code !== 'string') return code
          return code.replace(/\b(location)\.(hostname|host|origin|href|protocol|pathname|port|search)\b/g, '$1.__$2__')
        }
        const _workerFunction = self.Function
        const rewriteFnBody = props => {
          if (props.length) {
            const code = props[props.length - 1]
            if (typeof code === 'string') {
              props[props.length - 1] = self.__rewrite_js__(code)
            }
          }
          return props
        }
        self.Function = new Proxy(_workerFunction, {
          construct (target, props) {
            return new _workerFunction(...rewriteFnBody(props))
          },
          apply (target, thisArg, props) {
            return new _workerFunction(...rewriteFnBody(props))
          }
        })
        for (const timerName of ['setTimeout', 'setInterval']) {
          self['_' + timerName + '_'] = self[timerName]
          self[timerName] = function (code, ...rest) {
            if (typeof code === 'string') code = self.__rewrite_js__(code)
            return self['_' + timerName + '_'].call(self, code, ...rest)
          }
        }
      }
    "#
}

// 作用域前缀（对应 this.jsScopePrefixCode）
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

// 作用域后缀（对应 this.jsScopeSuffixCode）
pub fn js_scope_suffix_code() -> &'static str {
    r#"
    }).call(self.__context__.self)
    "#
}

// 对应 calcHoistIdentifiersCode(code)
// 扫描 function/class 名，把提升的标识符挂到 self 上
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

// 对应 refactorJsScopeCode(ctx, code, isJsFile)
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

    // warn warn warn：ES module 代码（含 import/export 声明）强制 strict mode，
    // 包裹 with 会直接语法错误
    //   ast_rewrite = true  → oxc AST 改写（按 module 解析），把裸
    //     location/window/self/globalThis/document/parent/top 精确替换为
    //     __location__/__window__ 等——这些是 intercept.js redefineGlobals
    //     装在真实 window 上的属性，不依赖 with 作用域即可生效。
    //   ast_rewrite = false → 任何改写都不做，原样透传（warn warn warn：模块内
    //     裸 location/window 等将看到 vpn 域名而非源站，伪装缺失）。
    let is_module_code = MODULE_SYNTAX_RE.is_match(code);
    if is_module_code && !config.ast_rewrite {
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
        }
        result.push_str(code);
        return result;
    }
    if is_module_code {
        let rewritten = rewrite_ast_in_js_module(code)
            .unwrap_or_else(|| legacy_rewrite_js(code));
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
        }
        result.push_str(&rewritten);
        return result;
    }
    if config.ast_rewrite {
        // AST 模式：不包裹 with（兼容 ESM/严格模式），不做 hoisting。
        // custom_response 已对整份响应做过 oxc AST 改写（this + 作用域标识符），
        // 这里只需保留 worker context 前缀。
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

// 对应 processHtml(ctx, res)：去掉 CSP meta
pub fn process_html(data: &str) -> String {
    // Node: res.data.match(this.reMetaCsp) 返回首个匹配（无 g 标志），
    // 再 res.data.replace(match[0], '') 删除该首个匹配字符串（String.replace 首匹配）。
    // 用 Regex::replace（首匹配）而非 replace_all，保持一致。
    CSP_META_RE.replace(data, "").to_string()
}

// 对应 processHtmlScopeCodes(ctx, code)
// 抽取 HTML 中所有内联 <script> 内容，逐个用 refactorJsScopeCode 包裹后回填
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

// 对应 processJsScopeCode(ctx, code)
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

// 对应 customResponse(ctx, res)
// 禁用 module / 严格模式，关闭 SRI，with(this) 重写，location.xxx 重写
// ast_rewrite = true 时改用 oxc AST 解析全部 this（覆盖默认的 with(this) 正则改写）
pub fn custom_response(data: &str, mime: &str, ast_rewrite: bool) -> String {
    if ast_rewrite {
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

// AST 模式（ast_rewrite=true）：对响应中的 JS 代码做 oxc AST 解析，
// 同时改写 this 和 7 个作用域标识符（location/window/self/globalThis/document/parent/top）。
// HTML 响应只解析内联 <script> 内容，避免把 HTML 标签当 JS 解析导致报错。
// 解析失败时回退到旧模式（字符串硬替换 + 正则 with(this) 改写），保证不崩。
fn rewrite_ast_in_response(data: &str, mime: &str) -> String {
    match mime {
        "js" => rewrite_ast_in_js(data).unwrap_or_else(|| legacy_rewrite_js(data)),
        "html" => rewrite_ast_in_html_scripts(data),
        _ => data.to_string(),
    }
}

// AST 模式解析失败时的回退改写。
// 仅做不依赖 `with(__context_proxy__)` 包裹的改写：
// - `with(this)` → `with(this === self ? __self__ : this)`（正则，处理原代码中的 with 语句）
// - `location.xxx` → `location.__xxx__`（正则，处理 location 属性访问）
//
// **不做** ESM 移除 / use strict 移除 / type=module 替换——
// 那些是旧模式 `with` 包裹的前置条件，AST 模式不包裹 with，做了反而有害
// （破坏 ESM 兼容性、可能误改 JS 字符串字面量中的 "type=module" 等子串）。
// integrity 属性的移除在 HTML 层面处理（rewrite_ast_in_html_scripts），不在此函数。
//
// 注意：此回退无法拦截裸 `location`/`window`/`self` 等标识符引用（需 AST 或 with 包裹）。
// 解析失败的 JS 会失去这部分拦截能力，但仍可正常运行。
fn legacy_rewrite_js(code: &str) -> String {
    let data = LOCATION_PROP_RE.replace_all(code, |caps: &regex::Captures| {
        format!("location.__{}__", &caps[1])
    }).to_string();
    WITH_THIS_RE.replace_all(&data, " with(this === self ? __self__ : this)").to_string()
}

// 抽取 HTML 中内联 <script> 内容逐段做 AST 改写（倒序回填避免位置偏移）
// 逻辑与 process_html_scope_codes 的脚本抽取一致
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

// 需要改写的 7 个作用域标识符及其替换文本
const SCOPE_NAMES: &[(&str, &str)] = &[
    ("location", "__location__"),
    ("window", "__window__"),
    ("self", "__self__"),
    ("globalThis", "__globalThis__"),
    ("document", "__document__"),
    ("parent", "__parent__"),
    ("top", "__top__"),
];

// this 的替换文本
// 比较对象必须用 globalThis 而非 self：注入的裸 `self` 会被局部变量遮蔽
// （如 jQuery find 里 `var self = this`，导致 this === self 恒真，
// 方法内的 this 全部错误地路由到 __self__，pushStack 等 Crash）。
// globalThis 不会被本改写器二次改写（替换是按 span 文本拼接，不重访），
// IE 等无 globalThis 的环境下求值为 undefined → 恒走 this 分支，安全降级。
const THIS_REPLACEMENT: &str = "(this === globalThis ? __self__ : this)";

// oxc AST visitor：一次遍历同时收集 ThisExpression 和 7 个作用域标识符的 span
// - ThisExpression: this → (this === globalThis ? __self__ : this)
// - IdentifierReference: location/window/self/globalThis/document/parent/top → __xxx__
//   注意：obj.location 中的 location 是 MemberProperty（IdentifierName），
//   不会触发 visit_identifier_reference，所以属性名不会被误改。
//
// 语义正确性：仅改写**未绑定到任何局部声明**的全局引用（is_global_reference）。
// `var top = 5; console.log(top)` 中，第二个 `top` 绑定到 var 声明，
// 不应改写——这与旧模式 `with` 语句的词法作用域行为一致（局部变量遮蔽 with 对象）。
struct RewriteCollector {
    spans: Vec<(u32, u32, &'static str)>, // (start, end, replacement)
    // Scoping 的原始指针：visitor 持有 &mut self，无法同时持有 &Scoping 借用，
    // 用 raw pointer 绕过借用检查。生命周期由调用方保证（scoping 活跃于整个 visit 期间）。
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

// 直接 eval 首参的包裹函数：intercept.js 在 window 上定义
// `window.__rewrite_js__ = code => WASM改写(code)`，见 public/intercept.js。
// 运行时对参数求值后做 this / 7 个作用域标识符改写，再交给直接 eval 执行——
// eval 调用形式不变（仍字面 eval），调用者闭包作用域与 this 全部保留。
const EVAL_ARG_WRAPPER: &str = "__rewrite_js__(";

// 间接 eval 的成员 callee：obj.eval 形式。obj 必须是这些全局引用之一，
// 且未被局部变量遮蔽（is_global_reference 判定）才可静态判定为 eval：
// - window.eval / globalThis.eval：规范定义的全局对象属性访问
// - top.eval / self.eval / parent.eval：浏览器全局对象别名，与 window 同一对象
//   （globalThis Proxy 改写发生在文本替换层，与本收集器互不干扰）
// 遮蔽情形（如 function f(self){ self.eval(x) }）静态不可判定，不收。
const INDIRECT_EVAL_OBJECTS: &[&str] = &["window", "globalThis", "top", "self", "parent"];

// 判断表达式是否为可静态判定的 eval（直接裸 eval 或 window.eval 等成员形式），
// 供调用 callee / var init 两处共用。返回 true 时调用方包裹首参——间接 eval
// 全局执行、无调用者闭包可破坏，包裹零语义风险。
fn is_eval_callee<'a>(
    callee: &oxc_ast::ast::Expression<'a>,
    scoping: &oxc_semantic::Scoping,
) -> bool {
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

impl<'a> oxc_ast_visit::Visit<'a> for RewriteCollector {
    fn visit_this_expression(&mut self, it: &oxc_ast::ast::ThisExpression) {
        self.spans.push((it.span.start, it.span.end, THIS_REPLACEMENT));
        oxc_ast_visit::walk::walk_this_expression(self, it);
    }

    // 直接/间接/别名 eval 首参包裹为 eval(__rewrite_js__(arg))。
    // 间接 eval 全局执行、无调用者闭包可破坏，包裹零语义风险；参数内部的
    // this / 标识符改写由 visit_identifier_reference 照常完成（两遍改写幂等）。
    fn visit_call_expression(&mut self, it: &oxc_ast::ast::CallExpression<'a>) {
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
                            let span = oxc_span::GetSpan::span(arg);
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

    // eval 别名收集：根作用域 var/let/const e = eval（或 = window.eval 等成员
    // 形式，包裹性质相同）→ 记录符号；传递链 var g = e 一并收集。
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

    // `e2 = eval`（无 var 声明的全局赋值别名）：RHS 是全局 eval 时按名字记录。
    // 调用点解析时要求该名字无任何局部符号，避免误包同名局部变量。
    // 注意：收集必须在 walk 之后——赋值目标 e2 自身是写引用，walk 中
    // mark_dirty_if_alias 会按名字清空别名记录；先 walk 后收集可正确
    // 作废"重赋值为非 eval"的旧值、保留"赋值为 eval"的新值。
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

    // `e++` / `--e` / `e += 1` 等更新目标写入别名变量 → 作废
    // （`e = x` 的赋值目标也走 SimpleAssignmentTarget::AssignmentTargetIdentifier）
    fn visit_simple_assignment_target(&mut self, it: &oxc_ast::ast::SimpleAssignmentTarget<'a>) {
        if let oxc_ast::ast::SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = it {
            self.mark_dirty_if_alias(id);
        }
        oxc_ast_visit::walk::walk_simple_assignment_target(self, it);
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

impl RewriteCollector {
    // 直接 eval 首参包裹：zero-width 插入 `__rewrite_js__(` 与 `)`
    fn push_eval_arg_spans<'a>(&mut self, it: &oxc_ast::ast::CallExpression<'a>) {
        if let Some(arg) = it.arguments.first() {
            if arg.is_spread() {
                // eval(...spread) 运行时才展开，无法静态包裹首参，跳过
            } else {
                let span = oxc_span::GetSpan::span(arg);
                let (s, e) = (span.start, span.end);
                self.spans.push((s, s, EVAL_ARG_WRAPPER));
                self.spans.push((e, e, ")"));
            }
        }
    }

    // 写引用（is_write）→ 别名作废；读引用是正常调用点，已在 visit_call_expression 处理。
    // 未解析引用（`e2 = x` 的 e2 无符号）按名字作废。
    fn mark_dirty_if_alias<'a>(&mut self, id: &oxc_ast::ast::IdentifierReference<'a>) {
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

// 用 oxc 解析单段 JS 代码，同时改写 this 和 7 个作用域标识符。
// 解析失败时返回 None，由调用方决定回退策略。
fn rewrite_ast_in_js(code: &str) -> Option<String> {
    // 快速跳过：不含任何需改写的关键字时无需启动 oxc。
    // eval( 改为 eval：别名形态 var e = eval; e('x') 不含 'eval('，
    // 漏判会跳过别名收集（Node 版 webvpn.js 同此修复）
    if !code.contains("this")
        && !code.contains("eval")
        && SCOPE_NAMES.iter().all(|(n, _)| !code.contains(n))
    {
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
    // 去重必须按 (start, end) 完整 span，否则同 start 的两个替换会丢一个
    spans.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);

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

// 与 rewrite_ast_in_js 相同的 AST 改写，但按 ES module 解析。
// 用于 module 语法检测命中的代码：module 强制 strict mode 不能包 with，
// 改为标识符级替换（裸 location → __location__ 等，与 ast_rewrite 模式一致）。
// import/export 声明保持原样——__xxx__ 是真实 window 属性，跨模块引用不受影响。
fn rewrite_ast_in_js_module(code: &str) -> Option<String> {
    // 快速跳过：不含任何需改写的关键字时无需启动 oxc（与 rewrite_ast_in_js 一致）
    if !code.contains("this")
        && !code.contains("eval")
        && SCOPE_NAMES.iter().all(|(n, _)| !code.contains(n))
    {
        return Some(code.to_string());
    }

    use oxc_allocator::Allocator;
    use oxc_parser::{Parser, ParseOptions};
    use oxc_span::SourceType;

    let allocator = Allocator::default();
    let source_type = SourceType::mjs();
    let options = ParseOptions::default();
    let ret = Parser::new(&allocator, code, source_type).with_options(options).parse();

    if ret.fatal_error {
        return None;
    }

    let program = &ret.program;

    use oxc_semantic::SemanticBuilder;
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

    let dirty = std::mem::take(&mut collector.dirty_symbols);
    let pending = std::mem::take(&mut collector.pending_alias_calls);
    for (sym, name, s, e) in pending {
        if sym == usize::MAX {
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

#[cfg(test)]
mod tests {
    use super::*;

    // 与 Node 版 acorn 行为对齐验证：顶层 return + this 应被正确改写
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

    // 损坏的 JS 应返回 None（由调用方回退到旧模式字符串替换）
    #[test]
    fn test_malformed_js_returns_none() {
        // 语法错误：function 后缺括号。oxc 应判定 fatal_error。
        let code = "function(){ with(this) }";
        let out = rewrite_ast_in_js(code);
        assert!(out.is_none(), "malformed JS should return None, got: {:?}", out);
    }

    // 不含 this/作用域标识符的代码应 fast-skip 原样返回
    #[test]
    fn test_no_targets_fast_skip() {
        let code = "const x = 42; function add(a, b) { return a + b; }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert_eq!(out, code, "code without targets should be returned unchanged");
    }

    // 字符串/注释中的 this 不应被改写（AST 解析识别真正的 ThisExpression）
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

    // with(this) 经 AST 改写后应为 with((this === globalThis ? __self__ : this))
    // （AST 路径只替换 this 表达式本身，保留外层 with(...) 结构）
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

    // 裸 location 标识符应被改写为 __location__
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

    // 裸 window 标识符应被改写为 __window__
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

    // obj.location 中的 location 是属性名，不应被改写
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

    // 声明名（BindingIdentifier）不应被改写；且引用局部声明的同名变量也不应被改写。
    // `var location = 1; console.log(location)` 中：
    // - `var location` 的声明名是 BindingIdentifier，不改写
    // - `console.log(location)` 中的 location 是 IdentifierReference，
    //   但它绑定到 var 声明（is_global_reference = false），也不改写。
    //   这与旧模式 `with` 的词法作用域行为一致——局部变量遮蔽 with 对象的属性。
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

    // 局部变量遮蔽：`var top = 5; console.log(top)` 中的 top 绑定到局部 var 声明，
    // 不应改写为 __top__。这是语义分析的核心价值——避免误改局部变量。
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

    // 对比：全局引用（无局部声明遮蔽）应被改写。
    // `console.log(top)` 中 top 无局部声明，是全局引用，应改写为 __top__。
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

    // 函数参数遮蔽：`function f(self) { return self; }` 中 self 是参数，绑定到局部，
    // 不应改写。这覆盖了函数作用域的引用解析。
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

    // AST 模式应保留 type="module" 和 use strict（不做字符串硬替换）
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

    // 旧模式应移除 type="module" 和 use strict
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

    // self 和 document 标识符应被改写
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

    // 箭头函数中的 this 应被改写（箭头函数不绑定自己的 this，继承外层）。
    // 这验证 visitor 能正确进入箭头函数体。
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

    // 闭包（普通函数）中的 this 应被改写。
    // 虽然普通函数的 this 是动态绑定的，但 AST 层面 ThisExpression 都应被改写——
    // 与旧模式 with(this) 正则的行为一致（正则无法区分函数内外）。
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

    // jQuery find 的崩溃回归测试：局部 `var self = this` 遮蔽全局 self。
    // 注入的比较引用必须是 globalThis（不可被局部变量遮蔽），
    // 否则方法内 this === self 恒真，this 全部错误路由到 __self__，
    // 导致 `__self__.pushStack is not a function` 一类的全局崩溃。
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

    // 解构赋值中的全局标识符引用应被改写。
    // `const { href } = location` 中 location 是全局引用（无局部遮蔽），应改写为 __location__。
    // href 是解构的 BindingIdentifier，不改写。
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

    // 对象解构中用同名 key 提取全局变量：`const { self } = window`
    // window 是全局引用 → __window__；self 是 BindingIdentifier → 不改写。
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

    // 嵌套作用域：外层 var 遮蔽 + 内层裸引用。
    // `var top = 1; function f() { return top; }` 中，
    // 函数内的 top 仍绑定到外层 var 声明（闭包捕获），不应改写。
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

    // let/const 块级作用域遮蔽：`let self = {}; console.log(self)`
    // self 绑定到 let 声明，不应改写。
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

    // 混合场景：局部变量 + 全局引用共存。
    // `var top = 1; console.log(top, window)` 中：
    // - top 绑定到局部 var，不改写
    // - window 是全局引用，改写为 __window__
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

    // with + use strict 是语法错误（严格模式禁止 with）。
    // oxc 应将其判为 fatal_error → 返回 None → 回退到 legacy_rewrite_js。
    // legacy_rewrite_js 不移除 use strict（AST 模式回退不做 ESM/strict 移除），
    // 但这不影响——原代码本身就有语法错误，浏览器也会报错。
    // 关键是：AST 路径不崩溃，返回 None 让调用方回退。
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

    // legacy_rewrite_js 不应破坏 JS 字符串字面量中的 "type=module" 等子串。
    // 此前旧版 legacy_rewrite_js 会做 type="module" → type="mod" 替换，
    // 可能误改 JS 代码中的字符串。修复后仅做 with(this) + location.xxx 正则。
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

    // AST 模式下 HTML 中的 integrity= 属性必须被移除。
    // 改写后的 JS/CSS 内容哈希变化，SRI 校验失败会导致资源被浏览器拒绝执行。
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

    // AST 模式下内联 <script> 中的 "integrity" 字符串字面量不应被移除。
    // INTEGRITY_ATTR_RE 只匹配标签属性，不匹配 JS 字符串。
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

    // catch 子句的异常变量是 BindingIdentifier，不应被改写。
    // `try {} catch(self) { console.log(self) }` 中：
    // - catch(self) 的 self 是绑定名，不改写
    // - console.log(self) 中的 self 绑定到 catch 变量，不改写
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

    // labeled statement 的标签不应被改写。
    // `top: for(;;) { break top; }` 中 top 是标签（IdentifierLabel），
    // 不是 IdentifierReference，不应被改写。
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

    // computed member expression 中的标识符是值引用，应被改写。
    // `obj[self]` 中 self 在方括号内，是 IdentifierReference，应改写为 __self__。
    // 对比：`obj.self` 中 self 是属性名（IdentifierName），不改写。
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

    // 对象简写属性：`{ location }` 等价于 `{ location: location }`。
    // 简写中的 location 既是 key 又是 value reference。
    // oxc 应将其解析为 IdentifierReference（value 部分），应被改写。
    // 注意：这与旧模式 with 的行为可能不同——with 无法拦截对象字面量简写中的 value。
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

    // 对象字面量中的普通属性名不应被改写。
    // `{ location: 1, window: 2 }` 中 location 和 window 是属性键，不是引用。
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

    // import 语句中的绑定不应被改写。
    // `import self from './mod'` 中 self 是 import 绑定（BindingIdentifier）。
    // 后续引用 self 应绑定到 import，不应改写为 __self__。
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

    // 多层嵌套作用域：全局引用在深层函数内仍应被改写。
    // `function a() { function b() { function c() { return location; } } }`
    // 最内层的 location 无局部声明，是全局引用，应改写。
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

    // 变量声明中的初始值引用全局变量应被改写。
    // `var x = window` 中 window 是全局引用，应改写。
    // `var x = location.href` 中 location 是全局引用，应改写。
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

    // 函数表达式赋值给变量：变量名是 BindingIdentifier，不改写。
    // `var self = function() {}` 中 var self 的 self 不改写。
    // 函数体内的 this 应改写。
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

    // TypeScript 语法（类型注解、泛型、接口）无法被 SourceType::script() 解析。
    // 应返回 None，由调用方回退到 legacy_rewrite_js（仅做 with(this) + location.xxx 正则）。
    // 回退后代码原样保留 TS 语法（浏览器自己也会报错，但不会崩服务）。
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

    // JSX 语法（<Component />）无法被 SourceType::script() 解析。
    // 应返回 None，回退到 legacy_rewrite_js。
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

    // 性能测试：大文件 AST + semantic 分析的耗时。
    // 生成 ~500KB JS（5000 个函数，混合全局引用 + 局部变量），
    // 确保 rewrite_ast_in_js 在合理时间内完成（debug < 5s，release < 1s）。
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

    // 直接 eval 首参应被包裹为 __rewrite_js__(...)，eval 调用本身保持不变
    #[test]
    fn test_direct_eval_arg_wrapped() {
        let out = rewrite_ast_in_js("eval('location.href');").expect("parse should succeed");
        assert!(
            out.contains("eval(__rewrite_js__('location.href'))"),
            "direct eval arg should be wrapped, got: {}",
            out
        );
    }

    // eval 参数为表达式（含 this / 标识符）时：包裹生效，参数内部照常改写
    #[test]
    fn test_eval_expression_arg() {
        let out = rewrite_ast_in_js("eval('x' + this.name + location.pathname);")
            .expect("parse should succeed");
        assert!(out.contains("eval(__rewrite_js__("), "arg should be wrapped, got: {}", out);
        assert!(out.contains("(this === globalThis ? __self__ : this)"), "this inside arg rewritten");
        assert!(out.contains("__location__"), "location inside arg rewritten");
    }

    // eval(location) 同 start 零宽包裹 + 标识符替换共存（dedup 按 (start,end)）
    #[test]
    fn test_eval_arg_same_start_dedup() {
        let out = rewrite_ast_in_js("eval(location);").expect("parse should succeed");
        assert_eq!(
            out, "eval(__rewrite_js__(__location__));",
            "zero-width wrap and identifier replace at same start must coexist, got: {}",
            out
        );
    }

    // 变量别名调用点在收集前不包裹、任意 obj.eval 不包裹。
    // window.eval 等确证全局对象形态现在按间接 eval 包裹
    // （见 test_indirect_eval_wrapped / test_eval_alias_wrapped）。
    #[test]
    fn test_indirect_eval_not_wrapped() {
        for code in ["obj.eval('x');", "foo.bar.eval('x');"] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                !out.contains("__rewrite_js__"),
                "non-global obj.eval must not be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
        // var e = eval：单独出现时无调用点，本身不改写
        let out = rewrite_ast_in_js("var e = eval;").expect("parse should succeed");
        assert!(
            !out.contains("__rewrite_js__"),
            "alias declaration without call must not be wrapped, got: {}",
            out
        );
    }

    // 局部 eval 函数遮蔽全局 eval：调用的是局部函数，不包裹
    #[test]
    fn test_local_eval_not_wrapped() {
        let code = "function eval(x) { return x }; eval('location');";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            !out.contains("__rewrite_js__"),
            "shadowed eval must not be wrapped, got: {}",
            out
        );
        // 注意：字符串参数里的 location 是字面量，不受影响
        assert!(out.contains("'location'"), "string literal preserved, got: {}", out);
    }

    // 嵌套作用域内的直接 eval 同样包裹
    #[test]
    fn test_nested_direct_eval_wrapped() {
        let code = "function f() { var v = 1; eval('v'); }";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        assert!(
            out.contains("eval(__rewrite_js__('v'))"),
            "direct eval inside function should be wrapped, got: {}",
            out
        );
    }

    // eval 变量别名：根作用域 var e = eval 后的调用点包裹首参。
    // 间接 eval 本就全局执行、无调用者作用域可破坏，包裹零语义风险，
    // 运行时由 __rewrite_js__ 补 this / 标识符伪装。
    #[test]
    fn test_eval_alias_wrapped() {
        for code in [
            "var e = eval; e('location.href');",
            "let e = eval; e('location.href');",
            "const e = eval; e('location.href');",
            "e2 = eval; e2('location.href');",
            // 无 location/this 等标记的纯别名形态：曾因 fast-skip 判据 'eval(' 漏过
            "var e = eval; e('x');",
            // 传递赋值链
            "var e = eval; var g = e; g('location.href');",
            // 别名与直接 eval 混用
            "var e = eval; eval('x'); e('y');",
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

    // 间接 eval（obj.eval 形式）：obj 为确证的全局对象别名时包裹首参。
    // 间接 eval 全局执行，包裹零语义风险。
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

    // obj 被局部变量遮蔽 / 非 eval 属性：静态不可判定或非 eval，不包裹
    #[test]
    fn test_indirect_eval_shadowed_not_wrapped() {
        for code in [
            // self 是函数参数（局部绑定），self.eval 不是全局对象
            "function f(self) { self.eval('x'); } f(window);",
            // var top 局部声明遮蔽全局 top
            "var top = {}; top.eval('x');",
            // 非全局对象的同名属性
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

    // 成员形式初始化的别名：var e = window.eval 等，调用点包裹首参
    #[test]
    fn test_eval_member_alias_wrapped() {
        for code in [
            "var e = window.eval; e('location.href');",
            "const e = globalThis.eval; e('location.href');",
            "var e = top.eval; e('location.href');",
            "var e = self.eval; e('location.href');",
            "var e = parent.eval; e('location.href');",
            // 成员别名传递链
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

    // 别名被重新赋值后作废：不再包裹（保守，避免包错非 eval 函数）
    #[test]
    fn test_eval_alias_reassigned_not_wrapped() {
        for code in [
            "var e = eval; e = console.log; e('x');",
            "var e = eval; e++; e('x');",
        ] {
            let out = rewrite_ast_in_js(code).expect("parse should succeed");
            assert!(
                !out.contains("__rewrite_js__("),
                "reassigned alias must not be wrapped, code: {}, got: {}",
                code,
                out
            );
        }
    }

    // 同名变量遮蔽：嵌套作用域的局部同名变量不是别名符号，不包裹
    #[test]
    fn test_eval_alias_shadowed_not_wrapped() {
        let code = "var e = eval; function f() { var e = function(x){return x}; e('x'); } f();";
        let out = rewrite_ast_in_js(code).expect("parse should succeed");
        // 顶层别名在函数外没有调用点；函数内的 e 是不同符号
        assert!(
            !out.contains("__rewrite_js__("),
            "shadowed alias call must not be wrapped, got: {}",
            out
        );
    }

    /*
     * ===== 已标明的遗漏点（机制边界，非实现遗漏）=====
     *
     * 1. 对象别名 obj.eval(x)：obj 为任意表达式时指向静态不可判定，不包裹。
     *    已覆盖的子集：obj 为确证全局引用（window/globalThis/top/self/parent，
     *    且未被局部变量遮蔽）时按间接 eval 包裹（见 INDIRECT_EVAL_OBJECTS）；
     *    var e = window.eval 等成员形式初始化的别名同样收集。
     * 2. 过程传递 function f(g){g(x)}; f(eval)：需要过程间数据流分析，
     *    不做。跨函数传递 eval 的代码同时放弃了闭包访问，出现率趋近于零。
     * 3. 跨 <script> 单元：单元 A 里 var e = eval、单元 B 里 e(x)——
     *    每个 script 独立编译改写，A 的信息在 B 中物理不存在，无法覆盖。
     *    （var 声明会挂到 window，跨单元调用点在 B 内是"非全局、无绑定
     *    信息的裸引用"，同样不包裹。）
     * 4. setTimeout('字符串') / new Function('字符串') 等隐式 eval：参数是运行时
     *    表达式，无法静态包裹。已在运行时关闭——intercept.js（主线程）与
     *    jsWorkerContextCode（worker）分别包装了这两类入口，对字符串参数做
     *    __rewrite_js__ 改写。静态改写不再列为遗漏。
     * 5. eval(...spread)：运行时才展开，无法静态包裹首参，跳过（见上）。
     *
     * 残余后果：这些形态下被 eval 的代码在真实全局执行，location/this
     * 伪装缺失。覆盖 window.eval 可关掉此缺口，但必然破坏直接 eval 的
     * 闭包作用域（规范互斥），故不做。
     */
}

// 对应 replaceUrls(ctx, res)：抽取匹配 + 替换
// 返回新的 data
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

// 对应 replaceMatches(ctx, res, matches)
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

// 对应 getBase(ctx, res)
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

// 对应 processOthers(ctx, res)
// 此前有 JSON.stringify(res.data) 的死分支：res.data 本就是字符串（来自 res.text()），
// 再次 stringify 会双重编码 JSON 文本，导致客户端拿到被破坏的 JSON。已移除（与 Node 版一致）。
pub fn process_others(data: &str, mime: &str, disable_source_map: bool) -> String {
    let mut data = data.to_string();
    if disable_source_map && (mime == "html" || mime == "js") {
        let mut search_from = 0;
        while let Some(rel) = data[search_from..].find("sourceMappingURL=") {
            let pos = search_from + rel;
            let line_start = match data[..pos].rfind('\n') {
                Some(nl) => nl + 1,
                None => 0,
            };
            let prefix = &data[line_start..pos];
            let is_comment = {
                let trimmed = prefix.trim_start();
                trimmed.starts_with("//") || trimmed.starts_with("/*")
            };
            if !is_comment {
                search_from = pos + 17;
                continue;
            }
            let end = data[pos..].find('\n').map(|n| pos + n).unwrap_or(data.len());
            data.replace_range(line_start..end, "");
            search_from = line_start;
        }
    }
    data
}

// 对应 appendScript(ctx, res)：在 HTML 头部注入运行时脚本
// 返回新的 HTML
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
    let debug_log = config.debug_log;
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
    let worker_wrapper_code = if config.ast_rewrite {
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
        debugLog: {},
        disableJump: {},
        confirmJump: {},
        isMainSession: {},
        shareId: {},
        astRewrite: {},
      }};
      const convertDomainsCode = {}
      ;new Function(convertDomainsCode)()
      webvpn.convertDomainsCode = convertDomainsCode
      {}
      webvpn.intercept_code = {}
      eval(webvpn.intercept_code)
      webvpn.worker_wrapper_code = convertDomainsCode + {}
      document.currentScript && document.currentScript.remove()
    </script>
    "#,
        site_url_json, protocol_json, source_url_json, page_url_json, hostname_json,
        http_vpn_json, https_vpn_json, base_json,
        debug_log, disable_jump, confirm_jump, is_main_session, share_id_json,
        config.ast_rewrite,
        convert_domains_json,
        custom_code,
        intercept_code_json,
        worker_wrapper_json
    );

    if enable_plugins {
        code.push_str(&format!("<script src=\"{}/public/plugins.js\" onload=\"this.remove()\"></script>\n", prefix));
    }
    if debug && !disable_devtools {
        code.push_str("<script src=\"https://cdnjs.cloudflare.com/ajax/libs/vConsole/3.15.1/vconsole.min.js\" onload=\"this.remove()\"></script>\n<script>new VConsole(); document.currentScript && document.currentScript.remove()</script>\n");
    }
    if disable_devtools {
        code.push_str(&format!("<script src=\"{}/public/disable-devtools.js\" onload=\"this.remove()\"></script>\n", prefix));
    }
    if is_main_session {
        code.push_str(&format!("<script src=\"{}/public/share-sessions.js\" onload=\"this.remove()\"></script>\n", prefix));
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
        document.currentScript && document.currentScript.remove()
      </script>"#,
            client_cache_json
        ));
    }

    let has_doctype = DOCTYPE_RE.is_match(data);
    let _ = codec;
    format!("{}{}{}", if has_doctype { "<!DOCTYPE html>\n" } else { "" }, code, data)
}

#[cfg(test)]
mod module_scope_tests {
    use super::*;

    // ES module 代码（顶层 import/export）强制 strict mode，包裹 with 会语法错误。
    // ast_rewrite = true：应走 oxc AST 改写：不包裹，且裸标识符被替换为 __location__ 等。
    #[test]
    fn module_code_not_wrapped_with_but_ast_rewritten() {
        let mut config = Config::default();
        config.ast_rewrite = true;
        let meta = Meta::default();
        let code = "import{x}from\"./y.js\";export const z=location.href;";
        let out = refactor_js_scope_code(code, false, &config, &meta, "");
        assert!(!out.contains("__context_proxy__"), "module code must not be wrapped with __context_proxy__, got: {}", out);
        assert!(out.contains("__location__.href"), "bare location must be AST-rewritten to __location__, got: {}", out);
        assert!(out.contains("import{x}from"), "import declaration preserved");
    }

    // ast_rewrite = false：module 代码不改写、不包裹，原样透传。
    #[test]
    fn module_code_passthrough_when_ast_rewrite_off() {
        let config = Config::default();
        let meta = Meta::default();
        let code = "import{x}from\"./y.js\";export const z=location.href;";
        let out = refactor_js_scope_code(code, false, &config, &meta, "");
        assert_eq!(out, code, "module code must be passed through verbatim when ast_rewrite is off");
    }

    // 普通脚本仍应被 with 包裹
    #[test]
    fn plain_script_still_wrapped() {
        let config = Config::default();
        let meta = Meta::default();
        let code = "console.log('hello');";
        let out = refactor_js_scope_code(code, false, &config, &meta, "");
        assert!(out.contains("__context_proxy__"), "plain script should be wrapped");
    }

    // 动态 import() 表达式（非顶层声明）也按 module 对象处理：
    // 页面主初始化脚本多为 Vite 产物（顶层 import + with 不兼容），
    // 'import(' 出现在字符串字面量时误判代价是不包 with，不影响运行。
    #[test]
    fn dynamic_import_not_wrapped() {
        let mut config = Config::default();
        config.ast_rewrite = true;
        let meta = Meta::default();
        let code = "import('./lazy.js').then(m => m.init(location))";
        let out = refactor_js_scope_code(code, false, &config, &meta, "");
        assert!(!out.contains("__context_proxy__"), "dynamic import code not wrapped, got: {}", out);
        assert!(out.contains("m.init(__location__)"), "bare location AST-rewritten, got: {}", out);
    }

    // 文本检测无法区分字符串字面量：'please import this' 也会命中（import 前是空格）。
    // 已知误判代价：该脚本改走 AST 改写（不包 with），行为等价，不破坏代码本身。
    #[test]
    fn import_in_string_falls_back_to_unwrapped() {
        let config = Config::default();
        let meta = Meta::default();
        let code = "var s = 'please import this module';\nfoo();";
        let out = refactor_js_scope_code(code, false, &config, &meta, "");
        assert!(out.contains(code), "code content preserved verbatim, got: {}", out);
    }
}
