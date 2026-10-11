use tauri::State;

use crate::db;
use crate::db::queries::Reminder;
use crate::AppState;

/// Validate user input for create/update.
///
/// - `time_of_day` must be `HH:MM` in `00:00..=23:59`.
/// - `weekdays` is a 7-bit bitmask; at least one bit must be set (`1..=127`).
fn validate_reminder_input(_label: &str, time_of_day: &str, weekdays: i64) -> Result<(), String> {
    // Label is optional — no validation needed.
    let parts: Vec<&str> = time_of_day.split(':').collect();
    if parts.len() != 2
        || parts[0].parse::<u8>().map_or(true, |h| h > 23)
        || parts[1].parse::<u8>().map_or(true, |m| m > 59)
    {
        return Err("time_of_day must be HH:MM (00:00-23:59)".to_string());
    }
    if !(1..=127).contains(&weekdays) {
        return Err("weekdays bitmask must be in 1..=127 (at least one day)".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn list_reminders(state: State<'_, AppState>) -> Result<Vec<Reminder>, String> {
    let conn = state.lock()?;
    db::list_reminders(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_reminder(
    state: State<'_, AppState>,
    label: String,
    time_of_day: String,
    weekdays: i64,
) -> Result<Reminder, String> {
    validate_reminder_input(&label, &time_of_day, weekdays)?;
    let conn = state.lock()?;
    db::create_reminder(&conn, &label, &time_of_day, weekdays).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_reminder(
    state: State<'_, AppState>,
    id: String,
    label: String,
    time_of_day: String,
    weekdays: i64,
    enabled: bool,
) -> Result<Reminder, String> {
    validate_reminder_input(&label, &time_of_day, weekdays)?;
    let conn = state.lock()?;
    db::update_reminder(&conn, &id, &label, &time_of_day, weekdays, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_reminder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_reminder(&conn, &id).map_err(|e| e.to_string())
}
