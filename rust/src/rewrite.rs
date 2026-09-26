// JS / HTML 改写：对应 customResponse / refactorJsScopeCode / calcHoistIdentifiersCode
// processHtml / processHtmlScopeCodes / processJsScopeCode / appendScript

use regex::Regex;
use once_cell::sync::Lazy;
use crate::config::Config;
use crate::context::Meta;
use crate::domain::DomainCodec;
use crate::headers::transform_url;

/// 预编译热路径正则（避免每个请求重复 Regex::new）
/// customResponse: with(this) 重写
static WITH_THIS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\s\{\}\;]?with\s*\(\s*this\s*\)").unwrap());
/// customResponse: location.xxx -> location.__xxx__
static LOCATION_PROP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"location\.(hostname|host|origin|href|protocol|navigate|assign|replace|reload|toString)").unwrap());
/// replaceUrls(html): href/src/action/srcset/poster 属性
static HTML_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\s(href|src|action|srcset|poster)=("|')?(http:|https:|http%3A|https%3A|//)[^\s>]*"#).unwrap());
/// replaceUrls(html/css): url(...)
static CSS_URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)url\([\"\']?(http|//)[^\"\')]+"#).unwrap());
/// replaceUrls(html/css): @import
static CSS_IMPORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)@import\s[\"\'](http|//)[^\"\']+"#).unwrap());
/// replaceMatches: 域名有效性检查
static WORD_DOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\w]+\.").unwrap());
/// replaceMatches: &#x 实体解码
static HEX_ENTITY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#x\w+;").unwrap());
/// calcHoistIdentifiersCode: function/class 名提取
static HOIST_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(function|class)\s+([\$\_\w]+)\s*\(").unwrap());
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
        "break", "case", "catch", "continue", "default", "delete", "do", "else", "finaly", "for",
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
        function transformUrl (url) {
          url = (url ? url.toString() : '').trim()
          if (url.startsWith('//')) {
            url = target.protocol + url
          } else if (url.startsWith('/')) {
            url = new URL(url, target.href).href
          }
          const u = new URL(url)
          const vpnDomain = u.protocol === 'http:' ? httpVpnDomain : httpsVpnDomain
          if (u.host.includes(vpnDomain)) return url
          return url.replace(u.host, encodeHost(u.host) + vpnDomain)
        }

        self.webvpn = { target, site, transformUrl }
        const globalCons = ['self', 'globalThis']
        const locationAttrs = ['hash', 'host', 'hostname', 'href', 'origin', 'pathname', 'port', 'protocol', 'search']

        self.__location__ = {}
        locationAttrs.forEach(key => {
          self.location['__' + key + '__'] = webvpn.target[key]
          for (let i = 0; i < 2; i++) {
            if (i) key = '__' + key + '__'
            Object.defineProperty(self.__location__, key, {
              get () {
                key = key.replaceAll('__', '')
                return webvpn.target[key] || location[key]
              }
            })
          }
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
            return value
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
            const init = {}
            for (let key in input) {
              const value = input[key]
              if (key === 'url' || typeof value === 'function') continue
              if (key === 'mode' && value === 'navigate') continue
              init[key] = value
            }
            input = new Request(newUrl, init)
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
    let mut names: Vec<String> = Vec::new();
    for caps in HOIST_RE.captures_iter(code) {
        let name = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if !JS_KEYWORDS.contains(&name) && !names.iter().any(|n| n == name) {
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
    CSP_META_RE.replace_all(data, "").to_string()
}

/// 对应 processHtmlScopeCodes(ctx, code)
/// 抽取 HTML 中所有内联 <script> 内容，逐个用 refactorJsScopeCode 包裹后回填
pub fn process_html_scope_codes(
    code: &str,
    config: &Config,
    meta: &Meta,
    convert_domains_code: &str,
) -> String {
    let re = SCRIPT_TAG_RE.clone();
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
        if let Some(type_idx) = attrs.find("type=") {
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
pub fn custom_response(data: &str) -> String {
    let mut data = data
        .replace("type=\"module\"", "type=\"mod\"")
        .replace("type=module", "type=mod")
        .replace("nomodule", "nomod")
        .replace(" integrity", " no-integrity")
        .replace("use strict", "");
    // with(this) -> with(this === self ? __self__ : this)
    data = WITH_THIS_RE.replace_all(&data, " with(this === self ? __self__ : this)").to_string();
    // location.xxx -> location.__xxx__
    data = LOCATION_PROP_RE.replace_all(&data, |caps: &regex::Captures| {
        format!("location.__{}__", &caps[1])
    }).to_string();
    data
}

/// 对应 replaceUrls(ctx, res)：抽取匹配 + 替换
/// 返回新的 data
pub fn replace_urls(data: &str, mime: &str, config: &Config, meta: &Meta, codec: &DomainCodec) -> String {
    let mut matches: Vec<String> = Vec::new();

    if mime == "html" {
        for m in HTML_ATTR_RE.find_iter(data) {
            let s = m.as_str().to_string();
            if !matches.contains(&s) {
                matches.push(s);
            }
        }
    }
    if mime == "html" || mime == "css" {
        for m in CSS_URL_RE.find_iter(data) {
            let s = m.as_str().to_string();
            if !matches.contains(&s) {
                matches.push(s);
            }
        }
        for m in CSS_IMPORT_RE.find_iter(data) {
            let s = m.as_str().to_string();
            if !matches.contains(&s) {
                matches.push(s);
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
        let before_slash = match m.find("//") {
            Some(i) => &m[..i],
            None => continue,
        };
        if before_slash.contains("http") {
            // url = match.slice(match.indexOf('http'), -1)
            // 注意 JS slice(-1) 是去掉最后一个字符
            let http_idx = m.find("http").unwrap();
            url = m[http_idx..m.len().saturating_sub(1)].to_string();
            prefix = if m.find("https").map(|i| i > 0).unwrap_or(false) {
                "https://".to_string()
            } else {
                "http://".to_string()
            };
        } else {
            // url = scheme + ':' + match.slice(match.indexOf('//'), -1)
            let slash_idx = m.find("//").unwrap();
            // quote = match[match.indexOf('//') - 1]  （取 // 前一个字符）
            if slash_idx > 0 {
                quote = (m.as_bytes()[slash_idx - 1] as char).to_string();
            }
            url = format!("{}:{}", scheme, &m[slash_idx..m.len().saturating_sub(1)]);
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

    // 按 key 长度降序排序，逐个替换
    dict.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    let mut data = data.to_string();
    for (key, value) in dict {
        data = data.replace(&key, &value);
    }
    data
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
pub fn process_others(data: &str, mime: &str, disable_source_map: bool) -> String {
    let mut data = data.to_string();
    if mime == "json" {
        // JSON.stringify(res.data) —— 这里 data 已是字符串，做 JSON 字符串串化
        data = serde_json::to_string(&data).unwrap_or(data);
    }
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
    global_cache: &crate::cache::GlobalCache,
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

    // worker_wrapper_code 模板：convertDomainsCode + worker_context(siteUrl替换) + scopePrefix + #CODE# + } + scopeSuffix
    let worker_context = js_worker_context_code().replace("#siteUrl#", &site_url);
    let worker_wrapper_code = format!(
        "{}\n        {}\n        {}\n          #CODE#\n        }}\n        {}",
        convert_domains_code,
        worker_context,
        js_scope_prefix_code(),
        js_scope_suffix_code()
    );

    // intercept_code = JSON.stringify(jsInterceptCode)
    let intercept_code_json = serde_json::to_string(js_intercept_code).unwrap_or_else(|_| "''".to_string());

    let mut code = format!(
        r#"
    <script>
      self.webvpn = {{
        siteUrl: '{}',
        protocol: '{}:',
        sourceUrl: '{}',
        pageUrl: '{}',
        hostname: '{}',
        httpVpnDomain: '{}',
        httpsVpnDomain: '{}',
        base: '{}',
        interceptLog: {},
        disableJump: {},
        confirmJump: {},
        isMainSession: {},
        shareId: '{}',
      }};
      const convertDomainsCode = `{}`
      eval(convertDomainsCode)
      {}
      webvpn.intercept_code = {}
      eval(webvpn.intercept_code)
      webvpn.worker_wrapper_code = convertDomainsCode + `
        {}
      `
    </script>
    "#,
        site_url, scheme, target.as_str(), page_url, target.host_str().unwrap_or(""),
        http_vpn_domain, https_vpn_domain, base,
        intercept_log, disable_jump, confirm_jump, is_main_session, share_id,
        convert_domains_code,
        custom_code,
        intercept_code_json,
        worker_wrapper_code
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
        let client_cache = global_cache.get_item(&format!("{}-clientCache", share_id)).await.unwrap_or_else(|| "{}".to_string());
        code.push_str(&format!(
            r#"<script>
        const {{ cookie, localStorage: local }} = {}
        document.cookie += cookie
        localStorage.clear()
        for (let key in local) localStorage[key] = local[key]
      </script>"#,
            client_cache
        ));
    }
    code.push_str("<script>\n      const ss = Array.from(document.querySelectorAll('script'));\n      ss.forEach(script => script.remove());\n    </script>\n");

    let has_doctype = DOCTYPE_RE.is_match(data);
    let _ = codec;
    format!("{}{}{}", if has_doctype { "<!DOCTYPE html>\n" } else { "" }, code, data)
}
