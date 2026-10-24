//! V2 first-time setup (recovery phrase + password). Moved from the desktop
//! `commands/crypto.rs` (mobile-app plan, phase 11.3). The cloud work (Drive
//! probe, keyring publish) stays in the desktop command wrappers; the OS
//! keystore and the pending cloud session go through [`VaultPlatformHooks`].

use std::path::Path;

use zeroize::Zeroizing;

use crate::db;
use crate::utils::encryption::{
    derive_sqlcipher_key, derive_sync_key, encode_content_key_list, generate_content_key,
    generate_encryption_salt, key_fingerprint, parse_kek_params, unwrap_key, wrap_content_key,
    wrap_key_with, KdfParams,
};
use crate::utils::{boot_file, boot_file::BootFile};
use crate::AppState;
use crate::EncryptionKeyState;

use super::{encode_hex, validate_password_length, VaultPlatformHooks};

/// Returned to the frontend after `begin_first_time_setup`.
///
/// The frontend holds `setup_id` until the user completes (or cancels) the
/// 4-word mnemonic confirmation challenge.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FirstTimeSetupHandle {
    /// Opaque token — matches the `pending_first_time_setup.setup_id` row.
    pub setup_id: String,
    /// 24 BIP39 words. The frontend renders these in a 4×6 grid.
    pub mnemonic: Vec<String>,
    /// 4 distinct indices into `mnemonic` (range `[0, 24)`).
    /// The confirmation screen asks the user to re-enter the words at these
    /// positions to prove they wrote the phrase down.
    pub challenge_indices: Vec<usize>,
}

/// Crate-internal implementation of `begin_first_time_setup`.
///
/// Separated so tests can call it without Tauri state.
#[doc(hidden)]
pub fn begin_first_time_setup_inner(
    conn: &rusqlite::Connection,
    password: &str,
    device_name: &str,
    kdf_params: KdfParams,
) -> Result<FirstTimeSetupHandle, String> {
    use rand::RngCore;

    // ── Password length guard ────────────────────────────────────────────────
    validate_password_length(password)?;

    // ── Re-init guard ────────────────────────────────────────────────────────
    let current_mode = db::get_encryption_mode(conn).map_err(|e| e.to_string())?;
    let has_wrapped = db::get_setting(conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
        .map_err(|e| e.to_string())?
        .is_some_and(|s| !s.is_empty());
    let has_hash = db::is_password_hash_set(conn).map_err(|e| e.to_string())?;
    if current_mode != db::EncryptionMode::Unset || has_wrapped || has_hash {
        return Err(
            "begin_first_time_setup refuses to run: encryption is already configured".to_string(),
        );
    }

    // ── Generate master key ──────────────────────────────────────────────────
    let mut master_key = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(master_key.as_mut());

    // ── Wrap master key with password KEK (self-describing, chosen preset) ────
    let kek_salt = generate_encryption_salt();
    let wrapped_master = wrap_key_with(&master_key, password, &kek_salt, kdf_params)
        .map_err(|e| format!("wrap_key failed: {e}"))?;
    let kek_salt_hex = encode_hex(&kek_salt);

    // ── Generate BIP39 mnemonic + recovery wrapped key ───────────────────────
    let mnemonic_phrase = crate::utils::recovery::generate_recovery_mnemonic()
        .map_err(|e| format!("generate_recovery_mnemonic failed: {e}"))?;
    let mnemonic_parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic_phrase)
        .map_err(|e| format!("validate_recovery_mnemonic failed: {e}"))?;
    let recovery_key = crate::utils::recovery::derive_recovery_key(&mnemonic_parsed);
    // Recovery slot uses AES-GCM directly with the recovery_key as the AES key —
    // NO Argon2id wrap. The recovery_key is already a 256-bit HKDF output of the
    // BIP39 seed, so KDF stretching would be redundant cost (~64 MiB Argon2id per
    // unwrap). The plan spec is `recovery_wrapped = AES-GCM(recovery_key, master_key)`.
    let recovery_wrapped_bytes =
        crate::utils::encryption::encrypt_data(&*recovery_key, master_key.as_ref())
            .map_err(|e| format!("recovery encrypt_data failed: {e}"))?;
    let recovery_wrapped = hex::encode(&recovery_wrapped_bytes);
    // recovery_key is dropped & zeroed here; master_key is zeroed at end of scope.

    // ── Device ID + setup ID ─────────────────────────────────────────────────
    let device_id = db::get_or_create_device_id(conn).map_err(|e| e.to_string())?;
    let setup_id = uuid::Uuid::new_v4().to_string();

    // ── Fixed challenge positions: 1st, 3rd, 2nd-to-last, last ───────────────
    // Asking for predictable, easy-to-count positions (words 1, 3, 23, 24)
    // lets the user fill the confirmation form without counting word-by-word
    // through the copied phrase. This trades the anti-guessing property of
    // random positions for materially better UX during onboarding.
    // The fixed scheme requires at least 5 words to stay distinct + in range
    // (unlike the old random sample, which only needed 4) — guard it.
    const _: () = assert!(crate::utils::recovery::RECOVERY_WORD_COUNT >= 5);
    let last = crate::utils::recovery::RECOVERY_WORD_COUNT - 1;
    let indices: Vec<usize> = vec![0, 2, last - 1, last];
    let challenge_indices_json = serde_json::to_string(&indices)
        .map_err(|e| format!("challenge_indices JSON failed: {e}"))?;

    // ── Purge any orphaned pending rows ─────────────────────────────────────
    // Only one active setup is allowed at a time. Stale rows from a previous
    // crashed wizard session are removed now, before the fresh row is written.
    let purged = db::delete_all_pending_setups(conn).map_err(|e| e.to_string())?;
    if purged > 0 {
        log::warn!(
            "begin_first_time_setup: purged {purged} orphaned pending setup row(s) before insert"
        );
    }

    // ── Persist pending row ──────────────────────────────────────────────────
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    db::insert_pending_setup(
        conn,
        &db::PendingFirstTimeSetupRow {
            setup_id: setup_id.clone(),
            mnemonic: (*mnemonic_phrase).clone(),
            wrapped_master,
            kek_salt: kek_salt_hex,
            recovery_wrapped,
            device_id,
            device_name: device_name.to_string(),
            challenge_indices: challenge_indices_json,
            created_at: now,
        },
    )
    .map_err(|e| e.to_string())?;

    let mnemonic_words: Vec<String> = mnemonic_phrase
        .split_whitespace()
        .map(str::to_string)
        .collect();

    // master_key is zeroed on drop here.
    Ok(FirstTimeSetupHandle {
        setup_id,
        mnemonic: mnemonic_words,
        challenge_indices: indices,
    })
}

/// Parse a caller-requested unlock method string and — if it asks for
/// os_kek — generate the os_kek and wrap `master_key` under it.
///
/// Accepted values: `None` / `Some("password")` (default) → password-only,
/// no os_kek touched. `Some("os_kek")` / `Some("both")` → probe
/// `is_os_kek_available()`; unavailable is a hard error (never silently
/// downgrade a caller's explicit request — the future picker UI needs to
/// know its choice wasn't honored). Available → generate a fresh os_kek and
/// wrap `master_key` under it.
///
/// The password wrap is always written by the caller regardless of this
/// function's result (setup/onboard always collect a password), so the
/// resolved method is always `Password` or `Both` — this function never
/// returns `UnlockMethod::OsKek` alone. Pure os_kek-only boot files are a
/// supported format/unlock-path state (design doc §4) but are not produced
/// by the setup/onboard commands this phase.
///
/// On any error after `generate_os_kek()` succeeded (i.e. the wrap step
/// itself fails), removes the just-created os_kek so a failed setup never
/// strands a Keychain item with nothing in the boot file pointing at it.
#[doc(hidden)]
pub fn resolve_unlock_method_with_os_kek(
    unlock_method: Option<&str>,
    master_key: &[u8; 32],
    hooks: &dyn VaultPlatformHooks,
) -> Result<(crate::utils::boot_file::UnlockMethod, Option<String>), String> {
    use crate::utils::boot_file::UnlockMethod;
    match unlock_method {
        None | Some("password") => Ok((UnlockMethod::Password, None)),
        Some("os_kek") | Some("both") => {
            if !hooks.is_os_kek_available() {
                return Err(
                    "os_kek unlock is not available on this platform; use password".to_string(),
                );
            }
            let os_kek = hooks
                .generate_os_kek()
                .map_err(|e| format!("failed to generate os_kek: {e}"))?;
            match wrap_content_key(&os_kek, master_key) {
                Ok(blob) => Ok((UnlockMethod::Both, Some(hex::encode(blob)))),
                Err(e) => {
                    let _ = hooks.remove_os_kek();
                    Err(format!("failed to wrap master under os_kek: {e}"))
                }
            }
        }
        Some(other) => Err(format!("Unknown unlock_method: {other:?}")),
    }
}

/// Context passed from `confirm_first_time_setup_inner` to
/// `try_publish_v2_keyring_after_setup` so the keyring files can be built
/// from values that are already in scope (avoiding re-reads after the
/// pending row is deleted).
#[derive(Debug)]
pub struct V2KeyringPublishContext {
    pub recovery_wrapped: String,
    pub device_id: String,
    pub device_name: String,
    /// 64-char hex HMAC-SHA256 fingerprint of the master key.
    pub master_fingerprint: String,
    /// Vault/keyring creation time — used for `_recovery.json` and `_meta.json`.
    /// Sourced from `RECOVERY_PASSPHRASE_CREATED_AT`. Distinct from
    /// [`Self::device_created_at`].
    pub created_at: i64,
    /// This DEVICE's join time — used for `devices/<id>.json` `created_at`.
    /// Sourced from the current device's local `devices` row, which is the
    /// single source of truth for it. Keeping this separate from
    /// [`Self::created_at`] avoids two writers stamping the device slot from
    /// different sources (the local row vs. the vault-creation setting, which is
    /// `0` on peer devices).
    pub device_created_at: i64,
    /// Wall-clock seconds for the device slot's `last_seen_at`. Sourced from the
    /// current device's local `devices` row (freshened after each sync) so a
    /// republish does not reset peers' view of this device to `created_at`.
    pub last_seen_at: i64,
    /// 120 hex chars: `AES-GCM(master, content_key_v1)` — the v1 content key
    /// wrapped under master.  Published to `_content.json` so joiners can unwrap
    /// the v1 key.  Computed in `confirm_first_time_setup_inner` where master is
    /// in scope; can't be recomputed at the gdrive layer.
    pub wrapped_content_v1: String,
    /// 64 hex chars: `key_fingerprint(derive_sync_key(v1))` — used as
    /// `content_fingerprint` in the `_content.json` entry for epoch 1.
    pub content_fingerprint_v1: String,
}

/// Tauri-free part of the desktop `confirm_first_time_setup` command: swap
/// the live connection for an `Unset` placeholder, run
/// `confirm_first_time_setup_inner`, then install the rekeyed connection, or
/// on failure restore a bootstrap connection (an emergency in-memory one if
/// that also fails). Returns the context for the keyring publish, which the
/// caller runs after this (the desktop: only when Drive is connected).
#[allow(clippy::too_many_arguments)]
pub fn confirm_first_time_setup(
    db_path: &Path,
    state: &AppState,
    key_state: &EncryptionKeyState,
    setup_id: &str,
    answers: &[String],
    password: &str,
    session_id: Option<&str>,
    unlock_method: Option<&str>,
    hooks: &dyn VaultPlatformHooks,
) -> Result<V2KeyringPublishContext, String> {
    let boot_path = crate::utils::boot_file::boot_path(db_path);

    // ── Extract the real connection, replace with placeholder ────────────────
    // Mirrors the swap pattern from `setup_first_time` (lines 98–110).
    let real_conn = {
        let placeholder = rusqlite::Connection::open_in_memory()
            .map_err(|e| format!("Failed to create placeholder connection: {e}"))?;
        db::schema::migrate(&placeholder)
            .map_err(|e| format!("Failed to migrate placeholder: {e}"))?;
        db::set_encryption_mode(&placeholder, db::EncryptionMode::Unset)
            .map_err(|e| format!("Failed to seed placeholder mode: {e}"))?;
        let mut guard = state.lock()?;
        std::mem::replace(&mut *guard, placeholder)
    };

    let result = confirm_first_time_setup_inner(
        real_conn,
        key_state,
        setup_id,
        answers,
        password,
        db_path,
        Some(&boot_path),
        session_id,
        unlock_method,
        hooks,
    );

    match result {
        Ok((new_conn, publish_ctx)) => {
            state.set_connection(new_conn)?;
            Ok(publish_ctx)
        }
        Err(e) => {
            // Restore a bootstrap connection so the app is not left with an
            // unusable in-memory placeholder. Mirrors setup_first_time error path.
            log::error!("confirm_first_time_setup: inner failed ({e}); restoring bootstrap conn");
            let db_path_str = db_path.to_string_lossy().into_owned();
            match db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY) {
                Ok(restored) => {
                    log::info!(
                        "confirm_first_time_setup: bootstrap re-open succeeded after failure"
                    );
                    let _ = state.set_connection(restored);
                }
                Err(open_err) => {
                    log::error!(
                        "confirm_first_time_setup: bootstrap re-open also failed ({open_err}); \
                         using emergency placeholder"
                    );
                    if let Ok(emergency) = rusqlite::Connection::open_in_memory() {
                        let _ = db::schema::migrate(&emergency);
                        let _ = state.set_connection(emergency);
                    }
                }
            }
            Err(e)
        }
    }
}

/// Crate-internal implementation of `confirm_first_time_setup`.
///
/// Takes ownership of `conn` because PRAGMA rekey consumes the connection
/// (same pattern as `setup_first_time_inner`). Returns the post-rekey
/// connection plus a [`V2KeyringPublishContext`] containing all values needed
/// to publish the V2 keyring to Drive (passed so values from the pending row
/// remain available after the row is deleted at the end of this function).
///
/// `boot_path`: pass `Some(path)` in production (writes boot file + PRAGMA
/// rekey). Pass `None` in unit tests using in-memory DBs to skip file I/O.
///
/// `unlock_method`: caller-requested unlock method — `None`/`Some("password")`
/// (default, current frontend behavior) writes password-only. `Some("os_kek")`
/// or `Some("both")` additionally generates an os_kek and writes
/// `os_kek_wrapped_master`; the password wrap is written unconditionally
/// either way, so the boot file's actual `unlock_method` is always `Password`
/// or `Both` — pure os_kek-only vaults are a supported format/unlock-path
/// state (§4) but are not produced by this command. See
/// `crate::utils::boot_file::UnlockMethod` doc comments.
#[doc(hidden)]
pub fn confirm_first_time_setup_inner(
    conn: rusqlite::Connection,
    key_state: &EncryptionKeyState,
    setup_id: &str,
    answers: &[String],
    password: &str,
    _db_path: &Path,
    boot_path: Option<&Path>,
    session_id: Option<&str>,
    unlock_method: Option<&str>,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(rusqlite::Connection, V2KeyringPublishContext), String> {
    // ── Load pending row ─────────────────────────────────────────────────────
    let row = db::get_pending_setup_by_id(&conn, setup_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("setup_id not found: {setup_id}"))?;

    // ── Validate challenge answers ────────────────────────────────────────────
    let mnemonic_words: Vec<&str> = row.mnemonic.split_whitespace().collect();
    let challenge_indices: Vec<usize> = serde_json::from_str(&row.challenge_indices)
        .map_err(|e| format!("challenge_indices parse failed: {e}"))?;

    if answers.len() != challenge_indices.len() {
        return Err(format!(
            "expected {} answers, got {}",
            challenge_indices.len(),
            answers.len()
        ));
    }

    for (i, (&idx, answer)) in challenge_indices.iter().zip(answers.iter()).enumerate() {
        let expected = mnemonic_words
            .get(idx)
            .ok_or_else(|| format!("challenge index {idx} out of range"))?;
        if answer.trim().to_lowercase() != *expected {
            return Err(format!(
                "mnemonic challenge failed at position {i} (word index {idx})"
            ));
        }
    }

    // ── Unwrap master key using the user's password ───────────────────────────
    let kek_salt_bytes =
        hex::decode(&row.kek_salt).map_err(|e| format!("kek_salt hex decode failed: {e}"))?;
    let master_key = unwrap_key(&row.wrapped_master, password, &kek_salt_bytes)
        .map_err(|_| "incorrect password".to_string())?;

    // ── Compute master fingerprint ────────────────────────────────────────────
    let fingerprint_bytes = crate::utils::encryption::key_fingerprint(&*master_key);
    let master_fingerprint = hex::encode(fingerprint_bytes);

    // ── Generate v1 content key + per-device db_key (Phase 3 T1) ─────────────
    //
    // Creator path: generate a fresh random v1 content key and a per-device
    // db_key. The content key wraps around the master (never published directly).
    // The db_key is per-device (never published to cloud) — only the content key
    // list is shared across devices via _content.json (Phase 5).
    let content_key_v1 = generate_content_key();
    let mut db_key = Zeroizing::new([0u8; 32]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, db_key.as_mut());

    let mut content_key_map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
        std::collections::BTreeMap::new();
    content_key_map.insert(1u32, Zeroizing::new(*content_key_v1));

    // Wrap the content-key list under master for boot file / DB storage.
    let encoded_content_list = encode_content_key_list(&master_key, &content_key_map)?;

    // Cloud fingerprint is key_fingerprint(derive_sync_key(v1)) —
    // matches how the sync engine stamps entry envelopes.
    let cloud_fp_hex = hex::encode(key_fingerprint(&*derive_sync_key(&*content_key_v1)));

    // Wrap db_key under the password KEK (same kek_salt as master).
    // We use the raw AES-256-GCM wrap (no Argon2id step) so the KEK we already
    // derived doesn't need a second Argon2id pass. To get the KDF params we
    // parse the wrapped_master header.
    let kek_blob = hex::decode(&row.wrapped_master)
        .map_err(|e| format!("wrapped_master hex decode failed: {e}"))?;
    let kek_params = parse_kek_params(&kek_blob)?;
    let kek = crate::utils::encryption::derive_encryption_key_with(
        password,
        &kek_salt_bytes,
        kek_params,
    )?;
    let wrapped_db_key_blob = wrap_content_key(&kek, &*db_key)?;
    let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);

    // ── Resolve unlock method (Phase 3) — before any DB mutation so an
    //    os_kek failure aborts cleanly with zero writes. ─────────────────────
    let (resolved_unlock_method, os_kek_wrapped_master_hex) =
        resolve_unlock_method_with_os_kek(unlock_method, &master_key, hooks)?;
    // If os_kek was generated above and any step below fails, remove it so a
    // failed setup never strands a Keychain item that nothing in the
    // (rolled-back) boot file or DB points at.
    let cleanup_os_kek = || {
        if os_kek_wrapped_master_hex.is_some() {
            let _ = hooks.remove_os_kek();
        }
    };

    // ── Commit all settings + device row ────────────────────────────────────
    // Note: settings writes and device upsert are done in separate operations
    // to avoid nesting transactions (`set_current_device` calls
    // `unchecked_transaction` internally, which conflicts with an outer
    // wrapping transaction). In first-time setup there is at most one device,
    // so the absence of a wrapping transaction is safe.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Key material.
    db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &row.wrapped_master)
        .map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::KEK_SALT_KEY, &row.kek_salt).map_err(|e| e.to_string())?;
    db::set_password_hash(&conn, password).map_err(|e| e.to_string())?;
    db::set_encryption_mode(&conn, db::EncryptionMode::Password).map_err(|e| e.to_string())?;
    // Mirror the resolved unlock method into `biometric_unlock_enabled` — the
    // setting every management surface reads. `enable_biometric_unlock` is the
    // only other writer and setup never calls it, so without this an os_kek
    // chosen here would wrap the master invisibly and unmanageably. Rolled
    // back by `rollback_settings` below, alongside `cleanup_os_kek`, so the
    // Keychain and the setting can never disagree in either direction.
    if let Err(e) = hooks.sync_biometric_setting_for_unlock_method(&conn, resolved_unlock_method) {
        cleanup_os_kek();
        return Err(e);
    }

    // V2 keyring local state.
    db::set_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH, "1").map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, &master_fingerprint)
        .map_err(|e| e.to_string())?;
    db::set_setting(
        &conn,
        db::RECOVERY_PASSPHRASE_CREATED_AT,
        &now_secs.to_string(),
    )
    .map_err(|e| e.to_string())?;
    // Persist recovery_wrapped so delayed Drive connect can publish the full
    // V2 keyring without the in-flight pending row. Required for C2/I1.
    db::set_setting(
        &conn,
        db::RECOVERY_WRAPPED_MASTER_KEY,
        &row.recovery_wrapped,
    )
    .map_err(|e| e.to_string())?;

    // Phase 3 T1: persist the content-key list and epoch.
    db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded_content_list)
        .map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::CLOUD_CONTENT_FINGERPRINT, &cloud_fp_hex)
        .map_err(|e| e.to_string())?;

    // Device row — upsert first (creates the row), then mark as current
    // (which requires the row to exist). `set_current_device` manages its own
    // transaction.
    db::upsert_device(
        &conn,
        &db::DeviceRow {
            device_id: row.device_id.clone(),
            name: row.device_name.clone(),
            created_at: now_secs,
            last_seen_at: now_secs,
            is_current: true,
            is_revoked: false,
        },
    )
    .map_err(|e| e.to_string())?;
    db::set_current_device(&conn, &row.device_id).map_err(|e| e.to_string())?;

    // ── Write boot file + PRAGMA rekey (production path only) ────────────────
    //
    // C3: if boot file write or PRAGMA rekey fails, roll back all settings
    // written above so the DB stays in the pre-call state (bootstrap-keyed,
    // no wrapped key). This prevents lib.rs startup from seeing an inconsistent
    // state (encryption_mode=password without a matching boot file) and wiping
    // the DB, which would lose the pending setup row and any local data.
    let rollback_settings = |conn: &rusqlite::Connection, device_id: &str| {
        log::warn!("confirm_first_time_setup: rekey failed, rolling back settings");
        let _ = db::delete_setting(conn, db::WRAPPED_ENCRYPTION_KEY_KEY);
        let _ = db::delete_setting(conn, db::KEK_SALT_KEY);
        let _ = db::delete_setting(conn, "password_hash");
        let _ = db::set_encryption_mode(conn, db::EncryptionMode::Unset);
        let _ = db::delete_setting(conn, db::KEYRING_V2_LOCAL_EPOCH);
        let _ = db::delete_setting(conn, db::CLOUD_MASTER_FINGERPRINT);
        let _ = db::delete_setting(conn, db::RECOVERY_PASSPHRASE_CREATED_AT);
        let _ = db::delete_setting(conn, db::RECOVERY_WRAPPED_MASTER_KEY);
        // Phase 3 T1: also roll back content-key settings.
        let _ = db::delete_setting(conn, db::WRAPPED_CONTENT_LIST);
        let _ = db::delete_setting(conn, db::CONTENT_KEY_EPOCH);
        let _ = db::delete_setting(conn, db::CLOUD_CONTENT_FINGERPRINT);
        // Paired with `cleanup_os_kek` on every failure path below, so the
        // Keychain item and this setting are rolled back together.
        let _ = db::delete_setting(conn, crate::vault::BIOMETRIC_ENABLED_SETTING);
        // Remove the device row inserted above so the DB is fully clean.
        // mark_device_revoked only soft-deletes; use a direct DELETE here
        // so the DB is left in exactly the pre-call state.
        let _ = conn.execute("DELETE FROM devices WHERE device_id = ?1", [device_id]);
    };

    if let Some(bp) = boot_path {
        // Phase 3 T1: rekey DB to db_key-derived (not master-derived).
        let sqlcipher_key = derive_sqlcipher_key(&*db_key);
        // T5: also wrap db_key under master so recover/biometric can reach db_key.
        let master_wrapped_db_key_hex = match wrap_content_key(&master_key, &*db_key) {
            Ok(blob) => hex::encode(&blob),
            Err(e) => {
                rollback_settings(&conn, &row.device_id);
                cleanup_os_kek();
                return Err(e);
            }
        };

        if let Err(e) = boot_file::save(
            &BootFile {
                mode: db::EncryptionMode::Password,
                unlock_method: resolved_unlock_method,
                kek_salt: Some(row.kek_salt.clone()),
                wrapped_key: Some(row.wrapped_master.clone()),
                os_kek_wrapped_master: os_kek_wrapped_master_hex.clone(),
                // Persist the recovery slot in the plaintext boot file so the
                // 24-word phrase can reset a forgotten password offline.
                recovery_wrapped: Some(row.recovery_wrapped.clone()),
                wrapped_content_list: Some(encoded_content_list.clone()),
                wrapped_db_key: Some(wrapped_db_key_hex.clone()),
                master_wrapped_db_key: Some(master_wrapped_db_key_hex),
                migration_in_progress: None,
            },
            bp,
        ) {
            rollback_settings(&conn, &row.device_id);
            cleanup_os_kek();
            return Err(format!("Failed to write boot file: {e}"));
        }

        let pre_rekey = conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .and_then(|_| conn.pragma_update(None, "journal_mode", "DELETE"));
        if let Err(e) = pre_rekey {
            rollback_settings(&conn, &row.device_id);
            let _ = boot_file::save(&BootFile::default(), bp);
            cleanup_os_kek();
            return Err(format!("Pre-rekey WAL flush failed: {e}"));
        }
        if let Err(e) = conn.pragma_update(
            None,
            "rekey",
            format!("x'{}'", hex::encode(&*sqlcipher_key)),
        ) {
            rollback_settings(&conn, &row.device_id);
            let _ = boot_file::save(&BootFile::default(), bp);
            cleanup_os_kek();
            return Err(format!("PRAGMA rekey failed: {e}"));
        }
    }

    // ── Load key into state ───────────────────────────────────────────────────
    // Phase 3 T1: use set_content_state to load the full content-key list.
    key_state.set_content_state(content_key_map, 1, db_key, Zeroizing::new(*master_key))?;

    // ── Build publish context before deleting the pending row ────────────────
    // The pending row is deleted next; capture all values we need so the
    // caller can publish to Drive without re-reading from the DB.
    //
    // I1: also compute wrapped_content_v1 = AES-GCM(master_key, v1) so the
    // gdrive layer can publish _content.json with the correct wrap.
    let wrapped_content_v1_blob = wrap_content_key(&master_key, &*content_key_v1)
        .map_err(|e| format!("confirm_first_time_setup: wrap v1 for _content.json failed: {e}"))?;
    let wrapped_content_v1 = hex::encode(&wrapped_content_v1_blob);

    let publish_ctx = V2KeyringPublishContext {
        recovery_wrapped: row.recovery_wrapped.clone(),
        device_id: row.device_id.clone(),
        device_name: row.device_name.clone(),
        master_fingerprint: master_fingerprint.clone(),
        created_at: now_secs,
        device_created_at: now_secs,
        last_seen_at: now_secs,
        wrapped_content_v1,
        content_fingerprint_v1: cloud_fp_hex.clone(),
    };

    // ── Consume pending Drive session + persist sync settings (best-effort) ──
    // Consume happens AFTER rekey succeeded — the in-code contract is "leaves
    // the session intact for retry on user-correctable failures (wrong phrase,
    // network)." Those failures all happen above. The remaining failure modes
    // after this point are pure I/O (disk full, antivirus lock), where burning
    // the pending session is acceptable because the DB is already committed
    // to password mode.
    //
    // If session_id is supplied but the pending entry is gone (TTL expired
    // during user typing), treat as a best-effort skip — same as a persist
    // failure: user lands in password mode without Drive; they can reconnect
    // from Settings → Sync. Returning PENDING_DRIVE_SESSION_EXPIRED here would
    // require re-running OAuth AND the pending_setup row is already deleted
    // below, blocking retry.
    if let Some(sid) = session_id {
        if let Some(persisted) = hooks.consume_pending_cloud_session(&conn, sid) {
            if let Err(e) = persisted {
                log::warn!(
                    "confirm_first_time_setup: persist_connect_settings failed (non-fatal): {e}"
                );
            }
        } else {
            log::warn!(
                "confirm_first_time_setup: pending Drive session expired or missing for session_id; \
                 user will need to reconnect Drive from Settings → Sync"
            );
        }
    }

    // ── Delete pending row ────────────────────────────────────────────────────
    db::delete_pending_setup(&conn, setup_id).map_err(|e| e.to_string())?;

    Ok((conn, publish_ctx))
}
