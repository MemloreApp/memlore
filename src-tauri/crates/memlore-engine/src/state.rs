//! `AppState`: the shared SQLite connection handle (moved from the desktop
//! `lib.rs` in the mobile-app plan, phase 10).

use std::sync::Mutex;

/// Shared application state — a single SQLite connection protected by a Mutex.
///
/// Internally holds the connection as `Arc<Mutex<Connection>>` so the same
/// handle can be shared with subsystems that need a write path (e.g. the
/// `SqliteAuditSink` in S2-1). The public API is unchanged.
pub struct AppState(std::sync::Arc<Mutex<rusqlite::Connection>>);

impl AppState {
    pub fn new(conn: rusqlite::Connection) -> Self {
        Self(std::sync::Arc::new(Mutex::new(conn)))
    }

    /// Clone the inner `Arc<Mutex<Connection>>` so other subsystems can share
    /// the same connection handle. Callers must observe the same locking
    /// discipline as `AppState::lock()` (no cross-lock-boundary awaits).
    pub fn db_handle(&self) -> std::sync::Arc<Mutex<rusqlite::Connection>> {
        std::sync::Arc::clone(&self.0)
    }

    /// Acquire the database connection lock.
    ///
    /// Returns a `String` error (compatible with Tauri command
    /// `Result<T, String>`). If the mutex is poisoned (a previous panic held
    /// the lock), we recover by taking the inner guard anyway — the SQLite
    /// connection itself remains safe to use, and the alternative (bubbling
    /// "poison error" forever) would make the app completely unresponsive
    /// after a single panic anywhere in the command pipeline.
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
        match self.0.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                log::warn!(
                    "AppState mutex was poisoned; recovering the inner guard. \
                     Investigate the panic that caused this."
                );
                Ok(poisoned.into_inner())
            }
        }
    }

    /// Run a closure with the connection lock, automatically releasing the
    /// guard afterwards.
    ///
    /// **Why this exists:** the sync engine (Chunk 3c) awaits filesystem
    /// I/O between DB calls. If the engine held a `MutexGuard` across
    /// `.await`, every other Tauri command (auto-save, search, list
    /// entries, …) would block for the entire sync duration — minutes on
    /// a slow Dropbox folder. `with_conn` lets the engine acquire the
    /// lock only for the short synchronous DB call, release it, then
    /// await I/O, then re-acquire for the next DB call.
    pub fn with_conn<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<R, String>,
    {
        let guard = self.lock()?;
        f(&guard)
    }

    /// Replace the inner connection.
    ///
    /// Called on unlock to swap the startup placeholder (`:memory:`) for the
    /// real SQLCipher-keyed on-disk connection. The old connection is dropped
    /// (and closed) atomically under the mutex.
    pub fn set_connection(&self, new_conn: rusqlite::Connection) -> Result<(), String> {
        let mut guard = self.lock()?;
        *guard = new_conn;
        Ok(())
    }
}
