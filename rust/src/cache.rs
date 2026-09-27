// 全局缓存模块：对应 Node 版的 globalCache
// Rust 版用 tokio 的 Mutex<HashMap> + Arc 实现多线程共享
// （Node 版用 cluster IPC 跨进程同步；Rust 单进程多线程无需 IPC）
//
// 与 Node 版一致：TTL=30min、maxItems=10000、超容量时淘汰最早过期的条目。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// 单条缓存项：值 + 过期时间
struct CacheItem {
    value: String,
    expires: Instant,
}

/// TTL（对应 Node 版 globalCache.ttl = 30 * 60 * 1000）
const TTL: Duration = Duration::from_secs(30 * 60);
/// 最大条目数（对应 Node 版 globalCache.maxItems = 10000）
const MAX_ITEMS: usize = 10000;

#[derive(Clone, Default)]
pub struct GlobalCache {
    inner: Arc<Mutex<HashMap<String, CacheItem>>>,
}

impl GlobalCache {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// 对应 globalCache.getItem(key)
    /// 过期则删除并返回 None
    pub async fn get_item(&self, key: &str) -> Option<String> {
        let mut guard = self.inner.lock().await;
        let expired = match guard.get(key) {
            Some(item) => item.expires < Instant::now(),
            None => return None,
        };
        if expired {
            guard.remove(key);
            return None;
        }
        guard.get(key).map(|item| item.value.clone())
    }

    /// 对应 globalCache.setItem(key, value)
    /// 达到 maxItems 时淘汰 expires 最早的条目
    pub async fn set_item(&self, key: &str, value: String) {
        let mut guard = self.inner.lock().await;
        // Node 版不检查 key 是否已存在：只要 len >= maxItems 就先淘汰最早过期的条目。
        // 此前加了 !contains_key(key) 守卫，会导致覆盖已存在 key 时跳过淘汰，
        // 与 Node 语义不符。移除该守卫以保持一致。
        if guard.len() >= MAX_ITEMS {
            // Node 用 Infinity 初始化 oldestTime，确保第一个条目一定更小。
            // Rust 没有 Instant::infinity，用 Option + take 模拟。
            let mut oldest_key: Option<String> = None;
            let mut oldest_time: Option<Instant> = None;
            for (k, item) in guard.iter() {
                if oldest_time.is_none() || item.expires < oldest_time.unwrap() {
                    oldest_time = Some(item.expires);
                    oldest_key = Some(k.clone());
                }
            }
            if let Some(k) = oldest_key {
                guard.remove(&k);
            }
        }
        guard.insert(key.to_string(), CacheItem {
            value,
            expires: Instant::now() + TTL,
        });
    }
}
