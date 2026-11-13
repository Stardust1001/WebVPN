// 域名编码模块：对应 Node 版的 convertDomainsCode + encodeHost/decodeHost
// 服务端与客户端（注入的 JS）使用同一套逻辑

use std::collections::HashMap;

#[derive(Clone)]
pub struct DomainCodec {
    pub mode: String, // "original" | "underline"
    pub subdomains: HashMap<String, String>, // 短子域 -> 目标域名（目标可带 '*' 通配前缀）
    pub domain_dict: HashMap<String, String>, // 目标域名 -> 短子域（反向，仅精确映射）
    pub wildcard_dict: HashMap<String, String>, // 通配后缀（'*suffix' 去掉 '*'）-> 短子域
}

impl DomainCodec {
    pub fn new(mode: &str, subdomains: &HashMap<String, String>) -> Self {
        let mut domain_dict = HashMap::new();
        let mut wildcard_dict = HashMap::new();
        for (sub, name) in subdomains {
            if let Some(suffix) = name.strip_prefix('*') {
                // 通配映射：'*aaa.com' 匹配 '<任意前缀>aaa.com'，
                // 编码 = 通配前缀原样保留 + (把 'aaa.com' 整体替换为 key)。
                // 用于下划线模式下编码后单标签会超 63 字符的长域名。
                wildcard_dict.insert(suffix.to_string(), sub.clone());
            } else {
                domain_dict.insert(name.clone(), sub.clone());
            }
        }
        Self {
            mode: mode.to_string(),
            subdomains: subdomains.clone(),
            domain_dict,
            wildcard_dict,
        }
    }

    /// 对应 matchWildcard：返回 (短子域, 通配后缀)
    fn match_wildcard(&self, text: &str) -> Option<(&str, &str)> {
        self.wildcard_dict
            .iter()
            .find(|(suffix, _)| text.ends_with(*suffix))
            .map(|(suffix, sub)| (sub.as_str(), suffix.as_str()))
    }

    /// 对应 _encode_host_original_ / _encode_host_underline_
    pub fn encode_host(&self, text: &str) -> String {
        if let Some(v) = self.domain_dict.get(text) {
            return v.clone();
        }
        match self.mode.as_str() {
            // JS 用 .replace(':', '_._')（首匹配），Rust str::replace 替换全部。
            // 用 replacen(.., 1) 保持一致，避免原 hostname 含字面 "_._" 时多替换。
            "original" => text.replacen(':', "_._", 1),
            _ => {
                if let Some((sub, suffix)) = self.match_wildcard(text) {
                    let mut value = String::with_capacity(text.len() - suffix.len() + sub.len());
                    value.push_str(&text[..text.len() - suffix.len()]);
                    value.push_str(sub);
                    return value;
                }
                // 注意 JS 用 replaceAll('.', '__') / replaceAll('-', '_h_')（全替换），
                // 但 : 用 .replace(':', '_c_')（首匹配）。用 replacen 保持一致。
                let mut value = text.replace('.', "__");
                value = value.replace('-', "_h_");
                value = value.replacen(':', "_c_", 1);
                value
            }
        }
    }

    /// 对应 _decode_host_original_ / _decode_host_underline_
    pub fn decode_host(&self, text: &str) -> String {
        if let Some(v) = self.subdomains.get(text) {
            // 通配映射在 host 恰好等于后缀本身时编码为裸 key，精确命中也要剥掉 '*'
            return v.strip_prefix('*').unwrap_or(v).to_string();
        }
        match self.mode.as_str() {
            "original" => text.replacen("_._", ":", 1),
            _ => {
                // 通配编码的子域以 '.<key>' 结尾（key 不会出现在普通编码结果末尾，
                // 普通编码结果末尾是 '__'、'_h_' 或裸标识符），反向替换回 '*suffix'。
                // 编码时前缀含结尾的 '.'（suffix 不以 . 开头），此处补回。
                for (sub, name) in &self.subdomains {
                    let Some(suffix) = name.strip_prefix('*') else { continue };
                    let dot_sub = format!(".{}", sub);
                    if text.len() > dot_sub.len() && text.ends_with(&dot_sub) {
                        let mut value = String::from(&text[..text.len() - dot_sub.len()]);
                        value.push('.');
                        value.push_str(suffix);
                        return value;
                    }
                }
                // underline: _c_ -> :, _h_ -> -, __ -> .
                // 注意顺序：JS 是 .replace('_c_', ':')（首匹配），replaceAll('_h_', '-')，replaceAll('__', '.')
                let mut value = text.replacen("_c_", ":", 1);
                value = value.replace("_h_", "-");
                value = value.replace("__", ".");
                value
            }
        }
    }

    /// 生成 convertDomainsCode（注入到 index.html / 每个 HTML 头部 / Worker 上下文）
    /// 与 Node 版逐字符对齐
    pub fn convert_domains_code(&self, http_vpn_domain: &str, https_vpn_domain: &str) -> String {
        let subdomains_json = serde_json::to_string(&self.subdomains).unwrap_or_else(|_| "{}".to_string());
        format!(
            r#"
      const httpVpnDomain = '{http}'
      const httpsVpnDomain = '{https}'
      const subdomains = {sub}
      const domainDict = {{}}
      const wildcardDict = {{}}
      const domainMode = '{mode}'
      Object.entries(subdomains).forEach(([sub, name]) => {{
        if (name.startsWith('*')) {{
          // 通配映射：'*aaa.com' 匹配 '<任意前缀>aaa.com'，
          // 编码 = 通配前缀原样保留 + (把 'aaa.com' 整体替换为 key)。
          // 用于下划线模式下编码后单标签会超 63 字符的长域名（如动态域名）。
          wildcardDict[name.slice(1)] = sub
        }} else {{
          domainDict[name] = sub
        }}
      }})
      const _encode_host_original_ = text => {{
        return domainDict[text] || text.replace(':', '_._')
      }}
      const _decode_host_original_ = text => {{
        return subdomains[text] || text.replace('_._', ':')
      }}
      const matchWildcard = text => {{
        for (const [suffix, sub] of Object.entries(wildcardDict)) {{
          if (text.endsWith(suffix)) return [sub, suffix]
        }}
        return null
      }}
      const _encode_host_underline_ = text => {{
        let value = domainDict[text]
        if (!value) {{
          const m = matchWildcard(text)
          if (m) {{
            value = text.slice(0, text.length - m[1].length) + m[0]
          }} else {{
            value = text.replaceAll('.', '__').replaceAll('-', '_h_').replace(':', '_c_')
          }}
        }}
        return value
      }}
      const _decode_host_underline_ = text => {{
        let value = subdomains[text]
        if (!value) {{
          // 通配编码的子域以 '.<key>' 结尾（key 不会出现在普通编码结果末尾，
          // 普通编码结果末尾是 '__'、'_h_' 或裸标识符），反向替换回 '*<suffix>'
          for (const [sub, name] of Object.entries(subdomains)) {{
            if (!name.startsWith('*')) continue
            const suffix = '.' + sub
            if (text.endsWith(suffix) && text.length > suffix.length) {{
              value = text.slice(0, text.length - suffix.length) + name.slice(1)
              break
            }}
          }}
        }}
        if (!value) {{
          value = text.replace('_c_', ':').replaceAll('_h_', '-').replaceAll('__', '.')
        }}
        return value
      }}
      globalThis.encodeHost = domainMode === 'underline' ? _encode_host_underline_ : _encode_host_original_
      globalThis.decodeHost = domainMode === 'underline' ? _decode_host_underline_ : _decode_host_original_
    "#,
            http = http_vpn_domain,
            https = https_vpn_domain,
            sub = subdomains_json,
            mode = self.mode
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codec() -> DomainCodec {
        let mut subdomains = HashMap::new();
        subdomains.insert("baidu".to_string(), "www.baidu.com".to_string());
        subdomains.insert("aaa".to_string(), "*aaa.com".to_string());
        DomainCodec::new("underline", &subdomains)
    }

    #[test]
    fn wildcard_encode_keeps_prefix_verbatim() {
        let c = codec();
        let host = "dyn1-abc123-def45678.aaa.com";
        let encoded = c.encode_host(host);
        assert_eq!(encoded, "dyn1-abc123-def45678.aaa");
        // 每个 DNS 标签都不超 63 字符
        assert!(encoded.split('.').all(|l| l.len() <= 63));
    }

    #[test]
    fn wildcard_encode_decode_roundtrip() {
        let c = codec();
        let host = "abc-123.aaa.com";
        assert_eq!(c.decode_host(&c.encode_host(host)), host);
    }

    #[test]
    fn wildcard_encode_without_prefix() {
        // 恰好等于后缀本身时前缀为空，编码结果就是 key
        let c = codec();
        assert_eq!(c.encode_host("aaa.com"), "aaa");
        assert_eq!(c.decode_host("aaa"), "aaa.com");
    }

    #[test]
    fn exact_match_still_wins_over_wildcard() {
        let c = codec();
        assert_eq!(c.encode_host("www.baidu.com"), "baidu");
        // 不匹配通配的域名照常下划线编码
        assert_eq!(c.encode_host("a-b.example.com"), "a_h_b__example__com");
    }

    #[test]
    fn wildcard_decode_only_when_dot_key_suffix() {
        let c = codec();
        // '.aaa' 后缀不在末尾时不误判（如 xxx__aaa__com）
        assert_eq!(c.decode_host("foo__aaa__com"), "foo.aaa.com");
        // 纯 key 整段是精确 subdomain 查找的职责（subdomains 里有 aaa），上面已覆盖
    }

    #[test]
    fn convert_domains_code_contains_wildcard_logic() {
        let c = codec();
        let code = c.convert_domains_code("webvpn.info", "webvpn.info");
        assert!(code.contains("wildcardDict"));
        assert!(code.contains("matchWildcard"));
        // 执行无语法错误
        // (JS 语法由 Node 端单测覆盖，这里只验证关键片段存在)
    }
}
