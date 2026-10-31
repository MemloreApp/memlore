//! Glue shim: `memlore_engine::ai::on_device` plus the desktop-only
//! `llama-server` sidecar (binary catalog, JIT download, process lifecycle).

pub use memlore_engine::ai::on_device::*;
pub mod llm_download;
pub mod server;
pub mod server_binary;
