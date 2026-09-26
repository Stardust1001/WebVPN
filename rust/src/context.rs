// 请求上下文：对应 Node 版的 ctx.meta
// 每个请求一份，贯穿整个请求生命周期
// host/origin/referer 字段保留以匹配 Node 版 ctx.meta，供钩子方法使用

use url::Url;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Meta {
    pub share_id: String,
    pub is_main_session: bool,
    pub url: String,           // 目标完整 URL
    pub is_xhr: bool,
    pub mime: String,
    pub scheme: String,        // http / https
    pub target: Url,           // 目标 URL 对象
    pub host: String,          // 请求头 host（vpn 域名）
    pub origin: String,        // 请求头 origin
    pub referer: String,       // 请求头 referer
    pub is_done: bool,         // 对应 ctx.meta.done
    pub cache: Option<bool>,   // 对应 ctx.meta.cache
    pub base: String,          // 对应 ctx.meta.base（getBase 计算）
    pub custom_code: String,   // 对应 ctx.meta.customCode
}

impl Default for Meta {
    fn default() -> Self {
        Self {
            share_id: String::new(),
            is_main_session: false,
            url: String::new(),
            is_xhr: false,
            mime: String::new(),
            scheme: String::new(),
            target: Url::parse("about:blank").unwrap_or_else(|_| Url::parse("http://localhost").unwrap()),
            host: String::new(),
            origin: String::new(),
            referer: String::new(),
            is_done: false,
            cache: None,
            base: String::new(),
            custom_code: String::new(),
        }
    }
}

impl Meta {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }
}
