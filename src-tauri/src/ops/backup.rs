//! Complete recovery-compatible `.memlore.zip` backup, plus the export
//! manifest/summary types and zip helpers it shares with the user-facing
//! export in `commands::export`. No Tauri types: the caller supplies the
//! `app_version` written to `manifest.json` (desktop passes its package
//! version; the engine passes `ops::app_info::app_version()`).

use std::io::Write as _;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::db;

// ─── Schema version ──────────────────────────────────────────────────────────

// Version 2: Phase 3 encryption redesign — all entry columns are plaintext at
// the application layer (SQLCipher provides at-rest encryption). Exports produced
// by v1 builds contained per-field AES-GCM ciphertext in title/preview_text/etc.;
// importing those into a Phase-3 DB would store ciphertext as displayable text.
pub(crate) const SCHEMA_VERSION: u32 = 2;

// ─── Output structs ───────────────────────────────────────────────────────────

/// Written to `manifest.json` inside the ZIP.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportManifest {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub entry_count: u64,
    pub journal_count: u64,
    pub tag_count: u64,
    pub media_count: u64,
}

/// Returned to the frontend after a successful export.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportSummary {
    pub entry_count: u64,
    pub journal_count: u64,
    pub tag_count: u64,
    pub media_count: u64,
    pub media_skipped: u64,
}

// ─── ISO 8601 UTC formatter (no chrono dep) ───────────────────────────────────

/// Format a Unix timestamp (seconds) as `YYYY-MM-DDTHH:MM:SSZ`.
/// Uses the proleptic Gregorian calendar algorithm (correct for all dates from
/// the Unix epoch forward).
pub(crate) fn format_iso8601_utc(unix_secs: u64) -> String {
    let secs_in_day = 86400u64;
    let days_since_epoch = unix_secs / secs_in_day;
    let time_of_day = unix_secs % secs_in_day;

    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    // Gregorian calendar: days since 1970-01-01 → (year, month, day).
    // Algorithm from https://howardhinnant.github.io/date_algorithms.html#civil_from_days
    let z = days_since_epoch as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

// ─── Recovery backup ──────────────────────────────────────────────────────────

/// Returns `true` if `s` is safe to use as a zip entry path component:
/// no path separators, no null bytes, non-empty, length ≤ 255.
pub(crate) fn is_safe_zip_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
        && !s.contains("..")
}

/// Write a complete recovery-compatible `.memlore.zip` containing
/// `full_snapshot.json` plus every media original. Media IDs present in
/// `path_overrides` are read from the override path (used for cloud-only
/// originals staged during local-authoritative preflight). Missing override
/// and empty/missing `storage_path` rows are hard errors — recovery backup
/// must be complete, unlike the user-facing export which skips gaps.
///
/// `db_key`: when `Some`, `full_snapshot.json` — the only member containing
/// decrypted entry text/titles/tags/locations, i.e. the same content
/// SQLCipher protects in the live DB — is AES-256-GCM encrypted (via
/// `utils::encryption::encrypt_data`, the same primitive used elsewhere in
/// the app) and stored as `full_snapshot.json.enc` instead.
///
/// **Always-encrypted note:** every vault now has a `db_key`, so production
/// callers always pass `Some`. The `None` arm (plaintext `full_snapshot.json`)
/// is unreachable in production — every caller resolves the key via
/// `EncryptionKeyState::with_db_key` and returns early on `Err`. It is kept
/// only so tests can exercise the member-name dispatch.
/// This mirrors `write_preserved_device_local_state`'s
/// `db_key: Option<&[u8; 32]>` pattern, except member-name dispatch is used
/// instead of a 1-byte envelope so the plaintext path can keep using
/// `read_optional_json_by_name` unchanged on the import side.
///
/// `manifest.json` and `media/*` are NOT encrypted: `manifest.json` is only
/// counts/schema metadata, and media originals are copied verbatim from
/// `storage_path` (or `path_overrides`), so they carry exactly the same
/// at-rest exposure in the backup as the live media directory already has —
/// no new exposure is introduced there.
pub fn write_complete_memlore_backup(
    conn: &rusqlite::Connection,
    dest: &std::path::Path,
    path_overrides: &std::collections::HashMap<String, PathBuf>,
    db_key: Option<&[u8; 32]>,
    app_version: &str,
) -> Result<ExportSummary, String> {
    let dest_path = dest.to_path_buf();
    let tmp_path = {
        let mut p = dest_path.clone();
        let mut name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recovery")
            .to_string();
        name.push_str(".tmp");
        p.set_file_name(name);
        p
    };

    let result = (|| -> Result<ExportSummary, String> {
        if let Some(parent) = tmp_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create backup directory: {e}"))?;
        }
        let file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create recovery backup file: {e}"))?;
        let mut zip = ZipWriter::new(file);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let snapshot =
            db::export_full_snapshot(conn).map_err(|e| format!("snapshot export: {e}"))?;
        let snapshot_json =
            serde_json::to_vec(&snapshot).map_err(|e| format!("full_snapshot serialize: {e}"))?;
        let (snapshot_member, snapshot_bytes) = match db_key {
            Some(key) => {
                let encrypted = crate::utils::encryption::encrypt_data(key, &snapshot_json)
                    .map_err(|e| format!("encrypt full_snapshot.json: {e}"))?;
                ("full_snapshot.json.enc", encrypted)
            }
            None => ("full_snapshot.json", snapshot_json),
        };
        zip.start_file(snapshot_member, opts)
            .map_err(|e| format!("zip start {snapshot_member}: {e}"))?;
        zip.write_all(&snapshot_bytes)
            .map_err(|e| format!("zip write {snapshot_member}: {e}"))?;

        let media_rows =
            db::list_backup_media_files(conn).map_err(|e| format!("list media: {e}"))?;
        let mut media_count = 0u64;
        for m in &media_rows {
            let ext = std::path::Path::new(&m.file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin")
                .to_string();
            if !is_safe_zip_component(&m.id) || !is_safe_zip_component(&ext) {
                return Err(format!(
                    "recovery backup cannot include media {} — unsafe id or extension",
                    m.id
                ));
            }
            let source = path_overrides
                .get(&m.id)
                .map(|p| p.as_path())
                .unwrap_or_else(|| std::path::Path::new(&m.storage_path));
            let file_bytes = std::fs::read(source).map_err(|e| {
                format!(
                    "recovery backup missing media {} at {}: {e}",
                    m.id,
                    source.display()
                )
            })?;
            let zip_path = format!("media/{}.{}", m.id, ext);
            zip.start_file(&zip_path, opts)
                .map_err(|e| format!("zip start {zip_path}: {e}"))?;
            zip.write_all(&file_bytes)
                .map_err(|e| format!("zip write {zip_path}: {e}"))?;
            media_count += 1;
        }

        let journals = db::list_journals(conn, None).map_err(|e| e.to_string())?;
        let tags = db::list_tags(conn, None).map_err(|e| e.to_string())?;
        let entries = db::list_all_entries(conn).map_err(|e| e.to_string())?;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("System clock error: {e}"))?
            .as_secs();
        let manifest = ExportManifest {
            schema_version: SCHEMA_VERSION,
            exported_at: format_iso8601_utc(now_secs),
            app_version: app_version.to_string(),
            entry_count: entries.len() as u64,
            journal_count: journals.len() as u64,
            tag_count: tags.len() as u64,
            media_count,
        };
        let manifest_json =
            serde_json::to_vec_pretty(&manifest).map_err(|e| format!("manifest serialize: {e}"))?;
        zip.start_file("manifest.json", opts)
            .map_err(|e| format!("zip start manifest.json: {e}"))?;
        zip.write_all(&manifest_json)
            .map_err(|e| format!("zip write manifest.json: {e}"))?;
        zip.finish().map_err(|e| format!("zip finish: {e}"))?;

        Ok(ExportSummary {
            entry_count: entries.len() as u64,
            journal_count: journals.len() as u64,
            tag_count: tags.len() as u64,
            media_count,
            media_skipped: 0,
        })
    })();

    match result {
        Ok(summary) => {
            std::fs::rename(&tmp_path, &dest_path)
                .map_err(|e| format!("Failed to finalize recovery backup: {e}"))?;
            Ok(summary)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}
