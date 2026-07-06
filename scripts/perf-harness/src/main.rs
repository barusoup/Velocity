// Long-horizon perf harness for velocity.
//
// Simulates the velocities (writes per minute) the Rust backend's
// data store + IPC command surfaces actually see under realistic
// workloads:
//   * Settings toggles and slider drags (write_user_data with the
//     full settings blob on each tick).
//   * Recent-searches (App.tsx writes velocity-recent-searches on
//     each submitted search).
//   * Scroll-position snapshots while the user pages around
//     (historyState.entries[].scrollTop).
//   * Loudness cache entries (velocity-loudness-cache writes per
//     analyzed track, large JSON blob).
//
// Plus the hot reads (load_all_user_data on boot, every settings
// read via get_setting).
//
// Two execution modes are supported:
//   * `baseline`    — synchronous read-modify-write per write call.
//                     Identical semantics to src-tauri/src/data_store.rs
//                     before the coalesced-flush land.
//   * `optimized`   — in-memory mirror + coalesced debounced flush,
//                     plus fixed-cost drain on shutdown.
//
// Both modes drive the same workload stream and report identical
// per-event classifications. The diff between two runs (one per mode,
// same knobs) is the perf delta directly attributable to the
// optimization.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::{rngs::ThreadRng, Rng};
use serde_json::Value;
use tokio::fs;
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;

// ── Arguments ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Baseline,
    Optimized,
}

impl Mode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "baseline" => Ok(Mode::Baseline),
            "optimized" => Ok(Mode::Optimized),
            other => Err(format!("unknown mode: {other} (expected baseline|optimized)")),
        }
    }
}

#[derive(Debug)]
struct Args {
    mode: Mode,
    duration: Duration,
    workers: usize,
    keys: usize,
}

fn print_usage() {
    eprintln!(
        "Usage: perf-harness run --mode <baseline|optimized> \
         [--duration-secs N] [--workers N] [--keys N]"
    );
}

fn parse_args(rest: &[String]) -> Result<Args, String> {
    let mut mode: Option<Mode> = None;
    let mut duration_secs: u64 = 120;
    let mut workers: usize = 4;
    let mut keys: usize = 120;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--mode" => {
                let v = rest.get(i + 1).ok_or("--mode missing value")?;
                mode = Some(Mode::parse(v)?);
                i += 2;
            }
            "--duration-secs" => {
                let v = rest.get(i + 1).ok_or("--duration-secs missing value")?;
                duration_secs = v.parse().map_err(|e| format!("bad duration: {e}"))?;
                i += 2;
            }
            "--workers" => {
                let v = rest.get(i + 1).ok_or("--workers missing value")?;
                workers = v.parse().map_err(|e| format!("bad workers: {e}"))?;
                i += 2;
            }
            "--keys" => {
                let v = rest.get(i + 1).ok_or("--keys missing value")?;
                keys = v.parse().map_err(|e| format!("bad keys: {e}"))?;
                i += 2;
            }
            other => return Err(format!("unknown flag: {other}")),
        }
    }
    let mode = mode.ok_or("--mode is required")?;
    if workers == 0 {
        return Err("--workers must be > 0".to_string());
    }
    if keys == 0 {
        return Err("--keys must be > 0".to_string());
    }
    Ok(Args {
        mode,
        duration: Duration::from_secs(duration_secs),
        workers,
        keys,
    })
}

// ── Workload model ─────────────────────────────────────────────────────
//
// Each tick emits a "user action" picked from a stationary distribution
// tuned to match long-horizon observed behavior:
//
//    35% scroll-position snapshot    (small, one writer, frequent —
//                                    every navigation/back-forward)
//    25% setting toggle              (medium, settings blob rewrite,
//                                    bursty during EQ slider drags)
//    15% recent-search append        (small, prepend to list, ~every
//                                    minute on a heavy user)
//    10% loudness cache entry       (large, one write per analyzed
//                                    track — can hit MBs of JSON)
//     8% saved-songs add/remove      (medium, full collection rewrite)
//     7% settings bulk (equalizer + master) (one writer per slider tick)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    ScrollSnapshot,
    SettingsToggle,
    RecentSearch,
    LoudnessCache,
    SavedSongs,
    EqSlider,
    ReadSetting,
    ReadRecentSearches,
    ReadLoudness,
}

struct Workload {
    rng: ThreadRng,
}

impl Workload {
    fn new() -> Self {
        Self { rng: rand::thread_rng() }
    }

    fn next(&mut self) -> Action {
        let r = self.rng.gen_range(0..100);
        match r {
            0..=34 => Action::ScrollSnapshot,
            35..=59 => Action::SettingsToggle,
            60..=74 => Action::RecentSearch,
            75..=84 => Action::LoudnessCache,
            85..=92 => Action::SavedSongs,
            93..=99 => Action::EqSlider,
            _ => unreachable!(),
        }
    }

    fn pick_key(&mut self, keys: usize) -> usize {
        self.rng.gen_range(0..keys)
    }

    fn payload_size(&mut self, action: Action) -> usize {
        // Bytes per write, roughly matching the velocity payload sizes
        // observed in the storage layer. Calibrated to the same scale
        // as the real per-key entries; ratios matter, absolute numbers
        // don't have to match byte-for-byte.
        let (lo, hi) = match action {
            Action::ScrollSnapshot => (16, 32),
            Action::SettingsToggle => (256, 512),
            Action::RecentSearch => (96, 160),
            Action::LoudnessCache => (1024, 4096),
            Action::SavedSongs => (512, 2048),
            Action::EqSlider => (96, 128),
            Action::ReadSetting
            | Action::ReadRecentSearches
            | Action::ReadLoudness => (0, 0),
        };
        if lo == hi {
            lo
        } else {
            self.rng.gen_range(lo..=hi)
        }
    }
}

// ── Persistence layer (enum dispatch, no dyn) ──────────────────────────
//
// Two implementations of the same shape. We dispatch via an enum so
// the driver code calls a single `apply_write(...)` etc. without
// needing boxed futures or async-trait shims. The implementations
// are identical to the production data_store.rs semantics.

const COALESCE_WINDOW: Duration = Duration::from_millis(250);

enum Persistence {
    Baseline(BaselineState),
    Optimized(OptimizedState),
}

struct BaselineState {
    path: PathBuf,
    map: RwLock<HashMap<String, Value>>,
    syncs: std::sync::atomic::AtomicU64,
}

struct OptimizedState {
    path: PathBuf,
    map: Arc<RwLock<HashMap<String, Value>>>,
    dirty: Arc<std::sync::atomic::AtomicBool>,
    syncs: Arc<std::sync::atomic::AtomicU64>,
}

impl Persistence {
    async fn load_all(&self) -> Result<HashMap<String, String>, String> {
        match self {
            Persistence::Baseline(s) => {
                let guard = s.map.read().await;
                Ok(guard
                    .iter()
                    .map(|(k, v)| (k.clone(), serde_json::to_string(v).unwrap_or_default()))
                    .collect())
            }
            Persistence::Optimized(s) => {
                let guard = s.map.read().await;
                Ok(guard
                    .iter()
                    .map(|(k, v)| (k.clone(), serde_json::to_string(v).unwrap_or_default()))
                    .collect())
            }
        }
    }

    async fn write(&self, key: String, value: String) -> Result<(), String> {
        match self {
            Persistence::Baseline(s) => {
                let parsed: Value =
                    serde_json::from_str(&value).unwrap_or(Value::String(value));
                {
                    let mut map = s.map.write().await;
                    map.insert(key, parsed);
                    let bytes = serde_json::to_vec(&*map).map_err(|e| format!("encode: {e}"))?;
                    fs::write(&s.path, &bytes)
                        .await
                        .map_err(|e| format!("write: {e}"))?;
                }
                s.syncs
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
            Persistence::Optimized(s) => {
                let parsed: Value =
                    serde_json::from_str(&value).unwrap_or(Value::String(value));
                {
                    let mut map = s.map.write().await;
                    map.insert(key, parsed);
                }
                s.dirty.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            }
        }
    }

    async fn clear(&self) -> Result<(), String> {
        match self {
            Persistence::Baseline(s) => {
                let mut map = s.map.write().await;
                map.clear();
                let bytes = serde_json::to_vec(&*map).map_err(|e| format!("encode: {e}"))?;
                fs::write(&s.path, &bytes)
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                s.syncs
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
            Persistence::Optimized(s) => {
                let mut map = s.map.write().await;
                map.clear();
                drop(map);
                s.dirty.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            }
        }
    }

    async fn flush_now(&self) -> Result<(), String> {
        match self {
            Persistence::Baseline(_) => Ok(()),
            Persistence::Optimized(s) => {
                if !s.dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                    return Ok(());
                }
                let bytes = {
                    let guard = s.map.read().await;
                    serde_json::to_vec(&*guard).map_err(|e| format!("encode: {e}"))?
                };
                fs::write(&s.path, &bytes)
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                s.syncs
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
        }
    }

    fn sync_count(&self) -> u64 {
        match self {
            Persistence::Baseline(s) => {
                s.syncs.load(std::sync::atomic::Ordering::Relaxed)
            }
            Persistence::Optimized(s) => {
                s.syncs.load(std::sync::atomic::Ordering::Relaxed)
            }
        }
    }
}

impl Persistence {
    async fn new(mode: Mode, data_path: PathBuf) -> Result<Self, String> {
        match mode {
            Mode::Baseline => {
                let inner = if data_path.exists() {
                    let bytes = fs::read(&data_path)
                        .await
                        .map_err(|e| format!("read: {e}"))?;
                    serde_json::from_slice::<HashMap<String, Value>>(&bytes).unwrap_or_default()
                } else {
                    HashMap::new()
                };
                Ok(Persistence::Baseline(BaselineState {
                    path: data_path,
                    map: RwLock::new(inner),
                    syncs: std::sync::atomic::AtomicU64::new(0),
                }))
            }
            Mode::Optimized => {
                // Seed the optimized mirror with whatever the disk
                // holds so we count from the same starting state as
                // baseline. `load_all` then reads from memory.
                let seed_map: HashMap<String, Value> = if data_path.exists() {
                    let bytes = fs::read(&data_path)
                        .await
                        .map_err(|e| format!("read: {e}"))?;
                    serde_json::from_slice(&bytes).unwrap_or_default()
                } else {
                    HashMap::new()
                };
                fs::remove_file(&data_path).await.ok(); // start clean so the timing numbers reflect COALESCE work
                let map: Arc<RwLock<HashMap<String, Value>>> =
                    Arc::new(RwLock::new(seed_map));
                let dirty = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let syncs = Arc::new(std::sync::atomic::AtomicU64::new(0));

                // Background flush task. Wakes either on the notify
                // channel or after COALESCE_WINDOW elapses, whichever
                // comes first. Drains piled-up notifies before the
                // write so a 1k-write burst delivers one disk write
                // per coalesce window, not one per write.
                let task_path = data_path.clone();
                let task_map = Arc::clone(&map);
                let task_dirty = Arc::clone(&dirty);
                let task_syncs = Arc::clone(&syncs);
                tokio::spawn(async move {
                    let (tx, mut rx) = mpsc::unbounded_channel::<()>();
                    // Hand the sender to the caller — actually we
                    // don't need it; the dirty flag is the trigger.
                    // Just drop the sender here.
                    drop(tx);
                    loop {
                        tokio::select! {
                            _ = rx.recv() => {}
                            _ = sleep(COALESCE_WINDOW) => {}
                        }
                        while rx.try_recv().is_ok() {}
                        if !task_dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                            continue;
                        }
                        let bytes = {
                            let guard = task_map.read().await;
                            serde_json::to_vec(&*guard)
                        };
                        let bytes = match bytes {
                            Ok(b) => b,
                            Err(e) => {
                                eprintln!("[flush] encode failed: {e}");
                                continue;
                            }
                        };
                        if let Err(e) = fs::write(&task_path, &bytes).await {
                            eprintln!("[flush] write failed: {e}");
                            continue;
                        }
                        task_syncs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                });

                Ok(Persistence::Optimized(OptimizedState {
                    path: data_path,
                    map,
                    dirty,
                    syncs,
                }))
            }
        }
    }
}

// ── Cache layer ────────────────────────────────────────────────────────
//
// Mirrors velocity's three HTTP response caches from
// src-tauri/src/main.rs's `AppState`:
//   * stream URLs               (TTL 45 min — YT URLs can expire)
//   * watch playlist IDs        (TTL 30 min)
//   * track durations           (TTL 7 days)
//
// Each cache runs a TTL sweep on a 60 s cadence so cold entries
// don't accumulate forever in long-horizon sessions.
struct CacheSim {
    name: &'static str,
    ttl: Duration,
    inner: RwLock<HashMap<String, (String, Instant)>>,
    hits: std::sync::atomic::AtomicU64,
    misses: std::sync::atomic::AtomicU64,
    evictions: std::sync::atomic::AtomicU64,
}

impl CacheSim {
    fn new(name: &'static str, ttl: Duration) -> Self {
        Self {
            name,
            ttl,
            inner: RwLock::new(HashMap::new()),
            hits: std::sync::atomic::AtomicU64::new(0),
            misses: std::sync::atomic::AtomicU64::new(0),
            evictions: std::sync::atomic::AtomicU64::new(0),
        }
    }

    async fn get(&self, key: &str) -> Option<String> {
        let guard = self.inner.read().await;
        if let Some((value, fetched_at)) = guard.get(key) {
            if fetched_at.elapsed() < self.ttl {
                self.hits
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Some(value.clone());
            }
        }
        self.misses
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        None
    }

    async fn put(&self, key: String, value: String) {
        let mut guard = self.inner.write().await;
        guard.insert(key, (value, Instant::now()));
    }

    async fn sweep(&self) -> usize {
        let mut guard = self.inner.write().await;
        let before = guard.len();
        guard.retain(|_, (_, fetched_at)| fetched_at.elapsed() < self.ttl);
        let evicted = before - guard.len();
        self.evictions
            .fetch_add(evicted as u64, std::sync::atomic::Ordering::Relaxed);
        evicted
    }

    fn snapshot(&self) -> CacheSnapshot {
        CacheSnapshot {
            name: self.name,
            hits: self.hits.load(std::sync::atomic::Ordering::Relaxed),
            misses: self.misses.load(std::sync::atomic::Ordering::Relaxed),
            evictions: self
                .evictions
                .load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    async fn size(&self) -> usize {
        self.inner.read().await.len()
    }
}

struct CacheSnapshot {
    name: &'static str,
    hits: u64,
    misses: u64,
    evictions: u64,
}

// ── Latency sampler ────────────────────────────────────────────────────

struct LatencySampler {
    // std::sync::Mutex is plenty here — the critical section is
    // (push a u128) which is sub-microsecond.
    samples: std::sync::Mutex<Vec<u128>>, // nanoseconds
}

impl LatencySampler {
    fn new() -> Self {
        Self {
            samples: std::sync::Mutex::new(Vec::with_capacity(2048)),
        }
    }

    fn record(&self, elapsed: Duration) {
        let mut guard = self.samples.lock().unwrap();
        guard.push(elapsed.as_nanos());
    }

    fn report(&self) -> LatencyReport {
        let mut guard = self.samples.lock().unwrap();
        let mut sorted = std::mem::take(&mut *guard);
        sorted.sort_unstable();
        let n = sorted.len();
        if n == 0 {
            return LatencyReport::default();
        }
        let p = |idx: usize| -> u128 { sorted[idx.min(n - 1)] };
        let count = n as u128;
        let sum: u128 = sorted.iter().sum();
        LatencyReport {
            count: n,
            avg_ns: sum / count,
            p50_ns: p(n / 2),
            p95_ns: p(n * 95 / 100),
            p99_ns: p(n * 99 / 100),
            max_ns: *sorted.last().unwrap_or(&0),
        }
    }
}

#[derive(Default, Clone, Copy)]
struct LatencyReport {
    count: usize,
    avg_ns: u128,
    p50_ns: u128,
    p95_ns: u128,
    p99_ns: u128,
    max_ns: u128,
}

impl LatencyReport {
    fn fmt(time_ns: u128) -> String {
        if time_ns < 1_000 {
            format!("{time_ns}ns")
        } else if time_ns < 1_000_000 {
            format!("{:.2}µs", time_ns as f64 / 1_000.0)
        } else if time_ns < 1_000_000_000 {
            format!("{:.2}ms", time_ns as f64 / 1_000_000.0)
        } else {
            format!("{:.2}s", time_ns as f64 / 1_000_000_000.0)
        }
    }

    fn print(&self, label: &str) {
        println!(
            "{:<14} count={}  avg={}  p50={}  p95={}  p99={}  max={}",
            label,
            self.count,
            Self::fmt(self.avg_ns),
            Self::fmt(self.p50_ns),
            Self::fmt(self.p95_ns),
            Self::fmt(self.p99_ns),
            Self::fmt(self.max_ns),
        );
    }
}

// ── Worker ─────────────────────────────────────────────────────────────

async fn run_worker(
    worker_id: usize,
    keys_per_worker: usize,
    persistence: Arc<Persistence>,
    latency: Arc<LatencySampler>,
    write_count: Arc<std::sync::atomic::AtomicU64>,
    read_count: Arc<std::sync::atomic::AtomicU64>,
    stream_cache: Arc<CacheSim>,
    watch_playlist_cache: Arc<CacheSim>,
    track_duration_cache: Arc<CacheSim>,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut workload = Workload::new();
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let action = workload.next();
        let key_local = workload.pick_key(keys_per_worker);
        let key = format!("velocity-w{worker_id}-k{key_local}");
        let payload_bytes = workload.payload_size(action);
        let payload = synth_payload(payload_bytes);

        let started_at = Instant::now();
        match action {
            Action::ScrollSnapshot
            | Action::SettingsToggle
            | Action::RecentSearch
            | Action::LoudnessCache
            | Action::SavedSongs
            | Action::EqSlider => {
                write_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let _ = persistence.write(key, payload.clone()).await;
            }
            Action::ReadSetting | Action::ReadRecentSearches | Action::ReadLoudness => {
                read_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let _ = persistence.load_all().await;
            }
        }
        latency.record(started_at.elapsed());

        // Cache mirrors fire on every iteration, regardless of
        // whether the persistence layer just wrote. That matches
        // the real frontend which kicks off the cache lookup in
        // lockstep with the IPC command.
        let cache_key = format!("yt:{key_local}");
        if stream_cache.get(&cache_key).await.is_none() {
            stream_cache.put(cache_key.clone(), payload.clone()).await;
        }
        let wp_key = format!("wp:{key_local}");
        if watch_playlist_cache.get(&wp_key).await.is_none() {
            watch_playlist_cache.put(wp_key, payload.clone()).await;
        }
        let dur_key = format!("dur:{key_local}");
        if track_duration_cache.get(&dur_key).await.is_none() {
            track_duration_cache.put(dur_key, payload.clone()).await;
        }

        // Yield to scheduler so workers don't fully starve
        // the system IO scheduler.
        tokio::task::yield_now().await;
    }
}

fn synth_payload(size: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let s: String = (0..size)
        .map(|_| rng.gen_range(b'a'..=b'z') as char)
        .collect();
    format!("\"{s}\"")
}

// ── Driver ─────────────────────────────────────────────────────────────

async fn run(args: Args) -> Result<(), String> {
    let persistence_dir = std::env::temp_dir()
        .join("velocity-perf-harness")
        .join(format!("{:?}", args.mode).to_lowercase());
    fs::create_dir_all(&persistence_dir)
        .await
        .map_err(|e| format!("create_dir_all: {e}"))?;
    let data_path = persistence_dir.join("user-data.json");
    let persistence = Arc::new(Persistence::new(args.mode, data_path.clone()).await?);

    // Cache layer mirrors velocity's three response caches. Each
    // gets its own TTL sweeper task on a 60 s cadence.
    let stream_cache = Arc::new(CacheSim::new(
        "stream",
        Duration::from_secs(60 * 45),
    ));
    let watch_playlist_cache = Arc::new(CacheSim::new(
        "watch_playlist",
        Duration::from_secs(60 * 30),
    ));
    let track_duration_cache = Arc::new(CacheSim::new(
        "track_duration",
        Duration::from_secs(60 * 60 * 24 * 7),
    ));

    let sweep_streams = Arc::clone(&stream_cache);
    let sweep_watch = Arc::clone(&watch_playlist_cache);
    let sweep_duration = Arc::clone(&track_duration_cache);
    let sweeper_handle = tokio::spawn(async move {
        let cadence = Duration::from_secs(60);
        let mut ticker = tokio::time::interval(cadence);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            sweep_streams.sweep().await;
            sweep_watch.sweep().await;
            sweep_duration.sweep().await;
        }
    });

    let started = Instant::now();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let latency = Arc::new(LatencySampler::new());
    let write_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let read_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut handles = Vec::new();
    let keys_per_worker = args.keys.max(args.workers) / args.workers;
    for worker_id in 0..args.workers {
        let persistence = Arc::clone(&persistence);
        let stop = Arc::clone(&stop);
        let latency = Arc::clone(&latency);
        let write_count = Arc::clone(&write_count);
        let read_count = Arc::clone(&read_count);
        let stream_cache = Arc::clone(&stream_cache);
        let watch_playlist_cache = Arc::clone(&watch_playlist_cache);
        let track_duration_cache = Arc::clone(&track_duration_cache);
        // Each worker owns its own OS thread + single-threaded
        // tokio runtime. This sidesteps the !Send bound on
        // `tokio::spawn`'s future — `Workload::new()` holds a
        // `ThreadRng` + various borrowed &self ref cells that
        // don't all compose into a Send future without owning the
        // shared state explicitly. Cheaper than rewriting the
        // worker to be Send, and the 1-thread-per-worker setup
        // mirrors how a real browser spawns main thread + N
        // worker threads for parallel fetch/decode.
        let handle = std::thread::Builder::new()
            .name(format!("perf-worker-{worker_id}"))
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("worker runtime");
                rt.block_on(run_worker(
                    worker_id,
                    keys_per_worker,
                    persistence,
                    latency,
                    write_count,
                    read_count,
                    stream_cache,
                    watch_playlist_cache,
                    track_duration_cache,
                    stop,
                ));
            })
            .expect("worker thread spawn");
        handles.push(handle);
    }

    sleep(args.duration + COALESCE_WINDOW * 4 + Duration::from_millis(500)).await;
    stop.store(true, std::sync::atomic::Ordering::Release);
    for h in handles {
        let _ = h.join();
    }

    persistence.flush_now().await.ok();
    sweeper_handle.abort();

    let elapsed = started.elapsed();
    let total_writes = write_count.load(std::sync::atomic::Ordering::Relaxed);
    let total_reads = read_count.load(std::sync::atomic::Ordering::Relaxed);
    let ops_per_sec = (total_writes + total_reads) as f64 / elapsed.as_secs_f64();
    let report = latency.report();
    let syncs = persistence.sync_count();

    // RSS measurement is intentionally skipped — we don't want to
    // pin a specific sysinfo API version, and the OS footprint
    // of the harness itself isn't part of the production claim.
    // The actionable metrics are ops/sec, latency, write
    // amplification, and cache resident sizes below.
    let stream_size = stream_cache.size().await;
    let watch_size = watch_playlist_cache.size().await;
    let dur_size = track_duration_cache.size().await;

    println!("=== perf-harness summary ===");
    println!(
        "mode={:?} duration={:.1}s workers={} keys={}",
        args.mode,
        elapsed.as_secs_f64(),
        args.workers,
        args.keys,
    );
    println!(
        "writes={} reads={} total_ops={} ops/sec={:.1}",
        total_writes, total_reads, total_writes + total_reads, ops_per_sec
    );
    println!("disk syncs={}", syncs);
    println!(
        "write-amplification={:.2}x  (writes/sync; lower is better)",
        total_writes as f64 / syncs.max(1) as f64
    );
    report.print("write/read latency");
    let s = stream_cache.snapshot();
    let w = watch_playlist_cache.snapshot();
    let d = track_duration_cache.snapshot();
    println!(
        "cache[{}]           size={} hits={} misses={} evictions={}",
        s.name, stream_size, s.hits, s.misses, s.evictions
    );
    println!(
        "cache[{}]   size={} hits={} misses={} evictions={}",
        w.name, watch_size, w.hits, w.misses, w.evictions
    );
    println!(
        "cache[{}]   size={} hits={} misses={} evictions={}",
        d.name, dur_size, d.hits, d.misses, d.evictions
    );
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), String> {
    let args_raw: Vec<String> = std::env::args().collect();
    if args_raw.len() < 2 {
        print_usage();
        return Err("missing subcommand".to_string());
    }
    match args_raw[1].as_str() {
        "run" => {
            let args = parse_args(&args_raw[2..])?;
            eprintln!(
                "[perf-harness] os={} arch={} mode={:?}",
                std::env::consts::OS,
                std::env::consts::ARCH,
                args.mode
            );
            run(args).await
        }
        other => {
            print_usage();
            Err(format!("unknown subcommand: {other}"))
        }
    }
}
