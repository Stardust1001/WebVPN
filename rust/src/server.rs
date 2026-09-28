// HTTP/HTTPS 服务器 + 请求生命周期：对应 proxyRoute / routeInit / serveWww / request / fetchRequest / respondPipe / createApp

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use regex::Regex;
use tungstenite::Message;
use http::header::HeaderName;
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use url::Url;

/// 预编译热路径正则
/// HTML 检测：响应首字符为 [ 或 { 时判断是否 JSON
static HTML_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[a-zA-Z]+").unwrap());
/// JSONP 检测：callback({... 或 callback([...)
/// (?-u) 使 \w 仅 ASCII [A-Za-z0-9_]，与 JS reJsonp=/^[\w\$_]+\(/ 的默认行为一致；
/// 否则 Rust 的 Unicode \w 会匹配 CJK 等回调名，导致 JSONP 误判
static JSONP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?-u)^[\w\$_]+\([\{\[]").unwrap());
/// 会话共享后缀正则：-(main|share)-<shareId>，shareId 不含点号
/// 兼容 original（subdomain 含点号）和 underline 两种模式
static SHARE_SESSION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"-(main|share)-([^.]+)$").unwrap());

use crate::cache::SessionStore;
use crate::charset::convert_charset_data;
use crate::config::Config;
use crate::context::Meta;
use crate::domain::DomainCodec;
use crate::files::{DiskCache, PublicFiles};
use crate::headers::{
    convert_host, delete_ignore_headers, init_response_headers,
    set_origin_headers, IGNORE_REQUEST_HEADER_REGEXPS,
    IGNORE_RESPONSE_HEADER_REGEXPS,
};
use crate::mime::{
    get_content_type_by_ext, get_mime_by_response_headers, get_response_type,
    CACHE_MIMES, NO_TRANSFORM_MIMES,
};
use crate::rewrite::{
    append_script, custom_response, get_base, process_html, process_html_scope_codes,
    process_js_scope_code, process_others, replace_urls,
};

/// WebSocket 客户端连接目标 wss 站点时使用的「不校验证书」验证器。
///
/// 对应 Node 版 WebSocket 客户端（ws 库）默认 `rejectUnauthorized` 配合
/// `NODE_TLS_REJECT_UNAUTHORIZED=0` 的行为，即对自签 / 证书不匹配的目标站点放行。
/// 与 reqwest 的 `danger_accept_invalid_certs(true)` 保持一致（见 AGENTS.md §14.10）。
///
/// 仅用于 ws_bridge 的 wss 连接路径，不影响 HTTPS 反向代理主链路。
#[derive(Debug)]
struct NoVerifyCert;

impl rustls::client::danger::ServerCertVerifier for NoVerifyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        // 返回 rustls 默认支持的算法集，避免握手时算法协商失败
        rustls::crypto::CryptoProvider::get_default()
            .map(|p| p.signature_verification_algorithms.supported_schemes().to_vec())
            .unwrap_or_default()
    }
}

/// 上游请求错误：区分超时（504）与其他错误（502）
/// 对应 Node 版 request() 中 AbortError -> 504 / 其他 -> 502 的逻辑
pub enum UpstreamError {
    Timeout,
    BadGateway(String),
}

impl fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpstreamError::Timeout => write!(f, "gateway timeout"),
            UpstreamError::BadGateway(msg) => write!(f, "{}", msg),
        }
    }
}

/// reqwest 启用 gzip/deflate/br 特性后会自动解压这三种编码（与 node-fetch 一致），
/// 必须删除对应的 content-encoding 头，否则浏览器会对已解压的 body 再次解压。
/// zstd reqwest 不会自动解压，保留 content-encoding 让浏览器自行处理。
/// 对应 Node 版 fetchRequest 中 `if (['gzip','deflate','br'].includes(encoding)) delete headers['content-encoding']`
fn should_remove_content_encoding(encoding: &str) -> bool {
    let enc = encoding.to_lowercase();
    enc.contains("gzip") || enc.contains("deflate") || enc.contains("br")
}

/// 共享状态（对应 WebVPN 实例的字段）
pub struct AppState {
    pub config: Config,
    pub codec: DomainCodec,
    pub convert_domains_code: String,
    pub js_intercept_code: String, // public/intercept.js 全文
    pub session_store: SessionStore,
    pub public_files: PublicFiles,
    pub disk_cache: DiskCache,
    pub http_client: reqwest::Client, // 复用连接池（对应 Node 版的 httpsAgent）
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let codec = DomainCodec::new(&config.domain_mode, &config.subdomains);
        let convert_domains_code = codec.convert_domains_code(&config.http_vpn_domain, &config.https_vpn_domain);
        let js_intercept_code = std::fs::read_to_string(format!("{}/intercept.js", config.public_dir.trim_end_matches('/'))).unwrap_or_default();
        let session_store = SessionStore::new(&config.sessions_dir);
        let public_files = PublicFiles::new(&config.public_dir);
        let disk_cache = DiskCache::new(&config);
        // 复用单一 Client：禁用自动重定向（手动处理 3xx）、接受无效证书（对应 NODE_TLS_REJECT_UNAUTHORIZED=0）
        // timeout：对应 Node 版 AbortController（requestTimeout || 60000），超时返回 504
        // gzip/deflate/brotli：reqwest 0.12 中 Cargo.toml feature 仅使方法可用，必须在 builder 上
        // 显式开启才会自动解压。对应 Node 版 node-fetch 对这三种编码的自动解压行为。
        let http_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(60))
            .gzip(true)
            .deflate(true)
            .brotli(true)
            .build()
            .expect("failed to build reqwest client");
        Self { config, codec, convert_domains_code, js_intercept_code, session_store, public_files, disk_cache, http_client }
    }
}

/// 主路由的输出：最终的 status / headers / body
pub struct ProxyOutput {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

/// 主路由：对应 proxyRoute(ctx, next)
/// 返回 Ok(Some) 表示已产生响应；返回 Ok(None) 表示交给 WebSocket 处理（已持有 stream）
pub async fn proxy_route(
    state: &Arc<AppState>,
    method: &Method,
    uri: &str,
    full_url: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Option<ProxyOutput>, String> {
    // 2. 解析 scheme、从 Host 剥离 vpnDomain 得到 subdomain
    let scheme = Url::parse(full_url)
        .ok()
        .map(|u| u.scheme().to_string())
        .unwrap_or_else(|| "http".to_string());
    let vpn_domain = if scheme == "http" {
        state.config.http_vpn_domain.clone()
    } else {
        state.config.https_vpn_domain.clone()
    };

    let host_header = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    // Node 版：host.endsWith(vpnDomain) ? host.slice(0, -vpnDomain.length) : host
    // 仅在 host 以 vpnDomain 结尾时截掉后缀；否则保留原样。
    // 此前用 host.replace(&vpn_domain, "") 会误删 host 中间出现的 vpnDomain 子串。
    let subdomain = if host_header.ends_with(&vpn_domain) {
        &host_header[..host_header.len() - vpn_domain.len()]
    } else {
        host_header
    };

    // 3. subdomain === 'www' -> serveWww
    if subdomain == "www" {
        return serve_www(state, method, uri, headers, body).await.map(Some);
    }

    // 4. subdomain 以 vpnDomain 开头（非法/根域误访问）-> 302 回首页
    // subdomain.split('-')[0] === vpnDomain.slice(1)
    // vpnDomain.slice(1) 去掉开头的 '.'（vpnDomain 形如 .webvpn.info，总以 . 开头）
    let slice1 = if vpn_domain.len() > 1 { &vpn_domain[1..] } else { vpn_domain.as_str() };
    if subdomain.split('-').next().unwrap_or("") == slice1 {
        let location = format!("{}://{}", scheme, state.config.site_host());
        let mut hm = HeaderMap::new();
        hm.insert("location", HeaderValue::from_str(&location).unwrap());
        return Ok(Some(ProxyOutput { status: StatusCode::FOUND, headers: hm, body: vec![] }));
    }

    // 5. checkPublic（/public/ 路径优先放行）
    if let Some(filepath) = state.public_files.check(uri).await {
        let data = tokio::fs::read(&filepath).await.map_err(|e| e.to_string())?;
        let mut hm = HeaderMap::new();
        let ct = get_content_type_by_ext(filepath.to_str().unwrap_or(""));
        hm.insert("content-type", HeaderValue::from_static(ct));
        return Ok(Some(ProxyOutput { status: StatusCode::OK, headers: hm, body: data }));
    }

    // 6. routeInit
    let mut meta = route_init(state, subdomain, &scheme, uri, headers, method).await?;

    // 7. 缓存命中？
    if state.config.cache && meta.cache != Some(false) {
        if let Some(path) = state.disk_cache.get(&meta).await {
            let data = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
            let mut hm = HeaderMap::new();
            let ct = get_content_type_by_ext(path.to_str().unwrap_or(""));
            hm.insert("content-type", HeaderValue::from_static(ct));
            return Ok(Some(ProxyOutput { status: StatusCode::OK, headers: hm, body: data }));
        }
    }

    // 8. noTransform mimes -> respondPipe 流式透传
    if NO_TRANSFORM_MIMES.contains(&meta.mime.as_str()) {
        return match respond_pipe(state, method, &meta, headers, body).await {
            Ok(output) => Ok(Some(output)),
            Err(UpstreamError::Timeout) => {
                log::error!("pipe timeout: {}", meta.url);
                Ok(Some(ProxyOutput {
                    status: StatusCode::GATEWAY_TIMEOUT,
                    headers: HeaderMap::new(),
                    body: b"Gateway Timeout".to_vec(),
                }))
            }
            Err(UpstreamError::BadGateway(e)) => {
                log::error!("pipe failed: {} \n{}", meta.url, e);
                Ok(Some(ProxyOutput {
                    status: StatusCode::BAD_GATEWAY,
                    headers: HeaderMap::new(),
                    body: e.into_bytes(),
                }))
            }
        };
    }

    // 9. request()：发上游请求
    let res = match upstream_request(state, method, &meta, headers, body).await {
        Ok(r) => r,
        Err(UpstreamError::Timeout) => {
            log::error!("request timeout: {}", meta.url);
            return Ok(Some(ProxyOutput {
                status: StatusCode::GATEWAY_TIMEOUT,
                headers: HeaderMap::new(),
                body: b"Gateway Timeout".to_vec(),
            }));
        }
        Err(UpstreamError::BadGateway(e)) => {
            log::error!("request failed: {} \n{}", meta.url, e);
            return Ok(Some(ProxyOutput {
                status: StatusCode::BAD_GATEWAY,
                headers: HeaderMap::new(),
                body: e.into_bytes(),
            }));
        }
    };

    // 写响应头
    let out_headers = headermap_from(&res.headers);

    // 上游已判定 mime（noTransform / JSONP / JSON）
    if let Some(m) = &res.mime {
        meta.mime = m.clone();
    }

    // 3xx 直接返回
    if res.status.as_u16() >= 300 && res.status.as_u16() < 400 {
        return Ok(Some(ProxyOutput { status: res.status, headers: out_headers, body: res.data.unwrap_or_default() }));
    }

    // 上游已标记 is_done（JSONP/JSON/noTransform）-> 跳过后续改写
    if res.is_done {
        meta.is_done = true;
    }

    // html mime 检测：首尾字符判断 JSON/文本
    let mut data = res.data.unwrap_or_default();
    if meta.mime == "html" && !data.is_empty() && !meta.is_done {
        let first = data[0];
        let last = data[data.len() - 1];
        let data_str = String::from_utf8_lossy(&data);
        if (first == b'[' && last == b']') || (first == b'{' && last == b'}') {
            meta.mime = "json".to_string();
            meta.is_done = true;
            data = data_str.into_owned().into_bytes();
        } else if !HTML_TAG_RE.is_match(&data_str) {
            meta.mime = "text".to_string();
            meta.is_done = true;
            data = data_str.into_owned().into_bytes();
        }
    }

    // 11. afterRequest 钩子（这里简化，不做短路）
    // 12. shouldReplaceUrls + customResponse
    if !meta.is_done && !data.is_empty() {
        let data_str = String::from_utf8_lossy(&data).to_string();
        let mut new_data = replace_urls(&data_str, &meta.mime, &state.config, &meta, &state.codec);
        new_data = custom_response(&new_data, &meta.mime, state.config.rewrite_this);

        if meta.mime == "html" {
            new_data = process_html(&new_data);
            new_data = process_html_scope_codes(&new_data, &state.config, &meta, &state.convert_domains_code);
            if !meta.is_xhr {
                // base 仅 appendScript 用到，且需基于改写前的原始 HTML 提取 <base href>
                meta.base = get_base(&data_str, &meta);
                new_data = append_script(&new_data, &state.config, &meta, &state.codec, &state.convert_domains_code, &state.js_intercept_code, &state.session_store).await;
            }
        } else if meta.mime == "js" {
            let (rewritten, new_mime) = process_js_scope_code(&new_data, &state.config, &meta, &state.convert_domains_code);
            new_data = rewritten;
            meta.mime = new_mime;
        }
        data = new_data.into_bytes();
    }

    // 13. processOthers
    if !meta.is_done {
        let data_str = String::from_utf8_lossy(&data).to_string();
        let new_data = process_others(&data_str, &meta.mime, state.config.disable_source_map);
        data = new_data.into_bytes();
    }

    // 14. setCache
    state.disk_cache.set(&meta, &data, CACHE_MIMES).await;

    Ok(Some(ProxyOutput { status: res.status, headers: out_headers, body: data }))
}

/// 对应 routeInit(ctx)
async fn route_init(
    state: &Arc<AppState>,
    subdomain_in: &str,
    scheme: &str,
    uri: &str,
    headers: &HeaderMap,
    method: &Method,
) -> Result<Meta, String> {
    let mut subdomain = subdomain_in.to_string();
    let (is_main_session, share_id) = check_share_session(state, &mut subdomain, headers).await;
    let domain = state.codec.decode_host(&subdomain);
    let url = format!("{}://{}{}", scheme, domain, uri);
    let is_xhr = headers.get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "XMLHttpRequest")
        .unwrap_or(false);
    let mime = get_response_type(method.as_str(), &url);
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let origin = headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let referer = headers.get("referer").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();

    Ok(Meta {
        share_id,
        is_main_session,
        url,
        is_xhr,
        mime,
        scheme: scheme.to_string(),
        target,
        host,
        origin,
        referer,
        is_done: false,
        cache: None,
        base: String::new(),
        custom_code: String::new(),
    })
}

/// 对应 checkShareSession(ctx)（webvpn.js:645-681）
/// 使用正则匹配会话后缀 -(main|share)-<shareId>，兼容 original 和 underline 两种模式。
/// original 模式下 subdomain 含点号（如 www.example.com-main-shareId），
/// 此前用 !includes('.') 判断会跳过 original 模式的会话共享。
async fn check_share_session(
    state: &Arc<AppState>,
    subdomain: &mut String,
    headers: &HeaderMap,
) -> (bool, String) {
    let mut is_main_session = false;
    let mut share_id = String::new();

    if let Some(caps) = SHARE_SESSION_RE.captures(subdomain.as_str()) {
        let match_start = caps.get(0).unwrap().start();
        let session_type = caps.get(1).unwrap().as_str().to_string();
        let s_id = caps.get(2).unwrap().as_str().to_string();
        *subdomain = subdomain[..match_start].to_string();
        is_main_session = session_type == "main";
        share_id = s_id;

        if is_main_session {
            if let Some(cookie) = headers.get("cookie").and_then(|v| v.to_str().ok()) {
                state.session_store.set_item(&format!("{}-cookie", share_id), cookie.to_string()).await;
            }
            if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
                state.session_store.set_item(&format!("{}-authorization", share_id), auth.to_string()).await;
            }
        }
        // share 会话消费者的 cookie 覆盖在 upstream_request 里做（需要改请求头）
    }

    (is_main_session, share_id)
}

/// 对应 serveWww(ctx)
async fn serve_www(
    state: &Arc<AppState>,
    method: &Method,
    uri: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<ProxyOutput, String> {
    if uri == "/" {
        let text = tokio::fs::read_to_string(format!("{}/index.html", state.config.public_dir.trim_end_matches('/'))).await.map_err(|e| e.to_string())?;
        // 注入 config + convertDomainsCode
        let config_json = serde_json::to_string_pretty(&state.config).unwrap_or_else(|_| "{}".to_string());
        let inject = format!("const config = {}\n{}", config_json, state.convert_domains_code);
        let text = text.replace("'inject_code'", &inject);
        let mut hm = HeaderMap::new();
        hm.insert("content-type", HeaderValue::from_static("text/html; charset=utf-8"));
        return Ok(ProxyOutput { status: StatusCode::OK, headers: hm, body: text.into_bytes() });
    }
    if uri.starts_with("/share-sessions") {
        if method == Method::POST {
            let share_id = Url::parse(&format!("http://x{}", uri))
                .ok()
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "shareId").map(|(_, v)| v.to_string()))
                .unwrap_or_default();
            let body_str = String::from_utf8_lossy(&body).to_string();
            state.session_store.set_item(&format!("{}-clientCache", share_id), body_str).await;
        }
        let mut hm = HeaderMap::new();
        let origin = headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("*");
        hm.insert("access-control-allow-credentials", HeaderValue::from_static("true"));
        hm.insert("access-control-allow-origin", HeaderValue::from_str(origin).unwrap_or(HeaderValue::from_static("*")));
        hm.insert("access-control-allow-headers", HeaderValue::from_static("*"));
        hm.insert("access-control-allow-methods", HeaderValue::from_static("*"));
        return Ok(ProxyOutput { status: StatusCode::OK, headers: hm, body: vec![] });
    }
    // 其他 /public/xx
    if let Some(filepath) = state.public_files.check(uri).await {
        let data = tokio::fs::read(&filepath).await.map_err(|e| e.to_string())?;
        let mut hm = HeaderMap::new();
        let ct = get_content_type_by_ext(filepath.to_str().unwrap_or(""));
        hm.insert("content-type", HeaderValue::from_static(ct));
        return Ok(ProxyOutput { status: StatusCode::OK, headers: hm, body: data });
    }
    Ok(ProxyOutput { status: StatusCode::NOT_FOUND, headers: HeaderMap::new(), body: vec![] })
}

/// 上游响应
pub struct UpstreamResponse {
    pub status: StatusCode,
    pub headers: HashMap<String, Vec<String>>,
    pub data: Option<Vec<u8>>,
    pub is_done: bool,   // JSONP/JSON 响应时为 true，跳过后续改写
    pub mime: Option<String>, // 上游检测出的 mime（用于覆盖 meta.mime）
}

/// 对应 request(ctx) + fetchRequest(ctx, options)
async fn upstream_request(
    state: &Arc<AppState>,
    method: &Method,
    meta: &Meta,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<UpstreamResponse, UpstreamError> {
    let mut req_headers = headermap_to_hashmap(headers);

    // deleteIgnoreHeaders + strip share suffix + setOriginHeaders
    delete_ignore_headers(&IGNORE_REQUEST_HEADER_REGEXPS, &mut req_headers);
    strip_share_suffix(state, &mut req_headers, meta);
    set_origin_headers(&mut req_headers, &state.config, &state.codec);

    // 会话消费者：覆盖 cookie/authorization
    if !meta.is_main_session && !meta.share_id.is_empty() {
        if let Some(cookie) = state.session_store.get_item(&format!("{}-cookie", meta.share_id)).await {
            req_headers.insert("cookie".to_string(), vec![cookie]);
        }
        if let Some(auth) = state.session_store.get_item(&format!("{}-authorization", meta.share_id)).await {
            req_headers.insert("authorization".to_string(), vec![auth]);
        }
    }

    let client = &state.http_client;

    let mut builder = client.request(method.clone(), &meta.url);
    for (k, vals) in &req_headers {
        if let Ok(name) = HeaderName::from_bytes(k.as_bytes()) {
            for v in vals {
                builder = builder.header(name.clone(), v);
            }
        }
    }
    if method == Method::POST || method == Method::PUT || method == Method::PATCH {
        builder = builder.body(body);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                return Err(UpstreamError::Timeout);
            }
            return Err(UpstreamError::BadGateway(e.to_string()));
        }
    };
    let status = resp.status();

    let raw_headers = headermap_to_hashmap(resp.headers());

    let content_type = raw_headers.get("content-type")
        .and_then(|v| v.first().cloned())
        .unwrap_or_default();
    let content_encoding = raw_headers.get("content-encoding")
        .and_then(|v| v.first().cloned())
        .unwrap_or_default();

    let mut headers = init_response_headers(&raw_headers, meta, &state.config, &state.codec, &state.session_store).await;
    delete_ignore_headers(&IGNORE_RESPONSE_HEADER_REGEXPS, &mut headers);

    // 钩子：initResponseHeaders（对应 main.js 中 .wasm 的 content-type 覆盖）
    if meta.url.ends_with(".wasm") {
        headers.insert("content-type".to_string(), vec!["application/wasm".to_string()]);
    }

    // location 头 -> 直接返回（3xx）
    if headers.contains_key("location") {
        return Ok(UpstreamResponse { status, headers, data: None, is_done: false, mime: None });
    }

    // mime 校正
    let new_mime = get_mime_by_response_headers(&content_type);
    let mime = new_mime.unwrap_or_else(|| meta.mime.clone());

    if NO_TRANSFORM_MIMES.contains(&mime.as_str()) {
        // reqwest 启用 gzip/deflate/br 特性后已自动解压这三种编码，必须删除 content-encoding
        // 否则浏览器会对已解压的 body 再次解压。zstd 不自动解压，保留让浏览器处理。
        // 对应 Node 版 fetchRequest:853-856
        if should_remove_content_encoding(&content_encoding) {
            headers.remove("content-encoding");
        }
        if mime == "json" {
            let text = resp.text().await.unwrap_or_default();
            let data = if text.is_empty() { "{}".to_string() } else { text };
            return Ok(UpstreamResponse { status, headers, data: Some(data.into_bytes()), is_done: true, mime: Some("json".to_string()) });
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                if e.is_timeout() {
                    return Err(UpstreamError::Timeout);
                }
                return Err(UpstreamError::BadGateway(e.to_string()));
            }
        };
        return Ok(UpstreamResponse { status, headers, data: Some(bytes.to_vec()), is_done: true, mime: Some(mime.clone()) });
    }

    // 非 noTransform 路径：content-encoding 一律删除
    // reqwest 已自动解压 gzip/deflate/br；zstd 由 convert_charset_data 解压
    headers.remove("content-encoding");

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            if e.is_timeout() {
                return Err(UpstreamError::Timeout);
            }
            return Err(UpstreamError::BadGateway(e.to_string()));
        }
    };
    let (text, new_ct) = convert_charset_data(&bytes, Some(&content_encoding), &content_type, &mime);
    if new_ct != content_type {
        headers.insert("content-type".to_string(), vec![new_ct]);
    }

    // isJsonpResponse / isJsonResponse（html mime 时）
    // Node 版正则：/^[\w\$_]+\((\{|\[)/  要求 ( 后紧跟 { 或 [
    if mime == "html" {
        if JSONP_RE.is_match(&text) {
            return Ok(UpstreamResponse { status, headers, data: Some(text.into_bytes()), is_done: true, mime: None });
        }
        if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
            return Ok(UpstreamResponse { status, headers, data: Some(text.into_bytes()), is_done: true, mime: Some("json".to_string()) });
        }
    }

    Ok(UpstreamResponse { status, headers, data: Some(text.into_bytes()), is_done: false, mime: None })
}

/// 剥离 origin/referer/host 中的 share session 后缀
/// 对应 checkShareSession 中第一段循环（webvpn.js:657-661）
fn strip_share_suffix(_state: &Arc<AppState>, headers: &mut HashMap<String, Vec<String>>, meta: &Meta) {
    if !meta.share_id.is_empty() {
        let share_suffix = format!("-{}-{}", if meta.is_main_session { "main" } else { "share" }, meta.share_id);
        for key in &["host", "origin", "referer"] {
            if let Some(vals) = headers.get_mut(*key) {
                for v in vals.iter_mut() {
                    // JS 用 .replace(shareSuffix, '')（首匹配），Rust str::replace 替换全部。
                    // 用 replacen 保持一致，避免路径中恰好含同字符串时误删。
                    *v = v.replacen(&share_suffix, "", 1);
                }
            }
        }
    }
    // 此前此处还有第二段循环：用 new URL(origin).host.split('.')[0] 再次解析会话后缀并删除。
    // 但上面第一段已用 shareSuffix 精确清理 origin/referer，第二段在 original 模式下
    // （编码 host 是多段子域名）会把目标域名第一段当 subdomain，split('-') 后误删，
    // 反而破坏已被清理干净的 header。整段删除。
}

/// 对应 respondPipe(ctx)：流式管道透传（noTransform mimes）
async fn respond_pipe(
    state: &Arc<AppState>,
    method: &Method,
    meta: &Meta,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<ProxyOutput, UpstreamError> {
    let mut req_headers = headermap_to_hashmap(headers);
    // 与 upstream_request 保持一致的顺序：deleteIgnoreHeaders + strip share suffix + setOriginHeaders
    delete_ignore_headers(&IGNORE_REQUEST_HEADER_REGEXPS, &mut req_headers);
    strip_share_suffix(state, &mut req_headers, meta);
    set_origin_headers(&mut req_headers, &state.config, &state.codec);

    if !meta.is_main_session && !meta.share_id.is_empty() {
        if let Some(cookie) = state.session_store.get_item(&format!("{}-cookie", meta.share_id)).await {
            req_headers.insert("cookie".to_string(), vec![cookie]);
        }
        if let Some(auth) = state.session_store.get_item(&format!("{}-authorization", meta.share_id)).await {
            req_headers.insert("authorization".to_string(), vec![auth]);
        }
    }

    let client = &state.http_client;

    let mut builder = client.request(method.clone(), &meta.url);
    for (k, vals) in &req_headers {
        if let Ok(name) = HeaderName::from_bytes(k.as_bytes()) {
            for v in vals {
                builder = builder.header(name.clone(), v);
            }
        }
    }
    if method == Method::POST || method == Method::PUT || method == Method::PATCH {
        builder = builder.body(body);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                return Err(UpstreamError::Timeout);
            }
            return Err(UpstreamError::BadGateway(e.to_string()));
        }
    };
    let status = resp.status();

    let raw_headers = headermap_to_hashmap(resp.headers());
    let content_encoding = raw_headers.get("content-encoding")
        .and_then(|v| v.first().cloned())
        .unwrap_or_default();

    let mut headers = init_response_headers(&raw_headers, meta, &state.config, &state.codec, &state.session_store).await;
    delete_ignore_headers(&IGNORE_RESPONSE_HEADER_REGEXPS, &mut headers);

    // 钩子：initResponseHeaders（对应 main.js 中 .wasm 的 content-type 覆盖）
    if meta.url.ends_with(".wasm") {
        headers.insert("content-type".to_string(), vec!["application/wasm".to_string()]);
    }

    // reqwest 已自动解压 gzip/deflate/br，必须删除 content-encoding
    // zstd 保留让浏览器处理（对应 Node 版 fetchRequest:853-856）
    if should_remove_content_encoding(&content_encoding) {
        headers.remove("content-encoding");
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            if e.is_timeout() {
                return Err(UpstreamError::Timeout);
            }
            return Err(UpstreamError::BadGateway(e.to_string()));
        }
    };
    let out_headers = headermap_from(&headers);
    Ok(ProxyOutput { status, headers: out_headers, body: bytes.to_vec() })
}

/// WebSocket 桥接：连接目标 ws 并双向桥接
/// 对应 wsServer.onConnection
///
/// `is_tls`：底层连接是否加密（对应 Node 版 request.socket.encrypted）。
/// 仅在 origin 缺失（非浏览器客户端）时作为回退判断依据。
pub async fn ws_bridge(
    state: &Arc<AppState>,
    host: &str,
    origin: &str,
    uri: &str,
    is_tls: bool,
    client_ws: axum::extract::ws::WebSocket,
) -> Result<(), String> {
    let host = convert_host(host, &state.config, &state.codec);
    // origin 缺失时（非浏览器客户端）按 socket 是否加密判断，而非强制 https
    let use_wss = if !origin.is_empty() {
        origin.starts_with("https")
    } else {
        is_tls
    };
    let protocol = if use_wss { "wss" } else { "ws" };
    let ws_url = format!("{}://{}{}", protocol, host, uri);

    // 对应 Node 版 WebSocket 客户端（ws 库）默认 rejectUnauthorized 与 NODE_TLS_REJECT_UNAUTHORIZED=0 配合
    // 即对自签/证书不匹配的目标 wss 站点放行，与 reqwest 的 danger_accept_invalid_certs(true) 保持一致。
    // tokio-tungstenite 默认用 webpki-roots 严格校验，需手动构造 rustls ClientConfig 关闭校验。
    let connector = if use_wss {
        let roots = rustls::RootCertStore::empty();
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        // dangerous() + dangerous_accept_invalid_certs(true) 关闭证书校验
        let mut config = config;
        config.dangerous().set_certificate_verifier(std::sync::Arc::new(NoVerifyCert));
        Some(tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config)))
    } else {
        None
    };

    let (target_ws, _response) = tokio_tungstenite::connect_async_tls_with_config(
        &ws_url, None, false, connector,
    )
        .await
        .map_err(|e| format!("ws connect failed: {}", e))?;

    let (mut target_tx, mut target_rx) = target_ws.split();
    let (mut client_tx, mut client_rx) = client_ws.split();

    // client -> target
    let c2t = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            let m = match msg {
                axum::extract::ws::Message::Text(t) => Message::Text(t.as_str().into()),
                axum::extract::ws::Message::Binary(b) => Message::Binary(b),
                axum::extract::ws::Message::Close(_) => break,
                _ => continue,
            };
            if target_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = target_tx.close().await;
    };

    // target -> client
    let t2c = async {
        while let Some(Ok(msg)) = target_rx.next().await {
            let m = match msg {
                Message::Text(t) => axum::extract::ws::Message::Text(t.as_str().into()),
                Message::Binary(b) => axum::extract::ws::Message::Binary(b),
                Message::Close(_) => break,
                _ => continue,
            };
            if client_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };

    // 对应 Node 版 ws 双向 on('message')/on('close')：任一方向结束即整体结束。
    // 用 select! 而非 join!：join! 会等两个 future 都完成，当一方提前结束
    // （对端断连 / 出错 / 收到 Close）时另一方仍挂在其 .next().await 或 .send().await，
    // 导致连接与内存泄漏到 OS 超时。select! 让先结束的一方取消另一方，两个 sink
    // 借 drop 自动关闭。
    tokio::select! {
        _ = c2t => {},
        _ = t2c => {},
    }
    Ok(())
}

/// HeaderMap -> HashMap<String, Vec<String>>（lower-case key）
fn headermap_to_hashmap(headers: &HeaderMap) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in headers.iter() {
        let key = k.as_str().to_lowercase();
        let val = v.to_str().unwrap_or("").to_string();
        map.entry(key).or_default().push(val);
    }
    map
}

/// HashMap<String, Vec<String>> -> HeaderMap
fn headermap_from(headers: &HashMap<String, Vec<String>>) -> HeaderMap {
    let mut hm = HeaderMap::new();
    for (k, vals) in headers {
        if let Ok(name) = HeaderName::from_bytes(k.as_bytes()) {
            for v in vals {
                if let Ok(val) = HeaderValue::from_str(v) {
                    hm.append(&name, val);
                }
            }
        }
    }
    hm
}
