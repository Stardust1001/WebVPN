// 域名编码模块：对应 Node 版的 convertDomainsCode + encodeHost/decodeHost
// 服务端与客户端（注入的 JS）使用同一套逻辑

use std::collections::HashMap;

#[derive(Clone)]
pub struct DomainCodec {
    pub mode: String, // "original" | "underline"
    pub subdomains: HashMap<String, String>, // 短子域 -> 目标域名
    pub domain_dict: HashMap<String, String>, // 目标域名 -> 短子域（反向）
}

impl DomainCodec {
    pub fn new(mode: &str, subdomains: &HashMap<String, String>) -> Self {
        let mut domain_dict = HashMap::new();
        for (sub, name) in subdomains {
            domain_dict.insert(name.clone(), sub.clone());
        }
        Self {
            mode: mode.to_string(),
            subdomains: subdomains.clone(),
            domain_dict,
        }
    }

    /// 对应 _encode_host_original_ / _encode_host_underline_
    pub fn encode_host(&self, text: &str) -> String {
        if let Some(v) = self.domain_dict.get(text) {
            return v.clone();
        }
        match self.mode.as_str() {
            "original" => text.replace(':', "_._"),
            _ => {
                // underline: . -> __, - -> _h_, : -> _c_
                let mut value = text.replace('.', "__");
                // 注意 JS 用 replaceAll('-', '_h_')，先替换 - 再替换 :
                value = value.replace('-', "_h_");
                value = value.replace(':', "_c_");
                value
            }
        }
    }

    /// 对应 _decode_host_original_ / _decode_host_underline_
    pub fn decode_host(&self, text: &str) -> String {
        if let Some(v) = self.subdomains.get(text) {
            return v.clone();
        }
        match self.mode.as_str() {
            "original" => text.replace("_._", ":"),
            _ => {
                // underline: _c_ -> :, _h_ -> -, __ -> .
                // 注意顺序：JS 是 _c_ -> :, _h_ -> -, __ -> .
                let mut value = text.replace("_c_", ":");
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
      const domainMode = '{mode}'
      Object.entries(subdomains).forEach(([sub, name]) => domainDict[name] = sub)
      const _encode_host_original_ = text => {{
        return domainDict[text] || text.replace(':', '_._')
      }}
      const _decode_host_original_ = text => {{
        return subdomains[text] || text.replace('_._', ':')
      }}
      const _encode_host_underline_ = text => {{
        let value = domainDict[text]
        if (!value) {{
          value = text.replaceAll('.', '__').replaceAll('-', '_h_').replace(':', '_c_')
        }}
        return value
      }}
      const _decode_host_underline_ = text => {{
        let value = subdomains[text]
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
