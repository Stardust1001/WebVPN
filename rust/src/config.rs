// 配置模块：对应 Node.js 版的 config.js
// 运行时可由 config.toml（同级目录或上级目录）覆盖默认值

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// WebVPN 域名是否支持 https
    pub https_enabled: bool,
    /// WebVPN 服务端口
    pub port: u16,
    /// WebVPN https 服务端口
    pub https_port: u16,
    /// WebVPN 服务网址，访问其他网站都从这里转换
    pub site: String,
    /// 工作进程数（Rust 版用 tokio 多线程代替，这里保留用于兼容）
    pub num_processes: usize,
    /// 是否启用缓存
    pub cache: bool,
    /// 缓存文件夹地址
    pub cache_dir: String,
    /// 会话共享持久化目录（share sessions 的 cookie/authorization/clientCache 落盘于此）
    /// 多进程下用「写临时文件 → rename」原子替换，无需文件锁；重启不丢会话
    pub sessions_dir: String,
    /// public 目录路径（前端资源目录，默认 ../public 因为 rust 代码在子目录）
    pub public_dir: String,
    /// ssl 目录路径（证书目录，默认 ../ssl 因为 rust 代码在子目录）
    pub ssl_dir: String,
    /// 是否在浏览器控制台打印拦截操作的日志
    pub intercept_log: bool,
    /// 是否禁止跳转
    pub disable_jump: bool,
    /// 跳转前是否询问用户
    pub confirm_jump: bool,
    /// 是否禁用 source map
    pub disable_source_map: bool,
    /// 是否启用插件
    pub enable_plugins: bool,
    /// 是否开启调试（VConsole）
    pub debug: bool,
    /// 是否禁用 devtools
    pub disable_devtools: bool,
    /// 是否启用 this 完整改写（oxc AST 解析，把每个 this 替换为 (this === self ? __self__ : this)）
    /// 默认 false：仅用正则改写 with(this) 模式（性能更好）
    /// true：用 oxc 解析全部 JS，拦截任何 this 穿透获得 window 的可能（更安全但更慢）
    pub rewrite_this: bool,
    /// 域名编码模式 original | underline
    pub domain_mode: String,
    /// 单域名代理映射
    pub subdomains: HashMap<String, String>,

    // ===== 下面是派生字段（构造函数里计算），序列化为 camelCase 以兼容前端 =====
    pub vpn_domain: String,
    pub http_vpn_domain: String,
    pub https_vpn_domain: String,
}

impl Default for Config {
    fn default() -> Self {
        let mut c = Self {
            https_enabled: true,
            port: 80,
            https_port: 443,
            site: "http://www.webvpn.info".to_string(),
            num_processes: 4,
            cache: false,
            cache_dir: "cache".to_string(),
            sessions_dir: "sessions".to_string(),
            public_dir: "../public".to_string(),
            ssl_dir: "../ssl".to_string(),
            intercept_log: false,
            disable_jump: false,
            confirm_jump: false,
            disable_source_map: true,
            enable_plugins: true,
            debug: false,
            disable_devtools: true,
            rewrite_this: false,
            domain_mode: "underline".to_string(),
            subdomains: {
                let mut m = HashMap::new();
                m.insert("baidu".to_string(), "www.baidu.com".to_string());
                m.insert("im".to_string(), "im.qq.com".to_string());
                m
            },
            vpn_domain: String::new(),
            http_vpn_domain: String::new(),
            https_vpn_domain: String::new(),
        };
        c.derive();
        c
    }
}

impl Config {
    /// 根据 site 计算派生域名（对应 Node 构造函数）
    /// Node: config.vpnDomain = '.' + site.hostname.replace(/^www\./, '')
    /// 即先去掉开头的 "www."，再在最前面补 "."，得到形如 ".webvpn.info" 的 vpnDomain。
    pub fn derive(&mut self) {
        let site = Url::parse(&self.site).unwrap_or_else(|_| Url::parse("http://www.webvpn.info").unwrap());
        let host = site.host_str().unwrap_or("www.webvpn.info");
        // 对应 site.hostname.replace(/^www\./, '')：仅去掉开头的 "www."，不动其余位置的 "www"
        let stripped = host.strip_prefix("www.").unwrap_or(host);
        // 对应 '.' + ...
        let vpn_domain = format!(".{}", stripped);
        self.vpn_domain = vpn_domain.clone();
        self.http_vpn_domain = format!("{}{}", vpn_domain, if self.port == 80 { String::new() } else { format!(":{}", self.port) });
        self.https_vpn_domain = format!("{}{}", vpn_domain, if self.https_port == 443 { String::new() } else { format!(":{}", self.https_port) });
    }

    /// 尝试从路径读取 TOML 配置并覆盖默认值
    pub fn load_file(path: &str) -> Self {
        let mut c = Config::default();
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(loaded) = toml::from_str::<ConfigToml>(&text) {
                loaded.apply(&mut c);
            }
        }
        c.derive();
        c
    }

    /// site 的 host（含端口），如 www.webvpn.info:443 或 www.webvpn.info
    pub fn site_host(&self) -> String {
        let site = Url::parse(&self.site).unwrap_or_else(|_| Url::parse("http://www.webvpn.info").unwrap());
        match site.port() {
            Some(p) => format!("{}:{}", site.host_str().unwrap_or(""), p),
            None => site.host_str().unwrap_or("").to_string(),
        }
    }

    /// site.origin（协议://host[:port]）
    pub fn site_origin(&self) -> String {
        let site = Url::parse(&self.site).unwrap_or_else(|_| Url::parse("http://www.webvpn.info").unwrap());
        site.origin().ascii_serialization()
    }
}

/// TOML 反序列化用（字段都 Option，缺省即用默认）
/// 注意：Config 用于序列化给前端，所以用 camelCase；但 TOML 配置文件遵循
/// snake_case 惯例，所以 ConfigToml 不加 rename_all，保持 snake_case 键名
#[derive(Deserialize, Default)]
struct ConfigToml {
    https_enabled: Option<bool>,
    port: Option<u16>,
    https_port: Option<u16>,
    site: Option<String>,
    num_processes: Option<usize>,
    cache: Option<bool>,
    cache_dir: Option<String>,
    sessions_dir: Option<String>,
    public_dir: Option<String>,
    ssl_dir: Option<String>,
    intercept_log: Option<bool>,
    disable_jump: Option<bool>,
    confirm_jump: Option<bool>,
    disable_source_map: Option<bool>,
    enable_plugins: Option<bool>,
    debug: Option<bool>,
    disable_devtools: Option<bool>,
    rewrite_this: Option<bool>,
    domain_mode: Option<String>,
    subdomains: Option<HashMap<String, String>>,
}

impl ConfigToml {
    fn apply(&self, c: &mut Config) {
        if let Some(v) = self.https_enabled { c.https_enabled = v; }
        if let Some(v) = self.port { c.port = v; }
        if let Some(v) = self.https_port { c.https_port = v; }
        if let Some(v) = &self.site { c.site = v.clone(); }
        if let Some(v) = self.num_processes { c.num_processes = v; }
        if let Some(v) = self.cache { c.cache = v; }
        if let Some(v) = &self.cache_dir { c.cache_dir = v.clone(); }
        if let Some(v) = &self.sessions_dir { c.sessions_dir = v.clone(); }
        if let Some(v) = &self.public_dir { c.public_dir = v.clone(); }
        if let Some(v) = &self.ssl_dir { c.ssl_dir = v.clone(); }
        if let Some(v) = self.intercept_log { c.intercept_log = v; }
        if let Some(v) = self.disable_jump { c.disable_jump = v; }
        if let Some(v) = self.confirm_jump { c.confirm_jump = v; }
        if let Some(v) = self.disable_source_map { c.disable_source_map = v; }
        if let Some(v) = self.enable_plugins { c.enable_plugins = v; }
        if let Some(v) = self.debug { c.debug = v; }
        if let Some(v) = self.disable_devtools { c.disable_devtools = v; }
        if let Some(v) = self.rewrite_this { c.rewrite_this = v; }
        if let Some(v) = &self.domain_mode { c.domain_mode = v.clone(); }
        if let Some(v) = &self.subdomains { c.subdomains = v.clone(); }
    }
}
