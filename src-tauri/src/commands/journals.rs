use tauri::State;

use crate::db::{self, Journal, Tag};
use crate::AppState;

/// Payload for `create_journal`. Uses a struct (rather than positional args)
/// so we can grow optional fields without breaking the JS call sites and so
/// serde field attributes propagate. `auto_tag_ids` defaults to empty —
/// auto-apply is opt-in.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJournalPayload {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub auto_tag_ids: Vec<String>,
}

/// Payload for `update_journal`. `auto_tag_ids` is `Option<Vec<String>>`:
/// - absent (`None`)        → leave the auto-apply set unchanged.
/// - present (`Some(vec)`)  → replace the auto-apply set with `vec` (empty
///                            vec = disable auto-apply entirely).
///
/// We don't need the `double_option` trick here because `Vec<String>`
/// already encodes "disable" as `[]` — there's no ambiguous third state.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJournalPayload {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub auto_tag_ids: Option<Vec<String>>,
}

/// Create a new journal. Returns the created journal. Auto-apply tags
/// (if any) are written in the same transaction.
#[tauri::command]
pub fn create_journal(
    state: State<'_, AppState>,
    payload: CreateJournalPayload,
) -> Result<Journal, String> {
    let conn = state.lock()?;
    let journal = db::create_journal(&conn, &payload.name, payload.color.as_deref())
        .map_err(|e| e.to_string())?;
    if !payload.auto_tag_ids.is_empty() {
        db::set_journal_auto_tags(&conn, &journal.id, &payload.auto_tag_ids)
            .map_err(map_set_auto_tags_err)?;
    }
    Ok(journal)
}

/// List all journals. Invisible journals are omitted while no vault session
/// is active (`active_vault_id = None`); when `Some(V)`, only journals in
/// vault V (plus non-invisible) are returned.
#[tauri::command]
pub fn list_journals(
    state: State<'_, AppState>,
    active_vault_id: Option<String>,
) -> Result<Vec<Journal>, String> {
    let conn = state.lock()?;
    db::list_journals(&conn, active_vault_id.as_deref()).map_err(|e| e.to_string())
}

/// Get a single journal by id. Returns None if not found, or if the journal
/// is invisible and not in the active vault (mirrors `get_entry` deniability).
#[tauri::command]
pub fn get_journal(
    state: State<'_, AppState>,
    id: String,
    active_vault_id: Option<String>,
) -> Result<Option<Journal>, String> {
    get_journal_impl(&state, &id, active_vault_id.as_deref())
}

/// Shared by the Tauri command and tests so the vault gate cannot drift
/// from what production actually runs.
fn get_journal_impl(
    state: &AppState,
    id: &str,
    active_vault_id: Option<&str>,
) -> Result<Option<Journal>, String> {
    let conn = state.lock()?;
    if !db::is_journal_visible_for_active_vault(&conn, id, active_vault_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    db::get_journal(&conn, id).map_err(|e| e.to_string())
}

/// Update a journal's name, color, and (optionally) auto-apply tags.
/// Returns the updated journal.
///
/// `db::update_journal` and `db::set_journal_auto_tags` each mark the
/// journal pending on the journal sync channel, so the change rides out
/// to peers on the next tick without needing to re-push every entry.
#[tauri::command]
pub fn update_journal(
    state: State<'_, AppState>,
    payload: UpdateJournalPayload,
) -> Result<Journal, String> {
    let conn = state.lock()?;
    update_journal_impl(
        &conn,
        &payload.id,
        &payload.name,
        payload.color.as_deref(),
        payload.auto_tag_ids.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// Error from [`update_journal_impl`] / [`delete_journal_impl`]. The validation
/// variants let the web-outbox importer refuse an intent for good instead of
/// retrying it every cycle; their text is what the UI shows.
#[derive(Debug, thiserror::Error)]
pub(crate) enum JournalImplError {
    #[error("One of the selected tags no longer exists")]
    UnknownTag,
    #[error("Cannot delete the last journal")]
    LastJournal,
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}

/// Shared by the `update_journal` command and the web-outbox importer.
///
/// The rename and the auto-tag swap commit in ONE transaction, so an error in
/// the swap (an unknown tag) rolls the rename back too. Each write marks the
/// journal pending, so `local_version` advances twice when `auto_tag_ids` is
/// `Some` — same as before the extraction.
/// The returned journal is read before the auto-tag write bumps `updated_at`.
pub(crate) fn update_journal_impl(
    conn: &rusqlite::Connection,
    id: &str,
    name: &str,
    color: Option<&str>,
    auto_tag_ids: Option<&[String]>,
) -> Result<Journal, JournalImplError> {
    let tx = conn.unchecked_transaction()?;
    let journal = db::update_journal(&tx, id, name, color)?;
    if let Some(tag_ids) = auto_tag_ids {
        db::set_journal_auto_tags_in_tx(&tx, &journal.id, tag_ids).map_err(|e| {
            if is_fk_violation(&e) {
                JournalImplError::UnknownTag
            } else {
                JournalImplError::Db(e)
            }
        })?;
    }
    tx.commit()?;
    Ok(journal)
}

/// Delete a journal permanently. Returns an error if this is the last journal.
#[tauri::command]
pub fn delete_journal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    let media_paths = delete_journal_impl(&conn, &id).map_err(|e| e.to_string())?;
    // Release the global DB lock BEFORE the (potentially large) filesystem
    // cleanup so bulk unlinks don't block every other Tauri command. The DB
    // transaction already committed inside `delete_journal`.
    drop(conn);
    // Best-effort disk cleanup, only after the DB change committed.
    for (storage_path, thumbnail_path) in &media_paths {
        crate::commands::media::remove_media_files_best_effort(
            storage_path,
            thumbnail_path.as_deref(),
        );
    }
    // Re-arm the throttled own-cloud media prune so the next automatic sync
    // sweeps the deleted journal's now-orphaned cloud media blobs.
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(())
}

/// Shared by the `delete_journal` command and the web-outbox importer.
/// Refuses the last journal; the count uses `list_journals(conn, None)`, so
/// invisible-vault journals do not count. Returns the deleted media rows'
/// `(storage_path, thumbnail_path)` pairs. The DB change has committed when
/// this returns; the CALLER must then unlink those files (best effort) and
/// call `reset_session_own_cloud_reconciled`, as `delete_journal` does.
pub(crate) fn delete_journal_impl(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<Vec<(String, Option<String>)>, JournalImplError> {
    if db::list_journals(conn, None)?.len() <= 1 {
        return Err(JournalImplError::LastJournal);
    }
    Ok(db::delete_journal(conn, id)?)
}

/// List the tags currently configured as auto-apply for `journal_id`.
/// Ordered by tag name ASC.
#[tauri::command]
pub fn list_journal_auto_tags(
    state: State<'_, AppState>,
    journal_id: String,
) -> Result<Vec<Tag>, String> {
    let conn = state.lock()?;
    db::list_journal_auto_tags(&conn, &journal_id).map_err(|e| e.to_string())
}

// FK violation on `journal_auto_tags(tag_id)` happens when the caller passes a
// tag id that no longer exists. SQLite's default text is "FOREIGN KEY
// constraint failed".
fn is_fk_violation(e: &rusqlite::Error) -> bool {
    e.to_string().contains("FOREIGN KEY constraint failed")
}

fn map_set_auto_tags_err(e: rusqlite::Error) -> String {
    // Surface something more actionable than SQLite's text.
    if is_fk_violation(&e) {
        JournalImplError::UnknownTag.to_string()
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use crate::db::{self, schema::migrate};
    use crate::AppState;
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    /// Phase 7 leak audit: by-id journal fetch must not return invisible
    /// journals unless the matching vault is active.
    #[test]
    fn get_journal_command_hides_invisible_unless_active_vault() {
        let state = make_state();
        let (public_id, invisible_id) = {
            let conn = state.lock().unwrap();
            let public = db::create_journal(&conn, "Public", None).unwrap();
            let invisible = db::create_journal(&conn, "Secret vault journal", None).unwrap();
            db::set_journal_invisible(&conn, &invisible.id, true, Some("vault-a")).unwrap();
            (public.id, invisible.id)
        };

        // Session locked.
        assert!(
            super::get_journal_impl(&state, &public_id, None)
                .unwrap()
                .is_some(),
            "public journal stays visible"
        );
        assert!(
            super::get_journal_impl(&state, &invisible_id, None)
                .unwrap()
                .is_none(),
            "invisible journal must not leak while locked"
        );

        // Wrong vault.
        assert!(
            super::get_journal_impl(&state, &invisible_id, Some("vault-b"))
                .unwrap()
                .is_none()
        );

        // Matching vault.
        let revealed = super::get_journal_impl(&state, &invisible_id, Some("vault-a"))
            .unwrap()
            .expect("visible under matching vault");
        assert!(revealed.is_invisible);
        assert_eq!(revealed.vault_id.as_deref(), Some("vault-a"));
    }

    #[test]
    fn delete_last_journal_returns_error() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let journals = db::list_journals(&conn, None).unwrap();
        assert_eq!(
            journals.len(),
            1,
            "migration should seed exactly one default journal"
        );
        let result = super::delete_journal_impl(&conn, &journals[0].id);
        assert!(
            matches!(result, Err(super::JournalImplError::LastJournal)),
            "should reject deleting the last journal"
        );
    }

    /// An unknown auto-tag id is a validation error, not a DB failure: the web-outbox
    /// importer refuses it for good instead of retrying it every cycle. The rename rolls
    /// back with it, so a refused or retried intent never leaves half its update applied.
    #[test]
    fn update_journal_with_unknown_auto_tag_is_a_validation_error() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();
        let result = super::update_journal_impl(
            &conn,
            &j.id,
            "Renamed",
            None,
            Some(&["no-such-tag".into()]),
        );
        assert!(
            matches!(result, Err(super::JournalImplError::UnknownTag)),
            "{result:?}"
        );
        let after = db::get_journal(&conn, &j.id).unwrap().unwrap();
        assert_eq!(after.name, "J", "the rename rolled back with the auto-tags");
        assert_eq!(after.updated_at, j.updated_at);
    }

    // ── Auto-apply tags ──────────────────────────────────────────────────────

    #[test]
    fn set_and_list_journal_auto_tags() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "a", None).unwrap();
        let t2 = db::create_tag(&conn, "b", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();

        db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        let mut got = ids.clone();
        got.sort();
        let mut want = vec![t1.id.clone(), t2.id.clone()];
        want.sort();
        assert_eq!(got, want);

        // The Tag variant returns them ordered by name ASC.
        let tags = db::list_journal_auto_tags(&conn, &j.id).unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "a");
        assert_eq!(tags[1].name, "b");
    }

    #[test]
    fn set_journal_auto_tags_replaces_existing() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "old1", None).unwrap();
        let t2 = db::create_tag(&conn, "old2", None).unwrap();
        let t3 = db::create_tag(&conn, "new", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();

        db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();
        db::set_journal_auto_tags(&conn, &j.id, &[t3.id.clone()]).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        assert_eq!(ids, vec![t3.id]);
    }

    #[test]
    fn set_journal_auto_tags_empty_clears_all() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "t", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();
        db::set_journal_auto_tags(&conn, &j.id, &[t1.id]).unwrap();

        db::set_journal_auto_tags(&conn, &j.id, &[]).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        assert!(ids.is_empty());
    }

    #[test]
    fn delete_tag_cascades_into_journal_auto_tags() {
        let state = make_state();
        // Enable FK enforcement so the ON DELETE CASCADE actually fires.
        // `migrate()` runs `PRAGMA foreign_keys = ON;` already, but the
        // pragma is per-connection — the test's connection inherits it via
        // make_state(), so this is just a belt-and-braces assertion.
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "doomed", None).unwrap();
        let t2 = db::create_tag(&conn, "survivor", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();
        db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();

        db::delete_tag(&conn, &t1.id).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        assert_eq!(ids, vec![t2.id], "FK CASCADE should drop the deleted tag");
    }
}
