//! Business operations shared by the Tauri commands, the MCP tools and the
//! sync engine. No Tauri types; `entries.rs` still calls into
//! `crate::commands::{ai_provider, ai_settings}` until Phase 7.1.

pub mod app_info;
pub mod backup;
pub mod entries;
pub mod guards;
pub mod journals;
pub mod media;
pub mod tags;
