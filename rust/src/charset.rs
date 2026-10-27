// 字符集解码：对应 Node 版的 convertCharsetData
// 处理 zstd 压缩响应 + 非 utf-8 字符集 -> utf-8

use regex::Regex;
use encoding_rs::UTF_8;
use once_cell::sync::Lazy;

/// 预编译：charset 检测用正则
/// 排除集与 Node 版 reMetaCharset=/[^"'\/>]+/i 一致（仅 "、'、/、>），不含空格。
/// 此前误加空格会使 <meta charset="utf-8 "> 等带尾随空格的标签匹配不到 charset。
static META_CHARSET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta charset=["'][^"'/>]+"#).unwrap());
static META_CT_CHARSET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta http-equiv="Content-Type" content="text/html;\s*charset=[^"'/>]+"#).unwrap());
static META_CHARSET_REPLACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta charset=["'][^"'/>]+["']>"#).unwrap());

/// 对应 convertCharsetData(ctx, headers, res)
/// 输入：原始字节、content-encoding、content-type、mime
/// 输出：(text, 新的 content-type)
pub fn convert_charset_data(
    bytes: &[u8],
    content_encoding: Option<&str>,
    content_type: &str,
    mime: &str,
) -> (String, String) {
    // 非 html/js 直接以 utf-8 解码（Node 版走 res.text()）
    if mime != "html" && mime != "js" {
        let (text, _, _) = UTF_8.decode(bytes);
        return (text.into_owned(), content_type.to_string());
    }

    // zstd 解压
    let (decoded_bytes, used_zstd) = if content_encoding == Some("zstd") {
        match zstd::decode_all(bytes) {
            Ok(d) => (d, true),
            Err(_) => (bytes.to_vec(), false),
        }
    } else {
        (bytes.to_vec(), false)
    };

    // 先按 utf-8 解一次
    let (text, _, _) = UTF_8.decode(&decoded_bytes);

    // 解析 charset（content-type 头中可能带引号，如 charset="gbk"，需去除引号与分号后的多余参数）
    let mut charset = content_type
        .split("charset=")
        .nth(1)
        .map(|s| {
            s.trim()
                .trim_matches('"')
                .trim_matches('\'')
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_lowercase()
        })
        .filter(|s| !s.is_empty());
    // charset 是否来自 meta 标签（而非 content-type 头）
    let mut charset_from_meta = false;

    if charset.is_none() {
        // 从 meta 标签找
        let m = META_CHARSET_RE.find(&text).or_else(|| META_CT_CHARSET_RE.find(&text));
        if let Some(m) = m {
            charset = m.as_str()
                .split("charset=")
                .nth(1)
                .map(|s| s.replace('"', "").to_lowercase());
            charset_from_meta = true;
        }
    }

    let charset = match charset {
        Some(c) => c,
        None => {
            // 未声明 charset（头和 meta 都没有）：正文已按 utf-8 解码，必须显式声明。
            // 否则浏览器对响应做编码嗅探 —— 注入代码里 UTF-8 中文注释密度高时，
            // Chrome 会误判为 GBK，多字节错位吞掉字符串里的 ASCII 引号/反斜杠，
            // 导致注入块 SyntaxError（webvpn 未定义），进而全站脚本连锁报错
            // （如 echartsjs 首页 (index):22:34642）。Node 版同场景同样不声明，
            // 依赖 Koa 后续行为，存在同款隐患；这里比 Node 更进一步，头声明兜底。
            let default_ct = if mime == "html" { "text/html" } else { "application/javascript" };
            let base = if content_type.is_empty() { default_ct } else { content_type };
            return (text.into_owned(), format!("{}; charset=utf-8", base));
        }
    };

    if charset == "utf-8" || charset == "utf8" {
        // Node: utf-8 时不修改 content-type 头，直接 return text。
        // 但 charset 仅来自 meta 标签时，注入块位于原 <head> 之前，浏览器解析到
        // meta 之前就已开始嗅探并可能误判编码（同上述 GBK 误判链），因此把
        // charset=utf-8 补进 content-type 头；charset 来自头时原本就有，保持不变。
        if charset_from_meta && !content_type.contains("charset=") {
            let base = if content_type.is_empty() { "text/html" } else { content_type };
            return (text.into_owned(), format!("{}; charset=utf-8", base));
        }
        return (text.into_owned(), content_type.to_string());
    }

    // 非 utf-8：用 encoding_rs 解码，并改写 content-type
    // 若 charset 来自 meta，需先重建 content-type 以包含 charset（Node 版同理：
    // contentType = 'text/html; charset=' + charset 后再 .replace(charset, 'utf-8')）。
    // JS 用 .replace(charset, 'utf-8')（首匹配），Rust str::replace 替换全部。
    // 用 replacen 保持一致。
    let ct = if charset_from_meta {
        format!("text/html; charset={}", charset)
    } else {
        content_type.to_string()
    };
    let new_ct = ct.replacen(&charset, "utf-8", 1);
    let enc = encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(UTF_8);
    let (decoded, _, _) = enc.decode(&decoded_bytes);
    let mut decoded = decoded.into_owned();

    // 替换 meta charset（JS 用 .replace(regex, ...) 无 g flag，仅首匹配）
    decoded = META_CHARSET_REPLACE_RE.replace(&decoded, "<meta charset=\"utf-8\">").to_string();

    let _ = used_zstd;
    (decoded, new_ct)
}
