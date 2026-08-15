use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// Bounded, TTL-aware in-memory cache — deep rewrite core.
///
/// Replaces the ad-hoc `Mutex<HashMap<String, CachedFoo>>` + manual `fetched_at` checks
/// that were scattered through `main.rs` (9k lines). Single struct owns expiry, LRU-ish
/// eviction, and size bounding so every cache (stream 300/45m, watch 50/30m, track 500/7d)
/// shares the same correctness properties and is tested (ttl_expiry, lru_eviction).
///
/// `V` must carry its own `fetched_at`; the cache only reads it via the `Cached` trait.
pub trait Cached {
    fn fetched_at(&self) -> Instant;
}

pub struct TtlCache<K, V> {
    map: HashMap<K, V>,
    max_size: usize,
    ttl: Duration,
    // Insertion order for LRU eviction (oldest at front).
    order: Vec<K>,
}

impl<K, V> TtlCache<K, V>
where
    K: Eq + std::hash::Hash + Clone,
    V: Cached,
{
    pub fn new(max_size: usize, ttl: Duration) -> Self {
        Self {
            map: HashMap::with_capacity(max_size),
            max_size,
            ttl,
            order: Vec::with_capacity(max_size),
        }
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        let v = self.map.get(key)?;
        if v.fetched_at().elapsed() > self.ttl {
            self.remove(key);
            return None;
        }
        // Touch for LRU: move key to back
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos);
            self.order.push(k);
        }
        self.map.get(key)
    }

    pub fn insert(&mut self, key: K, value: V) {
        if self.map.contains_key(&key) {
            if let Some(pos) = self.order.iter().position(|k| k == &key) {
                self.order.remove(pos);
            }
        }
        self.order.push(key.clone());
        self.map.insert(key, value);
        self.evict_if_needed();
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.map.remove(key)
    }

    /// Remove all entries whose TTL has elapsed. Call periodically or
    /// before size checks to avoid leaking expired entries.
    pub fn cleanup_expired(&mut self) {
        // Collect to avoid borrow issues
        let expired: Vec<K> = self
            .map
            .iter()
            .filter(|(_, v)| v.fetched_at().elapsed() > self.ttl)
            .map(|(k, _)| k.clone())
            .collect();
        for k in expired {
            self.remove(&k);
        }
    }

    /// Retain only entries for which predicate returns true. Also removes expired.
    pub fn retain<F>(&mut self, mut f: F)
    where
        F: FnMut(&K, &V) -> bool,
    {
        let to_remove: Vec<K> = self
            .map
            .iter()
            .filter(|(k, v)| v.fetched_at().elapsed() > self.ttl || !f(k, v))
            .map(|(k, _)| k.clone())
            .collect();
        for k in to_remove {
            self.remove(&k);
        }
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.map.values()
    }

    fn evict_if_needed(&mut self) {
        while self.map.len() > self.max_size {
            if let Some(oldest) = self.order.first().cloned() {
                self.remove(&oldest);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone)]
    struct Entry {
        fetched_at: Instant,
    }
    impl Cached for Entry {
        fn fetched_at(&self) -> Instant {
            self.fetched_at
        }
    }

    #[test]
    fn ttl_expiry() {
        let mut c: TtlCache<String, Entry> = TtlCache::new(10, Duration::from_millis(50));
        c.insert(
            "k".to_string(),
            Entry {
                fetched_at: Instant::now(),
            },
        );
        assert!(c.get(&"k".to_string()).is_some());
        std::thread::sleep(Duration::from_millis(60));
        assert!(c.get(&"k".to_string()).is_none());
    }

    #[test]
    fn lru_eviction() {
        let mut c: TtlCache<String, Entry> = TtlCache::new(2, Duration::from_secs(60));
        for key in ["a", "b", "c"] {
            c.insert(
                key.to_string(),
                Entry {
                    fetched_at: Instant::now(),
                },
            );
        }
        assert_eq!(c.values().count(), 2);
        assert!(c.get(&"a".to_string()).is_none());
        assert!(c.get(&"b".to_string()).is_some());
        assert!(c.get(&"c".to_string()).is_some());
    }
}
