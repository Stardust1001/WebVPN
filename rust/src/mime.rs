// MIME 判定模块：对应 Node 版的 mimeRegs / mimeDict / noTransformMimes / cacheMimes
// 以及 getResponseType / getMimeByResponseHeaders

use once_cell::sync::Lazy;
use regex::Regex;

/// (正则, mime 类型) —— 与 webvpn.js this.mimeRegs 一致
pub static MIME_REGS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    vec![
        (Regex::new(r"(?i)\.json").unwrap(), "json"),
        (Regex::new(r"(?i)\.js").unwrap(), "js"),
        (Regex::new(r"(?i)\.css").unwrap(), "css"),
        (Regex::new(r"(?i)\.wasm").unwrap(), "wasm"),
        (Regex::new(r"(?i)\.(png|jpg|ico|svg|gif|webp|jpeg)").unwrap(), "image"),
        (Regex::new(r"(?i)\.(mp4|m3u8|ts|flv)[^a-zA-Z]").unwrap(), "video"),
        (Regex::new(r"(?i)\.(mp3|wav|ogg)").unwrap(), "audio"),
        (Regex::new(r"(?i)\.(pdf|csv|tsv|doc|docx|xls|xlsx|ppt|pptx)").unwrap(), "pdf-office"),
        (Regex::new(r"(?i)\.(html|php|do|asp|htm|shtml)").unwrap(), "html"),
        (Regex::new(r"(?i)\.(ttf|eot|woff|woff2)").unwrap(), "font"),
    ]
});

/// 不进入改写流水线，直接管道透传
pub const NO_TRANSFORM_MIMES: &[&str] = &[
    "wasm", "font", "json", "image", "video", "audio", "pdf-office", "stream", "event-stream",
];

/// 可被本地磁盘缓存的类型
pub const CACHE_MIMES: &[&str] = &[
    "js", "css", "font", "image", "video", "audio", "pdf-office",
];

/// mime -> content-type 候选（用 ', ' 分隔，与 Node mimeDict 一致）
pub fn mime_dict(mime: &str) -> Option<&'static str> {
    match mime {
        "html" => Some("text/html"),
        "text" => Some("text/plain"),
        "js" => Some("application/javascript, application/x-javascript, text/javascript"),
        "css" => Some("text/css"),
        "image" => Some("image/png, image/jpg, image/jpeg, image/gif"),
        "json" => Some("application/json"),
        "video" => Some("video/mp4, application/vnd.apple.mpegurl"),
        "audio" => Some("audio/webm, audio/mpeg"),
        "pdf-office" => Some("application/pdf"),
        "stream" => Some("application/octet-stream, application/protobuffer"),
        "event-stream" => Some("text/event-stream"),
        _ => None,
    }
}

/// 对应 getResponseType(ctx, url)
/// PUT/POST 一律 text；按 URL 后缀正则判定；根路径判 html；否则 text
pub fn get_response_type(method: &str, url: &str) -> String {
    if method == "PUT" || method == "POST" {
        return "text".to_string();
    }
    let link = match url.find('?') {
        Some(i) => &url[..i],
        None => url,
    };
    for (re, mime) in MIME_REGS.iter() {
        if re.is_match(link) {
            return mime.to_string();
        }
    }
    // new URL(link).pathname === '/' -> html
    if let Ok(u) = url::Url::parse(link) {
        if u.path() == "/" {
            return "html".to_string();
        }
    }
    "text".to_string()
}

/// 对应 getMimeByResponseHeaders(headers)
/// 按 content-type 二次校正
pub fn get_mime_by_response_headers(content_type: &str) -> Option<String> {
    if content_type.is_empty() {
        return None;
    }
    let ct = content_type.split(';').next().unwrap_or("").trim();
    // 遍历 mimeDict 找匹配
    let all_mimes = [
        "html", "text", "js", "css", "image", "json", "video", "audio", "pdf-office", "stream", "event-stream",
    ];
    for mime in all_mimes.iter() {
        if let Some(parts) = mime_dict(mime) {
            // parts 用 ', ' 分隔；Node 是 split(',') 后 some(part => contentType.indexOf(part) >= 0)
            for part in parts.split(',') {
                let part = part.trim();
                if !part.is_empty() && ct.contains(part) {
                    return Some(mime.to_string());
                }
            }
        }
    }
    // !mime && contentType.startsWith('image/') -> image
    if ct.starts_with("image/") {
        return Some("image".to_string());
    }
    None
}
