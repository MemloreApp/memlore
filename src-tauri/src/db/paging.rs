//! Pagination helpers for SQLite queries. Every paginated command must run two
//! queries — a `COUNT(*)` for the total and a `LIMIT`/`OFFSET` page fetch —
//! so both execute against the same snapshot and the returned `total` is consistent.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedResult<T> {
    pub items: Vec<T>,
    pub total: u32,
}

pub const PAGE_SIZE: u32 = 20;

/// Clamp a 1-based page number to a valid range given `total` items.
/// - total=0 → returns 1 (empty result is still page 1)
/// - page=0 → returns 1 (caller passed an invalid 0-index)
/// - page > last_page → returns last_page
pub fn clamp_page(page: u32, total: u32) -> u32 {
    let max_page = max_page_for(total);
    page.max(1).min(max_page)
}

/// SQL OFFSET for a 1-based page. page<=1 → 0, page=2 → 20, page=5 → 80.
/// Returns i64 because SQLite bind params want signed.
pub fn page_offset(page: u32) -> i64 {
    ((page.max(1) - 1) as i64) * PAGE_SIZE as i64
}

/// SQL LIMIT — always equal to PAGE_SIZE. Returns i64 for SQLite bind.
pub fn page_limit() -> i64 {
    PAGE_SIZE as i64
}

/// SQL OFFSET for a 1-based page using a caller-supplied page size. Used by
/// surfaces that let the user pick how many items fit on a page (e.g. the
/// Media Gallery page-size selector). `page<=1 → 0`. Returns i64 for SQLite bind.
pub fn page_offset_for(page: u32, page_size: u32) -> i64 {
    (page.max(1) as i64 - 1) * page_size as i64
}

/// SQL LIMIT for a caller-supplied page size. Returns i64 for SQLite bind.
pub fn page_limit_for(page_size: u32) -> i64 {
    page_size as i64
}

fn max_page_for(total: u32) -> u32 {
    if total == 0 {
        return 1;
    }
    (total + PAGE_SIZE - 1) / PAGE_SIZE
}

#[cfg(test)]
mod tests {
    use super::*;

    // clamp_page edge cases

    #[test]
    fn clamp_page_empty_total_returns_1() {
        assert_eq!(clamp_page(1, 0), 1);
    }

    #[test]
    fn clamp_page_zero_page_clamped_to_1() {
        assert_eq!(clamp_page(0, 100), 1);
    }

    #[test]
    fn clamp_page_boundary_21_items_page_2() {
        // 21 items = 2 pages; page 2 is valid
        assert_eq!(clamp_page(2, 21), 2);
    }

    #[test]
    fn clamp_page_boundary_21_items_page_3_clamped() {
        // 21 items = 2 pages; page 3 is beyond last page → clamp to 2
        assert_eq!(clamp_page(3, 21), 2);
    }

    #[test]
    fn clamp_page_100_items_page_6_clamped() {
        // 100 items = 5 pages; page 6 is beyond last page → clamp to 5
        assert_eq!(clamp_page(6, 100), 5);
    }

    // page_offset

    #[test]
    fn page_offset_zero_is_zero() {
        assert_eq!(page_offset(0), 0);
    }

    #[test]
    fn page_offset_two_is_page_size() {
        assert_eq!(page_offset(2), 20);
    }

    // page_offset_for / page_limit_for — caller-supplied page size

    #[test]
    fn page_offset_for_two_is_one_page_size() {
        assert_eq!(page_offset_for(2, 40), 40);
    }

    #[test]
    fn page_offset_for_clamps_below_one() {
        assert_eq!(page_offset_for(0, 40), 0);
    }

    // PagedResult JSON serialization

    #[test]
    fn paged_result_exact_json_shape() {
        let result = PagedResult {
            items: vec![10i32, 20],
            total: 2u32,
        };
        let json = serde_json::to_string(&result).expect("serialize");
        assert_eq!(json, r#"{"items":[10,20],"total":2}"#);
    }
}
