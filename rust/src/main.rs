// 入口：对应 main.js
// 加载配置 -> 初始化 AppState -> 启动 axum HTTP/HTTPS 服务器（含 WebSocket 升级）
// 钩子（beforeRequest/afterRequest/customResponse/beforeResponse/shouldReplaceUrls/initResponseHeaders）
// 在 server.rs 的对应流程里已体现（wasm content-type 覆盖等）

mod cache;
mod charset;
mod config;
mod context;
mod domain;
mod files;
mod headers;
mod mime;
mod rewrite;
mod server;

use std::sync::Arc;
use std::net::SocketAddr;

use axum::{
    Extension,
    Router,
    body::Body,
    extract::{Request, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use crate::config::Config;
use crate::server::{proxy_route, ws_bridge, AppState};

#[tokio::main]
async fn main() {
    // 安装 rustls 进程级 CryptoProvider（ring），避免 reqwest/tokio-tungstenite 启动时
    // 因 aws-lc-rs 与 ring 特性同时存在而 panic（rustls 0.23 默认不自动选择）
    let _ = rustls::crypto::ring::default_provider().install_default();

    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_module_path(false)
        .try_init();

    // 1. 加载配置（config.toml 缺省时用默认值，对应 config.js）
    //    根据运行位置自动校正 public_dir / ssl_dir：
    //    - 从仓库根运行（rust/config.toml 存在）→ public/、ssl/
    //    - 从 rust/ 子目录运行（config.toml 存在）→ ../public、../ssl
    let mut config = if std::path::Path::new("rust/config.toml").exists() {
        let mut c = Config::load_file("rust/config.toml");
        // 仅在用户未显式覆盖时校正为仓库根相对路径
        if c.public_dir == "../public" { c.public_dir = "public".to_string(); }
        if c.ssl_dir == "../ssl" { c.ssl_dir = "ssl".to_string(); }
        c
    } else if std::path::Path::new("config.toml").exists() {
        Config::load_file("config.toml")
    } else {
        Config::default()
    };
    // 派生字段重新计算（确保 public_dir/ssl_dir 改动后仍正确）
    config.derive();

    log::info!("WebVPN 启动中...");
    log::info!("site = {}", config.site);
    log::info!("http_port = {}, https_port = {}", config.port, config.https_port);
    log::info!("domain_mode = {}", config.domain_mode);
    log::info!("vpn_domain = {}", config.vpn_domain);

    // 2. 初始化共享状态
    let state = Arc::new(AppState::new(config.clone()));
    state.public_files.init().await;
    state.disk_cache.init().await;

    // 3. axum 路由：HTTP 和 HTTPS 各用一个 router，区别仅在中间件注入的 SchemeFlag
    //    （对应 Node 版 Koa 自动根据实际 server 判定 http/https scheme）
    let app_http = make_router(state.clone(), false);

    // 4. HTTP 服务
    let http_addr: SocketAddr = format!("0.0.0.0:{}", config.port).parse().expect("invalid http port");
    let http_listener = TcpListener::bind(http_addr).await.expect("bind http failed");
    log::info!("HTTP 监听 {}", http_addr);

    let app_http_svc = app_http.into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(http_listener, app_http_svc).await {
            log::error!("HTTP server error: {}", e);
        }
    });

    // 5. HTTPS 服务（使用自定义 TLS acceptor 包装 axum service）
    if config.https_enabled {
        let https_port = config.https_port;
        let https_addr: SocketAddr = format!("0.0.0.0:{}", https_port).parse().expect("invalid https port");

        match load_tls_config(&config.ssl_dir) {
            Some(tls) => {
                let listener = TcpListener::bind(https_addr).await.expect("bind https failed");
                log::info!("HTTPS 监听 {}", https_addr);
                let app_https = make_router(state.clone(), true);
                tokio::spawn(async move {
                    serve_tls(listener, tls, app_https).await;
                });
            }
            None => {
                log::warn!("未找到 ssl/server.key 或 ssl/server.pem，跳过 HTTPS 启动");
            }
        }
    }

    // 保持主线程存活
    std::future::pending::<()>().await;
}

/// 标记当前请求来自 TLS 还是明文 HTTP 连接。
/// 由 make_router 中的中间件注入到 request extensions，
/// root_handler 提取后用于判断 scheme（对应 Node 版 request.socket.encrypted）。
#[derive(Clone, Copy)]
struct SchemeFlag(bool);

/// 构造一个带 state 的路由。
/// is_tls 决定中间件注入的 SchemeFlag，使 handler 能正确判断 http/https scheme。
fn make_router(state: Arc<AppState>, is_tls: bool) -> Router {
    Router::new()
        .route("/", any(root_handler))
        .route("/{*path}", any(root_handler))
        .layer(middleware::from_fn(move |mut req: Request, next: Next| async move {
            req.extensions_mut().insert(SchemeFlag(is_tls));
            next.run(req).await
        }))
        .with_state(state)
}

/// 统一入口：处理普通 HTTP 请求 + WebSocket 升级
///
/// axum 0.8 中 WebSocketUpgrade 通过 FromRequestParts 提取。
/// 用 Result<WebSocketUpgrade, _> 区分：ws 升级请求时为 Ok，普通请求时为 Err。
async fn root_handler(
    State(state): State<Arc<AppState>>,
    Extension(scheme_flag): Extension<SchemeFlag>,
    ws_upgrade: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    request: Request,
) -> Response {
    // WebSocket 升级判断
    if let Ok(upgrade) = ws_upgrade {
        let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let origin = headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let uri_str = uri.to_string();
        // 判断底层连接是否加密（对应 Node 版 request.socket.encrypted）：
        // SchemeFlag 由 make_router 中间件注入（TLS 连接为 true）；
        // 额外检查 x-forwarded-proto=https 以兼容反代终止 TLS 的场景。
        let is_tls = scheme_flag.0
            || headers
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "https")
                .unwrap_or(false);
        let state_ws = state.clone();
        return upgrade
            .on_upgrade(move |socket| async move {
                let _ = ws_bridge(&state_ws, &host, &origin, &uri_str, is_tls, socket).await;
            })
            .into_response();
    }

    // 普通请求：收集 body，构造完整 URL，调用 proxy_route
    let full_url = build_full_url(&headers, &uri, scheme_flag.0);
    let body = match axum::body::to_bytes(request.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(e) => {
            log::error!("read body failed: {}", e);
            return (StatusCode::BAD_REQUEST, "read body failed").into_response();
        }
    };

    match proxy_route(&state, &method, uri.path(), &full_url, &headers, body).await {
        Ok(Some(out)) => {
            let mut resp = Response::builder().status(out.status);
            for (k, v) in out.headers.iter() {
                resp = resp.header(k.clone(), v.clone());
            }
            resp.body(Body::from(out.body))
                .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "build response failed").into_response())
        }
        Ok(None) => (StatusCode::NOT_FOUND, "not found").into_response(),
        Err(e) => {
            log::error!("proxy error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

/// 根据 Host 头 + URI 构造完整 URL
/// is_tls 由 make_router 中间件注入的 SchemeFlag 给出（对应 Node 版 request.socket.encrypted），
/// 不再依赖 Host:443 推断（浏览器默认省略 443 端口，会导致直接 HTTPS 部署被误判为 http）。
/// 额外检查 x-forwarded-proto=https 以兼容反向代理终止 TLS 的场景。
fn build_full_url(headers: &HeaderMap, uri: &Uri, is_tls: bool) -> String {
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let scheme = if is_tls
        || headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == "https")
            .unwrap_or(false)
    {
        "https"
    } else {
        "http"
    };
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    format!("{}://{}{}", scheme, host, path_and_query)
}

/// 加载 ssl/server.key 和 ssl/server.pem（对应 Node 版的 https 配置）
fn load_tls_config(ssl_dir: &str) -> Option<TlsAcceptor> {
    let key_path = format!("{}/server.key", ssl_dir.trim_end_matches('/'));
    let pem_path = format!("{}/server.pem", ssl_dir.trim_end_matches('/'));
    if !std::path::Path::new(&key_path).exists() || !std::path::Path::new(&pem_path).exists() {
        return None;
    }
    let key = std::fs::read(&key_path).ok()?;
    let pem = std::fs::read(&pem_path).ok()?;

    let mut key_reader = std::io::BufReader::new(&key[..]);
    let mut pem_reader = std::io::BufReader::new(&pem[..]);

    let private_key = rustls_pemfile::private_key(&mut key_reader).ok()??;
    let certs: Vec<_> = rustls_pemfile::certs(&mut pem_reader)
        .filter_map(|c| c.ok())
        .collect();
    if certs.is_empty() {
        return None;
    }

    let server_crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, private_key)
        .ok()?;

    Some(TlsAcceptor::from(std::sync::Arc::new(server_crypto)))
}

/// 在 TCP listener 上做 TLS 握手，再交给 hyper-util auto Builder 处理 HTTP/1+2
///
/// 手动 accept TCP，TLS 握手后用 hyper_util::server::conn::auto::Builder 自动协商 HTTP 版本，
/// 直接把 axum Router（已实现 Service<Request<Incoming>>）当作连接级 Service 传入。
async fn serve_tls(listener: TcpListener, tls: TlsAcceptor, app: Router) {
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use hyper_util::server::conn::auto::Builder as AutoBuilder;
    use hyper_util::service::TowerToHyperService;

    loop {
        let (tcp_stream, _remote) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                // 持续性错误（如 EMFILE 描述符耗尽）下立即 continue 会忙循环占满 CPU，
                // 短暂 sleep 让系统有机会回收资源。对应 Node 版 server.on('error') 的兜底。
                log::warn!("tcp accept failed: {}", e);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let tls = tls.clone();
        // TowerToHyperService 适配 axum Router（tower_service::Service）到 hyper::service::Service
        let svc = TowerToHyperService::new(app.clone());
        tokio::spawn(async move {
            let tls_stream = match tls.accept(tcp_stream).await {
                Ok(s) => s,
                Err(e) => {
                    log::debug!("tls handshake failed: {}", e);
                    return;
                }
            };
            let io = TokioIo::new(tls_stream);
            if let Err(e) = AutoBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, svc)
                .await
            {
                log::debug!("tls connection ended: {}", e);
            }
        });
    }
}
