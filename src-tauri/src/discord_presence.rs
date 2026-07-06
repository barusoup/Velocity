//! Discord Rich Presence for Velocity's playback status.
//!
//! Brand intent (the wording this file aims for): "Listening on Velocity".
//!
//! What Discord actually renders on the user's status line:
//! "Listening to Velocity". Discord's UI hardcodes a "Listening to {name}"
//! prefix on `ActivityType::Listening`, and the "to" preposition cannot be
//! customized via the standard Rich Presence API — it is a constraint of
//! Discord's UI for listening activities. `{name}` resolves to the registered
//! application on https://discord.com/developers/applications, so we deliberately
//! omit the `.name()` override here and rely on the dev portal setting instead.
//!
//! Requires a Discord application registered at https://discord.com/developers/applications
//! with a Rich Presence asset key `velocity` as fallback when no album art is available.
//!
//! All Discord IPC runs on a dedicated background thread so `connect()` handshakes
//! never block the Tauri main thread (startup, settings toggles, playback updates).

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::sync::mpsc::{Receiver, Sender, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::AppHandle;

/// Velocity Discord application ID (Developer Portal → Application → General Information).
const DISCORD_APPLICATION_ID: &str = "1522349470354903251";

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));
const IPC_ACK_TIMEOUT: Duration = Duration::from_secs(8);

struct PresenceManager {
    client: Option<DiscordIpcClient>,
    /// Whether the last successful update included a start/end pair.
    timestamps_active: bool,
    /// Drops out-of-order async invokes (stale playing after pause).
    last_generation: u64,
}

impl PresenceManager {
    fn ensure_connected(&mut self) -> bool {
        if self.client.is_some() {
            return true;
        }
        for attempt in 0..14 {
            if attempt > 0 {
                let delay_ms = 100_u64 * (1_u64 << attempt.min(5));
                thread::sleep(Duration::from_millis(delay_ms));
            }
            let mut client = DiscordIpcClient::new(DISCORD_APPLICATION_ID);
            if client.connect().is_ok() {
                let _ = client.clear_activity();
                self.client = Some(client);
                return true;
            }
        }
        false
    }

    fn clear(&mut self) {
        if let Some(client) = &mut self.client {
            let _ = client.clear_activity();
        }
        self.timestamps_active = false;
    }

    fn disconnect(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
        self.timestamps_active = false;
    }

    fn drain_ipc_response(client: &mut DiscordIpcClient) {
        let _ = client.recv();
    }

    fn clear_discord_activity(client: &mut DiscordIpcClient) -> Result<(), String> {
        client
            .clear_activity()
            .map_err(|e| e.to_string())?;
        Self::drain_ipc_response(client);
        Ok(())
    }

    fn should_apply(&self, generation: Option<u64>) -> bool {
        let Some(gen) = generation else {
            return true;
        };
        gen >= self.last_generation
    }

    fn mark_applied(&mut self, generation: Option<u64>) {
        if let Some(gen) = generation {
            if gen >= self.last_generation {
                self.last_generation = gen;
            }
        }
    }

    fn is_superseded_by_queue(
        generation: Option<u64>,
        latest_queued_generation: u64,
    ) -> bool {
        generation.is_some_and(|gen| gen < latest_queued_generation)
    }

    fn set_activity(
        &mut self,
        state: &str,
        details: &str,
        large_image: &str,
        paused: bool,
        started_at: Option<i64>,
        ends_at: Option<i64>,
    ) -> Result<(), String> {
        let client = match self.client.as_mut() {
            Some(client) => client,
            None => return Err("Discord IPC client is not connected".to_string()),
        };

        // Paused and buffering: never publish any timestamp fields. Wipe Discord's
        // merged state and wait for the clear to land before republishing metadata.
        if paused {
            Self::clear_discord_activity(client)?;
            self.timestamps_active = false;

            let assets = activity::Assets::new().large_image(large_image);
            let mut act = activity::Activity::new()
                .activity_type(activity::ActivityType::Listening)
                .details(details)
                .assets(assets);

            if !state.is_empty() {
                act = act.state(state);
            }

            client.set_activity(act).map_err(|e| e.to_string())?;
            self.timestamps_active = false;
            return Ok(());
        }

        let want_timestamps =
            matches!((started_at, ends_at), (Some(start), Some(end)) if end > start);

        // Discord merges SET_ACTIVITY field-by-field. Partial updates cannot
        // remove an existing progress bar — clear first when dropping timestamps.
        if !want_timestamps && self.timestamps_active {
            Self::clear_discord_activity(client)?;
            self.timestamps_active = false;
        }

        let assets = activity::Assets::new().large_image(large_image);

        let mut act = activity::Activity::new()
            .activity_type(activity::ActivityType::Listening)
            .details(details)
            .assets(assets);

        if !state.is_empty() {
            act = act.state(state);
        }

        if want_timestamps {
            let (Some(start), Some(end)) = (started_at, ends_at) else {
                return Ok(());
            };
            act = act.timestamps(activity::Timestamps::new().start(start).end(end));
        }

        client.set_activity(act).map_err(|e| e.to_string())?;
        self.timestamps_active = want_timestamps;
        Ok(())
    }
}

enum PresenceOp {
    Update(DiscordPresenceUpdate, Option<Sender<bool>>),
    /// Disconnect and clear activity; worker keeps running.
    Clear(Sender<()>),
    /// App exit — disconnect, drain, and stop the worker.
    Shutdown(Sender<()>),
}

struct CoalescedBatch {
    shutdown: Option<Sender<()>>,
    clear: Option<Sender<()>>,
    update: Option<(DiscordPresenceUpdate, Option<Sender<bool>>)>,
    dropped_update_acks: Vec<Sender<bool>>,
}

struct DiscordWorker {
    tx: SyncSender<PresenceOp>,
    join: Option<JoinHandle<()>>,
}

impl DiscordWorker {
    fn spawn() -> Self {
        let (tx, rx) = mpsc::sync_channel(64);
        let join = thread::Builder::new()
            .name("discord-presence".into())
            .spawn(move || run_worker(rx))
            .expect("discord presence worker thread");

        Self {
            tx,
            join: Some(join),
        }
    }
}

impl Drop for DiscordWorker {
    fn drop(&mut self) {
        let _ = wait_for_shutdown(&self.tx);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

static WORKER: Lazy<DiscordWorker> = Lazy::new(DiscordWorker::spawn);

fn wait_for_clear(tx: &SyncSender<PresenceOp>) -> bool {
    let (ack_tx, ack_rx) = mpsc::channel();
    if tx.send(PresenceOp::Clear(ack_tx)).is_err() {
        return false;
    }
    ack_rx.recv_timeout(Duration::from_secs(2)).is_ok()
}

fn wait_for_shutdown(tx: &SyncSender<PresenceOp>) -> bool {
    let (ack_tx, ack_rx) = mpsc::channel();
    if tx.send(PresenceOp::Shutdown(ack_tx)).is_err() {
        return false;
    }
    ack_rx.recv_timeout(Duration::from_secs(2)).is_ok()
}

/// Drain every immediately-available op and return the batch to execute.
/// Later playback updates replace earlier ones; clear/shutdown always win.
fn coalesce_ops(rx: &Receiver<PresenceOp>, first: PresenceOp) -> CoalescedBatch {
    let mut batch = CoalescedBatch {
        shutdown: None,
        clear: None,
        update: None,
        dropped_update_acks: Vec::new(),
    };

    let mut ingest = |op: PresenceOp| {
        match op {
            PresenceOp::Shutdown(ack) => batch.shutdown = Some(ack),
            PresenceOp::Clear(ack) => batch.clear = Some(ack),
            PresenceOp::Update(payload, ack) => {
                if let Some((prior_payload, prior_ack)) = batch.update.take() {
                    let keep_new = payload.generation.unwrap_or(0) >= prior_payload.generation.unwrap_or(0);
                    if keep_new {
                        if let Some(prior_ack) = prior_ack {
                            batch.dropped_update_acks.push(prior_ack);
                        }
                        batch.update = Some((payload, ack));
                    } else {
                        if let Some(ack) = ack {
                            batch.dropped_update_acks.push(ack);
                        }
                        batch.update = Some((prior_payload, prior_ack));
                    }
                } else {
                    batch.update = Some((payload, ack));
                }
            }
        }
    };

    ingest(first);
    while let Ok(op) = rx.try_recv() {
        ingest(op);
    }

    batch
}

fn ack_dropped_updates(batch: &CoalescedBatch) {
    for ack in &batch.dropped_update_acks {
        // Superseded by a newer update in the same batch — not an IPC failure.
        let _ = ack.send(true);
    }
}

fn note_queued_generation(payload: &DiscordPresenceUpdate, latest: &mut u64) {
    if let Some(gen) = payload.generation {
        *latest = (*latest).max(gen);
    }
}

fn merge_follow_up_update(
    current: Option<(DiscordPresenceUpdate, Option<Sender<bool>>)>,
    incoming: DiscordPresenceUpdate,
    incoming_ack: Option<Sender<bool>>,
) -> (DiscordPresenceUpdate, Option<Sender<bool>>) {
    match current {
        None => (incoming, incoming_ack),
        Some((prior_payload, prior_ack)) => {
            let keep_new = incoming
                .generation
                .unwrap_or(0)
                >= prior_payload.generation.unwrap_or(0);
            if keep_new {
                if let Some(prior_ack) = prior_ack {
                    let _ = prior_ack.send(true);
                }
                (incoming, incoming_ack)
            } else {
                if let Some(incoming_ack) = incoming_ack {
                    let _ = incoming_ack.send(true);
                }
                (prior_payload, prior_ack)
            }
        }
    }
}

fn run_worker(rx: Receiver<PresenceOp>) {
    let mut manager = PresenceManager {
        client: None,
        timestamps_active: false,
        last_generation: 0,
    };
    let mut latest_queued_generation: u64 = 0;

    'worker: while let Ok(mut op) = rx.recv() {
        loop {
            let batch = coalesce_ops(&rx, op);
            ack_dropped_updates(&batch);

            if let Some(ack) = batch.shutdown {
                manager.disconnect();
                while rx.try_recv().is_ok() {}
                let _ = ack.send(());
                break 'worker;
            }

            if let Some(ack) = batch.clear {
                manager.disconnect();
                let _ = ack.send(());
                break;
            }

            let Some((mut payload, ack)) = batch.update else {
                break;
            };

            note_queued_generation(&payload, &mut latest_queued_generation);

            let applied = apply_update(&mut manager, &mut payload, latest_queued_generation);

            let mut follow_up: Option<PresenceOp> = None;
            let mut stop_after_control = false;
            while let Ok(pending) = rx.try_recv() {
                match pending {
                    PresenceOp::Shutdown(shutdown_ack) => {
                        if let Some(ref update_ack) = ack {
                            let _ = update_ack.send(applied && follow_up.is_none());
                        }
                        manager.disconnect();
                        while rx.try_recv().is_ok() {}
                        let _ = shutdown_ack.send(());
                        break 'worker;
                    }
                    PresenceOp::Clear(clear_ack) => {
                        if let Some(ref update_ack) = ack {
                            let _ = update_ack.send(applied && follow_up.is_none());
                        }
                        manager.disconnect();
                        let _ = clear_ack.send(());
                        stop_after_control = true;
                        break;
                    }
                    PresenceOp::Update(newer, newer_ack) => {
                        note_queued_generation(&newer, &mut latest_queued_generation);
                        let merged = merge_follow_up_update(
                            follow_up.take().and_then(|next| match next {
                                PresenceOp::Update(payload, ack) => Some((payload, ack)),
                                _ => None,
                            }),
                            newer,
                            newer_ack,
                        );
                        follow_up = Some(PresenceOp::Update(merged.0, merged.1));
                    }
                }
            }

            if stop_after_control {
                break;
            }

            if let Some(update_ack) = ack {
                let superseded = follow_up.is_some();
                let _ = update_ack.send(if superseded { true } else { applied });
            }

            if let Some(next) = follow_up {
                op = next;
                continue;
            }
            break;
        }
    }
}

fn apply_update(
    manager: &mut PresenceManager,
    payload: &mut DiscordPresenceUpdate,
    latest_queued_generation: u64,
) -> bool {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return false;
    }

    if !payload.enabled {
        manager.disconnect();
        manager.last_generation = 0;
        return true;
    }

    if !manager.should_apply(payload.generation) {
        return true;
    }

    if PresenceManager::is_superseded_by_queue(payload.generation, latest_queued_generation) {
        return true;
    }

    if payload.paused {
        payload.started_at = None;
        payload.ends_at = None;
    }

    let Some(title) = payload.title.clone().filter(|s| !s.is_empty()) else {
        manager.clear();
        manager.mark_applied(payload.generation);
        return true;
    };

    if let Some(cover_ref) = payload.cover_url.clone() {
        if let Some(app) = APP_HANDLE
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
        {
            if let Some(published) =
                crate::discord_cover_publish::publish_local_cover_for_discord(&app, &cover_ref)
            {
                payload.cover_url = Some(published);
            }
        }
    }

    if PresenceManager::is_superseded_by_queue(payload.generation, latest_queued_generation) {
        return true;
    }

    if !manager.ensure_connected() {
        return false;
    }

    let state = payload
        .state
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format_listening_state(&payload.artist, &payload.album));
    let details = truncate(&title, 128);
    let cover_url = resolve_cover_url(payload.cover_url.as_deref(), payload.video_id.as_deref());
    let large_image = cover_url.as_deref().unwrap_or("velocity");

    let applied = manager
        .set_activity(
            &state,
            &details,
            large_image,
            payload.paused,
            payload.started_at,
            payload.ends_at,
        )
        .is_ok();
    if applied {
        manager.mark_applied(payload.generation);
    }
    applied
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPresenceUpdate {
    pub enabled: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub video_id: Option<String>,
    pub state: Option<String>,
    /// Playback paused or buffering — omit timestamps; clear any active bar once.
    #[serde(default)]
    pub paused: bool,
    /// Unix milliseconds when playback effectively started (now − elapsed).
    pub started_at: Option<i64>,
    /// Unix milliseconds when the track ends (started_at + duration).
    pub ends_at: Option<i64>,
    /// Monotonic sync id from the frontend; stale invokes are ignored.
    #[serde(default)]
    pub generation: Option<u64>,
}

fn wait_for_update(tx: &SyncSender<PresenceOp>, payload: DiscordPresenceUpdate) -> bool {
    let (ack_tx, ack_rx) = mpsc::channel();
    if tx
        .send(PresenceOp::Update(payload, Some(ack_tx)))
        .is_err()
    {
        return false;
    }
    ack_rx.recv_timeout(IPC_ACK_TIMEOUT).unwrap_or(false)
}

#[tauri::command]
pub fn sync_discord_presence(
    app: tauri::AppHandle,
    payload: DiscordPresenceUpdate,
) -> Result<bool, String> {
    if let Ok(mut guard) = APP_HANDLE.lock() {
        *guard = Some(app);
    }

    if !payload.enabled {
        let _ = wait_for_clear(&WORKER.tx);
        return Ok(true);
    }
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(false);
    }

    Ok(wait_for_update(&WORKER.tx, payload))
}

pub fn shutdown_discord_presence() {
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = wait_for_shutdown(&WORKER.tx);
}

fn format_listening_state(artist: &Option<String>, album: &Option<String>) -> String {
    let artist = artist.as_deref().filter(|s| !s.is_empty());
    let album = album.as_deref().filter(|s| !s.is_empty());
    match (artist, album) {
        (Some(a), Some(al)) => truncate(&format!("{a} · {al}"), 128),
        (Some(a), None) => truncate(a, 128),
        (None, Some(al)) => truncate(al, 128),
        _ => String::new(),
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars.saturating_sub(1)).collect::<String>() + "…"
}

fn resolve_cover_url(cover_url: Option<&str>, video_id: Option<&str>) -> Option<String> {
    if let Some(url) = cover_url.and_then(normalize_cover_url) {
        return Some(square_google_cover_url(&url));
    }

    video_id
        .filter(|id| !id.is_empty())
        .map(|id| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))
}

/// Request a square crop from googleusercontent album-art URLs.
fn square_google_cover_url(url: &str) -> String {
    const COVER_SIZE: u32 = 512;

    if !url.contains("googleusercontent.com") {
        return url.to_string();
    }

    let Some((prefix, suffix)) = url.rsplit_once('=') else {
        return url.to_string();
    };

    if !suffix.starts_with('w') {
        return url.to_string();
    }

    format!("{prefix}=w{COVER_SIZE}-h{COVER_SIZE}-p-l90-rj")
}

fn normalize_cover_url(url: &str) -> Option<String> {
    if url.starts_with("asset://")
        || url.contains("asset.localhost")
        || url.starts_with("blob:")
        || url.starts_with("data:")
    {
        return None;
    }

    let normalized = if url.starts_with("//") {
        format!("https:{url}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("https://{rest}")
    } else if url.starts_with("https://") {
        url.to_string()
    } else {
        return None;
    };

    Some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_square_track_cover_over_ytimg_fallback() {
        assert_eq!(
            resolve_cover_url(
                Some("https://lh3.googleusercontent.com/example=w544-h544-l90-rj"),
                Some("abc123"),
            ),
            Some("https://lh3.googleusercontent.com/example=w512-h512-p-l90-rj".to_string()),
        );
    }

    #[test]
    fn falls_back_to_ytimg_when_cover_missing() {
        assert_eq!(
            resolve_cover_url(None, Some("abc123")),
            Some("https://i.ytimg.com/vi/abc123/hqdefault.jpg".to_string()),
        );
    }

    #[test]
    fn listening_state_joins_artist_and_album() {
        assert_eq!(
            format_listening_state(
                &Some("Artist".to_string()),
                &Some("Album".to_string()),
            ),
            "Artist · Album",
        );
    }

    #[test]
    fn normalizes_protocol_relative_cover_urls() {
        assert_eq!(
            normalize_cover_url("//i.ytimg.com/vi/abc/hqdefault.jpg"),
            Some("https://i.ytimg.com/vi/abc/hqdefault.jpg".to_string()),
        );
    }

    #[test]
    fn omits_timestamps_when_not_provided() {
        let act = activity::Activity::new().details("Song");
        let json = serde_json::to_value(&act).expect("activity json");
        assert!(json.get("timestamps").is_none());
    }

    #[test]
    fn rejects_local_asset_urls() {
        assert_eq!(normalize_cover_url("https://asset.localhost/cover.jpg"), None);
    }

    #[test]
    fn coalesce_keeps_latest_update() {
        let (tx, rx) = mpsc::sync_channel(8);
        tx.send(PresenceOp::Update(
            DiscordPresenceUpdate {
                enabled: true,
                title: Some("Song".to_string()),
                artist: None,
                album: None,
                cover_url: None,
                video_id: None,
                state: None,
                paused: false,
                started_at: None,
                ends_at: None,
                generation: None,
            },
            None,
        ))
        .expect("update send");

        let first = rx.recv().expect("first op");
        let batch = coalesce_ops(&rx, first);
        assert!(batch.update.is_some());
        assert_eq!(
            batch.update.as_ref().and_then(|(payload, _)| payload.title.as_deref()),
            Some("Song"),
        );
    }

    #[test]
    fn coalesce_superseded_update_acks_are_dropped() {
        let (tx, rx) = mpsc::sync_channel(8);
        let (ack_a_tx, ack_a_rx) = mpsc::channel();
        let (ack_b_tx, ack_b_rx) = mpsc::channel();

        tx.send(PresenceOp::Update(
            DiscordPresenceUpdate {
                enabled: true,
                title: Some("First".to_string()),
                artist: None,
                album: None,
                cover_url: None,
                video_id: None,
                state: None,
                paused: false,
                started_at: None,
                ends_at: None,
                generation: Some(1),
            },
            Some(ack_a_tx),
        ))
        .expect("first update send");
        tx.send(PresenceOp::Update(
            DiscordPresenceUpdate {
                enabled: true,
                title: Some("Second".to_string()),
                artist: None,
                album: None,
                cover_url: None,
                video_id: None,
                state: None,
                paused: false,
                started_at: None,
                ends_at: None,
                generation: Some(2),
            },
            Some(ack_b_tx),
        ))
        .expect("second update send");

        let first = rx.recv().expect("first op");
        let batch = coalesce_ops(&rx, first);
        ack_dropped_updates(&batch);
        assert_eq!(ack_a_rx.recv_timeout(Duration::from_millis(50)), Ok(true));
        assert!(ack_b_rx.recv_timeout(Duration::from_millis(50)).is_err());
    }
}