//! Vault startup: open the database at launch and detect the encryption state.
//! Moved from the desktop `lib.rs` (mobile-app plan, phase 11.3); the OS
//! keystore wipes go through [`VaultPlatformHooks`].

use std::fs;
use std::path::Path;

use crate::db;
use crate::utils;
use crate::EncryptionKeyState;

use super::VaultPlatformHooks;

/// The outcome of `startup_init`, describing which branch was taken.
///
/// Serialized to the frontend via `get_startup_mode` (`snake_case` strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupMode {
    /// Truly fresh DB — no encryption mode set yet (boot file absent or mode=unset).
    /// Frontend routes to onboarding.
    FirstLaunch,
    /// Password mode is active — key_state stays empty, LockScreen handles unlock.
    PasswordLocked,
    /// Boot file exists but is invalid/unreadable. Vault on disk is left untouched;
    /// frontend shows recovery instructions (24-word phrase). Never wipe.
    BootFileCorrupt,
}

/// Build the in-memory placeholder connection used while the real SQLCipher DB
/// cannot be opened yet (`PasswordLocked` / `BootFileCorrupt`).
///
/// Seeds `encryption_mode=password` so the frontend probe does not mis-route
/// to FirstLaunch/onboarding.
fn startup_placeholder_conn() -> Result<rusqlite::Connection, String> {
    let placeholder = rusqlite::Connection::open(":memory:")
        .map_err(|e| format!("Failed to create startup placeholder: {e}"))?;
    db::schema::migrate(&placeholder)
        .map_err(|e| format!("Failed to migrate startup placeholder: {e}"))?;
    db::set_encryption_mode(&placeholder, db::EncryptionMode::Password)
        .map_err(|e| format!("Failed to seed startup placeholder: {e}"))?;
    Ok(placeholder)
}

/// Open (or re-open) the SQLite database at `db_path`, detect the encryption
/// state, and return the live connection plus the startup mode.
///
/// ## Branch logic
///
/// 1. **Recovery probe**: inspect the data directory for `.bak` / `.enc`
///    conversion artifacts and restore if needed (handles an interrupted
///    `convert_to_password` call).
///
/// 2. **Boot file exists but is invalid/unreadable** — return an in-memory
///    placeholder and `BootFileCorrupt`. Never wipe the on-disk vault.
///
/// 3. **Boot file `mode == Password`** — the DB is SQLCipher-encrypted.
///    Return an in-memory placeholder connection and `PasswordLocked`.
///    The real keyed connection is opened in `initialize_encryption` after
///    the user unlocks.
///
/// 4. **Boot file absent or `mode == Unset`** — fresh install or legacy DB.
///    Open with the bootstrap SQLCipher key and run the existing self-heal
///    detection. Return `FirstLaunch`.
///
/// The app is always encrypted — there is no plaintext DB branch. `key_state`
/// is left empty for `FirstLaunch`, `PasswordLocked`, and `BootFileCorrupt`.
pub fn startup_init(
    db_path: &Path,
    _key_state: &EncryptionKeyState,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(rusqlite::Connection, StartupMode), String> {
    // _key_state is not touched here — always-encrypted startup never seeds a
    // key before the user unlocks (or completes first-time setup). Kept as a
    // parameter for signature stability across callers/tests.
    let boot_path = utils::boot_file::boot_path(db_path);

    // ── Step 1: Recovery probe ────────────────────────────────────────────────
    //
    // Must run before any DB open attempt so that a partial conversion does not
    // leave us opening the wrong file.
    match db::conversion::recover_from_interrupted_conversion(db_path, &boot_path) {
        Ok(action) if action != db::conversion::RecoveryAction::None => {
            log::info!("startup recovery: applied {action:?}");
        }
        Ok(_) => {} // RecoveryAction::None — nothing to do
        Err(e) => {
            return Err(format!("startup recovery failed: {e}"));
        }
    }

    // ── Step 2: Read boot file ────────────────────────────────────────────────
    //
    // `load()` returns `Ok(BootFile::default())` when the file is simply
    // absent (fresh install) — safe to treat as FirstLaunch below. It returns
    // `Err` for any other read failure (EACCES/EIO/transient lock — see the
    // `NotFound` discrimination in `boot_file::load`), and when the file EXISTS
    // but is invalid (unknown mode/unlock_method
    // value, or a mode=password file with zero unlock wraps — the exact
    // bricked-vault shape Phase 3's invariant now rejects). Swallowing that
    // Err into `BootFile::default()` would misread a corrupted-but-real vault
    // as FirstLaunch, which falls through to the wipe-and-recreate path below
    // — turning a recoverable "boot file needs manual repair" situation into
    // silent data loss. Instead return `BootFileCorrupt` with an in-memory
    // placeholder so the app window can open and the frontend can guide the
    // user to recover with the 24-word phrase — never wipe.
    let boot = match utils::boot_file::load(&boot_path) {
        Ok(b) => b,
        Err(e) => {
            log::error!(
                "startup: boot file exists but is invalid ({e}) — \
                 entering BootFileCorrupt recovery (vault left intact)"
            );
            #[cfg(any(test, feature = "test-support"))]
            LAST_BOOT_LOAD_ERROR.with(|c| *c.borrow_mut() = Some(e.clone()));
            let placeholder = startup_placeholder_conn()?;
            return Ok((placeholder, StartupMode::BootFileCorrupt));
        }
    };

    match boot.mode {
        // ── Password mode ─────────────────────────────────────────────────────
        db::EncryptionMode::Password => {
            // DB is SQLCipher-encrypted — return a placeholder until the user
            // unlocks and `initialize_encryption` opens the real keyed connection.
            // The placeholder must have schema so commands like `get_encryption_mode`
            // work correctly while locked (the frontend probe on reconcile must not
            // throw "no such table: settings").
            let placeholder = startup_placeholder_conn()?;
            // Mirror the boot file's os_kek availability into the placeholder's
            // `biometric_unlock_enabled` setting. The real setting lives in the
            // still-encrypted DB, unreadable while locked, so without this the
            // lock screen's `is_biometric_unlock_enabled` probe reads the empty
            // placeholder and returns false — hiding the Touch ID button on a
            // device that genuinely has os_kek set up (and making
            // `unlock_with_biometric` reject its own valid path). The boot file's
            // `os_kek_wrapped_master` is the authoritative, lock-time-readable
            // signal that this device can unlock biometrically.
            if boot.os_kek_wrapped_master.is_some() {
                db::set_setting(
                    &placeholder,
                    crate::vault::BIOMETRIC_ENABLED_SETTING,
                    "true",
                )
                .map_err(|e| format!("Failed to seed biometric flag in placeholder: {e}"))?;
            }
            return Ok((placeholder, StartupMode::PasswordLocked));
        }

        // ── Unset (fresh install or no boot file) ─────────────────────────────
        db::EncryptionMode::Unset => {
            // Fall through to the existing bootstrap + self-heal path below.
        }
    }

    let db_path_str = db_path.to_string_lossy().into_owned();

    // Open (or create) the DB with the bootstrap SQLCipher key. Every file DB
    // is created encrypted from page 1 so that PRAGMA rekey can later rotate
    // it to the real HKDF-derived user key. A plain-SQLite DB from before this
    // patch is wiped and recreated automatically.
    let conn = open_bootstrap_or_wipe(db_path, &db_path_str)?;

    // Check for a failed encryption setup: encryption_mode=password without a
    // boot file means setup_first_time crashed after writing settings but before
    // writing the boot file. The real PRAGMA rekey never ran — the DB is still
    // bootstrap-encrypted. Wipe and start fresh.
    let early_enc_mode = db::get_encryption_mode(&conn)
        .map_err(|e| format!("Failed to read encryption_mode: {e}"))?;

    if early_enc_mode == db::EncryptionMode::Password {
        log::warn!(
            "Detected encryption_mode=password without boot file — setup_first_time likely \
             crashed mid-flight. Wiping DB and returning FirstLaunch."
        );
        drop(conn);
        wipe_db_files(db_path)?;
        let conn = db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
            .map_err(|e| format!("Failed to recreate database after failed-setup wipe: {e}"))?;
        if let Err(e) = hooks.wipe_biometric_keychain() {
            log::warn!("Failed to wipe biometric Keychain on failed-setup wipe: {e}");
        }
        return Ok((conn, StartupMode::FirstLaunch));
    }

    // Detect orphaned crypto-material from a crashed setup. If wrapped_key +
    // password_hash + encryption_mode=password are all present but enc_enabled
    // is absent, the DB is still bootstrap-encrypted with no valid user key.
    // Wipe it so the user can start fresh.
    let has_wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
        .map_err(|e| format!("Failed to read wrapped_encryption_key: {e}"))?
        .is_some_and(|s| !s.is_empty());
    let has_hash = db::is_password_hash_set(&conn)
        .map_err(|e| format!("Failed to read password hash: {e}"))?;
    let enc_mode = db::get_encryption_mode(&conn)
        .map_err(|e| format!("Failed to read encryption_mode: {e}"))?;
    let is_password_mode = matches!(enc_mode, db::EncryptionMode::Password);
    if has_wrapped && has_hash && is_password_mode {
        log::warn!(
            "Detected orphaned password-mode crypto material (wrapped_key + password_hash + \
             encryption_mode=password set, no boot file). \
             setup_first_time likely crashed. Wiping DB and returning FirstLaunch."
        );
        drop(conn);
        wipe_db_files(db_path)?;
        let conn = db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
            .map_err(|e| format!("Failed to recreate database after orphan-wipe: {e}"))?;
        if let Err(e) = hooks.wipe_biometric_keychain() {
            log::warn!("Failed to wipe biometric Keychain on orphan-wipe: {e}");
        }
        return Ok((conn, StartupMode::FirstLaunch));
    }

    // Fresh DB or Some(false) — wipe biometric Keychain to clear any orphaned
    // entry from a prior uninstall or corrupted settings row.
    if let Err(e) = hooks.wipe_biometric_keychain() {
        log::warn!("Failed to wipe biometric Keychain on first-launch probe: {e}");
    }
    Ok((conn, StartupMode::FirstLaunch))
}

/// Wipe the DB file and its WAL/SHM siblings from disk.
fn wipe_db_files(db_path: &Path) -> Result<(), String> {
    for suffix in &["", "-wal", "-shm"] {
        let mut p = db_path.to_owned();
        p.set_file_name(format!(
            "{}{}",
            db_path.file_name().unwrap_or_default().to_string_lossy(),
            suffix
        ));
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("Failed to wipe {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

/// Open the file DB with the bootstrap SQLCipher key. If the key is rejected
/// (legacy plain-SQLite DB created before the bootstrap-key patch), wipe the
/// file and recreate it as a fresh bootstrap-encrypted DB.
fn open_bootstrap_or_wipe(
    db_path: &Path,
    db_path_str: &str,
) -> Result<rusqlite::Connection, String> {
    match db::open_with_key(db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY) {
        Ok(conn) => Ok(conn),
        Err(e) => {
            if db_path.exists() {
                log::warn!(
                    "Failed to open DB with bootstrap key (legacy plain-SQLite?): {e}. \
                     Wiping and recreating."
                );
                wipe_db_files(db_path)?;
            }
            db::open_with_key(db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
                .map_err(|e| format!("Failed to recreate database after legacy wipe: {e}"))
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    /// The `boot_file::load` error behind the last `BootFileCorrupt` that
    /// `startup_init` returned on this thread. `StartupMode` carries no
    /// payload (its serde strings are the frontend contract), so this is
    /// how a test failure can show the real error. libtest runs each test
    /// on its own thread, so no other test can overwrite it.
    static LAST_BOOT_LOAD_ERROR: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;
    use zeroize::Zeroizing;

    /// The startup tests exercise the DB and boot-file logic only; every
    /// platform hook is a no-op so no test touches the OS keystore.
    struct NoopHooks;

    impl VaultPlatformHooks for NoopHooks {
        fn wipe_biometric_keychain(&self) -> Result<(), String> {
            Ok(())
        }
        fn post_unlock(&self, _state: &crate::AppState) {}
        fn is_os_kek_available(&self) -> bool {
            false
        }
        fn generate_os_kek(&self) -> Result<Zeroizing<[u8; 32]>, String> {
            Err("os_kek is not available on this platform".to_string())
        }
        fn remove_os_kek(&self) -> Result<(), String> {
            Ok(())
        }
        fn sync_biometric_setting_for_unlock_method(
            &self,
            _conn: &rusqlite::Connection,
            _method: crate::utils::boot_file::UnlockMethod,
        ) -> Result<(), String> {
            Ok(())
        }
        fn consume_pending_cloud_session(
            &self,
            _conn: &rusqlite::Connection,
            _session_id: &str,
        ) -> Option<Result<(), String>> {
            None
        }
    }

    /// Create a temp dir with a fresh DB and return (TempDir, db_path).
    /// TempDir must be held alive for the duration of the test.
    fn temp_db() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        (dir, db_path)
    }

    /// `#[serde(rename_all = "snake_case")]` on `StartupMode` is the entire
    /// contract with the frontend: `src/hooks/useAuth.ts` and `src/lib/tauri.ts`
    /// match on these exact string literals. Nothing else in the test suite
    /// serializes `StartupMode` — without this, a rename, a variant reorder
    /// around a future addition, or dropping `rename_all` would silently break
    /// the frontend match with no test catching it, sending a `BootFileCorrupt`
    /// user to a normal LockScreen with no working unlock method instead of the
    /// recovery screen.
    #[test]
    fn startup_mode_serializes_to_the_frontend_contract_strings() {
        assert_eq!(
            serde_json::to_string(&StartupMode::FirstLaunch).unwrap(),
            "\"first_launch\""
        );
        assert_eq!(
            serde_json::to_string(&StartupMode::PasswordLocked).unwrap(),
            "\"password_locked\""
        );
        assert_eq!(
            serde_json::to_string(&StartupMode::BootFileCorrupt).unwrap(),
            "\"boot_file_corrupt\""
        );
    }

    // ── Test 1: fresh DB → FirstLaunch ───────────────────────────────────────

    #[test]
    fn startup_fresh_db_returns_first_launch() {
        let (_dir, db_path) = temp_db();
        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks, &NoopHooks).expect("startup_init failed");
        // TODO(later): docs/LATER.md — under the full parallel suite this once
        // returned BootFileCorrupt on a fresh TempDir; print the real load error.
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "boot_file::load error: {:?}",
            LAST_BOOT_LOAD_ERROR.with(|c| c.borrow_mut().take())
        );
        // The connection is usable and mode is Unset.
        let enc_mode = db::get_encryption_mode(&conn).expect("get_encryption_mode failed");
        assert_eq!(enc_mode, db::EncryptionMode::Unset);
    }

    // ── Test 2: encryption_mode=password without boot file → wipe + FirstLaunch ─
    //
    // If setup_first_time crashed after writing settings but before writing the
    // boot file, encryption_mode=password is in the DB but no boot file exists.
    // The real PRAGMA rekey never ran — DB is still bootstrap-encrypted.
    // startup_init must wipe and return FirstLaunch.

    #[test]
    fn startup_failed_setup_without_boot_file_returns_first_launch() {
        let (_dir, db_path) = temp_db();
        // Pre-seed: encryption_mode=password, no boot file, bootstrap-encrypted DB.
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_encryption_mode(&conn, db::EncryptionMode::Password)
                .expect("set_encryption_mode");
        }
        let ks = EncryptionKeyState::new();
        let (_conn, mode) = startup_init(&db_path, &ks, &NoopHooks).expect("startup_init failed");
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "encryption_mode=password without boot file means failed setup — must wipe and return FirstLaunch"
        );
    }

    // ── Test 3: orphaned crypto markers without boot file → wipe + FirstLaunch ──
    //
    // setup_first_time crashed mid-flight: wrapped_key + password_hash +
    // encryption_mode=password are present but no boot file was written. DB is
    // still bootstrap-encrypted. startup_init must wipe and return FirstLaunch.
    #[test]
    fn startup_wipes_orphaned_password_mode_markers_returns_first_launch() {
        let (_dir, db_path) = temp_db();
        // Pre-seed: password_hash + wrapped key + KEK salt + encryption_mode=password.
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_password_hash(&conn, "dummy-password").expect("set_password_hash");
            db::set_setting(
                &conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                "deadbeef".repeat(32).as_str(),
            )
            .expect("set wrapped key");
            db::set_setting(&conn, db::KEK_SALT_KEY, &"a".repeat(64)).expect("set kek salt");
            db::set_encryption_mode(&conn, db::EncryptionMode::Password)
                .expect("set encryption_mode");
        }

        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks, &NoopHooks).expect("startup_init");
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "orphaned crypto markers without boot file must wipe and return FirstLaunch"
        );
        // After wipe the new DB is clean.
        assert_eq!(
            db::get_encryption_mode(&conn).expect("read mode"),
            db::EncryptionMode::Unset,
            "wiped DB must have Unset encryption_mode"
        );
    }

    #[test]
    fn startup_does_not_self_heal_when_encryption_mode_missing() {
        // The orphan-wipe requires ALL three password-mode markers
        // (wrapped_key + hash + encryption_mode=password). A DB with
        // wrapped_key + hash but missing mode is ambiguous — fall through to
        // FirstLaunch rather than silently wiping.
        let (_dir, db_path) = temp_db();
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_password_hash(&conn, "dummy-password").expect("set_password_hash");
            db::set_setting(
                &conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                "deadbeef".repeat(32).as_str(),
            )
            .expect("set wrapped key");
            db::set_setting(&conn, db::KEK_SALT_KEY, &"a".repeat(64)).expect("set kek salt");
            // Deliberately DO NOT set encryption_mode.
        }
        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks, &NoopHooks).expect("startup_init");
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "incomplete marker set (no encryption_mode) must NOT self-heal"
        );
        assert_eq!(
            db::get_encryption_mode(&conn).expect("read mode"),
            db::EncryptionMode::Unset,
            "self-heal must not have changed encryption_mode"
        );
    }

    // ── Test 5: missing DB file — graceful creation ───────────────────────────

    #[test]
    fn startup_handles_missing_db_file_gracefully() {
        let (_dir, db_path) = temp_db();
        // The DB file does NOT exist yet — startup_init must create it.
        assert!(!db_path.exists(), "pre-condition: file must not exist");
        let ks = EncryptionKeyState::new();
        let (_conn, mode) =
            startup_init(&db_path, &ks, &NoopHooks).expect("startup_init should succeed");
        assert_eq!(mode, StartupMode::FirstLaunch);
        assert!(db_path.exists(), "DB file should have been created");
    }

    // ── Test 6: boot file with mode=password → PasswordLocked + placeholder ──────

    #[test]
    fn startup_boot_file_encrypted_returns_password_locked_placeholder() {
        let (_dir, db_path) = temp_db();
        // Write a boot file that says the DB is encrypted.
        let boot_path = crate::utils::boot_file::boot_path(&db_path);
        crate::utils::boot_file::save(
            &crate::utils::boot_file::BootFile {
                mode: crate::db::EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: Some("aabbccdd".to_owned()),
                wrapped_key: Some("11223344".to_owned()),
                os_kek_wrapped_master: None,
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();

        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks, &NoopHooks).expect("startup_init failed");
        assert_eq!(
            mode,
            StartupMode::PasswordLocked,
            "boot file with mode=password must return PasswordLocked"
        );
        // The placeholder must have encryption_mode=password so that the lock
        // screen query works while the real DB is not yet open.
        assert_eq!(
            db::get_encryption_mode(&conn).expect("get_encryption_mode on placeholder"),
            db::EncryptionMode::Password,
            "placeholder must report encryption_mode=password"
        );
        // The real DB file should NOT have been created (we returned placeholder).
        assert!(
            !db_path.exists(),
            "real DB must not be opened when boot says encrypted"
        );
        // A password-only device has no os_kek, so the placeholder must NOT
        // advertise biometric unlock (the lock screen must not offer Touch ID).
        assert_eq!(
            db::get_setting(&conn, crate::vault::BIOMETRIC_ENABLED_SETTING)
                .expect("get biometric setting on placeholder"),
            None,
            "password-only boot file must leave biometric_unlock_enabled unset in the placeholder"
        );
    }

    // ── Test 6b: os_kek boot file seeds biometric_unlock_enabled in placeholder ──
    //
    // Regression guard: the lock-screen `is_biometric_unlock_enabled` probe reads
    // the in-memory placeholder (the real DB is still encrypted/locked). When the
    // boot file carries an `os_kek_wrapped_master`, the placeholder MUST report
    // the biometric flag as enabled, or the Touch ID button is hidden on a device
    // that genuinely supports it — and `unlock_with_biometric` rejects its own
    // valid path.
    #[test]
    fn startup_os_kek_boot_file_seeds_biometric_enabled_in_placeholder() {
        let (_dir, db_path) = temp_db();
        let boot_path = crate::utils::boot_file::boot_path(&db_path);
        crate::utils::boot_file::save(
            &crate::utils::boot_file::BootFile {
                mode: crate::db::EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Both,
                kek_salt: Some("aabbccdd".to_owned()),
                wrapped_key: Some("11223344".to_owned()),
                os_kek_wrapped_master: Some("55667788".to_owned()),
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();

        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks, &NoopHooks).expect("startup_init failed");
        assert_eq!(mode, StartupMode::PasswordLocked);
        assert_eq!(
            db::get_setting(&conn, crate::vault::BIOMETRIC_ENABLED_SETTING)
                .expect("get biometric setting on placeholder"),
            Some("true".to_owned()),
            "an os_kek boot file must make the placeholder report biometric unlock as enabled"
        );
    }

    // ── Test 7: corrupted (not absent) boot file → BootFileCorrupt, never wipe ──
    //
    // Phase 3 regression guard (updated): `utils::boot_file::load()` returns
    // `Err` for a boot file that EXISTS but is invalid — e.g. `mode=password`
    // with neither `wrapped_key` nor `os_kek_wrapped_master` (zero unlock
    // methods, the exact bricked shape `save()` now refuses to write).
    // Swallowing that `Err` into `BootFile::default()` (mode=Unset) used to
    // route into wipe-and-recreate. Propagating `Err` out of `startup_init`
    // then panicked the process before any window opened. Correct behaviour:
    // return `Ok(BootFileCorrupt)` with an in-memory placeholder and leave
    // the on-disk vault untouched so the frontend can show recovery UI.
    #[test]
    fn startup_corrupted_boot_file_fails_loudly_without_wiping() {
        let (_dir, db_path) = temp_db();
        // Pre-seed exactly the orphaned password-mode markers from the
        // sibling wipe test — this is the state that would have been wiped.
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_password_hash(&conn, "dummy-password").expect("set_password_hash");
            db::set_setting(
                &conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                "deadbeef".repeat(32).as_str(),
            )
            .expect("set wrapped key");
            db::set_setting(&conn, db::KEK_SALT_KEY, &"a".repeat(64)).expect("set kek salt");
            db::set_encryption_mode(&conn, db::EncryptionMode::Password)
                .expect("set encryption_mode");
        }

        // A boot file that EXISTS but is invalid — written directly (not via
        // `boot_file::save`, which would refuse this exact shape) to simulate
        // real on-disk corruption.
        let boot_path = crate::utils::boot_file::boot_path(&db_path);
        std::fs::write(&boot_path, "mode=password\nkek_salt=aabbcc\n")
            .expect("write corrupted boot file");

        let ks = EncryptionKeyState::new();
        let (placeholder, mode) = startup_init(&db_path, &ks, &NoopHooks)
            .expect("corrupted boot file must return Ok(BootFileCorrupt), not panic");
        assert_eq!(
            mode,
            StartupMode::BootFileCorrupt,
            "corrupted boot file must surface BootFileCorrupt for recovery UI"
        );
        // Placeholder must report password mode so the frontend does not
        // mis-route into FirstLaunch/onboarding.
        assert_eq!(
            db::get_encryption_mode(&placeholder).expect("get_encryption_mode on placeholder"),
            db::EncryptionMode::Password,
            "BootFileCorrupt placeholder must report encryption_mode=password"
        );

        // The database must be untouched — re-open with the bootstrap key and
        // confirm the pre-seeded markers survived (a wipe would reset
        // encryption_mode to Unset and drop the settings).
        let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
            .expect("re-open bootstrap after BootFileCorrupt startup_init");
        assert_eq!(
            db::get_encryption_mode(&conn).expect("read mode"),
            db::EncryptionMode::Password,
            "database must NOT have been wiped — encryption_mode must survive"
        );
        assert!(
            db::is_password_hash_set(&conn).expect("read password hash marker"),
            "pre-seeded password hash marker must survive BootFileCorrupt startup"
        );
    }
}
