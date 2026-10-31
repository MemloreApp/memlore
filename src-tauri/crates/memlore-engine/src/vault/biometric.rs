//! Biometric (os_kek) unlock, moved from the desktop `commands/keychain.rs`
//! (mobile M1 plan, task 1.2): the `biometric_unlock_enabled` setting and the
//! enable / disable / restore-after-rotation orchestration, and the os_kek
//! unlock itself (task 1.3). The OS keystore
//! itself stays behind [`VaultPlatformHooks`]; whether the platform has one
//! comes from `is_os_kek_available`, never from a `cfg`.

use std::path::Path;

use super::{OsKekError, VaultPlatformHooks, BIOMETRIC_ENABLED_SETTING};
use crate::db;
use crate::utils::boot_file::{self, BootFile, UnlockMethod};
use crate::utils::encryption::{
    decode_content_key_list, derive_sqlcipher_key, unwrap_content_key, wrap_content_key,
};
use crate::AppState;
use crate::EncryptionKeyState;

/// Read whether the user has enabled biometric unlock.
/// Returns `false` if the setting is missing or the stored value is anything
/// other than the literal string `"true"`.
pub fn read_biometric_enabled(conn: &rusqlite::Connection) -> Result<bool, String> {
    match db::get_setting(conn, BIOMETRIC_ENABLED_SETTING).map_err(|e| e.to_string())? {
        Some(v) => Ok(v == "true"),
        None => Ok(false),
    }
}

/// Write the setting as `"true"` / `"false"`.
pub fn write_biometric_enabled(conn: &rusqlite::Connection, enabled: bool) -> Result<(), String> {
    db::set_setting(
        conn,
        BIOMETRIC_ENABLED_SETTING,
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}

/// Persist `biometric_unlock_enabled` so the DB setting matches a boot file's
/// `unlock_method`.
///
/// Setup (`confirm_first_time_setup`) and join (`onboard_complete`) resolve
/// their unlock method themselves — they generate the os_kek and write the
/// wrap into the boot file without ever going through
/// `enable_biometric_unlock`, which is the setting's only other writer. Without
/// this call the os_kek item exists in the OS keystore wrapping the master
/// while every management surface (`is_biometric_unlock_enabled`, the lock
/// screen's biometric button, Settings) reports it absent — an invisible,
/// unmanageable secret, and a durable one: the restore after a key rotation
/// early-returns when the setting is false, so a later rotation leaves the
/// orphan wrapping a superseded master.
///
/// Any method carrying an os_kek wrap (`Both`, `OsKek`) means enabled;
/// `Password` means disabled — written explicitly rather than left absent so
/// the setting always states the resolved outcome.
pub fn sync_biometric_setting_for_unlock_method(
    conn: &rusqlite::Connection,
    method: UnlockMethod,
) -> Result<(), String> {
    write_biometric_enabled(
        conn,
        matches!(method, UnlockMethod::Both | UnlockMethod::OsKek),
    )
}

/// Flip the `biometric_unlock_enabled` setting to `false`. Only
/// `change_password` / recovery should call this, to mirror the OS keystore
/// wipe. Pair with [`VaultPlatformHooks::wipe_biometric_keychain`].
///
/// [`VaultPlatformHooks::wipe_biometric_keychain`]: super::VaultPlatformHooks::wipe_biometric_keychain
pub fn clear_biometric_setting(conn: &rusqlite::Connection) -> Result<(), String> {
    write_biometric_enabled(conn, false)
}

/// Enable biometric unlock: generate an os_kek, wrap the current in-memory
/// master key under it, persist the wrap into the boot file (the os_kek
/// itself goes into the OS keystore through `hooks`), and flip the setting.
///
/// Requires:
/// - The app is in **password mode** with a boot file already written
///   (biometric layers on top of the always-present password unlock). This
///   means `wrapped_key` is always present, so enabling os_kek here always
///   yields `unlock_method = Both`, never a pure os_kek-only boot file.
/// - The app is currently unlocked (master must be present in `key_state`).
///
/// **Transactional contract:** every step (os_kek generation → wrap → boot
/// file write → setting flip) is rolled back on the first failure, so a
/// partial enable never leaves a stranded keystore item, a boot file that
/// disagrees with the setting, or a setting that disagrees with the boot
/// file. "keystore item + os_kek_wrapped_master present" ⇔ "setting is true".
///
/// The Tauri-free body of the desktop `enable_biometric_unlock` command.
pub fn enable_biometric_unlock(
    db_path: &Path,
    state: &AppState,
    key_state: &EncryptionKeyState,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(), String> {
    if !hooks.is_os_kek_available() {
        return Err("Biometric unlock is not supported on this platform".to_string());
    }

    // Guard: biometric requires encryption to be set up. In the
    // password-only model this is a first-launch completion check.
    {
        let conn = state.lock()?;
        let mode = db::get_encryption_mode(&conn).map_err(|e| e.to_string())?;
        if mode != db::EncryptionMode::Password {
            return Err("Biometric unlock requires encryption to be enabled. \
                 Complete first-launch password setup first."
                .to_string());
        }
    }

    let boot_path = boot_file::boot_path(db_path);
    let existing_boot = boot_file::load(&boot_path)?;
    if existing_boot.mode != db::EncryptionMode::Password {
        return Err("Biometric unlock requires a boot file already written by \
             first-launch password setup."
            .to_string());
    }

    // Generate a fresh os_kek and wrap the current master under it.
    let os_kek = hooks.generate_os_kek()?;
    let wrap_result =
        key_state.with_master(|master| wrap_content_key(&os_kek, master).map(hex::encode));
    let wrapped_master_hex = match wrap_result {
        Ok(hex) => hex,
        Err(e) => {
            let _ = hooks.remove_os_kek();
            return Err(e);
        }
    };

    // Password unlock is always present at this point (guarded above),
    // so enabling os_kek always yields Both, never a pure os_kek-only file.
    let updated_boot = BootFile {
        unlock_method: UnlockMethod::Both,
        os_kek_wrapped_master: Some(wrapped_master_hex),
        ..existing_boot.clone()
    };
    if let Err(e) = boot_file::save(&updated_boot, &boot_path) {
        let _ = hooks.remove_os_kek();
        return Err(format!(
            "enable_biometric_unlock: failed to update boot file: {e}"
        ));
    }

    let conn = state.lock()?;
    if let Err(e) = write_biometric_enabled(&conn, true) {
        // Roll back the os_kek AND the boot file — a stranded os_kek with
        // enabled=false would be an invisible secret the user can't
        // manage from Settings; a boot file claiming Both with no
        // matching setting would confuse the next unlock's UI hints.
        let _ = hooks.remove_os_kek();
        if let Err(restore_err) = boot_file::save(&existing_boot, &boot_path) {
            log::warn!(
                "enable_biometric_unlock: setting write failed AND boot file \
                 rollback failed — boot file may be inconsistent. setting_err={e} \
                 rollback_err={restore_err}"
            );
        }
        return Err(e);
    }
    Ok(())
}

/// Disable biometric unlock: clear `os_kek_wrapped_master` from the boot file
/// (reverting `unlock_method` to `Password`, which remains valid since
/// `wrapped_key` is untouched), remove the os_kek from the OS keystore, and
/// clear the setting. Idempotent — a missing keystore item or boot file field
/// is not an error.
///
/// The Tauri-free body of the desktop `disable_biometric_unlock` command.
pub fn disable_biometric_unlock(
    db_path: &Path,
    state: &AppState,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(), String> {
    // ORDER MATTERS: update the boot file FIRST, remove the keystore item
    // second. The reverse order is a latent brick — on a device whose only
    // unlock method is os_kek, `save()` correctly refuses to write a boot
    // file with zero unlock methods, but by then the os_kek would already
    // be destroyed, leaving a boot file claiming OsKek with nothing behind
    // it. Doing the refusable step first means a refusal costs nothing.
    // Such devices are not producible today (setup always keeps a password
    // wrap), but this must not depend on that invariant holding forever.
    let boot_path = boot_file::boot_path(db_path);
    if let Ok(boot) = boot_file::load(&boot_path) {
        if boot.mode == db::EncryptionMode::Password && boot.os_kek_wrapped_master.is_some() {
            let updated = BootFile {
                unlock_method: UnlockMethod::Password,
                os_kek_wrapped_master: None,
                ..boot
            };
            // Refusing here means the device would be left with no way
            // in. Abort without touching the keystore — the user keeps
            // working biometric unlock, which beats a bricked vault.
            boot_file::save(&updated, &boot_path).map_err(|e| {
                format!(
                    "disable_biometric_unlock: refusing to remove the OS key because                              the boot file could not be updated ({e}); biometric unlock is                              left enabled"
                )
            })?;
        }
    }

    hooks.remove_os_kek()?;

    let conn = state.lock()?;
    write_biometric_enabled(&conn, false)
}

/// Re-wrap the NEW master key under the existing os_kek after a key rotation,
/// updating the boot file's `os_kek_wrapped_master` in place.
///
/// Rotation mints a brand-new random master; `commit_local_inner`
/// (`sync/rotation/commit.rs`) already drops the (now-stale) os_kek wrap from
/// the boot file it writes and downgrades `unlock_method` to `Password`, so
/// there is never a window where the boot file's os_kek wrap points at a
/// dead master. This function re-establishes convenience unlock on top of
/// that safe baseline: the os_kek itself is untouched (it is independent of
/// the master), only its wrap of the master needs updating.
///
/// On any failure it drops the boot file's os_kek wrap, wipes the os_kek
/// keystore item and clears the biometric setting so the UI falls back to
/// password unlock gracefully (password is unaffected by rotation's master
/// change, so this is never a lockout).
///
/// No-op when the platform has no OS keystore or biometric is not enabled.
/// The Tauri-free body of the desktop `restore_biometric_keychain_after_rotation`.
pub fn restore_biometric_after_rotation(
    db_path: &Path,
    state: &AppState,
    key_state: &EncryptionKeyState,
    hooks: &dyn VaultPlatformHooks,
) {
    if !hooks.is_os_kek_available() {
        return;
    }

    // Read the setting without holding the lock during the (slow) keystore call.
    let enabled = match state.lock() {
        Ok(conn) => read_biometric_enabled(&conn).unwrap_or(false),
        Err(_) => return,
    };
    if !enabled {
        return;
    }

    let boot_path = boot_file::boot_path(db_path);
    let result: Result<(), String> = (|| {
        let boot = boot_file::load(&boot_path)?;
        if boot.mode != db::EncryptionMode::Password {
            return Err("boot file is not in password mode".to_string());
        }

        // Reuse the existing os_kek — it wraps the master, not the other
        // way around, so rotation does not invalidate the os_kek itself.
        // Retrieving it triggers the OS biometric prompt.
        let os_kek = hooks.get_os_kek().map_err(|e| e.to_string())?;
        let wrapped_master_hex =
            key_state.with_master(|master| wrap_content_key(&os_kek, master).map(hex::encode))?;

        let updated_boot = BootFile {
            unlock_method: if boot.wrapped_key.is_some() {
                UnlockMethod::Both
            } else {
                UnlockMethod::OsKek
            },
            os_kek_wrapped_master: Some(wrapped_master_hex),
            ..boot
        };
        boot_file::save(&updated_boot, &boot_path)
    })();

    match result {
        Ok(()) => {
            log::info!(
                "restore_biometric_keychain_after_rotation: os_kek wrap of new master updated"
            );
        }
        Err(e) => {
            // Fallback: wipe stale entry + disable setting so biometric unlock
            // doesn't silently use the wrong key. The user will need to
            // re-enable it.
            log::warn!(
                "restore_biometric_keychain_after_rotation: re-wrap failed ({e}); \
                 wiping stale entry and disabling biometric"
            );
            // Also clear the boot file's os_kek wrap, or the dead biometric
            // button comes back on every launch (see `drop_boot_os_kek_wrap`).
            // Best-effort: this whole branch is already a degraded path.
            drop_boot_os_kek_wrap(&boot_path);
            // TODO(later): see docs/LATER.md ("Mobile M1 notes", Phase 1 review suggestions).
            let _ = hooks.wipe_biometric_keychain();
            if let Ok(conn) = state.lock() {
                let _ = clear_biometric_setting(&conn);
            }
        }
    }
}

/// Whether this device can unlock biometrically right now: the setting is
/// `"true"` **and** the boot file carries an `os_kek_wrapped_master`. Any
/// read error counts as `false`.
pub fn biometric_unlock_enabled(db_path: &Path, conn: &rusqlite::Connection) -> bool {
    read_biometric_enabled(conn).unwrap_or(false)
        && boot_file::load(&boot_file::boot_path(db_path))
            .map(|boot| boot.os_kek_wrapped_master.is_some())
            .unwrap_or(false)
}

/// The refusal when the boot file is not in the shape the os_kek unlock can
/// open (see [`unlock_with_os_kek`]). Nothing is turned off: once a password
/// unlock has finished the migration, biometric unlock works again.
const UNLOCK_WITH_PASSWORD: &str =
    "Biometric unlock is not available for this vault right now. Unlock with your password.";

/// Why [`unlock_with_os_kek`] did not unlock. `Display` gives the
/// user-facing message (the desktop's `unlock_with_biometric` strings).
#[derive(Debug, PartialEq, Eq)]
pub enum BiometricUnlockError {
    /// Biometric unlock cannot be used now; the user unlocks with the
    /// password. The message says whether it was also turned off.
    Disabled(String),
    /// The user dismissed the OS prompt. Nothing changed.
    Cancelled,
    /// Any other failure (keystore error, DB open). Nothing changed.
    Failed(String),
}

impl std::fmt::Display for BiometricUnlockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BiometricUnlockError::Disabled(msg) | BiometricUnlockError::Failed(msg) => {
                write!(f, "{msg}")
            }
            BiometricUnlockError::Cancelled => write!(f, "Biometric unlock was cancelled"),
        }
    }
}

/// Drop the boot file's `os_kek_wrapped_master` and set `unlock_method` back
/// to `Password`. That wrap is the plaintext, lock-time-readable signal
/// `startup_init` uses to seed the locked placeholder's
/// `biometric_unlock_enabled`, so a dead wrap left here resurfaces a dead
/// biometric button on every launch.
///
/// Only a password-mode file that keeps its password wrap (`wrapped_key`) is
/// touched: an os_kek-only file must never lose its only wrap. Dropping the
/// field keeps the file readable by every older version (v0.2.x), for which
/// `os_kek_wrapped_master` is optional. Best-effort: a failed save is logged
/// and leaves the file as it was.
///
/// Returns `true` when the file is valid and keeps its password wrap, i.e.
/// the os_kek is no longer the only way in and the keystore item may go.
fn drop_boot_os_kek_wrap(boot_path: &Path) -> bool {
    let Ok(boot) = boot_file::load(boot_path) else {
        return false;
    };
    if boot.mode != db::EncryptionMode::Password || boot.wrapped_key.is_none() {
        return false;
    }
    if boot.os_kek_wrapped_master.is_some() {
        let updated = BootFile {
            unlock_method: UnlockMethod::Password,
            os_kek_wrapped_master: None,
            ..boot
        };
        if let Err(e) = boot_file::save(&updated, boot_path) {
            log::warn!("biometric: could not drop the boot file's os_kek wrap: {e}");
        }
    }
    true
}

/// Turn biometric unlock off after it proved permanently broken (invalid boot
/// file, missing or corrupt wrap, missing keystore item, wrap the os_kek
/// cannot open). Best-effort: password unlock is a separate path and never
/// touched here, so this always degrades to "use your password".
///
/// Durable (mobile M1 decision 9): besides writing the setting `false` on the
/// live connection (the locked `:memory:` placeholder after a cold start,
/// which is discarded), it drops the boot file's os_kek wrap so the next
/// `startup_init` no longer seeds the biometric flag, then removes the
/// keystore item. Both only when the boot file is valid and keeps its
/// password wrap; an invalid boot file gets the setting write alone.
fn self_heal_broken_biometric(db_path: &Path, state: &AppState, hooks: &dyn VaultPlatformHooks) {
    if drop_boot_os_kek_wrap(&boot_file::boot_path(db_path)) {
        if let Err(e) = hooks.remove_os_kek() {
            log::warn!("biometric: self-heal could not remove the OS key: {e}");
        }
    }
    if let Ok(conn) = state.lock() {
        let _ = write_biometric_enabled(&conn, false);
    }
}

/// Unlock with the OS keystore key (os_kek) instead of the password: the
/// Tauri-free body of the desktop `unlock_with_biometric` command, shared
/// with the mobile FFI.
///
/// `get_os_kek` unwraps the master from the boot file's
/// `os_kek_wrapped_master`; the master unwraps the per-device DB key from
/// `master_wrapped_db_key`; the real SQLCipher DB is opened with it and
/// replaces the locked placeholder in `state`; the post-unlock sweeps run as
/// for a password unlock; then `key_state` gets the content keys.
///
/// Only the T2 boot-file shape the password unlock opens directly is
/// accepted (password mode, `wrapped_content_list`, `wrapped_db_key` and
/// `master_wrapped_db_key` present, no `migration_in_progress`). Anything
/// else needs the password unlock's migration first, so it is refused with
/// nothing changed. Unlike the password unlock this runs no T3 migration,
/// no recovery-slot backfill and no keyring reconcile.
///
/// Errors: [`BiometricUnlockError::Disabled`] when biometric cannot be used
/// (and, for a permanently broken setup, has been turned off for good: the
/// setting, the boot file's os_kek wrap and the keystore item, see
/// `self_heal_broken_biometric`); [`BiometricUnlockError::Cancelled`] when the
/// user dismissed the OS prompt; [`BiometricUnlockError::Failed`] otherwise.
/// `Cancelled` and `Failed` change nothing; only the self-heal cases write
/// anything before the real DB is open.
pub fn unlock_with_os_kek(
    db_path: &Path,
    state: &AppState,
    key_state: &EncryptionKeyState,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(), BiometricUnlockError> {
    use BiometricUnlockError::{Cancelled, Disabled, Failed};

    // Short-lived lock: it must not be held across the (blocking) OS prompt.
    let enabled = {
        let conn = state.lock().map_err(Failed)?;
        read_biometric_enabled(&conn).map_err(Failed)?
    };
    if !enabled {
        return Err(Disabled("Biometric unlock is not enabled".to_string()));
    }

    // A load() failure means the boot file exists but is invalid: still safe
    // to self-heal (password unlock is untouched), and the message says the
    // file is corrupt rather than merely missing a wrap.
    let boot = match boot_file::load(&boot_file::boot_path(db_path)) {
        Ok(boot) => boot,
        Err(e) => {
            self_heal_broken_biometric(db_path, state, hooks);
            return Err(Disabled(format!(
                "Boot file is invalid ({e}) — biometric unlock has been disabled. \
                 Unlock with your password and re-enable it in Settings."
            )));
        }
    };

    // The T2 gate, as in `initialize_encryption_inner`. Mid-migration the DB
    // may still be keyed under the master, and a legacy file has no db_key
    // wrap yet: the password unlock handles both, then this works again.
    let (list_hex, master_wrapped_db_key_hex) = match (
        boot.mode,
        boot.wrapped_content_list.as_deref(),
        boot.wrapped_db_key.as_deref(),
        boot.master_wrapped_db_key.as_deref(),
        boot.migration_in_progress == Some(true),
    ) {
        (db::EncryptionMode::Password, Some(list), Some(_), Some(mwdk), false) => (list, mwdk),
        _ => return Err(Disabled(UNLOCK_WITH_PASSWORD.to_string())),
    };

    let Some(os_kek_wrapped_master_hex) = boot.os_kek_wrapped_master.as_deref() else {
        // Setting says enabled but the boot file has no wrap to unlock with.
        self_heal_broken_biometric(db_path, state, hooks);
        return Err(Disabled(
            "Biometric unlock has no wrapped key on this device — it has been \
             disabled. Unlock with your password and re-enable it in Settings."
                .to_string(),
        ));
    };

    // Decoded before the OS prompt: a corrupt wrap is as permanent as a
    // missing keystore item, and no key can open it.
    let wrapped_master = match hex::decode(os_kek_wrapped_master_hex) {
        Ok(bytes) => bytes,
        Err(e) => {
            self_heal_broken_biometric(db_path, state, hooks);
            return Err(Disabled(format!(
                "biometric: os_kek_wrapped_master is corrupt (hex decode: {e}) — \
                 biometric unlock has been disabled. Unlock with your password \
                 and re-enable it in Settings."
            )));
        }
    };

    let os_kek = match hooks.get_os_kek() {
        Ok(key) => key,
        Err(OsKekError::NotFound) => {
            // The keystore item is gone (reinstall, manual deletion, a
            // biometric enrolment change).
            self_heal_broken_biometric(db_path, state, hooks);
            return Err(Disabled(
                "Biometric key is missing — biometric unlock has been disabled. \
                 Unlock with your password and re-enable it in Settings."
                    .to_string(),
            ));
        }
        Err(OsKekError::Cancelled) => return Err(Cancelled),
        Err(e) => return Err(Failed(e.to_string())),
    };

    let master = match unwrap_content_key(&os_kek, &wrapped_master) {
        Ok(master) => master,
        Err(e) => {
            // The os_kek does not open this boot file's wrap: inconsistent,
            // and as permanent as a missing item.
            self_heal_broken_biometric(db_path, state, hooks);
            return Err(Disabled(format!(
                "biometric: os_kek could not unwrap the stored master ({e}) — \
                 biometric unlock has been disabled. Unlock with your password \
                 and re-enable it in Settings."
            )));
        }
    };

    let db_key_blob = hex::decode(master_wrapped_db_key_hex)
        .map_err(|e| Failed(format!("biometric: master_wrapped_db_key hex decode: {e}")))?;
    let db_key = unwrap_content_key(&master, &db_key_blob).map_err(|e| {
        Failed(format!(
            "biometric: master_wrapped_db_key unwrap failed: {e}"
        ))
    })?;
    let sqlcipher_key = derive_sqlcipher_key(&db_key);
    let real_conn = db::open_with_key(&db_path.to_string_lossy(), &sqlcipher_key)
        .map_err(|e| Failed(format!("biometric: failed to open encrypted DB: {e}")))?;
    let content_keys = decode_content_key_list(&master, list_hex)
        .map_err(|e| Failed(format!("biometric: content-key list decode failed: {e}")))?;
    let latest = *content_keys
        .keys()
        .next_back()
        .ok_or_else(|| Failed("biometric: content-key list is empty".to_string()))?;

    // Replace the locked `:memory:` placeholder with the real DB.
    // TODO(later): see docs/LATER.md ("Mobile M1 notes", Phase 1 review suggestions).
    state.set_connection(real_conn).map_err(Failed)?;
    super::unlock::run_post_unlock_sweeps(state, hooks);
    key_state
        .set_content_state(content_keys, latest, db_key, master)
        .map_err(Failed)
}

/// How [`FakeKeystoreHooks::get_os_kek`] fails when forced to.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FakeGetOsKekFailure {
    NotFound,
    Cancelled,
    Other,
}

/// In-memory OS keystore for engine tests: one optional os_kek slot plus
/// switches that force `get_os_kek` or `generate_os_kek` to fail. The
/// non-keystore hooks are no-ops like the startup tests' `NoopHooks`, except
/// `sync_biometric_setting_for_unlock_method`, which does the real setting
/// write every platform does. No `Debug`: it holds key bytes.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
#[derive(Default)]
pub struct FakeKeystoreHooks {
    /// The stored os_kek; `None` means the keystore has no item.
    pub key: std::sync::Mutex<Option<[u8; 32]>>,
    /// When set, `get_os_kek` fails this way even if a key is stored.
    pub get_failure: std::sync::Mutex<Option<FakeGetOsKekFailure>>,
    /// When `true`, `generate_os_kek` fails and stores nothing.
    pub fail_generate: std::sync::atomic::AtomicBool,
}

#[cfg(any(test, feature = "test-support"))]
impl FakeKeystoreHooks {
    /// The stored os_kek (a copy).
    pub fn stored_key(&self) -> Option<[u8; 32]> {
        *self.key.lock().unwrap()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl VaultPlatformHooks for FakeKeystoreHooks {
    fn wipe_biometric_keychain(&self) -> Result<(), String> {
        // Desktop: an alias of `remove_os_kek`.
        self.remove_os_kek()
    }

    fn post_unlock(&self, _state: &AppState) {}

    fn is_os_kek_available(&self) -> bool {
        true
    }

    fn generate_os_kek(&self) -> Result<zeroize::Zeroizing<[u8; 32]>, String> {
        use rand::RngCore;
        if self.fail_generate.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("fake keystore: generate_os_kek failed".to_string());
        }
        let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
        rand::rngs::OsRng.fill_bytes(bytes.as_mut());
        *self.key.lock().unwrap() = Some(*bytes);
        Ok(bytes)
    }

    fn get_os_kek(&self) -> Result<zeroize::Zeroizing<[u8; 32]>, super::OsKekError> {
        use super::OsKekError;
        match *self.get_failure.lock().unwrap() {
            Some(FakeGetOsKekFailure::NotFound) => return Err(OsKekError::NotFound),
            Some(FakeGetOsKekFailure::Cancelled) => return Err(OsKekError::Cancelled),
            Some(FakeGetOsKekFailure::Other) => {
                return Err(OsKekError::Other(
                    "fake keystore: get_os_kek failed".to_string(),
                ))
            }
            None => {}
        }
        match *self.key.lock().unwrap() {
            Some(key) => Ok(zeroize::Zeroizing::new(key)),
            None => Err(OsKekError::NotFound),
        }
    }

    fn remove_os_kek(&self) -> Result<(), String> {
        *self.key.lock().unwrap() = None;
        Ok(())
    }

    fn sync_biometric_setting_for_unlock_method(
        &self,
        conn: &rusqlite::Connection,
        method: UnlockMethod,
    ) -> Result<(), String> {
        sync_biometric_setting_for_unlock_method(conn, method)
    }

    fn consume_pending_cloud_session(
        &self,
        _conn: &rusqlite::Connection,
        _session_id: &str,
    ) -> Option<Result<(), String>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::utils::encryption::{key_fingerprint, KdfParams};
    use rusqlite::Connection;
    use tempfile::TempDir;
    use zeroize::Zeroizing;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    // ─── Biometric-enabled setting (pure helpers) ────────────────────────────

    #[test]
    fn read_biometric_enabled_is_false_by_default() {
        let conn = setup();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn unrecognized_setting_value_is_treated_as_false() {
        // Guards against a storage-corruption or external-write that
        // puts something unexpected in the cell. "false" / "0" / garbage
        // must all be safe defaults (biometric OFF).
        let conn = setup();
        db::set_setting(&conn, BIOMETRIC_ENABLED_SETTING, "yes").unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    // ─── sync_biometric_setting_for_unlock_method ────────────────────────────
    //
    // Setup/join resolve their own unlock method and write the boot file
    // directly, never going through `enable_biometric_unlock`. These pin the
    // mapping that keeps the DB setting in step with that resolved method —
    // if it were wrong, a user who chose OS unlock would end up with an
    // os_kek in the OS keystore that no management surface can see.

    #[test]
    fn sync_biometric_setting_enables_for_both() {
        let conn = setup();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::Both).unwrap();
        assert!(
            read_biometric_enabled(&conn).unwrap(),
            "a boot file carrying an os_kek wrap must report biometric enabled"
        );
    }

    #[test]
    fn sync_biometric_setting_enables_for_os_kek_only() {
        let conn = setup();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::OsKek).unwrap();
        assert!(read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn sync_biometric_setting_writes_explicit_false_for_password() {
        let conn = setup();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::Password).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
        // Explicit "false", not absent — the setting states the outcome.
        assert_eq!(
            db::get_setting(&conn, BIOMETRIC_ENABLED_SETTING).unwrap(),
            Some("false".to_string())
        );
    }

    #[test]
    fn sync_biometric_setting_downgrades_a_previously_true_setting() {
        let conn = setup();
        write_biometric_enabled(&conn, true).unwrap();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::Password).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    // ─── clear_biometric_setting ─────────────────────────────────────────────

    #[test]
    fn clear_biometric_setting_flips_true_to_false() {
        let conn = setup();
        write_biometric_enabled(&conn, true).unwrap();
        clear_biometric_setting(&conn).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    // ─── enable / disable / restore orchestration ────────────────────────────

    const MASTER: [u8; 32] = [7u8; 32];

    /// An unlocked vault: an `AppState` whose DB says password mode, a key
    /// state holding the master, and the boot file path in a temp dir.
    fn unlocked_vault(
        boot: &BootFile,
    ) -> (TempDir, std::path::PathBuf, AppState, EncryptionKeyState) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        boot_file::save(boot, &boot_file::boot_path(&db_path)).unwrap();
        let conn = setup();
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new(MASTER)).unwrap();
        (dir, db_path, AppState::new(conn), key_state)
    }

    /// A password-mode boot file with the password wrap and, optionally, an
    /// os_kek wrap. The values are opaque to these tests.
    fn password_boot(os_kek_wrapped_master: Option<&str>) -> BootFile {
        BootFile {
            mode: db::EncryptionMode::Password,
            unlock_method: if os_kek_wrapped_master.is_some() {
                UnlockMethod::Both
            } else {
                UnlockMethod::Password
            },
            kek_salt: Some("ab".repeat(16)),
            wrapped_key: Some("cd".repeat(67)),
            os_kek_wrapped_master: os_kek_wrapped_master.map(str::to_string),
            ..BootFile::default()
        }
    }

    /// Make every write of the biometric setting fail (`set_setting` upserts,
    /// so both the INSERT and the UPDATE path must abort).
    fn fail_biometric_setting_writes(state: &AppState) {
        state
            .lock()
            .unwrap()
            .execute_batch(&format!(
                "CREATE TRIGGER fail_bio_insert BEFORE INSERT ON settings
                   WHEN NEW.key = '{BIOMETRIC_ENABLED_SETTING}'
                   BEGIN SELECT RAISE(ABORT, 'injected setting write failure'); END;
                 CREATE TRIGGER fail_bio_update BEFORE UPDATE ON settings
                   WHEN NEW.key = '{BIOMETRIC_ENABLED_SETTING}'
                   BEGIN SELECT RAISE(ABORT, 'injected setting write failure'); END;"
            ))
            .unwrap();
    }

    fn setting(state: &AppState) -> Option<String> {
        db::get_setting(&state.lock().unwrap(), BIOMETRIC_ENABLED_SETTING).unwrap()
    }

    /// The transactional contract of enable: a failure after the os_kek was
    /// generated must not strand a keystore item or leave the boot file
    /// claiming an os_kek wrap the setting does not know about.
    #[test]
    fn enable_rolls_back_when_the_setting_write_fails() {
        let (_dir, db_path, state, key_state) = unlocked_vault(&password_boot(None));
        let boot_path = boot_file::boot_path(&db_path);
        let boot_before = std::fs::read(&boot_path).unwrap();
        fail_biometric_setting_writes(&state);
        let hooks = FakeKeystoreHooks::default();

        let result = enable_biometric_unlock(&db_path, &state, &key_state, &hooks);

        assert!(result.is_err(), "enable must report the setting failure");
        assert_eq!(hooks.stored_key(), None, "the os_kek must be removed");
        assert_eq!(
            std::fs::read(&boot_path).unwrap(),
            boot_before,
            "the boot file must be restored byte for byte"
        );
        assert_eq!(setting(&state), None);
    }

    /// Disable updates the boot file before it removes the key. On an
    /// os_kek-only boot file `boot_file::save` refuses the rewrite (it would
    /// leave zero unlock methods), so the key and the setting must survive:
    /// removing the key first would brick the vault.
    #[test]
    fn disable_keeps_the_key_when_the_boot_file_is_refused() {
        let os_kek_only = BootFile {
            unlock_method: UnlockMethod::OsKek,
            kek_salt: None,
            wrapped_key: None,
            ..password_boot(Some(&"ef".repeat(60)))
        };
        let (_dir, db_path, state, _key_state) = unlocked_vault(&os_kek_only);
        let boot_path = boot_file::boot_path(&db_path);
        let boot_before = std::fs::read(&boot_path).unwrap();
        write_biometric_enabled(&state.lock().unwrap(), true).unwrap();
        let hooks = FakeKeystoreHooks::default();
        *hooks.key.lock().unwrap() = Some([9u8; 32]);

        let result = disable_biometric_unlock(&db_path, &state, &hooks);

        let err = result.expect_err("disable must refuse");
        assert!(err.contains("refusing to remove the OS key"), "{err}");
        assert_eq!(hooks.stored_key(), Some([9u8; 32]), "the key must stay");
        assert_eq!(setting(&state).as_deref(), Some("true"));
        assert_eq!(std::fs::read(&boot_path).unwrap(), boot_before);
    }

    /// After a key rotation the boot file has no os_kek wrap and restore
    /// re-wraps the new master. When the keystore item is gone, restore must
    /// turn biometric off instead of leaving a dead biometric button, and
    /// never touch the password wrap.
    #[test]
    fn restore_after_rotation_self_heals_when_the_key_is_missing() {
        let rotated = password_boot(None);
        let (_dir, db_path, state, key_state) = unlocked_vault(&rotated);
        write_biometric_enabled(&state.lock().unwrap(), true).unwrap();
        let hooks = FakeKeystoreHooks::default(); // empty: get_os_kek → NotFound

        restore_biometric_after_rotation(&db_path, &state, &key_state, &hooks);

        assert_eq!(setting(&state).as_deref(), Some("false"));
        let boot = boot_file::load(&boot_file::boot_path(&db_path)).unwrap();
        assert_eq!(boot.wrapped_key, rotated.wrapped_key);
        assert_eq!(boot.kek_salt, rotated.kek_salt);
        assert_eq!(boot.os_kek_wrapped_master, None);
        assert_eq!(boot.unlock_method, UnlockMethod::Password);
    }

    // ─── unlock_with_os_kek on a real vault ──────────────────────────────────

    const PASSWORD: &str = "correct horse battery";
    const MARKER: &str = "test_written_before_lock";

    /// A real password vault on disk, created and left unlocked the way the
    /// mobile FFI's `create_vault` does it.
    fn created_vault(
        hooks: &FakeKeystoreHooks,
    ) -> (TempDir, std::path::PathBuf, AppState, EncryptionKeyState) {
        use crate::vault::{setup, startup};

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let key_state = EncryptionKeyState::new();
        let (conn, mode) = startup::startup_init(&db_path, &key_state, hooks).unwrap();
        assert_eq!(mode, startup::StartupMode::FirstLaunch);
        let state = AppState::new(conn);
        let handle = setup::begin_first_time_setup_inner(
            &state.lock().unwrap(),
            PASSWORD,
            "test device",
            KdfParams::FAST,
        )
        .unwrap();
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();
        setup::confirm_first_time_setup(
            &db_path,
            &state,
            &key_state,
            &handle.setup_id,
            &answers,
            PASSWORD,
            None,
            None,
            hooks,
        )
        .unwrap();
        (dir, db_path, state, key_state)
    }

    /// Lock as the app does (clear the keys), then start cold: the live
    /// connection becomes the locked placeholder `startup_init` returns.
    fn lock_and_cold_start(
        db_path: &Path,
        state: &AppState,
        key_state: &EncryptionKeyState,
        hooks: &FakeKeystoreHooks,
    ) {
        use crate::vault::startup;

        key_state.clear_key().unwrap();
        let (placeholder, mode) = startup::startup_init(db_path, key_state, hooks).unwrap();
        assert_eq!(mode, startup::StartupMode::PasswordLocked);
        state.set_connection(placeholder).unwrap();
    }

    /// Enable, lock, cold start, os_kek unlock, disable: the whole biometric
    /// life cycle on one vault. The unlock must open the REAL database file,
    /// not the `:memory:` placeholder `startup_init` installed while locked.
    #[test]
    fn os_kek_round_trip_opens_the_real_database() {
        let hooks = FakeKeystoreHooks::default();
        let (_dir, db_path, state, key_state) = created_vault(&hooks);
        let boot_path = boot_file::boot_path(&db_path);
        db::set_setting(&state.lock().unwrap(), MARKER, "real").unwrap();

        enable_biometric_unlock(&db_path, &state, &key_state, &hooks).unwrap();
        let boot = boot_file::load(&boot_path).unwrap();
        assert_eq!(boot.unlock_method, UnlockMethod::Both);
        assert!(boot.os_kek_wrapped_master.is_some());
        assert!(hooks.stored_key().is_some());
        assert_eq!(setting(&state).as_deref(), Some("true"));
        let master_fingerprint = || key_state.with_master(|m| Ok(key_fingerprint(m))).unwrap();
        let master_before_lock = master_fingerprint();

        lock_and_cold_start(&db_path, &state, &key_state, &hooks);
        assert_eq!(
            setting(&state).as_deref(),
            Some("true"),
            "the locked placeholder must offer biometric unlock"
        );
        assert_eq!(
            db::get_setting(&state.lock().unwrap(), MARKER).unwrap(),
            None
        );

        unlock_with_os_kek(&db_path, &state, &key_state, &hooks).unwrap();

        assert!(key_state.is_initialized().unwrap());
        assert!(
            master_fingerprint() == master_before_lock,
            "the key state must hold the vault's master again"
        );
        {
            let conn = state.lock().unwrap();
            assert_eq!(
                db::get_setting(&conn, MARKER).unwrap().as_deref(),
                Some("real"),
                "a row written before the lock must be readable"
            );
            let open_path = conn.path().expect("a file connection has a path");
            assert!(!open_path.is_empty(), "still on the :memory: placeholder");
            assert_eq!(
                std::fs::canonicalize(open_path).unwrap(),
                std::fs::canonicalize(&db_path).unwrap()
            );
        }

        disable_biometric_unlock(&db_path, &state, &hooks).unwrap();
        let boot = boot_file::load(&boot_path).unwrap();
        assert_eq!(boot.unlock_method, UnlockMethod::Password);
        assert_eq!(boot.os_kek_wrapped_master, None);
        assert_eq!(hooks.stored_key(), None);
        assert_eq!(setting(&state).as_deref(), Some("false"));
    }

    /// The os_kek unlock opens only the T2 shape the password unlock opens
    /// directly. Mid-migration, legacy or non-password boot files must fall
    /// back to the password and change nothing: no keys, no boot file write,
    /// no setting write, no keystore removal.
    #[test]
    fn os_kek_unlock_refuses_outside_the_t2_shape() {
        let hooks = FakeKeystoreHooks::default();
        let (_dir, db_path, state, key_state) = created_vault(&hooks);
        enable_biometric_unlock(&db_path, &state, &key_state, &hooks).unwrap();
        // Cold start on the valid boot file, before any mutation: a
        // `mode=unset` file would send `startup_init` to wipe the vault.
        lock_and_cold_start(&db_path, &state, &key_state, &hooks);
        let boot_path = boot_file::boot_path(&db_path);
        let original = std::fs::read(&boot_path).unwrap();
        let t2 = boot_file::load(&boot_path).unwrap();
        let stored_key = hooks.stored_key();
        assert!(stored_key.is_some());

        let cases = [
            (
                "migration in progress",
                BootFile {
                    migration_in_progress: Some(true),
                    ..t2.clone()
                },
            ),
            (
                "wrapped_db_key missing",
                BootFile {
                    wrapped_db_key: None,
                    ..t2.clone()
                },
            ),
            (
                "master_wrapped_db_key missing",
                BootFile {
                    master_wrapped_db_key: None,
                    ..t2.clone()
                },
            ),
            (
                "mode not password",
                BootFile {
                    mode: db::EncryptionMode::Unset,
                    ..t2.clone()
                },
            ),
        ];
        for (name, boot) in cases {
            boot_file::save(&boot, &boot_path).unwrap();
            let before = std::fs::read(&boot_path).unwrap();

            let result = unlock_with_os_kek(&db_path, &state, &key_state, &hooks);

            assert_eq!(
                result,
                Err(BiometricUnlockError::Disabled(
                    UNLOCK_WITH_PASSWORD.to_string()
                )),
                "{name}"
            );
            assert!(!key_state.is_initialized().unwrap(), "{name}: unlocked");
            assert_eq!(std::fs::read(&boot_path).unwrap(), before, "{name}");
            assert_eq!(setting(&state).as_deref(), Some("true"), "{name}");
            assert_eq!(hooks.stored_key(), stored_key, "{name}: keystore");
            std::fs::write(&boot_path, &original).unwrap();
        }
    }

    /// Decision 9: a permanently broken biometric setup (keystore item gone,
    /// a wrap the os_kek cannot open, a corrupt wrap) is turned off for good.
    /// The setting lands in the `:memory:` placeholder and dies with it, so
    /// the boot file must lose its os_kek wrap too, or every cold start seeds
    /// the dead button again. The password unlock must keep working. A
    /// dismissed prompt or a transient keystore error changes nothing.
    #[test]
    fn self_heal_is_durable() {
        use crate::vault::{startup, unlock};

        fn enabled_and_cold_locked() -> (
            FakeKeystoreHooks,
            TempDir,
            std::path::PathBuf,
            AppState,
            EncryptionKeyState,
        ) {
            let hooks = FakeKeystoreHooks::default();
            let (dir, db_path, state, key_state) = created_vault(&hooks);
            db::set_setting(&state.lock().unwrap(), MARKER, "real").unwrap();
            enable_biometric_unlock(&db_path, &state, &key_state, &hooks).unwrap();
            lock_and_cold_start(&db_path, &state, &key_state, &hooks);
            (hooks, dir, db_path, state, key_state)
        }

        let permanent: [(&str, fn(&FakeKeystoreHooks, &Path)); 3] = [
            ("keystore item missing", |hooks, _| {
                *hooks.get_failure.lock().unwrap() = Some(FakeGetOsKekFailure::NotFound);
            }),
            ("os_kek does not open the wrap", |hooks, _| {
                *hooks.key.lock().unwrap() = Some([1u8; 32]);
            }),
            ("corrupt wrap hex", |_, boot_path| {
                let boot = boot_file::load(boot_path).unwrap();
                let corrupt = BootFile {
                    os_kek_wrapped_master: Some("zz".repeat(60)),
                    ..boot
                };
                boot_file::save(&corrupt, boot_path).unwrap();
            }),
        ];
        for (name, break_biometric) in permanent {
            let (hooks, _dir, db_path, state, key_state) = enabled_and_cold_locked();
            let boot_path = boot_file::boot_path(&db_path);
            let password_wrap = boot_file::load(&boot_path).unwrap().wrapped_key;
            break_biometric(&hooks, &boot_path);

            let result = unlock_with_os_kek(&db_path, &state, &key_state, &hooks);

            assert!(
                matches!(result, Err(BiometricUnlockError::Disabled(_))),
                "{name}: {result:?}"
            );
            // The next launch: a fresh placeholder must not offer biometric.
            let (placeholder, mode) = startup::startup_init(&db_path, &key_state, &hooks).unwrap();
            assert_eq!(mode, startup::StartupMode::PasswordLocked, "{name}");
            state.set_connection(placeholder).unwrap();
            assert_eq!(setting(&state), None, "{name}: flag seeded again");
            let boot = boot_file::load(&boot_path).unwrap();
            assert_eq!(boot.unlock_method, UnlockMethod::Password, "{name}");
            assert_eq!(boot.os_kek_wrapped_master, None, "{name}");
            assert_eq!(boot.wrapped_key, password_wrap, "{name}: password wrap");
            assert_eq!(hooks.stored_key(), None, "{name}: keystore item kept");

            let password = Zeroizing::new(PASSWORD.to_string());
            unlock::unlock_with_password(&db_path, &state, &key_state, &password, &hooks)
                .unwrap_or_else(|e| panic!("{name}: password unlock failed: {e}"));
            assert_eq!(
                db::get_setting(&state.lock().unwrap(), MARKER)
                    .unwrap()
                    .as_deref(),
                Some("real"),
                "{name}: password unlock must open the real database"
            );
        }

        let transient = [
            (FakeGetOsKekFailure::Cancelled, true),
            (FakeGetOsKekFailure::Other, false),
        ];
        for (failure, is_cancel) in transient {
            let (hooks, _dir, db_path, state, key_state) = enabled_and_cold_locked();
            let boot_path = boot_file::boot_path(&db_path);
            let boot_before = std::fs::read(&boot_path).unwrap();
            let key_before = hooks.stored_key();
            *hooks.get_failure.lock().unwrap() = Some(failure);

            let result = unlock_with_os_kek(&db_path, &state, &key_state, &hooks);

            if is_cancel {
                assert_eq!(result, Err(BiometricUnlockError::Cancelled));
            } else {
                assert!(
                    matches!(result, Err(BiometricUnlockError::Failed(_))),
                    "{result:?}"
                );
            }
            assert!(!key_state.is_initialized().unwrap(), "{failure:?}");
            assert_eq!(
                std::fs::read(&boot_path).unwrap(),
                boot_before,
                "{failure:?}"
            );
            assert_eq!(hooks.stored_key(), key_before, "{failure:?}");
            assert_eq!(setting(&state).as_deref(), Some("true"), "{failure:?}");
        }
    }
}
