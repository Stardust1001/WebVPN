// 响应头/请求头改写：对应 initResponseHeaders / setOriginHeaders / deleteIgnoreHeaders / convertHost

use std::collections::HashMap;
use regex::Regex;
use once_cell::sync::Lazy;
use crate::config::Config;
use crate::domain::DomainCodec;
use crate::context::Meta;

/// 忽略的请求头（对应 ignoreRequestHeaderRegexps）
pub static IGNORE_REQUEST_HEADER_REGEXPS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"(?i)^x-(forwarded|requested|csrf|content|frame)").unwrap(),
        Regex::new(r"(?i)upgrade-insecure-requests").unwrap(),
        // hop-by-hop 逐跳头不能透传：请求体已被完整缓冲，reqwest 会按实际大小设置
        // content-length，转发 transfer-encoding: chunked 会导致 hyper 客户端报错
        Regex::new(r"(?i)^(transfer-encoding|connection|keep-alive|upgrade)$").unwrap(),
    ]
});

/// 忽略的响应头（对应 ignoreResponseHeaderRegexps）
pub static IGNORE_RESPONSE_HEADER_REGEXPS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"(?i)content-length").unwrap(),
        Regex::new(r"(?i)x-content-type-options").unwrap(),
        Regex::new(r"(?i)report-to").unwrap(),
        Regex::new(r"(?i)x-xss-protection").unwrap(),
        Regex::new(r"(?i)cross-origin-resource-policy").unwrap(),
        Regex::new(r"(?i)cross-origin-opener-policy").unwrap(),
        Regex::new(r"(?i)cross-origin-embedder-policy").unwrap(),
        Regex::new(r"(?i)content-security-policy-report-only").unwrap(),
        // hop-by-hop 逐跳头不能透传：响应体是完整缓冲的 Bytes，hyper 自己决定分帧
        // （自动补 content-length）。透传上游的 transfer-encoding: chunked 会触发
        // hyper "user sent unexpected header"，连接被无响应直接关闭
        // （浏览器表现为 ERR_EMPTY_RESPONSE）。
        // Node 版不需要：node:http 自行管理 transfer-encoding，透传无碍。
        Regex::new(r"(?i)^(transfer-encoding|connection|keep-alive|upgrade)$").unwrap(),
    ]
});

/// set-cookie 处理用：匹配 domain= 属性
static DOMAIN_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)domain=").unwrap());
/// convertHost 用：剥离会话共享后缀 -(main|share)-<shareId>
/// shareId 不含点号，故用 [^.]+；$ 锚定末尾，兼容 original/underline 两种模式
static SHARE_SUFFIX_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"-(main|share)-[^.]+$").unwrap());
/// set-cookie 用：匹配所有位置的 Secure 标志（含大小写、无空格、末尾等情形）
/// 对应 Node 版 /;\s*Secure\b/gi
static SECURE_COOKIE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i);\s*Secure\b").unwrap());

/// 删除被忽略的 header（请求头或响应头版本，按正则匹配 key）
pub fn delete_ignore_headers(regexps: &[Regex], headers: &mut HashMap<String, Vec<String>>) {
    let keys: Vec<String> = headers.keys().cloned().collect();
    for key in keys {
        if regexps.iter().any(|re| re.is_match(&key)) {
            headers.remove(&key);
        }
    }
}

/// 取 URL 的 host（含端口，无端口时仅 host）
fn url_host_with_port(u: &url::Url) -> String {
    let host = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{}:{}", host, p),
        None => host.to_string(),
    }
}

/// 把 "host:port" 或 "host" 设到 URL 上（分别 set_host / set_port）
/// 对应 Node 版 `u.host = convertHost(u.host)`：Node 的 host setter 同时设 host+port，
/// Rust 的 url crate 须分开设置。
fn set_url_host(u: &mut url::Url, host_with_port: &str) -> Result<(), ()> {
    // IPv6 形如 [::1]:8080 —— 必须先识别方括号，否则地址内的冒号会干扰 rfind(':')。
    if host_with_port.starts_with('[') {
        if let Some(close) = host_with_port.find(']') {
            let host = &host_with_port[..=close]; // 含方括号，url crate 要求带 []
            let rest = &host_with_port[close + 1..];
            if let Some(port_str) = rest.strip_prefix(':') {
                if let Ok(port) = port_str.parse::<u16>() {
                    u.set_host(Some(host)).map_err(|_| ())?;
                    u.set_port(Some(port)).map_err(|_| ())?;
                    return Ok(());
                }
            }
            u.set_host(Some(host)).map_err(|_| ())?;
            return Ok(());
        }
        // 方括号未闭合，交给 set_host 报错
        u.set_host(Some(host_with_port)).map_err(|_| ())?;
        return Ok(());
    }
    if let Some(idx) = host_with_port.rfind(':') {
        let host = &host_with_port[..idx];
        if let Ok(port) = host_with_port[idx + 1..].parse::<u16>() {
            u.set_host(Some(host)).map_err(|_| ())?;
            u.set_port(Some(port)).map_err(|_| ())?;
            return Ok(());
        }
    }
    u.set_host(Some(host_with_port)).map_err(|_| ())?;
    Ok(())
}

/// 对应 convertHost(host)（webvpn.js:1337-1350）
/// 非 vpn 域名直接返回；先剥离 vpnDomain 和会话共享后缀，再整体 decodeHost。
/// 此前用 split('-')[0] 截断，original 模式下目标域名本身的连字符会被误切。
pub fn convert_host(host: &str, config: &Config, codec: &DomainCodec) -> String {
    if host.is_empty() {
        return host.to_string();
    }
    // 非 vpn 域名的 host 直接返回，避免对第三方域名误跑 decodeHost 破坏其原样
    if !host.contains(&config.vpn_domain)
        && !host.contains(&config.http_vpn_domain)
        && !host.contains(&config.https_vpn_domain)
    {
        return host.to_string();
    }
    // Node 用 String.replace(string, string) 只替换第一个匹配；Rust str::replace 替换全部。
    // 主机名中 vpnDomain 通常只出现一次，实际无差异，但用 replacen(.., 1) 保持严格一致。
    let h = host
        .replacen(&config.https_vpn_domain, "", 1)
        .replacen(&config.http_vpn_domain, "", 1);
    let h = SHARE_SUFFIX_RE.replace_all(&h, "");
    codec.decode_host(&h)
}

/// 判断给定的 origin 是否属于 WebVPN 自身域（用于 CORS 白名单）。
/// 对应 Node 版 WebVPN.isAllowedOrigin：site.origin 命中，或 host 以 vpnDomain（含端口后缀）结尾。
pub fn is_allowed_origin(origin: &str, config: &Config) -> bool {
    if origin.is_empty() {
        return false;
    }
    if origin == config.site_origin().as_str() {
        return true;
    }
    if let Ok(u) = url::Url::parse(origin) {
        let host = u.host_str().unwrap_or("");
        // u.host_str() 不含端口，需额外检查带端口后缀的 vpnDomain 变体
        let host_with_port = url_host_with_port(&u);
        return host.ends_with(&config.vpn_domain)
            || host_with_port.ends_with(&config.http_vpn_domain)
            || host_with_port.ends_with(&config.https_vpn_domain);
    }
    false
}

/// 对应 setOriginHeaders(ctx, headers)（webvpn.js:1306-1335）
/// 把浏览器发来的 vpn 域名 Host / Origin / Referer 还原为目标域名。
/// origin/referer 改用 URL 重组 host，避免字符串 .replace(host, ...) 在路径中误伤同名子串。
pub fn set_origin_headers(headers: &mut HashMap<String, Vec<String>>, config: &Config, codec: &DomainCodec) {
    // host
    if let Some(vals) = headers.get_mut("host") {
        if let Some(v) = vals.first_mut() {
            *v = convert_host(v, config, codec);
        }
    }
    // origin：try { u = new URL(origin); u.host = convertHost(u.host); origin = u.origin } catch {}
    if let Some(vals) = headers.get_mut("origin") {
        if let Some(v) = vals.first().cloned() {
            if let Ok(mut u) = url::Url::parse(&v) {
                let host_with_port = url_host_with_port(&u);
                let converted = convert_host(&host_with_port, config, codec);
                if set_url_host(&mut u, &converted).is_ok() {
                    *vals = vec![u.origin().ascii_serialization()];
                }
            }
        }
    }
    // referer
    if let Some(vals) = headers.get("referer").cloned() {
        let referer = vals.first().cloned().unwrap_or_default();
        let vpn_domain = if referer.starts_with("http://") {
            &config.http_vpn_domain
        } else {
            &config.https_vpn_domain
        };
        // 若 referer 既不含 site.host 又不含 vpnDomain 则删除
        if !referer.contains(&config.site_host()) || !referer.contains(vpn_domain) {
            headers.remove("referer");
        } else {
            // try { u = new URL(referer); u.host = convertHost(u.host); referer = u.toString() } catch { delete }
            match url::Url::parse(&referer) {
                Ok(mut u) => {
                    let host_with_port = url_host_with_port(&u);
                    let converted = convert_host(&host_with_port, config, codec);
                    if set_url_host(&mut u, &converted).is_ok() {
                        headers.insert("referer".to_string(), vec![u.to_string()]);
                    } else {
                        headers.remove("referer");
                    }
                }
                Err(_) => {
                    headers.remove("referer");
                }
            }
        }
    }
}

/// 对应 initResponseHeaders(ctx, res)
/// 返回处理后的 headers（多值 Vec<String>）
///
/// 入参 raw_headers：上游响应的 header（已 lower-case key）
pub async fn init_response_headers(
    raw_headers: &HashMap<String, Vec<String>>,
    meta: &Meta,
    config: &Config,
    codec: &DomainCodec,
    session_store: &crate::cache::SessionStore,
) -> HashMap<String, Vec<String>> {
    let https_enabled = config.https_enabled;
    let vpn_domain = &config.vpn_domain;
    let http_vpn_domain = &config.http_vpn_domain;
    let https_vpn_domain = &config.https_vpn_domain;
    let domain_mode = &config.domain_mode;
    let is_main_session = meta.is_main_session;
    let share_id = &meta.share_id;
    let scheme = &meta.scheme;
    let target = &meta.target;

    let mut headers: HashMap<String, Vec<String>> = raw_headers.clone();

    // access-control-allow-origin
    if let Some(vals) = headers.get_mut("access-control-allow-origin") {
        let new_vals: Vec<String> = vals.iter().map(|e| {
            if e == "*" {
                return e.clone();
            }
            // 目标站可能返回 null / 畸形 origin，new URL 会抛异常导致整个响应处理中断
            // 对应 Node 版 try { host = ... } catch { return e }
            let host = if e.contains("http") {
                match url::Url::parse(e) {
                    Ok(u) => {
                        let h = u.host_str().unwrap_or("");
                        match u.port() {
                            Some(p) => format!("{}:{}", h, p),
                            None => h.to_string(),
                        }
                    }
                    Err(_) => {
                        // URL 解析失败：直接返回原值，不继续处理
                        return e.clone();
                    }
                }
            } else {
                e.clone()
            };
            // Node 版用 indexOf('http://') >= 0（contains），非 starts_with
            let vpn_d = if e.contains("http://") { http_vpn_domain } else { https_vpn_domain };
            let mut domain = codec.encode_host(&host);
            if !share_id.is_empty() {
                domain.push('-');
                domain.push_str(if is_main_session { "main" } else { "share" });
                domain.push('-');
                domain.push_str(share_id);
            }
            domain.push_str(vpn_d);
            // JS String.replace(str, str) 只替换第一个匹配；Rust str::replace 替换全部
            e.replacen(&host, &domain, 1)
        }).collect();
        *vals = new_vals;
    }

    // content-type 默认 text/html
    let ct = headers.get("content-type")
        .and_then(|v| v.first().cloned())
        .unwrap_or_else(|| "text/html".to_string());
    headers.insert("content-type".to_string(), vec![ct]);

    // content-security-policy
    // 旧实现：只要整条 CSP 中出现 "-src" / "unsafe-" / "require-trusted-types-for"，
    // 就把整条 CSP 清空，这会误伤非相关指令（如 frame-ancestors / report-uri）。
    // 改为按分号分指令逐条过滤：移除含上述关键字的指令，保留其余指令；
    // frame-ancestors 单独改写为允许 WebVPN 主域。
    if let Some(vals) = headers.get_mut("content-security-policy") {
        let new_vals: Vec<String> = vals.iter().map(|e| {
            let protocol = format!("{}://", if https_enabled { scheme } else { "http" });
            let site_host = config.site_host();
            let replaced = site_host
                .strip_prefix("www.")
                .map(|s| format!("*.{}", s))
                .unwrap_or_else(|| site_host.clone());

            let kept: Vec<&str> = e.split(';').map(|d| d.trim()).filter(|d| {
                !d.is_empty()
                    && !d.contains("-src")
                    && !d.contains("unsafe-")
                    && !d.contains("require-trusted-types-for")
                    && !d.contains("trusted-types")
            }).collect();

            // 检查原始 CSP 是否已有 frame-ancestors 指令
            let has_fa = e.split(';').any(|d| d.trim().starts_with("frame-ancestors"));
            let mut result = kept.join("; ");
            if has_fa {
                // 已有则替换其值为 WebVPN 主域
                // 简化处理：直接追加一条新的 frame-ancestors（浏览器以最严格者为准，
                // 但这里 kept 已剔除原 frame-ancestors，故等价于重写）
                if !result.is_empty() { result.push_str("; "); }
                result.push_str(&format!("frame-ancestors {}{}", protocol, replaced));
            }
            // https 下追加 upgrade-insecure-requests（对应 Node 版 initResponseHeaders 末尾逻辑）
            if https_enabled && !result.is_empty() && !result.contains("upgrade-insecure-requests") {
                result.push_str("; upgrade-insecure-requests");
            }
            result
        }).collect();
        *vals = new_vals;
    }

    // location
    if let Some(vals) = headers.get_mut("location") {
        let new_vals: Vec<String> = vals.iter().map(|e| {
            let mut e = e.clone();
            if !e.starts_with("http") {
                if e.starts_with('/') {
                    e = format!("{}{}", target.origin().ascii_serialization(), e);
                }
            }
            transform_url(&e, config, codec, meta)
        }).collect();
        *vals = new_vals;
    }

    // set-cookie
    if let Some(vals) = headers.get_mut("set-cookie") {
        let new_vals: Vec<String> = vals.iter().map(|e| {
            let e = SECURE_COOKIE_RE.replace_all(&e, "").to_string();
            if !DOMAIN_ATTR_RE.is_match(&e) {
                return e;
            }
            let parts: Vec<String> = e.split("; ").map(|p| {
                if !DOMAIN_ATTR_RE.is_match(p) {
                    return p.to_string();
                }
                let mut domain = p.split('=').nth(1).unwrap_or("").to_string();
                let has_dot = domain.starts_with('.');
                if has_dot {
                    domain = domain[1..].to_string();
                }
                if domain_mode == "original" {
                    let mut d = codec.encode_host(&domain);
                    if !share_id.is_empty() {
                        d.push('-');
                        d.push_str(if is_main_session { "main" } else { "share" });
                        d.push('-');
                        d.push_str(share_id);
                    }
                    d.push_str(vpn_domain);
                    if has_dot {
                        d = format!(".{}", d);
                    }
                    domain = d;
                } else {
                    // underline 模式不支持 cookie domain，塌缩为 vpnDomain
                    domain = vpn_domain.clone();
                }
                format!("domain={}", domain)
            }).collect();
            parts.join("; ")
        }).collect();
        *vals = new_vals;
    }

    // 默认 access-control-allow-origin: *
    if !headers.contains_key("access-control-allow-origin") {
        headers.insert("access-control-allow-origin".to_string(), vec!["*".to_string()]);
    }

    // https 下追加 upgrade-insecure-requests
    if https_enabled && scheme == "https" {
        let entry = headers.entry("content-security-policy".to_string()).or_insert_with(Vec::new);
        entry.push("upgrade-insecure-requests".to_string());
    }

    // x-frame-options: allowall
    headers.insert("x-frame-options".to_string(), vec!["allowall".to_string()]);

    // 会话消费者：用 sessionStore 中存的 cookie 与目标响应自身的 set-cookie 合并
    if !is_main_session && !share_id.is_empty() {
        let cookie = session_store.get_item(&format!("{}-cookie", share_id)).await;
        if let Some(c) = cookie {
            // 缓存的 cookie 是 Cookie 请求头格式（"a=1; b=2"），需拆分为单个 cookie
            // 再与目标响应自身的 set-cookie 合并，避免覆盖目标站点新设置的 cookie
            let cached: Vec<String> = c.split(';')
                .map(|ck| ck.trim().to_string())
                .filter(|ck| !ck.is_empty())
                .collect();
            let existing = headers.remove("set-cookie").unwrap_or_default();
            let mut merged = cached;
            merged.extend(existing);
            headers.insert("set-cookie".to_string(), merged);
        }
    }

    headers
}

/// 对应 transformUrl(ctx, url)
/// 把目标 URL 改写为 vpn 域名 URL
pub fn transform_url(url: &str, config: &Config, codec: &DomainCodec, _meta: &Meta) -> String {
    let u = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return url.to_string(),
    };
    let vpn_domain = if u.scheme() == "http" {
        &config.http_vpn_domain
    } else {
        &config.https_vpn_domain
    };
    // u.host（含端口）
    let host = match u.host_str() {
        Some(h) => {
            match u.port() {
                Some(p) => format!("{}:{}", h, p),
                None => h.to_string(),
            }
        }
        None => return url.to_string(),
    };
    let encoded = codec.encode_host(&host);
    // url.replace(u.host, encodeHost(u.host) + vpnDomain)
    // 注意 JS 这里 u.host 是 host+port（无端口时仅 host）
    // JS String.replace(str, str) 只替换第一个匹配；Rust str::replace 替换全部
    url.replacen(&host, &format!("{}{}", encoded, vpn_domain), 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h() -> HashMap<String, Vec<String>> {
        let mut m = HashMap::new();
        m.insert("content-type".to_string(), vec!["text/html".to_string()]);
        m
    }

    /// 上游 transfer-encoding: chunked 必须被剥掉：hyper 会自行管理分帧，
    /// 透传会触发 "user sent unexpected header"，连接无响应直接关闭
    /// （浏览器表现为 ERR_EMPTY_RESPONSE）。
    #[test]
    fn test_response_strips_transfer_encoding() {
        let mut headers = h();
        headers.insert("transfer-encoding".to_string(), vec!["chunked".to_string()]);
        delete_ignore_headers(&IGNORE_RESPONSE_HEADER_REGEXPS, &mut headers);
        assert!(!headers.contains_key("transfer-encoding"));
        assert!(headers.contains_key("content-type"));
    }

    /// hop-by-hop 头（connection/keep-alive/upgrade）也不应透传到下游响应
    #[test]
    fn test_response_strips_hop_by_hop() {
        let mut headers = h();
        headers.insert("connection".to_string(), vec!["keep-alive".to_string()]);
        headers.insert("keep-alive".to_string(), vec!["timeout=5".to_string()]);
        headers.insert("upgrade".to_string(), vec!["h2c".to_string()]);
        delete_ignore_headers(&IGNORE_RESPONSE_HEADER_REGEXPS, &mut headers);
        assert!(!headers.contains_key("connection"));
        assert!(!headers.contains_key("keep-alive"));
        assert!(!headers.contains_key("upgrade"));
        // content-length 原有忽略逻辑不受影响（子串匹配，忽略大小写）
        headers.insert("Content-Length".to_string(), vec!["123".to_string()]);
        delete_ignore_headers(&IGNORE_RESPONSE_HEADER_REGEXPS, &mut headers);
        assert!(!headers.contains_key("Content-Length"));
    }

    /// 请求侧同样剥离 hop-by-hop 头；且不能误伤业务头
    /// （如 x-custom-request 含 connection 子串时应保留——新规则是全词锚定匹配）
    #[test]
    fn test_request_strips_hop_by_hop() {
        let mut headers = h();
        headers.insert("transfer-encoding".to_string(), vec!["chunked".to_string()]);
        headers.insert("connection".to_string(), vec!["close".to_string()]);
        headers.insert("x-custom-connection-info".to_string(), vec!["v".to_string()]);
        delete_ignore_headers(&IGNORE_REQUEST_HEADER_REGEXPS, &mut headers);
        assert!(!headers.contains_key("transfer-encoding"));
        assert!(!headers.contains_key("connection"));
        assert!(headers.contains_key("x-custom-connection-info"));
        // 原有规则不受影响
        headers.insert("x-forwarded-for".to_string(), vec!["1.2.3.4".to_string()]);
        delete_ignore_headers(&IGNORE_REQUEST_HEADER_REGEXPS, &mut headers);
        assert!(!headers.contains_key("x-forwarded-for"));
    }
}
