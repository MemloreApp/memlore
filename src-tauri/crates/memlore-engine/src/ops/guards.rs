use rusqlite::Connection;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Transact, Update};

use crate::db;

/// Static not-found. Never interpolate entry body into the message (Risk 7).
#[doc(hidden)]
pub const ENTRY_NOT_FOUND: &str = "Entry not found.";

/// Same gate as the read path: invisible/deleted → not-found; locked →
/// not-found even when `ai_embed_include_protected` is on.
#[doc(hidden)]
pub fn require_writable_entry(conn: &Connection, id: &str) -> Result<db::Entry, String> {
    let entry = db::get_entry_for_provider(conn, id).map_err(|e| e.to_string())?;
    let Some(entry) = entry else {
        return Err(ENTRY_NOT_FOUND.to_string());
    };
    if entry.is_locked {
        return Err(ENTRY_NOT_FOUND.to_string());
    }
    Ok(entry)
}

#[doc(hidden)]
pub fn visible_journal(conn: &Connection, id: &str) -> Result<Option<(String, String)>, String> {
    match db::get_journal(conn, id).map_err(|e| e.to_string())? {
        Some(j) if !j.is_deleted && !j.is_invisible => Ok(Some((j.id, j.name))),
        _ => Ok(None),
    }
}

#[doc(hidden)]
pub fn validate_emotion(emotion: Option<&str>) -> Result<(), String> {
    match emotion {
        None | Some("bad") | Some("neutral") | Some("good") => Ok(()),
        Some(value) => Err(format!("invalid emotion: {value}")),
    }
}

#[doc(hidden)]
pub fn load_yjs_doc(blob: Option<&[u8]>) -> Result<Doc, String> {
    let doc = Doc::new();
    if let Some(bytes) = blob.filter(|b| !b.is_empty()) {
        let update = Update::decode_v1(bytes).map_err(|e| e.to_string())?;
        let mut txn = doc.transact_mut();
        txn.apply_update(update).map_err(|e| e.to_string())?;
    }
    Ok(doc)
}
