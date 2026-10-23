//! Provider-ID constants for providers whose implementations stay in the
//! desktop app (`ai/providers/cli/*`, `ai/providers/on_device_llm.rs`).
//! Plain string values only, so engine-side code can recognise these IDs
//! without depending on the process-spawning modules, which re-export them
//! as their own `PROVIDER_ID`.

pub const CLAUDE_CLI_ID: &str = "claude-cli";

pub const CODEX_CLI_ID: &str = "codex-cli";

/// Provider id — the prefix in `provider_namespaced_chat_model_id`, so the
/// chat cache namespace is `"on-device-llm:<catalog model id>"`.
pub const ON_DEVICE_LLM_ID: &str = "on-device-llm";
