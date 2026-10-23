//! App version injected by the entry point. The engine never reads a
//! build-time package version itself: desktop sets it at the top of
//! `run()`, the mobile FFI sets it when the engine is created.

use std::sync::OnceLock;

static APP_VERSION: OnceLock<&'static str> = OnceLock::new();

/// Set the app version once. A second call is ignored (a JS reload can
/// recreate the mobile module); it never panics.
pub fn set_app_version(v: &'static str) {
    let _ = APP_VERSION.set(v);
}

/// The injected app version, or `None` when no entry point set it yet.
/// Never panics.
pub fn try_app_version() -> Option<&'static str> {
    APP_VERSION.get().copied()
}

/// The injected app version. Panics in a normal build when it was never set,
/// so a missing injection can never silently write the wrong version.
pub fn app_version() -> &'static str {
    match try_app_version() {
        Some(v) => v,
        None => unset_app_version(),
    }
}

#[cfg(test)]
fn unset_app_version() -> &'static str {
    "0.0.0-test"
}

#[cfg(not(test))]
fn unset_app_version() -> &'static str {
    panic!("app version not set: call ops::app_info::set_app_version from the entry point")
}
