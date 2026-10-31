//! Provider-ID constants for providers whose implementations stay in the
//! desktop app (`ai/providers/cli/*`, `ai/providers/on_device_llm.rs`) or
//! sit behind the optional `fastembed` feature
//! (`ai/providers/on_device_embed.rs`). Plain string values only, so
//! engine-side code can recognise these IDs without depending on those
//! modules, which re-export them as their own `PROVIDER_ID`.

pub const CLAUDE_CLI_ID: &str = "claude-cli";

pub const CODEX_CLI_ID: &str = "codex-cli";

/// On-device embedding provider id (`ai::providers::on_device_embed`
/// re-exports it as `PROVIDER_ID`) — the prefix in
/// `provider_namespaced_model_id`, so the composed embedding cache key is
/// `"on-device:<catalog model id>"`. Here so it stays reachable without the
/// `fastembed` feature.
pub const ON_DEVICE_EMBED_ID: &str = "on-device";

/// Provider id — the prefix in `provider_namespaced_chat_model_id`, so the
/// chat cache namespace is `"on-device-llm:<catalog model id>"`.
pub const ON_DEVICE_LLM_ID: &str = "on-device-llm";
