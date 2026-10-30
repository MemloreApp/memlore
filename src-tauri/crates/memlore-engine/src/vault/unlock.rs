//! Password unlock. Moved from the desktop `commands/crypto.rs` (mobile-app
//! plan, phase 11.3); the post-unlock sweep that stays in the desktop glue
//! runs through [`VaultPlatformHooks::post_unlock`].

use std::path::Path;

use zeroize::Zeroizing;

use crate::db;
use crate::db::EncryptionMode;
use crate::utils::encryption::{
    decode_content_key_list, derive_sqlcipher_key, derive_sync_key, encode_content_key_list,
    generate_content_key, key_fingerprint, parse_kek_params, unwrap_content_key, unwrap_key,
    wrap_content_key,
};
use crate::utils::{boot_file, boot_file::BootFile};
use crate::AppState;
use crate::EncryptionKeyState;

use super::{decode_hex_salt, VaultPlatformHooks};

/// Phase 3 inner — content-key list and per-device db_key.
///
/// Called from `initialize_encryption` when `boot.mode == Password`. Handles
/// both the T2 path (boot file already has `wrapped_content_list` +
/// `wrapped_db_key`) and the T3 one-time migration path (legacy install).
///
/// Extracted as a free function so tests can drive it directly without the
/// desktop app handle or an async context.
///
/// # Arguments
/// * `state`       — app state (connection swap target)
/// * `key_state`   — encryption key state (receives `set_content_state`)
/// * `boot`        — boot file as loaded from disk
/// * `boot_path`   — path to the boot file (for updates)
/// * `db_path`     — path to the SQLite database file
/// * `master`      — unwrapped master key (Argon2id → KEK → master)
/// * `password`    — current password (needed to wrap/unwrap db_key under KEK)
/// * `wrapped_hex` — raw hex of the wrapped-master blob (for KEK param extraction)
/// * `kek_salt`    — raw KEK salt bytes
/// * `kek_salt_hex`— hex-encoded KEK salt (written back to boot file on T3)
#[doc(hidden)]
pub fn initialize_encryption_inner(
    state: &crate::AppState,
    key_state: &crate::EncryptionKeyState,
    boot: &BootFile,
    boot_path: &Path,
    db_path: &Path,
    master: &Zeroizing<[u8; 32]>,
    password: &Zeroizing<String>,
    wrapped_hex: &str,
    kek_salt: &[u8],
    kek_salt_hex: &str,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(), String> {
    // T2 path: boot file has `wrapped_content_list` + `wrapped_db_key` (and no
    //   `migration_in_progress` marker) → decode + unwrap them, open DB under
    //   db_key-derived key.
    //
    // T3 path: no `wrapped_content_list` (existing install) →
    //   crash-safe one-time PRAGMA rekey from master-derived to db_key-derived.
    //   Order: pre-write boot (with marker) → rekey → verify → DB settings →
    //   clear marker (final boot write). Any crash before marker-clear causes
    //   the next unlock to resume the migration idempotently (see T3-resume).
    //
    // T3-resume path: `migration_in_progress` marker set in the boot file →
    //   a previous T3 attempt was interrupted after the pre-write boot but before
    //   the marker was cleared. The boot file already has the new key material.
    //   Decode db_key from `boot.master_wrapped_db_key`, try to open DB under
    //   it. If that fails, the DB is still master-keyed → redo PRAGMA rekey.
    //   Then write DB settings and clear the marker.
    //
    // In all cases the final key_state is set via set_content_state.

    let content_keys: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>>;
    let db_key: Zeroizing<[u8; 32]>;

    // Check for interrupted T3 migration first.  A set marker means the boot file
    // was already written with the new key material (wrapped_content_list, wrapped_db_key,
    // master_wrapped_db_key) but the PRAGMA rekey may or may not have completed.
    let is_interrupted_migration = boot.migration_in_progress == Some(true);

    match (
        boot.wrapped_content_list.as_deref(),
        boot.wrapped_db_key.as_deref(),
        is_interrupted_migration,
    ) {
        (Some(list_hex), Some(db_key_hex), false) => {
            // ── T2: decode the persisted content-key list ────────────
            let db_key_blob = hex::decode(db_key_hex)
                .map_err(|e| format!("wrapped_db_key hex decode failed: {e}"))?;
            let kek_blob = hex::decode(wrapped_hex)
                .map_err(|e| format!("wrapped_key hex decode failed: {e}"))?;
            let params = parse_kek_params(&kek_blob)?;
            let kek =
                crate::utils::encryption::derive_encryption_key_with(password, kek_salt, params)?;
            let db_key_raw = unwrap_content_key(&kek, &db_key_blob)?;
            let keys_map = decode_content_key_list(master, list_hex)?;
            let latest = *keys_map
                .keys()
                .next_back()
                .ok_or_else(|| "decode_content_key_list returned empty map".to_string())?;
            content_keys = keys_map;
            db_key = db_key_raw;
            log::info!(
                "initialize_encryption: T2 path — content-key list loaded \
                 (latest epoch={latest})"
            );

            // T2: open DB with db_key-derived SQLCipher key.
            let sqlcipher_key = derive_sqlcipher_key(&*db_key);
            let db_path_str = db_path.to_string_lossy();
            let real_conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key)
                .map_err(|e| format!("Failed to open encrypted DB: {e}"))?;
            state.set_connection(real_conn)?;
        }
        (Some(list_hex), Some(db_key_hex), true) => {
            // ── T3-resume: interrupted migration — boot file already has new material ─
            //
            // The pre-write boot was saved (marker=true) but PRAGMA rekey and/or
            // DB settings write may not have completed.  Decode the pinned db_key
            // and content-list from the boot file (do NOT regenerate — that would
            // invalidate the already-written wraps).
            log::info!("initialize_encryption: T3-resume path — resuming interrupted migration");

            let kek_blob = hex::decode(wrapped_hex)
                .map_err(|e| format!("T3-resume: wrapped_key hex decode failed: {e}"))?;
            let params = parse_kek_params(&kek_blob)?;
            let kek =
                crate::utils::encryption::derive_encryption_key_with(password, kek_salt, params)?;
            let db_key_blob = hex::decode(db_key_hex)
                .map_err(|e| format!("T3-resume: wrapped_db_key hex decode failed: {e}"))?;
            let resumed_db_key = unwrap_content_key(&kek, &db_key_blob)?;
            let keys_map = decode_content_key_list(master, list_hex)?;

            let new_sqlcipher_key = derive_sqlcipher_key(&*resumed_db_key);
            let old_sqlcipher_key = derive_sqlcipher_key(&**master);
            let db_path_str = db_path.to_string_lossy();

            // Try to open under the new db_key first — if PRAGMA rekey already
            // completed before the crash, this will succeed.
            let migration_conn = match crate::db::open_with_key(&db_path_str, &*new_sqlcipher_key) {
                Ok(conn) => {
                    log::info!("T3-resume: DB already on db_key-derived key");
                    conn
                }
                Err(_) => {
                    // DB is still master-keyed — redo the PRAGMA rekey.
                    log::info!("T3-resume: DB still master-keyed, redoing PRAGMA rekey");
                    let conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key)
                        .map_err(|e| {
                            format!("T3-resume: failed to open DB under either key: {e}")
                        })?;
                    let pre_rekey = conn
                        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                        .and_then(|_| conn.pragma_update(None, "journal_mode", "DELETE"));
                    if let Err(e) = pre_rekey {
                        return Err(format!("T3-resume: WAL flush before rekey failed: {e}"));
                    }
                    if let Err(e) = conn.pragma_update(
                        None,
                        "rekey",
                        format!("x'{}'", hex::encode(&*new_sqlcipher_key)),
                    ) {
                        // Rekey failed — DB is still master-keyed; do not clear marker.
                        return Err(format!("T3-resume: PRAGMA rekey failed: {e}"));
                    }
                    let verify: Result<i64, rusqlite::Error> =
                        conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0));
                    if let Err(e) = verify {
                        log::error!(
                            "T3-resume: post-rekey verify failed ({e}), restoring original key"
                        );
                        let _ = conn.pragma_update(
                            None,
                            "rekey",
                            format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                        );
                        return Err(format!(
                            "T3-resume: DB verify failed after rekey (original key restored): {e}"
                        ));
                    }
                    conn
                }
            };

            // DB is now on db_key. Re-write DB settings (idempotent — safe to repeat).
            let encoded_list_for_db = list_hex.to_owned();
            let cloud_fp_hex = {
                let keys_map_ref = &keys_map;
                let v1 = keys_map_ref.get(&1).ok_or_else(|| {
                    "T3-resume: epoch 1 missing from content-key list".to_string()
                })?;
                hex::encode(key_fingerprint(&*derive_sync_key(&**v1)))
            };
            db::set_setting(
                &migration_conn,
                db::WRAPPED_CONTENT_LIST,
                &encoded_list_for_db,
            )
            .map_err(|e| format!("T3-resume: WRAPPED_CONTENT_LIST write failed: {e}"))?;
            db::set_setting(&migration_conn, db::CONTENT_KEY_EPOCH, "1")
                .map_err(|e| format!("T3-resume: CONTENT_KEY_EPOCH write failed: {e}"))?;
            db::set_setting(
                &migration_conn,
                db::CLOUD_CONTENT_FINGERPRINT,
                &cloud_fp_hex,
            )
            .map_err(|e| format!("T3-resume: CLOUD_CONTENT_FINGERPRINT write failed: {e}"))?;
            db::set_setting(&migration_conn, db::NEEDS_CLOUD_CONTENT_MIGRATION, "1").map_err(
                |e| format!("T3-resume: NEEDS_CLOUD_CONTENT_MIGRATION write failed: {e}"),
            )?;

            // Clear the migration marker — migration is now complete. T3 only
            // touches db_key/content-list rekeying, never unlock_method/os_kek —
            // carry both forward unchanged.
            let final_boot = BootFile {
                mode: EncryptionMode::Password,
                unlock_method: boot.unlock_method,
                kek_salt: Some(kek_salt_hex.to_owned()),
                wrapped_key: Some(wrapped_hex.to_owned()),
                os_kek_wrapped_master: boot.os_kek_wrapped_master.clone(),
                recovery_wrapped: boot.recovery_wrapped.clone(),
                wrapped_content_list: boot.wrapped_content_list.clone(),
                wrapped_db_key: boot.wrapped_db_key.clone(),
                master_wrapped_db_key: boot.master_wrapped_db_key.clone(),
                migration_in_progress: None,
            };
            if let Err(e) = boot_file::save(&final_boot, boot_path) {
                // Non-fatal: marker stays set but migration is functionally complete.
                // The next unlock will re-run this idempotent resume path.
                log::warn!("T3-resume: final boot file save (clear marker) failed: {e}");
            }

            log::info!(
                "T3-resume: migration complete — DB on db_key-derived key, \
                 content list persisted"
            );
            content_keys = keys_map;
            db_key = resumed_db_key;
            state.set_connection(migration_conn)?;
        }
        _ => {
            // ── T3: one-time migration for existing installs ──────────
            //
            // DB is currently keyed under derive_sqlcipher_key(master).
            //
            // CRASH-SAFE ORDER:
            //   1. Compute all new key material.
            //   2. Write boot file with new material + migration_in_progress=true
            //      (atomic rename — this is the point-of-no-return commit).
            //   3. Open DB under master-derived key.
            //   4. WAL flush + PRAGMA rekey to db_key-derived.
            //   5. Verify a read succeeds.
            //   6. Write DB settings.
            //   7. Write final boot with migration_in_progress cleared.
            //
            // If we crash after step 2 (pre-write boot saved), the next unlock
            // detects migration_in_progress=true and enters the T3-resume path
            // above, which re-does the rekey idempotently using the pinned keys.
            log::info!(
                "initialize_encryption: T3 path — one-time local rekey \
                 from master-derived to db_key-derived"
            );

            let v1 = generate_content_key();
            let mut new_db_key = Zeroizing::new([0u8; 32]);
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, new_db_key.as_mut());

            let new_sqlcipher_key = derive_sqlcipher_key(&*new_db_key);
            let old_sqlcipher_key = derive_sqlcipher_key(&**master);

            // Compute all wraps BEFORE touching the boot file.
            let mut keys_map_single = std::collections::BTreeMap::new();
            keys_map_single.insert(1u32, Zeroizing::new(*v1));
            let encoded_list = encode_content_key_list(master, &keys_map_single)?;

            let kek_blob = hex::decode(wrapped_hex)
                .map_err(|e| format!("wrapped_key hex decode failed: {e}"))?;
            let params = parse_kek_params(&kek_blob)?;
            let kek =
                crate::utils::encryption::derive_encryption_key_with(password, kek_salt, params)?;
            let wrapped_db_key_blob = wrap_content_key(&kek, &*new_db_key)?;
            let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);
            let master_wrapped_db_key_blob = wrap_content_key(master, &*new_db_key)?;
            let master_wrapped_db_key_hex = hex::encode(&master_wrapped_db_key_blob);
            let cloud_fp_hex = hex::encode(key_fingerprint(&*derive_sync_key(&*v1)));

            // Step 2: write pre-rekey boot with migration_in_progress=true.
            // This must succeed before the irreversible PRAGMA rekey.
            boot_file::save(
                &BootFile {
                    mode: EncryptionMode::Password,
                    unlock_method: boot.unlock_method,
                    kek_salt: Some(kek_salt_hex.to_owned()),
                    wrapped_key: Some(wrapped_hex.to_owned()),
                    os_kek_wrapped_master: boot.os_kek_wrapped_master.clone(),
                    recovery_wrapped: boot.recovery_wrapped.clone(),
                    wrapped_content_list: Some(encoded_list.clone()),
                    wrapped_db_key: Some(wrapped_db_key_hex.clone()),
                    master_wrapped_db_key: Some(master_wrapped_db_key_hex.clone()),
                    migration_in_progress: Some(true),
                },
                boot_path,
            )
            .map_err(|e| format!("T3 migration: pre-rekey boot file write failed: {e}"))?;

            // Step 3: open DB under old master-derived key.
            let db_path_str = db_path.to_string_lossy();
            let migration_conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key)
                .map_err(|e| {
                    format!("T3 migration: failed to open DB under master-derived key: {e}")
                })?;

            // Step 4: WAL flush + PRAGMA rekey.
            let pre_rekey = migration_conn
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .and_then(|_| migration_conn.pragma_update(None, "journal_mode", "DELETE"));
            if let Err(e) = pre_rekey {
                return Err(format!("T3 migration: WAL flush before rekey failed: {e}"));
            }

            if let Err(e) = migration_conn.pragma_update(
                None,
                "rekey",
                format!("x'{}'", hex::encode(&*new_sqlcipher_key)),
            ) {
                // Rekey failed — DB is still master-keyed.  The pre-write boot is
                // already saved (marker=true), so the next unlock will enter T3-resume
                // and retry the rekey using the pinned db_key from the boot file.
                return Err(format!("T3 migration: PRAGMA rekey failed: {e}"));
            }

            // Step 5: verify read succeeds under db_key.
            let verify: Result<i64, rusqlite::Error> =
                migration_conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0));
            if let Err(e) = verify {
                // Inverse rekey to restore original state.
                log::error!(
                    "T3 migration: post-rekey verify failed ({e}), \
                     attempting inverse rekey to restore original key"
                );
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                return Err(format!(
                    "T3 migration: DB verify failed after rekey \
                     (original key restored): {e}"
                ));
            }

            // Step 6: persist content-key list + db_key to DB settings.
            if let Err(e) =
                db::set_setting(&migration_conn, db::WRAPPED_CONTENT_LIST, &encoded_list)
            {
                // Inverse rekey before returning error.
                log::error!(
                    "T3 migration: settings write failed ({e}), \
                     restoring original key"
                );
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                return Err(format!("T3 migration: settings write failed: {e}"));
            }
            db::set_setting(&migration_conn, db::CONTENT_KEY_EPOCH, "1").map_err(|e| {
                // Inverse rekey before returning error.
                log::error!("T3 migration: CONTENT_KEY_EPOCH write failed ({e}), restoring key");
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                format!("T3 migration: CONTENT_KEY_EPOCH write failed: {e}")
            })?;
            db::set_setting(
                &migration_conn,
                db::CLOUD_CONTENT_FINGERPRINT,
                &cloud_fp_hex,
            )
            .map_err(|e| {
                log::error!(
                    "T3 migration: CLOUD_CONTENT_FINGERPRINT write failed ({e}), restoring key"
                );
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                format!("T3 migration: CLOUD_CONTENT_FINGERPRINT write failed: {e}")
            })?;
            db::set_setting(&migration_conn, db::NEEDS_CLOUD_CONTENT_MIGRATION, "1").map_err(
                |e| {
                    log::error!(
                        "T3 migration: NEEDS_CLOUD_CONTENT_MIGRATION write failed ({e}), restoring key"
                    );
                    let _ = migration_conn.pragma_update(
                        None,
                        "rekey",
                        format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                    );
                    format!("T3 migration: NEEDS_CLOUD_CONTENT_MIGRATION write failed: {e}")
                },
            )?;

            // Step 7: write final boot file with migration_in_progress cleared.
            let updated_boot = BootFile {
                mode: EncryptionMode::Password,
                unlock_method: boot.unlock_method,
                kek_salt: Some(kek_salt_hex.to_owned()),
                wrapped_key: Some(wrapped_hex.to_owned()),
                os_kek_wrapped_master: boot.os_kek_wrapped_master.clone(),
                recovery_wrapped: boot.recovery_wrapped.clone(),
                wrapped_content_list: Some(encoded_list),
                wrapped_db_key: Some(wrapped_db_key_hex),
                master_wrapped_db_key: Some(master_wrapped_db_key_hex),
                migration_in_progress: None,
            };
            if let Err(e) = boot_file::save(&updated_boot, boot_path) {
                // Non-fatal: marker stays set but migration is functionally complete.
                // The next unlock will enter T3-resume and clear the marker idempotently.
                log::warn!("T3 migration: final boot file save (clear marker) failed: {e}");
            }

            log::info!(
                "T3 migration: complete — DB rekeyed to db_key-derived, \
                 content list persisted"
            );

            let mut all_keys = std::collections::BTreeMap::new();
            all_keys.insert(1u32, Zeroizing::new(*v1));
            content_keys = all_keys;
            db_key = new_db_key;

            // Install the migrated connection (keyed under db_key).
            state.set_connection(migration_conn)?;
        }
    }

    run_post_unlock_sweeps(state, hooks);

    // Backfill the recovery slot into the boot file for vaults set up
    // before the slot was stored there. The real DB is now open, so we
    // can read RECOVERY_WRAPPED_MASTER_KEY from settings.
    //
    // CRITICAL guard: that DB setting and CLOUD_MASTER_FINGERPRINT are
    // co-written at every site (setup, onboard, rotation publish), so
    // the fingerprint always identifies the master the recovery slot
    // currently wraps. During a rotation window — commit_local has
    // rekeyed the DB to the NEW master but publish_keyring has not yet
    // refreshed the slot + fingerprint — the stored fingerprint is the
    // OLD master while `master` is NEW. Backfilling the stale slot there
    // would permanently poison the boot file (a correct recovery phrase
    // would then unwrap the dead OLD master and be wrongly rejected).
    // So we only backfill when the recovered master's fingerprint
    // matches the stored one, proving the slot wraps THIS master. This
    // is immune to every rotation/abort interleaving without reasoning
    // about job states.
    if boot.recovery_wrapped.is_none() {
        let live_fp = hex::encode(crate::utils::encryption::key_fingerprint(&**master));
        let slot_and_fp = state
            .with_conn(|c| {
                let rw = db::get_setting(c, db::RECOVERY_WRAPPED_MASTER_KEY)
                    .map_err(|e| e.to_string())?
                    .filter(|s| !s.is_empty());
                let fp =
                    db::get_setting(c, db::CLOUD_MASTER_FINGERPRINT).map_err(|e| e.to_string())?;
                Ok::<_, String>((rw, fp))
            })
            .ok();
        if let Some((Some(rw), Some(stored_fp))) = slot_and_fp {
            if stored_fp == live_fp {
                // Preserve the content-key fields when backfilling the boot file.
                //
                // A load() failure here means the on-disk boot file exists but is
                // invalid (e.g. hand-corrupted) — this backfill is best-effort and
                // must never fail (or brick) an unlock that has already succeeded,
                // so skip it and log rather than defaulting to an empty BootFile
                // (which would silently drop wrapped_content_list/wrapped_db_key/
                // master_wrapped_db_key from the write below) or propagating the
                // error (which would fail a password unlock that already worked).
                match boot_file::load(boot_path) {
                    Ok(current_boot) => {
                        let backfilled = BootFile {
                            mode: EncryptionMode::Password,
                            unlock_method: current_boot.unlock_method,
                            kek_salt: Some(kek_salt_hex.to_owned()),
                            wrapped_key: Some(wrapped_hex.to_owned()),
                            os_kek_wrapped_master: current_boot.os_kek_wrapped_master.clone(),
                            recovery_wrapped: Some(rw),
                            wrapped_content_list: current_boot.wrapped_content_list.clone(),
                            wrapped_db_key: current_boot.wrapped_db_key.clone(),
                            master_wrapped_db_key: current_boot.master_wrapped_db_key.clone(),
                            migration_in_progress: None,
                        };
                        if let Err(e) = boot_file::save(&backfilled, boot_path) {
                            log::warn!("recovery slot backfill into boot file failed: {e}");
                        } else {
                            log::info!("backfilled recovery slot into boot file");
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "recovery slot backfill: failed to re-read boot file ({e}); \
                             skipping backfill this unlock"
                        );
                    }
                }
            } else {
                log::info!(
                    "skipping recovery slot backfill: stored fingerprint does not match \
                     the live master (likely an in-flight rotation); will retry next unlock"
                );
            }
        }
    }

    let latest = *content_keys
        .keys()
        .next_back()
        .ok_or_else(|| "content_keys map is empty — this is a bug".to_string())?;
    key_state.set_content_state(content_keys, latest, db_key, Zeroizing::new(**master))?;
    Ok(())
}

/// The sweeps every unlock runs once the real keyed connection is installed
/// in `state`: AI audit retention, trash retention, then the platform's
/// `post_unlock` hook. Shared by the password unlock
/// (`initialize_encryption_inner`) and the os_kek unlock
/// (`biometric::unlock_with_os_kek`).
pub(super) fn run_post_unlock_sweeps(state: &AppState, hooks: &dyn VaultPlatformHooks) {
    // Phase 6 Stretch S2-1: run the AI audit-log retention purge
    // against the real on-disk DB. At startup `lib.rs` skipped this
    // call because the connection was the `:memory:` placeholder;
    // now that the real keyed connection is in place, purge any
    // ai_audit_log rows older than the configured retention window.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let purge_result = state.with_conn(|c| {
        crate::ai::audit::run_startup_retention_purge(c, now_ms).map_err(|e| e.to_string())
    });
    if let Err(e) = purge_result {
        log::warn!("ai audit: post-unlock retention purge failed: {e}");
    }
    if let Err(e) = state.with_conn(|c| {
        crate::ops::entries::purge_expired_trash_on_unlock(c, now_ms / 1000);
        Ok(())
    }) {
        log::warn!("trash: unlock retention sweep skipped: {e}");
    }
    hooks.post_unlock(state);
}

/// Unlock the vault with the password: resolve the password wrap (boot file
/// first, DB settings as the legacy fallback), unwrap the master, then open
/// the real keyed DB (`initialize_encryption_inner`) or, outside password
/// mode, load the master directly.
///
/// The Tauri-free body of the desktop `initialize_encryption` command, which
/// resolves `db_path` and keeps the emits and post-unlock tasks.
pub fn unlock_with_password(
    db_path: &Path,
    state: &AppState,
    key_state: &EncryptionKeyState,
    password: &Zeroizing<String>,
    hooks: &dyn VaultPlatformHooks,
) -> Result<(), String> {
    let boot_path = boot_file::boot_path(db_path);
    // A load() failure means the boot file exists but is invalid — propagate
    // rather than default to mode=Unset, which would silently divert this
    // unlock onto the "legacy DB fallback" branch below (using set_key's
    // Phase-1 shim) even though the on-disk DB is actually db_key-keyed
    // (Phase 3), producing a confusing "wrong key" failure instead of a
    // clear "boot file is invalid" one.
    let boot = boot_file::load(&boot_path)
        .map_err(|e| format!("initialize_encryption: failed to read boot file: {e}"))?;

    // Resolve kek_salt and wrapped_key — boot file preferred, DB fallback.
    let (wrapped_hex, kek_salt_hex) =
        if let (Some(wk), Some(ks)) = (boot.wrapped_key.as_ref(), boot.kek_salt.as_ref()) {
            (wk.clone(), ks.clone())
        } else {
            // Legacy path: boot file absent, read from DB.
            let conn = state.lock()?;
            let wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .map_err(|e| e.to_string())?
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Encryption not initialized — complete first-launch password setup first"
                        .to_string()
                })?;
            let kek_salt = db::get_setting(&conn, db::KEK_SALT_KEY)
                .map_err(|e| e.to_string())?
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Encryption not initialized — KEK salt missing".to_string())?;
            (wrapped, kek_salt)
        };

    let kek_salt = decode_hex_salt(&kek_salt_hex)?;
    // AES-GCM authentication failure = wrong password.
    let master = unwrap_key(&wrapped_hex, password, &kek_salt)
        .map_err(|_| "Invalid password".to_string())?;

    if boot.mode == EncryptionMode::Password {
        initialize_encryption_inner(
            state,
            key_state,
            &boot,
            &boot_path,
            db_path,
            &master,
            password,
            &wrapped_hex,
            &kek_salt,
            &kek_salt_hex,
            hooks,
        )?;
    } else {
        // Non-Password mode (None / Unset) — use Phase-1 shim.
        key_state.set_key(master)?;
    }
    Ok(())
}
