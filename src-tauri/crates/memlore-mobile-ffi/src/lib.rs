//! UniFFI surface of `memlore-engine` for the mobile app (proc-macro mode).
//!
//! FFI surface rule: every data method of [`MemloreEngine`] runs behind the
//! lock gate ([`MemloreEngine::with_unlocked`]) and returns
//! [`MemloreError::Locked`] while the vault is locked; listing uses the same
//! locked/invisible-aware query as the desktop list command. Raw `ops::*_impl`,
//! `db::*`, the AI credential readers and the `*_inner` vault helpers are only
//! called from here, never exported. Error messages carry no key material.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use memlore_core::envelope::{open_entry, EnvelopeError};
use memlore_core::key_state::ContentKeyList;
use memlore_core::outbox::MAX_YJS_DOC_BYTES;
use memlore_engine::ai::indexer::EntryIndexer;
use memlore_engine::db::{self, EntrySort, EntryTimeRange, LockFilter, LockedView};
use memlore_engine::ops::entries::{
    maybe_detect_language_after_save, maybe_mark_entry_embedding_dirty_after_save,
    save_entry_content_merged_impl,
};
use memlore_engine::utils::boot_file::{self, UnlockMethod};
use memlore_engine::utils::encryption::KdfParams;
use memlore_engine::vault::biometric::BiometricUnlockError;
use memlore_engine::vault::startup::StartupMode;
use memlore_engine::vault::{self, VaultPlatformHooks};
use memlore_engine::{AppState, EncryptionKeyState};
use tokio::runtime::Runtime;
use zeroize::Zeroizing;

use crate::keystore::OsKeyStore;

mod keystore;

uniffi::setup_scaffolding!();

/// Process-wide runtime for the engine's async code. Never dropped: a JS
/// reload that creates a second engine reuses it.
static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// Device name written at first-time setup (the desktop derives one from the
/// platform the same way).
const DEVICE_NAME: &str = if cfg!(target_os = "ios") {
    "iOS device"
} else if cfg!(target_os = "android") {
    "Android device"
} else {
    "This device"
};

/// Exactly what `vault::unlock::unlock_with_password` returns when the
/// password wrap does not authenticate.
const INVALID_PASSWORD: &str = "Invalid password";

/// Seconds in the background before the app locks, in the encrypted DB
/// settings. Device-local (each phone picks its own): it must NEVER be added
/// to `SYNCABLE_SETTING_KEYS` (memlore-engine `db/queries.rs`).
const AUTO_LOCK_SETTING: &str = "mobile_auto_lock_seconds";
/// Immediate, 1, 5 and 15 minutes.
const AUTO_LOCK_CHOICES: [u32; 4] = [0, 60, 300, 900];
/// The default, and what any missing or unexpected stored value reads as.
const AUTO_LOCK_DEFAULT: u32 = 60;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MemloreError {
    #[error("the vault is locked")]
    Locked,
    #[error("wrong password")]
    WrongPassword,
    #[error("{msg}")]
    Io { msg: String },
    #[error("{msg}")]
    Format { msg: String },
    /// Face ID unlock cannot be used now (not enabled, or found broken and
    /// turned off); the user unlocks with the password.
    #[error("{msg}")]
    BiometricDisabled { msg: String },
    /// The user dismissed the Face ID prompt. Nothing changed.
    #[error("biometric unlock was cancelled")]
    BiometricCancelled,
}

fn io(msg: String) -> MemloreError {
    MemloreError::Io { msg }
}

fn format_err(msg: impl Into<String>) -> MemloreError {
    MemloreError::Format { msg: msg.into() }
}

fn biometric_unlock_err(e: BiometricUnlockError) -> MemloreError {
    match e {
        BiometricUnlockError::Disabled(msg) => MemloreError::BiometricDisabled { msg },
        BiometricUnlockError::Cancelled => MemloreError::BiometricCancelled,
        BiometricUnlockError::Failed(msg) => io(msg),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StartupModeFfi {
    FirstLaunch,
    PasswordLocked,
    BootFileCorrupt,
}

impl From<StartupMode> for StartupModeFfi {
    fn from(mode: StartupMode) -> Self {
        match mode {
            StartupMode::FirstLaunch => Self::FirstLaunch,
            StartupMode::PasswordLocked => Self::PasswordLocked,
            StartupMode::BootFileCorrupt => Self::BootFileCorrupt,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EntryTitleFfi {
    pub id: String,
    pub title: Option<String>,
    pub entry_date: i64,
}

/// One opened `<device>/entries/<id>.bin` sync file.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EntryFrameFfi {
    /// `serde_json` of the frozen `EntryMetadata` (memlore-core `metadata.rs`).
    pub metadata_json: String,
    /// Yjs full-state bytes, empty when the entry has no body yet.
    pub yjs: Vec<u8>,
}

/// Mobile side of the vault lifecycle: the os_kek lives in `keystore` (the
/// iOS Keychain), no post-unlock sweep, no pending cloud session.
struct MobileVaultHooks {
    keystore: Arc<dyn OsKeyStore>,
}

impl VaultPlatformHooks for MobileVaultHooks {
    fn wipe_biometric_keychain(&self) -> Result<(), String> {
        self.keystore.remove()
    }

    fn post_unlock(&self, _state: &AppState) {}

    fn is_os_kek_available(&self) -> bool {
        self.keystore.is_available()
    }

    fn generate_os_kek(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        // Any fresh 32-byte `OsRng` key will do: reusing memlore-core's
        // content-key generator keeps `rand` out of this crate.
        let os_kek = memlore_core::encryption::generate_content_key();
        self.keystore.store(&os_kek)?;
        Ok(os_kek)
    }

    fn get_os_kek(&self) -> Result<Zeroizing<[u8; 32]>, vault::OsKekError> {
        self.keystore.retrieve()
    }

    fn remove_os_kek(&self) -> Result<(), String> {
        self.keystore.remove()
    }

    /// Same mirror as the desktop: the setting says whether the vault can
    /// unlock with the OS keystore.
    fn sync_biometric_setting_for_unlock_method(
        &self,
        conn: &rusqlite::Connection,
        method: UnlockMethod,
    ) -> Result<(), String> {
        let enabled = matches!(method, UnlockMethod::Both | UnlockMethod::OsKek);
        db::set_setting(
            conn,
            vault::BIOMETRIC_ENABLED_SETTING,
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
    }

    fn consume_pending_cloud_session(
        &self,
        _conn: &rusqlite::Connection,
        _session_id: &str,
    ) -> Option<Result<(), String>> {
        None
    }
}

#[derive(uniffi::Object)]
pub struct MemloreEngine {
    db_path: PathBuf,
    state: AppState,
    key_state: EncryptionKeyState,
    startup_mode: Mutex<StartupMode>,
    /// The hooks every vault call of this engine gets.
    hooks: MobileVaultHooks,
    /// The one indexer of this engine, like the desktop's managed
    /// `EntryIndexer` (stub embedder until a provider is configured).
    // TODO(later): see docs/LATER.md (nothing drains the embedding-dirty rows
    // this queues once settings sync brings an embed provider).
    indexer: EntryIndexer,
}

#[uniffi::export]
impl MemloreEngine {
    /// Inject the app version and the runtime, then open the vault at
    /// `app_data_dir/memlore.db` the way the desktop `setup` does.
    #[uniffi::constructor]
    pub fn new(app_data_dir: String, app_version: String) -> Result<Arc<Self>, MemloreError> {
        Self::with_keystore(app_data_dir, app_version, keystore::default_keystore())
    }

    pub fn startup_mode(&self) -> StartupModeFfi {
        (*self.startup_mode.lock().unwrap_or_else(|p| p.into_inner())).into()
    }

    /// First-time setup in one step (the desktop splits it across two screens):
    /// create the vault with a password unlock, no cloud, and return the
    /// 24-word recovery phrase. The vault is unlocked afterwards, and
    /// `startup_mode` reports `PasswordLocked` (what a restart would find).
    pub fn create_vault(&self, password: String) -> Result<String, MemloreError> {
        let password = Zeroizing::new(password);
        vault::validate_password_length(&password).map_err(format_err)?;
        let handle = {
            let conn = self.state.lock().map_err(io)?;
            vault::setup::begin_first_time_setup_inner(
                &conn,
                &password,
                DEVICE_NAME,
                KdfParams::FAST,
            )
            .map_err(io)?
        };
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();
        vault::setup::confirm_first_time_setup(
            &self.db_path,
            &self.state,
            &self.key_state,
            &handle.setup_id,
            &answers,
            &password,
            None,
            None,
            &self.hooks,
        )
        .map_err(io)?;
        *self.startup_mode.lock().unwrap_or_else(|p| p.into_inner()) = StartupMode::PasswordLocked;
        Ok(handle.mnemonic.join(" "))
    }

    pub fn unlock(&self, password: String) -> Result<(), MemloreError> {
        let password = Zeroizing::new(password);
        vault::unlock::unlock_with_password(
            &self.db_path,
            &self.state,
            &self.key_state,
            &password,
            &self.hooks,
        )
        .map_err(|e| {
            if e == INVALID_PASSWORD {
                MemloreError::WrongPassword
            } else {
                io(e)
            }
        })
    }

    /// Clear the keys from memory, like the desktop `lock_encryption`, then
    /// close the database (decision 10): the keyed SQLCipher connection is
    /// replaced by the password-locked placeholder a cold start opens, so
    /// the Face ID flag still answers. Only for a created vault (boot file
    /// in password mode): before setup the live connection is the one
    /// `create_vault` rekeys, and it holds no user data.
    ///
    /// Never fails open: the keys go first, and if the placeholder cannot
    /// replace the connection it stays open behind the lock gate. That is
    /// logged, but no logger is installed on mobile yet.
    // TODO(later): see docs/LATER.md ("Mobile M1 notes", Phase 2 review suggestions).
    pub fn lock(&self) -> Result<(), MemloreError> {
        self.key_state.clear_key().map_err(io)?;
        let closed = boot_file::load(&boot_file::boot_path(&self.db_path)).and_then(|boot| {
            if boot.mode != db::EncryptionMode::Password {
                return Ok(());
            }
            let placeholder = vault::startup::password_locked_placeholder(&boot)?;
            self.state.set_connection(placeholder)
        });
        if let Err(e) = closed {
            log::error!("lock: the connection was not replaced, data calls stay locked ({e})");
        }
        Ok(())
    }

    /// Whether Face ID can unlock this vault: the setting AND the boot file's
    /// os_kek wrap. Answers while locked too (the boot file is plaintext).
    pub fn is_biometric_unlock_enabled(&self) -> bool {
        self.state
            .lock()
            .map(|conn| vault::biometric::biometric_unlock_enabled(&self.db_path, &conn))
            .unwrap_or(false)
    }

    /// Turn Face ID unlock on: a new os_kek in the Keychain wraps the master
    /// into the boot file. Needs an unlocked vault.
    // Not `with_unlocked`: the engine takes the connection and the master
    // itself, and the key state must not be re-entered.
    pub fn enable_biometric(&self) -> Result<(), MemloreError> {
        if !self.key_state.is_initialized().map_err(io)? {
            return Err(MemloreError::Locked);
        }
        vault::biometric::enable_biometric_unlock(
            &self.db_path,
            &self.state,
            &self.key_state,
            &self.hooks,
        )
        .map_err(io)
    }

    /// Turn Face ID unlock off: the boot file's wrap first, then the Keychain
    /// item, then the setting. Idempotent. Needs an unlocked vault: while
    /// locked the connection is the placeholder, so the setting would not
    /// reach the vault.
    pub fn disable_biometric(&self) -> Result<(), MemloreError> {
        if !self.key_state.is_initialized().map_err(io)? {
            return Err(MemloreError::Locked);
        }
        vault::biometric::disable_biometric_unlock(&self.db_path, &self.state, &self.hooks)
            .map_err(io)
    }

    /// Unlock with the Face ID-protected os_kek instead of the password.
    /// Refused while unlocked: it would replace the live connection.
    pub fn unlock_with_biometric(&self) -> Result<(), MemloreError> {
        if self.key_state.is_initialized().map_err(io)? {
            return Err(io("The vault is already unlocked".to_string()));
        }
        vault::biometric::unlock_with_os_kek(
            &self.db_path,
            &self.state,
            &self.key_state,
            &self.hooks,
        )
        .map_err(biometric_unlock_err)
    }

    /// The auto-lock interval: 0 (immediate), 60, 300 or 900 seconds. Fails
    /// closed: a missing, unparsable or unexpected stored value reads as the
    /// 1-minute default, never as "never lock".
    pub fn auto_lock_seconds(&self) -> Result<u32, MemloreError> {
        self.with_unlocked(|conn| {
            let stored = db::get_setting(conn, AUTO_LOCK_SETTING).map_err(|e| io(e.to_string()))?;
            Ok(stored
                .and_then(|v| v.parse::<u32>().ok())
                .filter(|s| AUTO_LOCK_CHOICES.contains(s))
                .unwrap_or(AUTO_LOCK_DEFAULT))
        })
    }

    /// Store the auto-lock interval; anything but 0, 60, 300 or 900 seconds
    /// is a `Format` error.
    pub fn set_auto_lock_seconds(&self, seconds: u32) -> Result<(), MemloreError> {
        self.with_unlocked(|conn| {
            if !AUTO_LOCK_CHOICES.contains(&seconds) {
                return Err(format_err(format!(
                    "auto-lock must be 0, 60, 300 or 900 seconds, not {seconds}"
                )));
            }
            db::set_setting(conn, AUTO_LOCK_SETTING, &seconds.to_string())
                .map_err(|e| io(e.to_string()))
        })
    }

    /// Entries the list shows (same filters as [`Self::list_entry_titles`]).
    pub fn entry_count(&self) -> Result<u64, MemloreError> {
        self.with_unlocked(|conn| Ok(u64::from(list_page(conn, 1)?.total)))
    }

    /// Create an entry with `title` and an empty body in the first visible,
    /// unlocked journal. Returns its id.
    pub fn create_entry(&self, title: String) -> Result<String, MemloreError> {
        self.with_unlocked(|conn| {
            let journal_id = db::list_journals(conn, None)
                .map_err(|e| io(e.to_string()))?
                .into_iter()
                .find(|j| !j.is_locked)
                .map(|j| j.id)
                .ok_or_else(|| io("No journal to create the entry in".to_string()))?;
            let title = Some(title.as_str()).filter(|t| !t.trim().is_empty());
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let entry = memlore_engine::ops::entries::create_entry_impl(
                conn,
                &journal_id,
                title,
                None,
                None,
                now,
            )
            .map_err(io)?;
            let (yjs, content_text, preview_text) =
                memlore_engine::yjs_doc::build_entry_yjs(&[""], &[]);
            memlore_engine::ops::entries::save_entry_content_impl(
                conn,
                &entry.id,
                &yjs,
                &content_text,
                &preview_text,
            )
            .map_err(io)?;
            Ok(entry.id)
        })
    }

    /// Newest first, at most `limit`. Locked entries are hidden and
    /// invisible-vault entries are excluded (no vault session on mobile).
    pub fn list_entry_titles(&self, limit: u32) -> Result<Vec<EntryTitleFfi>, MemloreError> {
        self.with_unlocked(|conn| {
            let limit = limit as usize;
            let mut out = Vec::new();
            let mut page = 1;
            while out.len() < limit {
                let items = list_page(conn, page)?.items;
                if items.is_empty() {
                    break;
                }
                out.extend(items.into_iter().map(|e| EntryTitleFfi {
                    id: e.id,
                    title: e.title,
                    entry_date: e.entry_date,
                }));
                page += 1;
            }
            out.truncate(limit);
            Ok(out)
        })
    }

    /// The entry's Yjs document (full state), empty when it has no body yet.
    /// Only entries the list shows open: a locked or invisible entry is
    /// "not found" (mobile has no reveal session and no invisible vault).
    pub fn load_entry_yjs(&self, id: String) -> Result<Vec<u8>, MemloreError> {
        self.with_unlocked(|conn| {
            require_listed_entry(conn, &id)?;
            Ok(db::get_entry_content(conn, &id)
                .map_err(|e| io(e.to_string()))?
                .unwrap_or_default())
        })
    }

    /// The editor's save, exactly like the desktop `save_entry_content`
    /// command: `full_state` is the editor's whole document
    /// (`Y.encodeStateAsUpdate`, never an incremental update) and it is
    /// MERGED into the stored one, so an edit that landed meanwhile (MCP
    /// append, outbox import) survives. Then the same post-save hooks, minus
    /// the desktop-only `last_edit` debounce clock.
    pub fn save_entry_yjs(
        &self,
        id: String,
        full_state: Vec<u8>,
        content_text: String,
        preview_text: String,
    ) -> Result<(), MemloreError> {
        if full_state.len() > MAX_YJS_DOC_BYTES {
            return Err(format_err(
                "Yjs document exceeds maximum allowed size (10 MiB)",
            ));
        }
        self.with_unlocked(|conn| {
            require_listed_entry(conn, &id)?;
            save_entry_content_merged_impl(conn, &id, &full_state, &content_text, &preview_text)
                .map_err(io)
        })?;
        // Outside the lock gate and after the connection guard is released:
        // the embedding hook takes the connection itself.
        {
            let conn = self.state.lock().map_err(io)?;
            maybe_detect_language_after_save(&conn, &id);
        }
        maybe_mark_entry_embedding_dirty_after_save(&self.state, &self.indexer, &id);
        Ok(())
    }
}

impl MemloreEngine {
    /// [`Self::new`] with the os_kek kept in `keystore` (tests pass a fake).
    fn with_keystore(
        app_data_dir: String,
        app_version: String,
        keystore: Arc<dyn OsKeyStore>,
    ) -> Result<Arc<Self>, MemloreError> {
        if memlore_engine::ops::app_info::try_app_version().is_none() {
            memlore_engine::ops::app_info::set_app_version(Box::leak(app_version.into_boxed_str()));
        }
        if RUNTIME.get().is_none() {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| io(format!("Failed to build the tokio runtime: {e}")))?;
            // A concurrent `new` may have won; its runtime is kept, ours dropped.
            let _ = RUNTIME.set(rt);
        }
        if let Some(rt) = RUNTIME.get() {
            memlore_engine::ai::runtime::set_runtime(rt.handle().clone());
        }

        let data_dir = PathBuf::from(app_data_dir);
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| io(format!("Failed to create the app data dir: {e}")))?;
        let db_path = data_dir.join("memlore.db");
        let key_state = EncryptionKeyState::new();
        let hooks = MobileVaultHooks { keystore };
        let (conn, mode) =
            vault::startup::startup_init(&db_path, &key_state, &hooks).map_err(io)?;
        Ok(Arc::new(Self {
            db_path,
            state: AppState::new(conn),
            key_state,
            startup_mode: Mutex::new(mode),
            hooks,
            indexer: EntryIndexer::with_stub(),
        }))
    }

    /// The lock gate: `Locked` unless the keys are loaded, then run `f` on
    /// the DB connection while holding the key state, like the desktop
    /// commands' `key_state.with_key`.
    fn with_unlocked<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> Result<T, MemloreError>,
    ) -> Result<T, MemloreError> {
        self.key_state
            .with_key(|_key| Ok(self.state.lock().map_err(io).and_then(|conn| f(&conn))))
            .map_err(|_| MemloreError::Locked)?
    }
}

/// The per-entry gate of [`MemloreEngine::load_entry_yjs`] and
/// [`MemloreEngine::save_entry_yjs`]: the same entries [`list_page`] shows
/// (live, not effectively locked, not invisible), anything else is not found.
fn require_listed_entry(conn: &rusqlite::Connection, id: &str) -> Result<(), MemloreError> {
    let entry = db::get_entry(conn, id).map_err(|e| io(e.to_string()))?;
    let visible =
        db::is_entry_visible_for_active_vault(conn, id, None).map_err(|e| io(e.to_string()))?;
    match entry {
        Some(e) if visible && !e.is_deleted && !e.is_locked => Ok(()),
        _ => Err(io("Entry not found".to_string())),
    }
}

/// One page of the desktop "all entries" list query, with the filters a
/// session without a revealed lock or an open invisible vault gets.
fn list_page(
    conn: &rusqlite::Connection,
    page: u32,
) -> Result<db::PagedResult<db::Entry>, MemloreError> {
    db::list_all_entries_paged_with_locked_view(
        conn,
        EntrySort::Newest,
        EntryTimeRange::All,
        None,
        1,
        page,
        LockedView::Hidden,
        None,
        LockFilter::All,
    )
    .map_err(|e| io(e.to_string()))
}

/// Open one entry sync file with the content key it was sealed under
/// (64 hex chars). The same `memlore_core` decoder the desktop sync uses:
/// frame + schema version check, key fingerprint, then both inner blobs.
#[uniffi::export]
pub fn open_entry_frame(
    content_key_hex: String,
    bytes: Vec<u8>,
) -> Result<EntryFrameFfi, MemloreError> {
    let content_key_hex = Zeroizing::new(content_key_hex);
    let mut key = Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(content_key_hex.as_bytes(), key.as_mut())
        .map_err(|_| format_err("content key must be 64 hex chars"))?;
    let list = ContentKeyList {
        keys: [(1, key)].into_iter().collect(),
        latest: 1,
        db_key: Zeroizing::new([0u8; 32]),
        master: Zeroizing::new([0u8; 32]),
    };
    let opened = open_entry(&list, &bytes).map_err(envelope_err)?;
    let metadata_json = String::from_utf8(opened.metadata_json)
        .map_err(|_| format_err("entry metadata is not UTF-8"))?;
    Ok(EntryFrameFfi {
        metadata_json,
        yjs: opened.yjs,
    })
}

fn envelope_err(e: EnvelopeError) -> MemloreError {
    format_err(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::MemoryKeyStore;
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim};

    /// A valid full state that differs from `base` (an editor typed into it).
    fn edited(base: &[u8]) -> Vec<u8> {
        let doc = yrs::Doc::with_client_id(7);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(base).unwrap()).unwrap();
        let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::new("paragraph", []));
        paragraph.push_back(&mut txn, XmlTextPrelim::new("must not land"));
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    }

    /// `require_listed_entry`: a locked entry, an entry of an invisible
    /// journal and a deleted entry are "not found" for both the load and the
    /// save, and the rejected save leaves the stored document untouched.
    #[test]
    fn entry_yjs_calls_refuse_unlisted_entries() {
        type Hide = fn(&rusqlite::Connection, &str);
        let cases: [(&str, Hide); 3] = [
            ("locked entry", |conn, id| {
                db::set_entry_locked(conn, id, true).unwrap()
            }),
            ("invisible journal", |conn, id| {
                let journal_id = db::get_entry(conn, id).unwrap().unwrap().journal_id;
                let vault = db::insert_invisible_vault(conn, "verifier").unwrap();
                db::set_journal_invisible(conn, &journal_id, true, Some(&vault.id)).unwrap();
            }),
            ("deleted entry", |conn, id| {
                db::trash_entry(conn, id, 1).unwrap()
            }),
        ];
        for (case, hide) in cases {
            let dir = tempfile::TempDir::new().unwrap();
            let engine = MemloreEngine::new(
                dir.path().to_string_lossy().into_owned(),
                "0.0.0-test".into(),
            )
            .unwrap();
            engine.create_vault("password12".to_string()).unwrap();
            let id = engine.create_entry("Hidden".to_string()).unwrap();
            let base = engine.load_entry_yjs(id.clone()).unwrap();
            let stored = |engine: &MemloreEngine| {
                let conn = engine.state.lock().unwrap();
                db::get_entry_content(&conn, &id).unwrap()
            };
            let before = stored(&engine);
            hide(&engine.state.lock().unwrap(), &id);

            assert!(
                matches!(
                    engine.load_entry_yjs(id.clone()),
                    Err(MemloreError::Io { .. })
                ),
                "{case}: load"
            );
            assert!(
                matches!(
                    engine.save_entry_yjs(id.clone(), edited(&base), "x".into(), "x".into()),
                    Err(MemloreError::Io { .. })
                ),
                "{case}: save"
            );
            assert_eq!(stored(&engine), before, "{case}: stored doc changed");
        }
    }

    /// Face ID enable, lock, unlock reads the same data: the os_kek lands in
    /// the keystore, the lock closes the database (decision 10) while the flag
    /// still answers from the placeholder, the biometric unlock opens the same
    /// vault and is refused once unlocked, and disable empties the keystore.
    #[test]
    fn face_id_enable_lock_unlock_reads_the_same_data() {
        let dir = tempfile::TempDir::new().unwrap();
        let keystore = Arc::new(MemoryKeyStore::default());
        let engine = MemloreEngine::with_keystore(
            dir.path().to_string_lossy().into_owned(),
            "0.0.0-test".into(),
            keystore.clone(),
        )
        .unwrap();
        engine.create_vault("password12".to_string()).unwrap();
        let id = engine.create_entry("Kept".to_string()).unwrap();
        let count = engine.entry_count().unwrap();

        engine.enable_biometric().unwrap();
        engine.lock().unwrap();
        assert!(
            db::get_entry(&engine.state.lock().unwrap(), &id)
                .unwrap()
                .is_none(),
            "lock left the keyed connection open"
        );
        assert!(matches!(
            engine.enable_biometric(),
            Err(MemloreError::Locked)
        ));
        assert!(matches!(
            engine.disable_biometric(),
            Err(MemloreError::Locked)
        ));
        assert!(engine.is_biometric_unlock_enabled());

        engine.unlock_with_biometric().unwrap();
        assert_eq!(engine.entry_count().unwrap(), count);
        assert!(matches!(
            engine.unlock_with_biometric(),
            Err(MemloreError::Io { .. })
        ));

        engine.disable_biometric().unwrap();
        assert!(!engine.is_biometric_unlock_enabled());
        assert!(matches!(
            keystore.retrieve(),
            Err(vault::OsKekError::NotFound)
        ));
    }

    /// The auto-lock interval fails closed: a missing setting, a stored value
    /// that does not parse or is outside {0, 60, 300, 900} reads as the
    /// 1-minute default, never as "never"; `set` accepts only the four
    /// choices, and both calls are lock-gated.
    #[test]
    fn auto_lock_interval_fails_closed() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = MemloreEngine::with_keystore(
            dir.path().to_string_lossy().into_owned(),
            "0.0.0-test".into(),
            Arc::new(MemoryKeyStore::default()),
        )
        .unwrap();
        engine.create_vault("password12".to_string()).unwrap();
        assert_eq!(engine.auto_lock_seconds().unwrap(), 60, "missing");

        for seconds in [0, 60, 300, 900] {
            engine.set_auto_lock_seconds(seconds).unwrap();
            assert_eq!(engine.auto_lock_seconds().unwrap(), seconds);
        }
        for raw in ["abc", "-1", "30", "3600", ""] {
            engine.set_auto_lock_seconds(300).unwrap();
            db::set_setting(&engine.state.lock().unwrap(), AUTO_LOCK_SETTING, raw).unwrap();
            assert_eq!(engine.auto_lock_seconds().unwrap(), 60, "stored {raw:?}");
        }
        for seconds in [30, 3600] {
            engine.set_auto_lock_seconds(300).unwrap();
            assert!(
                matches!(
                    engine.set_auto_lock_seconds(seconds),
                    Err(MemloreError::Format { .. })
                ),
                "set {seconds}"
            );
            assert_eq!(engine.auto_lock_seconds().unwrap(), 300, "set {seconds}");
        }

        engine.lock().unwrap();
        assert!(matches!(
            engine.auto_lock_seconds(),
            Err(MemloreError::Locked)
        ));
        assert!(matches!(
            engine.set_auto_lock_seconds(60),
            Err(MemloreError::Locked)
        ));
    }

    /// First launch wipes a stale Keychain item, a password-locked launch
    /// keeps it: an os_kek left by an earlier install is never paired with a
    /// new vault, and a relaunch never loses the Face ID key of the vault
    /// that is there.
    #[test]
    fn first_launch_wipes_a_stale_keychain_item_a_password_locked_launch_keeps_it() {
        let fresh = tempfile::TempDir::new().unwrap();
        let stale = Arc::new(MemoryKeyStore::default());
        stale.store(&[7u8; 32]).unwrap();
        let engine = MemloreEngine::with_keystore(
            fresh.path().to_string_lossy().into_owned(),
            "0.0.0-test".into(),
            stale.clone(),
        )
        .unwrap();
        assert_eq!(engine.startup_mode(), StartupModeFfi::FirstLaunch);
        assert!(
            matches!(stale.retrieve(), Err(vault::OsKekError::NotFound)),
            "first launch kept a stale Keychain item"
        );

        let dir = tempfile::TempDir::new().unwrap();
        let keystore = Arc::new(MemoryKeyStore::default());
        let open = || {
            MemloreEngine::with_keystore(
                dir.path().to_string_lossy().into_owned(),
                "0.0.0-test".into(),
                keystore.clone(),
            )
            .unwrap()
        };
        let engine = open();
        engine.create_vault("password12".to_string()).unwrap();
        engine.enable_biometric().unwrap();
        drop(engine);

        let engine = open();
        assert_eq!(engine.startup_mode(), StartupModeFfi::PasswordLocked);
        assert!(
            keystore.retrieve().is_ok(),
            "password-locked launch wiped the Face ID key"
        );
    }
}
