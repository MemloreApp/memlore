//! Process-global sync single-flight guard (`SYNC_IN_PROGRESS`) shared by
//! the Tauri commands and the sync engine. `commands::sync` re-exports it.

use std::sync::atomic::{AtomicBool, Ordering};

/// Prevents two sync cycles from running simultaneously, regardless of who
/// started them. Owned by `run_sync_now` itself, so every entry path —
/// user-initiated `sync_now`, the background scheduler, the window-close
/// final push — participates without needing to remember to flip the flag.
/// `sync_reset_local_state` and `sync_repair_from_this_device` read this flag
/// to queue maintenance work while a sync is in flight (otherwise the engine
/// could re-stamp `synced` on rows the reset just flipped to `pending`).
#[doc(hidden)]
pub static SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[doc(hidden)]
pub fn is_sync_in_progress() -> bool {
    SYNC_IN_PROGRESS.load(Ordering::Acquire)
}

/// RAII guard that flips `SYNC_IN_PROGRESS` to `true` on construction and
/// back to `false` on drop. Using `Drop` (rather than a manual `.store` at
/// every return site) guarantees the flag is released even on panic or
/// early `?`-propagation inside `run_sync_now`.
#[doc(hidden)]
pub struct SyncInProgressGuard;

impl SyncInProgressGuard {
    /// Try to take the sync slot. Returns `None` if another sync is already
    /// running — caller should bail with a clear error.
    #[doc(hidden)]
    pub fn try_acquire() -> Option<Self> {
        if SYNC_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            Some(SyncInProgressGuard)
        } else {
            None
        }
    }

    /// Like [`Self::try_acquire`], but queues behind the current holder
    /// instead of bailing: polls every 250 ms until the slot frees up or
    /// `timeout` elapses (`None`). The holder is usually a sync cycle, but
    /// can be any guard taker (rotation, OAuth connect, cloud wipe, another
    /// queued command). For user actions that should run automatically once
    /// the holder finishes (e.g. `remove_device`) rather than surface a
    /// "sync is running, try again" error. No fairness ordering across
    /// concurrent waiters — fine while call sites stay rare.
    #[doc(hidden)]
    pub async fn acquire_waiting(timeout: std::time::Duration) -> Option<Self> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut logged_wait = false;
        loop {
            if let Some(guard) = Self::try_acquire() {
                if logged_wait {
                    log::info!("acquire_waiting: sync guard freed, proceeding");
                }
                return Some(guard);
            }
            if !logged_wait {
                log::info!("acquire_waiting: sync guard busy — queueing (timeout {timeout:?})");
                logged_wait = true;
            }
            if tokio::time::Instant::now() >= deadline {
                log::warn!("acquire_waiting: gave up after {timeout:?}");
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
}

impl Drop for SyncInProgressGuard {
    fn drop(&mut self) {
        SYNC_IN_PROGRESS.store(false, Ordering::Release);
    }
}

/// Shared serialisation lock for any test that touches `SYNC_IN_PROGRESS`
/// (i.e. acquires or checks `SyncInProgressGuard`). Both `sync.rs` and
/// `crypto.rs` test suites compile into the same test binary; without this
/// lock two guard tests that run concurrently can observe each other's
/// intermediate state and fail intermittently.
///
/// Usage inside a test:
/// ```ignore
/// let _lock = crate::sync::guard::SYNC_GUARD_TEST_LOCK
///     .lock()
///     .unwrap_or_else(|e| e.into_inner());
/// ```
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub static SYNC_GUARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Error string returned by `run_sync_now` (and thus `sync_now`,
/// scheduler, etc.) when another sync is already in flight. Used as a
/// stable marker so callers can distinguish "skip this tick, no harm
/// done" from a real failure that warrants backoff.
pub const SYNC_IN_PROGRESS_ERR: &str = "sync_in_progress";
