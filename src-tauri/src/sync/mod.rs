//! Glue shim: the sync engine lives in `memlore_engine::sync`; only the
//! Tauri-driven scheduler stays here.

pub use memlore_engine::sync::*;
pub mod scheduler;
