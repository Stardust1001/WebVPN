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
    ]
});

/// set-cookie 处理用：匹配 domain= 属性
static DOMAIN_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)domain=").unwrap());

/// 把 header map 里的多值用 ', ' join 成单字符串（用于透传给目标服务器）
#[allow(dead_code)]
pub fn header_map_to_single(map: &HashMap<String, Vec<String>>) -> HashMap<String, String> {
    map.iter().map(|(k, v)| (k.clone(), v.join(", "))).collect()
}

/// 删除被忽略的 header（请求头或响应头版本，按正则匹配 key）
pub fn delete_ignore_headers(regexps: &[Regex], headers: &mut HashMap<String, Vec<String>>) {
    let keys: Vec<String> = headers.keys().cloned().collect();
    for key in keys {
        if regexps.iter().any(|re| re.is_match(&key)) {
            headers.remove(&key);
        }
    }
}

/// 对应 convertHost(host)
/// host = host.split('-')[0].replace(httpsVpnDomain, '').replace(httpVpnDomain, '')
/// return decodeHost(host)
pub fn convert_host(host: &str, config: &Config, codec: &DomainCodec) -> String {
    let mut h = host.split('-').next().unwrap_or("").to_string();
    h = h.replace(&config.https_vpn_domain, "").replace(&config.http_vpn_domain, "");
    codec.decode_host(&h)
}

/// 对应 setOriginHeaders(ctx, headers)
/// 把浏览器发来的 vpn 域名 Host / Origin / Referer 还原为目标域名
pub fn set_origin_headers(headers: &mut HashMap<String, Vec<String>>, config: &Config, codec: &DomainCodec) {
    // host
    if let Some(vals) = headers.get_mut("host") {
        if let Some(v) = vals.first_mut() {
            *v = convert_host(v, config, codec);
        }
    }
    // origin
    if let Some(vals) = headers.get_mut("origin") {
        if let Some(v) = vals.first().cloned() {
            if let Ok(u) = url::Url::parse(&v) {
                if let Some(host) = u.host_str() {
                    let host_with_port = match u.port() {
                        Some(p) => format!("{}:{}", host, p),
                        None => host.to_string(),
                    };
                    let converted = convert_host(&host_with_port, config, codec);
                    let new_origin = v.replace(&host_with_port, &converted);
                    *vals = vec![new_origin];
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
        } else if let Ok(u) = url::Url::parse(&referer) {
            if let Some(host) = u.host_str() {
                let host_with_port = match u.port() {
                    Some(p) => format!("{}:{}", host, p),
                    None => host.to_string(),
                };
                let converted = convert_host(&host_with_port, config, codec);
                let new_referer = referer.replace(&host_with_port, &converted);
                headers.insert("referer".to_string(), vec![new_referer]);
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
    global_cache: &crate::cache::GlobalCache,
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
            // host = e.indexOf('http') >= 0 ? new URL(e).host : e
            let host = if e.contains("http") {
                url::Url::parse(e).ok()
                    .and_then(|u| {
                        let host = u.host_str().unwrap_or("");
                        Some(match u.port() {
                            Some(p) => format!("{}:{}", host, p),
                            None => host.to_string(),
                        })
                    })
                    .unwrap_or_else(|| e.clone())
            } else {
                e.clone()
            };
            let vpn_d = if e.starts_with("http://") { http_vpn_domain } else { https_vpn_domain };
            let mut domain = codec.encode_host(&host);
            if !share_id.is_empty() {
                domain.push('-');
                domain.push_str(if is_main_session { "main" } else { "share" });
                domain.push('-');
                domain.push_str(share_id);
            }
            domain.push_str(vpn_d);
            e.replace(&host, &domain)
        }).collect();
        *vals = new_vals;
    }

    // content-type 默认 text/html
    let ct = headers.get("content-type")
        .and_then(|v| v.first().cloned())
        .unwrap_or_else(|| "text/html".to_string());
    headers.insert("content-type".to_string(), vec![ct]);

    // content-security-policy
    if let Some(vals) = headers.get_mut("content-security-policy") {
        let new_vals: Vec<String> = vals.iter().map(|e| {
            if e.contains("-src") || e.contains("unsafe-") || e.contains("require-trusted-types-for") {
                return String::new();
            }
            if !e.contains("frame-ancestors") || e == "frame-ancestors 'none';" {
                return e.clone();
            }
            let protocol = format!("{}://", if https_enabled { scheme } else { "http" });
            // site.host.replace('www', '*')
            let site_host = config.site_host();
            let replaced = site_host.replacen("www", "*", 1);
            e.replace("frame-ancestors", &format!("frame-ancestors {}{}", protocol, replaced))
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
            let e = e.replace(" Secure;", "");
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

    // 会话消费者：用 globalCache 中存的 cookie 覆盖 set-cookie
    if !is_main_session && !share_id.is_empty() {
        let cookie = global_cache.get_item(&format!("{}-cookie", share_id)).await;
        if let Some(c) = cookie {
            headers.insert("set-cookie".to_string(), vec![c]);
        }
    }

    let _ = http_vpn_domain;
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
    url.replace(&host, &format!("{}{}", encoded, vpn_domain))
}
