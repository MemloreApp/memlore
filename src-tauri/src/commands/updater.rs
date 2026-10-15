//! In-app updater: ask the updater plugin whether a newer build exists on
//! `/releases/latest`, and install it on demand.
//!
//! There is one channel. Every desktop release is a stable `v*` release;
//! prereleases and the beta channel are gone (builds up to v0.2.5 still carry
//! a beta setting, which resolves through the GitHub API instead).
//!
//! Installing and relaunching are **two** commands. `install_update` swaps the
//! bundle on disk and returns, so the download runs in the background while the
//! user keeps working; the relaunch happens only when the user asks for it via
//! `restart_app`. An update that quits the app out from under an open editor is
//! worse than an update applied on the next ordinary launch.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The plugin's `.check()` has no timeout of its own, and it runs on the
/// startup path: a hung endpoint would strand the user in a "checking…" modal.
/// The download is deliberately left unbounded — `Update` is built with
/// `timeout: None` regardless of the builder, and a reqwest timeout covers the
/// *whole* request, so any cap would abort a large install on a slow link.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// GitHub's `/releases/latest` redirect never serves a prerelease, and never a
/// `web-v*` release: those are always created with `make_latest: false`, so it
/// stays on the desktop release.
const UPDATE_ENDPOINT: &str =
    "https://github.com/MemloreApp/memlore/releases/latest/download/latest.json";

/// What the frontend gets back. A plain serde struct so `src/` never imports
/// the updater plugin's JS API (the Vite `tauriAliasGuard` would reject it).
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// The `Update` handle returned by the last successful `check_for_update`.
///
/// `install_update` cannot re-run the check itself without a second network
/// round-trip; stashing the handle also guarantees the user installs exactly
/// the build they were shown.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Take the stashed `Update` handle out of managed state, or replace it.
/// Both commands go through here so poisoning is handled the same way.
fn pending<R: Runtime>(app: &AppHandle<R>) -> State<'_, PendingUpdate> {
    app.state::<PendingUpdate>()
}

/// Forget the stashed handle. Called before anything fallible in a check so a
/// failed check can never leave an older build installable.
fn clear_pending<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    *pending(app).0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// `time::OffsetDateTime`'s `Display` is not `Date`-parseable in JS; hand the
/// frontend RFC 3339 instead, via the `chrono` already in the tree.
fn rfc3339_from_unix(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0).map(|dt| dt.to_rfc3339())
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(app: AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    // First thing, before any `?`: the handle we may be about to replace must
    // not outlive this call if it fails half way.
    clear_pending(&app)?;

    // Dev builds never reach the network: `pnpm tauri dev` runs against a
    // version that is not on GitHub, and the check would be noise at best.
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let url = url::Url::parse(UPDATE_ENDPOINT).map_err(|e| e.to_string())?;

    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let Some(update) = update else {
        return Ok(None);
    };

    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        pub_date: update
            .date
            .and_then(|d| rfc3339_from_unix(d.unix_timestamp())),
    };
    *pending(&app).0.lock().map_err(|e| e.to_string())? = Some(update);
    Ok(Some(info))
}

/// Download and install the build the last `check_for_update` found, then
/// return. **It does not relaunch** — on macOS `download_and_install` swaps the
/// bundle without touching the running process, so the user stays in their
/// session and the new version takes effect on the next launch (either
/// `restart_app`, or an ordinary quit-and-reopen).
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Take the handle out and drop the guard before awaiting — a std
    // `MutexGuard` is not `Send` and cannot be held across `.await`.
    let update = {
        let state = pending(&app);
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        slot.take()
            .ok_or_else(|| "no pending update — run check_for_update first".to_string())?
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Relaunch into the freshly installed build. The only exit point of an
/// update, and always user-initiated (the "Restart" button on the
/// update-ready card) — never called by `install_update`.
///
/// `AppHandle::restart` is `-> !`: it does not return, so the `Ok` is
/// unreachable and exists only to keep the command's signature uniform with
/// every other one.
#[tauri::command]
pub fn restart_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.restart()
}

/// The running build's version, straight from `tauri.conf.json` via the
/// embedded package info. Shown on the About page so a bug report can name
/// the exact build. `Result` for consistency with every other command.
#[tauri::command]
pub fn app_version<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_timeout_is_bounded() {
        // The plugin's `.check()` has no timeout of its own; without this the
        // user sits in an undismissable "checking…" modal forever.
        assert!(
            CHECK_TIMEOUT.as_secs() > 0 && CHECK_TIMEOUT.as_secs() <= 60,
            "got {CHECK_TIMEOUT:?}"
        );
    }

    /// The install command refuses to run without a handle from a successful
    /// check — this is what makes a double-install an error instead of
    /// installing the wrong build.
    #[tokio::test]
    async fn install_update_without_a_pending_handle_errors() {
        let app = crate::test_support::mock_app::mock_app();
        let err = install_update(app.handle().clone())
            .await
            .expect_err("empty slot must error");
        assert!(err.contains("no pending update"), "got {err}");
    }

    /// `check_for_update` runs this before its first `?`, so a failed check can
    /// never leave an older build installable.
    /// (A stale `Some(Update)` cannot be seeded here: the plugin's `Update` has
    /// private fields, so the ordering itself is enforced by construction.)
    #[tokio::test]
    async fn clearing_the_pending_slot_leaves_nothing_installable() {
        let app = crate::test_support::mock_app::mock_app();
        clear_pending(app.handle()).expect("clear_pending");
        assert!(pending(app.handle()).0.lock().unwrap().is_none());

        check_for_update(app.handle().clone())
            .await
            .expect("dev-build check is a no-op");
        let err = install_update(app.handle().clone())
            .await
            .expect_err("nothing to install");
        assert!(err.contains("no pending update"), "got {err}");
    }

    // `restart_app` has no test: `AppHandle::restart` terminates the process,
    // so calling it here would kill the test runner. Its whole body is that one
    // call, and it is registered in `generate_handler!` next to the others.
}
