//! Outbox Importer — Desktop Ingest of Web Companion Intents
//!
//! This module documents and implements the desktop-side outbox importer (Phases 13 & 14)
//! for the Memlore Web Companion (`web.memlore.app`).
//!
//! # Architecture & Safety Principles
//!
//! The web companion operates under a strict "outbox" model:
//! 1. The web NEVER writes sync-protocol files (`metadata.json`, `entries/`, `media/`, `journals/`).
//! 2. The web writes sealed intents into `generations/g-<N>/<webId>/outbox/`:
//!    - `outbox/<entryId>.bin`: one entry intent (frame v1) per entry, updated in place.
//!    - Frame v2 intents, one file per target, updated in place: `outbox/j-<journalId>.bin`
//!      (create journal), `outbox/t-<tagId>.bin` (create tag), `outbox/p-<templateId>.bin`
//!      (upsert or delete template), `outbox/d-<entryId>.bin` (move entry to Trash). The
//!      file name must match the body's kind and id, or the file is `corrupt`.
//!    - Apply order in one cycle, across all web devices: `t-` → `j-` → `p-` → entry
//!      intents → `d-`, so a journal finds the auto tags created with it and an entry
//!      finds the journal / tags created with it.
//!    - `outbox/m-<mediaId>` and `outbox/m-<mediaId>.thumb`: flat layout, 3-part logical paths
//!      (`<dev>/outbox/<file>`), compliant with `parse_drive_path` (`gdrive_provider.rs:1729-1742`).
//! 3. Desktop is primary: desktops apply intents through their own local code paths, then
//!    publish the result as normal desktop sync files. Older desktops without this importer
//!    ignore the outbox completely because `<webId>` has no `metadata.json`.
//!
//! ---
//!
//! ## (a) Desktop Consumers & Namespace Isolation
//!
//! Every device-folder consumer in the desktop codebase has been verified:
//! - **Manifest pull:** `engine.rs:5143` and `engine.rs:5213-5218` iterate devices and pull only
//!   when `metadata.json` is present. Because `<webId>` never writes `metadata.json`, all
//!   desktop pull pipelines skip the web device folder.
//! - **Whole-table channels:** settings, tags, templates, streak, locations, and ai channels
//!   ignore missing files (NotFound -> continue). Chats and memory are manifest-gated.
//! - **New desktop-written file `{self}/outbox-acks.bin`:**
//!   - Placed at the root of the desktop's OWN folder.
//!   - **Rotation enumeration (`rotation/enumerate.rs:154-237`):**
//!     Rotation enumerates `FileKind::Entries`, `FileKind::Media`, `FileKind::Journals`,
//!     `FileKind::Versions`, and a fixed list `SINGLETON_BLOB_NAMES` (`enumerate.rs:223-235`).
//!     It does NOT glob or list all root files; `{self}/outbox-acks.bin` is not in
//!     `SINGLETON_BLOB_NAMES` and is therefore ignored during rotation re-encryption.
//!   - **Own-cloud reconcile (`engine.rs:693-730`):**
//!     `FileKind::DeviceRoot` listing compares against `HASH_GATED_SURFACE_NAMES` (`engine.rs:728`).
//!     Extra files like `outbox-acks.bin` do not match any surface name and are ignored without error.
//! - **Destructive flows touching the web namespace:**
//!   - **Cloud cleanup (`gdrive_provider.rs:1358-1396`, `recovery.rs:1457-1486`):**
//!     Deletes all children of the `Memlore` root except `.meta/control.json` and recovery markers
//!     preserved by `preserve_during_cloud_cleanup`. This cleanly purges all device folders,
//!     including web outbox folders and `{self}/outbox-acks.bin`.
//!   - **Key rotation `publish_keyring` (`rotation/publish.rs:198-216`):**
//!     `kio::delete_device_slot(provider, &slot.device_id)` deletes every non-rotator device slot
//!     under `.meta/keyring/devices/`. Web slots are dropped, revoking decryption of new content.
//!   - **Remove device (`commands/crypto.rs:3933-3953`):**
//!     `remove_device_inner` calls `delete_device_slot` on the cloud provider and deletes the
//!     local device record, leaving cloud outbox files untouched until cloud cleanup.
//!
//! ---
//!
//! ## (b) Provider Listing API & Device Slot Discovery
//!
//! - **Subfolder listing:**
//!   In `gdrive_provider.rs:1145-1148`, `list_subfolder_files` checks `find_folder(subfolder, ...)`.
//!   If the subfolder does not exist, it returns `Ok(vec![])`. Listing `outbox` on a device
//!   folder without an outbox cleanly returns empty.
//! - **Device slot discovery:**
//!   `KeyringV2Io::list_device_slots` (`keyring_v2/io.rs:318`) lists `.meta/keyring/devices/*.json`.
//!   In `commands/sync.rs:880` and `commands/crypto.rs:3747`, `refresh_devices_from_cloud_impl`
//!   calls `list_device_slots(&provider)` to discover registered devices.
//!
//! ---
//!
//! ## (c) Building Blocks Reused by the Importer
//!
//! Following the precedent established in `commands/mcp.rs`:
//! - **Write guards (`commands/mcp.rs:357-395`):**
//!   `require_writable_entry` refuses locked, invisible, or deleted entries. An entry in
//!   Trash is refused before it, with reason `entry_trashed`.
//!   `visible_journal` verifies that the target journal exists and is neither deleted nor invisible.
//! - **Emotion & tag validation:**
//!   `validate_emotion` (`mcp.rs:425`) enforces 3-state emotion values (`good`, `neutral`, `bad`).
//!   Tag IDs require a new ID-based query `existing_tag_ids(conn, ids)` because
//!   `resolve_existing_tag_ids` (`mcp.rs:396-416`) looks up tags by name and errors on unknown tags.
//! - **Yrs Yjs text extraction:**
//!   Yjs text is extracted using yrs transactions. The frontend already computes `contentText`
//!   and `previewText` in the outbox payload (`OutboxEntryV1`), but desktop verification
//!   or fallback can walk the `default` text type of the merged `Y.Doc`.
//! - **Editor live diff bridge (`commands/mcp.rs:306`, `src/hooks/useMcpEntryEvents.ts:24-33`):**
//!   `encode_diff_v1(&sv_before)` emits `mcp:entry-changed` so an open TipTap editor absorbs changes.
//! - **Content persistence:**
//!   `save_entry_content_impl` (`commands/entries.rs:334-346`) persists `yjs_doc`, `content_text`,
//!   and `preview_text` in a transaction.
//! - **Embedding indexing & language detection:**
//!   `maybe_mark_entry_embedding_dirty_after_save` (`commands/entries.rs:38`) queues embedding
//!   dirty jobs and detects language.
//! - **Size limits:**
//!   `MAX_YJS_DOC_BYTES` (`commands/entries.rs:1052`, 10 MiB) guards document size.
//! - **Version snapshots:**
//!   `snapshot_entry_version_impl` (`commands/entries.rs:1322`) records an immutable history snapshot.
//! - **Media handling:**
//!   `get_media_upload_limits` / `get_media_upload_limits_inner` (`commands/media.rs:1993`) checks quotas.
//!   The media file creation pattern (`commands/media.rs:242`) saves media under `media_dir`.
//!
//! ---
//!
//! ## (d) Field Setters & `updated_at` Timestamp Contracts
//!
//! Setters in `db/queries.rs`:
//! - `create_entry` (`queries.rs:1046`): stamps `now_unix()`.
//! - `update_entry_emotion` (`queries.rs:2633`): stamps `now_unix()`.
//! - `update_entry_title` (`queries.rs:2687`): stamps `now_unix()`.
//! - `update_entry_date` (`queries.rs:2705`): stamps `now_unix()`.
//! - `update_entry_journal` (`queries.rs:2733`): stamps `now_unix()`.
//! - `set_entry_language` (`queries.rs:3504-3516`): stamps `now_unix()`.
//! - `mark_entry_date_user_edited` (`queries.rs:2723`): flags `entry_date_user_edited = 1` without bumping `updated_at`.
//! - `touch_entry_updated_at` (`queries.rs:3145`): uses `MAX(?1, updated_at + 1)` to ensure monotonicity.
//! - Tag associations (`commands/tags.rs:115, 129`): call `touch_entry_updated_at`.
//!
//! ---
//!
//! ## (e) `sync_state` Reset Invariants & Reset Hooks
//!
//! The additive table `web_outbox_imports` must be cleared ONLY on true user-data wipe:
//! - **Clear table on:**
//!   1. `hard_wipe_user_data` (`queries.rs:689-701`).
//!   2. `reset_all_sync_state_to_pending` (`queries.rs:7904`).
//! - **Keep table on:**
//!   1. `reset_local_sync_state` (`commands/sync.rs:1390`, callers `sync.rs:810, 1464`, `gdrive.rs:1472, 4374`).
//!   2. `run_repair_from_this_device` (`commands/sync.rs:1497`).
//!   3. `mark_scope_upgrade_required_in_tx` (`commands/sync.rs:1627`).
//!   4. Provider disconnect / reconnect (`gdrive_provider.rs:1285`).
//!   5. Surface push invalidation (`engine.rs:220`).
//!   6. Local-authoritative rebuild (`adopt_all_local_entries`, `queries.rs:7938`).
//!
//! The acks file (`outbox-acks.bin`) on Drive self-heals: every rewrite merges known
//! `created: true` statuses so imported entries are never resurrected as duplicates.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use bincode::Options;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::ai::persona_builder::sanitize_persona_text;
use crate::ai::provider::settings_keys;
use crate::commands::entries::{
    maybe_detect_language_after_save, maybe_mark_entry_embedding_dirty_after_save,
    move_entry_to_journal_impl, purge_entry_impl, restore_entry_impl, save_entry_content_impl,
    snapshot_entry_version_impl, soft_delete_entry_impl, toggle_favorite_impl,
    update_entry_date_impl, update_entry_emotion_impl, update_entry_impl,
    update_entry_location_impl,
};
use crate::commands::journals::{delete_journal_impl, update_journal_impl, JournalImplError};
use crate::commands::mcp::{
    load_yjs_doc, require_writable_entry, validate_emotion, visible_journal,
};
use crate::commands::media::{
    delete_media_inner, is_safe_cache_filename, mime_from_ext, sanitize_attachment_filename,
    update_media_insertion_mode_impl,
};
use crate::commands::tags::{delete_tag_impl, update_tag_impl, UpdateTagError};
use crate::db;
use crate::db::queries::{
    existing_tag_ids, get_media, outbox_import_get, outbox_import_record, CreateEntryParams,
    CreateMediaWithIdParams, LockedView, WebOutboxImportRecord,
};
use crate::sync::engine::{ConnAccess, SyncProgressEvent, SyncProgressPhase, SyncSummary};
use crate::sync::keyring_v2::KeyringV2Io;
use crate::sync::metadata::DeviceMetadata;
use crate::sync::provider::{ConditionalRead, FileKind, SyncError, SyncProvider};
use crate::AppState;
use memlore_core::envelope::open_media;
use memlore_core::key_state::ContentKeyList;
use memlore_core::outbox::{
    check_intent_name, check_intent_name_v3, open_outbox_acks, open_outbox_intent,
    parse_intent_name, seal_outbox_acks, FieldChange, MediaInsertionMode, OutboxAckEntry,
    OutboxAcksV1, OutboxEntryV1, OutboxError, OutboxFieldDecision, OutboxIntent as WireIntent,
    OutboxIntentPrefix, OutboxIntentV2, OutboxIntentV3, OutboxLocation, SUPPORTED_OUTBOX_VERSIONS,
};

const PREVIEW_MAX_CHARS: usize = 200;
/// Refusal reason (ack `refused_reason`) for a v1 edit to an entry in Trash.
const ENTRY_TRASHED: &str = "entry_trashed";
/// Refusal reasons for v2 intents (ack `refused_reason`).
const NAME_TAKEN: &str = "name_taken";
const CHANGED_ON_DESKTOP: &str = "changed_on_desktop";
/// A deterministic validation failure (bad color, name, base64, size, …): final.
const INVALID: &str = "invalid";
/// The target is unknown here and not live on any peer (shared with v1). v2 trash also
/// uses it for every locked, invisible or purged target, so a refusal reveals nothing.
const ABSENT: &str = "absent";
/// `delete_journal` refusals (Q1): the main vault would lose its last journal, or the
/// journal still holds entry rows (some of which the web cannot see).
const LAST_JOURNAL: &str = "last_journal";
/// `restore_entry` / `purge_entry` on an entry that is not in Trash (live, or purged).
const NOT_IN_TRASH: &str = "not_in_trash";
const JOURNAL_NOT_EMPTY: &str = "journal_not_empty";
const MEDIA_ENTRY_MISMATCH: &str = "media_entry_mismatch";
/// `attach_media` of a file whose extension the desktop file picker treats as an image,
/// video or audio (`mime_from_ext`): those travel through their own paths.
const MEDIA_NOT_ALLOWED: &str = "media_not_allowed";
/// `attach_media` of a media id this desktop holds a tombstone for: deleted here or on a
/// peer. Media ids are never reused, so it is never re-created.
const MEDIA_DELETED: &str = "media_deleted";

fn sync_io(e: impl ToString) -> SyncError {
    SyncError::Io(e.to_string())
}

/// Outcome of applying an outbox intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    Refused(String),
    Transient,
    SkippedVersion(u16),
    Corrupt(String),
}

/// Context passed to the pure apply logic.
#[derive(Debug, Clone)]
pub struct ApplyContext {
    /// entry_id -> is_deleted (true if tombstoned in peer/own cloud manifests).
    pub known_ids: HashMap<String, bool>,
    /// Whether the pull leg of this cycle completed with 0 errors.
    pub pull_clean: bool,
    /// Desktop's own historical acknowledgements (`outbox-acks.bin`).
    pub own_acks: HashMap<String, OutboxAckEntry>,
    /// Local media storage directory for saving attached images/videos.
    pub media_dir: PathBuf,
}

impl ApplyContext {
    pub fn new(media_dir: PathBuf) -> Self {
        Self {
            known_ids: HashMap::new(),
            pull_clean: true,
            own_acks: HashMap::new(),
            media_dir,
        }
    }
}

/// Decrypted outbox intent and associated downloaded media.
#[derive(Debug, Clone)]
pub struct OutboxIntent {
    pub path: String,
    pub entry: OutboxEntryV1,
    pub content_hash: String,
    pub revision: Option<String>,
    pub media_payloads: HashMap<String, Option<Vec<u8>>>,
    pub media_thumb_payloads: HashMap<String, Option<Vec<u8>>>,
}

/// Live bridge event emitted to the frontend editor upon successful import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxBridgeEvent {
    pub kind: String, // "created", "appended", "metadata"
    pub entry_id: String,
    pub journal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yjs_update: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<serde_json::Value>,
}

/// Detailed result of applying an intent.
#[derive(Debug, Clone)]
pub struct ApplyResult {
    pub outcome: Outcome,
    pub touched_entry_ids: Vec<String>,
    pub bridge_event: Option<OutboxBridgeEvent>,
}

/// Pending plan saved to the DB before mutations begin, ensuring crash safety.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PendingPlan {
    pub is_create: bool,
    pub local_before: i64,
}

/// Deterministic fingerprint of an entry's current metadata state.
pub fn compute_metadata_fingerprint(
    title: Option<&str>,
    entry_date: i64,
    emotion: Option<&str>,
    is_favorite: bool,
    journal_id: &str,
    tag_ids: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(entry_date.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(emotion.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(if is_favorite { [1u8] } else { [0u8] });
    hasher.update(b"\0");
    hasher.update(journal_id.as_bytes());
    hasher.update(b"\0");
    let mut sorted_tags = tag_ids.to_vec();
    sorted_tags.sort();
    for tag in &sorted_tags {
        hasher.update(tag.as_bytes());
        hasher.update(b",");
    }
    hex::encode(hasher.finalize())
}

/// Parse an entry date string into Unix epoch seconds.
pub fn parse_entry_date(s: &str) -> Option<i64> {
    if let Ok(ts) = s.parse::<i64>() {
        return Some(ts);
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp());
    }
    None
}

/// Map allowed MIME types to safe, canonical extensions.
fn ext_from_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/heic" => Some("heic"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/mp4" => Some("mp4"),
        "video/quicktime" => Some("mov"),
        // `attach_media` only (core validate keeps audio off the v1 media list). Never
        // add these to `mime_from_ext`: the desktop file picker refuses what it maps.
        "audio/wav" => Some("wav"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        _ => None,
    }
}

/// Resolve a visible, non-locked journal for creation, falling back safely.
pub(crate) fn resolve_safe_journal(
    conn: &Connection,
    preferred_id: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(id) = preferred_id {
        if let Ok(Some((jid, name))) = visible_journal(conn, id) {
            let is_locked: bool = conn
                .query_row(
                    "SELECT is_locked FROM journals WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if !is_locked {
                return Ok((jid, name));
            }
        }
    }
    if let Ok(Some(default_id)) =
        db::queries::get_setting(conn, settings_keys::MCP_DEFAULT_JOURNAL_ID)
    {
        if let Ok(Some((jid, name))) = visible_journal(conn, &default_id) {
            let is_locked: bool = conn
                .query_row(
                    "SELECT is_locked FROM journals WHERE id = ?1",
                    [&default_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if !is_locked {
                return Ok((jid, name));
            }
        }
    }
    let journals = db::queries::list_journals(conn, None).map_err(|e| e.to_string())?;
    for j in journals {
        if !j.is_deleted && !j.is_invisible && !j.is_locked {
            return Ok((j.id, j.name));
        }
    }
    Err("NO_VALID_JOURNAL".to_string())
}

/// Evaluate a field change according to the decide-once, no-clocks rule:
/// Returns (decision, should_apply).
/// `own_prior`: every change to the entry since the web's `base_updated_at` was an own apply
/// of this web device (`own_chain_reaches` over the entry's edges), so the local value is the
/// web's own earlier value. The web keeps the base of its first unresolved edit, and a web
/// create has the synthetic base `""` / 0, so `local_val == base` alone would refuse the web's
/// second edit of a field it already set. `untouched`: nothing changed the row since this
/// path's last apply; only then does an equal base VALUE (no stamp evidence) apply.
fn evaluate_field<T: PartialEq>(
    local_val: &T,
    change: &FieldChange<T>,
    local_before: i64,
    untouched: bool,
    own_prior: bool,
) -> (&'static str, bool) {
    if local_val == &change.value {
        ("reflected", false)
    } else if local_before == change.base_updated_at || own_prior {
        ("applied", true)
    } else if untouched && local_val == &change.base {
        ("applied", true)
    } else {
        ("refused", false)
    }
}

/// Apply media attachments from the intent to disk and the database.
fn apply_media_items(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    media_items: &[memlore_core::outbox::OutboxMediaRef],
    payloads: &HashMap<String, Option<Vec<u8>>>,
    thumb_payloads: &HashMap<String, Option<Vec<u8>>>,
) -> Result<bool, String> {
    let mut any_created = false;
    for m in media_items {
        if let Ok(Some(existing)) = db::queries::get_media(conn, &m.media_id) {
            if existing.entry_id != entry_id {
                return Err("media_entry_mismatch".to_string());
            }
            continue;
        }
        // Deleted (here or on a peer): never re-create it.
        if db::queries::media_tombstone_exists(conn, &m.media_id).map_err(|e| e.to_string())? {
            continue;
        }

        let bytes = payloads
            .get(&m.media_id)
            .and_then(|o| o.as_ref())
            .ok_or_else(|| format!("missing media payload for {}", m.media_id))?;
        let ext = ext_from_mime(&m.file_type)
            .ok_or_else(|| format!("unsupported mime: {}", m.file_type))?;
        let thumb = if m.has_thumb {
            thumb_payloads.get(&m.media_id).and_then(|t| t.as_deref())
        } else {
            None
        };

        let inserted = store_media(
            conn,
            media_dir,
            StoredMedia {
                id: &m.media_id,
                entry_id,
                ext,
                file_type: &m.file_type,
                bytes,
                thumb,
                insertion_mode: "inline",
                duration_seconds: None,
            },
        )?;

        if inserted {
            db::queries::mark_entry_pending(conn, entry_id).map_err(|e| e.to_string())?;
            any_created = true;
        }
    }
    Ok(any_created)
}

/// One downloaded media blob, stored as `<media_dir>/<id>.<ext>` (thumbnail beside it).
struct StoredMedia<'a> {
    id: &'a str,
    entry_id: &'a str,
    ext: &'a str,
    file_type: &'a str,
    bytes: &'a [u8],
    thumb: Option<&'a [u8]>,
    insertion_mode: &'a str,
    duration_seconds: Option<f64>,
}

/// Write the blob, then create its row (`create_media_with_id`, which touches the entry
/// stamp). Returns whether the row was inserted. The caller marks the entry pending.
fn store_media(conn: &Connection, media_dir: &Path, m: StoredMedia) -> Result<bool, String> {
    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;
    let dest_path = media_dir.join(format!("{}.{}", m.id, m.ext));
    std::fs::write(&dest_path, m.bytes).map_err(|e| e.to_string())?;

    let thumb_path = match m.thumb {
        Some(thumb_bytes) => {
            let t_path = media_dir.join(format!("{}.thumb.jpg", m.id));
            std::fs::write(&t_path, thumb_bytes).map_err(|e| e.to_string())?;
            Some(t_path)
        }
        None => None,
    };

    db::queries::create_media_with_id(
        conn,
        CreateMediaWithIdParams {
            id: m.id,
            entry_id: m.entry_id,
            extension: m.ext,
            file_type: m.file_type,
            storage_path: dest_path.to_str().ok_or("invalid dest path")?,
            thumbnail_path: thumb_path.as_ref().and_then(|p| p.to_str()),
            file_size: Some(m.bytes.len() as i64),
            sort_order: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: m.insertion_mode,
            width: None,
            height: None,
            duration_seconds: m.duration_seconds,
        },
    )
    .map_err(|e| e.to_string())
}

/// Pure apply logic for ingesting a single outbox intent without network calls.
/// Holds the DB connection only for the duration of this call.
pub fn apply_intent(
    conn: &Connection,
    ctx: &ApplyContext,
    intent: &OutboxIntent,
) -> (Outcome, Vec<String>) {
    let res = apply_intent_full(conn, ctx, intent);
    (res.outcome, res.touched_entry_ids)
}

/// Full implementation of `apply_intent`, producing an `ApplyResult` with bridge events.
pub fn apply_intent_full(
    conn: &Connection,
    ctx: &ApplyContext,
    intent: &OutboxIntent,
) -> ApplyResult {
    // 0. Schema version and payload validation
    if !SUPPORTED_OUTBOX_VERSIONS.contains(&intent.entry.schema_version) {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "skipped_version".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: Some(intent.entry.schema_version.to_string()),
            created: false,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::SkippedVersion(intent.entry.schema_version),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    if let Err(e) = intent.entry.validate() {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "corrupt".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: Some(e.to_string()),
            created: false,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Corrupt(e.to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    // 1. Behind-desktop check & missing media check
    if !ctx.pull_clean {
        return ApplyResult {
            outcome: Outcome::Transient,
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    for m in &intent.entry.media {
        match intent.media_payloads.get(&m.media_id) {
            Some(Some(_)) => {}
            _ => {
                return ApplyResult {
                    outcome: Outcome::Transient,
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        }
        if m.has_thumb {
            match intent.media_thumb_payloads.get(&m.media_id) {
                Some(Some(_)) => {}
                _ => {
                    return ApplyResult {
                        outcome: Outcome::Transient,
                        touched_entry_ids: vec![],
                        bridge_event: None,
                    };
                }
            }
        }
    }

    // Load existing import record
    let existing_import = outbox_import_get(conn, &intent.path).unwrap_or(None);
    let mut decided_map: BTreeMap<String, OutboxFieldDecision> = existing_import
        .as_ref()
        .and_then(|r| r.decided_fields.as_deref())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let sticky_created = existing_import.as_ref().map(|r| r.created).unwrap_or(false);

    // 2. Presence check
    let raw_entry = db::queries::get_entry_raw(conn, &intent.entry.entry_id).unwrap_or(None);

    if raw_entry.is_none() {
        // (i) Known live in cloud manifests -> Transient
        if let Some(&is_deleted) = ctx.known_ids.get(&intent.entry.entry_id) {
            if !is_deleted {
                return ApplyResult {
                    outcome: Outcome::Transient,
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
            // (ii) Known deleted in cloud manifests -> Refused("absent")
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some("absent".to_string()),
                created: sticky_created,
                applied_from_updated_at: None,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("absent".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }

        // Not created on web -> Refused("absent")
        if !intent.entry.created_on_web {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some("absent".to_string()),
                created: sticky_created,
                applied_from_updated_at: None,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("absent".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }

        // (iii) Wipe-resurrection guard: own_acks or sticky created reports created
        let own_ack_created = ctx
            .own_acks
            .get(&intent.path)
            .map(|a| a.created)
            .unwrap_or(false);
        if sticky_created || own_ack_created {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some("absent".to_string()),
                created: true,
                applied_from_updated_at: None,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("absent".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }

        // (iv) Valid create path
        let target_jid = intent
            .entry
            .fields
            .journal_id
            .as_ref()
            .map(|j| j.value.as_str());
        let (journal_id, _) = match resolve_safe_journal(conn, target_jid) {
            Ok(pair) => pair,
            Err(_) => {
                let rec = WebOutboxImportRecord {
                    path: intent.path.clone(),
                    revision: intent.revision.clone(),
                    content_hash: intent.content_hash.clone(),
                    outcome: "refused".to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: serde_json::to_string(&decided_map).ok(),
                    pending_revision: None,
                    pending_plan: Some("no_journal".to_string()),
                    created: sticky_created,
                    applied_from_updated_at: None,
                };
                let _ = outbox_import_record(conn, &rec);
                return ApplyResult {
                    outcome: Outcome::Refused("no_journal".to_string()),
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        };

        let entry_date = intent
            .entry
            .fields
            .entry_date
            .as_ref()
            .and_then(|d| parse_entry_date(&d.value))
            .unwrap_or(intent.entry.web_updated_at_secs);
        let title = intent.entry.fields.title.as_ref().map(|t| t.value.as_str());
        let content_text = intent.entry.content_text.as_deref().unwrap_or("");
        let preview_text = intent.entry.preview_text.as_deref().unwrap_or("");

        // Two-phase crash safety: record 'pending' before first mutation in create path
        let pending_rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: existing_import.as_ref().and_then(|r| r.revision.clone()),
            content_hash: intent.content_hash.clone(),
            outcome: "pending".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: existing_import
                .as_ref()
                .and_then(|r| r.last_applied_updated_at),
            post_import_fingerprint: existing_import
                .as_ref()
                .and_then(|r| r.post_import_fingerprint.clone()),
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: intent.revision.clone(),
            pending_plan: serde_json::to_string(&PendingPlan {
                is_create: true,
                local_before: 0,
            })
            .ok(),
            created: sticky_created,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &pending_rec);

        let inserted = match db::queries::create_entry_with_id(
            conn,
            &intent.entry.entry_id,
            CreateEntryParams {
                journal_id: &journal_id,
                title,
                content_text: Some(content_text),
                preview_text: Some(preview_text),
                entry_date,
            },
        ) {
            Ok(b) => b,
            Err(e) => {
                return ApplyResult {
                    outcome: Outcome::Refused(e.to_string()),
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        };

        if inserted {
            // Write Yjs document
            let yjs_bytes = if intent.entry.yjs_full_state.is_empty() {
                Doc::new()
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default())
            } else {
                intent.entry.yjs_full_state.clone()
            };
            if let Err(e) = save_entry_content_impl(
                conn,
                &intent.entry.entry_id,
                &yjs_bytes,
                content_text,
                preview_text,
            ) {
                return ApplyResult {
                    outcome: Outcome::Refused(e),
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }

            if intent.entry.fields.entry_date.is_some() {
                let _ = db::queries::mark_entry_date_user_edited(conn, &intent.entry.entry_id);
            }
            if let Some(em) = &intent.entry.fields.emotion {
                let _ =
                    update_entry_emotion_impl(conn, &intent.entry.entry_id, em.value.as_deref());
            }
            if let Some(fav) = &intent.entry.fields.is_favorite {
                if fav.value {
                    let _ = toggle_favorite_impl(conn, &intent.entry.entry_id);
                }
            }
            for (tag_id, change) in &intent.entry.fields.tags_add {
                if change.value {
                    if let Ok(valid) = existing_tag_ids(conn, &[tag_id.as_str()]) {
                        if valid.contains(tag_id) {
                            let _ =
                                db::queries::add_tag_to_entry(conn, &intent.entry.entry_id, tag_id);
                        }
                    }
                }
            }
            for (tag_id, change) in &intent.entry.fields.tags_remove {
                if change.value {
                    let _ =
                        db::queries::remove_tag_from_entry(conn, &intent.entry.entry_id, tag_id);
                }
            }

            // Media
            let _ = apply_media_items(
                conn,
                &ctx.media_dir,
                &intent.entry.entry_id,
                &intent.entry.media,
                &intent.media_payloads,
                &intent.media_thumb_payloads,
            );

            let _ = db::queries::mark_entry_pending(conn, &intent.entry.entry_id);

            // Record all fields as applied
            let now = chrono::Utc::now().timestamp();
            if let Some(t) = &intent.entry.fields.title {
                decided_map.insert(
                    format!("title@{}", t.change_seq),
                    OutboxFieldDecision {
                        field: "title".to_string(),
                        change_seq: t.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(d) = &intent.entry.fields.entry_date {
                decided_map.insert(
                    format!("entry_date@{}", d.change_seq),
                    OutboxFieldDecision {
                        field: "entry_date".to_string(),
                        change_seq: d.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(e) = &intent.entry.fields.emotion {
                decided_map.insert(
                    format!("emotion@{}", e.change_seq),
                    OutboxFieldDecision {
                        field: "emotion".to_string(),
                        change_seq: e.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(f) = &intent.entry.fields.is_favorite {
                decided_map.insert(
                    format!("is_favorite@{}", f.change_seq),
                    OutboxFieldDecision {
                        field: "is_favorite".to_string(),
                        change_seq: f.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(j) = &intent.entry.fields.journal_id {
                decided_map.insert(
                    format!("journal_id@{}", j.change_seq),
                    OutboxFieldDecision {
                        field: "journal_id".to_string(),
                        change_seq: j.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            for (tag_id, c) in &intent.entry.fields.tags_add {
                decided_map.insert(
                    format!("tag_add:{}@{}", tag_id, c.change_seq),
                    OutboxFieldDecision {
                        field: format!("tag_add:{}", tag_id),
                        change_seq: c.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            for (tag_id, c) in &intent.entry.fields.tags_remove {
                decided_map.insert(
                    format!("tag_remove:{}@{}", tag_id, c.change_seq),
                    OutboxFieldDecision {
                        field: format!("tag_remove:{}", tag_id),
                        change_seq: c.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }

            maybe_detect_language_after_save(conn, &intent.entry.entry_id);

            // Step 8: read final entry and store record
            let final_entry = db::queries::get_entry(conn, &intent.entry.entry_id)
                .ok()
                .flatten();
            let final_updated_at = final_entry.as_ref().map(|e| e.updated_at).unwrap_or(now);
            let final_tags = db::queries::get_tag_ids_for_entry(conn, &intent.entry.entry_id)
                .unwrap_or_default();
            let final_fp = compute_metadata_fingerprint(
                final_entry.as_ref().and_then(|e| e.title.as_deref()),
                final_entry
                    .as_ref()
                    .map(|e| e.entry_date)
                    .unwrap_or(entry_date),
                final_entry.as_ref().and_then(|e| e.emotion.as_deref()),
                final_entry.as_ref().map(|e| e.is_favorite).unwrap_or(false),
                &journal_id,
                &final_tags,
            );

            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "applied".to_string(),
                imported_at: now,
                last_applied_updated_at: Some(final_updated_at),
                post_import_fingerprint: Some(final_fp),
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: None,
                created: true,
                applied_from_updated_at: Some(APPLIED_FROM_CREATED),
            };
            let _ = outbox_import_record(conn, &rec);

            let bridge_event = OutboxBridgeEvent {
                kind: "created".to_string(),
                entry_id: intent.entry.entry_id.clone(),
                journal_id,
                yjs_update: None,
                patch: None,
            };

            return ApplyResult {
                outcome: Outcome::Applied,
                touched_entry_ids: vec![intent.entry.entry_id.clone()],
                bridge_event: Some(bridge_event),
            };
        }
    }

    // ── Present Entry Path ──────────────────────────────────────────────────
    // A trashed entry (`is_deleted = 1` + `trashed_at`) is read-only until
    // restored. Refuse with its own reason so the web can tell it apart from
    // a purged or missing entry (which stay on `require_writable_entry`).
    if raw_entry
        .as_ref()
        .is_some_and(|e| e.is_deleted && e.trashed_at.is_some())
    {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "refused".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: None,
            pending_plan: Some(ENTRY_TRASHED.to_string()),
            created: sticky_created,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Refused(ENTRY_TRASHED.to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }
    let entry = match require_writable_entry(conn, &intent.entry.entry_id) {
        Ok(e) => e,
        Err(e) => {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some(e),
                created: sticky_created,
                applied_from_updated_at: None,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("target_not_writable".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }
    };

    // Check visible and unlocked journal
    let j_locked: bool = conn
        .query_row(
            "SELECT is_locked FROM journals WHERE id = ?1",
            [&entry.journal_id],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if visible_journal(conn, &entry.journal_id)
        .ok()
        .flatten()
        .is_none()
        || j_locked
    {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "refused".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: None,
            pending_plan: Some("journal_locked_or_invisible".to_string()),
            created: sticky_created,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Refused("journal_locked_or_invisible".to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    if let Some(em) = &intent.entry.fields.emotion {
        if let Err(e) = validate_emotion(em.value.as_deref()) {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some(e),
                created: sticky_created,
                applied_from_updated_at: None,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("invalid_emotion".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }
    }

    // Step 3: Snapshot local_before once (restoring from pending_plan if resuming after crash)
    let restored_pending_plan: Option<PendingPlan> = existing_import
        .as_ref()
        .and_then(|r| r.pending_plan.as_deref())
        .and_then(|s| serde_json::from_str(s).ok());
    let local_before = restored_pending_plan
        .map(|p| p.local_before)
        .unwrap_or(entry.updated_at);

    // Own-apply edges of this entry, read before this apply's pending record replaces
    // its path's row (README "Own-path chaining").
    let chain_edges =
        match db::queries::outbox_import_entry_edges(conn, outbox_dir(&intent.path), &entry.id) {
            Ok(edges) => edges,
            Err(e) => {
                log::warn!("outbox_import: chain edges for {} failed: {e}", intent.path);
                return ApplyResult {
                    outcome: Outcome::Transient,
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        };

    // Step 4: Content decision & Empty base guard
    let existing_blob = db::queries::get_entry_content(conn, &entry.id).unwrap_or(None);
    let local_doc = match load_yjs_doc(existing_blob.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            return ApplyResult {
                outcome: Outcome::Refused(e),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }
    };
    let sv_before = local_doc.transact().state_vector();
    let local_has_content = !sv_before.is_empty()
        || existing_blob
            .as_ref()
            .map(|b| !b.is_empty())
            .unwrap_or(false)
        || entry
            .content_text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);

    if intent.entry.base_state_vector.is_empty()
        && local_has_content
        && !intent.entry.created_on_web
    {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "refused".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: None,
            pending_plan: Some("empty_base".to_string()),
            created: sticky_created,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Refused("empty_base".to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    // Two-phase crash safety: record 'pending' before first mutation
    let pending_rec = WebOutboxImportRecord {
        path: intent.path.clone(),
        revision: existing_import.as_ref().and_then(|r| r.revision.clone()),
        content_hash: intent.content_hash.clone(),
        outcome: "pending".to_string(),
        imported_at: chrono::Utc::now().timestamp(),
        last_applied_updated_at: existing_import
            .as_ref()
            .and_then(|r| r.last_applied_updated_at),
        post_import_fingerprint: existing_import
            .as_ref()
            .and_then(|r| r.post_import_fingerprint.clone()),
        decided_fields: serde_json::to_string(&decided_map).ok(),
        pending_revision: intent.revision.clone(),
        pending_plan: serde_json::to_string(&PendingPlan {
            is_create: false,
            local_before,
        })
        .ok(),
        created: sticky_created,
        // Kept so a crash-resume still sees this path's chain (`own_prior`).
        applied_from_updated_at: existing_import
            .as_ref()
            .and_then(|r| r.applied_from_updated_at),
    };
    let _ = outbox_import_record(conn, &pending_rec);

    let mut touched_entry_ids = Vec::new();
    let mut content_changed = false;
    let mut yjs_diff_bytes: Option<Vec<u8>> = None;

    if !intent.entry.yjs_full_state.is_empty() {
        if let Ok(update) = Update::decode_v1(&intent.entry.yjs_full_state) {
            let _ = local_doc.transact_mut().apply_update(update);
            let sv_after = local_doc.transact().state_vector();
            let diff = local_doc.transact().encode_diff_v1(&sv_before);
            if sv_before != sv_after || diff != [0, 0] {
                content_changed = true;
                yjs_diff_bytes = Some(diff);
            }
        }
    }

    if content_changed {
        let _ = snapshot_entry_version_impl(
            conn,
            &entry.id,
            existing_blob.as_deref().unwrap_or(&[]),
            entry.preview_text.as_deref().unwrap_or(""),
        );
        let full_state = local_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        // The text is read from the merged doc, so it holds both sides'
        // edits exactly once, as the editor would save it.
        let (content_text, preview_text) = crate::yjs_doc::extract_entry_text(&full_state)
            .unwrap_or_else(|| {
                let text = intent
                    .entry
                    .content_text
                    .clone()
                    .or_else(|| entry.content_text.clone())
                    .unwrap_or_default();
                let preview = text.chars().take(PREVIEW_MAX_CHARS).collect();
                (text, preview)
            });
        let _ = save_entry_content_impl(conn, &entry.id, &full_state, &content_text, &preview_text);
        touched_entry_ids.push(entry.id.clone());
    }

    // Step 5: Fields decision
    let current_tag_ids = db::queries::get_tag_ids_for_entry(conn, &entry.id).unwrap_or_default();
    let current_fp = compute_metadata_fingerprint(
        entry.title.as_deref(),
        entry.entry_date,
        entry.emotion.as_deref(),
        entry.is_favorite,
        &entry.journal_id,
        &current_tag_ids,
    );
    let untouched = match (
        existing_import
            .as_ref()
            .and_then(|r| r.last_applied_updated_at),
        existing_import
            .as_ref()
            .and_then(|r| r.post_import_fingerprint.as_ref()),
    ) {
        (Some(last_applied), Some(last_fp)) => {
            local_before == last_applied && current_fp == *last_fp
        }
        _ => false,
    };
    // Every desktop setter stamps `MAX(updated_at + 1, now)`, so a desktop change after
    // this path's last apply always moves the stamp past the one it recorded. The
    // fingerprint is a second guard for writers that set a stamp verbatim (a pulled
    // peer row whose stamp can equal it).
    let fp_clean = match existing_import.as_ref() {
        Some(r) if r.last_applied_updated_at == Some(local_before) => r
            .post_import_fingerprint
            .as_ref()
            .is_none_or(|fp| *fp == current_fp),
        _ => true,
    };
    let own_prior = |base_updated_at: i64| {
        fp_clean && chain_reaches(&chain_edges, base_updated_at, local_before)
    };
    // A base with stamp evidence that only own applies touched the entry since it.
    let chains =
        |base_updated_at: i64| local_before == base_updated_at || own_prior(base_updated_at);
    // Bases of the fields applied by `chains`: the smallest becomes this apply's edge start.
    let mut chain_bases: Vec<i64> = Vec::new();

    let now = chrono::Utc::now().timestamp();
    let mut journal_or_tags_changed = false;

    // Field: title
    if let Some(t) = &intent.entry.fields.title {
        let key = format!("title@{}", t.change_seq);
        if !decided_map.contains_key(&key) {
            let local_title = entry.title.clone().unwrap_or_default();
            let (decision, should_apply) = evaluate_field(
                &local_title,
                t,
                local_before,
                untouched,
                own_prior(t.base_updated_at),
            );
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply && chains(t.base_updated_at) {
                chain_bases.push(t.base_updated_at);
            }
            if should_apply {
                if let Err(e) = update_entry_impl(conn, &entry.id, Some(&t.value), None, None) {
                    final_decision = "refused".to_string();
                    reason = Some(e);
                } else {
                    touched_entry_ids.push(entry.id.clone());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "title".to_string(),
                    change_seq: t.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: entry_date
    if let Some(d) = &intent.entry.fields.entry_date {
        let key = format!("entry_date@{}", d.change_seq);
        if !decided_map.contains_key(&key) {
            let local_ts = entry.entry_date;
            let val_ts = parse_entry_date(&d.value);
            let base_ts = parse_entry_date(&d.base);
            let mut final_decision = "refused".to_string();
            let mut reason = None;

            if let Some(v_ts) = val_ts {
                if local_ts == v_ts {
                    final_decision = "reflected".to_string();
                } else if chains(d.base_updated_at) || (untouched && Some(local_ts) == base_ts) {
                    if chains(d.base_updated_at) {
                        chain_bases.push(d.base_updated_at);
                    }
                    if let Err(e) = update_entry_date_impl(conn, &entry.id, v_ts) {
                        final_decision = "refused".to_string();
                        reason = Some(e);
                    } else {
                        let _ = db::queries::mark_entry_date_user_edited(conn, &entry.id);
                        final_decision = "applied".to_string();
                        touched_entry_ids.push(entry.id.clone());
                    }
                }
            } else {
                reason = Some("invalid_date".to_string());
            }

            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "entry_date".to_string(),
                    change_seq: d.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: emotion
    if let Some(em) = &intent.entry.fields.emotion {
        let key = format!("emotion@{}", em.change_seq);
        if !decided_map.contains_key(&key) {
            let (decision, should_apply) = evaluate_field(
                &entry.emotion,
                em,
                local_before,
                untouched,
                own_prior(em.base_updated_at),
            );
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply && chains(em.base_updated_at) {
                chain_bases.push(em.base_updated_at);
            }
            if should_apply {
                if let Err(e) = update_entry_emotion_impl(conn, &entry.id, em.value.as_deref()) {
                    final_decision = "refused".to_string();
                    reason = Some(e);
                } else {
                    touched_entry_ids.push(entry.id.clone());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "emotion".to_string(),
                    change_seq: em.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: is_favorite
    if let Some(f) = &intent.entry.fields.is_favorite {
        let key = format!("is_favorite@{}", f.change_seq);
        if !decided_map.contains_key(&key) {
            let (decision, should_apply) = evaluate_field(
                &entry.is_favorite,
                f,
                local_before,
                untouched,
                own_prior(f.base_updated_at),
            );
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply && chains(f.base_updated_at) {
                chain_bases.push(f.base_updated_at);
            }
            if should_apply {
                if entry.is_favorite != f.value {
                    if let Err(e) = toggle_favorite_impl(conn, &entry.id) {
                        final_decision = "refused".to_string();
                        reason = Some(e);
                    } else {
                        touched_entry_ids.push(entry.id.clone());
                    }
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "is_favorite".to_string(),
                    change_seq: f.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: journal_id
    if let Some(j) = &intent.entry.fields.journal_id {
        let key = format!("journal_id@{}", j.change_seq);
        if !decided_map.contains_key(&key) {
            let (decision, should_apply) = evaluate_field(
                &entry.journal_id,
                j,
                local_before,
                untouched,
                own_prior(j.base_updated_at),
            );
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply && chains(j.base_updated_at) {
                chain_bases.push(j.base_updated_at);
            }
            if should_apply {
                let target_visible = visible_journal(conn, &j.value).ok().flatten();
                let target_locked: bool = conn
                    .query_row(
                        "SELECT is_locked FROM journals WHERE id = ?1",
                        [&j.value],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);
                if target_visible.is_some() && !target_locked {
                    if let Err(e) = move_entry_to_journal_impl(conn, &entry.id, &j.value) {
                        final_decision = "refused".to_string();
                        reason = Some(e);
                    } else {
                        touched_entry_ids.push(entry.id.clone());
                        journal_or_tags_changed = true;
                    }
                } else {
                    final_decision = "refused".to_string();
                    reason = Some("journal".to_string());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "journal_id".to_string(),
                    change_seq: j.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: tags_add
    for (tag_id, change) in &intent.entry.fields.tags_add {
        let key = format!("tag_add:{}@{}", tag_id, change.change_seq);
        if !decided_map.contains_key(&key) {
            let is_present = current_tag_ids.contains(tag_id);
            let (decision, should_apply) = evaluate_field(
                &is_present,
                change,
                local_before,
                untouched,
                own_prior(change.base_updated_at),
            );
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply && chains(change.base_updated_at) {
                chain_bases.push(change.base_updated_at);
            }
            if should_apply {
                if let Ok(valid) = existing_tag_ids(conn, &[tag_id.as_str()]) {
                    if valid.contains(tag_id) {
                        let _ = db::queries::add_tag_to_entry(conn, &entry.id, tag_id);
                        let _ = db::queries::mark_entry_pending(conn, &entry.id);
                        touched_entry_ids.push(entry.id.clone());
                        journal_or_tags_changed = true;
                    } else {
                        final_decision = "refused".to_string();
                        reason = Some("tag_not_found".to_string());
                    }
                } else {
                    final_decision = "refused".to_string();
                    reason = Some("error".to_string());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: format!("tag_add:{}", tag_id),
                    change_seq: change.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: tags_remove
    for (tag_id, change) in &intent.entry.fields.tags_remove {
        let key = format!("tag_remove:{}@{}", tag_id, change.change_seq);
        if !decided_map.contains_key(&key) {
            let is_present = current_tag_ids.contains(tag_id);
            let (decision, should_apply) = evaluate_field(
                &!is_present,
                change,
                local_before,
                untouched,
                own_prior(change.base_updated_at),
            );
            let final_decision = decision.to_string();
            let reason = None;
            if should_apply && chains(change.base_updated_at) {
                chain_bases.push(change.base_updated_at);
            }
            if should_apply {
                let _ = db::queries::remove_tag_from_entry(conn, &entry.id, tag_id);
                let _ = db::queries::mark_entry_pending(conn, &entry.id);
                touched_entry_ids.push(entry.id.clone());
                journal_or_tags_changed = true;
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: format!("tag_remove:{}", tag_id),
                    change_seq: change.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Step 6: Media
    if let Ok(media_created) = apply_media_items(
        conn,
        &ctx.media_dir,
        &entry.id,
        &intent.entry.media,
        &intent.media_payloads,
        &intent.media_thumb_payloads,
    ) {
        if media_created {
            touched_entry_ids.push(entry.id.clone());
        }
    }

    // Step 7: Language detection hook
    if !touched_entry_ids.is_empty() {
        maybe_detect_language_after_save(conn, &entry.id);
    }

    // Step 8: Final record
    // Edge start (README "Own-path chaining", v1 base): the smallest base this revision
    // applied with stamp evidence, or this path's previous start while the chain from it
    // still reaches `local_before` (a revision that re-sends only higher bases keeps the
    // web's first base); else `local_before`.
    let prev_from = existing_import
        .as_ref()
        .filter(|r| r.outcome == "applied" || r.outcome == "pending")
        .and_then(|r| r.applied_from_updated_at)
        .filter(|&from| chains(from));
    let applied_from = chain_bases
        .iter()
        .copied()
        .chain(prev_from)
        .min()
        .unwrap_or(local_before);
    let final_entry = db::queries::get_entry(conn, &entry.id)
        .ok()
        .flatten()
        .unwrap_or(entry);
    let final_tags = db::queries::get_tag_ids_for_entry(conn, &final_entry.id).unwrap_or_default();
    let final_fp = compute_metadata_fingerprint(
        final_entry.title.as_deref(),
        final_entry.entry_date,
        final_entry.emotion.as_deref(),
        final_entry.is_favorite,
        &final_entry.journal_id,
        &final_tags,
    );

    let rec = WebOutboxImportRecord {
        path: intent.path.clone(),
        revision: intent.revision.clone(),
        content_hash: intent.content_hash.clone(),
        outcome: "applied".to_string(),
        imported_at: now,
        last_applied_updated_at: Some(final_entry.updated_at),
        post_import_fingerprint: Some(final_fp),
        decided_fields: serde_json::to_string(&decided_map).ok(),
        pending_revision: None,
        pending_plan: None,
        created: sticky_created || intent.entry.created_on_web,
        applied_from_updated_at: Some(applied_from),
    };
    let _ = outbox_import_record(conn, &rec);

    touched_entry_ids.sort();
    touched_entry_ids.dedup();

    let bridge_event = if journal_or_tags_changed {
        Some(OutboxBridgeEvent {
            kind: "created".to_string(),
            entry_id: final_entry.id.clone(),
            journal_id: final_entry.journal_id.clone(),
            yjs_update: None,
            patch: None,
        })
    } else if content_changed || !touched_entry_ids.is_empty() {
        let mut patch = serde_json::Map::new();
        patch.insert(
            "updated_at".to_string(),
            serde_json::json!(final_entry.updated_at),
        );
        if let Some(t) = &final_entry.title {
            patch.insert("title".to_string(), serde_json::json!(t));
        }
        if let Some(e) = &final_entry.emotion {
            patch.insert("emotion".to_string(), serde_json::json!(e));
        }
        patch.insert(
            "is_favorite".to_string(),
            serde_json::json!(final_entry.is_favorite),
        );
        patch.insert(
            "entry_date".to_string(),
            serde_json::json!(final_entry.entry_date),
        );
        let kind = if content_changed {
            "appended"
        } else {
            "metadata"
        };
        Some(OutboxBridgeEvent {
            kind: kind.to_string(),
            entry_id: final_entry.id.clone(),
            journal_id: final_entry.journal_id.clone(),
            yjs_update: yjs_diff_bytes,
            patch: Some(serde_json::Value::Object(patch)),
        })
    } else {
        None
    };

    ApplyResult {
        outcome: Outcome::Applied,
        touched_entry_ids,
        bridge_event,
    }
}

/// Sink for bridge events, progress reports, and embedding dirty notifications.
pub trait OutboxEventSink: Send + Sync {
    fn emit_bridge_event(&self, event: &OutboxBridgeEvent);
    fn emit_progress(&self, current: u32, total: u32);
    fn mark_embedding_dirty(&self, entry_id: &str);
    /// Called right before an intent is applied, in apply order. Test hook.
    fn on_intent_dispatched(&self, _path: &str) {}
}

/// Production sink backed by Tauri AppHandle and AppState.
pub struct TauriOutboxSink<'a> {
    pub app: &'a tauri::AppHandle,
    pub state: &'a AppState,
}

impl<'a> OutboxEventSink for TauriOutboxSink<'a> {
    fn emit_bridge_event(&self, event: &OutboxBridgeEvent) {
        use tauri::Emitter;
        match event.kind.as_str() {
            "created" => {
                let payload = serde_json::json!({
                    "kind": "created",
                    "entryId": event.entry_id,
                    "journalId": event.journal_id,
                });
                let _ = self
                    .app
                    .emit(crate::commands::mcp::MCP_ENTRY_CHANGED_EVENT, payload);
            }
            "appended" => {
                let payload = serde_json::json!({
                    "kind": "appended",
                    "entryId": event.entry_id,
                    "journalId": event.journal_id,
                    "yjsUpdate": event.yjs_update,
                    "patch": event.patch,
                });
                let _ = self
                    .app
                    .emit(crate::commands::mcp::MCP_ENTRY_CHANGED_EVENT, payload);
            }
            "metadata" => {
                let payload = serde_json::json!({
                    "kind": "metadata",
                    "entryId": event.entry_id,
                    "journalId": event.journal_id,
                    "patch": event.patch,
                });
                let _ = self
                    .app
                    .emit(crate::commands::mcp::MCP_ENTRY_CHANGED_EVENT, payload);
            }
            _ => {}
        }
    }

    fn emit_progress(&self, current: u32, total: u32) {
        use tauri::Emitter;
        let event = SyncProgressEvent {
            phase: SyncProgressPhase::ImportingWebEdits,
            current,
            total,
        };
        let _ = self
            .app
            .emit(crate::commands::sync::SYNC_PROGRESS_EVENT, event);
    }

    fn mark_embedding_dirty(&self, entry_id: &str) {
        use tauri::Manager;
        if let Some(indexer) = self.app.try_state::<crate::ai::indexer::EntryIndexer>() {
            maybe_mark_entry_embedding_dirty_after_save(self.state, &indexer, entry_id);
        }
    }
}

/// No-op sink for headless or default testing environments.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopOutboxSink;

impl OutboxEventSink for NoopOutboxSink {
    fn emit_bridge_event(&self, _event: &OutboxBridgeEvent) {}
    fn emit_progress(&self, _current: u32, _total: u32) {}
    fn mark_embedding_dirty(&self, _entry_id: &str) {}
}

/// Summary metrics of an outbox import cycle.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OutboxImportSummary {
    pub candidates_checked: usize,
    pub intents_listed: usize,
    pub intents_applied: usize,
    pub intents_refused: usize,
    pub intents_transient: usize,
    pub intents_skipped_unchanged: usize,
    pub media_downloaded: usize,
    pub media_bytes_downloaded: u64,
    pub acks_written: bool,
}

/// Extract known entry IDs and their deletion status from fetched peer manifests.
pub fn collect_known_ids_from_manifests(
    manifests: &[(String, DeviceMetadata)],
) -> HashMap<String, bool> {
    let mut known = HashMap::new();
    for (_, m) in manifests {
        for e in &m.entries {
            known
                .entry(e.entry_id.clone())
                .and_modify(|d| *d = *d && e.is_deleted)
                .or_insert(e.is_deleted);
        }
    }
    known
}

/// v3 kinds this build APPLIES (`SUPPORTED_OUTBOX_KINDS` is what it can decode). Any
/// other v3 intent is recorded `skipped_kind` / kind name, without an ack, and re-read once
/// a later build lists its kind here. Grows phase by phase; never remove a kind.
pub(crate) const APPLIED_KINDS: &[&str] = &[
    "upsert_tag",
    "upsert_journal",
    "upsert_template",
    "delete_template",
    "trash_entry",
    "delete_tag",
    "delete_journal",
    "restore_entry",
    "purge_entry",
    "empty_trash",
    "set_entry_location",
    "set_media_insertion_mode",
    "attach_media",
    "delete_media",
    "delete_memory_item",
    "update_persona",
];

#[cfg(test)]
thread_local! {
    static APPLIED_KINDS_OVERRIDE: std::cell::Cell<Option<&'static [&'static str]>> =
        const { std::cell::Cell::new(None) };
}

fn applied_kinds() -> &'static [&'static str] {
    #[cfg(test)]
    {
        if let Some(kinds) = APPLIED_KINDS_OVERRIDE.with(std::cell::Cell::get) {
            return kinds;
        }
    }
    APPLIED_KINDS
}

/// Whether a recorded row must be re-read even though its file did not change: a
/// crash-interrupted apply, an intent skipped for a version this build now reads (after
/// a desktop upgrade; v0.2.2 recorded every v2 file as `skipped_version` / "2"), or a v3
/// intent skipped for a kind this build now applies. Refused, corrupt and other skipped
/// rows also fill `pending_plan` (with their reason), but they are final until the intent
/// file changes.
fn is_pending(r: &WebOutboxImportRecord) -> bool {
    match r.outcome.as_str() {
        "pending" => r.pending_plan.is_some(),
        "skipped_version" => r
            .pending_plan
            .as_deref()
            .and_then(|v| v.parse::<u16>().ok())
            .is_some_and(|v| SUPPORTED_OUTBOX_VERSIONS.contains(&v)),
        "skipped_kind" => r
            .pending_plan
            .as_deref()
            .is_some_and(|k| applied_kinds().contains(&k)),
        _ => false,
    }
}

/// Apply rank of an intent kind (README "Kinds" table), ascending. Baked into installed
/// builds: tags run before the journals whose `auto_tag_ids` reference them, creates run
/// before the entry intents that reference them, a restore before the edits of the entry
/// it revives, and deletes last. Only the relative order matters; gaps leave room.
const RANK_TAG: u8 = 10;
const RANK_JOURNAL: u8 = 20;
const RANK_TEMPLATE: u8 = 25;
const RANK_RESTORE: u8 = 28;
const RANK_ENTRY: u8 = 30;
/// `set_entry_location`, `attach_media`, `delete_media`.
const RANK_ENTRY_MEDIA: u8 = 40;
const RANK_INSERTION_MODE: u8 = 45;
/// `trash_entry`, `purge_entry`.
const RANK_TRASH: u8 = 50;
const RANK_EMPTY_TRASH: u8 = 55;
const RANK_DELETE_TAG: u8 = 60;
const RANK_DELETE_JOURNAL: u8 = 70;
/// `delete_memory_item`, `update_persona`.
const RANK_MEMORY: u8 = 80;
/// Read rank of a file letter this build has no kind for: read last.
const RANK_UNKNOWN_LETTER: u8 = u8::MAX;

/// Apply rank of a v2 intent: each prefix carries exactly one v2 kind, ranked with its
/// v3 equivalent (create_tag = upsert_tag, create_journal = upsert_journal).
fn prefix_rank(prefix: OutboxIntentPrefix) -> u8 {
    match prefix {
        OutboxIntentPrefix::Journal => RANK_JOURNAL,
        OutboxIntentPrefix::Tag => RANK_TAG,
        OutboxIntentPrefix::Template => RANK_TEMPLATE,
        OutboxIntentPrefix::Trash => RANK_TRASH,
    }
}

/// Apply rank of a v3 intent, from its decoded kind (never its file letter).
fn v3_rank(intent: &OutboxIntentV3) -> u8 {
    match intent {
        OutboxIntentV3::UpsertTag { .. } => RANK_TAG,
        OutboxIntentV3::UpsertJournal { .. } => RANK_JOURNAL,
        OutboxIntentV3::UpsertTemplate { .. } | OutboxIntentV3::DeleteTemplate { .. } => {
            RANK_TEMPLATE
        }
        OutboxIntentV3::RestoreEntry { .. } => RANK_RESTORE,
        OutboxIntentV3::SetEntryLocation { .. }
        | OutboxIntentV3::AttachMedia { .. }
        | OutboxIntentV3::DeleteMedia { .. } => RANK_ENTRY_MEDIA,
        OutboxIntentV3::SetMediaInsertionMode { .. } => RANK_INSERTION_MODE,
        OutboxIntentV3::TrashEntry { .. } | OutboxIntentV3::PurgeEntry { .. } => RANK_TRASH,
        OutboxIntentV3::EmptyTrash { .. } => RANK_EMPTY_TRASH,
        OutboxIntentV3::DeleteTag { .. } => RANK_DELETE_TAG,
        OutboxIntentV3::DeleteJournal { .. } => RANK_DELETE_JOURNAL,
        OutboxIntentV3::DeleteMemoryItem { .. } | OutboxIntentV3::UpdatePersona { .. } => {
            RANK_MEMORY
        }
    }
}

/// File name (last segment) of an outbox path.
fn outbox_file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Rank guessed from the file name alone, used for the READ order so that a budget cut
/// drops trash and entries, never the creates they depend on. A hint only: a letter can
/// carry several kinds (`d-` is trash, restore, purge), the apply order comes from the
/// decoded kind (`sort_key`). Bare names are entries; unknown letters rank last. A `d-`
/// file whose entry intent is listed too reads right after it (`read_order_key`).
fn path_rank(path: &str) -> u8 {
    match parse_intent_name(outbox_file_name(path)) {
        Ok((letter, _)) => match OutboxIntentPrefix::from_letter(letter) {
            Some(prefix) => prefix_rank(prefix),
            None => match letter {
                'l' | 'a' => RANK_ENTRY_MEDIA,
                'i' => RANK_INSERTION_MODE,
                'y' | 'q' => RANK_MEMORY,
                _ => RANK_UNKNOWN_LETTER,
            },
        },
        Err(_) => RANK_ENTRY,
    }
}

/// `<dir>/<E>.bin` for a `<dir>/d-<E>.bin` path: the entry intent of the same web device
/// that a trash, restore or purge file targets.
fn trash_sibling_entry_path(path: &str) -> Option<String> {
    match parse_intent_name(outbox_file_name(path)) {
        Ok(('d', id)) => Some(format!("{}/{id}.bin", outbox_dir(path))),
        _ => None,
    }
}

/// Read position of an outbox path: `path_rank`, except that `d-<E>` reads right after
/// a listed `<E>.bin`, and the read budget never cuts between the two (see the read
/// pass). A restore applies before the edit (rank 28 < 30) and a trash after it, so a
/// budget cut must never leave one of them for the next cycle: a lone edit of a trashed
/// entry, or a lone trash before its edit, would end with a final `entry_trashed`.
fn read_order_key(path: &str, listed: &HashSet<String>) -> (u8, String, u8) {
    match trash_sibling_entry_path(path).filter(|entry| listed.contains(entry)) {
        Some(entry) => (RANK_ENTRY, entry, 1),
        None => (path_rank(path), path.to_string(), 0),
    }
}

/// A decoded intent waiting for the apply pass.
enum Decoded {
    V1(Box<OutboxEntryV1>),
    V2(OutboxIntentV2),
    V3(OutboxIntentV3),
}

struct DecodedIntent {
    path: String,
    content_hash: String,
    revision: Option<String>,
    body: Decoded,
}

impl DecodedIntent {
    fn sort_key(&self) -> (u8, i64, &str) {
        match &self.body {
            Decoded::V1(e) => (RANK_ENTRY, e.web_updated_at_secs, &self.path),
            Decoded::V2(i) => (prefix_rank(i.prefix()), v2_updated_at_secs(i), &self.path),
            Decoded::V3(i) => (v3_rank(i), i.web_updated_at_secs(), &self.path),
        }
    }
}

fn v2_updated_at_secs(intent: &OutboxIntentV2) -> i64 {
    match intent {
        OutboxIntentV2::CreateJournal {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::CreateTag {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::UpsertTemplate {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::DeleteTemplate {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::TrashEntry {
            web_updated_at_secs,
            ..
        } => *web_updated_at_secs,
    }
}

/// Why the read pass records an intent instead of handing it to the apply pass.
enum ReadSkip {
    /// Frame version this build cannot read: `skipped_version` / version.
    Version(u16),
    /// v3 kind this build does not apply: `skipped_kind` / kind name, no ack.
    Kind(String),
    /// Malformed or misnamed: final `corrupt`.
    Corrupt(String),
}

/// Check the decoded body against its file name: a v2/v3 body needs the `<letter>-<id>.bin`
/// name of its kind and id; a v1 body must not carry an intent prefix. A well-named v3
/// body whose kind is not in `APPLIED_KINDS` is skipped by kind.
fn decode_named_intent(path: &str, intent: WireIntent) -> Result<Decoded, ReadSkip> {
    let name = outbox_file_name(path);
    match intent {
        WireIntent::V1(entry) => match parse_intent_name(name) {
            Ok(_) => Err(ReadSkip::Corrupt(format!(
                "entry intent under an intent prefix: {name}"
            ))),
            Err(_) => Ok(Decoded::V1(Box::new(entry))),
        },
        WireIntent::V2(v2) => check_intent_name(name, &v2)
            .map(|()| Decoded::V2(v2))
            .map_err(|e| ReadSkip::Corrupt(e.to_string())),
        WireIntent::V3(v3) => {
            check_intent_name_v3(name, &v3).map_err(|e| ReadSkip::Corrupt(e.to_string()))?;
            let kind = v3.kind();
            if !applied_kinds().contains(&kind) {
                return Err(ReadSkip::Kind(kind.to_string()));
            }
            // An applied kind must never come back as `Kind`: `is_pending` would re-read
            // its `skipped_kind` row every cycle. Its apply arm is in `decide_intent_v3`
            // (an exhaustive match); `every_applied_kind_decodes_for_the_apply_pass`
            // checks the fixture sample of every applied kind reaches it.
            Ok(Decoded::V3(v3))
        }
    }
}

/// `applied_from_updated_at` of an apply that created the row: there was no desktop
/// state for the web to miss, so any base fast-forwards. A legacy template row whose
/// `updated_at` is still the column default 0 records the same value; that only
/// loosens the check while the row is unchanged since the web's own write, which is
/// harmless, so leave it (the v1 crash-resume create path also restores 0).
const APPLIED_FROM_CREATED: i64 = 0;

/// Final decision for one v2 intent, before it is recorded.
enum V2Decision {
    /// Journal / tag created, or already present under this id.
    Created,
    /// Template / trash applied or already reflected. `at`: the row's `updated_at`
    /// after; `from`: the web base this write fast-forwarded from (see
    /// `fast_forward_from`), `None` when nothing was written.
    Applied { at: i64, from: Option<i64> },
    /// Final refusal with its ack reason code.
    Refused(String),
    /// Retry next cycle, nothing recorded.
    Transient,
}

/// Why a v2 decision could not be reached.
#[derive(Debug)]
enum DecideError {
    /// Deterministic: the same bytes fail the same way every cycle. Recorded as a
    /// final `invalid` refusal so a poison intent is read once, not every cycle.
    Invalid(String),
    /// DB / IO failure: retry next cycle, nothing recorded.
    Io(String),
}

impl From<rusqlite::Error> for DecideError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            // The db layer's input-validation error (tag name / color, template caps).
            rusqlite::Error::InvalidParameterName(m) => Self::Invalid(m),
            other => Self::Io(other.to_string()),
        }
    }
}

/// A journal write's validation failure is final (`invalid`); a real DB failure retries.
impl From<JournalImplError> for DecideError {
    fn from(e: JournalImplError) -> Self {
        match e {
            JournalImplError::Db(e) => e.into(),
            other => Self::Invalid(other.to_string()),
        }
    }
}

impl std::fmt::Display for DecideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Io(m) => f.write_str(m),
        }
    }
}

/// The outbox folder of an intent path (`<…>/<webId>/outbox`): identifies its web device.
fn outbox_dir(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// What an own-apply chain belongs to (README "Own-path chaining").
enum ChainTarget<'a> {
    /// An entry: every own apply of this web device that touched it, whatever the path
    /// (`<E>.bin`, `d-<E>`, `l-<E>`, and `a-*` / `i-*` rows naming it).
    Entry { dir: &'a str, entry_id: &'a str },
    /// Any other target (tag, journal, template, …): its own path only.
    Path(&'a str),
}

/// Whether walking own-apply edges `from → to` from `base` reaches `current`. An edge
/// accepts any stamp `b` with `from <= b <= to`: it records that only this web device's
/// own applies touched the row in that interval. Each pass consumes at least one edge,
/// so the walk ends after at most `edges.len()` passes.
fn chain_reaches(edges: &[(i64, i64)], base: i64, current: i64) -> bool {
    let mut reached = vec![base];
    let mut used = vec![false; edges.len()];
    loop {
        if reached.contains(&current) {
            return true;
        }
        let mut grew = false;
        for (i, &(from, to)) in edges.iter().enumerate() {
            if !used[i] && reached.iter().any(|&r| from <= r && r <= to) {
                used[i] = true;
                reached.push(to);
                grew = true;
            }
        }
        if !grew {
            return false;
        }
    }
}

/// Own-apply edges of `target` (see `ChainTarget`).
fn own_chain_edges(conn: &Connection, target: &ChainTarget) -> rusqlite::Result<Vec<(i64, i64)>> {
    match target {
        ChainTarget::Entry { dir, entry_id } => {
            db::queries::outbox_import_entry_edges(conn, dir, entry_id)
        }
        ChainTarget::Path(path) => Ok(outbox_import_get(conn, path)?
            .filter(|r| r.outcome == "applied" || r.outcome == "pending")
            .and_then(|r| Some((r.applied_from_updated_at?, r.last_applied_updated_at?)))
            .into_iter()
            .collect()),
    }
}

/// `own_prior`: every change to `target` since the web's `base` was an apply of this
/// web device's own intents, so the web may write over `current` (see `chain_reaches`).
fn own_chain_reaches(
    conn: &Connection,
    target: &ChainTarget,
    base: i64,
    current: i64,
) -> rusqlite::Result<bool> {
    if base == current {
        return Ok(true);
    }
    Ok(chain_reaches(
        &own_chain_edges(conn, target)?,
        base,
        current,
    ))
}

/// Desktop-wins guard shared by every base-checked v2/v3 kind. Passes when the web's
/// base is the target's current stamp, or when every change since that base was an own
/// apply (`own_chain_reaches`). A refused or merged edit records the row's stamp too,
/// but its `applied_from_updated_at` is the desktop's stamp, not the web's base, so it
/// never opens a stale base. A create intent (`None`) passes only along a chain that
/// starts at a row this path created (`APPLIED_FROM_CREATED`).
///
/// Returns the web base the write fast-forwards from (record it as the new
/// `applied_from_updated_at`, so a chain of web edits from one base keeps passing),
/// or `None` when the desktop changed the row since the web's base.
///
/// TODO(later): see docs/LATER.md "Phase 14 review notes" — an upgrade/downgrade/re-upgrade
/// can leave a stale `applied_from_updated_at` next to a v0.2.2-written stamp.
fn fast_forward_from(
    conn: &Connection,
    target: &ChainTarget,
    base_updated_at: Option<i64>,
    row_updated_at: i64,
) -> rusqlite::Result<Option<i64>> {
    match base_updated_at {
        Some(base) => Ok(own_chain_reaches(conn, target, base, row_updated_at)?.then_some(base)),
        None => {
            // A create needs a recorded edge even when the row's stamp is still 0 (legacy rows).
            let edges = own_chain_edges(conn, target)?;
            let passes =
                !edges.is_empty() && chain_reaches(&edges, APPLIED_FROM_CREATED, row_updated_at);
            Ok(passes.then_some(APPLIED_FROM_CREATED))
        }
    }
}

fn decode_template_content(content_b64: Option<&str>) -> Result<Option<Vec<u8>>, DecideError> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    content_b64
        .map(|c| {
            B64.decode(c)
                .map_err(|_| DecideError::Invalid("content_b64: invalid base64".to_string()))
        })
        .transpose()
}

fn template_updated_at(conn: &Connection, id: &str) -> Result<i64, DecideError> {
    db::queries::get_template_for_import(conn, id)?
        .map(|r| r.updated_at)
        .ok_or_else(|| DecideError::Io(format!("template {id} vanished")))
}

#[allow(clippy::too_many_arguments)]
fn decide_upsert_template(
    conn: &Connection,
    path: &str,
    id: &str,
    name: &str,
    description: Option<&str>,
    content_b64: Option<&str>,
    sort_order: i64,
    base_updated_at: Option<i64>,
) -> Result<V2Decision, DecideError> {
    let content = decode_template_content(content_b64)?;
    let Some(row) = db::queries::get_template_for_import(conn, id)? else {
        if base_updated_at.is_some() {
            return Ok(V2Decision::Refused(ABSENT.to_string()));
        }
        db::queries::create_template_with_id(
            conn,
            id,
            name,
            description,
            content.as_deref(),
            sort_order,
        )?;
        return Ok(V2Decision::Applied {
            at: template_updated_at(conn, id)?,
            from: Some(APPLIED_FROM_CREATED),
        });
    };
    if row.is_predefined || row.is_deleted {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    if row.name == name
        && row.description.as_deref() == description
        && row.content == content
        && row.sort_order == sort_order
    {
        return Ok(V2Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    let Some(from) = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        base_updated_at,
        row.updated_at,
    )?
    else {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    db::queries::update_template_with_sort_order(
        conn,
        id,
        name,
        description,
        content.as_deref(),
        sort_order,
    )?;
    Ok(V2Decision::Applied {
        at: template_updated_at(conn, id)?,
        from: Some(from),
    })
}

fn decide_delete_template(
    conn: &Connection,
    path: &str,
    id: &str,
    base_updated_at: i64,
) -> Result<V2Decision, DecideError> {
    let Some(row) = db::queries::get_template_for_import(conn, id)? else {
        // Upsert and delete share `p-<id>.bin`: a template created and deleted on the
        // web before any import arrives as a delete of a row that never existed here.
        return Ok(V2Decision::Applied {
            at: base_updated_at,
            from: None,
        });
    };
    if row.is_deleted {
        return Ok(V2Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    if row.is_predefined {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    let Some(from) = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?
    else {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    db::queries::delete_template(conn, id)?;
    Ok(V2Decision::Applied {
        at: template_updated_at(conn, id)?,
        from: Some(from),
    })
}

/// An entry targeted by a `d-` intent, as the importer view (README "Importer view") sees it.
enum WebEntry {
    /// The row (live, trashed or purged): unlocked, outside every invisible vault, in a
    /// live, visible, unlocked journal.
    Visible(Box<db::Entry>),
    /// Missing here but live on a peer, not pulled yet: wait (v1 presence rules).
    NotPulled,
    /// Missing, or hidden from the web.
    Absent,
}

/// Visibility first, and one reason for every hidden or gone target, so a refusal (or an
/// already-trashed / already-purged shortcut) never reveals that a locked or invisible
/// entry exists, nor its stamp.
fn web_entry(conn: &Connection, ctx: &ApplyContext, entry_id: &str) -> rusqlite::Result<WebEntry> {
    let Some(raw) = db::queries::get_entry_raw(conn, entry_id)? else {
        return Ok(match ctx.known_ids.get(entry_id) {
            Some(false) => WebEntry::NotPulled,
            _ => WebEntry::Absent,
        });
    };
    let journal_ok = db::queries::get_journal(conn, &raw.journal_id)?
        .is_some_and(|j| !j.is_deleted && !j.is_invisible && !j.is_locked);
    Ok(if raw.is_locked || raw.is_invisible || !journal_ok {
        WebEntry::Absent
    } else {
        WebEntry::Visible(Box::new(raw))
    })
}

fn entry_stamp(conn: &Connection, id: &str) -> Result<i64, DecideError> {
    db::queries::get_entry_raw(conn, id)?
        .map(|e| e.updated_at)
        .ok_or_else(|| DecideError::Io(format!("entry {id} vanished")))
}

/// The stamp a v3 entry write acks, after a monotonic touch (`MAX(now, updated_at + 1)`).
/// Every desktop entry setter is monotonic too, so a later desktop edit always lands
/// strictly past this stamp and the entry's own-apply chain never takes it for an apply.
fn bump_entry_stamp(conn: &Connection, id: &str) -> Result<i64, DecideError> {
    db::queries::touch_entry_updated_at(conn, id)?;
    entry_stamp(conn, id)
}

fn decide_trash_entry(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    entry_id: &str,
    base_updated_at: i64,
) -> Result<V2Decision, DecideError> {
    let raw = match web_entry(conn, ctx, entry_id)? {
        WebEntry::Visible(raw) => raw,
        WebEntry::NotPulled => return Ok(V2Decision::Transient),
        WebEntry::Absent => return Ok(V2Decision::Refused(ABSENT.to_string())),
    };
    if raw.is_deleted {
        return Ok(match raw.trashed_at {
            // Already trashed, e.g. pulled from another desktop that applied this intent.
            Some(_) => V2Decision::Applied {
                at: raw.updated_at,
                from: None,
            },
            // Purged.
            None => V2Decision::Refused(ABSENT.to_string()),
        });
    }
    let entry = raw;
    // Chains on every own apply to this entry (its `<entryId>.bin` edits included).
    let target = ChainTarget::Entry {
        dir: outbox_dir(path),
        entry_id,
    };
    let Some(from) = fast_forward_from(conn, &target, Some(base_updated_at), entry.updated_at)?
    else {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    soft_delete_entry_impl(conn, entry_id).map_err(DecideError::Io)?;
    let stamp =
        db::queries::get_entry_raw(conn, entry_id)?.map_or(entry.updated_at, |e| e.updated_at);
    Ok(V2Decision::Applied {
        at: stamp,
        from: Some(from),
    })
}

fn decide_intent_v2(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    intent: &OutboxIntentV2,
) -> Result<V2Decision, DecideError> {
    let created = |o: db::queries::CreateWithIdOutcome| match o {
        db::queries::CreateWithIdOutcome::Created | db::queries::CreateWithIdOutcome::Exists => {
            V2Decision::Created
        }
        db::queries::CreateWithIdOutcome::NameTaken => V2Decision::Refused(NAME_TAKEN.to_string()),
    };
    // Already checked when the file was opened; repeated here so this entry point
    // never writes an intent the wire contract rejects.
    intent
        .validate()
        .map_err(|e| DecideError::Invalid(e.to_string()))?;
    match intent {
        OutboxIntentV2::CreateJournal {
            journal_id,
            name,
            color,
            auto_tag_ids,
            ..
        } => db::queries::create_journal_with_id(
            conn,
            journal_id,
            name,
            color.as_deref(),
            auto_tag_ids,
        )
        .map(created)
        .map_err(DecideError::from),
        OutboxIntentV2::CreateTag {
            tag_id,
            name,
            color,
            ..
        } => db::queries::create_tag_with_id(conn, tag_id, name, color.as_deref())
            .map(created)
            .map_err(DecideError::from),
        OutboxIntentV2::UpsertTemplate {
            template_id,
            name,
            description,
            content_b64,
            sort_order,
            base_updated_at,
            ..
        } => decide_upsert_template(
            conn,
            path,
            template_id,
            name,
            description.as_deref(),
            content_b64.as_deref(),
            *sort_order,
            *base_updated_at,
        ),
        OutboxIntentV2::DeleteTemplate {
            template_id,
            base_updated_at,
            ..
        } => decide_delete_template(conn, path, template_id, *base_updated_at),
        OutboxIntentV2::TrashEntry {
            entry_id,
            base_updated_at,
            ..
        } => decide_trash_entry(conn, ctx, path, entry_id, *base_updated_at),
    }
}

/// Apply one decoded v2 intent and record its outcome in `web_outbox_imports` the
/// way v1 does, so applied / refused are final until the file changes and the ack
/// carries `created` (creates), `applied_updated_at` (template / trash) or
/// `refused_reason`. Every apply is idempotent, so a crash between the write and
/// the record replays to the same result. A validation failure is a final `invalid`
/// refusal; transient and DB / IO errors record nothing and retry next cycle.
pub(crate) fn apply_intent_v2(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    content_hash: &str,
    revision: Option<String>,
    intent: &OutboxIntentV2,
) -> Outcome {
    // Desktop behind its peers: a base comparison could refuse on stale rows.
    if !ctx.pull_clean {
        return Outcome::Transient;
    }
    let decision = match decide_intent_v2(conn, ctx, path, intent) {
        Ok(d) => d,
        Err(e @ DecideError::Invalid(_)) => {
            log::warn!("outbox_import: v2 intent {path} refused: {e}");
            V2Decision::Refused(INVALID.to_string())
        }
        Err(DecideError::Io(e)) => {
            log::warn!("outbox_import: v2 intent {path} failed: {e}");
            return Outcome::Transient;
        }
    };
    let (outcome, applied_at, applied_from, created, reason) = match decision {
        V2Decision::Transient => return Outcome::Transient,
        V2Decision::Created => (Outcome::Applied, None, None, true, None),
        V2Decision::Applied { at, from } => (Outcome::Applied, Some(at), from, false, None),
        V2Decision::Refused(code) => (
            Outcome::Refused(code.clone()),
            None,
            None,
            false,
            Some(code),
        ),
    };
    let rec = WebOutboxImportRecord {
        path: path.to_string(),
        revision,
        content_hash: content_hash.to_string(),
        outcome: if reason.is_some() {
            "refused"
        } else {
            "applied"
        }
        .to_string(),
        imported_at: chrono::Utc::now().timestamp(),
        last_applied_updated_at: applied_at,
        post_import_fingerprint: None,
        decided_fields: None,
        pending_revision: None,
        pending_plan: reason,
        created,
        applied_from_updated_at: applied_from,
    };
    let _ = outbox_import_record(conn, &rec);
    outcome
}

/// Final decision for one v3 intent, before it is recorded. Unlike v2, every applied
/// v3 kind acks `applied_updated_at`, creates included (README "Acks").
enum V3Decision {
    /// Target created (acks `created` too). `at`: its `updated_at`; `from`:
    /// `APPLIED_FROM_CREATED` when this apply created it, `None` when it already existed.
    Created { at: i64, from: Option<i64> },
    /// Applied or already reflected. `at`: the target's `updated_at` after; `from`: the
    /// web base this write fast-forwarded from, `None` when nothing was written.
    Applied { at: i64, from: Option<i64> },
    /// Final refusal with its ack reason code.
    Refused(String),
    /// Retry next cycle, nothing recorded.
    Transient,
}

/// A v2 decider reused for its v3 kind (templates, trash): same rules, same stamps.
impl From<V2Decision> for V3Decision {
    fn from(d: V2Decision) -> Self {
        match d {
            V2Decision::Applied { at, from } => Self::Applied { at, from },
            V2Decision::Refused(code) => Self::Refused(code),
            V2Decision::Transient => Self::Transient,
            // Only the v2 tag / journal creates return it, and v3 creates go through
            // `decide_create_v3` (which reads the stamp). Never ack without a stamp.
            V2Decision::Created => {
                log::warn!("outbox_import: v2 create decision reached a v3 kind");
                Self::Transient
            }
        }
    }
}

/// A v3 tag / journal create (`base_updated_at: None`): the v2 get-or-create rules
/// (another id holding the name refuses `name_taken`), acking the row's stamp. `row`
/// reads the target's `(updated_at, visible)`. An id that already exists counts as
/// created (a crash replay, or a peer desktop applied the same intent and its row may
/// have changed since), but this apply did not create it: no `APPLIED_FROM_CREATED`
/// edge, which would let any later base fast-forward, and a deleted or hidden row is
/// `absent`, its stamp never acked.
fn decide_create_v3(
    outcome: db::queries::CreateWithIdOutcome,
    id: &str,
    row: impl FnOnce() -> rusqlite::Result<Option<(i64, bool)>>,
) -> Result<V3Decision, DecideError> {
    use db::queries::CreateWithIdOutcome as C;
    match outcome {
        C::NameTaken => Ok(V3Decision::Refused(NAME_TAKEN.to_string())),
        C::Created => row()?
            .map(|(at, _)| V3Decision::Created {
                at,
                from: Some(APPLIED_FROM_CREATED),
            })
            .ok_or_else(|| DecideError::Io(format!("{id} vanished"))),
        C::Exists => Ok(match row()? {
            Some((at, true)) => V3Decision::Created { at, from: None },
            _ => V3Decision::Refused(ABSENT.to_string()),
        }),
    }
}

/// `upsert_tag` update (`base_updated_at: Some`): desktop wins on the tag's stamp,
/// chained on this `t-` path's own applies; a deleted or unknown tag is `absent`; a
/// rename onto another tag's name (live or deleted, `tags.name` is UNIQUE) is
/// `name_taken`.
fn decide_update_tag(
    conn: &Connection,
    path: &str,
    id: &str,
    name: &str,
    color: Option<&str>,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let row = match db::queries::get_tag_for_import(conn, id)? {
        Some(row) if !row.is_deleted => row,
        _ => return Ok(V3Decision::Refused(ABSENT.to_string())),
    };
    let from = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?;
    if row.name == name.trim() && row.color.as_deref() == color {
        // Reflected (e.g. a peer desktop applied it): keep this path's chain if it holds.
        return Ok(V3Decision::Applied {
            at: row.updated_at,
            from,
        });
    }
    let Some(from) = from else {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    match update_tag_impl(conn, id, Some(name), Some(color)) {
        Ok(_) => {}
        Err(UpdateTagError::NameTaken) => return Ok(V3Decision::Refused(NAME_TAKEN.to_string())),
        Err(UpdateTagError::Db(e)) => return Err(e.into()),
    }
    let at = db::queries::get_tag_updated_at(conn, id)?
        .ok_or_else(|| DecideError::Io(format!("tag {id} vanished")))?;
    Ok(V3Decision::Applied {
        at,
        from: Some(from),
    })
}

/// A journal the web may write: live, visible and unlocked (README "Importer view").
fn writable_journal(conn: &Connection, id: &str) -> rusqlite::Result<Option<db::Journal>> {
    Ok(db::queries::get_journal(conn, id)?
        .filter(|j| !j.is_deleted && !j.is_invisible && !j.is_locked))
}

/// `upsert_journal` update (`base_updated_at: Some`): desktop wins on the journal's
/// stamp, chained on this `j-` path's own applies; a locked, invisible, deleted or
/// unknown journal is `absent`; a new name held by another live, visible journal is
/// `name_taken` (the create rule). Unknown or deleted `auto_tag_ids` are dropped, as on
/// create.
#[allow(clippy::too_many_arguments)]
fn decide_update_journal(
    conn: &Connection,
    path: &str,
    id: &str,
    name: &str,
    color: Option<&str>,
    auto_tag_ids: &[String],
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let Some(row) = writable_journal(conn, id)? else {
        return Ok(V3Decision::Refused(ABSENT.to_string()));
    };
    let name = name.trim();
    let mut tag_ids = existing_tag_ids(conn, auto_tag_ids)?;
    tag_ids.sort();
    tag_ids.dedup();
    let mut current: Vec<String> = db::queries::list_journal_auto_tags(conn, id)?
        .into_iter()
        .map(|t| t.id)
        .collect();
    current.sort();
    let from = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?;
    if row.name == name && row.color.as_deref() == color && tag_ids == current {
        return Ok(V3Decision::Applied {
            at: row.updated_at,
            from,
        });
    }
    let Some(from) = from else {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    if row.name.trim() != name && db::queries::journal_name_taken_by_other(conn, name, id)? {
        return Ok(V3Decision::Refused(NAME_TAKEN.to_string()));
    }
    update_journal_impl(conn, id, name, color, Some(&tag_ids))?;
    // Re-read: `update_journal_impl` returns the row from before its auto-tag write
    // bumped `updated_at`.
    let at = db::queries::get_journal(conn, id)?
        .map(|j| j.updated_at)
        .ok_or_else(|| DecideError::Io(format!("journal {id} vanished")))?;
    Ok(V3Decision::Applied {
        at,
        from: Some(from),
    })
}

/// `delete_tag`: desktop wins on the tag's stamp (chained on the `t-` path, so a web
/// rename then delete applies); already deleted is applied; unknown is `absent`.
fn decide_delete_tag(
    conn: &Connection,
    path: &str,
    id: &str,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let Some(row) = db::queries::get_tag_for_import(conn, id)? else {
        return Ok(V3Decision::Refused(ABSENT.to_string()));
    };
    if row.is_deleted {
        return Ok(V3Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    let Some(from) = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?
    else {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    delete_tag_impl(conn, id).map_err(DecideError::Io)?;
    let at = db::queries::get_tag_updated_at(conn, id)?
        .ok_or_else(|| DecideError::Io(format!("tag {id} vanished")))?;
    Ok(V3Decision::Applied {
        at,
        from: Some(from),
    })
}

/// `delete_journal` (Q1: empty journals only). A locked, invisible or unknown journal is
/// `absent` (checked first, so nothing reveals it); already deleted is applied (also the
/// crash replay); then desktop wins on the stamp; `last_journal` follows the desktop
/// command (`list_journals(conn, None)`: invisible-vault journals do not count);
/// `journal_not_empty` counts EVERY non-purged entry row (locked, invisible-vault and
/// trashed included), since the web cannot see them all. The delete commits inside
/// `delete_journal_impl`; its media files are unlinked after, then the own-cloud prune
/// is re-armed, as the desktop command does.
fn decide_delete_journal(
    conn: &Connection,
    path: &str,
    id: &str,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let row = match db::queries::get_journal(conn, id)? {
        Some(j) if !j.is_invisible && !j.is_locked => j,
        _ => return Ok(V3Decision::Refused(ABSENT.to_string())),
    };
    if row.is_deleted {
        return Ok(V3Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    let Some(from) = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?
    else {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    if db::queries::list_journals(conn, None)?.len() <= 1 {
        return Ok(V3Decision::Refused(LAST_JOURNAL.to_string()));
    }
    if db::queries::count_unpurged_entries_in_journal(conn, id)? > 0 {
        return Ok(V3Decision::Refused(JOURNAL_NOT_EMPTY.to_string()));
    }
    let media_paths = match delete_journal_impl(conn, id) {
        Ok(paths) => paths,
        Err(JournalImplError::LastJournal) => {
            return Ok(V3Decision::Refused(LAST_JOURNAL.to_string()))
        }
        Err(e) => return Err(e.into()),
    };
    for (storage_path, thumbnail_path) in &media_paths {
        crate::commands::media::remove_media_files_best_effort(
            storage_path,
            thumbnail_path.as_deref(),
        );
    }
    crate::sync::engine::reset_session_own_cloud_reconciled();
    let at = db::queries::get_journal(conn, id)?
        .map(|j| j.updated_at)
        .ok_or_else(|| DecideError::Io(format!("journal {id} vanished")))?;
    Ok(V3Decision::Applied {
        at,
        from: Some(from),
    })
}

/// The entry a v3 kind writes to, recorded as `{"entry_id"}` in `decided_fields` so the
/// entry's own-apply chain finds rows keyed by another id (`a-<mediaId>`, …).
fn v3_entry_target(intent: &OutboxIntentV3) -> Option<&str> {
    match intent {
        OutboxIntentV3::TrashEntry { entry_id, .. }
        | OutboxIntentV3::RestoreEntry { entry_id, .. }
        | OutboxIntentV3::PurgeEntry { entry_id, .. }
        | OutboxIntentV3::SetEntryLocation { entry_id, .. }
        | OutboxIntentV3::AttachMedia { entry_id, .. }
        | OutboxIntentV3::DeleteMedia { entry_id, .. }
        | OutboxIntentV3::SetMediaInsertionMode { entry_id, .. } => Some(entry_id),
        OutboxIntentV3::UpsertTag { .. }
        | OutboxIntentV3::UpsertJournal { .. }
        | OutboxIntentV3::UpsertTemplate { .. }
        | OutboxIntentV3::DeleteTemplate { .. }
        | OutboxIntentV3::EmptyTrash { .. }
        | OutboxIntentV3::DeleteTag { .. }
        | OutboxIntentV3::DeleteJournal { .. }
        | OutboxIntentV3::DeleteMemoryItem { .. }
        | OutboxIntentV3::UpdatePersona { .. } => None,
    }
}

/// `restore_entry` (rank 28, before the entry's v1 edits). `base_updated_at` is the
/// trashed row's stamp the web saw; desktop wins on it, chained on every own apply to
/// the entry. A live entry is reflected only along that chain (a replay, or this
/// restore applied by a peer desktop and then own edits), else `not_in_trash`, as is a
/// purged one.
fn decide_restore_entry(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    entry_id: &str,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let raw = match web_entry(conn, ctx, entry_id)? {
        WebEntry::Visible(raw) => raw,
        WebEntry::NotPulled => return Ok(V3Decision::Transient),
        WebEntry::Absent => return Ok(V3Decision::Refused(ABSENT.to_string())),
    };
    let target = ChainTarget::Entry {
        dir: outbox_dir(path),
        entry_id,
    };
    let own = own_chain_reaches(conn, &target, base_updated_at, raw.updated_at)?;
    if !raw.is_deleted {
        return Ok(if own {
            V3Decision::Applied {
                at: raw.updated_at,
                from: Some(base_updated_at),
            }
        } else {
            V3Decision::Refused(NOT_IN_TRASH.to_string())
        });
    }
    if raw.trashed_at.is_none() {
        return Ok(V3Decision::Refused(NOT_IN_TRASH.to_string()));
    }
    if !own {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    restore_entry_impl(conn, entry_id, LockedView::Hidden, None).map_err(DecideError::Io)?;
    Ok(V3Decision::Applied {
        at: bump_entry_stamp(conn, entry_id)?,
        from: Some(base_updated_at),
    })
}

/// What purging one entry the web listed in Trash at a base did.
enum PurgeOutcome {
    /// Purged now: the tombstone's stamp.
    Purged(i64),
    /// Already a tombstone (a replay, or a peer desktop purged it): its stamp.
    AlreadyPurged(i64),
    /// Live: restored on the desktop since the web listed it.
    NotInTrash,
    /// Still trashed, but the desktop changed it since the web's base.
    Changed,
    Absent,
    NotPulled,
}

/// Purge `entry_id` only if it is still in the importer view's Trash at `base` (chained
/// on every own apply to the entry). `purge_entry_impl` unlinks the media files itself
/// after its commit; the own-cloud prune is then re-armed, as the desktop command does.
fn purge_listed_entry(
    conn: &Connection,
    ctx: &ApplyContext,
    dir: &str,
    entry_id: &str,
    base_updated_at: i64,
) -> Result<PurgeOutcome, DecideError> {
    let raw = match web_entry(conn, ctx, entry_id)? {
        WebEntry::Visible(raw) => raw,
        WebEntry::NotPulled => return Ok(PurgeOutcome::NotPulled),
        WebEntry::Absent => return Ok(PurgeOutcome::Absent),
    };
    if !raw.is_deleted {
        return Ok(PurgeOutcome::NotInTrash);
    }
    if raw.trashed_at.is_none() {
        return Ok(PurgeOutcome::AlreadyPurged(raw.updated_at));
    }
    let target = ChainTarget::Entry { dir, entry_id };
    if !own_chain_reaches(conn, &target, base_updated_at, raw.updated_at)? {
        return Ok(PurgeOutcome::Changed);
    }
    purge_entry_impl(conn, entry_id, LockedView::Hidden, None).map_err(DecideError::Io)?;
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(PurgeOutcome::Purged(entry_stamp(conn, entry_id)?))
}

/// `purge_entry` (rank 50): see `purge_listed_entry`.
fn decide_purge_entry(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    entry_id: &str,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let refused = |code: &str| V3Decision::Refused(code.to_string());
    Ok(
        match purge_listed_entry(conn, ctx, outbox_dir(path), entry_id, base_updated_at)? {
            PurgeOutcome::Purged(at) => V3Decision::Applied {
                at,
                from: Some(base_updated_at),
            },
            PurgeOutcome::AlreadyPurged(at) => V3Decision::Applied { at, from: None },
            PurgeOutcome::NotInTrash => refused(NOT_IN_TRASH),
            PurgeOutcome::Changed => refused(CHANGED_ON_DESKTOP),
            PurgeOutcome::Absent => refused(ABSENT),
            PurgeOutcome::NotPulled => V3Decision::Transient,
        },
    )
}

/// `empty_trash` (rank 55): purge exactly the listed entries still in the importer
/// view's Trash at their listed base; every other one (unlisted, hidden, restored,
/// trashed again, not pulled) stays where it is. Acks `now`: the web re-reads its Trash
/// list after the next pull.
fn decide_empty_trash(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    items: &[memlore_core::outbox::EmptyTrashItem],
) -> Result<V3Decision, DecideError> {
    for item in items {
        purge_listed_entry(
            conn,
            ctx,
            outbox_dir(path),
            &item.entry_id,
            item.base_updated_at,
        )?;
    }
    Ok(V3Decision::Applied {
        at: chrono::Utc::now().timestamp(),
        from: None,
    })
}

/// A visible entry an entry-scoped v3 edit may write (`set_entry_location`,
/// `set_media_insertion_mode`, `attach_media`, `delete_media`): a trashed one is
/// read-only until restored (`entry_trashed`, like a v1 edit), a purged one is `absent`.
/// Never left to the impl's `require_live_entry`, whose error would retry the intent
/// every cycle.
fn writable_web_entry(
    conn: &Connection,
    ctx: &ApplyContext,
    entry_id: &str,
) -> Result<Result<db::Entry, V3Decision>, DecideError> {
    let raw = match web_entry(conn, ctx, entry_id)? {
        WebEntry::Visible(raw) => *raw,
        WebEntry::NotPulled => return Ok(Err(V3Decision::Transient)),
        WebEntry::Absent => return Ok(Err(V3Decision::Refused(ABSENT.to_string()))),
    };
    if raw.is_deleted {
        let code = if raw.trashed_at.is_some() {
            ENTRY_TRASHED
        } else {
            ABSENT
        };
        return Ok(Err(V3Decision::Refused(code.to_string())));
    }
    Ok(Ok(raw))
}

/// A location as compared by `set_entry_location`: blank text is no text, and no
/// coordinates with no text is no location (`None`), as core validate defines it.
fn comparable_location(l: Option<&OutboxLocation>) -> Option<OutboxLocation> {
    let text = |t: &Option<String>| t.clone().filter(|t| !t.trim().is_empty());
    let l = l?;
    let label = text(&l.label);
    let address = text(&l.address);
    if l.latitude.is_none() && l.longitude.is_none() && label.is_none() && address.is_none() {
        return None;
    }
    Some(OutboxLocation {
        latitude: l.latitude,
        longitude: l.longitude,
        label,
        address,
    })
}

fn entry_location(e: &db::Entry) -> Option<OutboxLocation> {
    comparable_location(Some(&OutboxLocation {
        latitude: e.latitude,
        longitude: e.longitude,
        label: e.location_label.clone(),
        address: e.location_address.clone(),
    }))
}

/// `set_entry_location` (rank 40). Already equal → applied (reflected). Otherwise the
/// web writes when the desktop still holds the web's `base`, or when every change since
/// `base_updated_at` was an own apply to the entry (any path); else desktop wins.
fn decide_set_entry_location(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    entry_id: &str,
    value: Option<&OutboxLocation>,
    base: Option<&OutboxLocation>,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let entry = match writable_web_entry(conn, ctx, entry_id)? {
        Ok(e) => e,
        Err(d) => return Ok(d),
    };
    let target = ChainTarget::Entry {
        dir: outbox_dir(path),
        entry_id,
    };
    let own = own_chain_reaches(conn, &target, base_updated_at, entry.updated_at)?;
    let current = entry_location(&entry);
    if current == comparable_location(value) {
        return Ok(V3Decision::Applied {
            at: entry.updated_at,
            from: own.then_some(base_updated_at),
        });
    }
    if !own && current != comparable_location(base) {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    update_entry_location_impl(
        conn,
        entry_id,
        value.and_then(|v| v.latitude),
        value.and_then(|v| v.longitude),
        value.and_then(|v| v.label.as_deref()),
        value.and_then(|v| v.address.as_deref()),
    )
    .map_err(DecideError::Io)?;
    Ok(V3Decision::Applied {
        at: bump_entry_stamp(conn, entry_id)?,
        from: Some(if own {
            base_updated_at
        } else {
            entry.updated_at
        }),
    })
}

/// `set_media_insertion_mode` (rank 45). `base_updated_at` is the entry's stamp (media
/// rows have none), so a coalesced toggle (inline → attached → inline) still chains on
/// the entry's own applies. The apply bumps the entry stamp and marks it pending so the
/// new mode is republished.
#[allow(clippy::too_many_arguments)]
fn decide_set_media_insertion_mode(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    entry_id: &str,
    media_id: &str,
    mode: MediaInsertionMode,
    base_mode: MediaInsertionMode,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let mode_str = |m: MediaInsertionMode| match m {
        MediaInsertionMode::Inline => "inline",
        MediaInsertionMode::Attached => "attached",
    };
    let entry = match writable_web_entry(conn, ctx, entry_id)? {
        Ok(e) => e,
        Err(d) => return Ok(d),
    };
    let Some(media) = get_media(conn, media_id)? else {
        return Ok(V3Decision::Refused(ABSENT.to_string()));
    };
    if media.entry_id != entry_id {
        return Ok(V3Decision::Refused(MEDIA_ENTRY_MISMATCH.to_string()));
    }
    let target = ChainTarget::Entry {
        dir: outbox_dir(path),
        entry_id,
    };
    let own = own_chain_reaches(conn, &target, base_updated_at, entry.updated_at)?;
    if media.insertion_mode == mode_str(mode) {
        return Ok(V3Decision::Applied {
            at: entry.updated_at,
            from: own.then_some(base_updated_at),
        });
    }
    if !own && media.insertion_mode != mode_str(base_mode) {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    let tx = conn.unchecked_transaction()?;
    update_media_insertion_mode_impl(&tx, media_id, mode_str(mode)).map_err(DecideError::Io)?;
    db::queries::touch_entry_updated_at(&tx, entry_id)?;
    db::mark_entry_pending(&tx, entry_id)?;
    tx.commit()?;
    Ok(V3Decision::Applied {
        at: entry_stamp(conn, entry_id)?,
        from: Some(if own {
            base_updated_at
        } else {
            entry.updated_at
        }),
    })
}

/// Storage extension of an `attach_media` blob (README "Media policy"): audio by its
/// MIME; a generic file (core validate admits no other type here) by its sanitised
/// display name's extension, kept when it is `[a-z0-9]{1,8}`, else `bin`. `None` when
/// the desktop file picker would refuse that extension as an image, video or audio.
fn attach_extension(file_type: &str, file_name: &str) -> Option<String> {
    if let Some(ext) = ext_from_mime(file_type) {
        return Some(ext.to_string());
    }
    let name = sanitize_attachment_filename(file_name);
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let mime = mime_from_ext(&ext);
    if ["image/", "video/", "audio/"]
        .iter()
        .any(|p| mime.starts_with(p))
    {
        return None;
    }
    let plain = (1..=8).contains(&ext.len())
        && ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    Some(if plain { ext } else { "bin".to_string() })
}

/// An `attach_media` blob (`m-<mediaId>`) as the cycle read it.
#[derive(Clone, Copy, Debug)]
pub(crate) enum AttachBlob<'a> {
    /// Not read this cycle (missing or unreadable file, timeout, media budget, dirty
    /// pull): the intent waits, unrecorded.
    NotRead,
    /// Read, but it does not open under the content keys that opened its intent: final.
    Undecryptable,
    /// Read and decrypted.
    Opened(&'a [u8]),
}

/// `attach_media` (rank 40): audio or a generic file, attached, on a visible live
/// entry. A row already holding `media_id` on this entry is applied (a replay, or a
/// peer desktop applied it and this one pulled the row); on another entry it is
/// `media_entry_mismatch`; a tombstoned id is `media_deleted` (never resurrected). The
/// row shows the file's sanitised display name, as a desktop attach does; the blob is
/// stored as `<mediaId>.<ext>`. `blob` is `m-<mediaId>` as the cycle read it: not read
/// waits (unrecorded); one that does not decrypt is `invalid`. The row and
/// `mark_entry_pending` commit together, so peers always pull it; the ack carries the
/// stamp read after both.
#[allow(clippy::too_many_arguments)]
fn decide_attach_media(
    conn: &Connection,
    ctx: &ApplyContext,
    entry_id: &str,
    media_id: &str,
    file_name: &str,
    file_type: &str,
    size: u64,
    duration_ms: Option<u64>,
    blob: AttachBlob,
) -> Result<V3Decision, DecideError> {
    let entry = match writable_web_entry(conn, ctx, entry_id)? {
        Ok(e) => e,
        Err(d) => return Ok(d),
    };
    if let Some(media) = get_media(conn, media_id)? {
        if media.entry_id != entry_id {
            return Ok(V3Decision::Refused(MEDIA_ENTRY_MISMATCH.to_string()));
        }
        return Ok(V3Decision::Applied {
            at: entry.updated_at,
            from: None,
        });
    }
    if db::queries::media_tombstone_exists(conn, media_id)? {
        return Ok(V3Decision::Refused(MEDIA_DELETED.to_string()));
    }
    let Some(ext) = attach_extension(file_type, file_name) else {
        return Ok(V3Decision::Refused(MEDIA_NOT_ALLOWED.to_string()));
    };
    let bytes = match blob {
        AttachBlob::Opened(bytes) => bytes,
        AttachBlob::NotRead => return Ok(V3Decision::Transient),
        AttachBlob::Undecryptable => {
            return Err(DecideError::Invalid("blob does not decrypt".to_string()))
        }
    };
    if bytes.len() as u64 != size {
        return Err(DecideError::Invalid(format!(
            "blob is {} bytes, intent says {size}",
            bytes.len()
        )));
    }
    let stored = (|| -> Result<(), String> {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        store_media(
            &tx,
            &ctx.media_dir,
            StoredMedia {
                id: media_id,
                entry_id,
                ext: &ext,
                file_type,
                bytes,
                thumb: None,
                insertion_mode: "attached",
                duration_seconds: duration_ms.map(|ms| ms as f64 / 1000.0),
            },
        )?;
        // The display name a desktop attach of this file stores (`media.file_name`, which
        // the attachment UI shows); kept as `<id>.<ext>` when it is not a safe peer
        // cache name (`resolve_media` would refuse to fetch it).
        let display = sanitize_attachment_filename(file_name);
        if is_safe_cache_filename(&display) {
            db::queries::set_media_file_name(&tx, media_id, &display).map_err(|e| e.to_string())?;
        }
        db::queries::touch_entry_updated_at(&tx, entry_id).map_err(|e| e.to_string())?;
        db::mark_entry_pending(&tx, entry_id).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(e) = stored {
        // The row rolled back: drop the blob written for it.
        let _ = std::fs::remove_file(ctx.media_dir.join(format!("{media_id}.{ext}")));
        return Err(DecideError::Io(e));
    }
    Ok(V3Decision::Applied {
        at: entry_stamp(conn, entry_id)?,
        from: Some(entry.updated_at),
    })
}

/// `delete_media` (rank 40): on a visible live entry, `delete_media_inner` tombstones
/// the row (peers drop it), bumps the entry stamp, marks it pending and unlinks the
/// files; the own-cloud prune is then re-armed, as the desktop command does. A row
/// already gone is applied; a row of another entry is `media_entry_mismatch`.
fn decide_delete_media(
    conn: &Connection,
    ctx: &ApplyContext,
    entry_id: &str,
    media_id: &str,
) -> Result<V3Decision, DecideError> {
    let entry = match writable_web_entry(conn, ctx, entry_id)? {
        Ok(e) => e,
        Err(d) => return Ok(d),
    };
    let Some(media) = get_media(conn, media_id)? else {
        return Ok(V3Decision::Applied {
            at: entry.updated_at,
            from: None,
        });
    };
    if media.entry_id != entry_id {
        return Ok(V3Decision::Refused(MEDIA_ENTRY_MISMATCH.to_string()));
    }
    delete_media_inner(conn, media_id).map_err(DecideError::Io)?;
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(V3Decision::Applied {
        at: bump_entry_stamp(conn, entry_id)?,
        from: Some(entry.updated_at),
    })
}

/// `delete_memory_item` (rank 80): desktop wins on the item's stamp, chained on this
/// `y-` path's own applies; already deleted is applied; unknown is `absent`. The
/// tombstone is the desktop command's write (`memory.bin` republishes it by LWW). A
/// plain tombstone reveals nothing about the item's sources.
fn decide_delete_memory_item(
    conn: &Connection,
    path: &str,
    id: &str,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let Some(row) = db::memory::get_memory_item(conn, id)? else {
        return Ok(V3Decision::Refused(ABSENT.to_string()));
    };
    if row.is_deleted {
        return Ok(V3Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    let Some(from) = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?
    else {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    db::memory::tombstone_memory_item(conn, id, chrono::Utc::now().timestamp())?;
    let at = db::memory::get_memory_item(conn, id)?
        .map(|r| r.updated_at)
        .ok_or_else(|| DecideError::Io(format!("memory item {id} vanished")))?;
    Ok(V3Decision::Applied {
        at,
        from: Some(from),
    })
}

/// `update_persona` (rank 80): desktop wins on `user_persona.updated_at`, chained on the
/// `q-user-persona` path's own applies. The text is the desktop edit command's write,
/// made only when the sanitised traits / style differ (it always sets `user_edited`);
/// `enabled` only when it differs. Both commit together and the ack carries the stamp
/// read after both (each write bumps it).
fn decide_update_persona(
    conn: &Connection,
    path: &str,
    traits_text: &str,
    style_text: &str,
    enabled: bool,
    base_updated_at: i64,
) -> Result<V3Decision, DecideError> {
    let row = db::persona::read_persona(conn)?;
    let traits = sanitize_persona_text(traits_text);
    let style = sanitize_persona_text(style_text);
    let text_changed = row.traits_text != traits || row.style_text != style;
    let enabled_changed = row.enabled != enabled;
    let from = fast_forward_from(
        conn,
        &ChainTarget::Path(path),
        Some(base_updated_at),
        row.updated_at,
    )?;
    if !text_changed && !enabled_changed {
        return Ok(V3Decision::Applied {
            at: row.updated_at,
            from,
        });
    }
    let Some(from) = from else {
        return Ok(V3Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    let tx = conn.unchecked_transaction()?;
    if text_changed {
        db::persona::write_persona_user_edit(&tx, &traits, &style)?;
    }
    if enabled_changed {
        db::persona::set_persona_enabled(&tx, enabled)?;
    }
    tx.commit()?;
    Ok(V3Decision::Applied {
        at: db::persona::read_persona(conn)?.updated_at,
        from: Some(from),
    })
}

/// The v3 dispatch point: one arm per kind (every kind in `APPLIED_KINDS`). `blob`: the
/// `attach_media` blob the cycle downloaded (ignored by every other kind).
fn decide_intent_v3(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    intent: &OutboxIntentV3,
    blob: AttachBlob,
) -> Result<V3Decision, DecideError> {
    // Already checked when the file was opened; repeated here so this entry point
    // never writes an intent the wire contract rejects.
    intent
        .validate()
        .map_err(|e| DecideError::Invalid(e.to_string()))?;
    match intent {
        OutboxIntentV3::UpsertTag {
            tag_id,
            name,
            color,
            base_updated_at: None,
            ..
        } => {
            let outcome = db::queries::create_tag_with_id(conn, tag_id, name, color.as_deref())?;
            decide_create_v3(outcome, tag_id, || {
                Ok(db::queries::get_tag_for_import(conn, tag_id)?
                    .map(|t| (t.updated_at, !t.is_deleted)))
            })
        }
        OutboxIntentV3::UpsertJournal {
            journal_id,
            name,
            color,
            auto_tag_ids,
            base_updated_at: None,
            ..
        } => {
            let outcome = db::queries::create_journal_with_id(
                conn,
                journal_id,
                name,
                color.as_deref(),
                auto_tag_ids,
            )?;
            decide_create_v3(outcome, journal_id, || {
                Ok(db::queries::get_journal(conn, journal_id)?.map(|j| {
                    (
                        j.updated_at,
                        !j.is_deleted && !j.is_invisible && !j.is_locked,
                    )
                }))
            })
        }
        OutboxIntentV3::UpsertTag {
            tag_id,
            name,
            color,
            base_updated_at: Some(base),
            ..
        } => decide_update_tag(conn, path, tag_id, name, color.as_deref(), *base),
        OutboxIntentV3::UpsertJournal {
            journal_id,
            name,
            color,
            auto_tag_ids,
            base_updated_at: Some(base),
            ..
        } => decide_update_journal(
            conn,
            path,
            journal_id,
            name,
            color.as_deref(),
            auto_tag_ids,
            *base,
        ),
        OutboxIntentV3::DeleteTag {
            tag_id,
            base_updated_at,
            ..
        } => decide_delete_tag(conn, path, tag_id, *base_updated_at),
        OutboxIntentV3::DeleteJournal {
            journal_id,
            base_updated_at,
            ..
        } => decide_delete_journal(conn, path, journal_id, *base_updated_at),
        OutboxIntentV3::UpsertTemplate {
            template_id,
            name,
            description,
            content_b64,
            sort_order,
            base_updated_at,
            ..
        } => decide_upsert_template(
            conn,
            path,
            template_id,
            name,
            description.as_deref(),
            content_b64.as_deref(),
            *sort_order,
            *base_updated_at,
        )
        .map(V3Decision::from),
        OutboxIntentV3::DeleteTemplate {
            template_id,
            base_updated_at,
            ..
        } => {
            decide_delete_template(conn, path, template_id, *base_updated_at).map(V3Decision::from)
        }
        OutboxIntentV3::TrashEntry {
            entry_id,
            base_updated_at,
            ..
        } => decide_trash_entry(conn, ctx, path, entry_id, *base_updated_at).map(V3Decision::from),
        OutboxIntentV3::RestoreEntry {
            entry_id,
            base_updated_at,
            ..
        } => decide_restore_entry(conn, ctx, path, entry_id, *base_updated_at),
        OutboxIntentV3::PurgeEntry {
            entry_id,
            base_updated_at,
            ..
        } => decide_purge_entry(conn, ctx, path, entry_id, *base_updated_at),
        OutboxIntentV3::EmptyTrash { items, .. } => decide_empty_trash(conn, ctx, path, items),
        OutboxIntentV3::SetEntryLocation {
            entry_id,
            value,
            base,
            base_updated_at,
            ..
        } => decide_set_entry_location(
            conn,
            ctx,
            path,
            entry_id,
            value.as_ref(),
            base.as_ref(),
            *base_updated_at,
        ),
        OutboxIntentV3::SetMediaInsertionMode {
            entry_id,
            media_id,
            mode,
            base_mode,
            base_updated_at,
            ..
        } => decide_set_media_insertion_mode(
            conn,
            ctx,
            path,
            entry_id,
            media_id,
            *mode,
            *base_mode,
            *base_updated_at,
        ),
        OutboxIntentV3::AttachMedia {
            entry_id,
            media_id,
            file_name,
            file_type,
            size,
            duration_ms,
            ..
        } => decide_attach_media(
            conn,
            ctx,
            entry_id,
            media_id,
            file_name,
            file_type,
            *size,
            *duration_ms,
            blob,
        ),
        OutboxIntentV3::DeleteMedia {
            entry_id, media_id, ..
        } => decide_delete_media(conn, ctx, entry_id, media_id),
        OutboxIntentV3::DeleteMemoryItem {
            memory_id,
            base_updated_at,
            ..
        } => decide_delete_memory_item(conn, path, memory_id, *base_updated_at),
        OutboxIntentV3::UpdatePersona {
            traits_text,
            style_text,
            enabled,
            base_updated_at,
            ..
        } => decide_update_persona(
            conn,
            path,
            traits_text,
            style_text,
            *enabled,
            *base_updated_at,
        ),
    }
}

/// Apply one decoded v3 intent and record its outcome like `apply_intent_v2`, except
/// that the ack of every applied kind carries `applied_updated_at` (creates also set
/// `created`) and a refusal carries `refused_reason`. `blob`: see `decide_intent_v3`.
pub(crate) fn apply_intent_v3(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    content_hash: &str,
    revision: Option<String>,
    intent: &OutboxIntentV3,
    blob: AttachBlob,
) -> Outcome {
    // Desktop behind its peers: a base comparison could refuse on stale rows.
    if !ctx.pull_clean {
        return Outcome::Transient;
    }
    let decision = match decide_intent_v3(conn, ctx, path, intent, blob) {
        Ok(d) => d,
        Err(e @ DecideError::Invalid(_)) => {
            log::warn!("outbox_import: v3 intent {path} refused: {e}");
            V3Decision::Refused(INVALID.to_string())
        }
        Err(DecideError::Io(e)) => {
            log::warn!("outbox_import: v3 intent {path} failed: {e}");
            return Outcome::Transient;
        }
    };
    let (outcome, applied_at, applied_from, created, reason) = match decision {
        V3Decision::Transient => return Outcome::Transient,
        V3Decision::Created { at, from } => (Outcome::Applied, Some(at), from, true, None),
        V3Decision::Applied { at, from } => (Outcome::Applied, Some(at), from, false, None),
        V3Decision::Refused(code) => (
            Outcome::Refused(code.clone()),
            None,
            None,
            false,
            Some(code),
        ),
    };
    let rec = WebOutboxImportRecord {
        path: path.to_string(),
        revision,
        content_hash: content_hash.to_string(),
        outcome: if reason.is_some() {
            "refused"
        } else {
            "applied"
        }
        .to_string(),
        imported_at: chrono::Utc::now().timestamp(),
        last_applied_updated_at: applied_at,
        post_import_fingerprint: None,
        // The entry this row's edge belongs to (`ChainTarget::Entry`). The ack loop reads
        // this column as field decisions and finds none, so it never reaches an ack.
        decided_fields: v3_entry_target(intent)
            .map(|entry_id| serde_json::json!({ "entry_id": entry_id }).to_string()),
        pending_revision: None,
        pending_plan: reason,
        created,
        applied_from_updated_at: applied_from,
    };
    let _ = outbox_import_record(conn, &rec);
    outcome
}

/// Execute a full outbox import cycle against the given provider.
pub async fn run_outbox_import_cycle<C: ConnAccess, S: OutboxEventSink>(
    provider: &(dyn SyncProvider + Send + Sync),
    keyring_io: &(dyn KeyringV2Io + Send + Sync),
    own_device_id: &str,
    key_list: &ContentKeyList,
    known_ids: HashMap<String, bool>,
    pull_clean: bool,
    summary: &SyncSummary,
    media_dir: &Path,
    access: &C,
    sink: &S,
) -> Result<OutboxImportSummary, SyncError> {
    // 1. Discovery: find candidate web devices from device slots
    let slots = crate::sync::keyring_v2::io::list_device_slots(keyring_io).await?;
    let candidates: Vec<String> = slots
        .into_iter()
        .map(|s| s.device_id)
        .filter(|id| {
            id != own_device_id
                && !summary.fetched_manifests.contains(id)
                && !summary.unchanged_peers.contains(id)
        })
        .collect();

    // 2. Enumerate outbox files for each candidate
    let mut intent_paths = Vec::new();
    for candidate in &candidates {
        match provider.list_files(candidate, FileKind::Outbox).await {
            Ok(files) => {
                for file in files {
                    if file.ends_with(".bin") {
                        intent_paths.push(file);
                    }
                }
            }
            Err(e) => {
                log::warn!("outbox_import: list_files({candidate}, Outbox) failed: {e}");
            }
        }
    }
    // Read in apply-rank order (see `path_rank`), each `d-<E>` right after its `<E>.bin`.
    let listed: HashSet<String> = intent_paths.iter().cloned().collect();
    intent_paths.sort_by_cached_key(|p| read_order_key(p, &listed));

    // 3. Check table rows & Read Own Acks
    let table_has_imports = access.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT 1 FROM web_outbox_imports WHERE path != '__acks__' LIMIT 1")
            .map_err(sync_io)?;
        let exists = stmt.exists([]).map_err(sync_io)?;
        Ok(exists)
    })?;

    let mut own_acks = OutboxAcksV1 {
        schema_version: 1,
        desktop_device_id: own_device_id.to_string(),
        acks: vec![],
    };
    let mut own_acks_failed = false;
    let mut own_cloud_file_missing = false;

    if table_has_imports || !intent_paths.is_empty() {
        let acks_cloud_path = format!("{own_device_id}/outbox-acks.bin");
        match provider.read_file(&acks_cloud_path).await {
            Ok(bytes) => match open_outbox_acks(key_list, &bytes) {
                Ok(parsed) => {
                    own_acks = parsed;
                }
                Err(e) => {
                    log::error!("outbox_import: web acks unreadable: {e}");
                    own_acks_failed = true;
                }
            },
            Err(SyncError::NotFound(_)) => {
                own_cloud_file_missing = true;
            }
            Err(e) => {
                log::warn!("outbox_import: read own acks failed: {e}");
                own_acks_failed = true;
            }
        }
    }

    // 4. Per-Intent Processing Loop
    let start_time = tokio::time::Instant::now();
    const MAX_WALL_CLOCK: Duration = Duration::from_secs(60);
    // The read pass stops here, so the apply pass always has time to record what was
    // read; otherwise slow reads could fill the budget and every cycle would re-read
    // the same files without applying any.
    const MAX_READ_WALL_CLOCK: Duration = Duration::from_secs(30);
    // Sealed bytes held for the apply pass (one intent is at most
    // MAX_OUTBOX_PAYLOAD_BYTES = 32 MiB, so 20 of them alone could reach 640 MiB).
    const MAX_DECODED_BYTES: usize = 64 * 1024 * 1024;
    const MAX_CHANGED_INTENTS: usize = 20;
    const MAX_MEDIA_BYTES: u64 = 200 * 1024 * 1024;
    const MAX_THUMB_BYTES: u64 = 2 * 1024 * 1024;

    let mut changed_intents_count = 0;
    let mut decoded_bytes: usize = 0;
    let mut total_media_bytes: u64 = 0;
    let mut summary_out = OutboxImportSummary {
        candidates_checked: candidates.len(),
        intents_listed: intent_paths.len(),
        ..Default::default()
    };

    let own_acks_map: HashMap<String, OutboxAckEntry> = own_acks
        .acks
        .iter()
        .map(|a| (a.path.clone(), a.clone()))
        .collect();

    let effective_pull_clean = pull_clean && !own_acks_failed;

    // 4a. Read + decode pass. Corrupt and unknown-version files are recorded here (final,
    // order-irrelevant); readable intents wait for the apply pass. Reading stops at
    // MAX_CHANGED_INTENTS files, MAX_READ_WALL_CLOCK, or once the held intents reach
    // MAX_DECODED_BYTES (checked before each read, so one intent may overshoot it by at
    // most MAX_OUTBOX_PAYLOAD_BYTES), so memory stays bounded.
    let mut decoded: Vec<DecodedIntent> = Vec::new();
    let checked_total = intent_paths.len() as u32;
    let mut checked_count: u32 = 0;
    let mut previous_path: Option<String> = None;
    for (checked, intent_path) in intent_paths.into_iter().enumerate() {
        // A `d-<E>` read right after its `<E>.bin` is never cut from it (`read_order_key`);
        // the budget overshoots by at most that one file.
        let pairs_with_previous =
            previous_path.is_some() && trash_sibling_entry_path(&intent_path) == previous_path;
        if !pairs_with_previous
            && (start_time.elapsed() >= MAX_READ_WALL_CLOCK
                || changed_intents_count >= MAX_CHANGED_INTENTS
                || decoded_bytes >= MAX_DECODED_BYTES)
        {
            log::info!("outbox_import: budget reached, deferring remaining intents to next cycle");
            break;
        }
        previous_path = Some(intent_path.clone());
        checked_count = checked as u32 + 1;
        sink.emit_progress(checked_count, checked_total);

        let recorded =
            access.with_conn(|conn| outbox_import_get(conn, &intent_path).map_err(sync_io))?;
        let recorded_revision = recorded.as_ref().and_then(|r| r.revision.as_deref());
        let is_pending = recorded.as_ref().is_some_and(is_pending);

        let (bytes, revision): (Vec<u8>, Option<String>) = if is_pending {
            match provider.read_file(&intent_path).await {
                Ok(b) => {
                    let rev = recorded_revision.map(|s| s.to_string());
                    (b, rev)
                }
                Err(e) => {
                    log::warn!("outbox_import: read_file({intent_path}) failed: {e}");
                    summary_out.intents_transient += 1;
                    continue;
                }
            }
        } else {
            match provider
                .read_file_if_changed(&intent_path, recorded_revision)
                .await
            {
                Ok(ConditionalRead::Unchanged) => {
                    summary_out.intents_skipped_unchanged += 1;
                    continue;
                }
                Ok(ConditionalRead::Changed { bytes, revision }) => (bytes, revision),
                Err(e) => {
                    log::warn!("outbox_import: read_file_if_changed({intent_path}) failed: {e}");
                    summary_out.intents_transient += 1;
                    continue;
                }
            }
        };

        let content_hash = hex::encode(sha2::Sha256::digest(&bytes));
        let opened = open_outbox_intent(key_list, &bytes)
            .map_err(|e| match e {
                // A supported frame version whose body disagrees is malformed, not newer.
                OutboxError::UnsupportedVersion(v) if SUPPORTED_OUTBOX_VERSIONS.contains(&v) => {
                    ReadSkip::Corrupt(format!("body version {v} does not match its frame"))
                }
                OutboxError::UnsupportedVersion(v) => ReadSkip::Version(v),
                // Whatever its letter: a newer web may use a letter this build never saw.
                OutboxError::UnknownKind(kind) => ReadSkip::Kind(kind),
                other => ReadSkip::Corrupt(other.to_string()),
            })
            .and_then(|intent| decode_named_intent(&intent_path, intent));

        changed_intents_count += 1;

        let body = match opened {
            Ok(body) => body,
            Err(skip) => {
                let (outcome, pending_plan) = match skip {
                    ReadSkip::Version(v) => {
                        log::warn!("outbox_import: intent {intent_path} unsupported version {v}");
                        ("skipped_version", Some(v.to_string()))
                    }
                    ReadSkip::Kind(kind) => {
                        log::warn!("outbox_import: intent {intent_path} kind {kind} not applied");
                        ("skipped_kind", Some(kind))
                    }
                    ReadSkip::Corrupt(e) => {
                        log::warn!("outbox_import: intent {intent_path} corrupt: {e}");
                        ("corrupt", None)
                    }
                };
                let rec = WebOutboxImportRecord {
                    path: intent_path.clone(),
                    revision: revision.clone(),
                    content_hash: content_hash.clone(),
                    outcome: outcome.to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: None,
                    pending_revision: None,
                    pending_plan,
                    created: false,
                    applied_from_updated_at: None,
                };
                let _ = access.with_conn(|conn| outbox_import_record(conn, &rec).map_err(sync_io));
                summary_out.intents_refused += 1;
                continue;
            }
        };

        decoded_bytes += bytes.len();
        decoded.push(DecodedIntent {
            path: intent_path,
            content_hash,
            revision,
            body,
        });
    }

    // 4b. Apply pass, across all web devices, by the decoded kind's rank (`RANK_*`): tags
    // → journals → templates → restore → v1 entry intents → location / media → insertion
    // mode → trash / purge → empty trash → delete tag → delete journal → memory / persona;
    // within a rank by `web_updated_at_secs`, then path.
    // Baked into installed builds: a journal must find its auto tags, and an entry the
    // journal / tags created with it.
    decoded.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
    let ctx = ApplyContext {
        known_ids,
        pull_clean: effective_pull_clean,
        own_acks: own_acks_map,
        media_dir: media_dir.to_path_buf(),
    };
    for DecodedIntent {
        path: intent_path,
        content_hash,
        revision,
        body,
    } in decoded
    {
        // No wall-clock cut here: v2 and media-less v1 applies are local and cheap, and
        // the media download below defers its own intent (unrecorded) past the budget.
        let entry = match body {
            Decoded::V1(entry) => *entry,
            Decoded::V2(v2) => {
                sink.on_intent_dispatched(&intent_path);
                let outcome = access.with_conn(|conn| {
                    Ok(apply_intent_v2(
                        conn,
                        &ctx,
                        &intent_path,
                        &content_hash,
                        revision,
                        &v2,
                    ))
                })?;
                match outcome {
                    Outcome::Applied => summary_out.intents_applied += 1,
                    Outcome::Transient => summary_out.intents_transient += 1,
                    _ => summary_out.intents_refused += 1,
                }
                continue;
            }
            Decoded::V3(v3) => {
                // `attach_media` brings its blob `m-<mediaId>` (no thumbnail), read from the
                // intent's OWN folder (never the body's `web_device_id`) under the v1 media
                // budget. A blob not read this cycle leaves `NotRead`: the intent waits,
                // unrecorded, unless decide refuses it first.
                let mut opened = None;
                let mut undecryptable = false;
                if let OutboxIntentV3::AttachMedia { media_id, size, .. } = &v3 {
                    let local_exists = access
                        .with_conn(|conn| {
                            Ok(get_media(conn, media_id).map_err(sync_io)?.is_some()
                                || db::queries::media_tombstone_exists(conn, media_id)
                                    .map_err(sync_io)?)
                        })
                        .unwrap_or(false);
                    if !ctx.pull_clean || local_exists {
                        // Decide waits (dirty pull), or finds the row or its tombstone:
                        // nothing to read.
                    } else if start_time.elapsed() >= MAX_WALL_CLOCK
                        || total_media_bytes + size > MAX_MEDIA_BYTES
                    {
                        log::info!("outbox_import: media budget reached, deferring {intent_path}");
                    } else {
                        let m_path = format!("{}/m-{media_id}", outbox_dir(&intent_path));
                        let read = provider.read_file(&m_path);
                        if let Ok(Ok(enc_bytes)) =
                            tokio::time::timeout(Duration::from_secs(45), read).await
                        {
                            let enc_len = enc_bytes.len() as u64;
                            if total_media_bytes + enc_len > MAX_MEDIA_BYTES {
                                log::warn!(
                                    "outbox_import: media download exceeded budget ({enc_len} bytes)"
                                );
                            } else if let Ok(dec) = open_media(key_list, &enc_bytes) {
                                total_media_bytes += enc_len;
                                summary_out.media_downloaded += 1;
                                summary_out.media_bytes_downloaded += enc_len;
                                sink.emit_progress(checked_count, checked_total);
                                opened = Some(dec);
                            } else {
                                log::warn!("outbox_import: blob {m_path} does not decrypt");
                                undecryptable = true;
                            }
                        }
                    }
                }
                sink.on_intent_dispatched(&intent_path);
                let outcome = access.with_conn(|conn| {
                    Ok(apply_intent_v3(
                        conn,
                        &ctx,
                        &intent_path,
                        &content_hash,
                        revision,
                        &v3,
                        match (&opened, undecryptable) {
                            (Some(bytes), _) => AttachBlob::Opened(bytes),
                            (None, true) => AttachBlob::Undecryptable,
                            (None, false) => AttachBlob::NotRead,
                        },
                    ))
                })?;
                match outcome {
                    Outcome::Applied => summary_out.intents_applied += 1,
                    Outcome::Transient => summary_out.intents_transient += 1,
                    _ => summary_out.intents_refused += 1,
                }
                continue;
            }
        };

        // Handle media downloads
        let mut media_payloads: HashMap<String, Option<Vec<u8>>> = HashMap::new();
        let mut media_thumb_payloads: HashMap<String, Option<Vec<u8>>> = HashMap::new();

        for m in &entry.media {
            if start_time.elapsed() >= MAX_WALL_CLOCK {
                log::info!("outbox_import: wall-clock budget reached during media download");
                media_payloads.insert(m.media_id.clone(), None);
                break;
            }

            let local_exists = access
                .with_conn(|conn| {
                    get_media(conn, &m.media_id)
                        .map(|row| row.is_some())
                        .map_err(sync_io)
                })
                .unwrap_or(false);

            if local_exists {
                media_payloads.insert(m.media_id.clone(), Some(vec![]));
                if m.has_thumb {
                    media_thumb_payloads.insert(m.media_id.clone(), Some(vec![]));
                }
                continue;
            }

            if total_media_bytes + m.size > MAX_MEDIA_BYTES {
                log::warn!("outbox_import: media budget exceeded, deferring intent {intent_path}");
                media_payloads.insert(m.media_id.clone(), None);
                break;
            }

            let m_path = format!("{}/outbox/m-{}", entry.web_device_id, m.media_id);
            let read_media_fut = provider.read_file(&m_path);
            let media_res =
                match tokio::time::timeout(Duration::from_secs(45), read_media_fut).await {
                    Ok(Ok(enc_bytes)) => {
                        let enc_len = enc_bytes.len() as u64;
                        if total_media_bytes + enc_len > MAX_MEDIA_BYTES {
                            log::warn!(
                                "outbox_import: media download exceeded budget ({enc_len} bytes)"
                            );
                            None
                        } else {
                            match open_media(key_list, &enc_bytes) {
                                Ok(dec) => {
                                    total_media_bytes += enc_len;
                                    summary_out.media_downloaded += 1;
                                    summary_out.media_bytes_downloaded += enc_len;
                                    // Same count again: keeps the UI watchdog alive during
                                    // long media downloads.
                                    sink.emit_progress(checked_count, checked_total);
                                    Some(dec)
                                }
                                Err(_) => None,
                            }
                        }
                    }
                    _ => None,
                };
            media_payloads.insert(m.media_id.clone(), media_res);

            if m.has_thumb {
                if start_time.elapsed() >= MAX_WALL_CLOCK {
                    log::info!("outbox_import: wall-clock budget reached during thumb download");
                    media_thumb_payloads.insert(m.media_id.clone(), None);
                    break;
                }
                let t_path = format!("{}/outbox/m-{}.thumb", entry.web_device_id, m.media_id);
                let read_thumb_fut = provider.read_file(&t_path);
                let thumb_res =
                    match tokio::time::timeout(Duration::from_secs(45), read_thumb_fut).await {
                        Ok(Ok(enc_bytes)) => {
                            let enc_len = enc_bytes.len() as u64;
                            if enc_len > MAX_THUMB_BYTES
                                || total_media_bytes + enc_len > MAX_MEDIA_BYTES
                            {
                                log::warn!(
                                "outbox_import: thumb download exceeded budget ({enc_len} bytes)"
                            );
                                None
                            } else {
                                match open_media(key_list, &enc_bytes) {
                                    Ok(dec) => {
                                        total_media_bytes += enc_len;
                                        Some(dec)
                                    }
                                    Err(_) => None,
                                }
                            }
                        }
                        _ => None,
                    };
                media_thumb_payloads.insert(m.media_id.clone(), thumb_res);
            }
        }

        let intent = OutboxIntent {
            path: intent_path.clone(),
            entry,
            content_hash,
            revision,
            media_payloads,
            media_thumb_payloads,
        };

        sink.on_intent_dispatched(&intent.path);
        let apply_res = access.with_conn(|conn| Ok(apply_intent_full(conn, &ctx, &intent)))?;

        for entry_id in &apply_res.touched_entry_ids {
            sink.mark_embedding_dirty(entry_id);
        }

        if let Some(ref event) = apply_res.bridge_event {
            sink.emit_bridge_event(event);
        }

        match apply_res.outcome {
            Outcome::Applied => summary_out.intents_applied += 1,
            Outcome::Refused(_) => summary_out.intents_refused += 1,
            Outcome::Transient => summary_out.intents_transient += 1,
            Outcome::SkippedVersion(_) => summary_out.intents_refused += 1,
            Outcome::Corrupt(_) => summary_out.intents_refused += 1,
        }
    }

    // 5. Writing Acks (`outbox-acks.bin`)
    if !own_acks_failed {
        let table_rows = access.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT path, revision, content_hash, outcome, imported_at, last_applied_updated_at, \
                     post_import_fingerprint, decided_fields, pending_revision, pending_plan, created \
                     FROM web_outbox_imports WHERE path != '__acks__'",
                )
                .map_err(sync_io)?;
            let rows: Vec<WebOutboxImportRecord> = stmt
                .query_map([], |row| {
                    Ok(WebOutboxImportRecord {
                        path: row.get(0)?,
                        revision: row.get(1)?,
                        content_hash: row.get(2)?,
                        outcome: row.get(3)?,
                        imported_at: row.get(4)?,
                        last_applied_updated_at: row.get(5)?,
                        post_import_fingerprint: row.get(6)?,
                        decided_fields: row.get(7)?,
                        pending_revision: row.get(8)?,
                        pending_plan: row.get(9)?,
                        created: row.get(10)?,
                        applied_from_updated_at: None,
                    })
                })
                .map_err(sync_io)?
                .filter_map(Result::ok)
                .collect();
            Ok(rows)
        })?;

        let has_cloud_created = own_acks.acks.iter().any(|a| a.created);
        let should_consider_acks = !table_rows.is_empty() || has_cloud_created;

        if should_consider_acks {
            let mut acks_map: BTreeMap<String, OutboxAckEntry> = BTreeMap::new();
            for cloud_ack in &own_acks.acks {
                if cloud_ack.created {
                    acks_map.insert(cloud_ack.path.clone(), cloud_ack.clone());
                }
            }

            for row in &table_rows {
                // An unapplied kind is not decided: the web keeps waiting for a newer desktop.
                if row.outcome == "pending" || row.outcome == "skipped_kind" {
                    continue;
                }
                let decided: Vec<OutboxFieldDecision> = row
                    .decided_fields
                    .as_deref()
                    .and_then(|s| {
                        serde_json::from_str::<BTreeMap<String, OutboxFieldDecision>>(s).ok()
                    })
                    .map(|m| m.into_values().collect())
                    .unwrap_or_default();

                let prior_created = acks_map.get(&row.path).map(|a| a.created).unwrap_or(false);
                let entry_created = row.created || prior_created;

                let refused_reason = if row.outcome == "refused" {
                    row.pending_plan.clone()
                } else {
                    None
                };

                acks_map.insert(
                    row.path.clone(),
                    OutboxAckEntry {
                        path: row.path.clone(),
                        content_hash: row.content_hash.clone(),
                        applied_updated_at: row.last_applied_updated_at,
                        decided,
                        created: entry_created,
                        refused_reason,
                    },
                );
            }

            let new_acks = OutboxAcksV1 {
                schema_version: 1,
                desktop_device_id: own_device_id.to_string(),
                acks: acks_map.into_values().collect(),
            };

            let plain_bytes = bincode::DefaultOptions::new()
                .with_fixint_encoding()
                .with_limit(memlore_core::outbox::MAX_OUTBOX_PAYLOAD_BYTES)
                .serialize(&new_acks)
                .map_err(|e| SyncError::Io(e.to_string()))?;

            let plain_hash = format!(
                "{}:{}",
                key_list.latest,
                hex::encode(sha2::Sha256::digest(&plain_bytes))
            );

            let last_written_hash = access
                .with_conn(|conn| outbox_import_get(conn, "__acks__").map_err(sync_io))?
                .map(|r| r.content_hash);

            let hash_changed = last_written_hash.as_deref() != Some(&plain_hash);
            let should_write = hash_changed || own_cloud_file_missing;

            if should_write {
                let sealed = seal_outbox_acks(key_list, &new_acks)
                    .map_err(|e| SyncError::Io(e.to_string()))?;
                let cloud_path = format!("{own_device_id}/outbox-acks.bin");
                provider.write_file(&cloud_path, &sealed).await?;

                let marker = WebOutboxImportRecord {
                    path: "__acks__".to_string(),
                    revision: None,
                    content_hash: plain_hash,
                    outcome: "written".to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: None,
                    pending_revision: None,
                    pending_plan: None,
                    created: false,
                    applied_from_updated_at: None,
                };
                access.with_conn(|conn| outbox_import_record(conn, &marker).map_err(sync_io))?;
                summary_out.acks_written = true;
            }
        }
    }

    Ok(summary_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use memlore_core::outbox::{FieldChange, OutboxFields, OutboxMediaRef};
    use yrs::updates::encoder::Encode;
    use yrs::Text;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    fn default_journal_id(conn: &Connection) -> String {
        db::queries::list_journals(conn, None).unwrap()[0]
            .id
            .clone()
    }

    fn make_test_yjs(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let txt = doc.get_or_insert_text("default");
        txt.push(&mut doc.transact_mut(), text);
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        bytes
    }

    fn make_base_intent(entry_id: &str, web_device_id: &str) -> OutboxIntent {
        let entry = OutboxEntryV1 {
            schema_version: 1,
            entry_id: entry_id.to_string(),
            web_device_id: web_device_id.to_string(),
            created_on_web: false,
            web_updated_at_secs: 1000,
            base_state_vector: vec![0],
            yjs_full_state: vec![],
            content_text: None,
            preview_text: None,
            fields: OutboxFields::default(),
            media: vec![],
        };
        OutboxIntent {
            path: format!("{}/outbox/{}.bin", web_device_id, entry_id),
            entry,
            content_hash: "hash-1".to_string(),
            revision: Some("rev-1".to_string()),
            media_payloads: HashMap::new(),
            media_thumb_payloads: HashMap::new(),
        }
    }

    #[test]
    fn test_title_emotion_favorite_tags_apply_on_existing_entry() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        // Create local entry
        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Old Title"),
            Some("Content"),
            Some("Preview"),
            1_700_000_000,
        )
        .unwrap();

        // Create a local tag
        let tag = db::queries::create_tag(&conn, "Focus", None).unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "New Title".to_string(),
            base: "Old Title".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1001,
        });
        intent.entry.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: local.updated_at,
            change_seq: 2,
            changed_at_secs: 1002,
        });
        intent.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 3,
            changed_at_secs: 1003,
        });
        intent.entry.fields.tags_add.insert(
            tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: local.updated_at,
                change_seq: 4,
                changed_at_secs: 1004,
            },
        );

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let updated = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(updated.title.as_deref(), Some("New Title"));
        assert_eq!(updated.emotion.as_deref(), Some("good"));
        assert!(updated.is_favorite);

        let tags = db::queries::get_tag_ids_for_entry(&conn, &local.id).unwrap();
        assert!(tags.contains(&tag.id));
    }

    #[test]
    fn test_create_applies_every_field_and_auto_tags() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        // Configure auto-tag on default journal
        let auto_tag = db::queries::create_tag(&conn, "AutoTag", None).unwrap();
        db::queries::set_journal_auto_tags(&conn, &jid, &[auto_tag.id.clone()]).unwrap();

        let eid = "created-entry-12345";
        let yjs_bytes = make_test_yjs("Created on web text");

        let mut intent = make_base_intent(eid, "web-dev-1");
        intent.entry.created_on_web = true;
        intent.entry.yjs_full_state = yjs_bytes.clone();
        intent.entry.content_text = Some("Created on web text".to_string());
        intent.entry.preview_text = Some("Created on web text".to_string());
        intent.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent.entry.fields.title = Some(FieldChange {
            value: "Web Created".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1000,
        });
        intent.entry.fields.emotion = Some(FieldChange {
            value: Some("neutral".to_string()),
            base: None,
            base_updated_at: 0,
            change_seq: 3,
            changed_at_secs: 1000,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![eid.to_string()]);

        let created = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(created.title.as_deref(), Some("Web Created"));
        assert_eq!(created.content_text.as_deref(), Some("Created on web text"));
        assert_eq!(created.emotion.as_deref(), Some("neutral"));

        let content_blob = db::queries::get_entry_content(&conn, eid).unwrap().unwrap();
        assert_eq!(content_blob, yjs_bytes);

        // Auto-tag was attached
        let tags = db::queries::get_tag_ids_for_entry(&conn, eid).unwrap();
        assert!(tags.contains(&auto_tag.id));
    }

    #[test]
    fn test_absent_entry_live_in_peer_manifest_returns_transient() {
        let conn = setup_test_db();
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "absent-live-entry-1";
        ctx.known_ids.insert(eid.to_string(), false); // live

        let intent = make_base_intent(eid, "web-dev-1");
        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Transient);
        assert!(touched.is_empty());

        let record = outbox_import_get(&conn, &intent.path).unwrap();
        assert!(record.is_none(), "transient outcome must not be recorded");
    }

    #[test]
    fn test_web_creates_e_desktop_imports_web_edits_again_second_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-and-edit";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.fields.title = Some(FieldChange {
            value: "Initial Title".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1000,
        });

        let (outcome1, _) = apply_intent(&conn, &ctx, &intent1);
        assert_eq!(outcome1, Outcome::Applied);

        let entry_after1 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(entry_after1.title.as_deref(), Some("Initial Title"));

        // Second intent: edits title
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.title = Some(FieldChange {
            value: "Second Title".to_string(),
            base: "Initial Title".to_string(),
            base_updated_at: entry_after1.updated_at,
            change_seq: 3,
            changed_at_secs: 2000,
        });

        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);
        assert_eq!(touched2, vec![eid.to_string()]);

        let entry_after2 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(entry_after2.title.as_deref(), Some("Second Title"));
    }

    /// The web moves its own new entry to another journal before it has seen the desktop's
    /// copy: the second revision still carries the create's synthetic base (`""`, 0). The
    /// desktop has not touched the row since it imported the create, so the move applies.
    #[test]
    fn test_web_created_entry_moved_before_web_saw_desktop_copy_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let web_journal = db::queries::create_journal(&conn, "Web Journal", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-then-move";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        let (outcome1, _) = apply_intent(&conn, &ctx, &intent1);
        assert_eq!(outcome1, Outcome::Applied);

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.journal_id = Some(FieldChange {
            value: web_journal.id.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1001,
        });
        let (outcome2, _) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.journal_id, web_journal.id,
            "the web's move must apply"
        );
        let rec = outbox_import_get(&conn, &intent2.path).unwrap().unwrap();
        let decided: BTreeMap<String, OutboxFieldDecision> =
            serde_json::from_str(rec.decided_fields.as_deref().unwrap()).unwrap();
        assert_eq!(decided["journal_id@2"].decision, "applied");
    }

    /// Resume from the update path's pending marker (a crash before the final record): the
    /// marker keeps `applied_from_updated_at`, so the resumed apply still sees the chain.
    #[test]
    fn test_web_created_entry_move_applies_after_crash_resume() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let web_journal = db::queries::create_journal(&conn, "Web Journal", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-move-crash";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);

        // The pending marker as the update path writes it (chain kept), then a crash.
        let mut rec = outbox_import_get(&conn, &intent1.path).unwrap().unwrap();
        let local_before = db::queries::get_entry(&conn, eid)
            .unwrap()
            .unwrap()
            .updated_at;
        rec.outcome = "pending".to_string();
        rec.pending_revision = Some("rev-2".to_string());
        rec.pending_plan = serde_json::to_string(&PendingPlan {
            is_create: false,
            local_before,
        })
        .ok();
        outbox_import_record(&conn, &rec).unwrap();

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.journal_id = Some(FieldChange {
            value: web_journal.id.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1001,
        });
        apply_intent(&conn, &ctx, &intent2);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.journal_id, web_journal.id,
            "the resumed move must apply"
        );
    }

    /// Same move, but the desktop moved the entry itself after importing the create: the
    /// desktop wins, and a later web edit of the field stays refused.
    #[test]
    fn test_web_created_entry_moved_after_desktop_moved_it_is_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let web_journal = db::queries::create_journal(&conn, "Web Journal", None).unwrap();
        let desk_journal = db::queries::create_journal(&conn, "Desk Journal", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-desktop-moves";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);

        move_entry_to_journal_impl(&conn, eid, &desk_journal.id).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = updated_at + 5 WHERE id = ?1",
            [eid],
        )
        .unwrap();

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.journal_id = Some(FieldChange {
            value: web_journal.id.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1001,
        });
        apply_intent(&conn, &ctx, &intent2);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.journal_id, desk_journal.id,
            "the desktop's move must win"
        );
        let rec = outbox_import_get(&conn, &intent2.path).unwrap().unwrap();
        let decided: BTreeMap<String, OutboxFieldDecision> =
            serde_json::from_str(rec.decided_fields.as_deref().unwrap()).unwrap();
        assert_eq!(decided["journal_id@2"].decision, "refused");

        // The row is untouched since that import, but that import ran after the desktop's move,
        // so its chain starts at the desktop's stamp, not the web's base 0.
        let mut intent3 = make_base_intent(eid, "web-dev-1");
        intent3.entry.created_on_web = true;
        intent3.revision = Some("rev-3".to_string());
        intent3.content_hash = "hash-3".to_string();
        intent3.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 3,
            changed_at_secs: 1002,
        });
        apply_intent(&conn, &ctx, &intent3);
        let after3 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(after3.journal_id, desk_journal.id, "the desktop still wins");
    }

    /// A desktop rename, then a web revision that does not decide the title (it re-baselines
    /// `untouched`), then a web rename on the create's synthetic base: the desktop still wins.
    #[test]
    fn test_web_rename_after_desktop_rename_and_unrelated_revision_is_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-desktop-renames";
        let title = |value: &str, seq: u64| {
            Some(FieldChange {
                value: value.to_string(),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: seq,
                changed_at_secs: 1000,
            })
        };

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.fields.title = title("A", 2);
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);

        conn.execute(
            "UPDATE entries SET title = 'B', updated_at = updated_at + 5 WHERE id = ?1",
            [eid],
        )
        .unwrap();

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: 0,
            change_seq: 3,
            changed_at_secs: 1001,
        });
        apply_intent(&conn, &ctx, &intent2);
        // The desktop rename broke the chain: the unrelated web edit is refused too.
        let after2 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(after2.emotion, None);

        let mut intent3 = make_base_intent(eid, "web-dev-1");
        intent3.entry.created_on_web = true;
        intent3.revision = Some("rev-3".to_string());
        intent3.content_hash = "hash-3".to_string();
        intent3.entry.fields.title = title("C", 4);
        apply_intent(&conn, &ctx, &intent3);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.title.as_deref(),
            Some("B"),
            "the desktop's rename must win"
        );
    }

    /// The web tags its new entry, then untags it before seeing the desktop copy.
    #[test]
    fn test_web_created_entry_tag_removed_before_web_saw_desktop_copy_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let tag = db::queries::create_tag(&conn, "Focus", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-then-untag";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.fields.tags_add.insert(
            tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: 0,
                change_seq: 2,
                changed_at_secs: 1000,
            },
        );
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);
        assert!(db::queries::get_tag_ids_for_entry(&conn, eid)
            .unwrap()
            .contains(&tag.id));

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.tags_remove.insert(
            tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: 0,
                change_seq: 3,
                changed_at_secs: 1001,
            },
        );
        apply_intent(&conn, &ctx, &intent2);
        assert!(!db::queries::get_tag_ids_for_entry(&conn, eid)
            .unwrap()
            .contains(&tag.id));
    }

    #[test]
    fn test_later_desktop_title_edit_wins() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Desktop First Title"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // Web saw local at t0
        let t0 = 1000;
        conn.execute(
            "UPDATE entries SET updated_at = 1000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        // Desktop edits title at t1 (t1 > t0)
        let desktop_edited =
            update_entry_impl(&conn, &local.id, Some("Desktop Newer Title"), None, None).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = 2000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();
        assert!(desktop_edited.updated_at >= t0);

        // Web attempts to apply an edit based on t0
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Web Stale Title".to_string(),
            base: "Desktop First Title".to_string(),
            base_updated_at: t0,
            change_seq: 1,
            changed_at_secs: 1005,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert!(touched.is_empty(), "stale title must not touch the entry");

        let entry_after = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(
            entry_after.title.as_deref(),
            Some("Desktop Newer Title"),
            "desktop edit must win"
        );
    }

    #[test]
    fn test_interleaved_desktop_title_and_web_emotion() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Original Title"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        let t0 = 1000;
        conn.execute(
            "UPDATE entries SET updated_at = 1000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        // Desktop retitles at t1.5 (2000 > 1000)
        update_entry_impl(&conn, &local.id, Some("Desktop Retitled"), None, None).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = 2000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        // Web changes emotion at t2 with base_updated_at = t0
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Web Title".to_string(),
            base: "Original Title".to_string(),
            base_updated_at: t0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent.entry.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: t0,
            change_seq: 2,
            changed_at_secs: 2000,
        });

        let (outcome, _touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        // Note: because desktop updated at t1.5, whole-entry base_updated_at differs,
        // so desktop title stays and web emotion is refused per whole-entry LWW
        let final_entry = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(final_entry.title.as_deref(), Some("Desktop Retitled"));
    }

    #[test]
    fn test_second_import_is_no_op() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Title"),
            Some("Body"),
            Some("Preview"),
            1_700_000_000,
        )
        .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Title 2".to_string(),
            base: "Title".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1001,
        });

        let (outcome1, touched1) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome1, Outcome::Applied);
        assert_eq!(touched1, vec![local.id.clone()]);

        let after1 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        let updated_at1 = after1.updated_at;

        // Second import of the exact same intent
        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome2, Outcome::Applied);
        assert!(touched2.is_empty(), "second import must touch nothing");

        let after2 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(
            after2.updated_at, updated_at1,
            "updated_at must remain unchanged"
        );
    }

    #[test]
    fn test_locked_invisible_deleted_targets_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        // 1. Deleted target
        let local_deleted = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("To Delete"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        crate::commands::entries::soft_delete_entry_impl(&conn, &local_deleted.id).unwrap();

        let intent_del = make_base_intent(&local_deleted.id, "web-dev-1");
        let (outcome_del, _) = apply_intent(&conn, &ctx, &intent_del);
        // A trashed target is refused with its own reason, which is what the
        // ack carries (`refused_reason` comes from `pending_plan`).
        assert_eq!(outcome_del, Outcome::Refused("entry_trashed".to_string()));
        let rec = outbox_import_get(&conn, &intent_del.path).unwrap().unwrap();
        assert_eq!(rec.outcome, "refused");
        assert_eq!(rec.pending_plan.as_deref(), Some("entry_trashed"));

        // 2. Locked target
        let local_locked = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Locked Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            [&local_locked.id],
        )
        .unwrap();

        let intent_lock = make_base_intent(&local_locked.id, "web-dev-1");
        let (outcome_lock, _) = apply_intent(&conn, &ctx, &intent_lock);
        assert!(matches!(outcome_lock, Outcome::Refused(_)));

        // 3. Invisible journal target
        let inv_journal = db::queries::create_journal(&conn, "Invisible Journal", None).unwrap();
        conn.execute(
            "UPDATE journals SET is_invisible = 1 WHERE id = ?1",
            [&inv_journal.id],
        )
        .unwrap();
        let local_inv_j = crate::commands::entries::create_entry_impl(
            &conn,
            &inv_journal.id,
            Some("Invis J Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let intent_inv_j = make_base_intent(&local_inv_j.id, "web-dev-1");
        let (outcome_inv_j, _) = apply_intent(&conn, &ctx, &intent_inv_j);
        assert!(matches!(outcome_inv_j, Outcome::Refused(_)));
    }

    #[test]
    fn test_deleted_tag_id_is_dropped_and_rest_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Tag Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // Valid tag
        let good_tag = db::queries::create_tag(&conn, "GoodTag", None).unwrap();
        // Deleted tag
        let del_tag = db::queries::create_tag(&conn, "DelTag", None).unwrap();
        db::queries::delete_tag(&conn, &del_tag.id).unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Title Applied".to_string(),
            base: "Tag Entry".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent.entry.fields.tags_add.insert(
            good_tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: local.updated_at,
                change_seq: 2,
                changed_at_secs: 1000,
            },
        );
        intent.entry.fields.tags_add.insert(
            del_tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: local.updated_at,
                change_seq: 3,
                changed_at_secs: 1000,
            },
        );

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let updated = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(updated.title.as_deref(), Some("Title Applied"));

        let tags = db::queries::get_tag_ids_for_entry(&conn, &local.id).unwrap();
        assert!(tags.contains(&good_tag.id));
        assert!(!tags.contains(&del_tag.id));
    }

    #[test]
    fn test_no_resurrection_when_entry_in_known_ids_or_not_created_on_web_or_dirty_pull() {
        let conn = setup_test_db();
        let dir = tempfile::tempdir().unwrap();
        let eid = "resurrect-candidate-1";

        // 1. In known_ids as deleted -> Refused
        let mut ctx1 = ApplyContext::new(dir.path().to_path_buf());
        ctx1.known_ids.insert(eid.to_string(), true); // deleted

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        let (res1, _) = apply_intent(&conn, &ctx1, &intent1);
        assert_eq!(res1, Outcome::Refused("absent".to_string()));

        // 2. Not created on web and absent -> Refused
        let ctx2 = ApplyContext::new(dir.path().to_path_buf());
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = false;
        let (res2, _) = apply_intent(&conn, &ctx2, &intent2);
        assert_eq!(res2, Outcome::Refused("absent".to_string()));

        // 3. Dirty pull -> Transient
        let mut ctx3 = ApplyContext::new(dir.path().to_path_buf());
        ctx3.pull_clean = false;
        let mut intent3 = make_base_intent(eid, "web-dev-1");
        intent3.entry.created_on_web = true;
        let (res3, _) = apply_intent(&conn, &ctx3, &intent3);
        assert_eq!(res3, Outcome::Transient);
    }

    #[test]
    fn test_media_keeps_id_and_cloud_path_passes_validation() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Media Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let mid = "media-uuid-12345";
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.media.push(OutboxMediaRef {
            media_id: mid.to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            size: 4,
            has_thumb: true,
        });
        intent
            .media_payloads
            .insert(mid.to_string(), Some(vec![1, 2, 3, 4]));
        intent
            .media_thumb_payloads
            .insert(mid.to_string(), Some(vec![5, 6]));

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let media_row = db::queries::get_media(&conn, mid).unwrap().unwrap();
        assert_eq!(media_row.id, mid);
        assert_eq!(media_row.upload_status, "pending");

        // Construct expected cloud_path when desktop sync uploads it:
        let cloud_path = format!("desktop-dev-1/media/{mid}");
        let validated_dev = crate::commands::media::validate_cloud_path(&cloud_path, mid).unwrap();
        assert_eq!(validated_dev, "desktop-dev-1");
    }

    #[test]
    fn test_empty_base_non_creation_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Has Content"),
            Some("Some content"),
            Some("Some preview"),
            1_700_000_000,
        )
        .unwrap();

        let local_yjs = make_test_yjs("Some content");
        save_entry_content_impl(&conn, &local.id, &local_yjs, "Some content", "Some preview")
            .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.created_on_web = false;
        intent.entry.base_state_vector = vec![]; // empty base
        intent.entry.yjs_full_state = make_test_yjs("New content");

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Refused("empty_base".to_string()));
        assert!(touched.is_empty());
    }

    #[test]
    fn test_version_snapshot_is_taken_on_content_change() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Snapshot Entry"),
            Some("Old content"),
            Some("Old preview"),
            1_700_000_000,
        )
        .unwrap();

        let local_doc = Doc::new();
        let txt = local_doc.get_or_insert_text("default");
        txt.push(&mut local_doc.transact_mut(), "Old content");
        let local_yjs = local_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        save_entry_content_impl(&conn, &local.id, &local_yjs, "Old content", "Old preview")
            .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.base_state_vector = local_doc.transact().state_vector().encode_v1();

        let web_doc = Doc::new();
        let _ = web_doc
            .transact_mut()
            .apply_update(Update::decode_v1(&local_yjs).unwrap());
        let web_txt = web_doc.get_or_insert_text("default");
        web_txt.push(&mut web_doc.transact_mut(), " + web text");
        intent.entry.yjs_full_state = web_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        intent.entry.content_text = Some("Old content + web text".to_string());

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let versions = db::queries::list_entry_versions(&conn, &local.id).unwrap();
        assert_eq!(versions.len(), 1, "version snapshot must be recorded");

        // Second import of same intent: no snapshot
        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome2, Outcome::Applied);
        assert!(touched2.is_empty());

        let versions2 = db::queries::list_entry_versions(&conn, &local.id).unwrap();
        assert_eq!(versions2.len(), 1, "no extra snapshot taken");
    }

    #[test]
    fn test_sync_state_pending_on_applied_change() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Sync State Test"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "New Title".to_string(),
            base: "Sync State Test".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        apply_intent(&conn, &ctx, &intent);

        let ver1 = db::queries::get_entry_local_version(&conn, &local.id)
            .unwrap()
            .unwrap();
        let sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&local.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sync_status, "pending");

        // Second import: local_version stays unchanged
        apply_intent(&conn, &ctx, &intent);
        let ver2 = db::queries::get_entry_local_version(&conn, &local.id)
            .unwrap()
            .unwrap();
        assert_eq!(ver2, ver1);
    }

    #[test]
    fn test_missing_media_returns_transient_unrecorded() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Missing Media Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let mid = "media-missing-1";
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.media.push(OutboxMediaRef {
            media_id: mid.to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            size: 100,
            has_thumb: false,
        });
        // Media payload is missing (None)
        intent.media_payloads.insert(mid.to_string(), None);

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Transient);
        assert!(touched.is_empty());

        let record = outbox_import_get(&conn, &intent.path).unwrap();
        assert!(record.is_none());
    }

    #[test]
    fn test_journal_id_to_locked_invisible_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Move Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let locked_j = db::queries::create_journal(&conn, "Locked J", None).unwrap();
        conn.execute(
            "UPDATE journals SET is_locked = 1 WHERE id = ?1",
            [&locked_j.id],
        )
        .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.journal_id = Some(FieldChange {
            value: locked_j.id.clone(),
            base: jid.clone(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert!(touched.is_empty(), "entry must not move to locked journal");

        let after = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(after.journal_id, jid);

        let rec = outbox_import_get(&conn, &intent.path).unwrap().unwrap();
        assert_ne!(rec.outcome, "pending", "row must not be left pending");
    }

    #[test]
    fn test_race_content_only_then_title_applies_untouched() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Original Title"),
            Some("Initial body"),
            Some("Initial preview"),
            1_700_000_000,
        )
        .unwrap();
        let t0 = 1000;
        conn.execute(
            "UPDATE entries SET updated_at = 1000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        let local_yjs = make_test_yjs("Initial body");
        save_entry_content_impl(
            &conn,
            &local.id,
            &local_yjs,
            "Initial body",
            "Initial preview",
        )
        .unwrap();

        // Revision 1: Content only update
        let mut intent1 = make_base_intent(&local.id, "web-dev-1");
        let updated_yjs = make_test_yjs("Initial body + revision 1");
        let local_doc = load_yjs_doc(Some(&local_yjs)).unwrap();
        intent1.entry.base_state_vector = local_doc.transact().state_vector().encode_v1();
        intent1.entry.yjs_full_state = updated_yjs;
        intent1.entry.content_text = Some("Initial body + revision 1".to_string());
        intent1.entry.fields.title = None;

        let (res1, _) = apply_intent(&conn, &ctx, &intent1);
        assert_eq!(res1, Outcome::Applied);

        // Simulate updated_at bump to 2000
        conn.execute(
            "UPDATE entries SET updated_at = 2000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE web_outbox_imports SET last_applied_updated_at = 2000 WHERE path = ?1",
            [&intent1.path],
        )
        .unwrap();

        let after1 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(after1.updated_at >= t0);
        assert_eq!(
            after1.content_text.as_deref(),
            Some("Initial body + revision 1"),
            "content-only edit on clean base vector must not duplicate text"
        );

        // Revision 2: Web carries title change made at t0 (base_updated_at = t0)
        let mut intent2 = make_base_intent(&local.id, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.base_state_vector = Doc::new().transact().state_vector().encode_v1();
        intent2.entry.fields.title = Some(FieldChange {
            value: "Web Renamed Title".to_string(),
            base: "Original Title".to_string(),
            base_updated_at: t0,
            change_seq: 1,
            changed_at_secs: 1005,
        });

        let (res2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(res2, Outcome::Applied);
        assert_eq!(touched2, vec![local.id.clone()]);

        let after2 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(
            after2.title.as_deref(),
            Some("Web Renamed Title"),
            "untouched title must apply"
        );
    }

    #[test]
    fn test_aba_single_desktop_recorded_decision() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("ABA Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // 1. Web favorites E with change_seq = 1
        let mut intent1 = make_base_intent(&local.id, "web-dev-1");
        intent1.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        apply_intent(&conn, &ctx, &intent1);
        let e1 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(e1.is_favorite);

        // 2. User unfavorites locally on desktop
        toggle_favorite_impl(&conn, &local.id).unwrap();
        let e2 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(!e2.is_favorite);

        // 3. Web re-pushes revision with the same field change (change_seq = 1)
        let mut intent2 = make_base_intent(&local.id, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        apply_intent(&conn, &ctx, &intent2);

        // E must stay unfavorited because decision was already recorded
        let e3 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(
            !e3.is_favorite,
            "ABA decision record must protect local revert"
        );
    }

    #[test]
    fn test_same_second_revert_fingerprint_guard() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Same Second"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // Intent applies
        let mut intent1 = make_base_intent(&local.id, "web-dev-1");
        intent1.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        apply_intent(&conn, &ctx, &intent1);

        // In same second, user reverts favorite
        toggle_favorite_impl(&conn, &local.id).unwrap();

        // Stale intent retry with different change_seq but same-second updated_at
        let mut intent2 = make_base_intent(&local.id, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1000,
        });

        apply_intent(&conn, &ctx, &intent2);
        let e_final = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(
            !e_final.is_favorite,
            "fingerprint mismatch must prevent stale re-apply"
        );
    }

    #[test]
    fn test_emotion_clear_applied() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Emotion Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        update_entry_emotion_impl(&conn, &local.id, Some("good")).unwrap();
        let entry_with_emotion = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(entry_with_emotion.emotion.as_deref(), Some("good"));

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.emotion = Some(FieldChange {
            value: None,
            base: Some("good".to_string()),
            base_updated_at: entry_with_emotion.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let cleared = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(cleared.emotion, None, "emotion must be cleared");
    }

    #[test]
    fn test_created_on_web_text_race_crdt_union() {
        use yrs::types::xml::XmlIn;
        use yrs::{XmlElementPrelim, XmlFragment, XmlTextPrelim};

        fn add_paragraph(base: &[u8], text: &str) -> Vec<u8> {
            let doc = Doc::new();
            let _ = doc
                .transact_mut()
                .apply_update(Update::decode_v1(base).unwrap());
            let fragment = doc.get_or_insert_xml_fragment("default");
            fragment.push_back(
                &mut doc.transact_mut(),
                XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(text))]),
            );
            let bytes = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            bytes
        }

        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-race-crdt-entry";

        // 1. Web creates E
        let (yjs1, _, _) = crate::yjs_doc::build_entry_yjs(&["Web Hello"], &[]);
        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.yjs_full_state = yjs1.clone();
        intent1.entry.content_text = Some("Web Hello".to_string());
        apply_intent(&conn, &ctx, &intent1);

        // 2. Desktop edits text locally before web pulls it
        let local_yjs = add_paragraph(&yjs1, "Desktop Local Edit");
        save_entry_content_impl(
            &conn,
            eid,
            &local_yjs,
            "Web Hello\nDesktop Local Edit",
            "Web Hello\nDesktop Local Edit",
        )
        .unwrap();

        // 3. Web edits text again with created_on_web = true
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.created_on_web = true;
        intent2.entry.base_state_vector = vec![];
        intent2.entry.yjs_full_state = add_paragraph(&yjs1, "Web Second Edit");
        intent2.entry.content_text = Some("Web Hello\nWeb Second Edit".to_string());

        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);
        assert_eq!(touched2, vec![eid.to_string()]);

        // The text is the merged doc's, not either side's copy: both edits
        // once, the shared base once, and the excerpt matches it.
        let final_entry = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        let blob = db::queries::get_entry_content(&conn, eid).unwrap().unwrap();
        let (want_text, want_preview) = crate::yjs_doc::extract_entry_text(&blob).unwrap();
        let text = final_entry.content_text.unwrap();
        assert_eq!(text, want_text);
        assert_eq!(final_entry.preview_text.unwrap(), want_preview);
        assert_eq!(text.matches("Web Hello").count(), 1);
        assert_eq!(text.matches("Desktop Local Edit").count(), 1);
        assert_eq!(text.matches("Web Second Edit").count(), 1);
    }

    #[test]
    fn test_wipe_resurrection_guard_with_own_acks() {
        let conn = setup_test_db();
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "wiped-entry-123";

        // Own acks in cloud reports created: true
        ctx.own_acks.insert(
            format!("web-dev-1/outbox/{eid}.bin"),
            OutboxAckEntry {
                path: format!("web-dev-1/outbox/{eid}.bin"),
                content_hash: "hash-0".to_string(),
                applied_updated_at: Some(1000),
                decided: vec![],
                created: true,
                refused_reason: None,
            },
        );

        let mut intent = make_base_intent(eid, "web-dev-1");
        intent.entry.created_on_web = true;

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Refused("absent".to_string()));
        assert!(touched.is_empty());

        let rec = outbox_import_get(&conn, &intent.path).unwrap().unwrap();
        assert!(rec.created, "sticky created flag must be set to 1");
    }

    #[derive(Default)]
    struct TestOutboxSink {
        progress_events: std::sync::Mutex<Vec<(u32, u32)>>,
        bridge_events: std::sync::Mutex<Vec<OutboxBridgeEvent>>,
        dirty_entries: std::sync::Mutex<Vec<String>>,
        dispatched: std::sync::Mutex<Vec<String>>,
    }

    impl OutboxEventSink for TestOutboxSink {
        fn emit_bridge_event(&self, event: &OutboxBridgeEvent) {
            self.bridge_events.lock().unwrap().push(event.clone());
        }
        fn emit_progress(&self, current: u32, total: u32) {
            self.progress_events.lock().unwrap().push((current, total));
        }
        fn mark_embedding_dirty(&self, entry_id: &str) {
            self.dirty_entries
                .lock()
                .unwrap()
                .push(entry_id.to_string());
        }
        fn on_intent_dispatched(&self, path: &str) {
            self.dispatched.lock().unwrap().push(path.to_string());
        }
    }

    fn test_key_list() -> ContentKeyList {
        ContentKeyList {
            keys: BTreeMap::from([(1, zeroize::Zeroizing::new([42u8; 32]))]),
            latest: 1,
            db_key: zeroize::Zeroizing::new([0u8; 32]),
            master: zeroize::Zeroizing::new([42u8; 32]),
        }
    }

    #[tokio::test]
    async fn test_import_cycle_no_web_devices_only_one_slot_listing() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";

        // Write only own desktop device slot
        let own_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: own_device_id.to_string(),
            name: "Desktop 1".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &own_slot)
            .await
            .unwrap();

        let conn = setup_test_db();
        let key_list = test_key_list();
        let summary = SyncSummary::default();
        let sink = TestOutboxSink::default();

        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.candidates_checked, 0);
        assert_eq!(res.intents_listed, 0);
        assert_eq!(res.intents_applied, 0);
    }

    #[tokio::test]
    async fn test_import_cycle_bridge_events_and_progress_emitted() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "22222222-2222-2222-2222-222222222222";

        // Register both slots
        let own_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: own_device_id.to_string(),
            name: "Desktop 1".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &own_slot)
            .await
            .unwrap();
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();
        let eid = "entry-web-created-1";
        let mut fields = OutboxFields::default();
        fields.title = Some(FieldChange {
            value: "Web Created Title".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let entry = OutboxEntryV1 {
            schema_version: 1,
            entry_id: eid.to_string(),
            web_device_id: web_device_id.to_string(),
            created_on_web: true,
            web_updated_at_secs: 1000,
            base_state_vector: vec![],
            yjs_full_state: make_test_yjs("Content from web outbox"),
            content_text: Some("Content from web outbox".to_string()),
            preview_text: Some("Preview".to_string()),
            fields,
            media: vec![],
        };

        let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
        sync_p
            .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
            .await
            .unwrap();

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();

        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.candidates_checked, 1);
        assert_eq!(res.intents_listed, 1);
        assert_eq!(res.intents_applied, 1);
        assert!(res.acks_written);

        // Progress emitted
        let progress = sink.progress_events.lock().unwrap();
        assert!(!progress.is_empty());
        assert_eq!(progress[0], (1, 1)); // files checked / files listed
        assert!(progress.iter().all(|&(_, total)| total == 1));

        // Bridge event emitted
        let bridge = sink.bridge_events.lock().unwrap();
        assert_eq!(bridge.len(), 1);
        assert_eq!(bridge[0].kind, "created");
        assert_eq!(bridge[0].entry_id, eid);

        // Dirty embedding marked
        let dirty = sink.dirty_entries.lock().unwrap();
        assert!(dirty.contains(&eid.to_string()));

        // Entry present in DB
        let db_entry = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(db_entry.title.as_deref(), Some("Web Created Title"));
        assert_eq!(
            db_entry.content_text.as_deref(),
            Some("Content from web outbox")
        );
    }

    #[tokio::test]
    async fn test_import_cycle_budget_limits_intents_to_20() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "33333333-3333-3333-3333-333333333333";

        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();

        // Write 25 intents: e-00 to e-24
        for i in 0..25 {
            let eid = format!("entry-bgt-{:02}", i);
            let mut fields = OutboxFields::default();
            fields.title = Some(FieldChange {
                value: format!("Title {i}"),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: 1,
                changed_at_secs: 1000,
            });

            let entry = OutboxEntryV1 {
                schema_version: 1,
                entry_id: eid.clone(),
                web_device_id: web_device_id.to_string(),
                created_on_web: true,
                web_updated_at_secs: 1000 + i as i64,
                base_state_vector: vec![],
                yjs_full_state: make_test_yjs(&format!("Content {i}")),
                content_text: Some(format!("Content {i}")),
                preview_text: Some("P".to_string()),
                fields,
                media: vec![],
            };
            let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
            sync_p
                .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
                .await
                .unwrap();
        }

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();

        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.intents_listed, 25);
        assert_eq!(res.intents_applied, 20); // capped at 20!
    }

    /// A refused intent stores its reason in `pending_plan`; that must not mark it as a
    /// crash-pending intent, or it is re-downloaded every cycle and starves the budget.
    #[tokio::test]
    async fn test_import_cycle_refused_intents_are_not_reprocessed() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "55555555-5555-5555-5555-555555555555";

        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();

        // 25 edits of entries this desktop has never seen and that were not created on the
        // web: each one is refused ("absent") and recorded.
        for i in 0..25 {
            let eid = format!("entry-ref-{:02}", i);
            let mut fields = OutboxFields::default();
            fields.title = Some(FieldChange {
                value: format!("Title {i}"),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: 1,
                changed_at_secs: 1000,
            });
            let entry = OutboxEntryV1 {
                schema_version: 1,
                entry_id: eid.clone(),
                web_device_id: web_device_id.to_string(),
                created_on_web: false,
                web_updated_at_secs: 1000 + i as i64,
                base_state_vector: vec![],
                yjs_full_state: make_test_yjs(&format!("Content {i}")),
                content_text: Some(format!("Content {i}")),
                preview_text: Some("P".to_string()),
                fields,
                media: vec![],
            };
            let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
            sync_p
                .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
                .await
                .unwrap();
        }

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();
        let mut results = Vec::new();
        for _ in 0..3 {
            results.push(
                run_outbox_import_cycle(
                    &provider,
                    &provider,
                    own_device_id,
                    &key_list,
                    HashMap::new(),
                    true,
                    &summary,
                    &media_dir,
                    &conn,
                    &sink,
                )
                .await
                .unwrap(),
            );
        }

        assert_eq!(results[0].intents_refused, 20);
        // Cycle 2 skips the 20 already-refused intents and reaches the last 5.
        assert_eq!(results[1].intents_skipped_unchanged, 20);
        assert_eq!(results[1].intents_refused, 5);
        // Cycle 3 downloads nothing: every refusal is final until the intent file changes.
        assert_eq!(results[2].intents_skipped_unchanged, 25);
        assert_eq!(results[2].intents_refused, 0);

        // A version skip stays skipped while the version is unknown, and is re-read once this
        // build understands it (a desktop upgrade), even though the file did not change.
        let first = format!("{web_device_id}/outbox/entry-ref-00.bin");
        let cycle_with_skipped_version = async |version: &str| {
            conn.execute(
                "UPDATE web_outbox_imports SET outcome = 'skipped_version', pending_plan = ?1 \
                 WHERE path = ?2",
                rusqlite::params![version, first],
            )
            .unwrap();
            run_outbox_import_cycle(
                &provider,
                &provider,
                own_device_id,
                &key_list,
                HashMap::new(),
                true,
                &summary,
                &media_dir,
                &conn,
                &sink,
            )
            .await
            .unwrap()
        };
        let unknown = cycle_with_skipped_version("999").await;
        assert_eq!(unknown.intents_skipped_unchanged, 25);
        let now_known =
            cycle_with_skipped_version(&memlore_core::outbox::OUTBOX_SCHEMA_VERSION.to_string())
                .await;
        assert_eq!(now_known.intents_skipped_unchanged, 24);
        assert_eq!(now_known.intents_refused, 1);
    }

    #[tokio::test]
    async fn test_import_cycle_acks_written_and_self_heals() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "44444444-4444-4444-4444-444444444444";

        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();
        let eid = "entry-ack-test-1";
        let mut fields = OutboxFields::default();
        fields.title = Some(FieldChange {
            value: "Ack Test".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let entry = OutboxEntryV1 {
            schema_version: 1,
            entry_id: eid.to_string(),
            web_device_id: web_device_id.to_string(),
            created_on_web: true,
            web_updated_at_secs: 1000,
            base_state_vector: vec![],
            yjs_full_state: make_test_yjs("Content"),
            content_text: Some("Content".to_string()),
            preview_text: Some("P".to_string()),
            fields,
            media: vec![],
        };
        let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
        sync_p
            .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
            .await
            .unwrap();

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();

        let res1 = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert!(res1.acks_written);

        // Acks file exists on provider
        let acks_path = format!("{own_device_id}/outbox-acks.bin");
        let acks_bytes = sync_p.read_file(&acks_path).await.unwrap();
        assert!(!acks_bytes.is_empty());

        // Now delete the acks file in the cloud to simulate cloud cleanup
        sync_p.delete_file(&acks_path).await.unwrap();
        assert!(sync_p.read_file(&acks_path).await.is_err());

        // Run cycle again: missing own file causes self-healing re-write!
        let res2 = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert!(
            res2.acks_written,
            "acks must self-heal when missing from cloud"
        );
        let healed_bytes = sync_p.read_file(&acks_path).await.unwrap();
        assert!(!healed_bytes.is_empty());
    }

    // ---- Phase 14.1: version dispatch + apply order ----

    const V2_OWN: &str = "11111111-1111-1111-1111-111111111111";
    const V2_WEB_A: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const V2_WEB_B: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    /// Provider with a device slot for every given web device.
    async fn v2_fixture(
        web_ids: &[&str],
    ) -> (
        tempfile::TempDir,
        crate::sync::local_provider::LocalSyncProvider,
        PathBuf,
    ) {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        for id in web_ids {
            let slot = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: id.to_string(),
                name: "Web Companion".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
            };
            crate::sync::keyring_v2::io::write_device_slot(&provider, &slot)
                .await
                .unwrap();
        }
        (temp_dir, provider, media_dir)
    }

    async fn v2_cycle(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        media_dir: &Path,
        conn: &Connection,
        sink: &TestOutboxSink,
    ) -> OutboxImportSummary {
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        run_outbox_import_cycle(
            provider,
            provider,
            V2_OWN,
            &test_key_list(),
            HashMap::new(),
            true,
            &summary,
            media_dir,
            conn,
            sink,
        )
        .await
        .unwrap()
    }

    async fn write_v2(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
        intent: &memlore_core::outbox::OutboxIntentV2,
    ) {
        let sealed = memlore_core::outbox::seal_outbox_intent_v2(&test_key_list(), intent).unwrap();
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(path, &sealed).await.unwrap();
    }

    async fn write_v1(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
        entry: &OutboxEntryV1,
    ) {
        let sealed = memlore_core::outbox::seal_outbox_entry(&test_key_list(), entry).unwrap();
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(path, &sealed).await.unwrap();
    }

    fn v2_journal(web: &str, id: &str, ts: i64) -> memlore_core::outbox::OutboxIntentV2 {
        memlore_core::outbox::OutboxIntentV2::CreateJournal {
            web_device_id: web.to_string(),
            web_updated_at_secs: ts,
            journal_id: id.to_string(),
            name: format!("Journal {id}"),
            color: None,
            auto_tag_ids: vec![],
        }
    }

    fn v2_tag(web: &str, id: &str, ts: i64) -> memlore_core::outbox::OutboxIntentV2 {
        memlore_core::outbox::OutboxIntentV2::CreateTag {
            web_device_id: web.to_string(),
            web_updated_at_secs: ts,
            tag_id: id.to_string(),
            name: format!("Tag {id}"),
            color: None,
        }
    }

    fn v1_edit(web: &str, entry_id: &str, ts: i64) -> OutboxEntryV1 {
        let fields = OutboxFields {
            title: Some(FieldChange {
                value: "Edited".to_string(),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: 1,
                changed_at_secs: ts,
            }),
            ..Default::default()
        };
        OutboxEntryV1 {
            schema_version: 1,
            entry_id: entry_id.to_string(),
            web_device_id: web.to_string(),
            created_on_web: false,
            web_updated_at_secs: ts,
            base_state_vector: vec![],
            yjs_full_state: make_test_yjs("Body"),
            content_text: Some("Body".to_string()),
            preview_text: Some("Body".to_string()),
            fields,
            media: vec![],
        }
    }

    fn import_row(conn: &Connection, path: &str) -> Option<WebOutboxImportRecord> {
        outbox_import_get(conn, path).unwrap()
    }

    #[test]
    fn test_is_pending_skipped_version_rows_follow_supported_versions() {
        let row = |outcome: &str, plan: Option<&str>| WebOutboxImportRecord {
            path: "p".to_string(),
            revision: None,
            content_hash: "h".to_string(),
            outcome: outcome.to_string(),
            imported_at: 0,
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: plan.map(str::to_string),
            created: false,
            applied_from_updated_at: None,
        };
        assert!(is_pending(&row("skipped_version", Some("1"))));
        assert!(is_pending(&row("skipped_version", Some("2"))));
        assert!(is_pending(&row("skipped_version", Some("3"))));
        assert!(!is_pending(&row("skipped_version", Some("999"))));
        assert!(!is_pending(&row("skipped_version", Some("abc"))));
        assert!(!is_pending(&row("skipped_version", None)));
        assert!(is_pending(&row("pending", Some("{}"))));
        assert!(!is_pending(&row("pending", None)));
        assert!(!is_pending(&row("corrupt", Some("2"))));
        assert!(!is_pending(&row("refused", Some("2"))));

        // `skipped_kind` revives only once its kind is applied (APPLIED_KINDS).
        {
            let _none = AppliedKindsOverride::set(&[]);
            assert!(!is_pending(&row("skipped_kind", Some("upsert_tag"))));
        }
        let _applied = AppliedKindsOverride::set(&["upsert_tag"]);
        assert!(is_pending(&row("skipped_kind", Some("upsert_tag"))));
        assert!(!is_pending(&row("skipped_kind", Some("rename_entry"))));
        assert!(!is_pending(&row("skipped_kind", None)));
        assert!(!is_pending(&row("skipped_version", Some("upsert_tag"))));
    }

    /// This build applies every kind it can decode (and so advertises all of them in the
    /// manifest's `outbox_kinds`): a kind is never applied without a decoder, and a
    /// decodable kind is never left skipped.
    #[test]
    fn applied_kinds_are_the_supported_kinds() {
        use memlore_core::outbox::SUPPORTED_OUTBOX_KINDS;
        let mut applied = APPLIED_KINDS.to_vec();
        let mut supported = SUPPORTED_OUTBOX_KINDS.to_vec();
        applied.sort_unstable();
        supported.sort_unstable();
        assert_eq!(applied, supported);
    }

    /// An applied kind must reach the apply pass: a well-named body of it never decodes to
    /// `ReadSkip::Kind` (its `skipped_kind` row would be re-read every cycle) or anything
    /// else, and `decide_intent_v3` decides its fixture sample (an apply or a legitimate
    /// refusal) without an error.
    #[test]
    fn every_applied_kind_decodes_for_the_apply_pass() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/memlore-core/fixtures/web-outbox.v3.json");
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let known = fixture["expected"]["known"].as_array().unwrap();
        for kind in applied_kinds() {
            let case = known
                .iter()
                .find(|c| c["kind"] == *kind)
                .unwrap_or_else(|| panic!("{kind}: no sample in web-outbox.v3.json"));
            let intent: memlore_core::outbox::OutboxIntentV3 =
                serde_json::from_value(case["intent"].clone()).unwrap();
            let path = case["path"].as_str().unwrap();
            let Ok(Decoded::V3(intent)) = decode_named_intent(path, WireIntent::V3(intent)) else {
                panic!("{kind} does not decode for the apply pass");
            };
            // The samples of the upserts are creates; their update form needs an arm too.
            let mut forms = vec![intent.clone()];
            let mut update = intent;
            if let OutboxIntentV3::UpsertTag {
                base_updated_at, ..
            }
            | OutboxIntentV3::UpsertJournal {
                base_updated_at, ..
            } = &mut update
            {
                *base_updated_at = Some(1);
                forms.push(update);
            }
            for intent in &forms {
                let conn = setup_test_db();
                let (_dir, ctx) = v2_ctx();
                let decision = decide_intent_v3(&conn, &ctx, path, intent, AttachBlob::NotRead);
                assert!(
                    decision.is_ok(),
                    "{kind} decide failed: {:?}",
                    decision.as_ref().err()
                );
            }
        }
    }

    /// Apply order comes from the decoded kind (README "Kinds" table): a v2 intent ranks
    /// with its v3 equivalent, and every v3 file letter has a read hint.
    #[test]
    fn apply_rank_follows_the_kind_table() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/memlore-core/fixtures/web-outbox.v3.json");
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let rank = |body: Decoded| {
            DecodedIntent {
                path: String::new(),
                content_hash: String::new(),
                revision: None,
                body,
            }
            .sort_key()
            .0
        };
        let mut ranks: HashMap<String, u8> = HashMap::new();
        for case in fixture["expected"]["known"].as_array().unwrap() {
            let intent: memlore_core::outbox::OutboxIntentV3 =
                serde_json::from_value(case["intent"].clone()).unwrap();
            let file = case["path"].as_str().unwrap();
            assert_ne!(path_rank(file), RANK_UNKNOWN_LETTER, "{file}");
            ranks.insert(intent.kind().to_string(), rank(Decoded::V3(intent)));
        }
        let v2 = [
            ("upsert_tag", v2_tag(V2_WEB_A, "tag-rank-00001", 1)),
            (
                "upsert_journal",
                v2_journal(V2_WEB_A, "journal-rank-001", 1),
            ),
            (
                "upsert_template",
                v2_template("tpl-rank-00001", "T", b"x", None),
            ),
            ("delete_template", v2_delete_template("tpl-rank-00001", 1)),
            ("trash_entry", v2_trash("entry-rank-0001", 1)),
        ];
        for (kind, intent) in v2 {
            assert_eq!(rank(Decoded::V2(intent)), ranks[kind], "v2 {kind}");
        }
        ranks.insert(
            "v1_entry".to_string(),
            rank(Decoded::V1(Box::new(v1_edit(
                V2_WEB_A,
                "entry-rank-0001",
                1,
            )))),
        );
        let order: &[&[&str]] = &[
            &["upsert_tag"],
            &["upsert_journal"],
            &["upsert_template", "delete_template"],
            &["restore_entry"],
            &["v1_entry"],
            &["set_entry_location", "attach_media", "delete_media"],
            &["set_media_insertion_mode"],
            &["trash_entry", "purge_entry"],
            &["empty_trash"],
            &["delete_tag"],
            &["delete_journal"],
            &["delete_memory_item", "update_persona"],
        ];
        assert_eq!(order.concat().len(), ranks.len(), "every kind is placed");
        let group_rank = |g: &[&str]| {
            for k in g {
                assert_eq!(ranks[*k], ranks[g[0]], "{k} ranks with {}", g[0]);
            }
            ranks[g[0]]
        };
        for pair in order.windows(2) {
            assert!(
                group_rank(pair[0]) < group_rank(pair[1]),
                "{:?} before {:?}",
                pair[0],
                pair[1]
            );
        }
    }

    /// Replaces `APPLIED_KINDS` on this thread until dropped (`#[tokio::test]` runs the
    /// whole cycle on the test thread).
    struct AppliedKindsOverride;

    impl AppliedKindsOverride {
        fn set(kinds: &'static [&'static str]) -> Self {
            APPLIED_KINDS_OVERRIDE.with(|c| c.set(Some(kinds)));
            Self
        }
    }

    impl Drop for AppliedKindsOverride {
        fn drop(&mut self) {
            APPLIED_KINDS_OVERRIDE.with(|c| c.set(None));
        }
    }

    /// Seal an arbitrary JSON body in a frame-3 file, bypassing typed validation (the
    /// core `seal_frame` layout: magic, bincode fixint {version, fingerprint, 0x01 ‖ AEAD}).
    fn seal_raw_v3(json: &str) -> Vec<u8> {
        use memlore_core::encryption::{derive_sync_key, encrypt_data, key_fingerprint};
        #[derive(serde::Serialize)]
        struct Frame {
            schema_version: u16,
            key_fingerprint: [u8; 32],
            ciphertext: Vec<u8>,
        }
        let list = test_key_list();
        let key = derive_sync_key(&derive_sync_key(&list.keys[&list.latest]));
        let mut ciphertext = vec![0x01];
        ciphertext.extend(encrypt_data(&key, json.as_bytes()).unwrap());
        let frame = Frame {
            schema_version: memlore_core::outbox::OUTBOX_INTENT_V3_SCHEMA_VERSION,
            key_fingerprint: key_fingerprint(&key),
            ciphertext,
        };
        let mut out = memlore_core::outbox::OUTBOX_MAGIC.to_vec();
        out.extend(
            bincode::DefaultOptions::new()
                .with_fixint_encoding()
                .serialize(&frame)
                .unwrap(),
        );
        out
    }

    fn v3_tag(web: &str, id: &str) -> memlore_core::outbox::OutboxIntentV3 {
        memlore_core::outbox::OutboxIntentV3::UpsertTag {
            web_device_id: web.to_string(),
            web_updated_at_secs: 1,
            tag_id: id.to_string(),
            name: format!("Tag {id}"),
            color: None,
            base_updated_at: None,
        }
    }

    async fn write_raw(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
        sealed: &[u8],
    ) {
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(path, sealed).await.unwrap();
    }

    /// A frame-3 kind this build cannot decode is `skipped_kind` (never final `corrupt`),
    /// writes no ack, stays skipped while unknown, and is re-read once its kind is applied.
    #[tokio::test]
    async fn test_cycle_v3_unknown_kind_is_skipped_kind_without_ack() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        // Any letter: an unknown kind is skipped whatever its file name says.
        let path = format!("{V2_WEB_A}/outbox/z-thing-00000001.bin");
        let body = serde_json::json!({
            "kind": "rename_entry",
            "web_device_id": V2_WEB_A,
            "web_updated_at_secs": 1,
            "entry_id": "thing-00000001",
            "title": "secret title",
        });
        write_raw(&provider, &path, &seal_raw_v3(&body.to_string())).await;
        // An applied v2 intent, so an acks file is written this cycle.
        let jid = "journal-ack-v3-01";
        let jpath = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &jpath, &v2_journal(V2_WEB_A, jid, 1)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert!(res.acks_written);

        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "skipped_kind");
        assert_eq!(row.pending_plan.as_deref(), Some("rename_entry"));
        assert_eq!(*sink.dispatched.lock().unwrap(), vec![jpath.clone()]);

        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        let bytes = p
            .read_file(&format!("{V2_OWN}/outbox-acks.bin"))
            .await
            .unwrap();
        let acks = open_outbox_acks(&test_key_list(), &bytes).unwrap();
        assert!(acks.acks.iter().any(|a| a.path == jpath));
        assert!(
            acks.acks.iter().all(|a| a.path != path),
            "no ack for an unapplied kind"
        );

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(
            res2.intents_skipped_unchanged, 2,
            "unknown kind stays skipped"
        );

        let _applied = AppliedKindsOverride::set(&["rename_entry"]);
        let res3 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res3.intents_skipped_unchanged, 1, "re-read once applied");
    }

    /// A known v3 kind is decoded but not applied yet (`skipped_kind` with its kind name,
    /// no ack); under another letter or id it is malformed, so final `corrupt`. Once a
    /// build applies the kind, the unchanged file is re-read: the row flips to applied
    /// and its ack appears.
    #[tokio::test]
    async fn test_cycle_v3_known_kind_is_skipped_kind_unless_misnamed() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let tid = "tag-v3-known-0001";
        let sealed =
            memlore_core::outbox::seal_outbox_intent_v3(&test_key_list(), &v3_tag(V2_WEB_A, tid))
                .unwrap();
        let right = format!("{V2_WEB_A}/outbox/t-{tid}.bin");
        let wrong_letter = format!("{V2_WEB_A}/outbox/j-{tid}.bin");
        let wrong_id = format!("{V2_WEB_A}/outbox/t-tag-v3-other-0001.bin");
        for path in [&right, &wrong_letter, &wrong_id] {
            write_raw(&provider, path, &sealed).await;
        }

        // An applied v2 intent, so an acks file is written in the skipping cycle too.
        let jid = "journal-known-v3-1";
        let jpath = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &jpath, &v2_journal(V2_WEB_A, jid, 1)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        {
            let _older_build = AppliedKindsOverride::set(&["upsert_template"]);
            v2_cycle(&provider, &media_dir, &conn, &sink).await;
        }

        let row = import_row(&conn, &right).unwrap();
        assert_eq!(row.outcome, "skipped_kind");
        assert_eq!(row.pending_plan.as_deref(), Some("upsert_tag"));
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        let bytes = p
            .read_file(&format!("{V2_OWN}/outbox-acks.bin"))
            .await
            .unwrap();
        let acks = open_outbox_acks(&test_key_list(), &bytes).unwrap().acks;
        assert!(acks.iter().any(|a| a.path == jpath));
        assert!(acks.iter().all(|a| a.path != right), "no ack while skipped");
        for path in [&wrong_letter, &wrong_id] {
            assert_eq!(
                import_row(&conn, path).unwrap().outcome,
                "corrupt",
                "{path}"
            );
        }
        assert!(
            db::queries::list_tags(&conn, None)
                .unwrap()
                .iter()
                .all(|t| t.id != tid),
            "not applied"
        );
        assert_eq!(*sink.dispatched.lock().unwrap(), vec![jpath.clone()]);

        // Revival: this build applies upsert_tag.
        v2_cycle(&provider, &media_dir, &conn, &sink).await;
        let row = import_row(&conn, &right).unwrap();
        assert_eq!(row.outcome, "applied");
        let stamp = db::queries::get_tag_updated_at(&conn, tid)
            .unwrap()
            .unwrap();
        let ack = own_ack(&provider, &right).await;
        assert_eq!(ack.applied_updated_at, Some(stamp));
        assert!(ack.created);
        for path in [&wrong_letter, &wrong_id] {
            assert_eq!(import_row(&conn, path).unwrap().outcome, "corrupt");
        }
    }

    /// v1 files go through the v1 apply path, v2 files through the v2 one; both are
    /// recorded, so neither is re-read next cycle.
    #[tokio::test]
    async fn test_cycle_dispatches_per_version() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let eid = "entry-dispatch-0001";
        let jid = "journal-dispatch-01";
        let v1_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        let v2_path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v1(&provider, &v1_path, &v1_edit(V2_WEB_A, eid, 1000)).await;
        write_v2(&provider, &v2_path, &v2_journal(V2_WEB_A, jid, 1000)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;

        assert_eq!(res.intents_listed, 2);
        assert_eq!(res.intents_refused, 1, "v1 edit of an unknown entry");
        assert_eq!(res.intents_applied, 1, "v2 journal create");
        assert_eq!(import_row(&conn, &v1_path).unwrap().outcome, "refused");
        assert_eq!(import_row(&conn, &v2_path).unwrap().outcome, "applied");
        assert_eq!(
            *sink.dispatched.lock().unwrap(),
            vec![v2_path.clone(), v1_path.clone()]
        );

        let sink2 = TestOutboxSink::default();
        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink2).await;
        assert_eq!(res2.intents_skipped_unchanged, 2);
        assert!(sink2.dispatched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_cycle_name_kind_mismatch_is_corrupt() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let tid = "tag-mismatch-00001";
        // Tag body under a journal prefix.
        let wrong_prefix = format!("{V2_WEB_A}/outbox/j-{tid}.bin");
        write_v2(&provider, &wrong_prefix, &v2_tag(V2_WEB_A, tid, 1)).await;
        // Right prefix, other id.
        let wrong_id = format!("{V2_WEB_A}/outbox/t-tag-other-000001.bin");
        write_v2(&provider, &wrong_id, &v2_tag(V2_WEB_A, tid, 1)).await;
        // v2 body in a bare entry name.
        let bare = format!("{V2_WEB_A}/outbox/{tid}.bin");
        write_v2(&provider, &bare, &v2_tag(V2_WEB_A, tid, 1)).await;
        // v1 body under an intent prefix.
        let eid = "entry-mismatch-0001";
        let v1_prefixed = format!("{V2_WEB_A}/outbox/d-{eid}.bin");
        write_v1(&provider, &v1_prefixed, &v1_edit(V2_WEB_A, eid, 1)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;

        assert_eq!(res.intents_refused, 4);
        for path in [&wrong_prefix, &wrong_id, &bare, &v1_prefixed] {
            assert_eq!(
                import_row(&conn, path).unwrap().outcome,
                "corrupt",
                "{path}"
            );
        }
        assert!(sink.dispatched.lock().unwrap().is_empty());

        // Corrupt is final until the file changes.
        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_skipped_unchanged, 4);
    }

    #[tokio::test]
    async fn test_cycle_unknown_version_999_is_skipped_version() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-version-999";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        let mut sealed = memlore_core::outbox::seal_outbox_intent_v2(
            &test_key_list(),
            &v2_journal(V2_WEB_A, jid, 1),
        )
        .unwrap();
        // Frame version is the u16 right after the 4-byte magic (bincode fixint, LE).
        sealed[4..6].copy_from_slice(&999u16.to_le_bytes());
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        p.write_file(&path, &sealed).await.unwrap();

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;

        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "skipped_version");
        assert_eq!(row.pending_plan.as_deref(), Some("999"));

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(
            res2.intents_skipped_unchanged, 1,
            "unknown version stays skipped"
        );
    }

    /// A v1 frame whose inner body claims version 2 is malformed, not "newer": it must be
    /// final `corrupt`, or the now-supported "2" would re-read it every cycle forever.
    #[tokio::test]
    async fn test_cycle_v1_frame_with_inner_version_2_is_corrupt() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let eid = "entry-inner-v2-0001";
        let path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        let mut entry = v1_edit(V2_WEB_A, eid, 1);
        entry.schema_version = 2;
        write_v1(&provider, &path, &entry).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(import_row(&conn, &path).unwrap().outcome, "corrupt");

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_skipped_unchanged, 1);
    }

    /// v0.2.2 recorded v2 files as `skipped_version` / "2" with the file's revision. After
    /// the upgrade that row is pending again: re-read and dispatched although unchanged.
    #[tokio::test]
    async fn test_cycle_rereads_skipped_version_2_row() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-old-skip-1";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &path, &v2_journal(V2_WEB_A, jid, 1)).await;
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        let revision = match p.read_file_if_changed(&path, None).await.unwrap() {
            ConditionalRead::Changed { revision, .. } => revision,
            ConditionalRead::Unchanged => unreachable!(),
        };
        assert!(revision.is_some());

        let conn = setup_test_db();
        let old_row = WebOutboxImportRecord {
            path: path.clone(),
            revision: revision.clone(),
            content_hash: "old-hash".to_string(),
            outcome: "skipped_version".to_string(),
            imported_at: 1,
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: Some("2".to_string()),
            created: false,
            applied_from_updated_at: None,
        };
        outbox_import_record(&conn, &old_row).unwrap();

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_skipped_unchanged, 0);
        assert_eq!(*sink.dispatched.lock().unwrap(), vec![path.clone()]);
        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "applied");
        assert!(row.created);
        assert_eq!(row.revision, revision);
        assert!(db::queries::get_journal(&conn, jid).unwrap().is_some());

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_skipped_unchanged, 1, "applied is final");
    }

    /// Across all web devices: tags → journals → templates → v1 entries → trash; within a
    /// kind by `web_updated_at_secs`, then path.
    #[tokio::test]
    async fn test_cycle_applies_in_kind_order_across_web_devices() {
        use memlore_core::outbox::OutboxIntentV2;
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A, V2_WEB_B]).await;
        let path = |web: &str, name: &str| format!("{web}/outbox/{name}.bin");

        let trash_a = path(V2_WEB_A, "d-entry-order-00001");
        write_v2(
            &provider,
            &trash_a,
            &OutboxIntentV2::TrashEntry {
                web_device_id: V2_WEB_A.to_string(),
                web_updated_at_secs: 1,
                entry_id: "entry-order-00001".to_string(),
                base_updated_at: 1,
            },
        )
        .await;
        let entry_a = path(V2_WEB_A, "entry-order-00001");
        write_v1(
            &provider,
            &entry_a,
            &v1_edit(V2_WEB_A, "entry-order-00001", 2),
        )
        .await;
        let entry_b = path(V2_WEB_B, "entry-order-00002");
        write_v1(
            &provider,
            &entry_b,
            &v1_edit(V2_WEB_B, "entry-order-00002", 1),
        )
        .await;
        let tpl_a = path(V2_WEB_A, "p-template-order-1");
        write_v2(
            &provider,
            &tpl_a,
            &OutboxIntentV2::DeleteTemplate {
                web_device_id: V2_WEB_A.to_string(),
                web_updated_at_secs: 3,
                template_id: "template-order-1".to_string(),
                base_updated_at: 1,
            },
        )
        .await;
        let tag_a = path(V2_WEB_A, "t-tag-order-0001");
        write_v2(&provider, &tag_a, &v2_tag(V2_WEB_A, "tag-order-0001", 400)).await;
        let tag_b = path(V2_WEB_B, "t-tag-order-0002");
        write_v2(&provider, &tag_b, &v2_tag(V2_WEB_B, "tag-order-0002", 300)).await;
        let journal_a = path(V2_WEB_A, "j-journal-order-1");
        write_v2(
            &provider,
            &journal_a,
            &v2_journal(V2_WEB_A, "journal-order-1", 500),
        )
        .await;
        let journal_b = path(V2_WEB_B, "j-journal-order-2");
        write_v2(
            &provider,
            &journal_b,
            &v2_journal(V2_WEB_B, "journal-order-2", 10),
        )
        .await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;

        assert_eq!(
            *sink.dispatched.lock().unwrap(),
            vec![tag_b, tag_a, journal_b, journal_a, tpl_a, entry_b, entry_a, trash_a]
        );
    }

    /// Tags apply before journals: a journal's `auto_tag_ids` may name a tag created
    /// in the same cycle, and `create_journal_with_id` drops unknown tag ids.
    #[tokio::test]
    async fn test_cycle_journal_auto_tag_created_same_cycle() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let tid = "tag-autotag-order-1";
        let jid = "journal-autotag-ord1";
        let tag = v2_tag(V2_WEB_A, tid, 900);
        let mut journal = v2_journal(V2_WEB_A, jid, 1);
        if let OutboxIntentV2::CreateJournal { auto_tag_ids, .. } = &mut journal {
            auto_tag_ids.push(tid.to_string());
        }
        write_v2(&provider, &v2_path(&tag), &tag).await;
        write_v2(&provider, &v2_path(&journal), &journal).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 2, "{res:?}");
        let auto: Vec<String> = db::queries::list_journal_auto_tags(&conn, jid)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(auto, vec![tid.to_string()]);
    }

    // ---- Phase 14.2 / 14.3: apply each v2 kind, acks ----

    const V2_HASH: &str = "hash-v2";
    const V2_REV: &str = "rev-v2";

    fn v2_path(intent: &OutboxIntentV2) -> String {
        format!("{}/outbox/{}", intent.web_device_id(), intent.file_name())
    }

    fn v2_apply(conn: &Connection, ctx: &ApplyContext, intent: &OutboxIntentV2) -> Outcome {
        apply_intent_v2(
            conn,
            ctx,
            &v2_path(intent),
            V2_HASH,
            Some(V2_REV.to_string()),
            intent,
        )
    }

    fn v2_ctx() -> (tempfile::TempDir, ApplyContext) {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        (dir, ctx)
    }

    fn v2_template(
        id: &str,
        name: &str,
        content: &[u8],
        base_updated_at: Option<i64>,
    ) -> OutboxIntentV2 {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        OutboxIntentV2::UpsertTemplate {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 10,
            template_id: id.to_string(),
            name: name.to_string(),
            description: Some("desc".to_string()),
            content_b64: Some(B64.encode(content)),
            sort_order: 2,
            base_updated_at,
        }
    }

    fn v2_delete_template(id: &str, base_updated_at: i64) -> OutboxIntentV2 {
        OutboxIntentV2::DeleteTemplate {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 11,
            template_id: id.to_string(),
            base_updated_at,
        }
    }

    fn v2_trash(entry_id: &str, base_updated_at: i64) -> OutboxIntentV2 {
        OutboxIntentV2::TrashEntry {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 12,
            entry_id: entry_id.to_string(),
            base_updated_at,
        }
    }

    fn live_entry(conn: &Connection, journal_id: &str) -> db::Entry {
        crate::commands::entries::create_entry_impl(
            conn,
            journal_id,
            Some("Desk"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap()
    }

    fn raw_entry(conn: &Connection, id: &str) -> db::Entry {
        db::queries::get_entry_raw(conn, id).unwrap().unwrap()
    }

    fn assert_refused(conn: &Connection, intent: &OutboxIntentV2, outcome: Outcome, code: &str) {
        assert_eq!(outcome, Outcome::Refused(code.to_string()));
        let row = import_row(conn, &v2_path(intent)).unwrap();
        assert_eq!(row.outcome, "refused");
        assert_eq!(row.pending_plan.as_deref(), Some(code));
        assert_eq!(row.revision.as_deref(), Some(V2_REV));
        assert!(!row.created);
    }

    #[test]
    fn test_v2_create_journal_happy_idempotent_and_name_taken() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let intent = v2_journal(V2_WEB_A, "journal-v2-happy-1", 5);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        let j = db::queries::get_journal(&conn, "journal-v2-happy-1")
            .unwrap()
            .unwrap();
        assert_eq!(j.name, "Journal journal-v2-happy-1");
        let row = import_row(&conn, &v2_path(&intent)).unwrap();
        assert_eq!(row.outcome, "applied");
        assert!(row.created);
        assert_eq!(row.revision.as_deref(), Some(V2_REV));
        assert_eq!(row.content_hash, V2_HASH);

        // Replay (crash before the record, or a second desktop) → applied, created.
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        assert!(import_row(&conn, &v2_path(&intent)).unwrap().created);

        // Same name, other id → name_taken.
        let clash = OutboxIntentV2::CreateJournal {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 6,
            journal_id: "journal-v2-happy-2".to_string(),
            name: "Journal journal-v2-happy-1".to_string(),
            color: None,
            auto_tag_ids: vec![],
        };
        let out = v2_apply(&conn, &ctx, &clash);
        assert_refused(&conn, &clash, out, "name_taken");
        assert!(db::queries::get_journal(&conn, "journal-v2-happy-2")
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_v2_create_tag_happy_idempotent_and_name_taken() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let intent = v2_tag(V2_WEB_A, "tag-v2-happy-0001", 5);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        assert_eq!(
            existing_tag_ids(&conn, &["tag-v2-happy-0001"]).unwrap(),
            vec!["tag-v2-happy-0001".to_string()]
        );
        assert!(import_row(&conn, &v2_path(&intent)).unwrap().created);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);

        db::queries::create_tag(&conn, "taken", None).unwrap();
        let clash = OutboxIntentV2::CreateTag {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 6,
            tag_id: "tag-v2-happy-0002".to_string(),
            name: "taken".to_string(),
            color: None,
        };
        let out = v2_apply(&conn, &ctx, &clash);
        assert_refused(&conn, &clash, out, "name_taken");
    }

    #[test]
    fn test_v2_template_create_reflected_update_and_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let id = "template-v2-0001";
        let create = v2_template(id, "Daily", b"one", None);
        assert_eq!(v2_apply(&conn, &ctx, &create), Outcome::Applied);
        let row = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert_eq!(row.name, "Daily");
        assert_eq!(row.description.as_deref(), Some("desc"));
        assert_eq!(row.content.as_deref(), Some(&b"one"[..]));
        assert_eq!(row.sort_order, 2);
        let rec = import_row(&conn, &v2_path(&create)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(row.updated_at));

        // Already reflected → applied without a write.
        assert_eq!(v2_apply(&conn, &ctx, &create), Outcome::Applied);
        let same = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert_eq!(same.updated_at, row.updated_at);

        // Update on the current base → applied.
        let update = v2_template(id, "Weekly", b"two", Some(row.updated_at));
        assert_eq!(v2_apply(&conn, &ctx, &update), Outcome::Applied);
        let updated = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Weekly");
        assert_eq!(
            import_row(&conn, &v2_path(&update))
                .unwrap()
                .last_applied_updated_at,
            Some(updated.updated_at)
        );

        // Desktop edits it, then a web edit on the old base → desktop wins.
        conn.execute(
            "UPDATE templates SET name = 'Desk', updated_at = updated_at + 100 WHERE id = ?1",
            [id],
        )
        .unwrap();
        let stale = v2_template(id, "Monthly", b"three", Some(row.updated_at));
        let out = v2_apply(&conn, &ctx, &stale);
        assert_refused(&conn, &stale, out, "changed_on_desktop");
        assert_eq!(
            db::queries::get_template_for_import(&conn, id)
                .unwrap()
                .unwrap()
                .name,
            "Desk"
        );
    }

    #[test]
    fn test_v2_template_in_place_edit_of_own_create_applies() {
        // The web edits its own not-yet-reflected template in place: still base None.
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let id = "template-v2-0002";
        assert_eq!(
            v2_apply(&conn, &ctx, &v2_template(id, "Draft", b"a", None)),
            Outcome::Applied
        );
        let edited = v2_template(id, "Draft 2", b"b", None);
        assert_eq!(v2_apply(&conn, &ctx, &edited), Outcome::Applied);
        // A second in-place edit, still base None: the chain carries the web's base.
        let edited = v2_template(id, "Draft 2b", b"bb", None);
        assert_eq!(v2_apply(&conn, &ctx, &edited), Outcome::Applied);
        assert_eq!(
            db::queries::get_template_for_import(&conn, id)
                .unwrap()
                .unwrap()
                .name,
            "Draft 2b"
        );

        // ...but not after a desktop edit.
        conn.execute(
            "UPDATE templates SET name = 'Desk', updated_at = updated_at + 100 WHERE id = ?1",
            [id],
        )
        .unwrap();
        let again = v2_template(id, "Draft 3", b"c", None);
        let out = v2_apply(&conn, &ctx, &again);
        assert_refused(&conn, &again, out, "changed_on_desktop");
    }

    #[test]
    fn test_v2_template_upsert_of_unknown_or_predefined_row_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let missing = v2_template("template-v2-0003", "X", b"x", Some(5));
        let out = v2_apply(&conn, &ctx, &missing);
        assert_refused(&conn, &missing, out, "absent");

        let pre = db::queries::create_predefined_template(&conn, "Seeded", None, None, 0).unwrap();
        let row = db::queries::get_template_for_import(&conn, &pre.id)
            .unwrap()
            .unwrap();
        let edit = v2_template(&pre.id, "Mine", b"m", Some(row.updated_at));
        let out = v2_apply(&conn, &ctx, &edit);
        assert_refused(&conn, &edit, out, "changed_on_desktop");
    }

    #[test]
    fn test_v2_template_delete_happy_idempotent_and_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let id = "template-v2-0004";
        db::queries::create_template_with_id(&conn, id, "T", None, None, 0).unwrap();
        let row = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();

        // Stale base → refused, row kept.
        let stale = v2_delete_template(id, row.updated_at - 1);
        let out = v2_apply(&conn, &ctx, &stale);
        assert_refused(&conn, &stale, out, "changed_on_desktop");
        assert!(
            !db::queries::get_template_for_import(&conn, id)
                .unwrap()
                .unwrap()
                .is_deleted
        );

        let del = v2_delete_template(id, row.updated_at);
        assert_eq!(v2_apply(&conn, &ctx, &del), Outcome::Applied);
        let gone = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert!(gone.is_deleted);
        assert_eq!(
            import_row(&conn, &v2_path(&del))
                .unwrap()
                .last_applied_updated_at,
            Some(gone.updated_at)
        );

        // Already deleted → applied, even with a stale base.
        let again = v2_delete_template(id, 1);
        assert_eq!(v2_apply(&conn, &ctx, &again), Outcome::Applied);

        // Created then deleted on the web before any import: nothing to delete.
        let never = v2_delete_template("template-v2-0005", 42);
        assert_eq!(v2_apply(&conn, &ctx, &never), Outcome::Applied);
        let rec = import_row(&conn, &v2_path(&never)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(42));
    }

    /// A deterministic validation failure is a final `invalid` refusal, recorded once,
    /// never a transient that re-reads (and spends budget on) the file every cycle.
    #[test]
    fn test_v2_invalid_intent_is_final_refused_invalid() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let mut bad_color = v2_tag(V2_WEB_A, "tag-poison-color-1", 1);
        if let OutboxIntentV2::CreateTag { color, .. } = &mut bad_color {
            *color = Some("red".to_string());
        }
        let mut blank_journal = v2_journal(V2_WEB_A, "journal-poison-blank", 1);
        if let OutboxIntentV2::CreateJournal { name, .. } = &mut blank_journal {
            *name = "   ".to_string();
        }
        let mut bad_b64 = v2_template("template-poison-b64", "T", b"t", None);
        if let OutboxIntentV2::UpsertTemplate { content_b64, .. } = &mut bad_b64 {
            *content_b64 = Some("!!not base64!!".to_string());
        }
        let mut huge = v2_template("template-poison-big", "T", b"t", None);
        if let OutboxIntentV2::UpsertTemplate { content_b64, .. } = &mut huge {
            *content_b64 = Some(B64.encode(vec![
                0u8;
                memlore_core::outbox::MAX_TEMPLATE_CONTENT_BYTES
                    + 1
            ]));
        }
        for i in [&bad_color, &blank_journal, &bad_b64, &huge] {
            let out = v2_apply(&conn, &ctx, i);
            assert_refused(&conn, i, out, "invalid");
            assert!(!is_pending(&import_row(&conn, &v2_path(i)).unwrap()));
        }
        assert!(db::queries::get_journal(&conn, "journal-poison-blank")
            .unwrap()
            .is_none());
        assert!(
            db::queries::get_template_for_import(&conn, "template-poison-b64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn test_v2_trash_happy_marks_pending_and_records_stamp() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        db::queries::mark_entry_synced(&conn, &e.id, 1).ok();
        let intent = v2_trash(&e.id, e.updated_at);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        let after = raw_entry(&conn, &e.id);
        assert!(after.is_deleted && after.trashed_at.is_some());
        assert!(after.updated_at > e.updated_at);
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&e.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
        let rec = import_row(&conn, &v2_path(&intent)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(after.updated_at));
        assert!(!rec.created);
    }

    #[test]
    fn test_v2_trash_stale_base_refused_changed_on_desktop() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let intent = v2_trash(&e.id, e.updated_at - 10);
        let out = v2_apply(&conn, &ctx, &intent);
        assert_refused(&conn, &intent, out, "changed_on_desktop");
        assert!(!raw_entry(&conn, &e.id).is_deleted);
    }

    #[test]
    fn test_v2_trash_already_trashed_is_applied() {
        // A second v0.3.0 desktop already pulled the first one's trash.
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        crate::commands::entries::soft_delete_entry_impl(&conn, &e.id).unwrap();
        let trashed = raw_entry(&conn, &e.id);
        let intent = v2_trash(&e.id, e.updated_at - 10);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        let rec = import_row(&conn, &v2_path(&intent)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(trashed.updated_at));
        assert_eq!(raw_entry(&conn, &e.id).updated_at, trashed.updated_at);
    }

    /// Every hidden or gone target refuses with the one reason `absent`, checked before
    /// the already-trashed shortcut, so the ack never reveals that a locked or
    /// invisible entry exists, nor its stamp.
    #[test]
    fn test_v2_trash_hidden_or_gone_targets_refused_absent() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let refuse = |id: &str| {
            let e = raw_entry(&conn, id);
            let i = v2_trash(id, e.updated_at);
            let out = v2_apply(&conn, &ctx, &i);
            assert_refused(&conn, &i, out, "absent");
            let row = import_row(&conn, &v2_path(&i)).unwrap();
            assert_eq!(row.last_applied_updated_at, None);
            assert_eq!(raw_entry(&conn, id).updated_at, e.updated_at);
        };

        let locked = live_entry(&conn, &jid);
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            [&locked.id],
        )
        .unwrap();
        refuse(&locked.id);
        assert!(!raw_entry(&conn, &locked.id).is_deleted);

        let invisible = live_entry(&conn, &jid);
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = ?1",
            [&invisible.id],
        )
        .unwrap();
        refuse(&invisible.id);

        let inv_j = db::queries::create_journal(&conn, "Hidden", None).unwrap();
        conn.execute(
            "UPDATE journals SET is_invisible = 1 WHERE id = ?1",
            [&inv_j.id],
        )
        .unwrap();
        let in_inv_j = live_entry(&conn, &inv_j.id);
        refuse(&in_inv_j.id);
        assert!(!raw_entry(&conn, &in_inv_j.id).is_deleted);

        let locked_j = db::queries::create_journal(&conn, "Locked", None).unwrap();
        let in_locked_j = live_entry(&conn, &locked_j.id);
        conn.execute(
            "UPDATE journals SET is_locked = 1 WHERE id = ?1",
            [&locked_j.id],
        )
        .unwrap();
        refuse(&in_locked_j.id);
        assert!(!raw_entry(&conn, &in_locked_j.id).is_deleted);

        // Already trashed, but hidden: still `absent`, not the applied shortcut.
        let trashed_locked = live_entry(&conn, &jid);
        crate::commands::entries::soft_delete_entry_impl(&conn, &trashed_locked.id).unwrap();
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            [&trashed_locked.id],
        )
        .unwrap();
        refuse(&trashed_locked.id);
        let trashed_in_inv_j = live_entry(&conn, &inv_j.id);
        crate::commands::entries::soft_delete_entry_impl(&conn, &trashed_in_inv_j.id).unwrap();
        refuse(&trashed_in_inv_j.id);

        let purged = live_entry(&conn, &jid);
        crate::commands::entries::soft_delete_entry_impl(&conn, &purged.id).unwrap();
        db::queries::purge_entry_mark(&conn, &purged.id).unwrap();
        refuse(&purged.id);

        let i = v2_trash("entry-v2-missing-01", 5);
        let out = v2_apply(&conn, &ctx, &i);
        assert_refused(&conn, &i, out, "absent");
    }

    #[test]
    fn test_v2_trash_waits_when_target_not_pulled_or_pull_dirty() {
        let conn = setup_test_db();
        let (_d, mut ctx) = v2_ctx();
        ctx.known_ids
            .insert("entry-v2-unpulled-1".to_string(), false);
        let i = v2_trash("entry-v2-unpulled-1", 5);
        assert_eq!(v2_apply(&conn, &ctx, &i), Outcome::Transient);
        assert!(import_row(&conn, &v2_path(&i)).is_none());

        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        ctx.pull_clean = false;
        let i = v2_trash(&e.id, e.updated_at);
        assert_eq!(v2_apply(&conn, &ctx, &i), Outcome::Transient);
        assert!(import_row(&conn, &v2_path(&i)).is_none());
        assert!(!raw_entry(&conn, &e.id).is_deleted);
    }

    /// Edit then delete on one web device: the edit applies first and bumps
    /// `updated_at`, so the trash's base (the pre-edit stamp the web saw) no longer
    /// matches. The trash still applies, because the only change since that base is
    /// the web's own edit, recorded for its `<entryId>.bin`.
    #[tokio::test]
    async fn test_cycle_edit_then_delete_from_one_web_device_applies() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        // An old stamp, so the web edit's `now` stamp always differs from the base.
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();

        let mut edit = v1_edit(V2_WEB_A, &e.id, 2000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let trash = v2_trash(&e.id, base);
        write_v2(&provider, &v2_path(&trash), &trash).await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 2, "{res:?}");
        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Edited"));
        assert!(after.is_deleted && after.trashed_at.is_some());
        assert_eq!(
            import_row(&conn, &v2_path(&trash)).unwrap().outcome,
            "applied"
        );
    }

    /// Two web edits from one base without a pull in between, then a trash from that
    /// base: each edit chains on the web's own previous apply, so the trash applies.
    #[tokio::test]
    async fn test_cycle_two_edits_then_trash_from_one_base_applies() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();
        let mut edit = v1_edit(V2_WEB_A, &e.id, 2000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let sink = TestOutboxSink::default();
        assert_eq!(
            v2_cycle(&provider, &media_dir, &conn, &sink)
                .await
                .intents_applied,
            1
        );

        edit.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: base,
            change_seq: 2,
            changed_at_secs: 2001,
        });
        write_v1(&provider, &edit_path, &edit).await;
        let trash = v2_trash(&e.id, base);
        write_v2(&provider, &v2_path(&trash), &trash).await;
        v2_cycle(&provider, &media_dir, &conn, &sink).await;

        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.emotion.as_deref(), Some("good"));
        assert!(after.is_deleted && after.trashed_at.is_some());
        assert_eq!(
            import_row(&conn, &v2_path(&trash)).unwrap().outcome,
            "applied"
        );
    }

    /// Desktop edits first, then the web edits and trashes from the same stale base in
    /// one cycle. The edit is refused field by field, yet its record still carries the
    /// row's stamp; that stamp must not let the trash through, desktop wins.
    #[tokio::test]
    async fn test_cycle_refused_edit_does_not_unlock_stale_trash() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();
        crate::commands::entries::update_entry_impl(&conn, &e.id, Some("Desk 2"), None, None)
            .unwrap();

        let mut edit = v1_edit(V2_WEB_A, &e.id, 2000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let trash = v2_trash(&e.id, base);
        write_v2(&provider, &v2_path(&trash), &trash).await;

        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;
        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Desk 2"));
        assert!(!after.is_deleted, "desktop edit wins over the stale trash");
        let row = import_row(&conn, &v2_path(&trash)).unwrap();
        assert_eq!(row.outcome, "refused");
        assert_eq!(row.pending_plan.as_deref(), Some("changed_on_desktop"));
    }

    /// A desktop edit after the web's own applied edit still wins over the trash.
    #[test]
    fn test_v2_trash_after_own_edit_refused_when_desktop_edited_since() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let sibling = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: sibling,
                revision: None,
                content_hash: "h".to_string(),
                outcome: "applied".to_string(),
                imported_at: 1,
                last_applied_updated_at: Some(e.updated_at),
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: None,
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();
        db::queries::touch_entry_updated_at(&conn, &e.id).unwrap();
        let i = v2_trash(&e.id, e.updated_at - 50);
        let out = v2_apply(&conn, &ctx, &i);
        assert_refused(&conn, &i, out, "changed_on_desktop");
    }

    /// Creates run before entry intents in the same cycle: an entry created on the web
    /// into a web-created journal with a web-created tag lands there with that tag.
    #[tokio::test]
    async fn test_cycle_entry_lands_in_journal_and_tag_created_same_cycle() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let new_jid = "journal-e2e-order-1";
        let new_tid = "tag-e2e-order-0001";
        let journal = v2_journal(V2_WEB_A, new_jid, 1);
        let tag = v2_tag(V2_WEB_A, new_tid, 1);
        write_v2(&provider, &v2_path(&journal), &journal).await;
        write_v2(&provider, &v2_path(&tag), &tag).await;

        let eid = "entry-e2e-order-001";
        let mut entry = v1_edit(V2_WEB_A, eid, 1);
        entry.created_on_web = true;
        entry.fields.journal_id = Some(FieldChange {
            value: new_jid.to_string(),
            base: String::new(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1,
        });
        entry.fields.tags_add.insert(
            new_tid.to_string(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: 0,
                change_seq: 3,
                changed_at_secs: 1,
            },
        );
        let entry_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        write_v1(&provider, &entry_path, &entry).await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 3, "{res:?}");
        assert_eq!(res.intents_refused, 0);

        let created = raw_entry(&conn, eid);
        assert_eq!(created.journal_id, new_jid);
        assert_ne!(created.journal_id, default_journal_id(&conn));
        assert_eq!(
            db::queries::get_tag_ids_for_entry(&conn, eid).unwrap(),
            vec![new_tid.to_string()]
        );
        let rec = import_row(&conn, &entry_path).unwrap();
        assert_eq!(rec.outcome, "applied");
        let decided = rec.decided_fields.unwrap_or_default();
        assert!(!decided.contains("tag_not_found"), "{decided}");
        assert!(!decided.contains("\"journal\""), "{decided}");
    }

    /// Ack shape per outcome: created for creates, applied_updated_at for template and
    /// trash applies, refused_reason for refusals.
    #[tokio::test]
    async fn test_cycle_v2_ack_shapes_per_outcome() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        db::queries::create_tag(&conn, "Tag tag-ack-taken-001", None).unwrap();

        let journal = v2_journal(V2_WEB_A, "journal-ack-00001", 1);
        let taken = v2_tag(V2_WEB_A, "tag-ack-taken-001", 1);
        let tpl = v2_template("template-ack-0001", "T", b"t", None);
        let trash = v2_trash(&e.id, e.updated_at);
        let stale = v2_delete_template("template-ack-0002", 1);
        db::queries::create_template_with_id(&conn, "template-ack-0002", "K", None, None, 0)
            .unwrap();
        for i in [&journal, &taken, &tpl, &trash, &stale] {
            write_v2(&provider, &v2_path(i), i).await;
        }

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert!(res.acks_written);
        assert_eq!(res.intents_applied, 3, "{res:?}");
        assert_eq!(res.intents_refused, 2, "{res:?}");

        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        let bytes = p
            .read_file(&format!("{V2_OWN}/outbox-acks.bin"))
            .await
            .unwrap();
        let acks = open_outbox_acks(&test_key_list(), &bytes).unwrap();
        let ack = |i: &OutboxIntentV2| {
            acks.acks
                .iter()
                .find(|a| a.path == v2_path(i))
                .unwrap_or_else(|| panic!("no ack for {}", v2_path(i)))
                .clone()
        };

        let a = ack(&journal);
        assert!(a.created);
        assert_eq!(a.refused_reason, None);

        let a = ack(&taken);
        assert!(!a.created);
        assert_eq!(a.refused_reason.as_deref(), Some("name_taken"));

        let a = ack(&tpl);
        let tpl_row = db::queries::get_template_for_import(&conn, "template-ack-0001")
            .unwrap()
            .unwrap();
        assert_eq!(a.applied_updated_at, Some(tpl_row.updated_at));
        assert_eq!(a.refused_reason, None);

        let a = ack(&trash);
        assert_eq!(
            a.applied_updated_at,
            Some(raw_entry(&conn, &e.id).updated_at)
        );
        assert_eq!(a.refused_reason, None);

        let a = ack(&stale);
        assert_eq!(a.applied_updated_at, None);
        assert_eq!(a.refused_reason.as_deref(), Some("changed_on_desktop"));
    }

    /// v2 reads count against the changed-intent budget again; because they are now
    /// recorded (final), the backlog drains and the v1 intent is reached next cycle.
    #[tokio::test]
    async fn test_cycle_v2_budget_drains_then_reaches_v1() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        for i in 0..25 {
            let id = format!("tag-budget-{i:04}");
            let p = format!("{V2_WEB_A}/outbox/t-{id}.bin");
            write_v2(&provider, &p, &v2_tag(V2_WEB_A, &id, i)).await;
        }
        let eid = "entry-budget-00001";
        let v1_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        write_v1(&provider, &v1_path, &v1_edit(V2_WEB_A, eid, 1)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 20);
        assert!(
            import_row(&conn, &v1_path).is_none(),
            "deferred by the budget"
        );

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_applied, 5);
        assert_eq!(res2.intents_skipped_unchanged, 20);
        assert_eq!(import_row(&conn, &v1_path).unwrap().outcome, "refused");
    }

    /// Provider whose outbox intent reads take `delay` of (paused) tokio time. Only
    /// reads that return bytes are slow; an unchanged-revision check stays cheap.
    struct SlowOutboxProvider<'a> {
        inner: &'a crate::sync::local_provider::LocalSyncProvider,
        delay: Duration,
    }

    #[async_trait::async_trait]
    impl SyncProvider for SlowOutboxProvider<'_> {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            SyncProvider::list_devices(self.inner).await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            SyncProvider::list_files(self.inner, device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if path.contains("/outbox/") {
                tokio::time::sleep(self.delay).await;
            }
            SyncProvider::read_file(self.inner, path).await
        }
        async fn read_file_if_changed(
            &self,
            path: &str,
            known_revision: Option<&str>,
        ) -> Result<ConditionalRead, SyncError> {
            let res = SyncProvider::read_file_if_changed(self.inner, path, known_revision).await;
            if matches!(res, Ok(ConditionalRead::Changed { .. })) {
                tokio::time::sleep(self.delay).await;
            }
            res
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            SyncProvider::write_file(self.inner, path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            SyncProvider::delete_file(self.inner, path).await
        }
    }

    /// Slow reads must not let the read pass eat the whole wall-clock budget: the
    /// apply pass still records what was read, so every cycle makes progress instead
    /// of re-reading the same files forever.
    #[tokio::test(start_paused = true)]
    async fn test_cycle_slow_reads_still_apply_each_cycle() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        for i in 0..5 {
            let tag = v2_tag(V2_WEB_A, &format!("tag-slow-read-{i:04}"), i);
            write_v2(&provider, &v2_path(&tag), &tag).await;
        }
        let slow = SlowOutboxProvider {
            inner: &provider,
            delay: Duration::from_secs(20),
        };
        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let mut applied = 0;
        for _ in 0..3 {
            let res = run_outbox_import_cycle(
                &slow,
                &provider,
                V2_OWN,
                &test_key_list(),
                HashMap::new(),
                true,
                &summary,
                &media_dir,
                &conn,
                &sink,
            )
            .await
            .unwrap();
            assert!(res.intents_applied > 0, "no progress: {res:?}");
            applied += res.intents_applied;
            if applied == 5 {
                break;
            }
        }
        assert_eq!(applied, 5);
    }

    // ---- Phase 14.5: old-state and mixed-fleet ----

    /// A second desktop still on v0.2.2 (no `outbox_versions` in its manifest).
    const V022_DESKTOP: &str = "22222222-2222-2222-2222-222222222222";

    /// Revision and sha256 hex of an outbox file, as v0.2.2 recorded them.
    async fn file_revision_and_hash(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
    ) -> (Option<String>, String) {
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        match p.read_file_if_changed(path, None).await.unwrap() {
            ConditionalRead::Changed { bytes, revision } => {
                assert!(revision.is_some());
                (revision, hex::encode(sha2::Sha256::digest(&bytes)))
            }
            ConditionalRead::Unchanged => unreachable!(),
        }
    }

    /// The ack v0.2.2 emitted for a `skipped_version` row: no refusal, nothing created.
    fn v022_skipped_ack(path: &str, content_hash: &str) -> OutboxAckEntry {
        OutboxAckEntry {
            path: path.to_string(),
            content_hash: content_hash.to_string(),
            applied_updated_at: None,
            decided: vec![],
            created: false,
            refused_reason: None,
        }
    }

    /// Write `{desktop}/outbox-acks.bin` as v0.2.2 did; returns the `__acks__` marker hash.
    async fn write_v022_acks(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        desktop: &str,
        acks: Vec<OutboxAckEntry>,
    ) -> String {
        let file = OutboxAcksV1 {
            schema_version: 1,
            desktop_device_id: desktop.to_string(),
            acks,
        };
        let plain = bincode::DefaultOptions::new()
            .with_fixint_encoding()
            .serialize(&file)
            .unwrap();
        let sealed = seal_outbox_acks(&test_key_list(), &file).unwrap();
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(&format!("{desktop}/outbox-acks.bin"), &sealed)
            .await
            .unwrap();
        format!("1:{}", hex::encode(sha2::Sha256::digest(&plain)))
    }

    async fn own_ack(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
    ) -> OutboxAckEntry {
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        let bytes = p
            .read_file(&format!("{V2_OWN}/outbox-acks.bin"))
            .await
            .unwrap();
        open_outbox_acks(&test_key_list(), &bytes)
            .unwrap()
            .acks
            .into_iter()
            .find(|a| a.path == path)
            .unwrap_or_else(|| panic!("no ack for {path}"))
    }

    /// Upgrade from v0.2.2: its `skipped_version` row (real revision and hash,
    /// `pending_plan = "2"`), its own ack and `__acks__` marker are all present. The
    /// file is unchanged, yet it is re-read, applied, and the ack becomes `created`.
    #[tokio::test]
    async fn test_cycle_upgrades_v022_skipped_row_and_ack_to_applied() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-v022-skip-1";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &path, &v2_journal(V2_WEB_A, jid, 1)).await;
        let (revision, content_hash) = file_revision_and_hash(&provider, &path).await;

        let conn = setup_test_db();
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: path.clone(),
                revision: revision.clone(),
                content_hash: content_hash.clone(),
                outcome: "skipped_version".to_string(),
                imported_at: 1,
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: Some("2".to_string()),
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();
        let marker_hash = write_v022_acks(
            &provider,
            V2_OWN,
            vec![v022_skipped_ack(&path, &content_hash)],
        )
        .await;
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: "__acks__".to_string(),
                revision: None,
                content_hash: marker_hash,
                outcome: "written".to_string(),
                imported_at: 1,
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: None,
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_skipped_unchanged, 0);
        assert_eq!(res.intents_applied, 1);
        assert!(res.acks_written);
        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "applied");
        assert_eq!(row.revision, revision);
        assert!(db::queries::get_journal(&conn, jid).unwrap().is_some());

        let ack = own_ack(&provider, &path).await;
        assert!(ack.created);
        assert_eq!(ack.refused_reason, None);
        assert_eq!(ack.content_hash, content_hash);
    }

    /// A `corrupt` row stays final across the upgrade even for a now-valid v2 file
    /// (`pending_plan` only revives `skipped_version` rows).
    #[tokio::test]
    async fn test_cycle_v022_corrupt_row_stays_final() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-v022-corrupt";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &path, &v2_journal(V2_WEB_A, jid, 1)).await;
        let (revision, content_hash) = file_revision_and_hash(&provider, &path).await;

        let conn = setup_test_db();
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: path.clone(),
                revision,
                content_hash,
                outcome: "corrupt".to_string(),
                imported_at: 1,
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: Some("2".to_string()),
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_skipped_unchanged, 1);
        assert_eq!(res.intents_applied, 0);
        assert!(sink.dispatched.lock().unwrap().is_empty());
        assert_eq!(import_row(&conn, &path).unwrap().outcome, "corrupt");
        assert!(db::queries::get_journal(&conn, jid).unwrap().is_none());
    }

    /// Mixed fleet: this v0.3.0 desktop plus a v0.2.2 desktop whose folder holds a
    /// pre-Phase-1 `metadata.json` and acks that skipped the web's v2 journal file.
    /// The old desktop is not mistaken for a web device, its acks are ignored, and an
    /// entry the web placed in a new journal lands in that journal here.
    #[tokio::test]
    async fn test_cycle_mixed_fleet_entry_lands_in_new_web_journal() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        for (id, name) in [(V2_OWN, "Desktop 0.3.0"), (V022_DESKTOP, "Desktop 0.2.2")] {
            let slot = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: id.to_string(),
                name: name.to_string(),
                created_at: 1000,
                last_seen_at: 1000,
            };
            crate::sync::keyring_v2::io::write_device_slot(&provider, &slot)
                .await
                .unwrap();
        }

        // Web: a v2 journal create and a v1 entry created into that journal.
        let jid = "journal-mixed-fleet1";
        let journal = v2_journal(V2_WEB_A, jid, 1);
        let journal_path = v2_path(&journal);
        write_v2(&provider, &journal_path, &journal).await;
        let eid = "entry-mixed-fleet-01";
        let mut entry = v1_edit(V2_WEB_A, eid, 2);
        entry.created_on_web = true;
        entry.fields.journal_id = Some(FieldChange {
            value: jid.to_string(),
            base: String::new(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 2,
        });
        let entry_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        write_v1(&provider, &entry_path, &entry).await;

        // v0.2.2 desktop: pre-Phase-1 manifest (no index_present / outbox_versions /
        // trashed_at), one unrelated entry, and acks that skipped the journal file.
        let old_manifest_json = format!(
            r#"{{"device_id":"{V022_DESKTOP}","recovery_generation":0,"entries":[{{"entry_id":"entry-v022-own-0001","updated_at":5,"local_version":1,"is_deleted":false}}],"journals":[],"chats_present":false,"memory_present":false,"generated_at":5}}"#
        );
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        p.write_file(
            &format!("{V022_DESKTOP}/metadata.json"),
            old_manifest_json.as_bytes(),
        )
        .await
        .unwrap();
        let (_, journal_hash) = file_revision_and_hash(&provider, &journal_path).await;
        write_v022_acks(
            &provider,
            V022_DESKTOP,
            vec![v022_skipped_ack(&journal_path, &journal_hash)],
        )
        .await;
        let old_manifest: DeviceMetadata = serde_json::from_str(&old_manifest_json).unwrap();
        assert_eq!(old_manifest.outbox_versions, None);

        // What the engine hands the importer after pulling the old desktop's manifest.
        let known_ids =
            collect_known_ids_from_manifests(&[(V022_DESKTOP.to_string(), old_manifest)]);
        let summary = SyncSummary {
            pull_clean: true,
            fetched_manifests: vec![V022_DESKTOP.to_string()],
            ..Default::default()
        };
        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            V2_OWN,
            &test_key_list(),
            known_ids,
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.candidates_checked, 1, "only the web device: {res:?}");
        assert_eq!(res.intents_applied, 2, "{res:?}");
        assert_eq!(res.intents_refused, 0);
        let created = raw_entry(&conn, eid);
        assert_eq!(created.journal_id, jid);
        assert_ne!(created.journal_id, default_journal_id(&conn));
        assert_eq!(import_row(&conn, &journal_path).unwrap().outcome, "applied");
        assert_eq!(import_row(&conn, &entry_path).unwrap().outcome, "applied");
        assert!(own_ack(&provider, &journal_path).await.created);
        assert!(own_ack(&provider, &entry_path).await.created);
    }

    // ---- Phase 7.2: the five v2 kinds folded into v3 ----

    /// The v3 twin of a v2 intent: same file name, same fields (a create = base `None`).
    fn v3_of(intent: &OutboxIntentV2) -> OutboxIntentV3 {
        match intent.clone() {
            OutboxIntentV2::CreateTag {
                web_device_id,
                web_updated_at_secs,
                tag_id,
                name,
                color,
            } => OutboxIntentV3::UpsertTag {
                web_device_id,
                web_updated_at_secs,
                tag_id,
                name,
                color,
                base_updated_at: None,
            },
            OutboxIntentV2::CreateJournal {
                web_device_id,
                web_updated_at_secs,
                journal_id,
                name,
                color,
                auto_tag_ids,
            } => OutboxIntentV3::UpsertJournal {
                web_device_id,
                web_updated_at_secs,
                journal_id,
                name,
                color,
                auto_tag_ids,
                base_updated_at: None,
            },
            OutboxIntentV2::UpsertTemplate {
                web_device_id,
                web_updated_at_secs,
                template_id,
                name,
                description,
                content_b64,
                sort_order,
                base_updated_at,
            } => OutboxIntentV3::UpsertTemplate {
                web_device_id,
                web_updated_at_secs,
                template_id,
                name,
                description,
                content_b64,
                sort_order,
                base_updated_at,
            },
            OutboxIntentV2::DeleteTemplate {
                web_device_id,
                web_updated_at_secs,
                template_id,
                base_updated_at,
            } => OutboxIntentV3::DeleteTemplate {
                web_device_id,
                web_updated_at_secs,
                template_id,
                base_updated_at,
            },
            OutboxIntentV2::TrashEntry {
                web_device_id,
                web_updated_at_secs,
                entry_id,
                base_updated_at,
            } => OutboxIntentV3::TrashEntry {
                web_device_id,
                web_updated_at_secs,
                entry_id,
                base_updated_at,
            },
        }
    }

    fn v3_path(intent: &OutboxIntentV3) -> String {
        format!("{}/outbox/{}", intent.web_device_id(), intent.file_name())
    }

    async fn write_v3(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        intent: &OutboxIntentV3,
    ) -> String {
        let path = v3_path(intent);
        let sealed = memlore_core::outbox::seal_outbox_intent_v3(&test_key_list(), intent).unwrap();
        write_raw(provider, &path, &sealed).await;
        path
    }

    #[derive(Clone, Copy, Debug)]
    enum Frame {
        V2,
        V3,
    }

    /// Apply a v2 intent as written, or its v3 twin under the same path.
    fn apply_as(
        frame: Frame,
        conn: &Connection,
        ctx: &ApplyContext,
        intent: &OutboxIntentV2,
    ) -> Outcome {
        match frame {
            Frame::V2 => v2_apply(conn, ctx, intent),
            Frame::V3 => {
                let v3 = v3_of(intent);
                assert_eq!(v3_path(&v3), v2_path(intent), "one file per target");
                apply_intent_v3(
                    conn,
                    ctx,
                    &v2_path(intent),
                    V2_HASH,
                    Some(V2_REV.to_string()),
                    &v3,
                    AttachBlob::NotRead,
                )
            }
        }
    }

    /// `upsert_template`, `delete_template` and `trash_entry` keep their v2 rules in
    /// frame 3: create / reflected / update / desktop wins, already deleted / never
    /// existed, already trashed, and the same recorded stamps (no `created` ack).
    #[test]
    fn test_v3_template_and_trash_follow_the_v2_rules() {
        for frame in [Frame::V2, Frame::V3] {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            let apply = |i: &OutboxIntentV2| apply_as(frame, &conn, &ctx, i);
            let applied_at = |i: &OutboxIntentV2| {
                let rec = import_row(&conn, &v2_path(i)).unwrap();
                assert_eq!(rec.outcome, "applied", "{frame:?}");
                assert!(
                    !rec.created,
                    "{frame:?}: templates and trash never ack created"
                );
                rec.last_applied_updated_at
            };
            let template = |id: &str| {
                db::queries::get_template_for_import(&conn, id)
                    .unwrap()
                    .unwrap()
            };

            // upsert_template: create, reflected, update, desktop wins.
            let id = "template-v3-0001";
            let create = v2_template(id, "Daily", b"one", None);
            assert_eq!(apply(&create), Outcome::Applied, "{frame:?}");
            let row = template(id);
            assert_eq!(row.content.as_deref(), Some(&b"one"[..]));
            assert_eq!(applied_at(&create), Some(row.updated_at));
            assert_eq!(apply(&create), Outcome::Applied, "{frame:?} reflected");
            assert_eq!(template(id).updated_at, row.updated_at);
            let update = v2_template(id, "Weekly", b"two", Some(row.updated_at));
            assert_eq!(apply(&update), Outcome::Applied, "{frame:?}");
            let updated = template(id);
            assert_eq!(updated.name, "Weekly");
            assert_eq!(applied_at(&update), Some(updated.updated_at));
            conn.execute(
                "UPDATE templates SET name = 'Desk', updated_at = updated_at + 100 WHERE id = ?1",
                [id],
            )
            .unwrap();
            let stale = v2_template(id, "Monthly", b"three", Some(row.updated_at));
            let out = apply(&stale);
            assert_refused(&conn, &stale, out, "changed_on_desktop");
            assert_eq!(template(id).name, "Desk");

            // delete_template: stale, happy, already deleted, never existed.
            let id = "template-v3-0002";
            db::queries::create_template_with_id(&conn, id, "T", None, None, 0).unwrap();
            let row = template(id);
            let stale = v2_delete_template(id, row.updated_at - 1);
            let out = apply(&stale);
            assert_refused(&conn, &stale, out, "changed_on_desktop");
            assert!(!template(id).is_deleted);
            let del = v2_delete_template(id, row.updated_at);
            assert_eq!(apply(&del), Outcome::Applied, "{frame:?}");
            let gone = template(id);
            assert!(gone.is_deleted);
            assert_eq!(applied_at(&del), Some(gone.updated_at));
            let again = v2_delete_template(id, 1);
            assert_eq!(apply(&again), Outcome::Applied, "{frame:?} already deleted");
            let never = v2_delete_template("template-v3-0003", 42);
            assert_eq!(apply(&never), Outcome::Applied, "{frame:?} never existed");
            assert_eq!(applied_at(&never), Some(42));

            // trash_entry: desktop wins, happy, already trashed.
            let jid = default_journal_id(&conn);
            let e = live_entry(&conn, &jid);
            let stale = v2_trash(&e.id, e.updated_at - 10);
            let out = apply(&stale);
            assert_refused(&conn, &stale, out, "changed_on_desktop");
            assert!(!raw_entry(&conn, &e.id).is_deleted);
            let trash = v2_trash(&e.id, e.updated_at);
            assert_eq!(apply(&trash), Outcome::Applied, "{frame:?}");
            let after = raw_entry(&conn, &e.id);
            assert!(after.is_deleted && after.trashed_at.is_some());
            assert_eq!(applied_at(&trash), Some(after.updated_at));
            let again = v2_trash(&e.id, e.updated_at - 10);
            assert_eq!(apply(&again), Outcome::Applied, "{frame:?} already trashed");
            assert_eq!(applied_at(&again), Some(after.updated_at));
            assert_eq!(raw_entry(&conn, &e.id).updated_at, after.updated_at);
        }
    }

    fn apply_v3(conn: &Connection, ctx: &ApplyContext, intent: &OutboxIntentV3) -> Outcome {
        apply_intent_v3(
            conn,
            ctx,
            &v3_path(intent),
            V2_HASH,
            Some(V2_REV.to_string()),
            intent,
            AttachBlob::NotRead,
        )
    }

    /// Tags and journals share the upsert rules; their tests run against both.
    #[derive(Clone, Copy, Debug)]
    enum Taxon {
        Tag,
        Journal,
    }

    impl Taxon {
        fn table(self) -> &'static str {
            match self {
                Self::Tag => "tags",
                Self::Journal => "journals",
            }
        }

        fn upsert(self, id: &str, name: &str, base_updated_at: Option<i64>) -> OutboxIntentV3 {
            let (web_device_id, name) = (V2_WEB_A.to_string(), name.to_string());
            match self {
                Self::Tag => OutboxIntentV3::UpsertTag {
                    web_device_id,
                    web_updated_at_secs: 1,
                    tag_id: id.to_string(),
                    name,
                    color: None,
                    base_updated_at,
                },
                Self::Journal => OutboxIntentV3::UpsertJournal {
                    web_device_id,
                    web_updated_at_secs: 1,
                    journal_id: id.to_string(),
                    name,
                    color: None,
                    auto_tag_ids: vec![],
                    base_updated_at,
                },
            }
        }

        /// `(name, updated_at, is_deleted)`.
        fn row(self, conn: &Connection, id: &str) -> Option<(String, i64, bool)> {
            use rusqlite::OptionalExtension;
            conn.query_row(
                &format!(
                    "SELECT name, updated_at, is_deleted FROM {} WHERE id = ?1",
                    self.table()
                ),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .optional()
            .unwrap()
        }

        /// A desktop-side write: `UPDATE <table> SET <set> WHERE id = ?`.
        fn set(self, conn: &Connection, id: &str, set: &str) {
            conn.execute(
                &format!("UPDATE {} SET {set} WHERE id = ?1", self.table()),
                [id],
            )
            .unwrap();
        }
    }

    /// Review I6 + Phase 8.2: tag / journal create, rename and desktop wins.
    /// - A create acks the row's stamp and starts its path's chain at the created row; a
    ///   replay that finds the row (`Exists`) acks it too, but never records an edge from
    ///   `APPLIED_FROM_CREATED`, which would let any later base fast-forward.
    /// - Two renames from one base (the first not yet acked) both apply (own-path chain),
    ///   a rename after a desktop edit is `changed_on_desktop`, a rename onto another
    ///   row's name is `name_taken`.
    /// - An unknown or deleted target is `absent`: nothing written, no stamp acked.
    #[test]
    fn test_v3_taxonomy_create_rename_and_desktop_wins() {
        for taxon in [Taxon::Tag, Taxon::Journal] {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            let apply = |i: &OutboxIntentV3| apply_v3(&conn, &ctx, i);
            let id = "taxon-v3-target-01";
            let rec = || import_row(&conn, &v3_path(&taxon.upsert(id, "", None))).unwrap();
            let refused = |code: &str| Outcome::Refused(code.to_string());

            let create = taxon.upsert(id, "Fresh", None);
            assert_eq!(apply(&create), Outcome::Applied, "{taxon:?}");
            let (_, stamp, _) = taxon.row(&conn, id).unwrap();
            let r = rec();
            assert!(r.created, "{taxon:?}");
            assert_eq!(r.last_applied_updated_at, Some(stamp));
            assert_eq!(r.applied_from_updated_at, Some(APPLIED_FROM_CREATED));
            assert_eq!(apply(&create), Outcome::Applied, "{taxon:?} replay");
            let r = rec();
            assert!(r.created, "{taxon:?} replay acks created");
            assert_eq!(r.last_applied_updated_at, Some(stamp));
            assert_eq!(r.applied_from_updated_at, None, "{taxon:?}: no edge from 0");

            taxon.set(&conn, id, "updated_at = 1000");
            let rename1 = taxon.upsert(id, "Renamed 1", Some(1000));
            assert_eq!(apply(&rename1), Outcome::Applied, "{taxon:?}");
            let (name, stamp1, _) = taxon.row(&conn, id).unwrap();
            assert_eq!(name, "Renamed 1");
            assert_eq!(rec().last_applied_updated_at, Some(stamp1), "{taxon:?}");
            let rename2 = taxon.upsert(id, "Renamed 2", Some(1000));
            assert_eq!(apply(&rename2), Outcome::Applied, "{taxon:?} chained");
            assert_eq!(taxon.row(&conn, id).unwrap().0, "Renamed 2");

            taxon.set(&conn, id, "name = 'Desk', updated_at = updated_at + 100");
            let stale = taxon.upsert(id, "Renamed 3", Some(1000));
            assert_eq!(apply(&stale), refused("changed_on_desktop"), "{taxon:?}");
            let (name, desk_stamp, _) = taxon.row(&conn, id).unwrap();
            assert_eq!(name, "Desk");
            assert_eq!(rec().last_applied_updated_at, None);

            let other = taxon.upsert("taxon-v3-other-001", "Other", None);
            assert_eq!(apply(&other), Outcome::Applied, "{taxon:?}");
            let clash = taxon.upsert(id, "Other", Some(desk_stamp));
            assert_eq!(apply(&clash), refused("name_taken"), "{taxon:?}");
            assert_eq!(taxon.row(&conn, id).unwrap().0, "Desk");

            let missing = taxon.upsert("taxon-v3-missing-1", "Ghost", Some(1));
            assert_eq!(apply(&missing), refused("absent"), "{taxon:?}");
            assert!(taxon.row(&conn, "taxon-v3-missing-1").is_none());
            taxon.set(&conn, id, "is_deleted = 1");
            for intent in [&create, &taxon.upsert(id, "Back", Some(desk_stamp))] {
                assert_eq!(apply(intent), refused("absent"), "{taxon:?} deleted");
                assert_eq!(rec().last_applied_updated_at, None, "no stamp acked");
            }
            assert_eq!(
                taxon.row(&conn, id).unwrap(),
                ("Desk".to_string(), desk_stamp, true)
            );
        }
    }

    /// README "Importer view": a locked or invisible journal is `absent` to every journal
    /// kind (no rename, no delete) and a replayed create never acks its stamp.
    #[test]
    fn test_v3_hidden_journal_is_absent_to_every_journal_kind() {
        let hides: [fn(&Connection, &str); 2] = [
            |c, id| db::queries::set_journal_locked(c, id, true).unwrap(),
            |c, id| db::queries::set_journal_invisible(c, id, true, Some("vault-a")).unwrap(),
        ];
        for hide in hides {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            let id = "journal-v3-hidden-1";
            let create = Taxon::Journal.upsert(id, "Hidden", None);
            assert_eq!(apply_v3(&conn, &ctx, &create), Outcome::Applied);
            hide(&conn, id);
            let (_, base, _) = Taxon::Journal.row(&conn, id).unwrap();
            let delete = OutboxIntentV3::DeleteJournal {
                web_device_id: V2_WEB_A.to_string(),
                web_updated_at_secs: 1,
                journal_id: id.to_string(),
                base_updated_at: base,
            };
            for intent in [
                &create,
                &Taxon::Journal.upsert(id, "Renamed", Some(base)),
                &delete,
            ] {
                assert_eq!(
                    apply_v3(&conn, &ctx, intent),
                    Outcome::Refused("absent".to_string()),
                    "{}",
                    intent.kind()
                );
                let rec = import_row(&conn, &v3_path(intent)).unwrap();
                assert_eq!(rec.last_applied_updated_at, None, "{}", intent.kind());
            }
            assert_eq!(
                Taxon::Journal.row(&conn, id).unwrap(),
                ("Hidden".to_string(), base, false)
            );
        }
    }

    /// `delete_tag`: unknown is `absent`; a desktop edit since the base wins; a rename then
    /// a delete from the same base on one `t-` path both apply (own-path chain); a
    /// replay of a deleted tag is applied with its stamp.
    #[test]
    fn test_v3_delete_tag_applied_already_deleted_and_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let delete = |id: &str, base_updated_at: i64| OutboxIntentV3::DeleteTag {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 2,
            tag_id: id.to_string(),
            base_updated_at,
        };
        let missing = delete("tag-v3-missing-001", 1);
        assert_eq!(
            apply_v3(&conn, &ctx, &missing),
            Outcome::Refused("absent".to_string())
        );

        let id = "tag-v3-delete-0001";
        assert_eq!(
            apply_v3(&conn, &ctx, &Taxon::Tag.upsert(id, "Doomed", None)),
            Outcome::Applied
        );
        Taxon::Tag.set(&conn, id, "updated_at = 1000");
        let stale = delete(id, 999);
        assert_eq!(
            apply_v3(&conn, &ctx, &stale),
            Outcome::Refused("changed_on_desktop".to_string())
        );
        assert!(!Taxon::Tag.row(&conn, id).unwrap().2);

        let rename = Taxon::Tag.upsert(id, "Doomed 2", Some(1000));
        assert_eq!(apply_v3(&conn, &ctx, &rename), Outcome::Applied);
        let del = delete(id, 1000);
        assert_eq!(apply_v3(&conn, &ctx, &del), Outcome::Applied, "chained");
        let (_, stamp, deleted) = Taxon::Tag.row(&conn, id).unwrap();
        assert!(deleted);
        let rec = import_row(&conn, &v3_path(&del)).unwrap();
        assert_eq!(rec.last_applied_updated_at, Some(stamp));

        let again = delete(id, 1);
        assert_eq!(apply_v3(&conn, &ctx, &again), Outcome::Applied, "replay");
        let rec = import_row(&conn, &v3_path(&again)).unwrap();
        assert_eq!(rec.last_applied_updated_at, Some(stamp));
    }

    /// `delete_journal` (Q1). `last_journal` counts like the desktop command: an
    /// invisible-vault journal does not keep the main vault's last journal deletable.
    /// `journal_not_empty` counts every row the web cannot see (a locked entry, an
    /// invisible-vault entry, a trashed-not-purged entry), never a purged tombstone.
    /// Then desktop wins, the delete applies, and a replay is applied.
    #[test]
    fn test_v3_delete_journal_refusals_and_apply() {
        // The applied delete re-arms the process-wide own-cloud reconcile flag.
        let _reconcile = crate::sync::engine::SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let delete = |id: &str, base_updated_at: i64| OutboxIntentV3::DeleteJournal {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 3,
            journal_id: id.to_string(),
            base_updated_at,
        };
        let stamp = |id: &str| Taxon::Journal.row(&conn, id).unwrap().1;
        let refused = |intent: &OutboxIntentV3, code: &str| {
            assert_eq!(
                apply_v3(&conn, &ctx, intent),
                Outcome::Refused(code.to_string()),
                "{code}"
            );
        };

        let main = default_journal_id(&conn);
        let vault = db::queries::create_journal(&conn, "Vault", None).unwrap();
        db::queries::set_journal_invisible(&conn, &vault.id, true, Some("vault-a")).unwrap();
        refused(&delete(&main, stamp(&main)), "last_journal");
        assert!(!Taxon::Journal.row(&conn, &main).unwrap().2);

        let doomed = db::queries::create_journal(&conn, "Doomed", None).unwrap();
        type Hide = fn(&Connection, &str);
        let hides: [(&str, Hide); 3] = [
            ("locked", |c, id| {
                db::queries::set_entry_locked(c, id, true).unwrap()
            }),
            ("invisible", |c, id| {
                db::queries::set_entry_invisible(c, id, true, Some("vault-a")).unwrap()
            }),
            ("trashed", |c, id| soft_delete_entry_impl(c, id).unwrap()),
        ];
        for (label, hide) in hides {
            let e = live_entry(&conn, &doomed.id);
            hide(&conn, &e.id);
            refused(&delete(&doomed.id, stamp(&doomed.id)), "journal_not_empty");
            assert!(!Taxon::Journal.row(&conn, &doomed.id).unwrap().2, "{label}");
            conn.execute(
                "UPDATE entries SET is_deleted = 1, trashed_at = NULL WHERE id = ?1",
                [&e.id],
            )
            .unwrap();
        }

        refused(
            &delete(&doomed.id, stamp(&doomed.id) - 1),
            "changed_on_desktop",
        );
        let ok = delete(&doomed.id, stamp(&doomed.id));
        assert_eq!(apply_v3(&conn, &ctx, &ok), Outcome::Applied);
        let (_, gone_stamp, deleted) = Taxon::Journal.row(&conn, &doomed.id).unwrap();
        assert!(deleted);
        let rec = import_row(&conn, &v3_path(&ok)).unwrap();
        assert_eq!(rec.last_applied_updated_at, Some(gone_stamp));
        let again = delete(&doomed.id, 1);
        assert_eq!(apply_v3(&conn, &ctx, &again), Outcome::Applied, "replay");

        refused(&delete(&vault.id, stamp(&vault.id)), "absent");
        refused(&delete("journal-v3-missing-1", 1), "absent");
    }

    /// The entry chain (README "Own-path chaining") reads the entry's own paths and the
    /// same web device's rows naming the entry in `decided_fields` (json_extract: this
    /// fails loudly on a SQLite without JSON1). Another device, another entry, an
    /// unapplied row or a non-JSON / v1-map column never extends it.
    #[test]
    fn test_own_chain_reaches_entry_edges_across_paths() {
        let conn = setup_test_db();
        let dir = format!("{V2_WEB_A}/outbox");
        let other_dir = format!("{V2_WEB_B}/outbox");
        let e = "entry-chain-000001";
        let edge = |path: String, outcome: &str, from: i64, to: i64, decided: Option<String>| {
            outbox_import_record(
                &conn,
                &WebOutboxImportRecord {
                    path,
                    revision: None,
                    content_hash: "h".to_string(),
                    outcome: outcome.to_string(),
                    imported_at: 1,
                    last_applied_updated_at: Some(to),
                    post_import_fingerprint: None,
                    decided_fields: decided,
                    pending_revision: None,
                    pending_plan: None,
                    created: false,
                    applied_from_updated_at: Some(from),
                },
            )
            .unwrap();
        };
        let naming = |id: &str| Some(serde_json::json!({ "entry_id": id }).to_string());
        let v1_map = BTreeMap::from([(
            "title@1".to_string(),
            OutboxFieldDecision {
                field: "title".to_string(),
                change_seq: 1,
                decision: "applied".to_string(),
                decided_updated_at: 1,
                reason: None,
            },
        )]);
        edge(
            format!("{dir}/{e}.bin"),
            "applied",
            100,
            200,
            serde_json::to_string(&v1_map).ok(),
        );
        edge(
            format!("{dir}/a-media-chain-01.bin"),
            "applied",
            200,
            300,
            naming(e),
        );
        let target = ChainTarget::Entry {
            dir: &dir,
            entry_id: e,
        };
        let reaches = |base, current| own_chain_reaches(&conn, &target, base, current).unwrap();
        assert!(reaches(100, 300));
        assert!(reaches(150, 300), "any base inside an edge");
        assert!(!reaches(50, 300));

        edge(
            format!("{dir}/a-media-chain-02.bin"),
            "applied",
            300,
            400,
            naming("entry-chain-other1"),
        );
        edge(
            format!("{other_dir}/a-media-chain-03.bin"),
            "applied",
            300,
            400,
            naming(e),
        );
        edge(
            format!("{dir}/i-media-chain-04.bin"),
            "refused",
            300,
            400,
            naming(e),
        );
        edge(
            format!("{dir}/z-media-chain-05.bin"),
            "applied",
            300,
            400,
            Some("not json".to_string()),
        );
        assert!(!reaches(100, 400));

        edge(format!("{dir}/l-{e}.bin"), "applied", 300, 400, None);
        assert!(reaches(100, 400), "an own `l-` edge");
    }

    /// Review round 6: one v1 path, fields on different bases. Revision 1 sets the title
    /// from 100; the web then sees stamp 200 and revision 2 carries only an emotion from
    /// 200; revision 3 re-edits the title (still from 100, never acked) and the emotion
    /// (from 200). Every field applies: revision 2 keeps the chain's start at 100.
    #[test]
    fn test_v1_fields_on_different_bases_chain_over_three_revisions() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        conn.execute("UPDATE entries SET updated_at = 100 WHERE id = ?1", [&e.id])
            .unwrap();
        let title = |value: &str, change_seq| FieldChange {
            value: value.to_string(),
            base: "Desk".to_string(),
            base_updated_at: 100,
            change_seq,
            changed_at_secs: 1,
        };
        let emotion = |value: &str, change_seq| FieldChange {
            value: Some(value.to_string()),
            base: None,
            base_updated_at: 200,
            change_seq,
            changed_at_secs: 1,
        };
        let mut intent = make_base_intent(&e.id, V2_WEB_A);

        intent.entry.fields.title = Some(title("Web 1", 1));
        assert_eq!(apply_intent(&conn, &ctx, &intent).0, Outcome::Applied);
        // Pin the import's stamp at 200 (the stamp the web then pulls).
        conn.execute("UPDATE entries SET updated_at = 200 WHERE id = ?1", [&e.id])
            .unwrap();
        conn.execute(
            "UPDATE web_outbox_imports SET last_applied_updated_at = 200 WHERE path = ?1",
            [&intent.path],
        )
        .unwrap();

        intent.revision = Some("rev-2".to_string());
        intent.entry.fields.title = None;
        intent.entry.fields.emotion = Some(emotion("good", 2));
        assert_eq!(apply_intent(&conn, &ctx, &intent).0, Outcome::Applied);

        intent.revision = Some("rev-3".to_string());
        intent.entry.fields.title = Some(title("Web 3", 3));
        intent.entry.fields.emotion = Some(emotion("bad", 4));
        assert_eq!(apply_intent(&conn, &ctx, &intent).0, Outcome::Applied);

        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Web 3"));
        assert_eq!(after.emotion.as_deref(), Some("bad"));
        let decided: BTreeMap<String, OutboxFieldDecision> = serde_json::from_str(
            &import_row(&conn, &intent.path)
                .unwrap()
                .decided_fields
                .unwrap(),
        )
        .unwrap();
        assert_eq!(decided.len(), 4);
        assert!(
            decided.values().all(|d| d.decision == "applied"),
            "{decided:?}"
        );
    }

    /// One cycle mixing frames: a v2 create_tag, a v3 upsert_template, a v1 entry edit
    /// and a v3 trash_entry apply by kind rank (tag < template < entry < trash), against
    /// their `web_updated_at_secs`; the v3 trash chains on the v1 edit's apply.
    #[tokio::test]
    async fn test_cycle_mixed_frames_apply_in_kind_rank_order() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();

        // Timestamps run against the rank: the tag is the newest, the trash the oldest.
        let tag = v2_tag(V2_WEB_A, "tag-mixed-000001", 9_000);
        let tag_path = v2_path(&tag);
        write_v2(&provider, &tag_path, &tag).await;
        let mut template = v3_of(&v2_template("template-mixed-01", "Mixed", b"m", None));
        if let OutboxIntentV3::UpsertTemplate {
            web_updated_at_secs,
            ..
        } = &mut template
        {
            *web_updated_at_secs = 5_000;
        }
        let template_path = write_v3(&provider, &template).await;
        let mut edit = v1_edit(V2_WEB_A, &e.id, 2_000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let mut trash = v3_of(&v2_trash(&e.id, base));
        if let OutboxIntentV3::TrashEntry {
            web_updated_at_secs,
            ..
        } = &mut trash
        {
            *web_updated_at_secs = 1;
        }
        let trash_path = write_v3(&provider, &trash).await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 4, "{res:?}");
        assert_eq!(
            *sink.dispatched.lock().unwrap(),
            vec![
                tag_path.clone(),
                template_path.clone(),
                edit_path.clone(),
                trash_path.clone()
            ]
        );
        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Edited"));
        assert!(after.is_deleted && after.trashed_at.is_some());
        let template_row = db::queries::get_template_for_import(&conn, "template-mixed-01")
            .unwrap()
            .unwrap();

        let trash_ack = own_ack(&provider, &trash_path).await;
        assert_eq!(trash_ack.applied_updated_at, Some(after.updated_at));
        assert_eq!(trash_ack.refused_reason, None);
        // The v3 row names its entry for the chain; that never reaches the ack.
        let trash_row = import_row(&conn, &trash_path).unwrap();
        assert!(trash_row.decided_fields.unwrap().contains(&e.id));
        assert!(trash_ack.decided.is_empty());
        let template_ack = own_ack(&provider, &template_path).await;
        assert_eq!(
            template_ack.applied_updated_at,
            Some(template_row.updated_at)
        );
        assert!(!template_ack.created);
        assert!(own_ack(&provider, &tag_path).await.created);
    }

    // ---- Phase 8.3: restore_entry, purge_entry, empty_trash ----

    fn v3_restore(entry_id: &str, base_updated_at: i64) -> OutboxIntentV3 {
        OutboxIntentV3::RestoreEntry {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 13,
            entry_id: entry_id.to_string(),
            base_updated_at,
        }
    }

    fn v3_purge(entry_id: &str, base_updated_at: i64) -> OutboxIntentV3 {
        OutboxIntentV3::PurgeEntry {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 14,
            entry_id: entry_id.to_string(),
            base_updated_at,
        }
    }

    /// A live entry moved to Trash, as the web lists it.
    fn trashed_entry(conn: &Connection, journal_id: &str) -> db::Entry {
        let e = live_entry(conn, journal_id);
        soft_delete_entry_impl(conn, &e.id).unwrap();
        raw_entry(conn, &e.id)
    }

    fn in_trash(conn: &Connection, id: &str) -> bool {
        let e = raw_entry(conn, id);
        e.is_deleted && e.trashed_at.is_some()
    }

    /// Restore (rank 28) and a v1 title edit of the same entry from one base: the edit
    /// chains on the restore's apply, in one cycle or across two. The one-cycle run puts
    /// the edit at the read budget's last slot, so the `d-` file must be read with it.
    #[tokio::test]
    async fn test_cycle_restore_then_edit_applies_in_one_or_two_cycles() {
        for two_cycles in [false, true] {
            let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
            let conn = setup_test_db();
            let jid = default_journal_id(&conn);
            let e = trashed_entry(&conn, &jid);
            let base = e.updated_at;

            let restore = v3_restore(&e.id, base);
            let restore_path = write_v3(&provider, &restore).await;
            let sink = TestOutboxSink::default();
            if two_cycles {
                let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
                assert_eq!(res.intents_applied, 1, "{res:?}");
            } else {
                // Fill the read budget up to the edit (tags read first).
                for i in 0..19 {
                    let tag = v2_tag(V2_WEB_A, &format!("tag-budget-{i:05}"), 1);
                    write_v2(&provider, &v2_path(&tag), &tag).await;
                }
            }
            let mut edit = v1_edit(V2_WEB_A, &e.id, 2_000);
            if let Some(t) = edit.fields.title.as_mut() {
                t.base = "Desk".to_string();
                t.base_updated_at = base;
            }
            edit.base_state_vector = vec![0];
            edit.yjs_full_state = vec![];
            edit.content_text = None;
            edit.preview_text = None;
            let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
            write_v1(&provider, &edit_path, &edit).await;
            let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;

            let label = if two_cycles {
                "two cycles"
            } else {
                "one cycle"
            };
            assert_eq!(res.intents_refused, 0, "{label}: {res:?}");
            let dispatched = sink.dispatched.lock().unwrap().clone();
            let at = |p: &str| dispatched.iter().position(|d| d == p);
            assert!(
                at(&restore_path) < at(&edit_path),
                "{label}: {dispatched:?}"
            );
            let after = raw_entry(&conn, &e.id);
            assert!(!after.is_deleted && after.trashed_at.is_none(), "{label}");
            assert_eq!(after.title.as_deref(), Some("Edited"), "{label}");
            assert_eq!(
                import_row(&conn, &edit_path).unwrap().outcome,
                "applied",
                "{label}"
            );
            let restore_row = import_row(&conn, &restore_path).unwrap();
            assert_eq!(restore_row.outcome, "applied", "{label}");
            let ack = own_ack(&provider, &restore_path).await;
            assert_eq!(ack.applied_updated_at, restore_row.last_applied_updated_at);
            assert!(ack.applied_updated_at.is_some_and(|s| s > base), "{label}");
        }
    }

    /// The importer view (README "Importer view"): restore and purge never touch, nor
    /// reveal, a locked or invisible entry (or one in a locked / invisible journal), and
    /// a target live on a peer but not pulled yet waits.
    #[test]
    fn test_v3_restore_and_purge_hidden_targets_are_absent() {
        type Kind = fn(&str, i64) -> OutboxIntentV3;
        type Hide = fn(&Connection, &str, &str);
        let kinds: [(&str, Kind); 2] = [("restore", v3_restore), ("purge", v3_purge)];
        let hides: [(&str, Hide); 4] = [
            ("locked", |c, id, _| {
                db::queries::set_entry_locked(c, id, true).unwrap()
            }),
            ("invisible", |c, id, _| {
                db::queries::set_entry_invisible(c, id, true, Some("vault-a")).unwrap()
            }),
            ("locked journal", |c, _, jid| {
                c.execute("UPDATE journals SET is_locked = 1 WHERE id = ?1", [jid])
                    .unwrap();
            }),
            ("invisible journal", |c, _, jid| {
                db::queries::set_journal_invisible(c, jid, true, Some("vault-a")).unwrap();
            }),
        ];
        for (kind, make) in kinds {
            for (label, hide) in hides {
                let conn = setup_test_db();
                let (_d, ctx) = v2_ctx();
                let journal = db::queries::create_journal(&conn, "Other", None).unwrap();
                let e = trashed_entry(&conn, &journal.id);
                hide(&conn, &e.id, &journal.id);
                let before = raw_entry(&conn, &e.id);
                let intent = make(&e.id, before.updated_at);
                assert_eq!(
                    apply_v3(&conn, &ctx, &intent),
                    Outcome::Refused(ABSENT.to_string()),
                    "{kind} {label}"
                );
                let row = import_row(&conn, &v3_path(&intent)).unwrap();
                assert_eq!(row.last_applied_updated_at, None, "{kind} {label}");
                let after = raw_entry(&conn, &e.id);
                assert!(in_trash(&conn, &e.id), "{kind} {label}");
                assert_eq!(after.updated_at, before.updated_at, "{kind} {label}");
            }

            let conn = setup_test_db();
            let (_d, mut ctx) = v2_ctx();
            let missing = make("entry-v3-missing-01", 5);
            assert_eq!(
                apply_v3(&conn, &ctx, &missing),
                Outcome::Refused(ABSENT.to_string()),
                "{kind}"
            );
            ctx.known_ids
                .insert("entry-v3-unpulled1".to_string(), false);
            let unpulled = make("entry-v3-unpulled1", 5);
            assert_eq!(apply_v3(&conn, &ctx, &unpulled), Outcome::Transient);
            assert!(import_row(&conn, &v3_path(&unpulled)).is_none(), "{kind}");
        }
    }

    /// Restore and purge rules on a visible entry: desktop wins on the trashed row's
    /// stamp; a live entry is `not_in_trash` unless only this web device's own applies
    /// changed it since the base (a replay of the applied restore); the applied stamp is
    /// the row's after the write.
    #[test]
    fn test_v3_restore_and_purge_base_and_trash_state() {
        type Kind = fn(&str, i64) -> OutboxIntentV3;
        let kinds: [(&str, Kind); 2] = [("restore", v3_restore), ("purge", v3_purge)];
        for (kind, make) in kinds {
            let _reconcile = crate::sync::engine::SESSION_RECONCILE_TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            let jid = default_journal_id(&conn);
            let e = trashed_entry(&conn, &jid);

            let stale = make(&e.id, e.updated_at - 1);
            assert_eq!(
                apply_v3(&conn, &ctx, &stale),
                Outcome::Refused(CHANGED_ON_DESKTOP.to_string()),
                "{kind}"
            );
            assert!(in_trash(&conn, &e.id), "{kind}");

            let live = live_entry(&conn, &jid);
            let on_live = make(&live.id, live.updated_at - 1);
            assert_eq!(
                apply_v3(&conn, &ctx, &on_live),
                Outcome::Refused("not_in_trash".to_string()),
                "{kind}"
            );
            assert!(!raw_entry(&conn, &live.id).is_deleted, "{kind}");

            let ok = make(&e.id, e.updated_at);
            assert_eq!(apply_v3(&conn, &ctx, &ok), Outcome::Applied, "{kind}");
            let after = raw_entry(&conn, &e.id);
            assert_eq!(after.trashed_at, None, "{kind}");
            assert_eq!(after.is_deleted, kind == "purge", "{kind}");
            let rec = import_row(&conn, &v3_path(&ok)).unwrap();
            assert_eq!(
                rec.last_applied_updated_at,
                Some(after.updated_at),
                "{kind}"
            );
            assert_eq!(
                apply_v3(&conn, &ctx, &ok),
                Outcome::Applied,
                "{kind}: replay"
            );
            assert_eq!(raw_entry(&conn, &e.id).updated_at, after.updated_at);
        }

        // A restore of an entry the desktop then edited is no longer reflected.
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = trashed_entry(&conn, &jid);
        let restore = v3_restore(&e.id, e.updated_at);
        assert_eq!(apply_v3(&conn, &ctx, &restore), Outcome::Applied);
        conn.execute(
            "UPDATE entries SET updated_at = updated_at + 100 WHERE id = ?1",
            [&e.id],
        )
        .unwrap();
        assert_eq!(
            apply_v3(&conn, &ctx, &restore),
            Outcome::Refused("not_in_trash".to_string())
        );
    }

    /// A purge removes the entry's media rows and, after the commit, its files (once:
    /// `purge_entry_impl` unlinks them itself).
    #[test]
    fn test_v3_purge_removes_media_rows_and_files() {
        use std::io::Write;
        let _reconcile = crate::sync::engine::SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let conn = setup_test_db();
        let (dir, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let storage = dir.path().join("photo.jpg");
        let thumb = dir.path().join("photo.jpg.thumb");
        for f in [&storage, &thumb] {
            std::fs::File::create(f).unwrap().write_all(b"x").unwrap();
        }
        let media = db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &e.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: storage.to_str().unwrap(),
                file_size: Some(1),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::update_media_thumbnail_path(&conn, &media.id, Some(thumb.to_str().unwrap())).unwrap();
        soft_delete_entry_impl(&conn, &e.id).unwrap();
        assert!(storage.exists() && thumb.exists(), "trash keeps the files");

        let purge = v3_purge(&e.id, raw_entry(&conn, &e.id).updated_at);
        assert_eq!(apply_v3(&conn, &ctx, &purge), Outcome::Applied);
        assert!(db::get_media_for_entry(&conn, &e.id).unwrap().is_empty());
        assert!(!storage.exists() && !thumb.exists());
    }

    /// `empty_trash` purges exactly the listed entries still in visible Trash at their
    /// listed stamp: an unlisted trashed entry, a listed one trashed again since, and a
    /// listed one restored since all stay; the ack stamp is set even when some are kept.
    #[test]
    fn test_v3_empty_trash_purges_only_listed_items_at_their_base() {
        use memlore_core::outbox::EmptyTrashItem;
        let _reconcile = crate::sync::engine::SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let listed = trashed_entry(&conn, &jid);
        let unlisted = trashed_entry(&conn, &jid);
        let retrashed = trashed_entry(&conn, &jid);
        let restored = trashed_entry(&conn, &jid);
        let locked = trashed_entry(&conn, &jid);
        db::queries::set_entry_locked(&conn, &locked.id, true).unwrap();
        let locked = raw_entry(&conn, &locked.id);
        let item = |e: &db::Entry| EmptyTrashItem {
            entry_id: e.id.clone(),
            base_updated_at: e.updated_at,
        };
        let intent = OutboxIntentV3::EmptyTrash {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 15,
            items: vec![
                item(&listed),
                item(&retrashed),
                item(&restored),
                item(&locked),
                EmptyTrashItem {
                    entry_id: "entry-v3-missing-02".to_string(),
                    base_updated_at: 1,
                },
            ],
        };
        // Trashed again on the desktop after the web listed it.
        crate::commands::entries::restore_entry_impl(
            &conn,
            &retrashed.id,
            db::queries::LockedView::Revealed,
            None,
        )
        .unwrap();
        soft_delete_entry_impl(&conn, &retrashed.id).unwrap();
        crate::commands::entries::restore_entry_impl(
            &conn,
            &restored.id,
            db::queries::LockedView::Revealed,
            None,
        )
        .unwrap();

        let before = chrono::Utc::now().timestamp();
        assert_eq!(apply_v3(&conn, &ctx, &intent), Outcome::Applied);
        let purged = raw_entry(&conn, &listed.id);
        assert!(purged.is_deleted && purged.trashed_at.is_none());
        for kept in [&unlisted, &retrashed, &locked] {
            assert!(in_trash(&conn, &kept.id), "{}", kept.id);
        }
        assert!(!raw_entry(&conn, &restored.id).is_deleted);
        let rec = import_row(&conn, &v3_path(&intent)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert!(rec.last_applied_updated_at.is_some_and(|s| s >= before));
    }

    // ---- Phase 8.4: set_entry_location, set_media_insertion_mode ----

    fn place(lat: Option<f64>, lon: Option<f64>, label: &str) -> OutboxLocation {
        OutboxLocation {
            latitude: lat,
            longitude: lon,
            label: Some(label.to_string()),
            address: None,
        }
    }

    fn v3_location(
        entry_id: &str,
        value: Option<OutboxLocation>,
        base: Option<OutboxLocation>,
        base_updated_at: i64,
    ) -> OutboxIntentV3 {
        OutboxIntentV3::SetEntryLocation {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 16,
            entry_id: entry_id.to_string(),
            value,
            base,
            base_updated_at,
        }
    }

    fn v3_mode(
        entry_id: &str,
        media_id: &str,
        mode: MediaInsertionMode,
        base_mode: MediaInsertionMode,
        base_updated_at: i64,
    ) -> OutboxIntentV3 {
        OutboxIntentV3::SetMediaInsertionMode {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 17,
            entry_id: entry_id.to_string(),
            media_id: media_id.to_string(),
            mode,
            base_mode,
            base_updated_at,
        }
    }

    /// A desktop entry at stamp 1000 (in the past, so every apply moves it) holding
    /// `location`, already synced.
    fn located_entry(
        conn: &Connection,
        journal_id: &str,
        location: Option<&OutboxLocation>,
    ) -> db::Entry {
        let e = live_entry(conn, journal_id);
        conn.execute(
            "UPDATE entries SET latitude = ?1, longitude = ?2, location_label = ?3,
                 location_address = ?4 WHERE id = ?5",
            rusqlite::params![
                location.and_then(|l| l.latitude),
                location.and_then(|l| l.longitude),
                location.and_then(|l| l.label.clone()),
                location.and_then(|l| l.address.clone()),
                e.id
            ],
        )
        .unwrap();
        settle(conn, &e.id);
        raw_entry(conn, &e.id)
    }

    /// Pin the entry at stamp 1000 and mark it synced, so an apply's stamp bump and
    /// `mark_entry_pending` are observable.
    fn settle(conn: &Connection, id: &str) {
        conn.execute("UPDATE entries SET updated_at = 1000 WHERE id = ?1", [id])
            .unwrap();
        conn.execute(
            "UPDATE sync_state SET sync_status = 'synced' WHERE entry_id = ?1",
            [id],
        )
        .unwrap();
    }

    fn sync_row(conn: &Connection, id: &str) -> (i64, String) {
        conn.query_row(
            "SELECT local_version, sync_status FROM sync_state WHERE entry_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn location_of(conn: &Connection, id: &str) -> Option<OutboxLocation> {
        entry_location(&raw_entry(conn, id))
    }

    /// `set_entry_location` on a visible live entry: a coordinate and a label-only
    /// location apply over the base the web saw (acking the stamp read after the write,
    /// entry pending), a replay is reflected without a write, `null` clears, and a
    /// desktop edit since the base wins.
    #[test]
    fn test_v3_set_entry_location_applies_reflects_clears_and_desktop_wins() {
        let home = place(Some(48.85), Some(2.35), "Home");
        let cafe = place(None, None, "Cafe");
        let cases: [(&str, Option<OutboxLocation>, Option<OutboxLocation>); 4] = [
            ("coordinates", None, Some(home.clone())),
            (
                "label-only",
                Some(cafe.clone()),
                Some(place(None, None, "Park")),
            ),
            ("clear", Some(home.clone()), None),
            ("label-only to coordinates", Some(cafe), Some(home)),
        ];
        for (label, before, value) in cases {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            let jid = default_journal_id(&conn);
            let e = located_entry(&conn, &jid, before.as_ref());
            let (version, _) = sync_row(&conn, &e.id);
            let set = v3_location(&e.id, value.clone(), before.clone(), e.updated_at);
            assert_eq!(apply_v3(&conn, &ctx, &set), Outcome::Applied, "{label}");
            let after = raw_entry(&conn, &e.id);
            assert_eq!(entry_location(&after), value, "{label}");
            assert!(after.updated_at > e.updated_at, "{label}");
            assert_eq!(sync_row(&conn, &e.id), (version + 1, "pending".to_string()));
            let rec = import_row(&conn, &v3_path(&set)).unwrap();
            assert_eq!(
                rec.last_applied_updated_at,
                Some(after.updated_at),
                "{label}"
            );
            assert_eq!(rec.applied_from_updated_at, Some(e.updated_at), "{label}");

            // Reflected: nothing written, same stamp acked.
            assert_eq!(
                apply_v3(&conn, &ctx, &set),
                Outcome::Applied,
                "{label} replay"
            );
            assert_eq!(raw_entry(&conn, &e.id).updated_at, after.updated_at);
            assert_eq!(sync_row(&conn, &e.id).0, version + 1, "{label}");

            // The desktop edits the location since: an edit from the old base loses.
            let desk = place(Some(1.0), Some(1.0), "Desk");
            update_entry_location_impl(&conn, &e.id, Some(1.0), Some(1.0), Some("Desk"), None)
                .unwrap();
            conn.execute(
                "UPDATE entries SET updated_at = updated_at + 100 WHERE id = ?1",
                [&e.id],
            )
            .unwrap();
            let stale = v3_location(&e.id, before.clone(), value.clone(), after.updated_at);
            assert_eq!(
                apply_v3(&conn, &ctx, &stale),
                Outcome::Refused(CHANGED_ON_DESKTOP.to_string()),
                "{label}"
            );
            assert_eq!(location_of(&conn, &e.id), Some(desk), "{label}");
        }
    }

    /// A hidden, trashed, purged or missing target is never written nor revealed; one
    /// live on a peer but not pulled yet waits. Same pre-check for both kinds.
    #[test]
    fn test_v3_location_and_insertion_mode_refuse_hidden_and_trashed_entries() {
        type Hide = fn(&Connection, &str, &str);
        let hides: [(&str, Hide, &str); 6] = [
            (
                "locked",
                |c, id, _| db::queries::set_entry_locked(c, id, true).unwrap(),
                ABSENT,
            ),
            (
                "invisible",
                |c, id, _| db::queries::set_entry_invisible(c, id, true, Some("vault-a")).unwrap(),
                ABSENT,
            ),
            (
                "locked journal",
                |c, _, jid| {
                    c.execute("UPDATE journals SET is_locked = 1 WHERE id = ?1", [jid])
                        .unwrap();
                },
                ABSENT,
            ),
            (
                "invisible journal",
                |c, _, jid| {
                    db::queries::set_journal_invisible(c, jid, true, Some("vault-a")).unwrap();
                },
                ABSENT,
            ),
            (
                "trashed",
                |c, id, _| soft_delete_entry_impl(c, id).unwrap(),
                ENTRY_TRASHED,
            ),
            (
                "purged",
                |c, id, _| {
                    c.execute(
                        "UPDATE entries SET is_deleted = 1, trashed_at = NULL WHERE id = ?1",
                        [id],
                    )
                    .unwrap();
                },
                ABSENT,
            ),
        ];
        use MediaInsertionMode::{Attached, Inline};
        for (label, hide, code) in hides {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            let journal = db::queries::create_journal(&conn, "Other", None).unwrap();
            let e = located_entry(&conn, &journal.id, None);
            let media = media_row(&conn, &e.id, "inline");
            hide(&conn, &e.id, &journal.id);
            let before = raw_entry(&conn, &e.id);
            let blob = b"blob".to_vec();
            let intents = [
                v3_location(
                    &e.id,
                    Some(place(None, None, "Web")),
                    None,
                    before.updated_at,
                ),
                v3_mode(&e.id, &media, Attached, Inline, before.updated_at),
                v3_attach(&e.id, ATTACH_ID, OCTET, "a.pdf", blob.len() as u64),
                v3_delete_media(&e.id, &media),
            ];
            for intent in &intents {
                assert_eq!(
                    attach_with(&conn, &ctx, intent, AttachBlob::Opened(&blob)),
                    Outcome::Refused(code.to_string()),
                    "{} {label}",
                    intent.kind()
                );
                let rec = import_row(&conn, &v3_path(intent)).unwrap();
                assert_eq!(rec.last_applied_updated_at, None, "{label}");
            }
            let after = raw_entry(&conn, &e.id);
            assert_eq!(after.updated_at, before.updated_at, "{label}");
            assert_eq!(entry_location(&after), None, "{label}");
            assert_eq!(
                get_media(&conn, &media).unwrap().unwrap().insertion_mode,
                "inline"
            );
            assert!(get_media(&conn, ATTACH_ID).unwrap().is_none(), "{label}");
            assert!(!ctx.media_dir.join(format!("{ATTACH_ID}.pdf")).exists());
        }

        let conn = setup_test_db();
        let (_d, mut ctx) = v2_ctx();
        ctx.known_ids
            .insert("entry-v3-unpulled2".to_string(), false);
        for id in ["entry-v3-missing-03", "entry-v3-unpulled2"] {
            let intents = [
                v3_location(id, None, None, 5),
                v3_mode(id, &format!("media-{id}"), Attached, Inline, 5),
                v3_attach(id, &format!("media-a-{id}"), OCTET, "a.pdf", 4),
                v3_delete_media(id, &format!("media-d-{id}")),
            ];
            for intent in &intents {
                let out = apply_v3(&conn, &ctx, intent);
                if id.contains("unpulled") {
                    assert_eq!(out, Outcome::Transient, "{}", intent.kind());
                    assert!(import_row(&conn, &v3_path(intent)).is_none());
                } else {
                    assert_eq!(
                        out,
                        Outcome::Refused(ABSENT.to_string()),
                        "{}",
                        intent.kind()
                    );
                }
            }
        }
    }

    /// Own-path chaining (README): two revisions of one `l-` path, the second keeping
    /// the first base (never acked yet), both apply; then a v1 title edit from that same
    /// base chains on the `l-` edge (entry-wide chain).
    #[test]
    fn test_v3_location_revisions_and_v1_edit_chain_on_the_first_base() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let base = e.updated_at;

        let rev1 = v3_location(&e.id, Some(place(None, None, "One")), None, base);
        assert_eq!(apply_v3(&conn, &ctx, &rev1), Outcome::Applied);
        let rev2 = v3_location(&e.id, Some(place(Some(1.0), Some(2.0), "Two")), None, base);
        assert_eq!(
            apply_v3(&conn, &ctx, &rev2),
            Outcome::Applied,
            "rev 2 chains"
        );
        assert_eq!(
            location_of(&conn, &e.id),
            Some(place(Some(1.0), Some(2.0), "Two"))
        );
        let rec = import_row(&conn, &v3_path(&rev2)).unwrap();
        assert_eq!(rec.applied_from_updated_at, Some(base));

        let mut edit = make_base_intent(&e.id, V2_WEB_A);
        edit.entry.fields.title = Some(FieldChange {
            value: "Web".to_string(),
            base: "Desk".to_string(),
            base_updated_at: base,
            change_seq: 1,
            changed_at_secs: 1,
        });
        assert_eq!(apply_intent(&conn, &ctx, &edit).0, Outcome::Applied);
        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Web"));
        assert_eq!(
            entry_location(&after),
            Some(place(Some(1.0), Some(2.0), "Two"))
        );
    }

    /// Same-second race: a desktop edit in the same second as a v3 entry apply, or in the
    /// next one, must land strictly past the stamp the apply recorded, or a later v1 edit
    /// from the web's older base would chain over it. Every desktop entry setter is
    /// monotonic (`MAX(updated_at + 1, now)`).
    #[test]
    fn test_v3_entry_apply_stamp_never_reached_by_a_later_desktop_edit() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let t = crate::utils::time::now_unix();
        for offset in [0, 1] {
            let e = located_entry(&conn, &jid, None);
            let base = e.updated_at;
            let set = v3_location(&e.id, Some(place(None, None, "Cafe")), None, base);
            {
                let _clock = crate::utils::time::pin_now_unix(t);
                assert_eq!(apply_v3(&conn, &ctx, &set), Outcome::Applied);
            }
            let applied = import_row(&conn, &v3_path(&set))
                .unwrap()
                .last_applied_updated_at
                .unwrap();
            {
                let _clock = crate::utils::time::pin_now_unix(t + offset);
                db::update_entry(&conn, &e.id, Some("Desk 2"), None, None).unwrap();
            }
            assert!(
                raw_entry(&conn, &e.id).updated_at > applied,
                "offset {offset}: the desktop edit lands past the apply's stamp"
            );
            let mut edit = make_base_intent(&e.id, V2_WEB_A);
            edit.entry.fields.title = Some(FieldChange {
                value: "Web".to_string(),
                base: "Desk".to_string(),
                base_updated_at: base,
                change_seq: 1,
                changed_at_secs: 1,
            });
            apply_intent(&conn, &ctx, &edit);
            assert_eq!(
                raw_entry(&conn, &e.id).title.as_deref(),
                Some("Desk 2"),
                "offset {offset}: the desktop edit since the web's base wins"
            );
        }
    }

    /// A media row of the entry, with `mode`.
    fn media_row(conn: &Connection, entry_id: &str, mode: &str) -> String {
        db::create_media(
            conn,
            db::CreateMediaParams {
                entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: "/nowhere/photo.jpg",
                file_size: Some(1),
                sort_order: 0,
                insertion_mode: mode,
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap()
        .id
    }

    /// `set_media_insertion_mode`: applied over the base mode (entry stamp bumped and
    /// entry pending, so its payload republishes the new mode), reflected on replay, a
    /// media row of another entry is `media_entry_mismatch`, a missing one `absent`, and
    /// a desktop change since the base wins.
    #[test]
    fn test_v3_set_media_insertion_mode_rules() {
        use MediaInsertionMode::{Attached, Inline};
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let media = media_row(&conn, &e.id, "inline");
        settle(&conn, &e.id);
        let (version, _) = sync_row(&conn, &e.id);
        let mode_of = |id: &str| get_media(&conn, id).unwrap().unwrap().insertion_mode;

        let set = v3_mode(&e.id, &media, Attached, Inline, 1000);
        assert_eq!(apply_v3(&conn, &ctx, &set), Outcome::Applied);
        assert_eq!(mode_of(&media), "attached");
        let after = raw_entry(&conn, &e.id);
        assert!(after.updated_at > 1000);
        assert_eq!(sync_row(&conn, &e.id), (version + 1, "pending".to_string()));
        let rec = import_row(&conn, &v3_path(&set)).unwrap();
        assert_eq!(rec.last_applied_updated_at, Some(after.updated_at));
        assert_eq!(rec.applied_from_updated_at, Some(1000));
        assert_eq!(apply_v3(&conn, &ctx, &set), Outcome::Applied, "reflected");
        assert_eq!(raw_entry(&conn, &e.id).updated_at, after.updated_at);

        let other = live_entry(&conn, &jid);
        let foreign = media_row(&conn, &other.id, "inline");
        let mismatch = v3_mode(&e.id, &foreign, Attached, Inline, after.updated_at);
        assert_eq!(
            apply_v3(&conn, &ctx, &mismatch),
            Outcome::Refused(MEDIA_ENTRY_MISMATCH.to_string())
        );
        assert_eq!(mode_of(&foreign), "inline");
        let missing = v3_mode(
            &e.id,
            "media-v3-missing-02",
            Attached,
            Inline,
            after.updated_at,
        );
        assert_eq!(
            apply_v3(&conn, &ctx, &missing),
            Outcome::Refused(ABSENT.to_string())
        );

        // The desktop sets it inline and edits the entry: a coalesced attached → inline
        // → attached draft from the stamp the web saw loses.
        update_media_insertion_mode_impl(&conn, &media, "inline").unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = updated_at + 100 WHERE id = ?1",
            [&e.id],
        )
        .unwrap();
        let stale = v3_mode(&e.id, &media, Attached, Attached, after.updated_at);
        assert_eq!(
            apply_v3(&conn, &ctx, &stale),
            Outcome::Refused(CHANGED_ON_DESKTOP.to_string())
        );
        assert_eq!(mode_of(&media), "inline");
    }

    /// Review round 4: the web toggles inline → attached (applied), then back to inline
    /// before the ack, keeping the first entry stamp and base mode. The coalesced draft
    /// (mode inline, base inline) matches neither the current mode nor its base, and
    /// applies only along the `i-` path's own edge.
    #[test]
    fn test_v3_coalesced_insertion_mode_toggle_chains_on_its_own_apply() {
        use MediaInsertionMode::{Attached, Inline};
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let media = media_row(&conn, &e.id, "inline");
        settle(&conn, &e.id);

        let rev1 = v3_mode(&e.id, &media, Attached, Inline, 1000);
        assert_eq!(apply_v3(&conn, &ctx, &rev1), Outcome::Applied);
        let rev2 = v3_mode(&e.id, &media, Inline, Inline, 1000);
        assert_eq!(apply_v3(&conn, &ctx, &rev2), Outcome::Applied, "chained");
        assert_eq!(
            get_media(&conn, &media).unwrap().unwrap().insertion_mode,
            "inline"
        );
    }

    const OCTET: &str = "application/octet-stream";
    const ATTACH_ID: &str = "media-attach-0001";

    fn v3_attach(
        entry_id: &str,
        media_id: &str,
        file_type: &str,
        file_name: &str,
        size: u64,
    ) -> OutboxIntentV3 {
        OutboxIntentV3::AttachMedia {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 17,
            entry_id: entry_id.to_string(),
            media_id: media_id.to_string(),
            file_name: file_name.to_string(),
            file_type: file_type.to_string(),
            size,
            has_thumb: false,
            duration_ms: file_type.starts_with("audio/").then_some(61_500),
            insertion_mode: MediaInsertionMode::Attached,
        }
    }

    fn v3_delete_media(entry_id: &str, media_id: &str) -> OutboxIntentV3 {
        OutboxIntentV3::DeleteMedia {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 17,
            entry_id: entry_id.to_string(),
            media_id: media_id.to_string(),
        }
    }

    /// `apply_v3` with the `m-<mediaId>` blob the cycle downloaded for an `attach_media`.
    fn attach_with(
        conn: &Connection,
        ctx: &ApplyContext,
        intent: &OutboxIntentV3,
        blob: AttachBlob,
    ) -> Outcome {
        apply_intent_v3(
            conn,
            ctx,
            &v3_path(intent),
            V2_HASH,
            Some(V2_REV.to_string()),
            intent,
            blob,
        )
    }

    /// `attach_media` stores audio under its MIME's extension and a generic file under
    /// its sanitised display name's extension (`[a-z0-9]{1,8}`, else `bin`) as
    /// `application/octet-stream`, attached, with its duration. The entry stamp advances
    /// and the entry is pending (peers pull the row); the ack carries the stamp read
    /// after every write, and the edge lets a later edit from the pre-attach base chain.
    /// A replay finds the row: applied, no write, no blob needed.
    #[test]
    fn test_v3_attach_media_stores_audio_and_files() {
        // (file_type, file_name, storage ext, duration, display name; `None`: the
        // sanitised name is not a safe peer cache name, so the row keeps `<id>.<ext>`).
        let cases = [
            (
                "audio/mp4",
                "voice memo.m4a",
                "m4a",
                Some(61.5),
                Some("voice memo.m4a"),
            ),
            ("audio/mpeg", "song", "mp3", Some(61.5), Some("song")),
            ("audio/wav", "take.txt", "wav", Some(61.5), Some("take.txt")),
            (OCTET, "Report.PDF", "pdf", None, Some("Report.PDF")),
            (OCTET, "backup.tar.gz", "gz", None, Some("backup.tar.gz")),
            (OCTET, "notes", "bin", None, Some("notes")),
            (OCTET, "...", "bin", None, Some("file.bin")),
            (OCTET, ".hidden.pdf", "pdf", None, Some("hidden.pdf")),
            (OCTET, "data.verylongx", "bin", None, Some("data.verylongx")),
            (
                OCTET,
                "caf\u{e9}.d\u{e9}j\u{e0}",
                "bin",
                None,
                Some("caf\u{e9}.d\u{e9}j\u{e0}"),
            ),
            (OCTET, "a..b.pdf", "pdf", None, None),
        ];
        for (file_type, file_name, ext, duration, display) in cases {
            let conn = setup_test_db();
            let (dir, ctx) = v2_ctx();
            let jid = default_journal_id(&conn);
            let e = located_entry(&conn, &jid, None);
            let (version, _) = sync_row(&conn, &e.id);
            let bytes = format!("blob of {file_name}").into_bytes();
            let attach = v3_attach(&e.id, ATTACH_ID, file_type, file_name, bytes.len() as u64);

            assert_eq!(
                attach_with(&conn, &ctx, &attach, AttachBlob::Opened(&bytes)),
                Outcome::Applied,
                "{file_name}"
            );
            let row = get_media(&conn, ATTACH_ID).unwrap().unwrap();
            assert_eq!(row.entry_id, e.id);
            assert_eq!(row.file_type, file_type, "{file_name}");
            let fallback = format!("{ATTACH_ID}.{ext}");
            assert_eq!(row.file_name, display.unwrap_or(&fallback), "{file_name}");
            assert_eq!(row.insertion_mode, "attached");
            assert_eq!(row.duration_seconds, duration, "{file_name}");
            assert_eq!(
                Path::new(&row.storage_path),
                dir.path().join(format!("{ATTACH_ID}.{ext}"))
            );
            assert_eq!(std::fs::read(&row.storage_path).unwrap(), bytes);
            let stamp = raw_entry(&conn, &e.id).updated_at;
            assert!(stamp > 1000, "{file_name}");
            assert_eq!(sync_row(&conn, &e.id), (version + 1, "pending".to_string()));
            let rec = import_row(&conn, &v3_path(&attach)).unwrap();
            assert_eq!(rec.last_applied_updated_at, Some(stamp));
            assert_eq!(rec.applied_from_updated_at, Some(1000));

            // The web's next edit still holds the pre-attach stamp: it chains on the edge.
            let moved = v3_location(
                &e.id,
                Some(place(None, None, "Web")),
                Some(place(None, None, "Seen before")),
                1000,
            );
            assert_eq!(
                apply_v3(&conn, &ctx, &moved),
                Outcome::Applied,
                "{file_name}"
            );

            let stamp = raw_entry(&conn, &e.id).updated_at;
            assert_eq!(
                attach_with(&conn, &ctx, &attach, AttachBlob::NotRead),
                Outcome::Applied,
                "{file_name} replay"
            );
            assert_eq!(raw_entry(&conn, &e.id).updated_at, stamp);
            assert_eq!(
                import_row(&conn, &v3_path(&attach))
                    .unwrap()
                    .last_applied_updated_at,
                Some(stamp)
            );
        }
    }

    /// `attach_media` refusals write nothing (no row, no file, no stamp): a file whose
    /// extension the desktop picker treats as image / video / audio is
    /// `media_not_allowed`, a blob that is not `size` bytes is `invalid`, a media id held
    /// by another entry is `media_entry_mismatch`; a blob not downloaded yet waits,
    /// unrecorded.
    #[test]
    fn test_v3_attach_media_refusals_write_nothing() {
        let conn = setup_test_db();
        let (dir, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let other = live_entry(&conn, &jid);
        let foreign = media_row(&conn, &other.id, "inline");
        settle(&conn, &e.id);
        let bytes = b"0123456789".to_vec();
        let size = bytes.len() as u64;
        let not_allowed = Outcome::Refused("media_not_allowed".to_string());

        let cases: Vec<(OutboxIntentV3, AttachBlob, Outcome)> = vec![
            (
                v3_attach(&e.id, ATTACH_ID, OCTET, "photo.JPG", size),
                AttachBlob::Opened(&bytes),
                not_allowed.clone(),
            ),
            (
                v3_attach(&e.id, ATTACH_ID, OCTET, "clip.mov", size),
                AttachBlob::Opened(&bytes),
                not_allowed.clone(),
            ),
            (
                v3_attach(&e.id, ATTACH_ID, OCTET, "take.wav", size),
                AttachBlob::Opened(&bytes),
                not_allowed.clone(),
            ),
            (
                v3_attach(&e.id, ATTACH_ID, OCTET, "logo.svg", size),
                AttachBlob::Opened(&bytes),
                not_allowed,
            ),
            (
                v3_attach(&e.id, ATTACH_ID, OCTET, "a.pdf", size + 1),
                AttachBlob::Opened(&bytes),
                Outcome::Refused(INVALID.to_string()),
            ),
            (
                v3_attach(&e.id, ATTACH_ID, "audio/mpeg", "a.mp3", size - 1),
                AttachBlob::Opened(&bytes),
                Outcome::Refused(INVALID.to_string()),
            ),
            (
                v3_attach(&e.id, &foreign, OCTET, "a.pdf", size),
                AttachBlob::Opened(&bytes),
                Outcome::Refused(MEDIA_ENTRY_MISMATCH.to_string()),
            ),
            (
                v3_attach(&e.id, "media-attach-wait", OCTET, "a.pdf", size),
                AttachBlob::NotRead,
                Outcome::Transient,
            ),
        ];
        for (intent, blob, expected) in cases {
            let label = format!("{intent:?}");
            assert_eq!(attach_with(&conn, &ctx, &intent, blob), expected, "{label}");
            if expected == Outcome::Transient {
                assert!(import_row(&conn, &v3_path(&intent)).is_none(), "{label}");
            } else {
                let rec = import_row(&conn, &v3_path(&intent)).unwrap();
                assert_eq!(rec.last_applied_updated_at, None, "{label}");
            }
            assert!(get_media(&conn, ATTACH_ID).unwrap().is_none(), "{label}");
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "{label}");
            assert_eq!(raw_entry(&conn, &e.id).updated_at, 1000, "{label}");
        }
        let kept = get_media(&conn, &foreign).unwrap().unwrap();
        assert_eq!(kept.entry_id, other.id);
    }

    /// `delete_media`: the row is tombstoned and dropped, its file unlinked, the entry
    /// stamp advanced and pending (peers drop it too); the ack carries the stamp read
    /// after. A replay (row gone) is applied without a write; a media id of another
    /// entry is `media_entry_mismatch` and survives with its file.
    #[test]
    fn test_v3_delete_media_tombstones_unlinks_and_republishes() {
        let conn = setup_test_db();
        let (dir, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let other = live_entry(&conn, &jid);
        let file_media = |entry_id: &str, name: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, b"pdf").unwrap();
            let id = db::create_media(
                &conn,
                db::CreateMediaParams {
                    entry_id,
                    file_name: name,
                    file_type: OCTET,
                    storage_path: path.to_str().unwrap(),
                    file_size: Some(3),
                    sort_order: 0,
                    insertion_mode: "attached",
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap()
            .id;
            (id, path)
        };
        let (media, path) = file_media(&e.id, "mine.pdf");
        let (foreign, foreign_path) = file_media(&other.id, "theirs.pdf");
        settle(&conn, &e.id);
        let (version, _) = sync_row(&conn, &e.id);

        let del = v3_delete_media(&e.id, &media);
        assert_eq!(apply_v3(&conn, &ctx, &del), Outcome::Applied);
        assert!(get_media(&conn, &media).unwrap().is_none());
        assert!(!path.exists());
        let tombstones = db::queries::list_media_tombstones_for_entry(&conn, &e.id).unwrap();
        assert_eq!(
            tombstones.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            [media.as_str()]
        );
        let stamp = raw_entry(&conn, &e.id).updated_at;
        assert!(stamp > 1000);
        assert_eq!(sync_row(&conn, &e.id), (version + 1, "pending".to_string()));
        let rec = import_row(&conn, &v3_path(&del)).unwrap();
        assert_eq!(rec.last_applied_updated_at, Some(stamp));
        assert_eq!(rec.applied_from_updated_at, Some(1000));

        assert_eq!(apply_v3(&conn, &ctx, &del), Outcome::Applied, "replay");
        assert_eq!(raw_entry(&conn, &e.id).updated_at, stamp);
        assert_eq!(
            import_row(&conn, &v3_path(&del))
                .unwrap()
                .last_applied_updated_at,
            Some(stamp)
        );

        let mismatch = v3_delete_media(&e.id, &foreign);
        assert_eq!(
            apply_v3(&conn, &ctx, &mismatch),
            Outcome::Refused(MEDIA_ENTRY_MISMATCH.to_string())
        );
        assert!(get_media(&conn, &foreign).unwrap().is_some());
        assert!(foreign_path.exists());
        assert_eq!(raw_entry(&conn, &e.id).updated_at, stamp);
    }

    /// The cycle downloads an `attach_media` blob from the intent's OWN folder (the
    /// body's `web_device_id` is attacker text and names another device here). Until the
    /// blob is there the intent waits: nothing recorded, no ack; then it applies and acks
    /// the entry stamp.
    #[tokio::test]
    async fn test_cycle_attach_media_reads_the_blob_from_the_intents_own_folder() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let bytes = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        let mut attach = v3_attach(
            &e.id,
            ATTACH_ID,
            "audio/wav",
            "take.wav",
            bytes.len() as u64,
        );
        if let OutboxIntentV3::AttachMedia { web_device_id, .. } = &mut attach {
            *web_device_id = V2_WEB_B.to_string();
        }
        let path = format!("{V2_WEB_A}/outbox/{}", attach.file_name());
        let sealed =
            memlore_core::outbox::seal_outbox_intent_v3(&test_key_list(), &attach).unwrap();
        write_raw(&provider, &path, &sealed).await;
        let sink = TestOutboxSink::default();

        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_transient, 1, "{res:?}");
        assert!(import_row(&conn, &path).is_none());
        assert!(get_media(&conn, ATTACH_ID).unwrap().is_none());
        assert_eq!(raw_entry(&conn, &e.id).updated_at, 1000);

        let blob = memlore_core::envelope::seal_media(&test_key_list(), &bytes).unwrap();
        write_raw(
            &provider,
            &format!("{V2_WEB_A}/outbox/m-{ATTACH_ID}"),
            &blob,
        )
        .await;
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 1, "{res:?}");
        assert_eq!(res.media_downloaded, 1, "{res:?}");
        let row = get_media(&conn, ATTACH_ID).unwrap().unwrap();
        assert_eq!(std::fs::read(&row.storage_path).unwrap(), bytes);
        let stamp = raw_entry(&conn, &e.id).updated_at;
        assert!(stamp > 1000);
        let ack = own_ack(&provider, &path).await;
        assert_eq!(ack.applied_updated_at, Some(stamp));
        assert_eq!(ack.refused_reason, None);
    }

    /// A file attached on the web shows the display name a desktop attach of the same
    /// file shows (`media.file_name`, what the attachment strip and viewer render).
    #[test]
    fn test_v3_attach_media_display_name_matches_a_desktop_attach() {
        let conn = setup_test_db();
        let (dir, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let bytes = b"%PDF-1.7".to_vec();
        for (i, name) in ["Report.PDF", ".bashrc.txt", "Ghi \u{e2}m (1).docx"]
            .into_iter()
            .enumerate()
        {
            let media_id = format!("media-attach-name-{i}");
            let attach = v3_attach(&e.id, &media_id, OCTET, name, bytes.len() as u64);
            assert_eq!(
                attach_with(&conn, &ctx, &attach, AttachBlob::Opened(&bytes)),
                Outcome::Applied
            );
            let desktop = crate::commands::media::save_attached_file_to_media_dir(
                &conn,
                dir.path(),
                &e.id,
                &crate::commands::media::sanitize_attachment_filename(name),
                &bytes,
            )
            .unwrap();
            let web_row = get_media(&conn, &media_id).unwrap().unwrap();
            let desktop_row = get_media(&conn, &desktop.media_id).unwrap().unwrap();
            assert_eq!(web_row.file_name, desktop_row.file_name, "{name}");
            assert_eq!(web_row.file_type, desktop_row.file_type, "{name}");
        }
    }

    /// Review 8.5: a media id this desktop holds a tombstone for (deleted here, or on a
    /// peer and pulled) is never re-created by a later import of the same `a-` file:
    /// final `media_deleted`, no row, no file, no download, the ack carries the reason.
    #[tokio::test]
    async fn test_cycle_attach_media_never_resurrects_a_deleted_media() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        db::queries::upsert_media_tombstone(&conn, ATTACH_ID, &e.id, 999).unwrap();
        let bytes = b"%PDF-1.7".to_vec();
        let attach = v3_attach(&e.id, ATTACH_ID, OCTET, "a.pdf", bytes.len() as u64);
        let path = write_v3(&provider, &attach).await;
        let blob = memlore_core::envelope::seal_media(&test_key_list(), &bytes).unwrap();
        write_raw(
            &provider,
            &format!("{V2_WEB_A}/outbox/m-{ATTACH_ID}"),
            &blob,
        )
        .await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_refused, 1, "{res:?}");
        assert_eq!(res.media_downloaded, 0, "{res:?}");
        assert!(get_media(&conn, ATTACH_ID).unwrap().is_none());
        assert_eq!(std::fs::read_dir(&media_dir).unwrap().count(), 0);
        assert_eq!(raw_entry(&conn, &e.id).updated_at, 1000);
        assert_eq!(import_row(&conn, &path).unwrap().outcome, "refused");
        let ack = own_ack(&provider, &path).await;
        assert_eq!(ack.refused_reason.as_deref(), Some("media_deleted"));
        assert_eq!(ack.applied_updated_at, None);
    }

    /// An `m-` blob that does not decrypt is final: `invalid`, recorded and acked, never
    /// re-read every cycle; nothing is stored. (A missing blob waits instead.)
    #[tokio::test]
    async fn test_cycle_attach_media_undecryptable_blob_is_refused_invalid() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = located_entry(&conn, &jid, None);
        let garbled = b"not a sealed media blob".to_vec();
        let attach = v3_attach(&e.id, ATTACH_ID, OCTET, "a.pdf", garbled.len() as u64);
        let path = write_v3(&provider, &attach).await;
        write_raw(
            &provider,
            &format!("{V2_WEB_A}/outbox/m-{ATTACH_ID}"),
            &garbled,
        )
        .await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_refused, 1, "{res:?}");
        assert_eq!(res.intents_transient, 0, "{res:?}");
        assert_eq!(res.media_downloaded, 0, "{res:?}");
        assert!(get_media(&conn, ATTACH_ID).unwrap().is_none());
        assert_eq!(std::fs::read_dir(&media_dir).unwrap().count(), 0);
        assert_eq!(raw_entry(&conn, &e.id).updated_at, 1000);
        assert_eq!(import_row(&conn, &path).unwrap().outcome, "refused");
        let ack = own_ack(&provider, &path).await;
        assert_eq!(ack.refused_reason.as_deref(), Some(INVALID));
        assert_eq!(ack.applied_updated_at, None);
    }

    /// The v1 media list never re-creates a tombstoned media id either; the rest of the
    /// intent applies, and media that was never deleted is stored as before.
    #[test]
    fn test_v1_media_list_skips_tombstoned_media() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let (_d, ctx) = v2_ctx();
        let local = live_entry(&conn, &jid);
        db::queries::upsert_media_tombstone(&conn, "media-v1-deleted1", &local.id, 999).unwrap();
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        for mid in ["media-v1-deleted1", "media-v1-kept0001"] {
            intent.entry.media.push(OutboxMediaRef {
                media_id: mid.to_string(),
                file_name: "photo.jpg".to_string(),
                file_type: "image/jpeg".to_string(),
                size: 4,
                has_thumb: false,
            });
            intent
                .media_payloads
                .insert(mid.to_string(), Some(vec![1, 2, 3, 4]));
        }
        let (outcome, _) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert!(get_media(&conn, "media-v1-deleted1").unwrap().is_none());
        assert!(!ctx.media_dir.join("media-v1-deleted1.jpg").exists());
        assert!(get_media(&conn, "media-v1-kept0001").unwrap().is_some());
    }

    /// `delete_memory_item` (rank 80, `y-<memoryId>`): missing is `absent`; a tombstone
    /// replays applied with its stamp; a desktop change since the base wins; else the item
    /// is tombstoned (memory.bin republishes it by LWW) and the ack carries the stamp
    /// read after.
    #[test]
    fn test_v3_delete_memory_item_rules() {
        use db::memory::{get_memory_item, insert_memory_item};
        const ID: &str = "memory-v3-item-0001";
        type Seed = fn(&Connection);
        let cases: [(&str, Seed, Outcome, bool); 4] = [
            (
                "missing",
                |_| {},
                Outcome::Refused("absent".to_string()),
                false,
            ),
            (
                "already deleted",
                |c| db::memory::tombstone_memory_item(c, ID, 1000).unwrap(),
                Outcome::Applied,
                true,
            ),
            (
                "changed on desktop",
                |c| db::memory::set_memory_enabled(c, ID, false, 2000).unwrap(),
                Outcome::Refused("changed_on_desktop".to_string()),
                false,
            ),
            ("applied", |_| {}, Outcome::Applied, true),
        ];
        for (label, seed, expected, deleted) in cases {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            if label != "missing" {
                insert_memory_item(&conn, ID, "Likes tea", "journal_entry", 1000).unwrap();
            }
            seed(&conn);
            let intent = OutboxIntentV3::DeleteMemoryItem {
                web_device_id: V2_WEB_A.to_string(),
                web_updated_at_secs: 5,
                memory_id: ID.to_string(),
                base_updated_at: 1000,
            };
            assert_eq!(v3_path(&intent), format!("{V2_WEB_A}/outbox/y-{ID}.bin"));
            assert_eq!(apply_v3(&conn, &ctx, &intent), expected, "{label}");
            let row = get_memory_item(&conn, ID).unwrap();
            assert_eq!(
                row.as_ref().is_some_and(|r| r.is_deleted),
                deleted,
                "{label}"
            );
            let rec = import_row(&conn, &v3_path(&intent)).unwrap();
            let acked = (expected == Outcome::Applied).then(|| row.unwrap().updated_at);
            assert_eq!(rec.last_applied_updated_at, acked, "{label}");
        }
    }

    /// `update_persona` (rank 80, `q-user-persona`): base vs `user_persona.updated_at`,
    /// chained on its own path; the text write (which always sets `user_edited`) runs
    /// only when the sanitised text differs; the ack carries the stamp read after both
    /// writes.
    #[test]
    fn test_v3_update_persona_rules() {
        use db::persona::{read_persona, write_persona_generated};
        const BASE: i64 = 1000;
        let refused = Outcome::Refused("changed_on_desktop".to_string());
        // (label, row stamp, revisions (traits, enabled, outcome), final (traits, enabled,
        // user_edited))
        type Rev = (&'static str, bool, Outcome);
        let cases: [(&str, i64, Vec<Rev>, (&str, bool, bool)); 4] = [
            (
                "text and enabled",
                BASE,
                vec![("New  traits ", false, Outcome::Applied)],
                ("New traits", false, true),
            ),
            (
                "enabled only",
                BASE,
                vec![(" Gen   traits", false, Outcome::Applied)],
                ("Gen traits", false, false),
            ),
            (
                "changed on desktop",
                2000,
                vec![("New traits", false, refused.clone())],
                ("Gen traits", true, false),
            ),
            (
                "two revisions on the first base",
                BASE,
                vec![
                    ("Rev 1", true, Outcome::Applied),
                    ("Rev 2", false, Outcome::Applied),
                ],
                ("Rev 2", false, true),
            ),
        ];
        for (label, stamp, revisions, (traits, enabled, user_edited)) in cases {
            let conn = setup_test_db();
            let (_d, ctx) = v2_ctx();
            write_persona_generated(&conn, "Gen traits", "Gen style", 1).unwrap();
            conn.execute(
                "UPDATE user_persona SET updated_at = ?1 WHERE id = 1",
                [stamp],
            )
            .unwrap();
            for (rev_traits, rev_enabled, expected) in revisions {
                let intent = OutboxIntentV3::UpdatePersona {
                    web_device_id: V2_WEB_A.to_string(),
                    web_updated_at_secs: 6,
                    traits_text: rev_traits.to_string(),
                    style_text: "Gen style".to_string(),
                    enabled: rev_enabled,
                    base_updated_at: BASE,
                };
                let path = v3_path(&intent);
                assert_eq!(path, format!("{V2_WEB_A}/outbox/q-user-persona.bin"));
                assert_eq!(apply_v3(&conn, &ctx, &intent), expected, "{label}");
                let rec = import_row(&conn, &path).unwrap();
                if expected == Outcome::Applied {
                    let after = read_persona(&conn).unwrap().updated_at;
                    assert_eq!(rec.last_applied_updated_at, Some(after), "{label}");
                    assert_eq!(rec.applied_from_updated_at, Some(BASE), "{label}");
                } else {
                    assert_eq!(rec.last_applied_updated_at, None, "{label}");
                }
            }
            let row = read_persona(&conn).unwrap();
            assert_eq!(
                (row.traits_text.as_str(), row.enabled, row.user_edited),
                (traits, enabled, user_edited),
                "{label}"
            );
            assert_eq!(row.style_text, "Gen style", "{label}");
        }
    }
}
