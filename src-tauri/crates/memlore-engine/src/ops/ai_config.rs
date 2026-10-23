//! AI configuration reads shared by the Tauri commands, the entry save path,
//! the indexer and the sync engine: per-preset credential resolution, slot
//! endpoint classes, configured embedding identities and the embedding
//! feature / background-indexing gates. No Tauri types.

use crate::ai::error::AiError;
use crate::ai::provider::{classify_endpoint, settings_keys, EndpointClass};
use crate::ai::provider_ids::{CLAUDE_CLI_ID, CODEX_CLI_ID, ON_DEVICE_LLM_ID};
use crate::ai::providers::on_device_embed::PROVIDER_ID as ON_DEVICE_PROVIDER_ID;
use crate::db;

/// Per-slot settings key bundle. Implemented for `gen_keys` / `embed_keys`
/// below — both are zero-sized marker structs.
#[doc(hidden)]
pub trait SlotKeys {
    const PROVIDER: &'static str;
    /// `Some(model)` for the model-bearing field used by this slot
    /// (chat_model for gen, embedding_model for embed). Image model is
    /// gen-only; the persist path reads it directly off the input.
    fn model_key() -> &'static str;
}

/// Syncable per-preset endpoint-override map. Value shape (T36, 2026-09-03):
/// `{ [preset]: { endpoint: string | null, updated_at: i64 } }`.
/// `null` = tombstone (reset-to-default). No migration shim — old
/// `BTreeMap<preset, endpoint>` rows degrade to empty.
#[doc(hidden)]
pub const PROVIDER_ENDPOINTS: &str = db::AI_PROVIDER_ENDPOINTS_KEY;
/// Non-synced JSON `BTreeMap<presetId, apiKey>` (preset id → API key). Never
/// enters the sync allow-list — keys never leave the device.
#[doc(hidden)]
pub const PROVIDER_KEYRING: &str = "ai_provider_keyring";

/// Live overrides only (`endpoint: Some`). Tombstones are omitted so
/// callers fall back to [`preset_default_endpoint`]. Missing, malformed,
/// and **old-shape** rows (`{"custom":"https://…"}`) degrade to empty —
/// no migration shim (T36).
#[doc(hidden)]
pub fn read_provider_endpoints(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, String>, AiError> {
    Ok(read_provider_endpoints_stamped(conn)?
        .into_iter()
        .filter_map(|(preset, rec)| rec.endpoint.map(|endpoint| (preset, endpoint)))
        .collect())
}

#[doc(hidden)]
pub fn read_provider_endpoints_stamped(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, db::ProviderEndpointRecord>, AiError> {
    let Some(raw) =
        db::get_setting(conn, PROVIDER_ENDPOINTS).map_err(|e| AiError::IoError(e.to_string()))?
    else {
        return Ok(std::collections::BTreeMap::new());
    };
    let parsed = db::parse_provider_endpoints_map(&raw);
    if parsed.is_empty() && !raw.trim().is_empty() && raw.trim() != "{}" {
        log::warn!(
            "read_provider_endpoints: unknown or old-shape {PROVIDER_ENDPOINTS} row, \
             degrading to empty map (presets fall back to built-in defaults)"
        );
    }
    Ok(parsed)
}

/// Read the per-preset API-key keyring. Empty (and missing row) deserialize
/// to an empty map. Mirrors [`read_provider_endpoints`]'s degrade-on-corruption
/// behavior: a malformed row logs a warning and falls back to an empty map
/// (no stored keys) rather than failing every preset's read.
#[doc(hidden)]
pub fn read_provider_keyring(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, String>, AiError> {
    let Some(raw) =
        db::get_setting(conn, PROVIDER_KEYRING).map_err(|e| AiError::IoError(e.to_string()))?
    else {
        return Ok(std::collections::BTreeMap::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_else(|e| {
        log::warn!(
            "read_provider_keyring: malformed {PROVIDER_KEYRING} row, degrading to empty \
             map (no stored keys reported): {e}"
        );
        std::collections::BTreeMap::new()
    }))
}

/// The built-in default endpoint for a preset id — the fallback used by
/// [`resolve_credential`] when no override is registered. Mirrors the
/// `endpoint:` field of each preset in `src/types/ai.ts` (the single source
/// of truth). Presets with no HTTP surface (CLI, on-device) and user-supplied
/// endpoints (`custom`, `other-local` is *given* a placeholder here only to
/// match the TS table; the user is expected to override it) return the empty
/// string. Returning `""` rather than erroring keeps [`resolve_credential`]
/// total; callers handle the empty case.
#[doc(hidden)]
pub fn preset_default_endpoint(preset_id: &str) -> &'static str {
    match preset_id {
        // Hosted
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "xai" => "https://api.x.ai/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "together" => "https://api.together.xyz/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "voyage" => "https://api.voyageai.com/v1",
        // Local (defaults mirror the TS preset table; the user overrides these)
        "ollama" => "http://127.0.0.1:11434/v1",
        "lmstudio" => "http://127.0.0.1:1234/v1",
        "llama-server" => "http://127.0.0.1:8080/v1",
        "other-local" => "http://127.0.0.1:8080/v1",
        // No HTTP surface / user-supplied
        "custom" | CLAUDE_CLI_ID | CODEX_CLI_ID | ON_DEVICE_PROVIDER_ID | ON_DEVICE_LLM_ID => "",
        // Unknown preset id — no default, callers handle the empty case.
        _ => "",
    }
}

/// `true` iff `preset_id` is one of the two presets whose endpoint the UI
/// lets the user edit (`custom`, `other-local` — see `AISettingsPanel.tsx`'s
/// `endpointEditable`). Every other preset's endpoint is fixed to
/// [`preset_default_endpoint`]. Centralizes backend enforcement of that
/// restriction so `commands::ai_provider::persist_provider_credential` never trusts an IPC
/// caller — or an `ai_provider_endpoints` payload synced in from another
/// device — to point a fixed preset like `openai` at an attacker-controlled
/// host, which would leak that preset's stored API key (and, via the next
/// AI feature call, journal content) to it on the next hydration.
#[doc(hidden)]
pub fn preset_endpoint_editable(preset_id: &str) -> bool {
    preset_id == "custom" || preset_id == "other-local"
}

/// Resolve the (endpoint, key) pair for a preset id.
///
/// The endpoint is the registered override if present, else the preset's
/// built-in default ([`preset_default_endpoint`]), else the empty string
/// (never an error). The key is the registered key for the preset id, if any.
/// This is the single read path the four slot hydrations switch to in T1.5.
///
/// Defense-in-depth: an override is only honored for a preset where
/// [`preset_endpoint_editable`] is `true` (`custom`, `other-local`). The
/// `ai_provider_endpoints` row is synced (Phase 2 T2.4) and reaches the DB
/// via the sync engine's LWW merge — a path that never goes through
/// `commands::ai_provider::persist_provider_credential`'s write-side guard. Re-checking here, at
/// the single resolution point every hydration/build/public-view read goes
/// through, means a malicious/compromised synced override for a fixed
/// preset (e.g. `{"openai": "https://attacker.example/v1"}`) can never pair
/// that preset's stored API key with an attacker-controlled endpoint.
#[doc(hidden)]
pub fn resolve_credential(
    conn: &rusqlite::Connection,
    preset_id: &str,
) -> Result<(String, Option<String>), AiError> {
    let endpoints = read_provider_endpoints(conn)?;
    let endpoint = endpoints
        .get(preset_id)
        .filter(|_| preset_endpoint_editable(preset_id))
        .cloned()
        .unwrap_or_else(|| preset_default_endpoint(preset_id).to_string());
    let key = read_provider_keyring(conn)?.get(preset_id).cloned();
    Ok((endpoint, key))
}

/// Derive the disclosure class for a (preset id, endpoint) pair. Pure
/// delegation to [`classify_provider_disclosure`] — `endpointClass` is now
/// derived on every read and never persisted, so the four stored
/// `*_endpoint_class` rows become redundant.
#[doc(hidden)]
pub fn credential_class(preset_id: &str, endpoint: &str) -> EndpointClass {
    classify_provider_disclosure(preset_id, endpoint)
}

#[doc(hidden)]
pub struct EmbedKeys;
impl SlotKeys for EmbedKeys {
    const PROVIDER: &'static str = settings_keys::embed::PROVIDER;
    fn model_key() -> &'static str {
        settings_keys::embed::EMBEDDING_MODEL
    }
}

/// T2.3 cutover: derive the `EndpointClass` for a slot's CURRENTLY
/// CONFIGURED provider — reads the slot's `provider` settings row (e.g.
/// [`settings_keys::gen::PROVIDER`]), then resolves + classifies via the
/// per-preset credential registry ([`resolve_credential`] /
/// [`credential_class`]). Replaces the old design where each slot ALSO
/// stored its own `endpoint_class` row (read by the now-deleted
/// `read_slot_endpoint_class`) — endpointClass is derived on every read now,
/// never persisted.
///
/// Returns `None` when the slot has no provider configured (missing, empty,
/// or `"none"` row).
///
/// **Why `None` instead of a default class** — every caller is a privacy
/// gate. Picking *any* default would silently route consent against the
/// user's most permissive accepted class. Forcing callers to handle `None`
/// explicitly is the fail-closed posture: no class = no consent.
#[doc(hidden)]
pub fn slot_provider_class(
    conn: &rusqlite::Connection,
    provider_key: &str,
) -> Result<Option<EndpointClass>, AiError> {
    let Some(provider) = db::get_setting(conn, provider_key)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .filter(|p| !p.is_empty() && p != "none")
    else {
        return Ok(None);
    };
    let (endpoint, _) = resolve_credential(conn, &provider)?;
    Ok(Some(credential_class(&provider, &endpoint)))
}

/// Compose the same `provider_id:embedding_model` identity string
/// `provider_namespaced_model_id` builds off a live `AIProvider`, but from
/// the raw settings-row values — used to detect an embedding-slot identity
/// change without constructing a provider instance.
#[doc(hidden)]
pub fn embed_identity(provider: &str, embedding_model: &str) -> String {
    format!("{provider}:{embedding_model}")
}

/// The CONFIGURED embedding slot's namespaced model_id
/// (`"{provider_id}:{embedding_model}"`) — same format
/// `provider_namespaced_model_id` builds off a live `AIProvider`, and the
/// same identity [`embed_identity`] computes for change-detection on the
/// save path, but read directly from the persisted `ai_embed_*` settings
/// rows so a caller never needs to construct an `AIProvider`.
///
/// C6 fix: `sync::engine::pull_embedding_chunks` uses this as its sole
/// source of "this device's active embedding model" instead of inferring
/// it from whatever `model_id`s happen to already be present in
/// `entry_embedding_chunks` — that idiom adopted nothing on a fresh
/// device (no local rows yet) and wrongly treated rows retained from a
/// PRIOR model (after a switch) as still active. Reading the configured
/// slot fixes both. Returns `None` when no embedding slot is configured
/// yet (provider or model row missing/empty) — same "nothing configured"
/// contract every other slot reader in this module uses.
#[doc(hidden)]
pub fn configured_embedding_model_id(conn: &rusqlite::Connection) -> Option<String> {
    let provider = db::get_setting(conn, EmbedKeys::PROVIDER)
        .ok()
        .flatten()
        .filter(|p| !p.is_empty() && p != "none")?;
    let model = db::get_setting(conn, EmbedKeys::model_key())
        .ok()
        .flatten()
        .filter(|m| !m.is_empty())?;
    Some(embed_identity(&provider, &model))
}

/// The CONFIGURED memory-embed slot's namespaced model_id — the memory
/// channel's sibling of [`configured_embedding_model_id`], reading the
/// `ai_memory_embed_*` settings rows instead. This is the SINGLE composer
/// the sync engine uses for peer-vector adoption and backfill detection
/// (`sync::engine::pull_memory_from_peers`); it must stay equal to what the
/// memory worker stamps via `provider_namespaced_model_id` off the hydrated
/// slot, or synced vectors silently stop matching (the exact bug this
/// dedupe guards against). Returns `None` when the slot is unconfigured.
#[doc(hidden)]
pub fn configured_memory_embedding_model_id(conn: &rusqlite::Connection) -> Option<String> {
    let provider = db::get_setting(conn, settings_keys::memory_embed::PROVIDER)
        .ok()
        .flatten()
        .filter(|p| !p.is_empty() && p != "none")?;
    let model = db::get_setting(conn, settings_keys::memory_embed::EMBEDDING_MODEL)
        .ok()
        .flatten()
        .filter(|m| !m.is_empty())?;
    Some(embed_identity(&provider, &model))
}

/// True iff the given provider id is served by spawning a local CLI
/// subprocess (instead of HTTP). Subprocess-backed providers have no
/// endpoint URL and no API key — they reuse the CLI's existing auth.
#[doc(hidden)]
pub fn provider_uses_subprocess(provider_id: &str) -> bool {
    matches!(provider_id, CLAUDE_CLI_ID | CODEX_CLI_ID)
}

/// True iff the given provider id is the on-device sentinel — in-process
/// `fastembed` inference with no HTTP endpoint and no API key (mirrors
/// `provider_uses_subprocess`'s exemption for CLI providers, but for a
/// different reason: there is no subprocess either, just a local model
/// session).
#[doc(hidden)]
pub fn provider_is_on_device(provider_id: &str) -> bool {
    provider_id == ON_DEVICE_PROVIDER_ID
}

/// Classify the disclosure surface of a (provider_id, endpoint) pair.
///
/// - `Local` — HTTP endpoint on loopback / RFC1918 / .local / IPv6 ULA.
/// - `Remote` — HTTP endpoint on the public internet.
/// - `Subscription` — CLI-backed provider. The prompt is handed to a
///   local process via stdin; the CLI then makes its own request
///   using credentials Memlore does not see (the user's Claude /
///   ChatGPT Plus subscription). Tailored privacy copy describes
///   "your local CLI handles auth, Memlore never sees your API key"
///   instead of the misleading Remote-banner copy.
///
/// Recognises BOTH on-device sentinels — the embed-only `on-device`
/// (via [`provider_is_on_device`]) and the chat-only `on-device-llm`
/// sidecar (via [`provider_is_on_device_llm`]). Without the latter check,
/// `on-device-llm` (whose [`preset_default_endpoint`] is `""`) would fall
/// through to `classify_endpoint("")`, which defaults an unparsable URL to
/// `Remote` — mirrors the fix `ai_settings::classify_memory_disclosure`
/// already documents needing for the same reason.
#[doc(hidden)]
pub fn classify_provider_disclosure(provider_id: &str, endpoint: &str) -> EndpointClass {
    if provider_uses_subprocess(provider_id) {
        EndpointClass::Subscription
    } else if provider_is_on_device(provider_id) || provider_is_on_device_llm(provider_id) {
        EndpointClass::OnDevice
    } else {
        classify_endpoint(endpoint)
    }
}

/// True iff the given provider id is the on-device-llm sentinel — the
/// `llama-server` sidecar, which (like `provider_is_on_device`'s embedding
/// counterpart) has no HTTP endpoint of its own: the backend picks a
/// localhost port at spawn time, so a stored empty endpoint is expected,
/// not a sign of a corrupt row.
#[doc(hidden)]
pub fn provider_is_on_device_llm(provider_id: &str) -> bool {
    provider_id == ON_DEVICE_LLM_ID
}

/// Fail-closed setting read: a missing or unparseable key is `false`.
///
/// This is the single definition of "absent means off" for opt-in features
/// whose default carries a privacy consequence — contrast
/// `read_feature_toggle_defaulting_on`, which returns `true` for a missing
/// key. Callers outside this module (e.g. the chat RAG gate in
/// `commands/ai.rs`) must call THIS rather than re-deriving the semantics,
/// so there is only one place where that default can ever be changed.
#[doc(hidden)]
pub fn read_bool_setting(conn: &rusqlite::Connection, key: &str) -> bool {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .map(|s| s == "true")
        .unwrap_or(false)
}

/// Read a **user-facing feature toggle**. Unlike [`read_bool_setting`], a
/// missing/empty key resolves to `true` — every AI feature is enabled by
/// default, so a user who configures a provider lands with all features on
/// instead of having to flip twelve toggles one by one.
///
/// An explicit stored value always wins: `"false"` stays `false`, so a user
/// who turns a feature off stays off. The provider-configured + privacy-
/// accepted gate in `commands::ai_settings::set_ai_feature` still applies before any feature can
/// actually run — this default only controls the desired state.
///
/// Reserved for the twelve feature toggles (the `*_ENABLED` keys surfaced in
/// `commands::ai_settings::read_full_settings`). Keys that must stay fail-closed
/// (`BACKGROUND_INDEXING_ENABLED`, `EMBED_INCLUDE_PROTECTED`, `AI_V2_MIGRATED`)
/// keep using [`read_bool_setting`].
///
/// This is the single source of truth for "feature on by default": both
/// `commands::ai_settings::read_full_settings` (Settings panel display) and the per-feature runtime
/// gates in `commands/ai.rs` / `commands/suggest_tags.rs` / `commands/search.rs`
/// call through here so the UI and the actual feature execution agree.
#[doc(hidden)]
pub fn read_feature_toggle_on(
    conn: &rusqlite::Connection,
    key: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(match db::get_setting(conn, key)? {
        Some(s) if !s.is_empty() => s == "true",
        _ => true,
    })
}

/// Infallible variant of [`read_feature_toggle_on`] for callers that already
/// swallow DB errors (e.g. `commands::ai_settings::read_full_settings`, which reads many keys and
/// treats any read failure the same as a missing key).
#[doc(hidden)]
pub fn read_feature_toggle_defaulting_on(conn: &rusqlite::Connection, key: &str) -> bool {
    read_feature_toggle_on(conn, key).unwrap_or(true)
}

#[doc(hidden)]
pub fn read_string_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

/// Shared gate: true when ANY embedding-consuming feature is enabled —
/// semantic search, emotion suggestions, or chat RAG. These are
/// the only features that read from the chunk vector store, so this is the
/// single source of truth for "does anything need entries to be embedded
/// right now?". Reused by the Phase 2 background embedding worker + its
/// auto-start, the "Index now" command, and the save-path dirty-marking hook
/// (`commands::entries::maybe_mark_entry_embedding_dirty_after_save`).
///
/// Reads the first two with [`read_feature_toggle_on`]'s **default-on**
/// semantics — the same default the Settings panel display and every other
/// per-feature runtime gate use — so a user who configures an embedding
/// provider and never touches the toggles is treated as having these features
/// on, exactly as the UI shows them. Using the fail-closed `read_bool_setting`
/// here (as this once did) silently disagreed with the displayed state: the
/// worker never ran, "Index now" no-op'd, and the indexer sat at "waiting for
/// edits to settle" forever for entries that were never edited.
///
/// Chat RAG (`CHAT_RAG_ENABLED`) is the one exception: it defaults OFF (see
/// `read_full_settings`), so it is read here with the fail-closed
/// `read_bool_setting` too — using the default-on reader would make this
/// gate return `true` for every user who has never touched chat RAG,
/// defeating the other two toggles' explicit "off" state.
///
/// This gate is intentionally about the FEATURE toggles only — it does NOT
/// check whether an embedding provider is configured. Callers that must not
/// act without a provider enforce that separately: `start_backfill` and the
/// worker loop check `registry.embedding()`, and the save-path hook checks the
/// embedding slot's endpoint class before marking a job dirty (a default-on
/// gate would otherwise queue stub-model jobs for users who never set up AI).
pub fn embedding_features_enabled(conn: &rusqlite::Connection) -> bool {
    read_feature_toggle_defaulting_on(conn, settings_keys::SEMANTIC_SEARCH_ENABLED)
        || read_feature_toggle_defaulting_on(conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED)
        || read_bool_setting(conn, settings_keys::CHAT_RAG_ENABLED)
}

/// Consent gate for the Phase 2 background-indexing worker — `true` iff the
/// worker is currently allowed to spend an embedding-provider call.
///
/// This is a **gate only**; it never itself embeds anything.
///
/// - Master toggle (`ai_background_indexing_enabled`) off → always `false`.
/// - The embedding slot's endpoint class is DERIVED via `slot_provider_class`
///   (T2.3: no longer a stored per-slot row) and phrased as "any non-hosted
///   class is auto": `class != Remote` is the auto-allowed branch. That's
///   `Local`, `OnDevice` (Phase 4 — in-process `fastembed` inference,
///   nothing ever leaves the machine), and the unconfigured/`None` case —
///   nothing to protect against yet.
/// - Hosted (`EndpointClass::Remote`) additionally requires
///   `ai_background_indexing_hosted_consent_at` to be set for the CURRENT
///   provider/model — see `commands::ai_provider::persist_embed_config`,
///   which clears that timestamp whenever the embedding provider/model
///   identity changes.
pub fn background_indexing_allowed(conn: &rusqlite::Connection) -> bool {
    if !read_bool_setting(conn, settings_keys::BACKGROUND_INDEXING_ENABLED) {
        return false;
    }
    match slot_provider_class(conn, settings_keys::embed::PROVIDER)
        .ok()
        .flatten()
    {
        // Critical fix (Phase 2): a Remote embed slot with no resolvable
        // API key must never be treated as usable, even with the hosted
        // consent receipt present — otherwise the worker fires keyless
        // requests at the hosted endpoint (transmitting journal text,
        // getting 401, pausing jobs) while Settings still shows the
        // provider as configured. This closes the R12-migration case
        // (provider/model + consent survive the key wipe) and the normal
        // "user cleared their key without changing provider" case alike.
        //
        // NOTE: this can't distinguish "needs a key but has none" from a
        // genuinely keyless hosted endpoint (e.g. a self-hosted gateway
        // configured via the `custom` preset with no auth) — that case is
        // now also gated off. Accepted limitation for the privacy win; see
        // `docs/LATER.md`.
        Some(EndpointClass::Remote) => {
            read_string_setting(conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                .is_some()
                && embed_slot_has_resolvable_key(conn)
        }
        _ => true,
    }
}

/// `true` iff the embed slot's currently configured provider resolves an
/// API key from the per-preset credential registry. Only meaningful for a
/// `Remote`-class slot — see [`background_indexing_allowed`]'s call site.
#[doc(hidden)]
pub fn embed_slot_has_resolvable_key(conn: &rusqlite::Connection) -> bool {
    let Some(provider) = read_string_setting(conn, settings_keys::embed::PROVIDER) else {
        return false;
    };
    resolve_credential(conn, &provider)
        .ok()
        .and_then(|(_, key)| key)
        .is_some()
}

/// Entry auto-index may run only when consent/key/master gates pass **and**
/// the device-local embed-sync decision allows **local dirty** work
/// (`none` / `reembed`, or modal Pause with `pause_scope=sync_backfill`).
/// `pending` / `switch` / Pause+`all` (absent field) hard-block claim/seed.
pub fn entry_embed_auto_allowed(conn: &rusqlite::Connection) -> bool {
    if !background_indexing_allowed(conn) {
        return false;
    }
    match crate::ai::embedding_decision::read_embed_sync_decision(
        conn,
        crate::ai::embedding_decision::EmbedSyncSlot::Entry,
    ) {
        Ok(d) => crate::ai::embedding_decision::auto_index_allowed(
            &d,
            crate::ai::embedding_decision::AutoIndexScope::LocalDirty,
        ),
        // Fail closed: a corrupt/unreadable receipt must not spend tokens.
        Err(_) => false,
    }
}
