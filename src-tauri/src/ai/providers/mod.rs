//! Glue shim: `memlore_engine::ai::providers` plus the desktop-only CLI
//! subprocess and on-device LLM providers.

pub use memlore_engine::ai::providers::*;
pub mod cli;
pub mod on_device_llm;
