use crate::db::{self, Tag};

/// Shared by the `delete_tag` command and the web-outbox importer.
#[doc(hidden)]
pub fn delete_tag_impl(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    db::delete_tag(conn, id).map_err(|e| e.to_string())
}

/// Error from [`update_tag_impl`]. `NameTaken` lets the web-outbox importer
/// refuse a rename clash as `name_taken`; its text is what the UI shows.
#[derive(Debug, thiserror::Error)]
#[doc(hidden)]
pub enum UpdateTagError {
    #[error("A tag with that name already exists")]
    NameTaken,
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}

/// Shared by the `update_tag` command and the web-outbox importer.
#[doc(hidden)]
pub fn update_tag_impl(
    conn: &rusqlite::Connection,
    id: &str,
    name: Option<&str>,
    color: Option<Option<&str>>,
) -> Result<Tag, UpdateTagError> {
    db::update_tag(conn, id, name, color).map_err(|e| {
        let msg = e.to_string();
        // SQLite raises "UNIQUE constraint failed: tags.name" on rename clash.
        // Surface a friendly message so the UI doesn't need to parse SQL errors.
        if msg.contains("UNIQUE constraint failed") && msg.contains("tags.name") {
            UpdateTagError::NameTaken
        } else {
            UpdateTagError::Db(e)
        }
    })
}
