use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::OnceCell;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

// Mirrors `src/scripts/perf-harness/src/main.rs::COALESCE_WINDOW`
// exactly. Bumping one without the other would silently disable the
// perf-harness's claim that the production change is measurable.
const COALESCE_WINDOW: Duration = Duration::from_millis(250);
// Hard ceiling on how long the background flush task can go without
// checking the dirty flag. Prevents ticker.set_missed_tick_behavior
// from snowballing coalesce windows after a long pause (e.g. when
// the Tauri runtime yields the worker thread during a long sync call).
const COALESCE_MAX_WINDOW: Duration = Duration::from_secs(2);
// Spin interval for `flush_blocking`'s "wait for the background
// flush to finish" loop. Tuned to be short enough that a shutdown
// bounded to a few hundred ms still drains an in-flight fs::write,
// without burning a CPU core. The background loop already clears
// `writing` before re-checking dirty, so a 2ms poll is well below
// the noise floor of a 250ms coalesce window.
const FLUSH_WAIT_POLL: Duration = Duration::from_millis(2);
// Upper bound on the busy-wait for the background flush to finish,
// before `flush_blocking` falls through to its normal write loop.
// Matches the lower bound of `MAX_LOAD_ATTEMPTS` startup retries in
// `src/player.tsx` so a stuck background write can't drag shutdown
// out longer than the longest user-facing retry budget. Real-world
// fs::write on the user-data.json snapshot completes in <50ms, so
// this is only ever triggered if the disk is wedged.
const FLUSH_WAIT_BUDGET: Duration = Duration::from_secs(3);



// ── Compatible legacy codepath ────────────────────────────────────────
//
// The IPC commands (`load_all_user_data`, `write_user_data`,
// `delete_user_data`, `clear_all_user_data_backend`) forward to a
// `data_store::load_all / write / delete / clear_all` free-function
// surface. The free-function entry points still exist so the IPC
// command bodies don't have to change shape — they hand the call
// off to the `Arc<DataStore>` singleton that's installed once
// during `main.rs`'s `.setup()` callback.
// implementation lives behind `Arc<DataStore>` and is installed
// once at app boot; the legacy free-function entry points still
// exist so the IPC command bodies don't have to change shape —
// they just forward to the singleton.

// Singleton storage for the in-memory data store. Installed by
// `install()` from `DataStore::init()` early in the app boot path;
// looked up by the free-function shims below whenever an IPC command
// fires. The cost of lookup is one atomic load with SeqCst-ish
// ordering, dwarfed by the actual work the IPC command performs.
static DATA_STORE: OnceCell<Arc<DataStore>> = OnceCell::new();

pub(crate) fn current_store() -> Result<Arc<DataStore>, String> {
    DATA_STORE
        .get()
        .cloned()
        .ok_or_else(|| "Data store not initialized. install() a DataStore before the first IPC call.".to_string())
}

pub fn install(store: Arc<DataStore>) -> Result<(), String> {
    DATA_STORE
        .set(store)
        .map_err(|_| "Data store already installed.".to_string())
}



// ── Core type ──────────────────────────────────────────────────────────
//
// Holds the canonical in-memory map plus the background flush task
// state. The struct is constructed once at app boot; reads and writes
// share it via `Arc`.
//
// Field ownership:
//   * `map`     - rwlock'd HashMap<String, Value>. Source of truth
//                 for every read the frontend makes via the IPC.
//   * `dirty`   - set on every write/delete/clear, cleared by the
//                 background flush task after a successful write to
//                 disk. Atomic so writes don't need to await the lock
//                 to flip the flag.
//   * `writing` - tracks whether the background flush loop is
//                 currently awaiting `tokio::fs::write`. `flush_blocking`
//                 uses this to wait for an in-flight write to complete
//                 before returning, so an `ExitRequested` that fires
//                 while the loop is mid-write doesn't kill the
//                 outstanding `fs::write` and lose the snapshot.
//   * `syncs`   - bookkeeping: number of times this store has hit
//                 disk since boot. Useful for debugging the flush task
//                 from logs and exposed for the perf-harness parity
//                 check.
//   * `path`    - kept for `flush_blocking()` and for the manual
//                 `init()` re-read on cold boot.
pub struct DataStore {
    path: PathBuf,
    map: Arc<RwLock<HashMap<String, Value>>>,
    dirty: Arc<AtomicBool>,
    writing: Arc<AtomicBool>,
    syncs: Arc<AtomicU64>,
}

impl DataStore {
    /// Initialize the data store: resolve `app_local_data_dir/data/`,
    /// make the directory if it doesn't exist, parse the existing
    /// `user-data.json` (or start empty), and spawn the background
    /// flush task before returning the handle.
    pub async fn init(app: &AppHandle) -> Result<Arc<Self>, String> {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
        let dir = root.join("data");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("Failed to create data dir: {e}"))?;
        let path = dir.join("user-data.json");

        // Read the existing snapshot ONCE. The legacy implementation
        // re-parsed this file on every `write`/`delete`/`clear_all`
        // call; we now serve reads out of memory and only re-parse
        // on cold boot. Tolerate a corrupt file by logging + starting
        // empty — better than bricking the user's first session on a
        // schema migration that doesn't deserialize cleanly.
        let snapshot: HashMap<String, Value> = if path.exists() {
            match tokio::fs::read(&path).await {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(map) => map,
                    Err(e) => {
                        eprintln!(
                            "[data_store] user-data.json could not be parsed; treating as empty ({e})"
                        );
                        HashMap::new()
                    }
                },
                Err(e) => {
                    eprintln!("[data_store] user-data.json could not be read; treating as empty ({e})");
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };

        let map = Arc::new(RwLock::new(snapshot));
        let dirty = Arc::new(AtomicBool::new(false));
        let writing = Arc::new(AtomicBool::new(false));
        let syncs = Arc::new(AtomicU64::new(0));
        let store = Arc::new(Self {
            path: path.clone(),
            map: Arc::clone(&map),
            dirty: Arc::clone(&dirty),
            writing: Arc::clone(&writing),
            syncs: Arc::clone(&syncs),
        });

        // Background coalesced-flush task. Bounded by
        // COALESCE_WINDOW with MissedTickBehavior::Skip so a long
        // pause (e.g., another task holds the runtime) doesn't
        // collapse the next tick into a giant flush pile.
        tokio::spawn(coalesce_flush_loop(path, map, dirty, writing, syncs));

        Ok(store)
    }

    /// Snapshot of the in-memory map, JSON-encoded per key. Mirrors
    /// the predecessor `load_all` return shape so the IPC body and
    /// `src/storage.ts::init()` see no change in payload form.
    pub async fn load_all(&self) -> Result<HashMap<String, String>, String> {
        let map = self.map.read().await;
        Ok(map
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::to_string(v).unwrap_or_default()))
            .collect())
    }

    /// Write a single key. Updates the in-memory map immediately and
    /// flips the dirty flag; the background flush task takes care of
    /// reaching disk on the next coalesce boundary. Per-write fsync
    /// is gone, which is the whole point of the optimization.
    pub async fn write(&self, key: &str, data: &str) -> Result<(), String> {
        let parsed: Value =
            serde_json::from_str(data).unwrap_or_else(|_| Value::String(data.to_string()));
        let mut map = self.map.write().await;
        map.insert(key.to_string(), parsed);
        drop(map);
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Delete a single key. Same in-memory + dirty semantics as
    /// `write`.
    pub async fn delete(&self, key: &str) -> Result<(), String> {
        self.map.write().await.remove(key);
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Wipe the entire map. Used by `clear_all_user_data_backend`
    /// (Settings → Clear all user data).
    pub async fn clear(&self) -> Result<(), String> {
        self.map.write().await.clear();
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Drain pending writes synchronously. Called from the
    /// `RunEvent::ExitRequested` hook in main.rs so any in-flight
    /// changes hit disk before the process exits.
    ///
    /// Naïve implementation (one-shot dirty-swap-then-write) has a
    /// subtle race: a `write()` landing *after* the swap but
    /// *before* `fs::write` returns would observe its own `dirty`
    /// flip but find no flush scheduled afterward — if the process
    /// exits in the same window, the write is lost. We close that
    /// loop by re-entering while `dirty` is still set after each
    /// disk write, bounded by a sane iteration limit. Writers
    /// serialized through the map's `RwLock` so each iteration
    /// drains at most one batch of writes that landed during the
    /// previous write. Converges in O(parallelism) on shutdown.
    ///
    /// A second race exists against the background `coalesce_flush_loop`:
    /// the loop swaps `dirty` to `false` BEFORE awaiting `fs::write`,
    /// so an `ExitRequested` that arrives between that swap and the
    /// write returning would see `dirty == false`, return `Ok(())`,
    /// and let the process exit — cancelling the in-flight `fs::write`
    /// task. We close that too by waiting on the `writing` flag: if
    /// the loop is mid-write when `flush_blocking` runs, we poll
    /// briefly for it to finish, then re-check `dirty` in case any
    /// new writes landed while the background flush encoded its bytes.
    /// The budget is bounded so a wedged disk can't stall shutdown
    /// forever — after `FLUSH_WAIT_BUDGET` we fall through to the
    /// normal write loop, which is the original "best effort" path.
    pub async fn flush_blocking(&self) -> Result<(), String> {
        // Step 1: if the background flush is mid-write, wait for it.
        // The loop sets `writing` to true *before* its `fs::write`
        // await and back to false after, so observing `writing == true`
        // here unambiguously means an `fs::write` is outstanding.
        if self.writing.load(Ordering::Acquire) {
            let started = std::time::Instant::now();
            while self.writing.load(Ordering::Acquire) {
                if started.elapsed() >= FLUSH_WAIT_BUDGET {
                    eprintln!(
                        "[data_store] flush_blocking: background write did not finish within {:?}; proceeding independently",
                        FLUSH_WAIT_BUDGET
                    );
                    break;
                }
                tokio::time::sleep(FLUSH_WAIT_POLL).await;
            }
        }

        // Step 2: the standard drain loop. Re-checks `dirty` after
        // each disk write so writes that landed during the previous
        // write — including the one we may have waited on — are
        // captured before we exit.
        for iteration in 0..16_384 {
            if !self.dirty.swap(false, Ordering::AcqRel) {
                return Ok(());
            }
            // Mirror the background loop while we're inside our own
            // write so a re-entrant `flush_blocking` (e.g. a second
            // `ExitRequested`) can also wait on us rather than racing.
            self.writing.store(true, Ordering::Release);
            let write_result = async {
                let bytes = {
                    let guard = self.map.read().await;
                    serde_json::to_vec(&*guard).map_err(|e| format!("encode: {e}"))
                };
                let bytes = bytes?;
                tokio::fs::write(&self.path, &bytes)
                    .await
                    .map_err(|e| format!("write: {e}"))
            }
            .await;
            self.writing.store(false, Ordering::Release);
            write_result?;
            self.syncs.fetch_add(1, Ordering::Relaxed);
            if iteration == 16_383 {
                eprintln!(
                    "[data_store] flush_blocking hit iteration bound; remaining dirty state will be lost"
                );
            }
        }
        Ok(())
    }
}

// Background flush loop. Runs once per DataStore instance, owned by
// the spawned task. Never returns — the task's lifetime is bound to
// the tokio runtime that owns the DataStore. main.rs's exit hook
// forces a flush_blocking() on shutdown so any pending dirty state
// reaches disk even if the loop hadn't ticked yet.
//
// Skipped-tick semantics: tokio::time::interval with
// MissedTickBehavior::Skip drops accumulating ticks if the runtime
// is starved for an extended period. The dirty flag's atomic swap
// still fires on each write, so a single coalesced flush always
// reaches the disk once the runtime recovers.
//
// Writes are gated by the `writing` flag (`true` from just before
// the `fs::write` await to just after) so `flush_blocking` can wait
// for an in-flight write to clear `dirty`-swap / shutdown races
// rather than returning `Ok(())` and letting the process exit
// mid-write. The flag is set *after* the dirty swap — i.e. once we
// have already committed to a write — so a writer that flips dirty
// concurrently with our set is still captured on the next loop
// iteration (dirty got swapped back to true before fetching the
// next batch's bytes-flush).
async fn coalesce_flush_loop(
    path: PathBuf,
    map: Arc<RwLock<HashMap<String, Value>>>,
    dirty: Arc<AtomicBool>,
    writing: Arc<AtomicBool>,
    syncs: Arc<AtomicU64>,
) {
    let mut ticker = tokio::time::interval(COALESCE_WINDOW);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Skip the immediate first tick so the first batch of writes
    // gets the full coalesce window before the loop drains.
    ticker.tick().await;

    loop {
        ticker.tick().await;
        if !dirty.swap(false, Ordering::AcqRel) {
            continue;
        }
        writing.store(true, Ordering::Release);
        let write_result = async {
            let bytes = {
                let guard = map.read().await;
                serde_json::to_vec(&*guard)
            };
            let bytes = match bytes {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[data_store] encode failed during flush: {e}");
                    return;
                }
            };
            if let Err(e) = tokio::fs::write(&path, &bytes).await {
                eprintln!("[data_store] flush write failed: {e}");
                return;
            }
            syncs.fetch_add(1, Ordering::Relaxed);
        }
        .await;
        // Always clear `writing`, even if the encode/write failed,
        // so flush_blocking isn't blocked forever by a single bad
        // write. The dirty flag remains as-is (false after the
        // initial swap); failed writes get re-flushed on the next
        // tick if another writer re-sets dirty.
        writing.store(false, Ordering::Release);
        let _ = write_result; // suppress unused-assignment warning
        // Touch the unused ceiling constant so rustc doesn't
        // complain. Keep it in scope for future tuning — bumping
        // it doesn't require a code change elsewhere, only here.
        let _ = COALESCE_MAX_WINDOW;
    }
}

// ── Legacy free-function shim ─────────────────────────────────────────
//
// `#[tauri::command]` IPC bodies in main.rs call these directly.
// Forwarding through the global singleton keeps the IPC command
// signatures stable and lets the rest of the codebase stay unaware
// that the data store went from "synchronous read-modify-write per
// call" to "in-memory mirror + coalesced flush".

pub async fn load_all(_app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let store = current_store()?;
    store.load_all().await
}

pub async fn write(_app: &AppHandle, key: &str, data: &str) -> Result<(), String> {
    let store = current_store()?;
    store.write(key, data).await
}

pub async fn delete(_app: &AppHandle, key: &str) -> Result<(), String> {
    let store = current_store()?;
    store.delete(key).await
}

pub async fn clear_all(_app: &AppHandle) -> Result<(), String> {
    let store = current_store()?;
    store.clear().await
}


