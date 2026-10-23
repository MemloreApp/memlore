use memlore_core::outbox::MAX_YJS_DOC_BYTES;
use rusqlite::{Connection, OptionalExtension};

use crate::ai::indexer::{EntryIndexer, AI_ENTRY_EMBED_MIN_CHARS};
use crate::db::queries::LockedView;
use crate::db::{self, CreateEntryParams, Entry};
use crate::AppState;

/// Debounce window (SECONDS) before a freshly-dirtied entry becomes
/// eligible for the Phase 2 background worker to claim. Rapid autosave
/// edits keep re-upserting the same job row via
/// `mark_entry_embedding_dirty`, pushing `next_attempt_at` forward each
/// time — only the LAST edit within this window actually gets embedded.
///
/// **Unit contract:** every consumer of `next_attempt_at` (`claim_due_
/// embedding_jobs`, the worker tick loops in `ai::indexer` /
/// `commands::ai`) compares against `Utc::now().timestamp()` — SECONDS,
/// not milliseconds. This constant and the `now` stamped alongside it
/// below MUST both be second-scale, or a dirty job's `next_attempt_at`
/// lands ~3.5 days in the future and is never claimed (C1 regression).
pub(crate) const AI_ENTRY_EMBED_DEBOUNCE_SECS: i64 = 300;

/// AI hook fired after every successful entry-mutating commit. When any
/// embedding-consuming feature is enabled (semantic search, emotion
/// suggestions, ask journal — see
/// [`crate::ops::ai_config::embedding_features_enabled`]) and the
/// entry's canonical text is non-trivial, marks the entry dirty in
/// `entry_embedding_jobs` so the Phase 2 background worker can embed it
/// later. This NEVER calls an embedding provider itself — the save path
/// must stay fast and must never block on a (possibly remote) embed call.
///
/// **Lock-scope contract:** this helper is invoked **outside** the
/// `EncryptionKeyState::with_key` closure AND after the caller has released
/// the `AppState` lock. It re-acquires the lock internally via
/// `AppState::with_conn` for a single short read+write. Errors are logged,
/// never bubbled — failing to queue a dirty job must NOT break the save
/// path.
pub(crate) fn maybe_mark_entry_embedding_dirty_after_save(
    state: &AppState,
    indexer: &EntryIndexer,
    entry_id: &str,
) {
    let model_id = indexer.model_id();
    let result = state.with_conn(|conn| {
        // No embedding provider configured → nothing to embed against, so
        // marking dirty here would queue stub-model jobs that never drain.
        // `embedding_features_enabled` now defaults ON once a provider is set
        // up (to match the Settings UI), so this provider-configured guard is
        // what keeps users who never opted into AI from accumulating jobs.
        if crate::ops::ai_config::slot_provider_class(
            conn,
            crate::ai::provider::settings_keys::embed::PROVIDER,
        )
        .ok()
        .flatten()
        .is_none()
        {
            return Ok(());
        }
        if !crate::ops::ai_config::embedding_features_enabled(conn) {
            return Ok(());
        }
        // Local dirty seeding: Pause+sync_backfill (modal) still queues;
        // Pause+all (absent field / old receipts) does not.
        let decision = crate::ai::embedding_decision::read_embed_sync_decision(
            conn,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
        )?;
        if !crate::ai::embedding_decision::auto_index_allowed(
            &decision,
            crate::ai::embedding_decision::AutoIndexScope::LocalDirty,
        ) {
            return Ok(());
        }
        let entry = match db::queries::get_entry_for_provider(conn, entry_id) {
            Ok(Some(e)) => e,
            Ok(None) => return Ok(()), // deleted / invisible before hook ran — fine
            Err(e) => return Err(format!("read entry {entry_id}: {e}")),
        };
        // Locked entries are write-eligible only when `ai_embed_include_protected`
        // is on — mirrors the `list_entries_needing_index` write-side gate so
        // the dirty queue never accumulates jobs the backfill query would
        // reject anyway. Invisible entries are already excluded unconditionally
        // by `get_entry_for_provider` above.
        if entry.is_locked {
            let include_protected = db::get_setting(
                conn,
                crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
            )
            .map_err(|e| e.to_string())?
            .map(|s| s == "true")
            .unwrap_or(false);
            if !include_protected {
                return Ok(());
            }
        }
        let text = crate::ai::indexer::build_indexable_text(
            entry.title.as_deref(),
            entry.content_text.as_deref(),
        );
        if text.chars().count() < AI_ENTRY_EMBED_MIN_CHARS {
            return Ok(());
        }
        let content_hash = crate::ai::chunking::content_hash(&text);
        let now = chrono::Utc::now().timestamp();
        let next_attempt_at = now + AI_ENTRY_EMBED_DEBOUNCE_SECS;
        db::embeddings::mark_entry_embedding_dirty(
            conn,
            entry_id,
            &model_id,
            &content_hash,
            next_attempt_at,
            now,
        )
        .map_err(|e| format!("mark_entry_embedding_dirty({entry_id}): {e}"))
    });
    if let Err(e) = result {
        log::warn!("ai: mark_entry_embedding_dirty('{entry_id}') failed: {e:?}");
    }
}

/// Phase 6 A5: auto-detect entry language on save. **First-detect-wins** —
/// only writes when the column is currently NULL. Manual overrides via
/// the language pill set the column directly and are therefore
/// preserved across subsequent saves.
///
/// **Sync coupling:** the auto-detected tag must reach the sync engine
/// even if the triggering save's `mark_entry_pending` was already
/// consumed by a push that landed between `commit()` and this hook.
/// We re-mark pending after any successful `set_entry_language` write
/// so a future push picks up the language column. Both writes run
/// inside a single transaction so a failure on either rolls back the
/// other — the "every committed change is pending" invariant holds.
///
/// Errors (DB read failures, column unexpectedly missing) are logged
/// and swallowed: a flaky language detection MUST NOT break the save
/// path. Same contract as `maybe_mark_entry_embedding_dirty_after_save`.
pub(crate) fn maybe_detect_language_after_save(conn: &Connection, entry_id: &str) {
    // Read the language column first to honour first-detect-wins
    // without paying the n-gram cost when the entry is already tagged.
    let current = match db::queries::get_entry_language(conn, entry_id) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("ai: get_entry_language('{entry_id}') failed: {e:?}");
            return;
        }
    };
    if current.is_some() {
        return; // already tagged (auto or manual) — leave untouched
    }
    // Read just the content_text column we need for detection.
    let entry = match db::queries::get_entry(conn, entry_id) {
        Ok(Some(e)) => e,
        Ok(None) => return, // entry deleted between save + hook — fine
        Err(e) => {
            log::warn!("ai: get_entry('{entry_id}') for language detect failed: {e:?}");
            return;
        }
    };
    let text = entry.content_text.as_deref().unwrap_or("");
    let Some(lang) = crate::utils::language_detect::detect_language(text) else {
        return;
    };

    // Wrap set_entry_language + mark_entry_pending in a single tx so
    // either both lands or neither — keeps the sync invariant intact
    // even under partial failure.
    let tx = match conn.unchecked_transaction() {
        Ok(t) => t,
        Err(e) => {
            log::warn!("ai: open tx for language detect '{entry_id}' failed: {e:?}");
            return;
        }
    };
    if let Err(e) = db::queries::set_entry_language(&tx, entry_id, Some(&lang)) {
        log::warn!("ai: set_entry_language('{entry_id}') failed: {e:?}");
        return; // tx rolls back on drop
    }
    if let Err(e) = db::mark_entry_pending(&tx, entry_id) {
        log::warn!("ai: mark_entry_pending('{entry_id}') after lang detect failed: {e:?}");
        return; // tx rolls back on drop
    }
    if let Err(e) = tx.commit() {
        log::warn!("ai: commit lang detect tx for '{entry_id}' failed: {e:?}");
    }
}

// ─── Row helper ──────────────────────────────────────────────────────────────
//
// Phase 3: All entry fields are stored as plaintext at the application layer.
// SQLCipher handles at-rest encryption at the database page level.
// `content_text` stays plaintext so FTS5 keeps working (documented trade-off;
// see docs/SPECIFICATION.md Phase 3).

/// Return an entry row as-is from the db layer. All fields are plaintext
/// post-Phase 3 — no decryption is applied. This replaces the old
/// `decrypt_entry` helper that unwrapped per-field AES-GCM ciphertext.
pub(crate) fn entry_row_from_db(entry: Entry) -> Result<Entry, String> {
    Ok(entry)
}

// ─── Impl helpers (tested directly; Tauri commands below delegate) ──────────
//
// Every mutating helper:
//   1. opens a transaction,
//   2. writes the entry,
//   3. marks the entry pending in `sync_state`,
//   4. commits.
//
// If step 3 fails, step 2 rolls back — the sync-state invariant (every
// committed entry mutation → pending sync_state row with `local_version`
// bumped) holds across all entry code paths even under partial failure.

pub(crate) fn create_entry_impl(
    conn: &Connection,
    journal_id: &str,
    title: Option<&str>,
    content_text: Option<&str>,
    preview_text: Option<&str>,
    entry_date: i64,
) -> Result<Entry, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Defensive: confirm the parent journal exists BEFORE attempting INSERT so
    // we can return a clean, typed error instead of the raw `FOREIGN KEY
    // constraint failed` from SQLite. The frontend caches the journal list in
    // a Zustand store; if it ever drifts from the DB (e.g. stale id captured
    // across an in-process DB swap during password-mode first-time setup), the
    // user would otherwise see an opaque FK error with no recovery path.
    let journal_exists: bool = tx
        .query_row("SELECT 1 FROM journals WHERE id = ?1", [journal_id], |_| {
            Ok(true)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);

    if !journal_exists {
        log::warn!(
            "create_entry_impl: journal_id {journal_id:?} does not exist; \
             frontend should refresh the journal list"
        );
        return Err(format!(
            "JOURNAL_NOT_FOUND: no journal with id {journal_id}"
        ));
    }

    let stored = db::create_entry(
        &tx,
        CreateEntryParams {
            journal_id,
            title,
            content_text,
            preview_text,
            entry_date,
        },
    )
    .map_err(|e| e.to_string())?;
    // Auto-apply every tag configured for this journal. Looked up inside
    // the same tx so the attachment shares the entry's atomicity guarantees
    // (rolls back together on failure). Tag rows referenced by the junction
    // table are guaranteed to exist — `journal_auto_tags(tag_id)` has
    // `ON DELETE CASCADE`, so a deleted tag is automatically dropped from
    // the set; `add_tag_to_entry`'s `INSERT OR IGNORE` is belt-and-braces.
    let auto_tag_ids = db::list_journal_auto_tag_ids(&tx, journal_id).map_err(|e| e.to_string())?;
    for tag_id in &auto_tag_ids {
        db::add_tag_to_entry(&tx, &stored.id, tag_id).map_err(|e| e.to_string())?;
    }
    db::mark_entry_pending(&tx, &stored.id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    entry_row_from_db(stored)
}

pub(crate) fn update_entry_impl(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    content_text: Option<&str>,
    preview_text: Option<&str>,
) -> Result<Entry, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let stored =
        db::update_entry(&tx, id, title, content_text, preview_text).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    // No eager cache invalidation here (unlike the old entry-level vector
    // cache): the chunk store keys each chunk by content_hash, and the
    // Phase 2 worker re-chunks from fresh text on the next dirty-job run,
    // reusing vectors for hashes that still match and pruning removed
    // chunks via `delete_chunks_not_in` — see `ai::chunking` module docs.
    // Eagerly wiping every chunk here would defeat that reuse. The
    // save-path hook (`maybe_mark_entry_embedding_dirty_after_save`)
    // queues the re-embed job separately, after this transaction commits.
    tx.commit().map_err(|e| e.to_string())?;
    entry_row_from_db(stored)
}

pub(crate) fn update_entry_location_impl(
    conn: &Connection,
    id: &str,
    latitude: Option<f64>,
    longitude: Option<f64>,
    location_label: Option<&str>,
    location_address: Option<&str>,
) -> Result<Entry, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let stored = db::update_entry_location(
        &tx,
        id,
        latitude,
        longitude,
        location_label,
        location_address,
    )
    .map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    entry_row_from_db(stored)
}

pub(crate) fn save_entry_content_impl(
    conn: &Connection,
    id: &str,
    yjs_doc: &[u8],
    content_text: &str,
    preview_text: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    db::save_entry_content(&tx, id, yjs_doc, content_text, preview_text)
        .map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The editor's save (the `save_entry_content` command only). Unlike
/// [`save_entry_content_impl`], which stays the replace primitive for
/// import, seed, MCP and outbox import, it merges into the stored doc: the
/// editor sends a full state serialized earlier, and an MCP append or a
/// web-edit merge that landed in between would otherwise be dropped.
///
/// One transaction. The incoming bytes and the frontend text are written
/// as sent (today's behaviour) when the stored doc is absent or adds
/// nothing to the incoming one, when the two docs are disjoint lineages
/// (a merge would double the body), when either does not decode, or when
/// the merge would pass [`MAX_YJS_DOC_BYTES`]. Otherwise the merged doc is
/// written, still a Yjs v1 update, with its text re-derived; if that text
/// cannot be read, the frontend text is kept.
pub(crate) fn save_entry_content_merged_impl(
    conn: &Connection,
    id: &str,
    yjs_doc: &[u8],
    content_text: &str,
    preview_text: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let stored = db::get_entry_content(&tx, id).map_err(|e| e.to_string())?;
    match merge_editor_save(id, stored.as_deref(), yjs_doc) {
        None => db::save_entry_content(&tx, id, yjs_doc, content_text, preview_text),
        Some(merged) => {
            let derived = crate::yjs_doc::extract_entry_text(&merged);
            let (text, preview) = derived
                .as_ref()
                .map_or((content_text, preview_text), |(t, p)| {
                    (t.as_str(), p.as_str())
                });
            db::save_entry_content(&tx, id, &merged, text, preview)
        }
    }
    .map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The merged doc to store for an editor save, or `None` to store the
/// incoming bytes as sent. Never fails: every doubt falls back to today's
/// overwrite.
fn merge_editor_save(id: &str, stored: Option<&[u8]>, incoming: &[u8]) -> Option<Vec<u8>> {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

    let stored = stored.filter(|b| !b.is_empty())?;
    let (Ok(stored_update), Ok(incoming_update)) =
        (Update::decode_v1(stored), Update::decode_v1(incoming))
    else {
        log::warn!("entries: save_entry_content('{id}'): a Yjs doc does not decode, overwriting");
        return None;
    };
    // The common autosave: the editor already holds everything stored.
    if update_contained_in(&stored_update, &incoming_update) {
        return None;
    }

    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    if txn.apply_update(incoming_update).is_err() {
        log::warn!("entries: save_entry_content('{id}'): incoming doc does not apply, overwriting");
        return None;
    }
    let before = txn.snapshot();
    let incoming_pending = txn.has_missing_updates();
    if txn.apply_update(stored_update).is_err() {
        log::warn!("entries: save_entry_content('{id}'): stored doc does not apply, overwriting");
        return None;
    }
    if !incoming_pending && !txn.has_missing_updates() && txn.snapshot() == before {
        return None;
    }
    match crate::sync::entry_sync::yjs_lineages_disjoint(stored, incoming) {
        Ok(false) => {}
        Ok(true) => {
            log::warn!(
                "entries: save_entry_content('{id}'): stored doc is another lineage, overwriting"
            );
            return None;
        }
        Err(e) => {
            log::warn!(
                "entries: save_entry_content('{id}'): lineage check failed ({e:?}), overwriting"
            );
            return None;
        }
    }
    let merged = txn.encode_state_as_update_v1(&StateVector::default());
    if merged.len() > MAX_YJS_DOC_BYTES {
        log::warn!(
            "entries: save_entry_content('{id}'): merged doc is {} bytes, over the cap, overwriting",
            merged.len()
        );
        return None;
    }
    Some(merged)
}

/// Whether every item and every deletion in `stored` is already in
/// `incoming`, read from the decoded updates without integrating them.
///
/// Inserted ids per client generalise "SV(stored) ⊆ SV(incoming)" to
/// updates with gaps. The delete sets must be compared too: a deletion
/// does not advance the state vector, so a state-vector-only gate would
/// take a stale doc as a superset and bring deleted text back. `false`
/// only means "inconclusive".
fn update_contained_in(stored: &yrs::Update, incoming: &yrs::Update) -> bool {
    let (want, have) = (stored.insertions(true), incoming.insertions(true));
    let inserts = stored.state_vector_lower().iter().all(|(client, _)| {
        match (want.get(client), have.get(client)) {
            (None, _) => true,
            (Some(w), Some(h)) => w.subset_of(h),
            (Some(_), None) => false,
        }
    });
    if !inserts {
        return false;
    }
    let mut want_ds = stored.delete_set().clone();
    let mut have_ds = incoming.delete_set().clone();
    want_ds.squash();
    have_ds.squash();
    want_ds
        .iter()
        .all(|(client, w)| have_ds.range(client).is_some_and(|h| w.subset_of(h)))
}

/// Move an entry to Trash (the `soft_delete_entry` command). One transaction:
/// trash stamp + pending mark + AI User Memory cleanup.
///
/// Memories go now, not at purge (user decision): `memory_item_sources` has
/// no FK to `entries` (intentional, see schema.rs), and a trashed entry must
/// stop feeding retrieval. A restore does not bring them back.
///
/// Media rows, files and the embedding index are deliberately KEPT so a
/// restore finds them; they go at purge time ([`purge_entry_impl`]).
pub(crate) fn soft_delete_entry_impl(conn: &Connection, id: &str) -> Result<(), String> {
    soft_delete_entry_at(conn, id, chrono::Utc::now().timestamp())
}

/// [`soft_delete_entry_impl`] with an explicit wall-clock `wall_now`.
///
/// The trash stamp is `max(wall_now, watermark - MAX_CLOCK_SKEW_SECS)`, the
/// watermark being the persisted sweep watermark
/// ([`TRASH_SWEEP_LAST_RUN_KEY`]) when there is one: a wall clock far behind
/// (dead RTC, VM restore) would otherwise stamp an entry that is already due
/// once the clock is corrected, and the next sweep would purge it
/// irreversibly. Only lengthens retention. With no watermark yet, it is
/// seeded at `wall_now`, so the sweep's clock guard bounds a later jump.
pub(crate) fn soft_delete_entry_at(
    conn: &Connection,
    id: &str,
    wall_now: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let watermark = db::get_setting(&tx, TRASH_SWEEP_LAST_RUN_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse::<i64>().ok());
    let now = match watermark {
        Some(w) => wall_now.max(w.saturating_sub(crate::sync::engine::MAX_CLOCK_SKEW_SECS)),
        None => {
            // Seed the watermark so a later clock correction cannot make
            // this trash immediately due.
            db::set_setting(&tx, TRASH_SWEEP_LAST_RUN_KEY, &wall_now.to_string())
                .map_err(|e| e.to_string())?;
            wall_now
        }
    };
    db::queries::trash_entry(&tx, id, now).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    db::memory::cleanup_memory_for_deleted_source(&tx, "journal_entry", id, now)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Bring an entry back from Trash and mark it pending. Errors when `id` is
/// not in Trash (live, purged, legacy tombstone or missing) or is not in the
/// Trash list this `locked_view` / `active_vault_id` shows (a locked entry
/// under `Hidden`, another vault's invisible entry). Unlike purge (see
/// [`purge_view`]), restore is allowed under `Covered`: it is
/// non-destructive, so acting on a redacted placeholder loses nothing.
pub(crate) fn restore_entry_impl(
    conn: &Connection,
    id: &str,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    require_in_visible_trash(&tx, id, locked_view, active_vault_id)?;
    let now = chrono::Utc::now().timestamp();
    db::queries::restore_entry(&tx, id, now).map_err(not_in_trash)?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The view purges may act under: a locked entry is purged only when its
/// content is `Revealed`. `Covered` lists it as a redacted placeholder, but
/// the user cannot see what they would destroy, so it purges like `Hidden`.
fn purge_view(locked_view: LockedView) -> LockedView {
    match locked_view {
        LockedView::Covered => LockedView::Hidden,
        other => other,
    }
}

/// Refuse `id` unless it is in the Trash list for this view. Missing and
/// out-of-view ids get the same error, so a caller cannot probe which
/// locked or invisible ids exist.
fn require_in_visible_trash(
    conn: &Connection,
    id: &str,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<(), String> {
    let visible =
        db::queries::list_trashed_entries_with_locked_view(conn, locked_view, active_vault_id)
            .map_err(|e| e.to_string())?
            .iter()
            .any(|e| e.id == id);
    if visible {
        Ok(())
    } else {
        Err(not_in_trash(rusqlite::Error::QueryReturnedNoRows))
    }
}

pub(crate) fn not_in_trash(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::QueryReturnedNoRows => "entry is not in Trash".to_string(),
        other => other.to_string(),
    }
}

/// Purge one trashed entry inside the caller's transaction: permanent
/// tombstone + pending mark + media rows / embedding index cascade + the
/// (idempotent) memory cleanup. Returns the media file paths to unlink once
/// the caller has committed.
fn purge_entry_in_tx(
    tx: &Connection,
    id: &str,
    now: i64,
) -> Result<Vec<(String, Option<String>)>, String> {
    // Mark first: it refuses anything not in Trash, so a live entry's media
    // is never touched.
    db::queries::purge_entry_mark(tx, id).map_err(not_in_trash)?;
    db::mark_entry_pending(tx, id).map_err(|e| e.to_string())?;
    // The media rows go in the same transaction as the tombstone: otherwise
    // they keep uploading (`list_pending_uploads` has no is_deleted filter)
    // and linger in the cloud forever. The cloud blobs are swept by the sync
    // engine's `reconcile_own_media_files` prune once these rows are gone.
    // The `media_count`/`cover_media_id` triggers fire on each row delete.
    let media = db::cascade_entry_content_delete(tx, id).map_err(|e| e.to_string())?;
    // Already ran at trash time; repeated here because a peer's memory.bin
    // can union-merge a source row back in the meantime.
    db::memory::cleanup_memory_for_deleted_source(tx, "journal_entry", id, now)
        .map_err(|e| e.to_string())?;
    Ok(media)
}

/// Best-effort disk cleanup, only after the DB change is durable, so a
/// rollback can never leave a live row pointing at a deleted file.
fn remove_purged_media_files(media: &[(String, Option<String>)]) {
    for (storage_path, thumbnail_path) in media {
        crate::ops::media::remove_media_files_best_effort(storage_path, thumbnail_path.as_deref());
    }
}

/// Permanently delete one trashed entry (the `delete_entry_forever`
/// command). Returns the media file paths it unlinked. Refuses an entry not
/// in this view's Trash, and a locked entry unless `Revealed` (see
/// [`purge_view`]).
pub(crate) fn purge_entry_impl(
    conn: &Connection,
    id: &str,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<Vec<(String, Option<String>)>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    require_in_visible_trash(&tx, id, purge_view(locked_view), active_vault_id)?;
    let now = chrono::Utc::now().timestamp();
    let media = purge_entry_in_tx(&tx, id, now)?;
    tx.commit().map_err(|e| e.to_string())?;
    remove_purged_media_files(&media);
    Ok(media)
}

pub(crate) fn list_trashed_entries_impl(
    conn: &Connection,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<Vec<Entry>, String> {
    let rows =
        db::queries::list_trashed_entries_with_locked_view(conn, locked_view, active_vault_id)
            .map_err(|e| e.to_string())?;
    rows.into_iter().map(entry_row_from_db).collect()
}

/// Purge the confirmed `ids` that the Trash screen shows readably for this
/// view — their intersection with the ids [`list_trashed_entries_impl`]
/// returns for the same `active_vault_id`, with `Covered` treated as `Hidden`
/// (see [`purge_view`]). So an entry trashed after the user confirmed is
/// never purged, only `Revealed` purges locked trashed entries, and another
/// vault's invisible entries are never touched; those still go via the 30-day
/// retention sweep. Unknown or out-of-view ids are skipped. One transaction;
/// returns how many were purged (0 when none is still in Trash, so a repeat
/// call is a no-op).
pub(crate) fn empty_trash_impl(
    conn: &Connection,
    ids: &[String],
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<usize, String> {
    let confirmed: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let ids: Vec<String> = db::queries::list_trashed_entries_with_locked_view(
        &tx,
        purge_view(locked_view),
        active_vault_id,
    )
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|e| e.id)
    .filter(|id| confirmed.contains(id.as_str()))
    .collect();
    let now = chrono::Utc::now().timestamp();
    let mut media = Vec::new();
    for id in &ids {
        media.extend(purge_entry_in_tx(&tx, id, now)?);
    }
    tx.commit().map_err(|e| e.to_string())?;
    remove_purged_media_files(&media);
    Ok(ids.len())
}

/// How long an entry stays in Trash before the retention sweep purges it.
pub(crate) const TRASH_RETENTION_SECS: i64 = 30 * 86_400;

/// Settings key of the sweep watermark (unix seconds; see
/// [`purge_expired_trash`]). Device-local: not in `SYNCABLE_SETTING_KEYS`.
pub(crate) const TRASH_SWEEP_LAST_RUN_KEY: &str = "trash_sweep_last_run";

/// How far past the session base one app launch may move the sweep clock,
/// on top of the real (monotonic) time elapsed since its first sweep.
pub(crate) const TRASH_SWEEP_MAX_ADVANCE_SECS: i64 = 86_400;

/// Process-lifetime anchor of the sweep clock, captured at the first sweep
/// of the process: `base` is the persisted watermark then (or `now` on the
/// very first sweep ever) and `started` the [`monotonic_secs_with_sleep`]
/// reading it was taken at.
///
/// Within one process the base comes from the first DB swept: a vault reset
/// in-process keeps the old base, which errs safe (a newer base only lets
/// retention advance further).
pub(crate) struct SweepSession {
    started: Option<u64>,
    base: i64,
}

/// Seconds on a monotonic clock that keeps counting while the machine
/// sleeps and that a wall-clock change cannot move: `CLOCK_MONOTONIC` on
/// Apple platforms (it includes sleep there), `CLOCK_BOOTTIME` on Linux and
/// Android. `std::time::Instant` would stop during sleep on both, so
/// retention would lag real time when the app stays open across sleeps.
/// `None` when the clock cannot be read; the sweep then counts no elapsed
/// time (errs safe).
#[cfg(unix)]
fn monotonic_secs_with_sleep() -> Option<u64> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const CLOCK: libc::clockid_t = libc::CLOCK_BOOTTIME;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const CLOCK: libc::clockid_t = libc::CLOCK_MONOTONIC;
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `ts` is a valid, writable `timespec` for the duration of the call.
    let rc = unsafe { libc::clock_gettime(CLOCK, &mut ts) };
    if rc != 0 {
        return None;
    }
    u64::try_from(ts.tv_sec).ok()
}

/// Windows: `Instant` (QueryPerformanceCounter) already counts sleep.
#[cfg(not(unix))]
fn monotonic_secs_with_sleep() -> Option<u64> {
    static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    ORIGIN
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
        .into()
}

/// The production sweep session, shared by the unlock and post-pull sweeps.
#[cfg(not(any(test, feature = "test-support")))]
static SWEEP_SESSION: std::sync::Mutex<Option<SweepSession>> = std::sync::Mutex::new(None);

/// The 30-day retention sweep: purge every entry trashed at or before
/// `sweep_at - TRASH_RETENTION_SECS` (unix seconds), regardless of lock or
/// vault visibility. One transaction; files are unlinked after commit.
/// Returns how many were purged (0 when nothing is due, so a repeat call is
/// a no-op). Re-arms the own-cloud media prune when anything was purged.
///
/// Clock guard: `sweep_at = min(now, base + TRASH_SWEEP_MAX_ADVANCE_SECS +
/// elapsed)`, where `base` is the persisted watermark
/// ([`TRASH_SWEEP_LAST_RUN_KEY`]) at the process's first sweep and `elapsed`
/// the time since then including sleep, from a monotonic clock that a
/// wall-clock change cannot move ([`monotonic_secs_with_sleep`]), so
/// however often the sweep runs (after every clean pull), one app launch
/// advances retention at most 1 day past the last persisted watermark plus
/// real elapsed time; a long real gap is caught up at most a day per launch.
/// With no persisted watermark (first sweep ever) the run only seeds it at
/// `now` and purges nothing. The watermark becomes `max(watermark,
/// sweep_at)` (never lowered, so a clock stepping back never sweeps ahead of
/// itself) and is written in the sweep's transaction.
pub(crate) fn purge_expired_trash(conn: &Connection, now: i64) -> Result<usize, String> {
    #[cfg(not(any(test, feature = "test-support")))]
    let mut session = SWEEP_SESSION.lock().unwrap_or_else(|e| e.into_inner());
    // Tests get a fresh session per call (each one a new "launch"): a
    // process-wide base would couple unrelated tests through their clocks.
    #[cfg(any(test, feature = "test-support"))]
    let mut session: Option<SweepSession> = None;
    purge_expired_trash_in_session(conn, now, &mut session, |s| {
        match (monotonic_secs_with_sleep(), s.started) {
            (Some(now), Some(started)) => now.saturating_sub(started),
            _ => 0,
        }
    })
}

/// [`purge_expired_trash`] against an explicit session; `elapsed` returns
/// the seconds elapsed since the session started.
pub(crate) fn purge_expired_trash_in_session(
    conn: &Connection,
    now: i64,
    session: &mut Option<SweepSession>,
    elapsed: impl Fn(&SweepSession) -> u64,
) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let persisted = db::get_setting(&tx, TRASH_SWEEP_LAST_RUN_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|v| match v.parse::<i64>() {
            Ok(t) => Some(t),
            Err(_) => {
                log::warn!("trash: unparseable sweep watermark {v:?}; reseeding at {now}");
                None
            }
        });
    let Some(last_run) = persisted else {
        db::set_setting(&tx, TRASH_SWEEP_LAST_RUN_KEY, &now.to_string())
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        session.get_or_insert(SweepSession {
            started: monotonic_secs_with_sleep(),
            base: now,
        });
        return Ok(0);
    };
    let s = session.get_or_insert(SweepSession {
        started: monotonic_secs_with_sleep(),
        base: last_run,
    });
    let elapsed = i64::try_from(elapsed(s)).unwrap_or(i64::MAX);
    let bound = s
        .base
        .saturating_add(TRASH_SWEEP_MAX_ADVANCE_SECS)
        .saturating_add(elapsed);
    let sweep_at = now.min(bound);
    if sweep_at < now {
        log::warn!(
            "trash: sweep clock capped at {sweep_at} (now {now}, session base {})",
            s.base
        );
    }
    db::set_setting(
        &tx,
        TRASH_SWEEP_LAST_RUN_KEY,
        &last_run.max(sweep_at).to_string(),
    )
    .map_err(|e| e.to_string())?;
    let ids = db::queries::list_trash_due(&tx, sweep_at - TRASH_RETENTION_SECS)
        .map_err(|e| e.to_string())?;
    let mut media = Vec::new();
    for id in &ids {
        media.extend(purge_entry_in_tx(&tx, id, sweep_at)?);
    }
    tx.commit().map_err(|e| e.to_string())?;
    remove_purged_media_files(&media);
    if !ids.is_empty() {
        crate::sync::engine::reset_session_own_cloud_reconciled();
    }
    Ok(ids.len())
}

/// Unlock-time retention sweep. Runs only when no sync cycle will run
/// (no provider, or sync disabled — the scheduler's own gate); otherwise the
/// sweep waits for a successful pull so a peer's restore is seen first.
/// Failures are logged, never surfaced.
pub(crate) fn purge_expired_trash_on_unlock(conn: &Connection, now: i64) {
    let sync_active = db::get_sync_enabled(conn).unwrap_or(false)
        && db::get_sync_provider(conn).ok().flatten().is_some();
    if sync_active {
        return;
    }
    if let Err(e) = purge_expired_trash(conn, now) {
        log::warn!("trash: unlock retention sweep failed: {e}");
    }
}

pub(crate) fn update_entry_emotion_impl(
    conn: &Connection,
    id: &str,
    emotion: Option<&str>,
) -> Result<Entry, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let stored = db::update_entry_emotion(&tx, id, emotion).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    entry_row_from_db(stored)
}

pub(crate) fn toggle_favorite_impl(conn: &Connection, id: &str) -> Result<bool, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let new_value = db::toggle_favorite(&tx, id).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_value)
}

pub(crate) fn update_entry_date_impl(
    conn: &Connection,
    id: &str,
    entry_date: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    db::update_entry_date(&tx, id, entry_date).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn move_entry_to_journal_impl(
    conn: &Connection,
    id: &str,
    journal_id: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    db::move_entry_to_journal(&tx, id, journal_id).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn snapshot_entry_version_impl(
    conn: &Connection,
    entry_id: &str,
    yjs_doc: &[u8],
    preview_text: &str,
) -> Result<String, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, entry_id).map_err(|e| e.to_string())?;
    let device_id = db::get_or_create_device_id(&tx).map_err(|e| e.to_string())?;
    let version_id = db::insert_entry_version(&tx, entry_id, yjs_doc, preview_text, &device_id)
        .map_err(|e| e.to_string())?;
    let retention_days = db::get_version_retention_days(&tx).map_err(|e| e.to_string())?;
    // Pruned rows are DB-only here; the sync engine (Phase 2) reconciles
    // own-folder cloud files against the local prune state separately.
    db::prune_entry_versions(&tx, entry_id, retention_days, db::MAX_VERSIONS_PER_ENTRY)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(version_id)
}
