//! SQLite cache for the Google Fonts catalog.
//!
//! Two tables:
//!   `google_fonts_catalog` — one row per font family.
//!   `google_fonts_catalog_meta` — single-row table (enforced by CHECK (id=1))
//!   that records when the catalog was last fetched.
//!
//! The schema is created by `db::schema::migrate` via `CREATE TABLE IF NOT EXISTS`.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One font family from the Google Fonts catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub family: String,
    pub category: String,
    /// All variants reported by the API, e.g. ["regular", "700", "italic"].
    pub variants: Vec<String>,
    /// Map from variant key (e.g. "regular", "700") to TTF download URL.
    pub files: HashMap<String, String>,
}

/// Metadata about the last successful catalog fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMeta {
    /// Unix timestamp (seconds) of last successful fetch; `None` if never fetched.
    pub fetched_at: Option<i64>,
    /// Number of families currently in the cache.
    pub count: i64,
}

/// Atomically replace the entire catalog with `entries` and update the meta row.
///
/// All work runs inside a single transaction: DELETE, N×INSERT, UPSERT meta.
/// If anything fails, the whole transaction is rolled back — the cache is
/// never left partially populated.
pub fn upsert_catalog(conn: &mut Connection, entries: &[CatalogEntry]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM google_fonts_catalog", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO google_fonts_catalog (family, category, variants_json, files_json)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for entry in entries {
            let variants_json = serde_json::to_string(&entry.variants)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            let files_json = serde_json::to_string(&entry.files)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            stmt.execute(params![
                entry.family,
                entry.category,
                variants_json,
                files_json
            ])?;
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let count = entries.len() as i64;
    tx.execute(
        "INSERT INTO google_fonts_catalog_meta (id, fetched_at, count)
         VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, count = excluded.count",
        params![now, count],
    )?;
    tx.commit()
}

/// Fold a single character to its ASCII lowercase equivalent for fuzzy match.
///
/// Lowercases ASCII letters, strips accents from common Latin-1 / Latin
/// Extended-A characters (é → e, ñ → n, ý → y, ư → u, ệ → e, …). Returns
/// the original char unchanged for anything outside the known map — that's
/// fine because the user's needle will go through the same fold, so the
/// only requirement is that fold is consistent for both sides of the match.
fn fold_char(c: char) -> char {
    // Cheap fast path for plain ASCII.
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    match c {
        // Latin lowercase with diacritics
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' | 'ả' | 'ạ' | 'ầ' | 'ấ' | 'ẩ' | 'ẫ'
        | 'ậ' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' => 'a',
        'ç' | 'ć' | 'č' | 'ĉ' | 'ċ' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' | 'ẻ' | 'ẽ' | 'ẹ' | 'ề' | 'ế' | 'ể'
        | 'ễ' | 'ệ' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ỉ' | 'ị' => 'i',
        'ñ' | 'ń' | 'ň' | 'ņ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' | 'ơ' | 'ỏ' | 'ọ' | 'ồ' | 'ố' | 'ổ'
        | 'ỗ' | 'ộ' | 'ờ' | 'ớ' | 'ở' | 'ỡ' | 'ợ' => 'o',
        'ř' | 'ŕ' => 'r',
        'š' | 'ś' | 'ş' | 'ș' => 's',
        'ť' | 'ț' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' | 'ư' | 'ủ' | 'ụ' | 'ừ' | 'ứ'
        | 'ử' | 'ữ' | 'ự' => 'u',
        'ý' | 'ÿ' | 'ỳ' | 'ỷ' | 'ỹ' | 'ỵ' => 'y',
        'ž' | 'ź' | 'ż' => 'z',
        // Latin uppercase — match the lowercase mappings.
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' | 'Ả' | 'Ạ' | 'Ầ' | 'Ấ' | 'Ẩ' | 'Ẫ'
        | 'Ậ' | 'Ằ' | 'Ắ' | 'Ẳ' | 'Ẵ' | 'Ặ' => 'a',
        'Ç' | 'Ć' | 'Č' | 'Ĉ' | 'Ċ' => 'c',
        'Ď' | 'Đ' => 'd',
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' | 'Ě' | 'Ẻ' | 'Ẽ' | 'Ẹ' | 'Ề' | 'Ế' | 'Ể'
        | 'Ễ' | 'Ệ' => 'e',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ĩ' | 'Ī' | 'Ĭ' | 'Į' | 'Ỉ' | 'Ị' => 'i',
        'Ñ' | 'Ń' | 'Ň' | 'Ņ' => 'n',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ŏ' | 'Ő' | 'Ơ' | 'Ỏ' | 'Ọ' | 'Ồ' | 'Ố' | 'Ổ'
        | 'Ỗ' | 'Ộ' | 'Ờ' | 'Ớ' | 'Ở' | 'Ỡ' | 'Ợ' => 'o',
        'Ř' | 'Ŕ' => 'r',
        'Š' | 'Ś' | 'Ş' | 'Ș' => 's',
        'Ť' | 'Ț' => 't',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ũ' | 'Ū' | 'Ŭ' | 'Ů' | 'Ű' | 'Ų' | 'Ư' | 'Ủ' | 'Ụ' | 'Ừ' | 'Ứ'
        | 'Ử' | 'Ữ' | 'Ự' => 'u',
        'Ý' | 'Ỳ' | 'Ỷ' | 'Ỹ' | 'Ỵ' => 'y',
        'Ž' | 'Ź' | 'Ż' => 'z',
        _ => c.to_lowercase().next().unwrap_or(c),
    }
}

/// Fold a whole string for fuzzy comparison: lowercase + strip diacritics.
fn fold_string(s: &str) -> String {
    s.chars().map(fold_char).collect()
}

/// Subsequence match: every char of `needle` (already folded) appears in
/// `haystack` (already folded) in order, not necessarily contiguously.
///
/// Empty `needle` returns true by convention; callers gate empty queries
/// separately so this never fires in production.
fn is_subsequence_match(haystack_folded: &str, needle_folded: &str) -> bool {
    if needle_folded.is_empty() {
        return true;
    }
    let mut needle_iter = needle_folded.chars().peekable();
    for h in haystack_folded.chars() {
        if let Some(&n) = needle_iter.peek() {
            if h == n {
                needle_iter.next();
            }
        } else {
            return true;
        }
    }
    needle_iter.peek().is_none()
}

/// Search the catalog for families whose name *fuzzy-matches* `query`.
///
/// Match is a subsequence test on accent-folded, lowercased text: every
/// character of the needle must appear in the family name in order, but not
/// necessarily contiguously. So `"vnm"` matches `"Vietnam"` (v…**n**…**m**),
/// `"opnsns"` matches `"Open Sans"`, and `"caf"` matches `"Café"`.
///
/// Returns at most `limit` results ordered alphabetically by the original
/// family name. Filtering happens in Rust because SQLite's LIKE can only
/// express contiguous substring matches.
///
/// An empty query returns an empty list (prevents dumping all ~1800 rows).
pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<CatalogEntry>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let needle = fold_string(trimmed);

    let mut stmt = conn.prepare(
        "SELECT family, category, variants_json, files_json
         FROM google_fonts_catalog
         ORDER BY family",
    )?;
    let rows = stmt.query_map([], |row| {
        let family: String = row.get(0)?;
        let category: String = row.get(1)?;
        let variants_json: String = row.get(2)?;
        let files_json: String = row.get(3)?;
        Ok((family, category, variants_json, files_json))
    })?;

    let mut results = Vec::new();
    for row in rows {
        let (family, category, variants_json, files_json) = row?;
        let haystack = fold_string(&family);
        if !is_subsequence_match(&haystack, &needle) {
            continue;
        }
        let variants: Vec<String> = serde_json::from_str(&variants_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
        })?;
        let files: HashMap<String, String> = serde_json::from_str(&files_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?;
        results.push(CatalogEntry {
            family,
            category,
            variants,
            files,
        });
        if results.len() as u32 >= limit {
            break;
        }
    }
    Ok(results)
}

/// Return the catalog metadata (last fetch timestamp and family count).
/// If the meta row has never been written, returns `None` for `fetched_at` and
/// count 0.
pub fn get_meta(conn: &Connection) -> Result<CatalogMeta> {
    let result = conn.query_row(
        "SELECT fetched_at, count FROM google_fonts_catalog_meta WHERE id = 1",
        [],
        |row| {
            let fetched_at: Option<i64> = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok(CatalogMeta { fetched_at, count })
        },
    );
    match result {
        Ok(meta) => Ok(meta),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(CatalogMeta {
            fetched_at: None,
            count: 0,
        }),
        Err(e) => Err(e),
    }
}
