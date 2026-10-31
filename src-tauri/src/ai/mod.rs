//! Glue shim: the AI modules live in `memlore_engine::ai`; only the
//! desktop-only, process-spawning parts stay here (mobile-app plan, phase 10).

pub use memlore_engine::ai::*;
pub mod on_device;
pub mod providers;
