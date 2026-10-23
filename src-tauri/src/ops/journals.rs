use crate::db::{self, Journal};

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

// FK violation on `journal_auto_tags(tag_id)` happens when the caller passes a
// tag id that no longer exists. SQLite's default text is "FOREIGN KEY
// constraint failed".
pub(crate) fn is_fk_violation(e: &rusqlite::Error) -> bool {
    e.to_string().contains("FOREIGN KEY constraint failed")
}
