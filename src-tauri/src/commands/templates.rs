use tauri::State;

use crate::db::{self, Template};
use crate::AppState;

#[tauri::command]
pub fn create_template(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    content: Option<Vec<u8>>,
) -> Result<Template, String> {
    let conn = state.lock()?;
    db::create_template(&conn, &name, description.as_deref(), content.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_templates(state: State<'_, AppState>) -> Result<Vec<Template>, String> {
    let conn = state.lock()?;
    db::list_templates(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_template(state: State<'_, AppState>, id: String) -> Result<Option<Template>, String> {
    let conn = state.lock()?;
    db::get_template(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_template(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
    content: Option<Vec<u8>>,
) -> Result<Template, String> {
    let conn = state.lock()?;
    db::update_template(
        &conn,
        &id,
        &name,
        description.as_deref(),
        content.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_template(&conn, &id).map_err(|e| e.to_string())
}
