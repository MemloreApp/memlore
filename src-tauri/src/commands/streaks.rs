use tauri::State;

use crate::db::{self, StreakInfo};
use crate::AppState;

/// Return the cached streak info. Reads from streak_cache without
/// recalculating. Fast — suitable for display on app load.
#[tauri::command]
pub fn get_streak(state: State<'_, AppState>) -> Result<StreakInfo, String> {
    let conn = state.lock()?;
    db::get_streak_cache(&conn).map_err(|e| e.to_string())
}

/// Scan all non-deleted entries, recompute streak, persist to streak_cache,
/// and return the updated values.
#[tauri::command]
pub fn recalculate_streak(state: State<'_, AppState>) -> Result<StreakInfo, String> {
    let conn = state.lock()?;
    db::recalculate_streak(&conn).map_err(|e| e.to_string())
}
