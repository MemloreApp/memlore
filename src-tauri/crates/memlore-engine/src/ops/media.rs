use crate::db::CreateMediaParams;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

/// Result returned by the media-picker commands (`pick_image`, `pick_video`,
/// and `save_pasted_image`) after copying bytes into the media dir and
/// inserting a `media` row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickImageResult {
    pub media_id: String,
    pub local_path: String,
}

/// Infer a MIME type from a lowercased file extension.
///
/// Covers the image formats the picker accepts plus the three video
/// containers supported in phase B1 (`mp4`, `mov`, `webm`, `m4v`). Unknown
/// extensions fall through to `application/octet-stream` so the caller can
/// reject unsupported bytes before they land in the media directory.
#[doc(hidden)]
pub fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        // HEIC / HEIF: iPhone Photos default since iOS 11. PHPicker on
        // macOS hands us these as `.heic` files; we must register them as
        // images so `save_media_to_media_dir` runs the EXIF extractor (the
        // kamadak-exif reader handles both JPEG and HEIF containers via
        // content-sniffing).
        "heic" | "heif" => "image/heic",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "m4v" => "video/x-m4v",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Normalize a user-chosen filename for safe DB storage + later peer
/// fetches. We persist this string in `media.file_name` and `resolve_media`
/// later runs `is_safe_cache_filename` against it on remote devices;
/// names starting with `.`, containing `/` or `\`, or longer than the
/// validator allows would otherwise become unfetchable.
///
/// Rules:
///   * Replace any path separator (`/`, `\`) with `_`.
///   * Strip leading dots so a `.bashrc` upload doesn't trip the hidden-
///     file guard on macOS / Linux peers.
///   * Collapse to a `file.bin` fallback if the result is empty after
///     stripping (e.g. user picked a file literally named `...`).
/// Maximum byte length of a sanitized filename. Trimmed past this point
/// so the result fits inside common FS limits (most are 255 bytes per
/// component) with headroom for the UUID-prefixed copy on disk and for
/// the cloud-storage metadata key.
#[doc(hidden)]
pub const SANITIZED_FILENAME_MAX_BYTES: usize = 200;

#[doc(hidden)]
pub fn sanitize_attachment_filename(original: &str) -> String {
    // Replace path separators + ANY control character (NUL, \n, \r, \t,
    // and the rest of U+0000-U+001F + U+007F) with `_`. Control chars
    // would otherwise persist into `media.file_name`, break log lines,
    // and confuse downstream consumers expecting display-safe strings.
    let cleaned: String = original
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.').to_string();
    let bounded = if trimmed.len() > SANITIZED_FILENAME_MAX_BYTES {
        // Find a UTF-8 char boundary at or before the cap so we never
        // produce invalid UTF-8 by slicing through a multi-byte sequence.
        let mut cut = SANITIZED_FILENAME_MAX_BYTES;
        while cut > 0 && !trimmed.is_char_boundary(cut) {
            cut -= 1;
        }
        trimmed[..cut].to_string()
    } else {
        trimmed
    };
    if bounded.is_empty() {
        "file.bin".to_string()
    } else {
        bounded
    }
}

/// Pure helper: write `bytes` into `media_dir/{uuid}.{ext}` and insert a
/// `media` row with `insertion_mode = 'attached'`. Returns the new row id
/// and the on-disk path on success. On DB-insert failure, the freshly-
/// written file is removed so the media dir never accumulates orphans.
///
/// Unlike `save_media_to_media_dir`, this helper:
///   * Stores `sanitized_name` (not the UUID-based dest name) in the
///     `file_name` column so the UI can render a recognizable label.
///   * Skips EXIF + thumbnail generation entirely — generic files have
///     no intrinsic dimensions or thumbnails we can derive in-process.
///   * Always inserts with `insertion_mode = "attached"`.
#[doc(hidden)]
pub fn save_attached_file_to_media_dir(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    sanitized_name: &str,
    bytes: &[u8],
) -> Result<PickImageResult, String> {
    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;

    let ext = std::path::Path::new(sanitized_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    // `mime_from_ext` only knows image/video/audio extensions — every other
    // extension falls back to `application/octet-stream`. Refuse anything
    // that resolves to a media MIME so a hand-crafted IPC call can't
    // smuggle a JPG through the file-attach path.
    let mime_type = mime_from_ext(&ext);
    if mime_type.starts_with("image/")
        || mime_type.starts_with("video/")
        || mime_type.starts_with("audio/")
    {
        return Err(format!(
            "extension '{ext}' is a media type; use the image/video/audio picker instead"
        ));
    }

    crate::db::require_live_entry(conn, entry_id).map_err(|e| e.to_string())?;

    let media_uuid = uuid::Uuid::new_v4().to_string();
    let dest_name = if ext.is_empty() {
        media_uuid.clone()
    } else {
        format!("{media_uuid}.{ext}")
    };
    let dest_path = media_dir.join(&dest_name);
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

    let file_size = dest_path.metadata().map(|m| m.len() as i64).unwrap_or(0);
    let local_path = dest_path.to_string_lossy().into_owned();

    match crate::db::create_media(
        conn,
        CreateMediaParams {
            entry_id,
            file_name: sanitized_name,
            file_type: mime_type,
            storage_path: &local_path,
            file_size: Some(file_size),
            sort_order: 0,
            insertion_mode: "attached",
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            width: None,
            height: None,
        },
    ) {
        Ok(media) => Ok(PickImageResult {
            media_id: media.id,
            local_path,
        }),
        Err(e) => {
            // DB insert failed → remove the orphan we just wrote so the
            // media dir doesn't accumulate untracked bytes. Best-effort:
            // a delete error is logged but does not mask the DB error.
            if let Err(remove_err) = std::fs::remove_file(&dest_path) {
                log::warn!("failed to remove orphaned attached-file {dest_name}: {remove_err}");
            }
            Err(e.to_string())
        }
    }
}

/// Returns `true` if `name` is a safe cache filename component.
///
/// Rejects:
/// - Strings containing `/` or `\` (path separator injection).
/// - Strings containing `..` (directory traversal).
/// - Strings starting with `.` (hidden files / relative path components).
/// - Empty strings.
#[doc(hidden)]
pub fn is_safe_cache_filename(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    if name.contains("..") {
        return false;
    }
    true
}

/// Validate a cloud path of the form `"{device_id}/media/{media_id}"`.
///
/// Returns `device_id` on success, or a descriptive error string on failure.
/// Validates:
/// - Exactly 3 slash-separated parts.
/// - `parts[1]` == `"media"`.
/// - `parts[2]` == `media_id` argument.
/// - `device_id` passes the safe-component check (ASCII alphanumeric, `-`, `_`; length >= 4).
#[doc(hidden)]
pub fn validate_cloud_path<'a>(cloud_path: &'a str, media_id: &str) -> Result<&'a str, String> {
    let parts: Vec<&str> = cloud_path.split('/').collect();
    if parts.len() != 3 {
        return Err(format!(
            "Invalid cloud path (expected 3 parts, got {}): {cloud_path}",
            parts.len()
        ));
    }
    let device_id = parts[0];
    let segment = parts[1];
    let tail = parts[2];

    if segment != "media" {
        return Err(format!(
            "Invalid cloud path (expected 'media' segment, got '{segment}'): {cloud_path}"
        ));
    }
    if tail != media_id {
        return Err(format!(
            "Invalid cloud path (tail '{tail}' does not match media_id '{media_id}'): {cloud_path}"
        ));
    }
    if !is_safe_device_id(device_id) {
        return Err(format!(
            "Invalid cloud path (unsafe device_id '{device_id}'): {cloud_path}"
        ));
    }
    Ok(device_id)
}

// Device-id validator lives in `crate::sync::safety` so engine + media share
// one definition. See `sync::safety::is_safe_device_id` for the rules.
use crate::sync::safety::is_safe_device_id;

/// Inner (testable) implementation for `delete_media`.
///
/// Reads `storage_path` and `thumbnail_path` before deleting the DB row, then
/// removes the files from disk best-effort (logs warnings on failure). The
/// `clear_entry_cover_on_media_delete` trigger handles nullifying `cover_media_id`
/// automatically.
#[doc(hidden)]
pub fn delete_media_inner(conn: &Connection, media_id: &str) -> Result<(), String> {
    let media = crate::db::get_media(conn, media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;

    let storage_path = media.storage_path.clone();
    let thumbnail_path = media.thumbnail_path.clone();
    let entry_id = media.entry_id.clone();
    crate::db::require_live_entry(conn, &entry_id).map_err(|e| e.to_string())?;
    let deleted_at = crate::utils::time::now_unix();

    // POINT OF NO RETURN (T38): persist the tombstone before dropping the
    // row so the next entry push can carry `deleted_media`. Bump
    // `updated_at` + pending so peers re-pull; same-timestamp LWW would
    // otherwise skip the payload and leave the peer row alive.
    crate::db::upsert_media_tombstone(conn, media_id, &entry_id, deleted_at)
        .map_err(|e| e.to_string())?;
    crate::db::touch_entry_updated_at(conn, &entry_id).map_err(|e| e.to_string())?;
    crate::db::mark_entry_pending(conn, &entry_id).map_err(|e| e.to_string())?;

    // Delete the DB row first. The cover trigger fires here.
    crate::db::delete_media(conn, media_id).map_err(|e| e.to_string())?;

    // Best-effort filesystem cleanup. Safe here because this runs without a
    // surrounding transaction (the `delete_media` command owns its own lock),
    // so there is no rollback that could restore the row after the unlink.
    remove_media_files_best_effort(&storage_path, thumbnail_path.as_deref());

    Ok(())
}

/// Best-effort removal of a media's original + thumbnail files from disk.
/// Failures are logged, never propagated. Callers that delete media rows
/// inside a transaction MUST defer this until after the commit succeeds —
/// filesystem deletes are not transactional, so unlinking before a rollback
/// would leave a live row pointing at a missing file.
#[doc(hidden)]
pub fn remove_media_files_best_effort(storage_path: &str, thumbnail_path: Option<&str>) {
    if !storage_path.is_empty() {
        if let Err(e) = std::fs::remove_file(storage_path) {
            log::warn!("delete_media: remove file {storage_path}: {e}");
        }
    }
    if let Some(thumb) = thumbnail_path {
        if !thumb.is_empty() {
            if let Err(e) = std::fs::remove_file(thumb) {
                log::warn!("delete_media: remove thumbnail {thumb}: {e}");
            }
        }
    }
}

/// Inner (testable) implementation for `update_media_insertion_mode`.
#[doc(hidden)]
pub fn update_media_insertion_mode_impl(
    conn: &Connection,
    media_id: &str,
    mode: &str,
) -> Result<(), String> {
    let media = crate::db::get_media(conn, media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;
    crate::db::require_live_entry(conn, &media.entry_id).map_err(|e| e.to_string())?;
    crate::db::update_media_insertion_mode_db(conn, media_id, mode).map_err(|e| e.to_string())
}
