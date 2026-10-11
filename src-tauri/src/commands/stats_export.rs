//! Statistics export — universal byte sink for files chosen via the
//! native save dialog on the frontend.
//!
//! The frontend builds the entire payload (CSV / JSON / HTML / PNG zip
//! / PDF) and hands the resulting bytes plus the user-selected path to
//! this command. Keeping the writer here means we don't need to ship
//! `tauri-plugin-fs` or widen frontend filesystem permissions just to
//! drop a file the user explicitly picked.

use std::fs;
use std::path::Path;

/// Write the supplied bytes to `path`, creating parent directories
/// as needed.
///
/// Errors are surfaced as plain `String`s so the frontend can render
/// them inline in the export modal. The command refuses an empty path
/// (defensive — the Tauri dialog should never return one, but a
/// programmer mistake should not silently produce a file at `cwd`).
#[tauri::command]
pub fn export_stats_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Export path is empty".to_string());
    }

    let p = Path::new(trimmed);

    // Create parent directories if missing. The Tauri save dialog
    // always returns a full path inside an existing directory, but a
    // user pasting a custom path through future UI affordances might
    // not — and `fs::write` would fail with a confusing "No such file
    // or directory" otherwise.
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
        }
    }

    fs::write(p, &bytes).map_err(|e| format!("Failed to write {}: {e}", p.display()))?;
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_path() {
        let err = export_stats_file(String::new(), b"x".to_vec()).unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[test]
    fn rejects_whitespace_path() {
        let err = export_stats_file("   ".to_string(), b"x".to_vec()).unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }
}
