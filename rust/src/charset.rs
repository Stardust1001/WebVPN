// 字符集解码：对应 Node 版的 convertCharsetData
// 处理 zstd 压缩响应 + 非 utf-8 字符集 -> utf-8

use regex::Regex;
use encoding_rs::UTF_8;
use once_cell::sync::Lazy;

/// 预编译：charset 检测用正则
/// 排除集与 Node 版 reMetaCharset=/[^"'\/>]+/i 一致（仅 "、'、/、>），不含空格。
/// 此前误加空格会使 <meta charset="utf-8 "> 等带尾随空格的标签匹配不到 charset。
static META_CHARSET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta charset=["'][^"'/\>]+"#).unwrap());
static META_CT_CHARSET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta http-equiv="Content-Type" content="text/html;\s*charset=[^"'/\>]+"#).unwrap());
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

    // 解析 charset
    let mut charset = content_type
        .split("charset=")
        .nth(1)
        .map(|s| s.to_lowercase());
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
        None => return (text.into_owned(), content_type.to_string()),
    };

    if charset == "utf-8" || charset == "utf8" {
        // Node: utf-8 时不修改 content-type 头，直接 return text。
        // 即使 charset 来自 meta 标签，也保持原始 content-type 不变。
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
