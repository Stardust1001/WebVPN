// 字符集解码：对应 Node 版的 convertCharsetData
// 处理 zstd 压缩响应 + 非 utf-8 字符集 -> utf-8

use regex::Regex;
use encoding_rs::UTF_8;
use once_cell::sync::Lazy;

/// 预编译：charset 检测用正则
static META_CHARSET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta charset=["'][^"'/ >]+"#).unwrap());
static META_CT_CHARSET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)<meta http-equiv="Content-Type" content="text/html;\s*charset=[^"'/ >]+"#).unwrap());
static META_CHARSET_REPLACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"<meta charset="\w+">"#).unwrap());

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

    if charset.is_none() {
        // 从 meta 标签找
        let m = META_CHARSET_RE.find(&text).or_else(|| META_CT_CHARSET_RE.find(&text));
        if let Some(m) = m {
            charset = m.as_str()
                .split("charset=")
                .nth(1)
                .map(|s| s.replace('"', "").to_lowercase());
        }
    }

    let charset = match charset {
        Some(c) => c,
        None => return (text.into_owned(), content_type.to_string()),
    };

    if charset == "utf-8" || charset == "utf8" {
        return (text.into_owned(), content_type.to_string());
    }

    // 非 utf-8：用 encoding_rs 解码，并改写 content-type
    let new_ct = content_type.replace(&charset, "utf-8");
    let enc = encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(UTF_8);
    let (decoded, _, _) = enc.decode(&decoded_bytes);
    let mut decoded = decoded.into_owned();

    // 替换 meta charset
    decoded = META_CHARSET_REPLACE_RE.replace_all(&decoded, "<meta charset=\"utf-8\">").to_string();

    let _ = used_zstd;
    (decoded, new_ct)
}
