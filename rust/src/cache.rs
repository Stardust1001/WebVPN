// 会话共享持久化存储：对应 Node 版的 sessionStore
// 把 cookie/authorization/clientCache 落盘到 sessions/ 目录。
//
// 每个独立文件，写入用「写临时文件 → rename」原子替换——读者要么看到旧完整文件、
// 要么看到新完整文件，永远不会读到半截，因此多线程/多进程并发无需文件锁。
// key 形如 "<shareId>-cookie"，shareId 来自客户端，必须 sanitize 防路径穿越。
//
// Rust 版用 tokio 多线程代替 cluster，单进程内 Arc 共享，但文件持久化让重启不丢会话。

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;

/// 全局递增计数器，保证同线程同纳秒的两次 set_item 也有不同 .tmp 文件名
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 获取当前线程的唯一标识（std::thread::ThreadId 无法直接转数字，用 hash）
fn thread_id_value() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::thread::current().id().hash(&mut h);
    h.finish()
}

/// TTL（对应 Node 版 sessionStore.ttl = 30 * 60 * 1000）
const TTL: Duration = Duration::from_secs(30 * 60);

/// 单条缓存项的 JSON 结构（序列化后落盘）
#[derive(serde::Serialize, serde::Deserialize)]
struct SessionItem {
    value: String,
    expires: u64, // Unix 毫秒时间戳
}

#[derive(Clone, Default)]
pub struct SessionStore {
    dir: Arc<String>,
    /// 短 TTL 内存读缓存：避免每个请求都读盘（cookie/auth 在单请求内被读两次）
    /// 写入时同步刷新。3s 过期，命中则直接返回内存值。
    read_cache: Arc<Mutex<std::collections::HashMap<String, (String, Instant)>>>,
    read_cache_ttl: Duration,
    /// 读缓存最大条目数（防攻击者生成大量 shareId 导致内存膨胀）
    read_cache_max: usize,
}

impl SessionStore {
    pub fn new(dir: &str) -> Self {
        Self {
            dir: Arc::new(dir.to_string()),
            read_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
            read_cache_ttl: Duration::from_secs(3),
            read_cache_max: 1000,
        }
    }

    /// 启动时初始化：创建目录 + 清理过期文件与残留 .tmp（对应 Node 版 start() 中的 ensureDir + cleanup）
    pub async fn init(&self) {
        self.ensure_dir().await;
        self.cleanup().await;
    }

    /// shareId 只允许字母数字与 _ -，其余替换为 _，并限制长度，杜绝 ../ 等穿越
    fn sanitize_key(key: &str) -> String {
        key.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(128)
            .collect()
    }

    fn file_path(&self, key: &str) -> PathBuf {
        PathBuf::from(self.dir.as_str()).join(format!("{}.json", Self::sanitize_key(key)))
    }

    async fn ensure_dir(&self) {
        let _ = fs::create_dir_all(self.dir.as_str()).await;
    }

    /// 读缓存防膨胀：超过上限时先清过期条目，仍超则任意淘汰。
    /// 攻击者可生成大量 shareId，每个 miss 都会往 read_cache 塞一条；
    /// 条目虽 3s 后过期但不会被主动移出 HashMap，故需在插入前显式淘汰。
    fn evict_read_cache_locked(
        guard: &mut std::collections::HashMap<String, (String, Instant)>,
        max: usize,
    ) {
        if guard.len() < max {
            return;
        }
        let now = Instant::now();
        // 先清过期条目（已自然失效，淘汰它们最安全）
        guard.retain(|_, (_, expires)| *expires > now);
        // 仍超上限则任意淘汰（HashMap 无序，等价于随机淘汰，与 Node 版取首键一致）
        while guard.len() >= max {
            let key_to_remove = match guard.keys().next().cloned() {
                Some(k) => k,
                None => break,
            };
            guard.remove(&key_to_remove);
        }
    }

    /// 对应 sessionStore.getItem(key)
    /// 过期则当不存在（并顺手删文件）
    pub async fn get_item(&self, key: &str) -> Option<String> {
        // 先查内存读缓存
        {
            let guard = self.read_cache.lock().await;
            if let Some((val, expires)) = guard.get(key) {
                if *expires > Instant::now() {
                    return Some(val.clone());
                }
            }
        }

        let file = self.file_path(key);
        let text = match fs::read_to_string(&file).await {
            Ok(t) => t,
            Err(_) => return None,
        };
        let item: SessionItem = match serde_json::from_str(&text) {
            Ok(it) => it,
            Err(_) => return None,
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if item.expires > 0 && now_ms > item.expires {
            let _ = fs::remove_file(&file).await;
            // 同步清除内存读缓存中的过期条目（对应 Node 版 this.readCache.delete(key)）
            // 条目虽已自然失效不会被命中，但留着会占据 HashMap 直到淘汰上限，此处显式清理
            let mut guard = self.read_cache.lock().await;
            guard.remove(key);
            return None;
        }
        // 填充内存读缓存（先按需淘汰，防 read_cache 无限膨胀）
        let mut guard = self.read_cache.lock().await;
        Self::evict_read_cache_locked(&mut guard, self.read_cache_max);
        guard.insert(
            key.to_string(),
            (item.value.clone(), Instant::now() + self.read_cache_ttl),
        );
        Some(item.value)
    }

    /// 对应 sessionStore.setItem(key, value)
    /// 写临时文件 → rename 原子替换。Windows 上 EBUSY/EPERM 时短暂重试。
    pub async fn set_item(&self, key: &str, value: String) {
        self.ensure_dir().await;
        let file = self.file_path(key);
        let pid = std::process::id();
        // 临时文件名唯一性：pid + 线程 id + 纳秒时间戳 + 全局计数器。
        // 此前用 Instant::now().elapsed()，但 .elapsed() 在刚创建的 Instant 上约等于 0，
        // 多线程并发时 rand 几乎恒定，会导致 .tmp 文件名冲突。
        let rand: u64 = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::Hasher;
            let mut h = DefaultHasher::new();
            h.write_u64(pid as u64);
            h.write_u64(thread_id_value());
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            h.write_u64(nanos);
            h.write_u64(COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            h.finish()
        };
        let tmp = PathBuf::from(self.dir.as_str())
            .join(format!("{}.{}.{}.tmp", Self::sanitize_key(key), pid, rand));

        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64 + TTL.as_millis() as u64)
            .unwrap_or(0);
        let payload = match serde_json::to_string(&SessionItem {
            value: value.clone(),
            expires,
        }) {
            Ok(s) => s,
            Err(_) => return,
        };

        if fs::write(&tmp, &payload).await.is_err() {
            return;
        }

        // rename：同卷原子（POSIX rename(2) / Windows MoveFileExW + REPLACE_EXISTING）。
        // Windows 上若目标文件恰好被读导致 EBUSY/EPERM，短暂重试。
        for attempt in 0..3u32 {
            match fs::rename(&tmp, &file).await {
                Ok(_) => {
                    // 同步刷新内存读缓存（同样先按需淘汰）
                    let mut guard = self.read_cache.lock().await;
                    Self::evict_read_cache_locked(&mut guard, self.read_cache_max);
                    guard.insert(
                        key.to_string(),
                        (value, Instant::now() + self.read_cache_ttl),
                    );
                    return;
                }
                Err(e) if attempt < 2 && is_rename_retryable(&e) => {
                    tokio::time::sleep(Duration::from_millis(10 * (attempt as u64 + 1))).await;
                    continue;
                }
                Err(e) => {
                    // 不可重试：清理临时文件，本次写入放弃
                    // 会话共享是 best-effort：写失败时读端继续用旧值或返回空，不应让请求本身失败
                    let _ = fs::remove_file(&tmp).await;
                    log::warn!("[WebVPN] sessionStore.set_item failed: key={}, err={}", key, e);
                    return;
                }
            }
        }
    }

    /// 启动时清理过期文件与残留 .tmp（对应 sessionStore.cleanup）
    pub async fn cleanup(&self) {
        let mut entries = match fs::read_dir(self.dir.as_str()).await {
            Ok(e) => e,
            Err(_) => return,
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let name = match name.to_str() {
                Some(s) => s,
                None => continue,
            };
            let path = entry.path();
            if name.ends_with(".tmp") {
                let _ = fs::remove_file(&path).await;
                continue;
            }
            if !name.ends_with(".json") {
                continue;
            }
            // 读文件检查过期。读失败或解析失败都视为损坏 → 删除（对应 Node 版 catch 块）
            let expired = match fs::read_to_string(&path).await {
                Ok(text) => match serde_json::from_str::<SessionItem>(&text) {
                    Ok(item) => item.expires > 0 && now_ms > item.expires,
                    Err(_) => true,
                },
                Err(_) => true,
            };
            if expired {
                let _ = fs::remove_file(&path).await;
            }
        }
    }
}

/// Windows 上 rename 可能因目标文件被占用而失败（EBUSY/EPERM/EACCES），
/// 短暂重试即可（文件极小，冲突窗口极短）。
fn is_rename_retryable(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    matches!(
        e.kind(),
        ErrorKind::PermissionDenied | ErrorKind::ResourceBusy | ErrorKind::WouldBlock
    ) || e.raw_os_error()
        .map(|code| code == 13 /* EACCES */ || code == 32 /* EBUSY(Windows) */ || code == 1 /* EPERM */)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建一个使用唯一临时目录的 SessionStore，测试结束后自动清理
    async fn make_store(test_name: &str) -> (SessionStore, String) {
        let dir = format!("test-sessions-{}-{}", test_name, std::process::id());
        let _ = fs::remove_dir_all(&dir).await;
        let store = SessionStore::new(&dir);
        store.ensure_dir().await;
        (store, dir)
    }

    async fn cleanup(dir: &str) {
        let _ = fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn test_basic_set_get() {
        let (store, dir) = make_store("basic").await;
        store.set_item("abc-cookie", "a=1; b=2".to_string()).await;
        let v = store.get_item("abc-cookie").await;
        assert_eq!(v.as_deref(), Some("a=1; b=2"));
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn test_path_traversal_sanitized() {
        let (store, dir) = make_store("traversal").await;
        // 恶意 shareId 含 ../，必须被 sanitize 成 _，不能逃出 sessions 目录
        store.set_item("../../../etc/passwd-cookie", "evil".to_string()).await;
        let sanitized = SessionStore::sanitize_key("../../../etc/passwd-cookie");
        assert!(!sanitized.contains('/'));
        assert!(!sanitized.contains('.'));
        let v = store.get_item("../../../etc/passwd-cookie").await;
        assert_eq!(v.as_deref(), Some("evil"));
        // 确认文件落在 sessions 目录内，而非上级
        let mut entries = fs::read_dir(&dir).await.unwrap();
        let mut count = 0;
        let mut entries_vec = vec![];
        while let Ok(Some(e)) = entries.next_entry().await {
            entries_vec.push(e.path());
            count += 1;
        }
        assert_eq!(count, 1, "should be exactly 1 file, got {:?} in {}", entries_vec, dir);
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn test_missing_key() {
        let (store, dir) = make_store("missing").await;
        let v = store.get_item("nonexistent").await;
        assert!(v.is_none());
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn test_overwrite() {
        let (store, dir) = make_store("overwrite").await;
        store.set_item("ow", "first".to_string()).await;
        store.set_item("ow", "second".to_string()).await;
        let v = store.get_item("ow").await;
        assert_eq!(v.as_deref(), Some("second"));
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn test_concurrent_writes_same_key() {
        let (store, dir) = make_store("concurrent").await;
        // 20 个并发写同一 key，rename 重试机制应保证最终只剩一个值，无 .tmp 残留
        let store_clone = store.clone();
        let mut handles = vec![];
        for i in 0..20u32 {
            let s = store_clone.clone();
            handles.push(tokio::spawn(async move {
                s.set_item("conc", format!("val-{}", i)).await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let v = store.get_item("conc").await;
        assert!(v.as_ref().unwrap().starts_with("val-"), "got {:?}", v);
        // 检查无 .tmp 残留
        let mut entries = fs::read_dir(&dir).await.unwrap();
        let mut tmp_count = 0;
        while let Ok(Some(e)) = entries.next_entry().await {
            if let Some(name) = e.file_name().to_str() {
                if name.ends_with(".tmp") {
                    tmp_count += 1;
                }
            }
        }
        assert_eq!(tmp_count, 0, "{} .tmp files leftover", tmp_count);
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn test_cleanup_removes_tmp_and_expired() {
        let (store, dir) = make_store("cleanup").await;
        // 手写一个 .tmp 残留文件
        let tmp_path = PathBuf::from(&dir).join("leftover.tmp");
        fs::write(&tmp_path, "garbage").await.unwrap();
        // 手写一个过期 .json 文件
        let expired = SessionItem { value: "old".to_string(), expires: 1 };
        let expired_path = PathBuf::from(&dir).join("expired.json");
        fs::write(&expired_path, serde_json::to_string(&expired).unwrap()).await.unwrap();
        // 手写一个未过期 .json 文件
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64 + 3_600_000)
            .unwrap_or(0);
        let valid = SessionItem { value: "alive".to_string(), expires: future };
        let valid_path = PathBuf::from(&dir).join("valid.json");
        fs::write(&valid_path, serde_json::to_string(&valid).unwrap()).await.unwrap();
        // 手写一个损坏 .json 文件（内容不是合法 JSON，cleanup 应删除）
        let corrupt_path = PathBuf::from(&dir).join("corrupt.json");
        fs::write(&corrupt_path, "not valid json {{{{").await.unwrap();

        store.cleanup().await;

        assert!(!tmp_path.exists(), ".tmp should be removed");
        assert!(!expired_path.exists(), "expired .json should be removed");
        assert!(valid_path.exists(), "valid .json should remain");
        assert!(!corrupt_path.exists(), "corrupt .json should be removed");
        cleanup(&dir).await;
    }
}

