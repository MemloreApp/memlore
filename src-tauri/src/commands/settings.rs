use tauri::State;

use crate::db;
use crate::AppState;

/// Get a setting value by key. Returns None if the key does not exist.
#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.lock()?;
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

/// Set a setting key/value pair. Upserts on conflict.
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

/// Remove a setting by key. No-op if the key does not exist.
#[tauri::command]
pub fn delete_setting(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_setting(&conn, &key).map_err(|e| e.to_string())
}
