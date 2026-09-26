// 静态文件服务 + 磁盘缓存：对应 checkPublic / respondFile / getCache / setCache / checkCaches

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::config::Config;
use crate::context::Meta;

/// 静态文件列表（对应 this.public）
#[derive(Clone, Default)]
pub struct PublicFiles {
    inner: Arc<Mutex<HashSet<String>>>,
    public_dir: String,
}

impl PublicFiles {
    pub fn new(public_dir: &str) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashSet::new())),
            public_dir: public_dir.trim_end_matches('/').to_string(),
        }
    }

    /// 扫描 public/ 目录，初始化文件列表（对应 initPublic）
    pub async fn init(&self) {
        let mut set = HashSet::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&self.public_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Some(name) = entry.file_name().to_str() {
                    set.insert(format!("{}/{}", self.public_dir, name));
                }
            }
        }
        *self.inner.lock().await = set;
    }

    /// 对应 checkPublic(ctx)：检查 url 是否是 /public/xx 并返回文件路径
    pub async fn check(&self, url: &str) -> Option<PathBuf> {
        let parts: Vec<&str> = url.split("/public/").collect();
        let mut filepath = if parts.len() > 1 {
            PathBuf::from(format!("{}/{}", self.public_dir, parts[1]))
        } else {
            return None;
        };
        // 去掉查询串
        if let Some(p) = filepath.to_str() {
            let p = p.split('?').next().unwrap_or(p);
            filepath = PathBuf::from(p);
        }
        let key = filepath.to_string_lossy().replace('\\', "/");
        let guard = self.inner.lock().await;
        if guard.contains(&key) {
            Some(filepath)
        } else {
            None
        }
    }
}

/// 磁盘缓存索引（对应 this.caches）
#[derive(Clone, Default)]
pub struct DiskCache {
    /// host -> 文件名集合
    inner: Arc<Mutex<std::collections::HashMap<String, HashSet<String>>>>,
    cache_dir: String,
    enabled: bool,
}

impl DiskCache {
    pub fn new(config: &Config) -> Self {
        Self {
            inner: Arc::new(Mutex::new(std::collections::HashMap::new())),
            cache_dir: config.cache_dir.clone(),
            enabled: config.cache,
        }
    }

    /// 对应 checkCaches()：扫描缓存目录索引
    pub async fn init(&self) {
        if !self.enabled {
            return;
        }
        let mut map = std::collections::HashMap::new();
        if let Ok(mut dirs) = tokio::fs::read_dir(&self.cache_dir).await {
            while let Ok(Some(dir)) = dirs.next_entry().await {
                if let Some(dir_name) = dir.file_name().to_str() {
                    let mut files = HashSet::new();
                    let dir_path = format!("{}/{}", self.cache_dir, dir_name);
                    if let Ok(mut entries) = tokio::fs::read_dir(&dir_path).await {
                        while let Ok(Some(entry)) = entries.next_entry().await {
                            if let Some(name) = entry.file_name().to_str() {
                                files.insert(name.to_string());
                            }
                        }
                    }
                    map.insert(dir_name.to_string(), files);
                }
            }
        }
        *self.inner.lock().await = map;
    }

    /// 对应 getCache(ctx)：检查缓存命中
    pub async fn get(&self, meta: &Meta) -> Option<PathBuf> {
        if !self.enabled {
            return None;
        }
        let host = meta.target.host_str()?;
        let pathname = meta.target.path();
        let filename = percent_encoding::utf8_percent_encode(
            pathname,
            percent_encoding::NON_ALPHANUMERIC,
        ).to_string();
        let guard = self.inner.lock().await;
        let files = guard.get(host)?;
        if !files.contains(&filename) {
            return None;
        }
        Some(PathBuf::from(format!("{}/{}/{}", self.cache_dir, host, filename)))
    }

    /// 对应 setCache(ctx, res)：写入缓存
    pub async fn set(&self, meta: &Meta, data: &[u8], cache_mimes: &[&str]) {
        if !self.enabled
            || !cache_mimes.contains(&meta.mime.as_str())
            || data.is_empty()
            || meta.cache == Some(false)
        {
            return;
        }
        let host = match meta.target.host_str() {
            Some(h) => h.to_string(),
            None => return,
        };
        let pathname = meta.target.path();
        let filename = percent_encoding::utf8_percent_encode(
            pathname,
            percent_encoding::NON_ALPHANUMERIC,
        ).to_string();
        let dir = format!("{}/{}", self.cache_dir, host);
        let _ = tokio::fs::create_dir_all(&dir).await;
        let path = format!("{}/{}", dir, filename);
        let _ = tokio::fs::write(&path, data).await;
        // 更新索引
        let mut guard = self.inner.lock().await;
        let entry = guard.entry(host).or_insert_with(HashSet::new);
        entry.insert(filename);
    }
}
