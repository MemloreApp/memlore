//! Time helpers.
//!
//! `now_unix` used to be duplicated across `db::queries` and
//! `sync::engine`. One copy here keeps the semantics — "current UNIX
//! timestamp in seconds, 0 on clock skew" — in a single place.

/// Current UNIX timestamp in seconds. Returns 0 if the system clock is
/// before the UNIX epoch (rare; indicates a broken clock).
pub fn now_unix() -> i64 {
    #[cfg(test)]
    if let Some(pinned) = PINNED_NOW.with(std::cell::Cell::get) {
        return pinned;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
thread_local! {
    static PINNED_NOW: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}

/// Test-only: `now_unix()` returns `ts` on this thread until the guard drops.
/// For tests that replay frozen fixtures through wall-clock retention windows.
#[cfg(test)]
pub fn pin_now_unix(ts: i64) -> PinnedNowGuard {
    PINNED_NOW.with(|cell| cell.set(Some(ts)));
    PinnedNowGuard
}

#[cfg(test)]
pub struct PinnedNowGuard;

#[cfg(test)]
impl Drop for PinnedNowGuard {
    fn drop(&mut self) {
        PINNED_NOW.with(|cell| cell.set(None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_unix_is_close_to_current_epoch() {
        let ts = now_unix();
        // Loose bounds: any run between 2020-01-01 and year 2100.
        assert!(ts > 1_577_836_800, "now_unix() = {ts} — broken clock?");
        assert!(ts < 4_102_444_800, "now_unix() = {ts} — future clock?");
    }

    #[test]
    fn pinned_now_unix_reverts_when_the_guard_drops() {
        {
            let _clock = pin_now_unix(1_000);
            assert_eq!(now_unix(), 1_000);
        }
        assert!(now_unix() > 1_577_836_800);
    }
}
