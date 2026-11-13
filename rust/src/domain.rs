// 域名编码模块：对应 Node 版的 convertDomainsCode + encodeHost/decodeHost
// 服务端与客户端（注入的 JS）使用同一套逻辑

use std::collections::HashMap;
// subdomains 需按配置顺序遍历（通配项先配置者先赢），HashMap 无序
use indexmap::IndexMap;

#[derive(Clone)]
pub struct DomainCodec {
    pub mode: String, // "original" | "underline"
    pub subdomains: IndexMap<String, String>, // 短子域 -> 目标域名（目标可含 '*' 通配，见下）
    pub domain_dict: HashMap<String, String>, // 目标域名 -> 短子域（反向，仅精确映射）
    // 通配映射：短子域 -> value 按 '*' 切段。key 与 value 都按 '*' 切段且段数一致
    // （'wave-*dashcdn' ↔ 'mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-*.builds.wavedashcdn.com'，
    // 逐段配对）：value 的字面段是锚点
    // （首段锚开头、末段锚结尾、中间段按序出现），段间为动态段。编码 = key 段逐段替换
    // 对应 value 段，动态段原样保留、直接拼接（无分隔符），如
    // 'mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123.builds.wavedashcdn.com' -> 'wave-abc123dashcdn'，
    // 缩短长字面段；
    // 解码用同一匹配器对 key 段做锚定匹配后还原，动态段恰好包含 key 字面量时有歧义
    // （warn warn warn，取最左匹配）
    // 通配项按配置顺序匹配（多个通配项都能命中同一段文本时先配置者先赢），
    // 必须保序，故用 Vec 而非 HashMap；JS 端 Object.entries 同样保持插入顺序
    pub wildcard_dict: Vec<(String, Vec<String>)>,
}

/// 字面段锚定匹配：parts 依次锚定 text——首段为前缀，末段为后缀，中间段按序出现，
/// 段间为动态段（间隙）。逐段取最左出现并回溯，保证确定性与完备性；
/// 返回各间隙内容（无则空串），不匹配返回 None
fn find_parts(text: &str, parts: &[String]) -> Option<Vec<String>> {
    if parts.len() < 2 || !text.starts_with(&parts[0]) {
        return None;
    }
    let mut gaps = vec![String::new(); parts.len() - 1];
    fn walk(text: &str, parts: &[String], i: usize, pos: usize, gaps: &mut Vec<String>) -> bool {
        if i == parts.len() {
            return pos == text.len();
        }
        let rest = &text[pos..];
        if i + 1 == parts.len() {
            // 末段必须锚定结尾，间隙为剩余部分
            if rest.len() >= parts[i].len() && rest.ends_with(&parts[i]) {
                gaps[i - 1] = rest[..rest.len() - parts[i].len()].to_string();
                return true;
            }
            return false;
        }
        // 中间段取最左出现，失败回溯到下一个出现位置
        let mut from = 0;
        while let Some(idx) = rest[from..].find(&parts[i]) {
            let at = from + idx;
            gaps[i - 1] = rest[..at].to_string();
            if walk(text, parts, i + 1, pos + at + parts[i].len(), gaps) {
                return true;
            }
            from = at + 1;
        }
        false
    }
    if walk(text, parts, 1, parts[0].len(), &mut gaps) {
        Some(gaps)
    } else {
        None
    }
}

/// 段与间隙交错拼接：segs[0] gaps[0] segs[1] gaps[1] ... segs[n]
fn join_parts(segs: &[String], gaps: &[String]) -> String {
    let mut out = segs[0].clone();
    for (j, gap) in gaps.iter().enumerate() {
        out.push_str(gap);
        out.push_str(&segs[j + 1]);
    }
    out
}

impl DomainCodec {
    pub fn new(mode: &str, subdomains: &IndexMap<String, String>) -> Self {
        let mut domain_dict = HashMap::new();
        let mut wildcard_dict = Vec::new();
        for (sub, name) in subdomains {
            let key_parts: Vec<&str> = sub.split('*').collect();
            let value_parts: Vec<&str> = name.split('*').collect();
            if key_parts.len() == value_parts.len() && key_parts.len() > 1 {
                // 通配映射：key/value 段数一致（含 '*'），逐段配对，按配置顺序保存
                wildcard_dict.push((
                    sub.clone(),
                    value_parts.iter().map(|s| s.to_string()).collect(),
                ));
            } else {
                if sub.contains('*') || name.contains('*') {
                    // 启动时警告通配配置错误：段数不一致的 '*' 无法逐段配对，该条目直接忽略
                    log::warn!("subdomains 通配符配置错误：key '{}' 与 value '{}' 的 '*' 数量不一致，该条目已忽略", sub, name);
                } else {
                    // 无 '*'：精确映射
                    domain_dict.insert(name.clone(), sub.clone());
                }
            }
        }
        Self {
            mode: mode.to_string(),
            subdomains: subdomains.clone(),
            domain_dict,
            wildcard_dict,
        }
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
                // 通配匹配直接在原始 host 上做字面段锚定
                for (sub, parts) in &self.wildcard_dict {
                    if let Some(gaps) = find_parts(text, parts) {
                        // 编码 = key 段逐段替换对应 value 段，动态段原样直拼（无分隔符），
                        // 如 'mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-*.builds.wavedashcdn.com'
                        // 编码 'mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123.builds.wavedashcdn.com'
                        // -> 'wave-abc123dashcdn'，缩短长字面段
                        let keys: Vec<String> = sub.split('*').map(|s| s.to_string()).collect();
                        return join_parts(&keys, &gaps);
                    }
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
            // subdomains 直接来自配置；若 value（目标域名）含 '*'（通配配置错误被忽略
            // 后不应解码出带 '*' 的域名），返回空串交由上层按未知子域处理
            if v.contains('*') {
                return String::new();
            }
            return v.clone();
        }
        match self.mode.as_str() {
            "original" => text.replacen("_._", ":", 1),
            _ => {
                // 通配解码：与编码同一匹配器对 key 段做字面段锚定匹配，提取间隙后
                // 还原到 value 段位置直接拼接。动态段恰好包含 key 字面量时取最左匹配，
                // 与编码的最左策略对称（warn warn warn）。必须先查通配再走普通解码
                for (sub, parts) in &self.wildcard_dict {
                    let keys: Vec<String> = sub.split('*').map(|s| s.to_string()).collect();
                    if let Some(gaps) = find_parts(text, &keys) {
                        let restored = join_parts(parts, &gaps);
                        let mut value = restored.replacen("_c_", ":", 1);
                        value = value.replace("_h_", "-");
                        value = value.replace("__", ".");
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
        // 含 '*' 的条目走通配映射：key 与 value 都按 '*' 切段且段数一致，逐段配对；
        // 段数不一致（配置错误，启动时服务端已警告）该条目直接忽略
        if (!name.includes('*')) {{
          domainDict[name] = sub
        }} else if (sub.split('*').length === name.split('*').length) {{
          wildcardDict[sub] = name.split('*')
        }}
      }})
      const findParts = (text, parts) => {{
        // 字面段锚定匹配：首段为前缀，末段为后缀，中间段按序出现（最左优先，回溯），
        // 段间为动态段（间隙）。返回各间隙内容（无则 ''），不匹配返回 null
        if (parts.length < 2 || !text.startsWith(parts[0])) return null
        const gaps = new Array(parts.length - 1).fill('')
        const walk = (i, pos) => {{
          if (i === parts.length) return pos === text.length
          const rest = text.slice(pos)
          if (i + 1 === parts.length) {{
            if (rest.length >= parts[i].length && rest.endsWith(parts[i])) {{
              gaps[i - 1] = rest.slice(0, rest.length - parts[i].length)
              return true
            }}
            return false
          }}
          let from = 0
          for (;;) {{
            const idx = rest.slice(from).indexOf(parts[i])
            if (idx === -1) return false
            const at = from + idx
            gaps[i - 1] = rest.slice(0, at)
            if (walk(i + 1, pos + at + parts[i].length)) return true
            from = at + 1
          }}
        }}
        return walk(1, parts[0].length) ? gaps : null
      }}
      const joinParts = (segs, gaps) => {{
        // 段与间隙交错直接拼接（无分隔符）
        let out = segs[0]
        gaps.forEach((gap, j) => {{ out += gap + segs[j + 1] }})
        return out
      }}
      const _encode_host_original_ = text => {{
        return domainDict[text] || text.replace(':', '_._')
      }}
      const _decode_host_original_ = text => {{
        return subdomains[text] || text.replace('_._', ':')
      }}
      const _encode_host_underline_ = text => {{
        let value = domainDict[text]
        if (!value) {{
          for (const [sub, parts] of Object.entries(wildcardDict)) {{
            const gaps = findParts(text, parts)
            if (gaps) {{
              // key 段逐段替换对应 value 段，动态段原样直拼（无分隔符），
              // 如 'mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-*.builds.wavedashcdn.com'
              // 编码 'mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123.builds.wavedashcdn.com'
              // -> 'wave-abc123dashcdn'，缩短长字面段
              value = joinParts(sub.split('*'), gaps)
              break
            }}
          }}
          if (!value) {{
            value = text.replaceAll('.', '__').replaceAll('-', '_h_').replace(':', '_c_')
          }}
        }}
        return value
      }}
      const _decode_host_underline_ = text => {{
        let value = subdomains[text]
        if (value) return value
        value = undefined
        // 通配解码：与编码同一匹配器对 key 段做字面段锚定匹配，提取间隙后
        // 还原到 value 段位置直接拼接。动态段恰好包含 key 字面量时取最左匹配，
        // 与编码的最左策略对称（warn warn warn）。必须先查通配再走普通解码
        for (const [sub, parts] of Object.entries(wildcardDict)) {{
          const gaps = findParts(text, sub.split('*'))
          if (gaps) {{
            value = joinParts(parts, gaps).replace('_c_', ':').replaceAll('_h_', '-').replaceAll('__', '.')
            break
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
        let mut subdomains = IndexMap::new();
        subdomains.insert("baidu".to_string(), "www.baidu.com".to_string());
        // 通配映射：key/value 各 1 个 '*'，逐段配对，长字面段被短 key 段替换缩短
        subdomains.insert(
            "wave-*dashcdn".to_string(),
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-*.builds.wavedashcdn.com".to_string(),
        );
        DomainCodec::new("underline", &subdomains)
    }

    #[test]
    fn wildcard_encode_replaces_segments_verbatim() {
        let c = codec();
        // key 段逐段替换 value 段，动态段原样直拼（无分隔符）
        assert_eq!(
            c.encode_host("mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123.builds.wavedashcdn.com"),
            "wave-abc123dashcdn"
        );
        // 无动态段：恰好等于 value 模式，编码为 key 段直拼
        assert_eq!(
            c.encode_host("mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-.builds.wavedashcdn.com"),
            "wave-dashcdn"
        );
    }

    #[test]
    fn wildcard_encode_decode_roundtrip() {
        let c = codec();
        // 动态段不能含 key 字面量（'wave-' / 'dashcdn'）与转义序列字面量
        // （'_' / '__' / '_c_'）：直接拼接格式下解码会按最左匹配错切动态段，
        // 且解码会对还原串整体做反转义（固有歧义，warn warn warn），
        // 往返测试只保证无碰撞 host（真实 CDN build id 为十六进制串，安全）
        for host in [
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123.builds.wavedashcdn.com",
            // 动态段含 '-'：通配路径字面直拼不转义（'-' 本就是合法标签字符），
            // 编码结果含 '.'/标签结构与普通路径不同，往返仍可逆
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-d1f2-e3.builds.wavedashcdn.com",
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123dashcdnx.builds.wavedashcdn.com",
        ] {
            assert_eq!(c.decode_host(&c.encode_host(host)), host, "host: {host}");
        }
        assert_eq!(
            c.encode_host("mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-d1f2-e3.builds.wavedashcdn.com"),
            "wave-d1f2-e3dashcdn"
        );
    }

    #[test]
    fn wildcard_decode_rebuilds_value() {
        let c = codec();
        assert_eq!(
            c.decode_host("wave-abc123dashcdn"),
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-abc123.builds.wavedashcdn.com"
        );
        assert_eq!(
            c.decode_host("wave-dashcdn"),
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-.builds.wavedashcdn.com"
        );
    }

    #[test]
    fn exact_match_still_wins_over_wildcard() {
        let c = codec();
        assert_eq!(c.encode_host("www.baidu.com"), "baidu");
        // 不匹配通配的域名照常下划线编码
        assert_eq!(c.encode_host("a-b.example.com"), "a_h_b__example__com");
    }

    #[test]
    fn wildcard_decode_falls_back_to_plain() {
        let c = codec();
        // 不命中任何 key 段模式的编码串走普通解码
        assert_eq!(c.decode_host("a_h_b__example__com"), "a-b.example.com");
        // key 首段 'wave-' 含 '-'，普通编码串的 '-' 均已转义为 '_h_'，
        // 前缀锚不可能命中，普通编码串不会误入通配解码：
        assert_eq!(c.decode_host("wave_a_h_b_dashcdn"), "wave_a-b_dashcdn");
        // 编码串 "wave-a__bdashcdn"（动态段含字面 '__' 的 host 编码而来）解码时
        // 通配命中、还原后整体反转义，'__' 被误转为 '.'（固有歧义，warn warn warn）：
        assert_eq!(
            c.decode_host("wave-a__bdashcdn"),
            "mx7ba9zy4tvjtdjkzj1em8ecwh8dbg61-a.b.builds.wavedashcdn.com"
        );
    }

    #[test]
    fn mismatched_star_count_is_ignored() {
        // key/value 段数不一致（配置错误）：警告后该条目直接忽略，不进任何字典
        let mut subdomains = IndexMap::new();
        subdomains.insert("t1".to_string(), "xxx*zzz.com".to_string());
        let c = DomainCodec::new("underline", &subdomains);
        // 含 '*' 的目标域名永远无法命中真实 host，编码走普通 underline 逻辑
        assert_eq!(c.encode_host("x.zz.com"), "x__zz__com");
        assert_eq!(c.decode_host("t1"), "");
    }

    #[test]
    fn wildcard_entries_match_in_config_order() {
        // 多个通配项都能命中同一段文本时，先配置者先赢：
        // host 'xzzz' 同时命中 'x*zz'（gap 'z'）与 'x*zzz'（gap ''）两个 value 模式
        let mut subdomains = IndexMap::new();
        subdomains.insert("a*b".to_string(), "x*zz".to_string());
        subdomains.insert("c*d".to_string(), "x*zzz".to_string());
        let c = DomainCodec::new("underline", &subdomains);
        assert_eq!(c.encode_host("xzzz"), "azb");
        // 颠倒配置顺序后应命中另一项（顺序敏感，HashMap 实现下此断言随机失败）
        let mut rev = IndexMap::new();
        rev.insert("c*d".to_string(), "x*zzz".to_string());
        rev.insert("a*b".to_string(), "x*zz".to_string());
        let c2 = DomainCodec::new("underline", &rev);
        assert_eq!(c2.encode_host("xzzz"), "cd");
    }

    #[test]
    fn convert_domains_code_contains_wildcard_logic() {
        let c = codec();
        let code = c.convert_domains_code("webvpn.info", "webvpn.info");
        assert!(code.contains("wildcardDict"));
        assert!(code.contains("findParts"));
        // 执行无语法错误
        // (JS 语法由 Node 端单测覆盖，这里只验证关键片段存在)
    }
}
