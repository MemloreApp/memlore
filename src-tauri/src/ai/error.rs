use serde::{Deserialize, Serialize};

/// AI-layer error type.
///
/// Each variant maps to a stable string error code that the frontend receives
/// via the Tauri command `Result<T, String>` boundary. Keep codes stable
/// across releases — the frontend may pattern-match on them.
#[derive(Debug, Clone, thiserror::Error)]
pub enum AiError {
    /// User has not configured an AI provider, or has revoked it. All AI
    /// commands return this until R2/R3 wire the Settings → AI panel.
    #[error("AI_NOT_CONFIGURED")]
    ProviderNotConfigured,

    /// User has not accepted the privacy notice for the current provider.
    /// Frontend should re-open the privacy modal.
    #[error("AI_PRIVACY_NOT_ACCEPTED")]
    PrivacyNotAccepted,

    /// User has not accepted the bulk-context notice for sending multiple
    /// entries to a remote or subscription provider. Frontend should show
    /// the bulk-context consent modal with entry count + date range.
    #[error("AI_BULK_CONTEXT_NOT_ACCEPTED")]
    BulkContextNotAccepted,

    /// The configured provider does not implement the requested capability
    /// (e.g. image generation on a provider that only does text).
    #[error("AI_PROVIDER_UNSUPPORTED: {0}")]
    ProviderUnsupported(String),

    /// HTTP error talking to the provider — network failure, 5xx, malformed
    /// JSON. The string carries diagnostic detail for the log; the frontend
    /// surfaces a generic "Provider unreachable" message.
    #[error("AI_PROVIDER_ERROR: {0}")]
    ProviderError(String),

    /// Feature toggle is off (or a hard precondition like Persona is off).
    /// Display is the bare `AI_*_DISABLED` code — no wrapper prefix — so
    /// the frontend can pattern-match it directly.
    #[error("{0}")]
    FeatureDisabled(&'static str),

    /// API key rejected (401 / 403). Surface as "Re-enter API key" in UI.
    #[error("AI_AUTH_FAILED")]
    AuthFailed,

    /// Provider rate-limited the request (429). Frontend backs off + retries.
    #[error("AI_RATE_LIMITED")]
    RateLimited,

    /// Generic IO / DB error within the AI subsystem.
    #[error("AI_IO_ERROR: {0}")]
    IoError(String),

    /// User-initiated or `app:locked`-driven cancellation.
    #[error("AI_CANCELLED")]
    Cancelled,

    /// Provider connected + returned 200 OK but produced no usable
    /// content. Most often: `stream: true` was sent but the provider
    /// ignored it and returned a non-SSE body, OR the model returned
    /// only whitespace / quotes that trim to empty. Distinguished from
    /// `ProviderError(_)` so the UI can surface "your provider doesn't
    /// support streaming" guidance specifically.
    #[error("AI_EMPTY_RESPONSE")]
    EmptyResponse,

    /// The on-device embedding model is not usable yet — either the
    /// user hasn't downloaded it, or the bundled `fastembed` version
    /// doesn't ship a backend for this catalog entry (see
    /// `ai::on_device::catalog`). The string carries a short diagnostic
    /// for the log. Treated like `ProviderNotConfigured` by the
    /// background-indexing worker's pause classifier
    /// (`ai::indexer::is_auth_or_config_error`) — a bare retry can
    /// never succeed until the user acts, so the job pauses instead of
    /// burning the exponential-backoff schedule.
    #[error("AI_MODEL_NOT_READY: {0}")]
    ModelNotReady(String),

    /// `resolve_chat_context` refused to hand back a usable Daily Chat
    /// context plan — a period attachment couldn't fit even in chunk mode,
    /// the combined estimate crossed the warn threshold without the
    /// caller's confirmation, or bulk-context consent is missing.
    ///
    /// Carried as the typed [`ChatContextRefusal`], not smuggled through
    /// `ProviderError`'s single opaque string: this variant's `Display` is
    /// EXACTLY `ChatContextRefusal`'s own JSON serialisation (no prefix,
    /// no wrapping text), so the `Result<_, String>` IPC boundary hands the
    /// frontend a `JSON.parse`-able discriminated union on `code` instead
    /// of a string it would have to split on an invented delimiter.
    #[error("{0}")]
    ChatContextRefused(ChatContextRefusal),
}

impl From<AiError> for String {
    fn from(e: AiError) -> String {
        e.to_string()
    }
}

/// One reason `resolve_chat_context` refused to hand back a usable plan.
/// Carried as `AiError::ChatContextRefused(ChatContextRefusal)` starting in
/// T4.7, which also wires the send path's `oversize_confirmed` handling —
/// `resolve_chat_context` itself never raises `NeedsConfirmation` (that one
/// is raised by the caller from `ChatContextPlan::needs_confirm`); it only
/// ever produces `PeriodTooLarge` or `ConsentRequired`.
///
/// **`ConsentRequired`** is this task's answer to "pick a sensible
/// representation" for a failed bulk-context consent check on the
/// attachment path (see `resolve_chat_context`'s doc comment). It carries no
/// fields: unlike `PeriodTooLarge`, the UI response is the same generic
/// consent modal regardless of what was attached, so there is nothing
/// caller-useful to include.
// `pub`, not `pub(crate)`: T4.7 nests this inside `AiError::ChatContextRefused`,
// and `AiError` is a `pub` enum — a crate-private variant payload there would
// trip `private_interfaces`.
// `rename_all` renames the VARIANTS (`PeriodTooLarge` -> `"period_too_large"`,
// which is what the `code` discriminator carries). It does NOT rename fields —
// `rename_all_fields` does, and it is required: `src/types/ai.ts` declares this
// union with camelCase fields (`entryCount`, `estimatedBytes`, …). Without it
// Rust emits `entry_count`, the frontend reads `undefined`, and the i18n
// `{{count}}` / `{{label}}` interpolation renders empty at exactly the moment
// the user is being told why their send was blocked — with nothing failing to
// compile on either side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChatContextRefusal {
    /// A period attachment didn't fit `CHAT_RAG_TAG_MAX_BYTES` (or its
    /// share of it) and chunk mode was unavailable. Nothing is returned for
    /// ANY attachment in this call, not just the offending period — see
    /// `refused_period_short_circuits_the_whole_plan`.
    PeriodTooLarge { label: String, entry_count: usize },
    /// A period attachment's share of the shared tag budget was too small
    /// to hold even the disclosure line, before its actual size was ever
    /// evaluated — see `commands::ai::PeriodContextOutcome::NoBudget`. Distinct from
    /// `PeriodTooLarge`: this period was starved of budget by other
    /// attachments (or other periods), not found to be too large itself.
    PeriodNoBudget { label: String },
    /// Confirmed by T4.7's send path when `ChatContextPlan::needs_confirm`
    /// is true and the caller has not yet passed `oversize_confirmed: true`.
    /// `resolve_chat_context` never constructs this variant itself.
    NeedsConfirmation {
        label: Option<String>,
        estimated_bytes: usize,
        entries_included: usize,
        entries_total: usize,
        total_bytes: usize,
    },
    /// The unified bulk-context privacy receipt has not been accepted for
    /// the generation slot's endpoint class. Attaching entries sends their
    /// full content to that (possibly remote) provider — exactly what the
    /// receipt gates — so a missing receipt refuses instead of silently
    /// dropping the attachment the user explicitly asked for.
    ConsentRequired,
}

impl std::fmt::Display for ChatContextRefusal {
    /// EXACTLY this value's own JSON serialisation — see
    /// `AiError::ChatContextRefused`'s doc comment for why the IPC
    /// boundary must hand the frontend raw, parseable JSON rather than a
    /// human-prefixed string.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match serde_json::to_string(self) {
            Ok(json) => f.write_str(&json),
            Err(_) => write!(f, "{self:?}"),
        }
    }
}
