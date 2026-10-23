//! Engine async runtime hook. The entry point injects the runtime the app
//! already runs on: desktop passes Tauri's runtime handle from `setup`, the
//! mobile FFI passes its own when the engine is created. AI code spawns and
//! blocks through these wrappers instead of Tauri's `async_runtime`.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;

static RUNTIME: OnceLock<Handle> = OnceLock::new();

/// Lazily built runtime for callers outside any runtime when no entry point
/// injected one (tests, tools). Kept alive here: dropping a `Runtime` would
/// cancel its tasks.
static FALLBACK: OnceLock<Runtime> = OnceLock::new();

/// Set the runtime once. A second call is ignored (a JS reload can recreate
/// the mobile engine); it never panics.
pub fn set_runtime(handle: Handle) {
    let _ = RUNTIME.set(handle);
}

/// The injected runtime, else the current one, else a lazily built
/// multi-thread runtime (the same default Tauri builds lazily).
pub fn handle() -> Handle {
    if let Some(h) = RUNTIME.get() {
        return h.clone();
    }
    if let Ok(h) = Handle::try_current() {
        return h;
    }
    FALLBACK
        .get_or_init(|| Runtime::new().expect("failed to build the fallback tokio runtime"))
        .handle()
        .clone()
}

/// Spawn a future onto the engine runtime.
pub fn spawn<F>(task: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(task)
}

/// Run a blocking closure on the engine runtime's blocking pool.
pub fn spawn_blocking<F, R>(func: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    handle().spawn_blocking(func)
}

/// Drive a future to completion on the engine runtime. Like
/// Tauri's `async_runtime::block_on`, it panics when called from inside an
/// async runtime context: call it from a plain thread.
pub fn block_on<F: Future>(task: F) -> F::Output {
    handle().block_on(task)
}
