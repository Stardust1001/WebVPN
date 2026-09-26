// 全局缓存模块：对应 Node 版的 globalCache
// Rust 版用 tokio 的 Mutex<HashMap> + Arc 实现多线程共享
// （Node 版用 cluster IPC 跨进程同步；Rust 单进程多线程无需 IPC）

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub struct GlobalCache {
    inner: Arc<Mutex<HashMap<String, String>>>,
}

impl GlobalCache {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn get_item(&self, key: &str) -> Option<String> {
        self.inner.lock().await.get(key).cloned()
    }

    pub async fn set_item(&self, key: &str, value: String) {
        self.inner.lock().await.insert(key.to_string(), value);
    }
}
