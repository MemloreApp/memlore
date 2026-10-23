//! Memory-worker wake-up signal, shared by sync (which nudges) and the
//! desktop memory worker in `commands/ai_memory.rs` (which waits on it).

use std::sync::OnceLock;

/// A pull can introduce memory items whose peer vectors use a different
/// model. Wake the worker so its active-model backfill does not wait for the
/// next 30-second scan interval. `Notify` retains one permit, so a nudge that
/// arrives while the worker is busy or between waits is not lost.
static MEMORY_WORKER_NUDGE: OnceLock<tokio::sync::Notify> = OnceLock::new();

pub(crate) fn memory_worker_nudge() -> &'static tokio::sync::Notify {
    MEMORY_WORKER_NUDGE.get_or_init(tokio::sync::Notify::new)
}

/// Wake the memory worker after sync has merged an item missing the local
/// model's vector. The tick itself retains the normal provider/configuration
/// gate, so this is a zero-work no-op when AI User Memory is not configured.
pub fn nudge_memory_worker() {
    memory_worker_nudge().notify_one();
}
