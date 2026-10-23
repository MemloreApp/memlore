//! Memlore engine: the platform-independent database, sync, AI and import
//! logic shared by the desktop app (`src-tauri`) and the mobile FFI crate.
//! It has no Tauri dependency; the desktop glue re-exports its modules.

// The weak test KDF, time pin, 0-ms retry and test fallbacks behind
// `test-support` must never ship.
#[cfg(all(feature = "test-support", not(debug_assertions)))]
compile_error!("memlore-engine: the test-support feature must never be enabled in a release build");

pub use memlore_core::key_state::{ContentKeyList, EncryptionKeyState};

pub mod ai;
pub mod db;
pub mod import_apple_journal;
pub mod import_apple_journal_yjs;
pub mod import_html;
pub mod import_markdown;
pub mod ops;
pub mod state;
pub mod sync;
pub mod utils;
pub mod yjs_doc;

pub use state::AppState;
