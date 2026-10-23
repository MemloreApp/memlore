use rusqlite::Connection;
use tauri::State;

use crate::ai::indexer::EntryIndexer;
use crate::db::queries::{EntrySort, EntryTimeRange, LockFilter, LockedView};
use crate::db::{self, Entry, PagedResult};
use crate::ops::entries::entry_row_from_db;
use crate::{AppState, EncryptionKeyState};

pub(crate) use crate::ops::entries::{
    create_entry_impl, empty_trash_impl, list_trashed_entries_impl,
    maybe_detect_language_after_save, maybe_mark_entry_embedding_dirty_after_save,
    move_entry_to_journal_impl, purge_entry_impl, purge_expired_trash_on_unlock,
    restore_entry_impl, save_entry_content_impl, save_entry_content_merged_impl,
    snapshot_entry_version_impl, soft_delete_entry_impl, toggle_favorite_impl,
    update_entry_date_impl, update_entry_emotion_impl, update_entry_impl,
    update_entry_location_impl,
};
#[cfg(test)]
pub(crate) use crate::ops::entries::{
    not_in_trash, purge_expired_trash_in_session, soft_delete_entry_at, SweepSession,
    AI_ENTRY_EMBED_DEBOUNCE_SECS, TRASH_RETENTION_SECS, TRASH_SWEEP_LAST_RUN_KEY,
    TRASH_SWEEP_MAX_ADVANCE_SECS,
};

pub(crate) fn update_entry_weather_impl(
    conn: &Connection,
    id: &str,
    weather_summary: Option<&str>,
    weather_icon: Option<&str>,
) -> Result<Entry, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let stored = db::update_entry_weather(&tx, id, weather_summary, weather_icon)
        .map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    entry_row_from_db(stored)
}

pub(crate) fn update_entry_language_impl(
    conn: &Connection,
    id: &str,
    language: Option<&str>,
) -> Result<Entry, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::queries::require_live_entry(&tx, id).map_err(|e| e.to_string())?;
    let stored = db::queries::set_entry_language(&tx, id, language).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(stored)
}

pub(crate) fn mark_entry_date_user_edited_impl(conn: &Connection, id: &str) -> Result<(), String> {
    db::queries::require_live_entry(conn, id).map_err(|e| e.to_string())?;
    db::mark_entry_date_user_edited(conn, id).map_err(|e| e.to_string())
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Create a new entry. Returns the created entry (with plaintext fields).
///
/// NOTE: `content_text` is stored **plaintext at rest** so the FTS5 virtual
/// table can index it. This is a deliberate, documented trade-off — see
/// `docs/SPECIFICATION.md` → "FTS5 trade-off". The regression test
/// `content_text_is_plaintext_at_rest` asserts this property; removing it
/// would silently change the zero-knowledge posture of the app.
#[tauri::command]
pub fn create_entry(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    indexer: State<'_, EntryIndexer>,
    journal_id: String,
    title: Option<String>,
    content_text: Option<String>,
    preview_text: Option<String>,
    entry_date: i64,
) -> Result<Entry, String> {
    let entry = key_state.with_key(|_key| {
        let conn = state.lock()?;
        create_entry_impl(
            &conn,
            &journal_id,
            title.as_deref(),
            content_text.as_deref(),
            preview_text.as_deref(),
            entry_date,
        )
    })?;
    // Hooks fire outside the encryption-key scope (see helper docstring).
    {
        let conn = state.lock()?;
        maybe_detect_language_after_save(&conn, &entry.id);
    }
    // Marking dirty re-locks internally for a single short read+write —
    // no embedding provider is ever called from the save path.
    maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);
    Ok(entry)
}

/// List non-deleted entries in a journal, ordered by entry_date DESC.
/// Return all entry_date timestamps (Unix seconds, DESC) for the given journal
/// scope. Passing `None` returns dates across all journals. Used by the
/// calendar heatmap — returns only timestamps, not full entry data, so it
/// stays cheap even at 10k+ entries.
#[tauri::command]
pub fn list_entry_dates(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    journal_id: Option<String>,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<Vec<i64>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        db::queries::list_entry_dates_with_locked_view(
            &conn,
            journal_id.as_deref(),
            locked_view,
            active_vault_id.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
}

/// Return non-deleted entries whose `entry_date` falls in `[from_ts, to_ts)`.
/// Used by the Calendar right-pane to list entries written on the selected day.
#[tauri::command]
pub fn list_entries_for_date_range(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    journal_id: Option<String>,
    from_ts: i64,
    to_ts: i64,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<Vec<Entry>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let rows = db::queries::list_entries_for_date_range_with_locked_view(
            &conn,
            journal_id.as_deref(),
            from_ts,
            to_ts,
            locked_view,
            active_vault_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        rows.into_iter().map(entry_row_from_db).collect()
    })
}

/// Apply `entry_row_from_db` to every item in a `PagedResult<Entry>`. Keeps
/// the paged commands in lockstep with the entry query commands so
/// any future row-level post-processing (e.g. selective decryption) added to
/// `entry_row_from_db` automatically applies to paged surfaces too.
fn map_paged_entries(paged: PagedResult<Entry>) -> Result<PagedResult<Entry>, String> {
    let items = paged
        .items
        .into_iter()
        .map(entry_row_from_db)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PagedResult {
        items,
        total: paged.total,
    })
}

/// Paginated list of non-deleted entries across all journals that carry the
/// given tag, with sort, time-range, and page parameters. `favorites_only`
/// additionally restricts to favorited entries (the "Starred" filter).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn list_entries_by_tag_paged(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    tag_id: String,
    journal_id: Option<String>,
    favorites_only: bool,
    sort: EntrySort,
    range: EntryTimeRange,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
    first_day_of_week: u8,
    page: u32,
    locked_view: LockedView,
    active_vault_id: Option<String>,
    lock_filter: LockFilter,
) -> Result<PagedResult<Entry>, String> {
    let custom_range = match (from_ts, to_ts) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let paged = db::queries::list_entries_by_tag_paged_with_locked_view(
            &conn,
            &tag_id,
            journal_id.as_deref(),
            favorites_only,
            sort,
            range,
            custom_range,
            first_day_of_week,
            page,
            locked_view,
            active_vault_id.as_deref(),
            lock_filter,
        )
        .map_err(|e| e.to_string())?;
        map_paged_entries(paged)
    })
}

/// Paginated list of non-deleted entries for a specific journal.
#[tauri::command]
pub fn list_entries_paged(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    journal_id: String,
    sort: EntrySort,
    range: EntryTimeRange,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
    first_day_of_week: u8,
    page: u32,
    locked_view: LockedView,
    active_vault_id: Option<String>,
    lock_filter: LockFilter,
) -> Result<PagedResult<Entry>, String> {
    let custom_range = match (from_ts, to_ts) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let paged = db::queries::list_entries_paged_with_locked_view(
            &conn,
            &journal_id,
            sort,
            range,
            custom_range,
            first_day_of_week,
            page,
            locked_view,
            active_vault_id.as_deref(),
            lock_filter,
        )
        .map_err(|e| e.to_string())?;
        map_paged_entries(paged)
    })
}

/// Paginated list of non-deleted entries across all journals.
#[tauri::command]
pub fn list_all_entries_paged(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    sort: EntrySort,
    range: EntryTimeRange,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
    first_day_of_week: u8,
    page: u32,
    locked_view: LockedView,
    active_vault_id: Option<String>,
    lock_filter: LockFilter,
) -> Result<PagedResult<Entry>, String> {
    let custom_range = match (from_ts, to_ts) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let paged = db::queries::list_all_entries_paged_with_locked_view(
            &conn,
            sort,
            range,
            custom_range,
            first_day_of_week,
            page,
            locked_view,
            active_vault_id.as_deref(),
            lock_filter,
        )
        .map_err(|e| e.to_string())?;
        map_paged_entries(paged)
    })
}

/// Paginated list of non-deleted favorite entries, optionally scoped to a journal.
/// When `journal_id` is `None`, returns favorites across all journals.
#[tauri::command]
pub fn list_favorite_entries_paged(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    journal_id: Option<String>,
    sort: EntrySort,
    range: EntryTimeRange,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
    first_day_of_week: u8,
    page: u32,
    locked_view: LockedView,
    active_vault_id: Option<String>,
    lock_filter: LockFilter,
) -> Result<PagedResult<Entry>, String> {
    let custom_range = match (from_ts, to_ts) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let paged = db::queries::list_favorite_entries_paged_with_locked_view(
            &conn,
            journal_id.as_deref(),
            sort,
            range,
            custom_range,
            first_day_of_week,
            page,
            locked_view,
            active_vault_id.as_deref(),
            lock_filter,
        )
        .map_err(|e| e.to_string())?;
        map_paged_entries(paged)
    })
}

/// Testable core of `list_on_this_day` — validates bounds, gates on unlock,
/// queries the db layer. The Tauri command is a thin wrapper that only exists
/// to satisfy the `State<'_, T>` extractor signature.
#[allow(dead_code)]
pub(crate) fn list_on_this_day_inner(
    state: &AppState,
    key_state: &EncryptionKeyState,
    month: u32,
    day: u32,
) -> Result<Vec<Entry>, String> {
    list_on_this_day_inner_with_locked_view(
        state,
        key_state,
        month,
        day,
        LockedView::Revealed,
        None,
    )
}

pub(crate) fn list_on_this_day_inner_with_locked_view(
    state: &AppState,
    key_state: &EncryptionKeyState,
    month: u32,
    day: u32,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<Vec<Entry>, String> {
    if !(1..=12).contains(&month) {
        return Err(format!("month must be 1..=12, got {month}"));
    }
    if !(1..=31).contains(&day) {
        return Err(format!("day must be 1..=31, got {day}"));
    }
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let rows = db::list_entries_by_month_day_with_locked_view(
            &conn,
            month,
            day,
            200,
            locked_view,
            active_vault_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        rows.into_iter().map(entry_row_from_db).collect()
    })
}

/// Return entries whose `entry_date` falls on `(month, day)` in any year,
/// across every journal, newest first. All fields are plaintext (Phase 3).
/// Requires the app to be unlocked.
#[tauri::command]
pub fn list_on_this_day(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    month: u32,
    day: u32,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<Vec<Entry>, String> {
    list_on_this_day_inner_with_locked_view(
        &state,
        &key_state,
        month,
        day,
        locked_view,
        active_vault_id.as_deref(),
    )
}

/// Count non-deleted entries in a journal. Doesn't touch encrypted fields.
#[tauri::command]
pub fn count_entries_in_journal(
    state: State<'_, AppState>,
    journal_id: String,
) -> Result<i64, String> {
    let conn = state.lock()?;
    db::count_entries_in_journal(&conn, &journal_id).map_err(|e| e.to_string())
}

/// Get a single entry by id. Returns None if not found.
#[tauri::command]
pub fn get_entry(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    active_vault_id: Option<String>,
) -> Result<Option<Entry>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        get_entry_impl(&conn, &id, active_vault_id.as_deref())
    })
}

pub(crate) fn get_entry_impl(
    conn: &Connection,
    id: &str,
    active_vault_id: Option<&str>,
) -> Result<Option<Entry>, String> {
    if !db::is_entry_visible_for_active_vault(conn, id, active_vault_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    match db::get_entry(conn, id).map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(entry) => entry_row_from_db(entry).map(Some),
    }
}

/// Update an entry's text fields. Returns the updated entry (with plaintext fields).
#[tauri::command]
pub fn update_entry(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    indexer: State<'_, EntryIndexer>,
    id: String,
    title: Option<String>,
    content_text: Option<String>,
    preview_text: Option<String>,
) -> Result<Entry, String> {
    let entry = key_state.with_key(|_key| {
        let conn = state.lock()?;
        update_entry_impl(
            &conn,
            &id,
            title.as_deref(),
            content_text.as_deref(),
            preview_text.as_deref(),
        )
    })?;
    {
        let conn = state.lock()?;
        maybe_detect_language_after_save(&conn, &entry.id);
    }
    maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);
    Ok(entry)
}

/// Move an entry to Trash (name kept for IPC compatibility). Its media stay
/// until it is purged. Requires the app to be unlocked — `key_state` is the
/// access-control gate (Phase 3: no per-field decryption, but the gate remains
/// so a locked device cannot mutate entries via IPC).
#[tauri::command]
pub fn soft_delete_entry(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
) -> Result<(), String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        soft_delete_entry_impl(&conn, &id)
    })
}

/// Entries in Trash, most recently trashed first, under the same
/// `locked_view` / `active_vault_id` rules as the other list commands — so a
/// locked trashed entry is listed (and restorable) while the lock is open.
#[tauri::command]
pub fn list_trashed_entries(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<Vec<Entry>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        list_trashed_entries_impl(&conn, locked_view, active_vault_id.as_deref())
    })
}

/// Restore an entry from Trash. Only an entry the Trash list shows for this
/// `locked_view` / `active_vault_id` can be restored.
#[tauri::command]
pub fn restore_entry(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<(), String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        restore_entry_impl(&conn, &id, locked_view, active_vault_id.as_deref())
    })
}

/// Permanently delete one entry that is in Trash and visible for this view;
/// a locked entry requires `Revealed` (see [`purge_entry_impl`]).
#[tauri::command]
pub fn delete_entry_forever(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<(), String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        purge_entry_impl(&conn, &id, locked_view, active_vault_id.as_deref())
    })?;
    // Re-arm the throttled own-cloud media prune so the next automatic sync
    // sweeps the purged entry's now-orphaned cloud media blobs.
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(())
}

/// Permanently delete the confirmed `ids` the Trash screen still shows
/// readably for this view (`Covered` purges like `Hidden`; see
/// [`empty_trash_impl`]). Returns how many entries were purged.
#[tauri::command]
pub fn empty_trash(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    ids: Vec<String>,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<usize, String> {
    let purged = key_state.with_key(|_key| {
        let conn = state.lock()?;
        empty_trash_impl(&conn, &ids, locked_view, active_vault_id.as_deref())
    })?;
    if purged > 0 {
        crate::sync::engine::reset_session_own_cloud_reconciled();
    }
    Ok(purged)
}

/// Set the emotion tag on an entry to one of `'good' | 'neutral' | 'bad'`,
/// or pass `None` to clear it. Emotion is not encrypted (needed for filter +
/// stats aggregation); the entry is marked pending so the change propagates
/// through sync.
#[tauri::command]
pub fn update_entry_emotion(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    emotion: Option<String>,
) -> Result<Entry, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        update_entry_emotion_impl(&conn, &id, emotion.as_deref())
    })
}

/// Manually set or clear the entry's `content_language` (Phase 6 A5).
///
/// Pass `Some("en")` / `Some("vi")` etc to override the auto-detected
/// language; pass `None` to clear the column, which causes the next
/// save to re-trigger the auto-detect hook. Bumps `updated_at` so
/// sync notices the change.
///
/// Validates the language tag against a permissive shape: 2-3
/// lowercase ASCII letters, optional `-REGION` suffix (e.g. `pt-BR`).
/// Rejects anything else to prevent the column from drifting into
/// arbitrary user-supplied strings.
#[tauri::command]
pub fn update_entry_language(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    language: Option<String>,
) -> Result<Entry, String> {
    if let Some(ref lang) = language {
        if !is_valid_language_tag(lang) {
            return Err(format!("invalid language tag: {lang:?}"));
        }
    }
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        update_entry_language_impl(&conn, &id, language.as_deref())
    })
}

/// Permissive language-tag validator. Accepts:
/// - 2-3 lowercase ASCII letters (e.g. `en`, `vi`, `nob`)
/// - 2-3 letters + `-` + 2-letter region (e.g. `pt-BR`, `zh-CN`)
///
/// Rejects empty strings, leading/trailing whitespace, anything
/// outside `[a-z]` for the language part, and non-ASCII region codes.
fn is_valid_language_tag(s: &str) -> bool {
    if s.is_empty() || s != s.trim() {
        return false;
    }
    let mut parts = s.split('-');
    let lang = match parts.next() {
        Some(l) => l,
        None => return false,
    };
    if !(2..=3).contains(&lang.len()) || !lang.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    match parts.next() {
        None => parts.next().is_none(),
        Some(region) => {
            // At most one suffix segment, and it must be 2-letter
            // uppercase ASCII (no scripts / variants for v1).
            parts.next().is_none()
                && region.len() == 2
                && region.chars().all(|c| c.is_ascii_uppercase())
        }
    }
}

/// Validate GPS coordinates: must be finite and within valid ranges.
fn validate_coords(lat: f64, lon: f64) -> Result<(), String> {
    if !lat.is_finite() || !lon.is_finite() {
        return Err("Invalid coordinates: values must be finite numbers".to_string());
    }
    if !(-90.0..=90.0).contains(&lat) {
        return Err(format!(
            "Latitude {lat} out of range: must be between -90 and 90"
        ));
    }
    if !(-180.0..=180.0).contains(&lon) {
        return Err(format!(
            "Longitude {lon} out of range: must be between -180 and 180"
        ));
    }
    Ok(())
}

/// Update the location fields for an entry. All fields are stored as plaintext
/// (Phase 3 — SQLCipher handles at-rest encryption). `latitude`/`longitude`
/// are also needed for the map view unmodified.
#[tauri::command]
pub fn update_entry_location(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    location_label: Option<String>,
    location_address: Option<String>,
) -> Result<Entry, String> {
    if let (Some(lat), Some(lon)) = (latitude, longitude) {
        validate_coords(lat, lon)?;
    }
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        update_entry_location_impl(
            &conn,
            &id,
            latitude,
            longitude,
            location_label.as_deref(),
            location_address.as_deref(),
        )
    })
}

/// Update the weather fields for an entry. All fields are stored as plaintext
/// (Phase 3 — SQLCipher handles at-rest encryption).
#[tauri::command]
pub fn update_entry_weather(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    weather_summary: Option<String>,
    weather_icon: Option<String>,
) -> Result<Entry, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        update_entry_weather_impl(
            &conn,
            &id,
            weather_summary.as_deref(),
            weather_icon.as_deref(),
        )
    })
}

/// Fetch weather from Open-Meteo for the given coordinates. When
/// `entry_date` (Unix seconds) is provided, returns weather for that
/// calendar day; otherwise returns current conditions.
/// Network call — not touching DB, so no encryption needed here.
#[tauri::command]
pub async fn fetch_weather(
    latitude: f64,
    longitude: f64,
    entry_date: Option<i64>,
) -> Result<crate::utils::weather::WeatherData, String> {
    validate_coords(latitude, longitude)?;
    crate::utils::weather::fetch_weather(latitude, longitude, entry_date).await
}

/// Toggle the is_favorite flag on an entry. Requires the app to be unlocked —
/// `key_state` is the access-control gate (Phase 3: no per-field decryption,
/// but the gate remains so a locked device cannot mutate entries via IPC).
#[tauri::command]
pub fn toggle_favorite(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
) -> Result<bool, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        toggle_favorite_impl(&conn, &id)
    })
}

/// Per-day emotion lookup for `year`. Returns `(date_iso, emotion)` pairs;
/// when a day has multiple entries with different emotions, the most
/// recently updated wins. Used by the Calendar month-view dot indicator
/// and by the year-long emotion heatmap on the Stats page (Phase 6).
///
/// Decision 10: always excludes ALL invisible entries (not vault-aware).
#[tauri::command]
pub fn get_emotion_by_date(
    state: State<'_, AppState>,
    year: i32,
    locked_view: LockedView,
) -> Result<Vec<(String, String)>, String> {
    let conn = state.lock()?;
    db::query_emotion_by_date_with_locked_view(&conn, year, locked_view).map_err(|e| e.to_string())
}

/// Upper bound on a single Yjs document blob. Well below AES-GCM's
pub use memlore_core::outbox::MAX_YJS_DOC_BYTES;

/// Save the Yjs binary document and plain-text for an entry.
/// Phase 3: all fields are stored as plaintext at the application layer;
/// SQLCipher handles at-rest encryption at the page level.
#[tauri::command]
pub fn save_entry_content(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    last_edit: State<'_, crate::LastEditState>,
    indexer: State<'_, EntryIndexer>,
    id: String,
    yjs_doc: Vec<u8>,
    content_text: String,
    preview_text: String,
) -> Result<(), String> {
    if yjs_doc.len() > MAX_YJS_DOC_BYTES {
        return Err("Yjs document exceeds maximum allowed size (10 MiB)".to_string());
    }
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        save_entry_content_merged_impl(&conn, &id, &yjs_doc, &content_text, &preview_text)
    })?;
    {
        let conn = state.lock()?;
        maybe_detect_language_after_save(&conn, &id);
    }
    maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &id);
    // Stamp the debounce clock only after the write committed. The
    // scheduler reads this to decide when the editor has "gone quiet"
    // (default 30s) and a background push is safe to fire.
    last_edit.mark_now();
    Ok(())
}

/// Update the `entry_date` field for an entry. Called by the multi-EXIF date
/// picker when the user selects a date from the suggestion modal, or
/// automatically when a single EXIF date is detected and the entry date has
/// not been user-edited. Requires unlock for access-control consistency.
#[tauri::command]
pub fn update_entry_date(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    entry_date: i64,
) -> Result<(), String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        update_entry_date_impl(&conn, &id, entry_date)
    })
}

/// Move an entry to a different journal. Wired up to the right-click
/// "Move to another journal" submenu on each entry card. Requires unlock
/// for access-control consistency with the rest of the entries surface.
#[tauri::command]
pub fn move_entry_to_journal(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    journal_id: String,
) -> Result<(), String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        move_entry_to_journal_impl(&conn, &id, &journal_id)
    })
}

/// Set `entry_date_user_edited = 1` durably so the multi-EXIF date modal
/// is suppressed on subsequent renders of this entry. Called by the
/// frontend after the user (a) manually edits the date pill, (b)
/// confirms a date in the suggestion modal, or (c) closes / cancels the
/// modal. Pure flag-flip — does NOT touch `entry_date`. Requires unlock.
#[tauri::command]
pub fn mark_entry_date_user_edited(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
) -> Result<(), String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        mark_entry_date_user_edited_impl(&conn, &id)
    })
}

// ─── Locations Map (C1) ──────────────────────────────────────────────────────

/// Upper bound on the number of pins returned by `list_map_pins`. Rendering
/// more than this in Leaflet without clustering tanks the frame rate; pin
/// clustering is a deferred follow-up chunk.
pub const MAP_PIN_SOFT_CAP: usize = 1000;

/// A single point on the locations map. `kind` discriminates between entry
/// pins (which carry a decrypted human-readable label) and photo pins
/// (identified by their parent entry — click-to-entry is enough for nav).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapPin {
    /// Self-describing composite identifier — `"entry:{uuid}"` for entry pins
    /// or `"photo:{uuid}"` for photo pins. Using a composite key avoids any
    /// possibility of an entry UUID and a media UUID colliding when the
    /// frontend keys a React list or `Map` by `id` alone.
    pub id: String,
    /// Discriminator — `"entry"` or `"photo"`.
    pub kind: &'static str,
    /// The entry the pin belongs to. Photo pins share their parent entry id
    /// here so clicking either kind navigates to the same editor.
    pub entry_id: String,
    pub latitude: f64,
    pub longitude: f64,
    /// Location label (entry pins only). Photo pins always return `None`.
    pub label: Option<String>,
    pub entry_date: i64,
    /// Absolute local path to a JPEG thumbnail the frontend can render on
    /// the marker. For entry pins this is the entry's oldest image-kind
    /// media thumbnail (if any); for photo pins it's the media's own
    /// thumbnail. `None` when no image exists or the thumbnail hasn't been
    /// generated yet — the frontend falls back to a generic Lucide icon.
    pub thumbnail_path: Option<String>,
}

/// Testable core of `list_map_pins` — gates on unlock, merges entry and media
/// GPS rows, soft-caps to [`MAP_PIN_SOFT_CAP`] by newest-created-first.
#[allow(dead_code)]
pub(crate) fn list_map_pins_inner(
    state: &AppState,
    key_state: &EncryptionKeyState,
) -> Result<Vec<MapPin>, String> {
    list_map_pins_inner_with_locked_view(state, key_state, LockedView::Revealed, None)
}

pub(crate) fn list_map_pins_inner_with_locked_view(
    state: &AppState,
    key_state: &EncryptionKeyState,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<Vec<MapPin>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        let entry_rows = db::list_entries_with_location_with_locked_view(
            &conn,
            locked_view,
            active_vault_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        let media_rows = db::list_media_with_location_with_locked_view(
            &conn,
            locked_view,
            active_vault_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;

        // Merge by created_at so the slice we return is the newest N across
        // both sources, bounded by MAP_PIN_SOFT_CAP.
        enum Merged {
            Entry(db::EntryLocationRow),
            Media(db::MediaLocationRow),
        }
        impl Merged {
            fn created_at(&self) -> i64 {
                match self {
                    Merged::Entry(r) => r.created_at,
                    Merged::Media(r) => r.created_at,
                }
            }
            // Stable tie-break so the soft-cap slice is a total function of
            // the data, not of insertion order.
            fn tiebreak_key(&self) -> (u8, &str) {
                match self {
                    Merged::Entry(r) => (0, r.id.as_str()),
                    Merged::Media(r) => (1, r.id.as_str()),
                }
            }
        }
        let mut merged: Vec<Merged> = Vec::with_capacity(entry_rows.len() + media_rows.len());
        merged.extend(entry_rows.into_iter().map(Merged::Entry));
        merged.extend(media_rows.into_iter().map(Merged::Media));
        // Sort newest-created first; on ties, entry pins before photo pins,
        // then by id descending so the per-source DB ordering is preserved.
        merged.sort_by(|a, b| {
            b.created_at()
                .cmp(&a.created_at())
                .then_with(|| a.tiebreak_key().0.cmp(&b.tiebreak_key().0))
                .then_with(|| b.tiebreak_key().1.cmp(a.tiebreak_key().1))
        });
        merged.truncate(MAP_PIN_SOFT_CAP);

        let mut pins: Vec<MapPin> = Vec::with_capacity(merged.len());
        for row in merged {
            match row {
                Merged::Entry(r) => {
                    let label = r.location_label.clone();
                    let composite_id = format!("entry:{}", r.id);
                    pins.push(MapPin {
                        id: composite_id,
                        kind: "entry",
                        entry_id: r.id,
                        latitude: r.latitude,
                        longitude: r.longitude,
                        label,
                        entry_date: r.entry_date,
                        thumbnail_path: r.thumbnail_path,
                    });
                }
                Merged::Media(r) => {
                    let composite_id = format!("photo:{}", r.id);
                    pins.push(MapPin {
                        id: composite_id,
                        kind: "photo",
                        entry_id: r.entry_id,
                        latitude: r.exif_latitude,
                        longitude: r.exif_longitude,
                        label: None,
                        entry_date: r.entry_date,
                        thumbnail_path: r.thumbnail_path,
                    });
                }
            }
        }
        Ok(pins)
    })
}

/// Return every mappable point in the journal (entry GPS + photo EXIF GPS),
/// newest-created first, capped at [`MAP_PIN_SOFT_CAP`]. Requires unlock for
/// access-control consistency (Phase 3: no decryption, gate is access-only).
#[tauri::command]
pub fn list_map_pins(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    locked_view: LockedView,
    active_vault_id: Option<String>,
) -> Result<Vec<MapPin>, String> {
    list_map_pins_inner_with_locked_view(
        &state,
        &key_state,
        locked_view,
        active_vault_id.as_deref(),
    )
}

/// Return the Yjs binary blob for an entry. None if not yet saved.
/// On the JS side, receive as number[] then wrap with `new Uint8Array()`.
#[tauri::command]
pub fn get_entry_content(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    id: String,
    active_vault_id: Option<String>,
) -> Result<Option<Vec<u8>>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        get_entry_content_impl(&conn, &id, active_vault_id.as_deref())
    })
}

pub(crate) fn get_entry_content_impl(
    conn: &Connection,
    id: &str,
    active_vault_id: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    if !db::is_entry_visible_for_active_vault(conn, id, active_vault_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    db::get_entry_content(conn, id).map_err(|e| e.to_string())
}

// ─── Version History (Phase 1: backend storage & retention) ─────────────────

/// Capture an immutable snapshot of an entry's current Yjs document as a new
/// version, then prune old versions per the retention setting plus the
/// hidden 50-versions-per-entry cap. Runs entirely inside one DB transaction.
#[tauri::command]
pub fn snapshot_entry_version(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    entry_id: String,
    yjs_doc: Vec<u8>,
    preview_text: String,
) -> Result<String, String> {
    if yjs_doc.len() > MAX_YJS_DOC_BYTES {
        return Err("Yjs document exceeds maximum allowed size (10 MiB)".to_string());
    }
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        snapshot_entry_version_impl(&conn, &entry_id, &yjs_doc, &preview_text)
    })
}

/// List version metadata (no blob) for an entry, newest first.
/// Invisible entries are withheld unless `active_vault_id` matches their vault
/// (same gate as `get_entry` — preview_text must not leak by remembered id).
#[tauri::command]
pub fn list_entry_versions(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    entry_id: String,
    active_vault_id: Option<String>,
) -> Result<Vec<db::VersionMeta>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        list_entry_versions_impl(&conn, &entry_id, active_vault_id.as_deref())
    })
}

pub(crate) fn list_entry_versions_impl(
    conn: &Connection,
    entry_id: &str,
    active_vault_id: Option<&str>,
) -> Result<Vec<db::VersionMeta>, String> {
    if !db::is_entry_visible_for_active_vault(conn, entry_id, active_vault_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        return Ok(Vec::new());
    }
    db::list_entry_versions(conn, entry_id).map_err(|e| e.to_string())
}

/// Return the Yjs blob for a single version, for preview/restore. Scoped to
/// `entry_id` so a version id can't be used to read another entry's content.
/// Also gated on vault visibility so locked-session callers cannot re-fetch
/// invisible content by remembered entry/version ids.
#[tauri::command]
pub fn get_entry_version_content(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    version_id: String,
    entry_id: String,
    active_vault_id: Option<String>,
) -> Result<Vec<u8>, String> {
    key_state.with_key(|_key| {
        let conn = state.lock()?;
        get_entry_version_content_impl(&conn, &version_id, &entry_id, active_vault_id.as_deref())
    })
}

pub(crate) fn get_entry_version_content_impl(
    conn: &Connection,
    version_id: &str,
    entry_id: &str,
    active_vault_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    if !db::is_entry_visible_for_active_vault(conn, entry_id, active_vault_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        return Err("Version not found".to_string());
    }
    db::get_entry_version_blob_for_entry(conn, version_id, entry_id).map_err(|e| e.to_string())
}

/// Read the version-history retention setting, in days. Defaults to 7.
#[tauri::command]
pub fn get_version_retention_days(state: State<'_, AppState>) -> Result<u32, String> {
    let conn = state.lock()?;
    db::get_version_retention_days(&conn).map_err(|e| e.to_string())
}

/// Persist the version-history retention setting. Only 3, 7, or 15 days
/// are valid — the frontend offers a fixed SegmentedControl.
#[tauri::command]
pub fn set_version_retention_days(state: State<'_, AppState>, days: u32) -> Result<(), String> {
    let conn = state.lock()?;
    db::set_version_retention_days(&conn, days).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::db::CreateEntryParams;
    use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    fn make_key_state() -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        let key = derive_encryption_key("test-password-1234", &[9u8; SALT_SIZE]).unwrap();
        ks.set_key(key).unwrap();
        ks
    }

    fn journal_id(state: &AppState) -> String {
        let conn = state.lock().unwrap();
        db::list_journals(&conn, None).unwrap()[0].id.clone()
    }

    /// Attach an inline and an attached media row (each with a thumbnail) to
    /// `entry_id`, backed by real files in `dir`, and make the first one the
    /// cover. Returns every file path created.
    fn attach_two_media_with_files(
        conn: &Connection,
        entry_id: &str,
        dir: &std::path::Path,
    ) -> Vec<std::path::PathBuf> {
        use std::io::Write;
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        let mut first_media_id: Option<String> = None;
        for (i, (name, mode)) in [("inline.jpg", "inline"), ("attached.pdf", "attached")]
            .into_iter()
            .enumerate()
        {
            let storage = dir.join(name);
            let thumb = dir.join(format!("{name}.thumb"));
            std::fs::File::create(&storage)
                .unwrap()
                .write_all(b"x")
                .unwrap();
            std::fs::File::create(&thumb)
                .unwrap()
                .write_all(b"t")
                .unwrap();
            let media = db::create_media(
                conn,
                crate::db::CreateMediaParams {
                    entry_id,
                    file_name: name,
                    file_type: "image/jpeg",
                    storage_path: storage.to_str().unwrap(),
                    file_size: Some(1),
                    sort_order: i as i64,
                    insertion_mode: mode,
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap();
            db::update_media_thumbnail_path(conn, &media.id, Some(thumb.to_str().unwrap()))
                .unwrap();
            if first_media_id.is_none() {
                first_media_id = Some(media.id.clone());
            }
            files.push(storage);
            files.push(thumb);
        }
        // Set a cover so we can assert the delete trigger clears it.
        conn.execute(
            "UPDATE entries SET cover_media_id = ?1 WHERE id = ?2",
            rusqlite::params![first_media_id.as_deref().unwrap(), entry_id],
        )
        .unwrap();
        files
    }

    /// Moving an entry to Trash keeps its media rows AND files, so a restore
    /// finds them. Purging it then removes the rows (inline AND attached),
    /// returns the file list, unlinks the files, and lets the DB triggers
    /// clear the denormalized `media_count` / `cover_media_id` — so a purged
    /// entry leaves no orphaned media to keep uploading or linger on disk.
    #[test]
    fn trash_keeps_media_rows_and_files_and_purge_removes_them() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let entry = create_entry_impl(&conn, &jid, Some("t"), Some("body"), None, 0).unwrap();
        let files = attach_two_media_with_files(&conn, &entry.id, tmp.path());

        soft_delete_entry_impl(&conn, &entry.id).unwrap();

        assert_eq!(
            db::get_media_for_entry(&conn, &entry.id).unwrap().len(),
            2,
            "trash must keep the entry's media rows"
        );
        for f in &files {
            assert!(f.exists(), "trash must not unlink {}", f.display());
        }
        let trashed = db::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert!(trashed.trashed_at.is_some());
        assert_eq!(trashed.media_count, 2);

        let paths = purge_entry_impl(&conn, &entry.id, LockedView::Revealed, None).unwrap();

        assert_eq!(
            paths.len(),
            2,
            "one (storage, thumbnail) pair per media row"
        );
        assert!(
            db::get_media_for_entry(&conn, &entry.id)
                .unwrap()
                .is_empty(),
            "purge must remove all of the entry's media rows"
        );
        for f in &files {
            assert!(!f.exists(), "media file must be unlinked: {}", f.display());
        }
        let stored = db::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert!(stored.is_deleted, "a purged entry stays a tombstone");
        assert_eq!(stored.trashed_at, None, "a purged entry leaves Trash");
        assert_eq!(stored.media_count, 0, "media_count trigger must reach 0");
        assert!(
            stored.cover_media_id.is_none(),
            "cover_media_id trigger must clear on media delete"
        );
    }

    /// Trash keeps the embedding index (a restore needs no re-embed; every
    /// RAG query already filters `is_deleted = 1`). Purge runs
    /// `cascade_entry_content_delete`, which drops it — shared with the
    /// `pull_entries` peer-tombstone loop, so this pins both entry-side paths.
    #[test]
    fn trash_keeps_the_embedding_index_and_purge_drops_it() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let entry = create_entry_impl(&conn, &jid, Some("t"), Some("body"), None, 0).unwrap();
        let other = create_entry_impl(&conn, &jid, Some("keep"), Some("body"), None, 0).unwrap();
        for eid in [&entry.id, &other.id] {
            db::embeddings::upsert_chunk(&conn, eid, "m", 0, "h", 0, 4, None, 1, &[0.1], 0)
                .unwrap();
            db::embeddings::mark_entry_embedding_dirty(&conn, eid, "m", "h", 0, 0).unwrap();
        }
        let count = |table: &str, eid: &str| -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE entry_id = ?1"),
                [eid],
                |r| r.get(0),
            )
            .unwrap()
        };

        soft_delete_entry_impl(&conn, &entry.id).unwrap();
        assert_eq!(
            count("entry_embedding_chunks", &entry.id),
            1,
            "trash keeps the index"
        );

        purge_entry_impl(&conn, &entry.id, LockedView::Revealed, None).unwrap();
        for table in ["entry_embedding_chunks", "entry_embedding_jobs"] {
            assert_eq!(
                count(table, &entry.id),
                0,
                "{table} must be cleared for the purged entry"
            );
        }
        assert_eq!(
            count("entry_embedding_chunks", &other.id),
            1,
            "another entry's index must survive"
        );
    }

    /// Deleting a whole journal must strip every entry's media (rows + files),
    /// not just tombstone the entries — otherwise journal-delete re-introduces
    /// the exact media leak the per-entry cleanup prevents.
    #[test]
    fn delete_journal_removes_entry_media_rows_and_files() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        // A second journal so the guard (can't delete the last) is satisfied and
        // we can delete `jid`.
        let entry_id;
        let storage;
        {
            let conn = state.lock().unwrap();
            db::create_journal(&conn, "Second", None).unwrap();
            let entry = create_entry_impl(&conn, &jid, Some("t"), Some("body"), None, 0).unwrap();
            entry_id = entry.id.clone();
            storage = tmp.path().join("j.jpg");
            std::fs::File::create(&storage)
                .unwrap()
                .write_all(b"x")
                .unwrap();
            db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id: &entry.id,
                    file_name: "j.jpg",
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
        }

        let paths = {
            let conn = state.lock().unwrap();
            db::delete_journal(&conn, &jid).unwrap()
        };
        // The command unlinks post-commit; here we exercise the same helper.
        for (s, t) in &paths {
            crate::commands::media::remove_media_files_best_effort(s, t.as_deref());
        }

        let conn = state.lock().unwrap();
        assert!(
            db::get_media_for_entry(&conn, &entry_id)
                .unwrap()
                .is_empty(),
            "journal delete must remove its entries' media rows"
        );
        assert_eq!(paths.len(), 1, "one media path returned for unlinking");
        assert!(!storage.exists(), "journal delete must unlink media files");
    }

    // ── Task 4: AI save-path dirty-marking hook ─────────────────────────────

    /// Embedder wrapper that counts `embed()` calls. Used to prove the
    /// save-path hook NEVER calls the embedding provider — marking dirty
    /// only.
    struct CountingEmbedder {
        model_id: String,
        dim: usize,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CountingEmbedder {
        fn new(model_id: &str, dim: usize) -> Self {
            Self {
                model_id: model_id.to_string(),
                dim,
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl crate::ai::embedder::Embedder for CountingEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, _text: &str) -> Result<Vec<f32>, crate::ai::error::AiError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![0.0; self.dim])
        }
    }

    fn job_row_count(conn: &Connection, entry_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM entry_embedding_jobs WHERE entry_id = ?1",
            rusqlite::params![entry_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Core success criterion: saving/creating an entry with the gate ON
    /// marks exactly one pending job row, and the embedding provider is
    /// NEVER called. Editing an entry must never call the embedding
    /// provider immediately.
    #[test]
    fn save_marks_dirty_without_embedding() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let counting = std::sync::Arc::new(CountingEmbedder::new("test-model", 4));
        let indexer = EntryIndexer::from_dyn(counting.clone());

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("some real content"), None, 0)
            })
            .unwrap();
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            1,
            "exactly one dirty job row must exist"
        );
        let job = db::embeddings::claim_due_embedding_jobs(
            &conn,
            "test-model",
            10,
            chrono::Utc::now().timestamp() + AI_ENTRY_EMBED_DEBOUNCE_SECS + 1,
            false,
        )
        .unwrap();
        assert_eq!(job.len(), 1);
        assert_eq!(job[0].entry_id, entry.id);
        assert_eq!(job[0].status, "in_progress");
        assert_eq!(
            counting.call_count(),
            0,
            "save path must never call the embedding provider"
        );
    }

    /// Rapid repeated saves of the same entry coalesce into ONE job row
    /// (upsert), not one row per save.
    #[test]
    fn save_marks_dirty_repeated_saves_coalesce_into_one_job() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("first content body"), None, 0)
            })
            .unwrap();
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        for i in 0..3 {
            ks.with_key(|_key| {
                let conn = state.lock()?;
                update_entry_impl(
                    &conn,
                    &entry.id,
                    Some("t"),
                    Some(&format!("edited content body {i}")),
                    None,
                )
            })
            .unwrap();
            maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);
        }

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            1,
            "repeated saves must coalesce into exactly one job row"
        );
    }

    /// Gate OFF (every embedding-consuming feature explicitly disabled) → no
    /// job row, even with an embedding provider configured. The two default-on
    /// toggles default ON, so "off" must be set explicitly.
    #[test]
    fn save_hook_skips_marking_dirty_when_gate_off() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "false").unwrap();
            db::set_setting(&conn, "ai_emotion_suggestions_enabled", "false").unwrap();
        }

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("some real content"), None, 0)
            })
            .unwrap();
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            0,
            "no job row when every embedding feature is explicitly off"
        );
    }

    /// Provider NOT configured (no embedding endpoint class) → no job row,
    /// even though the features default ON. Guards users who never set up AI
    /// from accumulating stub-model jobs on every save.
    #[test]
    fn save_hook_skips_marking_dirty_when_no_embedding_provider() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        // No `ai_embed_endpoint_class` set; features left at their default-on.
        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("some real content"), None, 0)
            })
            .unwrap();
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            0,
            "no job row when no embedding provider is configured"
        );
    }

    /// The shared gate also fires for emotion_suggestions / chat_rag —
    /// not just semantic_search.
    #[test]
    fn save_hook_marks_dirty_when_only_emotion_suggestions_enabled() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_emotion_suggestions_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("some real content"), None, 0)
            })
            .unwrap();
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(job_row_count(&conn, &entry.id), 1);
    }

    /// Entry below `AI_ENTRY_EMBED_MIN_CHARS` of canonical text → skipped
    /// (no job row).
    #[test]
    fn save_hook_skips_marking_dirty_for_entry_below_min_chars() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }

        // "t" + "\n\n" + "hi" = well under AI_ENTRY_EMBED_MIN_CHARS (20).
        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("hi"), None, 0)
            })
            .unwrap();
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            0,
            "entry below AI_ENTRY_EMBED_MIN_CHARS must be skipped"
        );
    }

    /// Task 6 write-side gate: a locked entry must NOT be marked dirty for
    /// embedding while `ai_embed_include_protected` is off (the default) —
    /// mirrors `list_entries_needing_index`'s write-side exclusion so the
    /// dirty queue never accumulates jobs the backfill query would reject.
    #[test]
    fn save_hook_skips_marking_dirty_for_locked_entry_by_default() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("some real content"), None, 0)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            conn.execute(
                "UPDATE entries SET is_locked = 1 WHERE id = ?1",
                rusqlite::params![entry.id],
            )
            .unwrap();
        }
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            0,
            "locked entry must not be dirty-marked while include_protected is off"
        );
    }

    /// Same setup, but `ai_embed_include_protected` is ON — the locked
    /// entry becomes write-eligible and IS marked dirty.
    #[test]
    fn save_hook_marks_dirty_for_locked_entry_when_include_protected() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let indexer = EntryIndexer::with_stub();

        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
            db::set_setting(
                &conn,
                crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
                "true",
            )
            .unwrap();
        }

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("some real content"), None, 0)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            conn.execute(
                "UPDATE entries SET is_locked = 1 WHERE id = ?1",
                rusqlite::params![entry.id],
            )
            .unwrap();
        }
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, &entry.id);

        let conn = state.lock().unwrap();
        assert_eq!(
            job_row_count(&conn, &entry.id),
            1,
            "locked entry must be dirty-marked once include_protected is on"
        );
    }

    /// Hook errors must be swallowed — a broken read cannot break the save
    /// path. Simulates this by marking dirty for an entry id that doesn't
    /// exist.
    #[test]
    fn save_hook_swallows_dirty_mark_errors_for_missing_entry() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }
        let indexer = EntryIndexer::with_stub();
        // Should NOT panic — the hook fails silently for an unknown id.
        maybe_mark_entry_embedding_dirty_after_save(&state, &indexer, "no-such-entry");
    }

    // ─── Phase 6 A5: language detection save-path hook ─────────────────────

    /// 50+ word English paragraph for the auto-detect hook tests. Long
    /// enough to clear the 30-word floor and the 0.6 confidence floor.
    const EN_PARAGRAPH: &str =
        "Today was a wonderful day in the city. I walked through the park with \
         my old friend, drinking coffee and watching the autumn leaves fall \
         from the trees. We talked about old memories and new dreams, and I \
         realised how much I had missed our long conversations. The afternoon \
         faded into a soft golden evening, and we promised to meet again next \
         weekend.";

    #[test]
    fn save_hook_auto_detects_english_when_language_null() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, Some("Title"), Some(EN_PARAGRAPH), None, 0)?;
                maybe_detect_language_after_save(&conn, &e.id);
                Ok(e)
            })
            .unwrap();

        let conn = state.lock().unwrap();
        let after = db::queries::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(
            after.content_language.as_deref(),
            Some("en"),
            "auto-detect must populate content_language on first save"
        );
    }

    /// First-detect-wins: a row that already has content_language set
    /// (manual override OR previous auto-detect) must NOT be overwritten
    /// by a fresh auto-detect run. Pre-set to "fr", save EN content,
    /// confirm "fr" survives.
    #[test]
    fn save_hook_does_not_overwrite_user_set_language() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("T"), Some(EN_PARAGRAPH), None, 0)
            })
            .unwrap();

        // Manually set to fr — simulates the language pill override.
        {
            let conn = state.lock().unwrap();
            db::queries::set_entry_language(&conn, &entry.id, Some("fr")).unwrap();
        }

        // Fire the hook — must NOT change the existing tag.
        {
            let conn = state.lock().unwrap();
            maybe_detect_language_after_save(&conn, &entry.id);
        }

        let conn = state.lock().unwrap();
        let after = db::queries::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(
            after.content_language.as_deref(),
            Some("fr"),
            "first-detect-wins: prior tag must survive"
        );
    }

    #[test]
    fn save_hook_skips_detection_for_short_content() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e =
                    create_entry_impl(&conn, &jid, Some("Title"), Some("Hello world"), None, 0)?;
                maybe_detect_language_after_save(&conn, &e.id);
                Ok(e)
            })
            .unwrap();

        let conn = state.lock().unwrap();
        let after = db::queries::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(
            after.content_language, None,
            "short content must NOT auto-tag — leaves NULL for next save"
        );
    }

    #[test]
    fn save_hook_swallows_errors_for_missing_entry() {
        // Hook must not panic / propagate when called with a stale id.
        let state = make_state();
        let conn = state.lock().unwrap();
        maybe_detect_language_after_save(&conn, "no-such-entry");
        // No assertion — the test passes if we didn't panic above.
    }

    #[test]
    fn is_valid_language_tag_accepts_canonical_forms() {
        assert!(is_valid_language_tag("en"));
        assert!(is_valid_language_tag("vi"));
        assert!(is_valid_language_tag("nob")); // 3-letter
        assert!(is_valid_language_tag("pt-BR"));
        assert!(is_valid_language_tag("zh-CN"));
    }

    #[test]
    fn is_valid_language_tag_rejects_garbage() {
        assert!(!is_valid_language_tag(""));
        assert!(!is_valid_language_tag("EN")); // upper
        assert!(!is_valid_language_tag("e")); // 1-char
        assert!(!is_valid_language_tag("english")); // 7-char
        assert!(!is_valid_language_tag("en-")); // empty region
        assert!(!is_valid_language_tag("en-us")); // lowercase region
        assert!(!is_valid_language_tag("en-USA")); // 3-char region
        assert!(!is_valid_language_tag("en-US-x")); // multi-segment
        assert!(!is_valid_language_tag(" en")); // leading space
        assert!(!is_valid_language_tag("en ")); // trailing space
        assert!(!is_valid_language_tag("e1")); // digit
        assert!(!is_valid_language_tag("en/x")); // path separator
    }

    #[test]
    fn set_entry_language_persists_and_get_returns_tag() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("T"), Some("c"), None, 0)
            })
            .unwrap();

        {
            let conn = state.lock().unwrap();
            db::queries::set_entry_language(&conn, &entry.id, Some("vi")).unwrap();
            let lang = db::queries::get_entry_language(&conn, &entry.id).unwrap();
            assert_eq!(lang.as_deref(), Some("vi"));
        }

        // Clear (None) — the column flips back to NULL so the next save
        // re-runs auto-detect.
        {
            let conn = state.lock().unwrap();
            db::queries::set_entry_language(&conn, &entry.id, None).unwrap();
            let lang = db::queries::get_entry_language(&conn, &entry.id).unwrap();
            assert_eq!(lang, None);
        }
    }

    /// Regression guard for the cf-review race: a sync push that lands
    /// between commit + hook would consume the row's pending state,
    /// leaving the auto-detected language stranded locally. The hook's
    /// own `mark_entry_pending` call must re-flag the row so a
    /// subsequent push includes the language tag.
    #[test]
    fn save_hook_re_marks_pending_after_auto_detect() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("T"), Some(EN_PARAGRAPH), None, 0)
            })
            .unwrap();

        // Simulate a push that drained the pending flag between commit
        // and hook execution: mark synced at version 1, then read back
        // the status to confirm the precondition.
        {
            let conn = state.lock().unwrap();
            db::queries::mark_entry_synced(&conn, &entry.id, 1).expect("mark synced");
            let status: String = conn
                .query_row(
                    "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                    [&entry.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "synced", "test precondition: pending consumed");
        }

        // Fire the hook — it must re-mark pending alongside writing
        // content_language.
        {
            let conn = state.lock().unwrap();
            maybe_detect_language_after_save(&conn, &entry.id);
        }

        let conn = state.lock().unwrap();
        let tagged = db::queries::get_entry_language(&conn, &entry.id).unwrap();
        assert_eq!(tagged.as_deref(), Some("en"), "hook must tag the language");
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&entry.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "pending",
            "hook must re-mark pending so the language tag reaches sync"
        );
    }

    #[test]
    fn set_entry_language_marks_pending_for_sync() {
        // Ensure the language pill change reaches sync_state so a remote
        // device picks up the override.
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("T"), Some("c"), None, 0)
            })
            .unwrap();
        let conn = state.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        db::queries::set_entry_language(&tx, &entry.id, Some("en")).unwrap();
        db::mark_entry_pending(&tx, &entry.id).unwrap();
        tx.commit().unwrap();
        // Sanity: the entry exists with the new tag.
        let lang = db::queries::get_entry_language(&conn, &entry.id).unwrap();
        assert_eq!(lang.as_deref(), Some("en"));
    }

    #[test]
    fn get_entry_helpers_hide_invisible_entry_and_content_by_default() {
        let state = make_state();
        let jid = journal_id(&state);
        let invisible_jid = {
            let conn = state.lock().unwrap();
            db::create_journal(&conn, "Invisible journal", None)
                .unwrap()
                .id
        };

        let (visible_entry, direct_invisible, inherited_invisible) = {
            let conn = state.lock().unwrap();
            let visible = db::create_entry(
                &conn,
                CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Visible"),
                    content_text: Some("visible"),
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
            let direct = db::create_entry(
                &conn,
                CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Direct invisible"),
                    content_text: Some("direct hidden"),
                    preview_text: None,
                    entry_date: 1_700_000_001,
                },
            )
            .unwrap();
            let inherited = db::create_entry(
                &conn,
                CreateEntryParams {
                    journal_id: &invisible_jid,
                    title: Some("Inherited invisible"),
                    content_text: Some("journal hidden"),
                    preview_text: None,
                    entry_date: 1_700_000_002,
                },
            )
            .unwrap();
            db::save_entry_content(&conn, &visible.id, b"visible-doc", "visible", "visible")
                .unwrap();
            db::save_entry_content(&conn, &direct.id, b"direct-doc", "direct hidden", "direct")
                .unwrap();
            db::save_entry_content(
                &conn,
                &inherited.id,
                b"inherited-doc",
                "journal hidden",
                "journal",
            )
            .unwrap();
            db::set_entry_invisible(&conn, &direct.id, true, Some("test-vault")).unwrap();
            db::set_journal_invisible(&conn, &invisible_jid, true, Some("test-vault")).unwrap();
            (visible.id, direct.id, inherited.id)
        };

        let conn = state.lock().unwrap();
        assert!(get_entry_impl(&conn, &visible_entry, None)
            .unwrap()
            .is_some());
        assert!(get_entry_content_impl(&conn, &visible_entry, None)
            .unwrap()
            .is_some());

        assert!(get_entry_impl(&conn, &direct_invisible, None)
            .unwrap()
            .is_none());
        assert!(get_entry_content_impl(&conn, &direct_invisible, None)
            .unwrap()
            .is_none());
        assert!(get_entry_impl(&conn, &inherited_invisible, None)
            .unwrap()
            .is_none());
        assert!(get_entry_content_impl(&conn, &inherited_invisible, None)
            .unwrap()
            .is_none());

        assert!(get_entry_impl(&conn, &direct_invisible, Some("test-vault"))
            .unwrap()
            .is_some());
        assert_eq!(
            get_entry_content_impl(&conn, &inherited_invisible, Some("test-vault")).unwrap(),
            Some(b"inherited-doc".to_vec())
        );
    }

    #[test]
    fn commands_require_unlocked_key() {
        // When the key state is empty, `with_key` returns an error. This is
        // the guard that prevents accidental plaintext writes when the app
        // is locked.
        let ks = EncryptionKeyState::new();
        let result: Result<(), String> = ks.with_key(|_| Ok(()));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("locked"));
    }

    // ── Chunk 3a: sync_state hooks ─────────────────────────────────────────
    //
    // Every entry mutation must leave the entry's sync_state row in 'pending'
    // and bump `local_version`. We test this by driving the internal
    // `*_impl` free functions the Tauri commands delegate to — they take a
    // raw `&Connection`, so no `State<'_,_>` plumbing needed.

    fn sync_row(state: &AppState, entry_id: &str) -> Option<(i64, String)> {
        let conn = state.lock().unwrap();
        conn.query_row(
            "SELECT local_version, sync_status FROM sync_state WHERE entry_id = ?1",
            [entry_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .ok()
    }

    #[test]
    fn create_entry_impl_returns_typed_error_for_unknown_journal_id() {
        // Regression: when the frontend's cached journal id drifts from the
        // DB (observed during the password-mode first-time setup re-key),
        // calling create_entry with the stale id would surface SQLite's
        // opaque `FOREIGN KEY constraint failed`. We now return a typed
        // `JOURNAL_NOT_FOUND:` prefix the frontend can parse for self-heal.
        let state = make_state();
        let err = {
            let conn = state.lock().unwrap();
            create_entry_impl(
                &conn,
                "00000000-dead-beef-cafe-000000000000",
                Some("t"),
                Some("body"),
                None,
                1_700_000_000,
            )
        }
        .expect_err("create_entry must reject a journal id that does not exist");
        assert!(
            err.starts_with("JOURNAL_NOT_FOUND:"),
            "expected typed error, got: {err}"
        );
    }

    #[test]
    fn create_entry_impl_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("body"), None, 1_700_000_000)
            })
            .unwrap();
        let (local_version, status) = sync_row(&state, &entry.id).expect("sync row");
        assert_eq!(local_version, 1);
        assert_eq!(status, "pending");
    }

    #[test]
    fn create_entry_impl_auto_applies_journal_tags() {
        let state = make_state();
        let ks = make_key_state();

        // Seed: two tags, plus a journal that auto-applies both.
        let (jid, t1_id, t2_id) = {
            let conn = state.lock().unwrap();
            let t1 = db::create_tag(&conn, "auto-a", Some("#7C3AED")).unwrap();
            let t2 = db::create_tag(&conn, "auto-b", Some("#10B981")).unwrap();
            let j = db::create_journal(&conn, "Auto", None).unwrap();
            db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();
            (j.id, t1.id, t2.id)
        };

        let entry = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("hi"), None, None, 1_700_000_000)
            })
            .unwrap();

        let conn = state.lock().unwrap();
        let mut tag_ids: Vec<String> = db::get_tags_for_entry(&conn, &entry.id)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        tag_ids.sort();
        let mut expected = [t1_id, t2_id];
        expected.sort();
        assert_eq!(tag_ids, expected, "both auto-tags should be attached");
    }

    #[test]
    fn update_entry_impl_bumps_local_version() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, Some("first"), None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        ks.with_key(|_key| {
            let conn = state.lock()?;
            update_entry_impl(&conn, &id, Some("second"), None, None)?;
            Ok::<(), String>(())
        })
        .unwrap();
        let (local_version, status) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
        assert_eq!(status, "pending");
    }

    // NOTE: `update_entry_impl_wipes_cached_embeddings` used to live here,
    // asserting that `update_entry_impl` eagerly wiped every cached vector
    // for an entry on edit. That eager-invalidation behavior (and the
    // `entries_embeddings` table it wiped) was removed in Task 4 of the
    // chunk-only embedding cutover: staleness is now handled by the
    // dirty-marking hook (`maybe_mark_entry_embedding_dirty_after_save`)
    // plus the Phase 2 worker's content-hash diffing over
    // `entry_embedding_chunks`, which reuses unchanged chunks instead of
    // wiping everything — see the comment in `update_entry_impl`.

    #[test]
    fn save_entry_content_impl_bumps_local_version() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        ks.with_key(|_key| {
            let conn = state.lock()?;
            save_entry_content_impl(&conn, &id, b"yjs", "body", "preview")
        })
        .unwrap();
        let (local_version, _) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
    }

    // ─── save_entry_content merges into the stored doc (L45 sub-item 5) ───

    /// A live entry whose stored doc is `paragraphs`, plus the stored bytes.
    fn entry_with_doc(conn: &Connection, paragraphs: &[&str]) -> (String, Vec<u8>) {
        let jid = db::list_journals(conn, None).unwrap()[0].id.clone();
        let entry = create_entry_impl(conn, &jid, None, None, None, 1_700_000_000).unwrap();
        let (bytes, text, preview) = crate::yjs_doc::build_entry_yjs(paragraphs, &[]);
        save_entry_content_merged_impl(conn, &entry.id, &bytes, &text, &preview).unwrap();
        (entry.id, bytes)
    }

    /// A doc loaded from `bytes` under its own client id, like the open
    /// editor (or a peer) that started from that state.
    fn replica(bytes: &[u8]) -> yrs::Doc {
        crate::commands::mcp::load_yjs_doc(Some(bytes)).unwrap()
    }

    fn push_paragraph(doc: &yrs::Doc, text: &str) {
        use yrs::types::xml::XmlIn;
        use yrs::{Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};
        let fragment = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        fragment.push_back(
            &mut txn,
            XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(text))]),
        );
    }

    fn full_state(doc: &yrs::Doc) -> Vec<u8> {
        use yrs::{ReadTxn, StateVector, Transact};
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// `(doc text, content_text)` as stored.
    fn stored_texts(conn: &Connection, id: &str) -> (String, String) {
        let blob = db::get_entry_content(conn, id).unwrap().unwrap();
        let (doc_text, _) = crate::yjs_doc::extract_entry_text(&blob).unwrap();
        let entry = db::get_entry(conn, id).unwrap().unwrap();
        (doc_text, entry.content_text.unwrap_or_default())
    }

    /// The editor serialized its full state before an MCP append landed and
    /// saves it after: the appended text must survive in the doc and in
    /// `content_text`, next to what the user typed.
    #[test]
    fn stale_editor_save_keeps_mcp_append() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let (id, opened) = entry_with_doc(&conn, &["Opened text"]);
        let editor = replica(&opened);

        crate::commands::mcp::append_to_entry_impl(&conn, &id, "From MCP").unwrap();

        push_paragraph(&editor, "Typed later");
        let text = "Opened text\nTyped later";
        save_entry_content_merged_impl(&conn, &id, &full_state(&editor), text, text).unwrap();

        let (doc_text, content_text) = stored_texts(&conn, &id);
        for want in ["Opened text", "From MCP", "Typed later"] {
            assert!(doc_text.contains(want), "doc lost {want:?}: {doc_text:?}");
            assert!(
                content_text.contains(want),
                "content_text lost {want:?}: {content_text:?}"
            );
        }
    }

    /// The common autosave: the editor holds everything stored plus its own
    /// edits. Its bytes and its text are written exactly as sent.
    #[test]
    fn editor_save_superset_keeps_incoming_bytes() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let (id, opened) = entry_with_doc(&conn, &["Opened text"]);
        let editor = replica(&opened);
        push_paragraph(&editor, "Typed now");
        let incoming = full_state(&editor);

        save_entry_content_merged_impl(&conn, &id, &incoming, "frontend text", "frontend").unwrap();

        let stored = db::get_entry_content(&conn, &id).unwrap().unwrap();
        assert_eq!(
            stored, incoming,
            "a superset save must keep the editor's bytes"
        );
        let entry = db::get_entry(&conn, &id).unwrap().unwrap();
        assert_eq!(entry.content_text.as_deref(), Some("frontend text"));
        assert_eq!(entry.preview_text.as_deref(), Some("frontend"));
    }

    /// The stored doc and the editor's doc share no client (a pull took a
    /// remote doc of another lineage while the editor was open). Merging
    /// would double the body, so the save overwrites as before.
    #[test]
    fn editor_save_disjoint_lineage_overwrites_as_before() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let (id, _) = entry_with_doc(&conn, &["Same body"]);
        let (incoming, _, _) = crate::yjs_doc::build_entry_yjs(&["Same body"], &[]);

        save_entry_content_merged_impl(&conn, &id, &incoming, "frontend text", "frontend").unwrap();

        let stored = db::get_entry_content(&conn, &id).unwrap().unwrap();
        assert_eq!(stored, incoming, "a disjoint lineage must be overwritten");
        let entry = db::get_entry(&conn, &id).unwrap().unwrap();
        assert_eq!(entry.content_text.as_deref(), Some("frontend text"));
    }

    /// A peer (web edit merge, outbox import) deleted a paragraph after the
    /// editor opened the entry. Deletes do not advance the state vector, so
    /// a state-vector-only gate would take the stale editor doc as a
    /// superset and bring the paragraph back.
    #[test]
    fn stale_editor_save_keeps_a_deletion_made_in_stored() {
        use yrs::{Transact, XmlFragment};
        let state = make_state();
        let conn = state.lock().unwrap();
        let (id, opened) = entry_with_doc(&conn, &["Keep me", "Doomed paragraph"]);
        let editor = replica(&opened);

        let peer = replica(&opened);
        {
            let fragment = peer.get_or_insert_xml_fragment("default");
            let mut txn = peer.transact_mut();
            fragment.remove_range(&mut txn, 1, 1);
        }
        save_entry_content_impl(&conn, &id, &full_state(&peer), "Keep me", "Keep me").unwrap();

        push_paragraph(&editor, "Typed later");
        let text = "Keep me\nDoomed paragraph\nTyped later";
        save_entry_content_merged_impl(&conn, &id, &full_state(&editor), text, text).unwrap();

        let (doc_text, content_text) = stored_texts(&conn, &id);
        for got in [&doc_text, &content_text] {
            assert!(got.contains("Keep me"), "lost kept text: {got:?}");
            assert!(got.contains("Typed later"), "lost typed text: {got:?}");
            assert!(
                !got.contains("Doomed"),
                "a deletion made in stored came back: {got:?}"
            );
        }
    }

    #[test]
    fn soft_delete_impl_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            soft_delete_entry_impl(&conn, &id).unwrap();
        }
        let (local_version, status) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
        assert_eq!(status, "pending");
    }

    // ── Bug 4 fix: soft-delete cascades to AI User Memory ──────────────────

    #[test]
    fn soft_delete_impl_tombstones_sole_source_memory_and_removes_job() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            db::memory::insert_memory_item(&conn, "m1", "sole source fact", "journal_entry", 100)
                .unwrap();
            db::memory::add_memory_source(&conn, "m1", "journal_entry", &id).unwrap();
            db::memory::upsert_memory_job_watermark(&conn, "journal_entry", &id, "h", 0, 100)
                .unwrap();
        }

        {
            let conn = state.lock().unwrap();
            soft_delete_entry_impl(&conn, &id).unwrap();
        }

        let conn = state.lock().unwrap();
        let items = db::memory::list_memory_items(&conn).unwrap();
        assert!(
            items.is_empty(),
            "the sole-source memory item must be tombstoned after the entry is deleted"
        );
        let job = db::memory::get_memory_job(&conn, "journal_entry", &id).unwrap();
        assert!(job.is_none(), "the entry's memory_jobs row must be removed");
    }

    #[test]
    fn soft_delete_impl_leaves_multi_source_memory_alive() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            db::memory::insert_memory_item(&conn, "m1", "consolidated fact", "journal_entry", 100)
                .unwrap();
            db::memory::add_memory_source(&conn, "m1", "journal_entry", &id).unwrap();
            db::memory::add_memory_source(&conn, "m1", "journal_entry", "other-entry").unwrap();
        }

        {
            let conn = state.lock().unwrap();
            soft_delete_entry_impl(&conn, &id).unwrap();
        }

        let conn = state.lock().unwrap();
        let items = db::memory::list_memory_items(&conn).unwrap();
        assert_eq!(
            items.len(),
            1,
            "memory with a surviving second source must not be tombstoned"
        );
    }

    // ── C1 fix: deleting a LOCKED source tombstones the whole memory,
    //    even with a surviving unlocked co-source ─────────────────────────

    #[test]
    fn soft_delete_impl_tombstones_whole_memory_when_deleted_entry_was_locked() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        let other_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            db::memory::insert_memory_item(&conn, "m1", "blended fact", "journal_entry", 100)
                .unwrap();
            db::memory::add_memory_source(&conn, "m1", "journal_entry", &id).unwrap();
            db::memory::add_memory_source(&conn, "m1", "journal_entry", &other_id).unwrap();
            db::set_entry_locked(&conn, &id, true).unwrap();
        }

        {
            let conn = state.lock().unwrap();
            soft_delete_entry_impl(&conn, &id).unwrap();
        }

        let conn = state.lock().unwrap();
        let items = db::memory::list_memory_items(&conn).unwrap();
        assert!(
            items.is_empty(),
            "a memory sourced from a locked, now-deleted entry must be tombstoned outright, \
             even though the unlocked co-source survives (C1 fix)"
        );
    }

    // ── Phase 9: Trash commands ──────────────────────────────────────────────

    fn trash_msg() -> String {
        db::queries::LiveEntryError::Trashed.to_string()
    }

    fn new_entry(conn: &Connection, jid: &str, title: &str) -> String {
        create_entry_impl(conn, jid, Some(title), Some("body"), None, 1_700_000_000)
            .unwrap()
            .id
    }

    fn local_version(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT local_version FROM sync_state WHERE entry_id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn soft_delete_impl_moves_the_entry_to_trash() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let id = new_entry(&conn, &jid, "t");

        soft_delete_entry_impl(&conn, &id).unwrap();

        let e = db::get_entry(&conn, &id).unwrap().unwrap();
        assert!(e.is_deleted);
        assert!(e.trashed_at.is_some());
        let listed = list_trashed_entries_impl(&conn, LockedView::Revealed, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
    }

    #[test]
    fn soft_delete_impl_refuses_trashed_and_missing_entries() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let id = new_entry(&conn, &jid, "t");
        soft_delete_entry_impl(&conn, &id).unwrap();
        let version = local_version(&conn, &id);

        assert_eq!(soft_delete_entry_impl(&conn, &id).unwrap_err(), trash_msg());
        assert_eq!(
            local_version(&conn, &id),
            version,
            "a refused trash must not re-mark pending"
        );
        assert!(soft_delete_entry_impl(&conn, "missing").is_err());
    }

    #[test]
    fn restore_entry_impl_brings_a_trashed_entry_back_with_its_media() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let id = new_entry(&conn, &jid, "Back");
        let files = attach_two_media_with_files(&conn, &id, tmp.path());
        soft_delete_entry_impl(&conn, &id).unwrap();
        let version = local_version(&conn, &id);

        restore_entry_impl(&conn, &id, LockedView::Revealed, None).unwrap();

        let e = db::get_entry(&conn, &id).unwrap().unwrap();
        assert!(!e.is_deleted);
        assert_eq!(e.trashed_at, None);
        assert_eq!(db::get_media_for_entry(&conn, &id).unwrap().len(), 2);
        assert!(files.iter().all(|f| f.exists()));
        assert_eq!(local_version(&conn, &id), version + 1, "restore re-pushes");
        assert!(list_trashed_entries_impl(&conn, LockedView::Revealed, None)
            .unwrap()
            .is_empty());
        // Edits work again once restored.
        update_entry_impl(&conn, &id, Some("edited"), None, None).unwrap();
    }

    #[test]
    fn restore_entry_impl_errors_for_live_missing_and_purged_ids() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let live = new_entry(&conn, &jid, "Live");
        let purged = new_entry(&conn, &jid, "Purged");
        soft_delete_entry_impl(&conn, &purged).unwrap();
        purge_entry_impl(&conn, &purged, LockedView::Revealed, None).unwrap();
        let version = local_version(&conn, &purged);

        assert!(restore_entry_impl(&conn, &live, LockedView::Revealed, None).is_err());
        assert!(restore_entry_impl(&conn, "missing", LockedView::Revealed, None).is_err());
        assert!(restore_entry_impl(&conn, &purged, LockedView::Revealed, None).is_err());
        assert_eq!(local_version(&conn, &purged), version);
        assert!(db::get_entry(&conn, &purged).unwrap().unwrap().is_deleted);
    }

    #[test]
    fn purge_entry_impl_marks_pending_and_is_idempotent_on_memories() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let id = new_entry(&conn, &jid, "t");
        db::memory::insert_memory_item(&conn, "m1", "fact", "journal_entry", 100).unwrap();
        db::memory::add_memory_source(&conn, "m1", "journal_entry", &id).unwrap();
        soft_delete_entry_impl(&conn, &id).unwrap();
        assert!(
            db::memory::list_memory_items(&conn).unwrap().is_empty(),
            "memories go at trash time"
        );
        let version = local_version(&conn, &id);

        let paths = purge_entry_impl(&conn, &id, LockedView::Revealed, None).unwrap();

        assert!(paths.is_empty(), "no media, nothing to unlink");
        assert_eq!(local_version(&conn, &id), version + 1);
        let e = db::get_entry(&conn, &id).unwrap().unwrap();
        assert!(e.is_deleted);
        assert_eq!(e.trashed_at, None);
    }

    #[test]
    fn purge_entry_impl_refuses_live_missing_and_already_purged_ids() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let live = new_entry(&conn, &jid, "Live");
        let files = attach_two_media_with_files(&conn, &live, tmp.path());

        assert!(purge_entry_impl(&conn, &live, LockedView::Revealed, None).is_err());
        assert_eq!(
            db::get_media_for_entry(&conn, &live).unwrap().len(),
            2,
            "a refused purge must not touch a live entry's media"
        );
        assert!(files.iter().all(|f| f.exists()));
        assert!(purge_entry_impl(&conn, "missing", LockedView::Revealed, None).is_err());

        soft_delete_entry_impl(&conn, &live).unwrap();
        purge_entry_impl(&conn, &live, LockedView::Revealed, None).unwrap();
        assert!(purge_entry_impl(&conn, &live, LockedView::Revealed, None).is_err());
    }

    #[test]
    fn list_trashed_entries_impl_follows_the_locked_view() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let plain = new_entry(&conn, &jid, "Plain");
        let locked = new_entry(&conn, &jid, "Locked");
        let _live = new_entry(&conn, &jid, "Live");
        db::set_entry_locked(&conn, &locked, true).unwrap();
        soft_delete_entry_impl(&conn, &plain).unwrap();
        soft_delete_entry_impl(&conn, &locked).unwrap();

        let ids = |view| {
            let mut v: Vec<String> = list_trashed_entries_impl(&conn, view, None)
                .unwrap()
                .into_iter()
                .map(|e| e.id)
                .collect();
            v.sort();
            v
        };
        let mut both = vec![plain.clone(), locked.clone()];
        both.sort();
        assert_eq!(ids(LockedView::Revealed), both);
        assert_eq!(ids(LockedView::Hidden), vec![plain]);
    }

    #[test]
    fn empty_trash_impl_purges_every_visible_trashed_entry_and_is_idempotent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let a = new_entry(&conn, &jid, "A");
        let b = new_entry(&conn, &jid, "B");
        let live = new_entry(&conn, &jid, "Live");
        let files = attach_two_media_with_files(&conn, &a, tmp.path());
        soft_delete_entry_impl(&conn, &a).unwrap();
        soft_delete_entry_impl(&conn, &b).unwrap();

        let confirmed = vec![a.clone(), b.clone()];
        let purged = empty_trash_impl(&conn, &confirmed, LockedView::Revealed, None).unwrap();

        assert_eq!(purged, 2);
        assert!(list_trashed_entries_impl(&conn, LockedView::Revealed, None)
            .unwrap()
            .is_empty());
        assert!(db::get_media_for_entry(&conn, &a).unwrap().is_empty());
        assert!(files.iter().all(|f| !f.exists()), "files unlinked");
        let live_row = db::get_entry(&conn, &live).unwrap().unwrap();
        assert!(!live_row.is_deleted, "a live entry is never purged");

        assert_eq!(
            empty_trash_impl(&conn, &confirmed, LockedView::Revealed, None).unwrap(),
            0,
            "a second empty is a no-op"
        );
    }

    #[test]
    fn empty_trash_impl_leaves_locked_entries_the_view_hides() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let plain = new_entry(&conn, &jid, "Plain");
        let locked = new_entry(&conn, &jid, "Locked");
        db::set_entry_locked(&conn, &locked, true).unwrap();
        soft_delete_entry_impl(&conn, &plain).unwrap();
        soft_delete_entry_impl(&conn, &locked).unwrap();

        assert_eq!(
            empty_trash_impl(&conn, &[plain, locked.clone()], LockedView::Hidden, None).unwrap(),
            1
        );

        let remaining = list_trashed_entries_impl(&conn, LockedView::Revealed, None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, locked);
    }

    /// Regression (LATER "Desktop empty_trash empties everything it shows at
    /// click time"): only the ids the user confirmed are purged, and a listed
    /// id is still refused unless it is in this view's visible Trash.
    #[test]
    fn empty_trash_purges_only_listed_visible_ids() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let listed = new_entry(&conn, &jid, "Listed");
        let unlisted = new_entry(&conn, &jid, "Arrived after confirm");
        let locked = new_entry(&conn, &jid, "Locked");
        let invisible = new_entry(&conn, &jid, "Invisible");
        let live = new_entry(&conn, &jid, "Live");
        db::set_entry_locked(&conn, &locked, true).unwrap();
        db::set_entry_invisible(&conn, &invisible, true, Some("vault-a")).unwrap();
        for id in [&listed, &unlisted, &locked, &invisible] {
            soft_delete_entry_impl(&conn, id).unwrap();
        }

        let ids = vec![
            listed.clone(),
            locked.clone(),
            invisible.clone(),
            live.clone(),
            "no-such-entry".to_string(),
        ];
        assert_eq!(
            empty_trash_impl(&conn, &ids, LockedView::Hidden, None).unwrap(),
            1
        );

        assert_eq!(
            db::get_entry(&conn, &listed).unwrap().unwrap().trashed_at,
            None,
            "purged (tombstone left)"
        );
        for id in [&unlisted, &locked, &invisible] {
            let row = db::get_entry(&conn, id).unwrap().unwrap();
            assert!(
                row.is_deleted && row.trashed_at.is_some(),
                "{id} kept in Trash"
            );
        }
        let live_row = db::get_entry(&conn, &live).unwrap().unwrap();
        assert!(!live_row.is_deleted, "a live entry is never purged");
    }

    /// One retention sweep against a test-owned session (never the
    /// process-wide one, which parallel tests would share).
    fn sweep(
        conn: &Connection,
        now: i64,
        session: &mut Option<SweepSession>,
        elapsed: u64,
    ) -> usize {
        purge_expired_trash_in_session(conn, now, session, |_| elapsed).unwrap()
    }

    fn seed_watermark(conn: &Connection, at: i64) {
        db::set_setting(conn, TRASH_SWEEP_LAST_RUN_KEY, &at.to_string()).unwrap();
    }

    fn watermark(conn: &Connection) -> Option<i64> {
        db::get_setting(conn, TRASH_SWEEP_LAST_RUN_KEY)
            .unwrap()
            .map(|v| v.parse().unwrap())
    }

    #[test]
    fn purge_expired_trash_purges_due_entries_keeps_recent_and_is_idempotent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let due = new_entry(&conn, &jid, "Due");
        let recent = new_entry(&conn, &jid, "Recent");
        let live = new_entry(&conn, &jid, "Live");
        let files = attach_two_media_with_files(&conn, &due, tmp.path());
        let now = crate::utils::time::now_unix();
        db::queries::trash_entry(&conn, &due, now - TRASH_RETENTION_SECS).unwrap();
        soft_delete_entry_impl(&conn, &recent).unwrap();
        let version = local_version(&conn, &due);
        seed_watermark(&conn, now - 60);
        let mut session = None;

        assert_eq!(sweep(&conn, now, &mut session, 0), 1);

        let row = db::get_entry(&conn, &due).unwrap().unwrap();
        assert!(row.is_deleted);
        assert_eq!(row.trashed_at, None, "a purged entry leaves Trash");
        assert_eq!(local_version(&conn, &due), version + 1, "marked pending");
        assert!(db::get_media_for_entry(&conn, &due).unwrap().is_empty());
        assert!(files.iter().all(|f| !f.exists()), "files unlinked");
        assert!(
            db::get_entry(&conn, &recent)
                .unwrap()
                .unwrap()
                .trashed_at
                .is_some(),
            "a not-yet-due entry stays in Trash"
        );
        assert!(!db::get_entry(&conn, &live).unwrap().unwrap().is_deleted);
        assert_eq!(watermark(&conn), Some(now));

        assert_eq!(
            sweep(&conn, now, &mut session, 0),
            0,
            "a second sweep is a no-op"
        );
    }

    fn trashed_at_offset(conn: &Connection, jid: &str, title: &str, at: i64) -> String {
        let id = new_entry(conn, jid, title);
        db::queries::trash_entry(conn, &id, at).unwrap();
        id
    }

    fn still_in_trash(conn: &Connection, id: &str) -> bool {
        db::get_entry(conn, id)
            .unwrap()
            .unwrap()
            .trashed_at
            .is_some()
    }

    /// A local trash with the wall clock far behind (dead RTC, VM restore)
    /// is stamped no earlier than `watermark - MAX_CLOCK_SKEW_SECS`, so once
    /// the clock is corrected the next sweep does not purge it at once.
    #[test]
    fn soft_delete_with_a_clock_far_behind_the_watermark_is_not_purged_once_corrected() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let real = crate::utils::time::now_unix();
        let id = new_entry(&conn, &jid, "Behind");
        seed_watermark(&conn, real - 60);
        let behind = real - 40 * 86_400;

        soft_delete_entry_at(&conn, &id, behind).unwrap();

        let row = db::get_entry(&conn, &id).unwrap().unwrap();
        let floor = real - 60 - crate::sync::engine::MAX_CLOCK_SKEW_SECS;
        assert_eq!(
            row.trashed_at,
            Some(floor),
            "stamp floored at the watermark"
        );
        assert!(row.updated_at >= floor, "updated_at uses the floored now");
        assert_eq!(sweep(&conn, real, &mut None, 0), 0);
        assert!(still_in_trash(&conn, &id), "not purged once corrected");
    }

    /// With no watermark yet, a trash seeds it at the wall clock, so a far-
    /// behind clock corrected later cannot make the trash immediately due.
    #[test]
    fn soft_delete_without_a_watermark_seeds_it_so_a_corrected_clock_does_not_purge() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let real = crate::utils::time::now_unix();
        let id = new_entry(&conn, &jid, "Behind");
        let behind = real - 40 * 86_400;

        soft_delete_entry_at(&conn, &id, behind).unwrap();

        assert_eq!(watermark(&conn), Some(behind), "watermark seeded");
        let mut session = None;
        assert_eq!(sweep(&conn, real, &mut session, 0), 0);
        assert_eq!(sweep(&conn, real, &mut session, 0), 0);
        assert!(still_in_trash(&conn, &id), "not purged once corrected");
    }

    /// With no watermark, or a wall clock ahead of it, the trash stamp is
    /// the wall clock itself.
    #[test]
    fn soft_delete_stamps_wall_now_when_not_behind_the_watermark() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let real = crate::utils::time::now_unix();
        let a = new_entry(&conn, &jid, "A");
        let b = new_entry(&conn, &jid, "B");

        soft_delete_entry_at(&conn, &a, real).unwrap();
        seed_watermark(&conn, real - 10 * 86_400);
        soft_delete_entry_at(&conn, &b, real).unwrap();

        for id in [&a, &b] {
            let row = db::get_entry(&conn, id).unwrap().unwrap();
            assert_eq!(row.trashed_at, Some(real));
        }
    }

    /// With no persisted watermark there is nothing to bound a clock jump
    /// against, so the first sweep ever only seeds it; later sweeps in the
    /// same process then purge normally.
    #[test]
    fn purge_expired_trash_first_run_ever_seeds_the_watermark_without_purging() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let old = trashed_at_offset(&conn, &jid, "Old", now - 40 * 86_400);
        let mut session = None;

        assert_eq!(sweep(&conn, now, &mut session, 0), 0);
        assert!(
            still_in_trash(&conn, &old),
            "the seeding run purges nothing"
        );
        assert_eq!(watermark(&conn), Some(now));

        assert_eq!(sweep(&conn, now, &mut session, 0), 1);
        assert!(!still_in_trash(&conn, &old));
    }

    /// Within one process the sweep clock is bounded by the session base
    /// (the watermark at the first sweep) + 1 day + real elapsed time, which
    /// a wall-clock jump cannot move: a +1 year jump, swept repeatedly,
    /// purges only what is due by that bound.
    #[test]
    fn purge_expired_trash_wall_clock_jump_is_bounded_by_session_base_plus_a_day_and_elapsed() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let day = 86_400;
        let elapsed = 3_600_u64;
        let bound = now + TRASH_SWEEP_MAX_ADVANCE_SECS + 3_600;
        let edge = trashed_at_offset(&conn, &jid, "Edge", bound - TRASH_RETENTION_SECS);
        let past = trashed_at_offset(&conn, &jid, "Past", bound - TRASH_RETENTION_SECS + 1);
        let fresh = trashed_at_offset(&conn, &jid, "Fresh", now);
        seed_watermark(&conn, now);
        let mut session = None;

        let year_later = now + 365 * day;
        assert_eq!(sweep(&conn, year_later, &mut session, elapsed), 1);
        assert!(!still_in_trash(&conn, &edge), "due by the bound");
        assert!(still_in_trash(&conn, &past), "beyond the bound: kept");
        assert!(still_in_trash(&conn, &fresh));
        assert_eq!(watermark(&conn), Some(bound));

        // Sweeping again (every clean pull does) does not advance it.
        for _ in 0..5 {
            assert_eq!(sweep(&conn, year_later, &mut session, elapsed), 0);
        }
        assert!(still_in_trash(&conn, &past));
        assert_eq!(watermark(&conn), Some(bound));
    }

    /// A long real gap (old watermark) is caught up at most 1 day (+ real
    /// elapsed time) per app launch, each launch rebasing on the watermark
    /// the previous one persisted.
    #[test]
    fn purge_expired_trash_long_gap_catches_up_at_most_a_day_per_launch() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let day = 86_400;
        let last = now - 90 * day;
        let first = trashed_at_offset(&conn, &jid, "First", last + day - TRASH_RETENTION_SECS);
        let second =
            trashed_at_offset(&conn, &jid, "Second", last + 2 * day - TRASH_RETENTION_SECS);
        let third = trashed_at_offset(
            &conn,
            &jid,
            "Third",
            last + 2 * day - TRASH_RETENTION_SECS + 1,
        );
        seed_watermark(&conn, last);

        let mut launch_one = None;
        assert_eq!(sweep(&conn, now, &mut launch_one, 0), 1);
        assert!(!still_in_trash(&conn, &first));
        assert!(still_in_trash(&conn, &second));
        assert_eq!(watermark(&conn), Some(last + day));

        let mut launch_two = None;
        assert_eq!(sweep(&conn, now, &mut launch_two, 0), 1);
        assert!(!still_in_trash(&conn, &second));
        assert!(still_in_trash(&conn, &third));
        assert_eq!(watermark(&conn), Some(last + 2 * day));
    }

    /// Normal operation: an app left running purges each entry on its due
    /// day as real time elapses.
    #[test]
    fn purge_expired_trash_daily_runs_purge_on_the_due_day() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let day = 86_400;
        let due_tomorrow = trashed_at_offset(&conn, &jid, "Tomorrow", now - 29 * day);
        let due_in_two = trashed_at_offset(&conn, &jid, "Two", now - 28 * day);
        seed_watermark(&conn, now);
        let mut session = None;

        assert_eq!(sweep(&conn, now, &mut session, 0), 0);
        assert_eq!(sweep(&conn, now + day, &mut session, day as u64), 1);
        assert!(!still_in_trash(&conn, &due_tomorrow));
        assert!(still_in_trash(&conn, &due_in_two));
        assert_eq!(sweep(&conn, now + 2 * day, &mut session, 2 * day as u64), 1);
        assert!(!still_in_trash(&conn, &due_in_two));
    }

    /// A clock that steps back is honoured (never sweeps ahead of it), and
    /// the watermark is never lowered.
    #[test]
    fn purge_expired_trash_backward_clock_does_not_sweep_ahead_or_lower_the_watermark() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let day = 86_400;
        let id = trashed_at_offset(&conn, &jid, "Due at now+1d", now - 29 * day);
        seed_watermark(&conn, now);
        let mut session = None;

        assert_eq!(sweep(&conn, now + 5 * day, &mut session, 0), 1);
        assert!(!still_in_trash(&conn, &id));
        assert_eq!(watermark(&conn), Some(now + day));
        let back = trashed_at_offset(&conn, &jid, "Back", now - 29 * day + 60);
        assert_eq!(sweep(&conn, now, &mut session, 0), 0);
        assert!(still_in_trash(&conn, &back), "clock back: not due at `now`");
        assert_eq!(
            watermark(&conn),
            Some(now + day),
            "the watermark is never lowered"
        );
    }

    #[test]
    fn purge_expired_trash_ignores_lock_and_vault_visibility() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let locked = trashed_at_offset(&conn, &jid, "Locked", now - TRASH_RETENTION_SECS);
        let invisible = trashed_at_offset(&conn, &jid, "Invisible", now - TRASH_RETENTION_SECS);
        db::set_entry_locked(&conn, &locked, true).unwrap();
        db::set_entry_invisible(&conn, &invisible, true, Some("vault-a")).unwrap();
        seed_watermark(&conn, now - 60);

        assert_eq!(sweep(&conn, now, &mut None, 0), 2);
        for id in [&locked, &invisible] {
            let row = db::get_entry(&conn, id).unwrap().unwrap();
            assert!(row.is_deleted);
            assert_eq!(row.trashed_at, None);
        }
    }

    // The on-unlock tests go through `purge_expired_trash` (a fresh session
    // per call under test) with a watermark just behind `now`, so the sweep
    // is live and the 1-day bound does not cap it.
    #[test]
    fn purge_expired_trash_on_unlock_runs_only_without_active_sync() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let a = trashed_at_offset(&conn, &jid, "A", now - TRASH_RETENTION_SECS - 1);
        let b = trashed_at_offset(&conn, &jid, "B", now - TRASH_RETENTION_SECS - 1);
        seed_watermark(&conn, now - 60);

        // Sync configured and enabled: the post-pull hook owns the sweep.
        db::set_sync_provider(&conn, "local").unwrap();
        db::set_sync_enabled(&conn, true).unwrap();
        purge_expired_trash_on_unlock(&conn, now);
        assert!(still_in_trash(&conn, &a) && still_in_trash(&conn, &b));

        // Provider set but sync turned off: no cycle will run, so unlock sweeps.
        db::set_sync_enabled(&conn, false).unwrap();
        purge_expired_trash_on_unlock(&conn, now);
        assert!(!still_in_trash(&conn, &a) && !still_in_trash(&conn, &b));
    }

    #[test]
    fn purge_expired_trash_on_unlock_sweeps_when_no_provider_is_set() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let now = crate::utils::time::now_unix();
        let a = trashed_at_offset(&conn, &jid, "A", now - TRASH_RETENTION_SECS - 1);
        seed_watermark(&conn, now - 60);

        purge_expired_trash_on_unlock(&conn, now);

        assert_eq!(db::get_entry(&conn, &a).unwrap().unwrap().trashed_at, None);
    }

    #[test]
    fn empty_trash_impl_under_covered_leaves_locked_entries_alone() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let plain = new_entry(&conn, &jid, "Plain");
        let locked = new_entry(&conn, &jid, "Locked");
        db::set_entry_locked(&conn, &locked, true).unwrap();
        soft_delete_entry_impl(&conn, &plain).unwrap();
        soft_delete_entry_impl(&conn, &locked).unwrap();
        assert_eq!(
            list_trashed_entries_impl(&conn, LockedView::Covered, None)
                .unwrap()
                .len(),
            2,
            "Covered still lists the locked entry (redacted)"
        );

        assert_eq!(
            empty_trash_impl(&conn, &[plain, locked.clone()], LockedView::Covered, None).unwrap(),
            1,
            "Covered purges only what the user can actually read"
        );

        let remaining = list_trashed_entries_impl(&conn, LockedView::Revealed, None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, locked);
    }

    #[test]
    fn restore_entry_impl_requires_the_entry_to_be_visible_in_the_view() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let locked = new_entry(&conn, &jid, "Locked");
        let invisible = new_entry(&conn, &jid, "Invisible");
        db::set_entry_locked(&conn, &locked, true).unwrap();
        db::set_entry_invisible(&conn, &invisible, true, Some("vault-a")).unwrap();
        soft_delete_entry_impl(&conn, &locked).unwrap();
        soft_delete_entry_impl(&conn, &invisible).unwrap();
        let version = local_version(&conn, &locked);

        let not_found = not_in_trash(rusqlite::Error::QueryReturnedNoRows);
        assert_eq!(
            restore_entry_impl(&conn, &locked, LockedView::Hidden, None).unwrap_err(),
            not_found
        );
        assert_eq!(
            restore_entry_impl(&conn, &invisible, LockedView::Revealed, None).unwrap_err(),
            not_found
        );
        assert_eq!(
            restore_entry_impl(&conn, &invisible, LockedView::Revealed, Some("vault-b"))
                .unwrap_err(),
            not_found
        );
        assert_eq!(
            local_version(&conn, &locked),
            version,
            "refused: no pending"
        );
        assert!(db::get_entry(&conn, &locked).unwrap().unwrap().is_deleted);

        // Covered lists (and so restores) a locked entry; the vault match
        // makes the invisible one reachable.
        restore_entry_impl(&conn, &locked, LockedView::Covered, None).unwrap();
        restore_entry_impl(&conn, &invisible, LockedView::Hidden, Some("vault-a")).unwrap();
        assert!(!db::get_entry(&conn, &locked).unwrap().unwrap().is_deleted);
    }

    #[test]
    fn purge_entry_impl_requires_revealed_for_locked_and_the_active_vault() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let locked = new_entry(&conn, &jid, "Locked");
        let invisible = new_entry(&conn, &jid, "Invisible");
        let files = attach_two_media_with_files(&conn, &locked, tmp.path());
        db::set_entry_locked(&conn, &locked, true).unwrap();
        db::set_entry_invisible(&conn, &invisible, true, Some("vault-a")).unwrap();
        soft_delete_entry_impl(&conn, &locked).unwrap();
        soft_delete_entry_impl(&conn, &invisible).unwrap();

        let not_found = not_in_trash(rusqlite::Error::QueryReturnedNoRows);
        for view in [LockedView::Hidden, LockedView::Covered] {
            assert_eq!(
                purge_entry_impl(&conn, &locked, view, None).unwrap_err(),
                not_found
            );
        }
        assert_eq!(
            purge_entry_impl(&conn, &invisible, LockedView::Revealed, None).unwrap_err(),
            not_found
        );
        assert_eq!(db::get_media_for_entry(&conn, &locked).unwrap().len(), 2);
        assert!(files.iter().all(|f| f.exists()));
        assert!(db::get_entry(&conn, &locked)
            .unwrap()
            .unwrap()
            .trashed_at
            .is_some());

        purge_entry_impl(&conn, &locked, LockedView::Revealed, None).unwrap();
        purge_entry_impl(&conn, &invisible, LockedView::Hidden, Some("vault-a")).unwrap();
        assert_eq!(
            db::get_entry(&conn, &locked).unwrap().unwrap().trashed_at,
            None
        );
        assert_eq!(
            db::get_entry(&conn, &invisible)
                .unwrap()
                .unwrap()
                .trashed_at,
            None
        );
    }

    #[test]
    fn detect_language_after_save_leaves_a_trashed_entry_untouched() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let entry = create_entry_impl(&conn, &jid, Some("t"), Some(EN_PARAGRAPH), None, 0).unwrap();
        conn.execute(
            "UPDATE entries SET content_language = NULL WHERE id = ?1",
            [&entry.id],
        )
        .unwrap();
        soft_delete_entry_impl(&conn, &entry.id).unwrap();
        let before = db::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert!(
            crate::utils::language_detect::detect_language(
                before.content_text.as_deref().unwrap_or("")
            )
            .is_some(),
            "fixture text must be detectable or this test proves nothing"
        );
        let version = local_version(&conn, &entry.id);

        maybe_detect_language_after_save(&conn, &entry.id);

        let after = db::get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(after.content_language, None);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(local_version(&conn, &entry.id), version);
    }

    #[test]
    fn entry_writes_on_a_trashed_entry_are_refused_with_the_trash_message() {
        let state = make_state();
        let jid = journal_id(&state);
        let conn = state.lock().unwrap();
        let other_journal = db::create_journal(&conn, "Other", None).unwrap().id;
        let id = new_entry(&conn, &jid, "Original");
        soft_delete_entry_impl(&conn, &id).unwrap();
        let version = local_version(&conn, &id);
        let msg = trash_msg();

        let results: Vec<(&str, Result<(), String>)> = vec![
            (
                "update_entry",
                update_entry_impl(&conn, &id, Some("x"), None, None).map(|_| ()),
            ),
            (
                "save_entry_content",
                save_entry_content_impl(&conn, &id, b"yjs", "x", "x"),
            ),
            (
                "update_entry_emotion",
                update_entry_emotion_impl(&conn, &id, Some("good")).map(|_| ()),
            ),
            (
                "update_entry_language",
                update_entry_language_impl(&conn, &id, Some("en")).map(|_| ()),
            ),
            (
                "update_entry_location",
                update_entry_location_impl(&conn, &id, Some(1.0), Some(2.0), None, None)
                    .map(|_| ()),
            ),
            (
                "update_entry_weather",
                update_entry_weather_impl(&conn, &id, Some("sun"), None).map(|_| ()),
            ),
            (
                "toggle_favorite",
                toggle_favorite_impl(&conn, &id).map(|_| ()),
            ),
            ("update_entry_date", update_entry_date_impl(&conn, &id, 42)),
            (
                "move_entry_to_journal",
                move_entry_to_journal_impl(&conn, &id, &other_journal),
            ),
            (
                "mark_entry_date_user_edited",
                mark_entry_date_user_edited_impl(&conn, &id),
            ),
            (
                "snapshot_entry_version",
                snapshot_entry_version_impl(&conn, &id, b"v", "p").map(|_| ()),
            ),
        ];
        for (name, result) in results {
            assert_eq!(
                result.unwrap_err(),
                msg,
                "{name} must refuse a trashed entry"
            );
        }

        let e = db::get_entry(&conn, &id).unwrap().unwrap();
        assert_eq!(e.title.as_deref(), Some("Original"));
        assert_eq!(e.journal_id, jid);
        assert!(!e.is_favorite);
        assert_eq!(
            local_version(&conn, &id),
            version,
            "nothing re-marked pending"
        );
        assert!(db::list_entry_versions(&conn, &id).unwrap().is_empty());
    }

    #[test]
    fn entry_writes_on_a_missing_entry_report_not_found() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert_eq!(
            toggle_favorite_impl(&conn, "missing").unwrap_err(),
            db::queries::LiveEntryError::NotFound.to_string()
        );
    }

    #[test]
    fn update_entry_location_impl_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        ks.with_key(|_key| {
            let conn = state.lock()?;
            update_entry_location_impl(&conn, &id, Some(10.0), Some(20.0), Some("home"), None)?;
            Ok::<(), String>(())
        })
        .unwrap();
        let (local_version, _) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
    }

    #[test]
    fn toggle_favorite_impl_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        // After create, local_version = 1.
        {
            let conn = state.lock().unwrap();
            toggle_favorite_impl(&conn, &id).unwrap();
        }
        let (local_version, status) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
        assert_eq!(status, "pending");
    }

    #[test]
    fn update_entry_emotion_impl_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        ks.with_key(|_key| {
            let conn = state.lock()?;
            update_entry_emotion_impl(&conn, &id, Some("good"))?;
            Ok::<(), String>(())
        })
        .unwrap();
        let (local_version, _) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
    }

    #[test]
    fn create_entry_impl_is_atomic_rolls_back_on_sync_state_failure() {
        // If mark_entry_pending fails, the entry row must also be rolled back.
        // We simulate a failure by pre-populating a sync_state row for a
        // blocked id — but sync_state PK is entry_id which is unknown ahead
        // of insert, so instead we use a sibling approach: drop the
        // sync_state table, call create_entry_impl, and assert BOTH the
        // entry row and the implicit write are absent (i.e. nothing was
        // committed).
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        {
            let conn = state.lock().unwrap();
            conn.execute("DROP TABLE sync_state", []).unwrap();
        }

        let before: i64 = {
            let conn = state.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM entries WHERE journal_id = ?1",
                [&jid],
                |r| r.get(0),
            )
            .unwrap()
        };

        let result = ks.with_key(|_key| {
            let conn = state.lock()?;
            create_entry_impl(&conn, &jid, Some("x"), None, None, 1_700_000_000)
        });
        assert!(result.is_err(), "mark_entry_pending should fail");

        let after: i64 = {
            let conn = state.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM entries WHERE journal_id = ?1",
                [&jid],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            before, after,
            "entry row must be rolled back on sync_state failure"
        );
    }

    /// Regression: `update_entry_date` was missing a `mark_entry_pending`
    /// call, so date edits never entered the sync queue and were silently
    /// dropped on the remote machine.  The command now opens a transaction,
    /// updates `entry_date`, calls `mark_entry_pending`, and commits — the
    /// same pattern as every other mutation command.
    #[test]
    fn update_entry_date_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            update_entry_date_impl(&conn, &id, 1_700_086_400).unwrap();
        }
        let (local_version, status) = sync_row(&state, &id).unwrap();
        assert_eq!(
            status, "pending",
            "sync_status must be 'pending' after date edit"
        );
        assert_eq!(
            local_version, 2,
            "local_version must increment after date edit"
        );
    }

    /// Regression: `move_entry_to_journal` was missing a `mark_entry_pending`
    /// call, so journal moves never entered the sync queue and were silently
    /// dropped on the remote machine.  The command now opens a transaction,
    /// moves the entry, calls `mark_entry_pending`, and commits — the same
    /// pattern as every other mutation command.
    #[test]
    fn move_entry_to_journal_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let other_jid = {
            let conn = state.lock().unwrap();
            db::create_journal(&conn, "Destination", None).unwrap().id
        };
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        {
            let conn = state.lock().unwrap();
            move_entry_to_journal_impl(&conn, &id, &other_jid).unwrap();
        }
        let (local_version, status) = sync_row(&state, &id).unwrap();
        assert_eq!(
            status, "pending",
            "sync_status must be 'pending' after journal move"
        );
        assert_eq!(
            local_version, 2,
            "local_version must increment after journal move"
        );
    }

    #[test]
    fn update_entry_weather_impl_marks_pending() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let e = create_entry_impl(&conn, &jid, None, None, None, 1_700_000_000)?;
                Ok::<String, String>(e.id)
            })
            .unwrap();
        ks.with_key(|_key| {
            let conn = state.lock()?;
            update_entry_weather_impl(&conn, &id, Some("Sunny"), Some("clear"))?;
            Ok::<(), String>(())
        })
        .unwrap();
        let (local_version, _) = sync_row(&state, &id).unwrap();
        assert_eq!(local_version, 2);
    }

    #[test]
    fn content_text_is_plaintext_at_rest() {
        // This is the regression guardrail for the deliberate FTS5 trade-
        // off. `content_text` must be readable in the raw SQLite row — if
        // someone "fixes" the pipeline to encrypt it, FTS5 silently stops
        // matching and this test fires to force a conscious re-decision.
        // Phase 3: all fields including title/preview are plaintext — this
        // test remains valid and unchanged.

        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let marker = "content-text-plaintext-marker-abc123";
        let eid = ks
            .with_key(|_k| {
                let conn = state.lock()?;
                let e = db::create_entry(
                    &conn,
                    CreateEntryParams {
                        journal_id: &jid,
                        title: Some("t"),
                        content_text: Some(marker),
                        preview_text: Some("p"),
                        entry_date: 1_700_000_000,
                    },
                )
                .map_err(|e| e.to_string())?;
                Ok::<String, String>(e.id)
            })
            .unwrap();

        let conn = state.lock().unwrap();
        let raw: String = conn
            .query_row(
                "SELECT content_text FROM entries WHERE id = ?1",
                [&eid],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            raw, marker,
            "content_text MUST be plaintext at rest — this is the FTS5 \
             trade-off documented in docs/SPECIFICATION.md. If this test \
             fails, read the Phase 3 encryption design notes before \
             'fixing' the pipeline."
        );
    }

    // ── list_on_this_day (A2a) ───────────────────────────────────────────────

    #[test]
    fn list_on_this_day_inner_rejects_invalid_month() {
        let state = make_state();
        let ks = make_key_state();
        assert!(list_on_this_day_inner(&state, &ks, 0, 15).is_err());
        assert!(list_on_this_day_inner(&state, &ks, 13, 15).is_err());
    }

    #[test]
    fn list_on_this_day_inner_rejects_invalid_day() {
        let state = make_state();
        let ks = make_key_state();
        assert!(list_on_this_day_inner(&state, &ks, 6, 0).is_err());
        assert!(list_on_this_day_inner(&state, &ks, 6, 32).is_err());
    }

    #[test]
    fn list_on_this_day_inner_requires_unlock() {
        let state = make_state();
        let ks = EncryptionKeyState::new(); // locked
        let err = list_on_this_day_inner(&state, &ks, 6, 15).unwrap_err();
        assert!(
            err.contains("locked"),
            "locked state must surface 'locked' in error, got: {err}"
        );
    }

    // ── list_map_pins (C1) ────────────────────────────────────────────────

    /// Seed an entry with GPS coords and a plaintext location_label.
    /// Phase 3: location_label is stored directly — no encryption.
    fn seed_entry_with_location(
        state: &AppState,
        ks: &EncryptionKeyState,
        jid: &str,
        lat: f64,
        lon: f64,
        label: &str,
    ) -> String {
        ks.with_key(|_key| {
            let conn = state.lock()?;
            let e = db::create_entry(
                &conn,
                CreateEntryParams {
                    journal_id: jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE entries SET latitude = ?1, longitude = ?2, location_label = ?3 WHERE id = ?4",
                rusqlite::params![lat, lon, label, e.id],
            )
            .map_err(|err| err.to_string())?;
            Ok::<String, String>(e.id)
        })
        .unwrap()
    }

    fn seed_media_pin(state: &AppState, entry_id: &str, lat: f64, lon: f64) -> String {
        let conn = state.lock().unwrap();
        db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id,
                file_name: "pic.jpg",
                file_type: "image/jpeg",
                storage_path: "/tmp/pic.jpg",
                file_size: Some(1024),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: Some(lat),
                exif_longitude: Some(lon),
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn list_map_pins_inner_requires_unlock() {
        let state = make_state();
        let ks = EncryptionKeyState::new(); // locked
        let err = list_map_pins_inner(&state, &ks).unwrap_err();
        assert!(
            err.contains("locked"),
            "locked state must surface 'locked' in error, got: {err}"
        );
    }

    #[test]
    fn list_map_pins_inner_returns_merged_pins_with_labels() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry_id = seed_entry_with_location(&state, &ks, &jid, 10.0, 20.0, "Hanoi");
        let media_id = seed_media_pin(&state, &entry_id, 48.8566, 2.3522);

        let pins = list_map_pins_inner(&state, &ks).unwrap();

        let entry_pin = pins
            .iter()
            .find(|p| p.kind == "entry" && p.entry_id == entry_id)
            .expect("entry pin present");
        assert_eq!(
            entry_pin.id,
            format!("entry:{entry_id}"),
            "entry pin id must be the composite 'entry:{{uuid}}' form"
        );
        assert_eq!(entry_pin.latitude, 10.0);
        assert_eq!(entry_pin.longitude, 20.0);
        assert_eq!(
            entry_pin.label.as_deref(),
            Some("Hanoi"),
            "entry label must be the stored plaintext"
        );

        let photo_pin = pins
            .iter()
            .find(|p| p.kind == "photo" && p.entry_id == entry_id)
            .expect("photo pin present");
        assert_eq!(
            photo_pin.id,
            format!("photo:{media_id}"),
            "photo pin id must be the composite 'photo:{{uuid}}' form"
        );
        assert!(
            (photo_pin.latitude - 48.8566).abs() < 1e-9
                && (photo_pin.longitude - 2.3522).abs() < 1e-9
        );
        assert!(
            photo_pin.label.is_none(),
            "photo pins never carry a label in C1"
        );
    }

    #[test]
    fn list_map_pins_inner_orders_newest_created_first() {
        // Guards against an accidental ORDER BY flip in either source query
        // or a broken merge sort.
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let older = seed_entry_with_location(&state, &ks, &jid, 1.0, 2.0, "older");
        let newer = seed_entry_with_location(&state, &ks, &jid, 3.0, 4.0, "newer");
        // Force `older` to have an older created_at so the natural insert
        // order doesn't accidentally give the right answer.
        {
            let conn = state.lock().unwrap();
            conn.execute(
                "UPDATE entries SET created_at = ?1 WHERE id = ?2",
                rusqlite::params![1_000i64, older],
            )
            .unwrap();
            conn.execute(
                "UPDATE entries SET created_at = ?1 WHERE id = ?2",
                rusqlite::params![2_000i64, newer],
            )
            .unwrap();
        }
        let pins = list_map_pins_inner(&state, &ks).unwrap();
        assert_eq!(pins[0].entry_id, newer, "newest created_at must come first");
        assert_eq!(pins[1].entry_id, older);
    }

    #[test]
    fn list_map_pins_inner_soft_caps_at_1000() {
        // Direct-insert 1_500 entry rows with GPS to avoid the encryption
        // overhead — we're verifying the cap, not the decrypt path.
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        {
            let conn = state.lock().unwrap();
            for i in 0..1_500i64 {
                let id = format!("pin-{i:04}");
                conn.execute(
                    "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at, latitude, longitude) \
                     VALUES (?1, ?2, ?3, ?3, ?3, ?4, ?5)",
                    rusqlite::params![id, jid, 1_700_000_000 + i, 1.0, 2.0],
                )
                .unwrap();
            }
        }
        let pins = list_map_pins_inner(&state, &ks).unwrap();
        assert_eq!(
            pins.len(),
            super::MAP_PIN_SOFT_CAP,
            "result must be soft-capped at {}",
            super::MAP_PIN_SOFT_CAP
        );
    }

    // ── Version History (Phase 1) ───────────────────────────────────────────

    #[test]
    fn snapshot_entry_version_impl_roundtrip_sets_device_id() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("c"), None, 0).map(|e| e.id)
            })
            .unwrap();

        let version_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                snapshot_entry_version_impl(&conn, &entry_id, b"yjs-bytes", "preview")
            })
            .unwrap();

        let conn = state.lock().unwrap();
        let versions = db::list_entry_versions(&conn, &entry_id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, version_id);
        assert_eq!(versions[0].preview_text, "preview");
        assert!(!versions[0].device_id.is_empty());

        let blob = db::get_entry_version_blob(&conn, &version_id).unwrap();
        assert_eq!(blob, b"yjs-bytes".to_vec());
    }

    /// End-to-end wiring check: repeatedly snapshotting the same entry past
    /// the hidden cap must leave exactly `MAX_VERSIONS_PER_ENTRY` rows. This
    /// exercises the full impl (device-id resolution + insert + retention
    /// lookup + prune) in one transaction, not just the query layer in
    /// isolation — a wrong constant or a broken transaction wiring here
    /// would not be caught by the `db::queries` unit tests alone.
    #[test]
    fn snapshot_entry_version_impl_prunes_beyond_cap() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("t"), Some("c"), None, 0).map(|e| e.id)
            })
            .unwrap();

        for i in 0..(db::MAX_VERSIONS_PER_ENTRY + 5) {
            ks.with_key(|_key| {
                let conn = state.lock()?;
                snapshot_entry_version_impl(&conn, &entry_id, b"v", &format!("v{i}"))
            })
            .unwrap();
        }

        let conn = state.lock().unwrap();
        let versions = db::list_entry_versions(&conn, &entry_id).unwrap();
        assert_eq!(versions.len() as i64, db::MAX_VERSIONS_PER_ENTRY);
    }

    /// `get_entry_version_blob_for_entry` must reject a version id that
    /// belongs to a DIFFERENT entry — this is the fix for the version
    /// content command not being scoped by entry_id. Correct pairing still
    /// returns the blob.
    #[test]
    fn get_entry_version_blob_for_entry_rejects_wrong_entry_id() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let (entry_a, entry_b) = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                let a = create_entry_impl(&conn, &jid, Some("a"), Some("ca"), None, 0)?.id;
                let b = create_entry_impl(&conn, &jid, Some("b"), Some("cb"), None, 0)?.id;
                Ok((a, b))
            })
            .unwrap();

        let version_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                snapshot_entry_version_impl(&conn, &entry_a, b"a-bytes", "preview-a")
            })
            .unwrap();

        let conn = state.lock().unwrap();

        // Wrong entry_id must be rejected.
        let err = db::get_entry_version_blob_for_entry(&conn, &version_id, &entry_b).unwrap_err();
        assert!(matches!(err, rusqlite::Error::QueryReturnedNoRows));

        // Correct entry_id returns the blob.
        let blob = db::get_entry_version_blob_for_entry(&conn, &version_id, &entry_a).unwrap();
        assert_eq!(blob, b"a-bytes".to_vec());
    }

    /// Phase 7 leak audit: version list/content must not return invisible
    /// entry data while the vault session is locked (or under the wrong vault).
    #[test]
    fn list_and_get_entry_versions_hide_invisible_unless_active_vault() {
        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        let entry_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                create_entry_impl(&conn, &jid, Some("secret"), Some("body"), None, 0).map(|e| e.id)
            })
            .unwrap();

        let version_id = ks
            .with_key(|_key| {
                let conn = state.lock()?;
                snapshot_entry_version_impl(&conn, &entry_id, b"yjs-secret", "preview secret")
            })
            .unwrap();

        {
            let conn = state.lock().unwrap();
            db::set_entry_invisible(&conn, &entry_id, true, Some("vault-a")).unwrap();
        }

        let conn = state.lock().unwrap();

        // Session locked: no metadata, no blob.
        assert!(list_entry_versions_impl(&conn, &entry_id, None)
            .unwrap()
            .is_empty());
        assert!(get_entry_version_content_impl(&conn, &version_id, &entry_id, None).is_err());

        // Wrong vault: still hidden.
        assert!(list_entry_versions_impl(&conn, &entry_id, Some("vault-b"))
            .unwrap()
            .is_empty());
        assert!(
            get_entry_version_content_impl(&conn, &version_id, &entry_id, Some("vault-b")).is_err()
        );

        // Correct vault: full access.
        let listed = list_entry_versions_impl(&conn, &entry_id, Some("vault-a")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, version_id);
        assert_eq!(listed[0].preview_text, "preview secret");
        let blob =
            get_entry_version_content_impl(&conn, &version_id, &entry_id, Some("vault-a")).unwrap();
        assert_eq!(blob, b"yjs-secret".to_vec());
    }
}
