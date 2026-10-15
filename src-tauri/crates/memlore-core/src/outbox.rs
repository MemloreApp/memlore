//! Outbox format, serialization, sealing, and validation (v1 entries, v2 and v3 intents).
//!
//! The outbox model allows the web companion to write sealed intents to
//! `generations/g-<N>/<webId>/outbox/` without touching sync-protocol files.
//! Desktops with the Phase 14 importer read and apply these intents using
//! their own local code.

use bincode::Options;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeMap;

use crate::encryption::{decrypt_data, encrypt_data, key_fingerprint, NONCE_SIZE, TAG_SIZE};
use crate::envelope::{self, EnvelopeError};
use crate::key_state::ContentKeyList;

/// Magic header for outbox entry files: ASCII "XJO1".
pub const OUTBOX_MAGIC: [u8; 4] = *b"XJO1";

/// Current on-disk outbox schema version.
pub const OUTBOX_SCHEMA_VERSION: u16 = 1;

/// Minimum safe ID byte length.
pub const MIN_SAFE_ID_BYTES: usize = 8;
/// Maximum safe ID byte length.
pub const MAX_SAFE_ID_BYTES: usize = 128;

/// Character class + length bounds for ids that may end up in FK columns,
/// path components, or chat attachment / `source_entry_ids` lists.
pub fn is_safe_id(s: &str) -> bool {
    let len = s.len();
    len >= MIN_SAFE_ID_BYTES
        && len <= MAX_SAFE_ID_BYTES
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Hard upper bound for any single Yjs document update (10 MiB).
pub const MAX_YJS_DOC_BYTES: usize = 10 * 1024 * 1024;

/// Upper bound for outbox payload serialization (32 MiB).
pub const MAX_OUTBOX_PAYLOAD_BYTES: u64 = 32 * 1024 * 1024;

/// Allowed MIME types for outbox media files. Never SVG or HTML.
pub const ALLOWED_MIME_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/quicktime",
];

/// Audio types `attach_media` accepts (wav, mp3, m4a). Never on the v1 list.
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const AUDIO_MIME_TYPES: &[&str] = &["audio/wav", "audio/mpeg", "audio/mp4"];

/// The one generic-file type `attach_media` accepts (exact match).
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const OCTET_STREAM_MIME: &str = "application/octet-stream";

/// Attachment / audio size cap. Taken from desktop `src-tauri/src/commands/media.rs`
/// `MAX_ATTACHED_FILE_SIZE` when v3 froze; a desktop widening is a new kind, not an edit here.
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const MAX_ATTACHED_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// What an outbox MIME type is, under the outbox media policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxMediaClass {
    Image,
    Video,
    Audio,
    File,
}

/// THE outbox media policy: the class of `file_type`, or `None` when no outbox
/// intent may carry it. The v1 media list takes `Image | Video` only (frozen,
/// `ALLOWED_MIME_TYPES`); `attach_media` takes `Audio | File` only. The desktop
/// importer's extension mapping and the web mirror this table.
pub fn outbox_media_class(file_type: &str) -> Option<OutboxMediaClass> {
    if ALLOWED_MIME_TYPES.contains(&file_type) {
        if file_type.starts_with("video/") {
            Some(OutboxMediaClass::Video)
        } else {
            Some(OutboxMediaClass::Image)
        }
    } else if AUDIO_MIME_TYPES.contains(&file_type) {
        Some(OutboxMediaClass::Audio)
    } else if file_type == OCTET_STREAM_MIME {
        Some(OutboxMediaClass::File)
    } else {
        None
    }
}

pub const MAX_TITLE_CHARS: usize = 1000;
pub const MAX_CONTENT_TEXT_CHARS: usize = 10_000_000;
pub const MAX_PREVIEW_TEXT_CHARS: usize = 1000;
pub const MAX_ENTRY_DATE_CHARS: usize = 64;

fn bincode_opts() -> impl bincode::Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_OUTBOX_PAYLOAD_BYTES)
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum OutboxError {
    #[error("outbox buffer too short")]
    ShortBuffer,
    #[error("invalid outbox magic")]
    BadMagic,
    #[error("unsupported schema version: {0}")]
    UnsupportedVersion(u16),
    #[error("key fingerprint mismatch")]
    FingerprintMismatch,
    #[error("wrong decryption key")]
    WrongKey,
    #[error("unsafe id: {0}")]
    InvalidId(String),
    #[error("yjs doc too large: {len} bytes (max {max})")]
    DocTooLarge { len: usize, max: usize },
    #[error("unsupported mime type: {0}")]
    UnsupportedMime(String),
    #[error("text too long: {field} (max {max})")]
    TextTooLong { field: &'static str, max: usize },
    #[error("invalid emotion: {0}")]
    InvalidEmotion(String),
    #[error("envelope error: {0}")]
    Envelope(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("serialization error: {0}")]
    Serialization(String),
    #[error("invalid color: {0}")]
    InvalidColor(String),
    #[error("empty text: {field}")]
    EmptyText { field: &'static str },
    #[error("too many items: {field} (max {max})")]
    TooManyItems { field: &'static str, max: usize },
    #[error("invalid outbox intent file name: {0}")]
    InvalidIntentName(String),
    #[error("outbox intent file name does not match its body: {0}")]
    IntentNameMismatch(String),
    /// A well-formed v3 kind this build cannot decode. Carries only the kind
    /// token (`^[a-z][a-z0-9_]{0,47}$`), never body text.
    #[error("unknown outbox intent kind: {0}")]
    UnknownKind(String),
    #[error("invalid value: {field}")]
    InvalidValue { field: &'static str },
    #[error("invalid coordinates")]
    InvalidCoordinates,
    #[error("media too large: {size} bytes (max {max})")]
    MediaTooLarge { size: u64, max: u64 },
}

impl From<EnvelopeError> for OutboxError {
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::ShortBuffer => OutboxError::ShortBuffer,
            EnvelopeError::WrongKey => OutboxError::WrongKey,
            EnvelopeError::FingerprintMismatch => OutboxError::FingerprintMismatch,
            other => OutboxError::Envelope(other.to_string()),
        }
    }
}

/// A recorded field modification from the web companion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldChange<T> {
    pub value: T,
    pub base: T,
    pub base_updated_at: i64,
    pub change_seq: u64,
    pub changed_at_secs: i64,
}

/// Set of field changes in an entry intent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxFields {
    pub title: Option<FieldChange<String>>,
    pub entry_date: Option<FieldChange<String>>,
    pub emotion: Option<FieldChange<Option<String>>>,
    pub is_favorite: Option<FieldChange<bool>>,
    pub journal_id: Option<FieldChange<String>>,
    #[serde(default)]
    pub tags_add: BTreeMap<String, FieldChange<bool>>,
    #[serde(default)]
    pub tags_remove: BTreeMap<String, FieldChange<bool>>,
}

/// Metadata reference for media associated with an outbox entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxMediaRef {
    pub media_id: String,
    pub file_name: String, // display only, never a path
    pub file_type: String,
    pub size: u64,
    pub has_thumb: bool,
}

/// Decrypted outbox entry intent (Version 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxEntryV1 {
    pub schema_version: u16,
    pub entry_id: String,
    pub web_device_id: String,
    pub created_on_web: bool,
    pub web_updated_at_secs: i64,
    pub base_state_vector: Vec<u8>,
    pub yjs_full_state: Vec<u8>,
    pub content_text: Option<String>,
    pub preview_text: Option<String>,
    pub fields: OutboxFields,
    pub media: Vec<OutboxMediaRef>,
}

impl OutboxEntryV1 {
    pub fn validate(&self) -> Result<(), OutboxError> {
        check_id(&self.entry_id)?;
        check_id(&self.web_device_id)?;
        if self.yjs_full_state.len() > MAX_YJS_DOC_BYTES {
            return Err(OutboxError::DocTooLarge {
                len: self.yjs_full_state.len(),
                max: MAX_YJS_DOC_BYTES,
            });
        }
        if let Some(content) = &self.content_text {
            if content.chars().count() > MAX_CONTENT_TEXT_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "content_text",
                    max: MAX_CONTENT_TEXT_CHARS,
                });
            }
        }
        if let Some(preview) = &self.preview_text {
            if preview.chars().count() > MAX_PREVIEW_TEXT_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "preview_text",
                    max: MAX_PREVIEW_TEXT_CHARS,
                });
            }
        }
        if let Some(t) = &self.fields.title {
            if t.value.chars().count() > MAX_TITLE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "title",
                    max: MAX_TITLE_CHARS,
                });
            }
            if t.base.chars().count() > MAX_TITLE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "title.base",
                    max: MAX_TITLE_CHARS,
                });
            }
        }
        if let Some(d) = &self.fields.entry_date {
            if d.value.chars().count() > MAX_ENTRY_DATE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "entry_date",
                    max: MAX_ENTRY_DATE_CHARS,
                });
            }
            if d.base.chars().count() > MAX_ENTRY_DATE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "entry_date.base",
                    max: MAX_ENTRY_DATE_CHARS,
                });
            }
        }
        if let Some(j) = &self.fields.journal_id {
            check_id(&j.value)?;
            if !j.base.is_empty() {
                check_id(&j.base)?;
            }
        }
        if let Some(e) = &self.fields.emotion {
            if let Some(val) = &e.value {
                if !matches!(val.as_str(), "good" | "neutral" | "bad") {
                    return Err(OutboxError::InvalidEmotion(bounded_echo(val)));
                }
            }
            if let Some(base_val) = &e.base {
                if !matches!(base_val.as_str(), "good" | "neutral" | "bad") {
                    return Err(OutboxError::InvalidEmotion(bounded_echo(base_val)));
                }
            }
        }
        for tag_id in self
            .fields
            .tags_add
            .keys()
            .chain(self.fields.tags_remove.keys())
        {
            check_id(tag_id)?;
        }
        for m in &self.media {
            check_id(&m.media_id)?;
            if !matches!(
                outbox_media_class(&m.file_type),
                Some(OutboxMediaClass::Image | OutboxMediaClass::Video)
            ) {
                return Err(OutboxError::UnsupportedMime(bounded_echo(&m.file_type)));
            }
        }
        Ok(())
    }
}

/// Sealed payload frame written to disk.
#[derive(Serialize, Deserialize)]
struct SealedOutboxEntryPayload {
    schema_version: u16,
    key_fingerprint: [u8; 32],
    ciphertext: Vec<u8>,
}

/// Seal an `OutboxEntryV1` into wire bytes under the latest key in `ContentKeyList`.
pub fn seal_outbox_entry(
    list: &ContentKeyList,
    entry: &OutboxEntryV1,
) -> Result<Vec<u8>, OutboxError> {
    entry.validate()?;
    let plain = bincode_opts()
        .serialize(entry)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    seal_frame(list, OUTBOX_SCHEMA_VERSION, &plain)
}

/// Encrypt `plain` under the latest key and wrap it in the `XJO1` frame
/// carrying `schema_version`. The frame layout is shared by every version.
fn seal_frame(
    list: &ContentKeyList,
    schema_version: u16,
    plain: &[u8],
) -> Result<Vec<u8>, OutboxError> {
    // Same double HKDF / K2 latest key as entries and media
    let (epoch, _) = list
        .keys
        .iter()
        .next_back()
        .ok_or_else(|| OutboxError::Envelope("no content keys in keyring".to_string()))?;
    let content = list.keys.get(epoch).unwrap();
    let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
    let fp = key_fingerprint(&key);

    let inner = encrypt_data(&key, plain).map_err(|e| OutboxError::Crypto(e.to_string()))?;
    let mut ct = Vec::with_capacity(1 + inner.len());
    ct.push(0x01); // Envelope V1 byte
    ct.extend_from_slice(&inner);

    let payload = SealedOutboxEntryPayload {
        schema_version,
        key_fingerprint: fp,
        ciphertext: ct,
    };
    let payload_bytes = bincode_opts()
        .serialize(&payload)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    let mut out = Vec::with_capacity(OUTBOX_MAGIC.len() + payload_bytes.len());
    out.extend_from_slice(&OUTBOX_MAGIC);
    out.extend_from_slice(&payload_bytes);
    Ok(out)
}

/// Open an outbox entry file, validating magic, schema version, fingerprint, and payload fields.
pub fn open_outbox_entry(
    list: &ContentKeyList,
    bytes: &[u8],
) -> Result<OutboxEntryV1, OutboxError> {
    let (_, plain) = open_frame(list, bytes, &[OUTBOX_SCHEMA_VERSION])?;
    decode_v1_body(&plain)
}

/// Decode a v1 (bincode) body, check its inner schema version and validate it.
fn decode_v1_body(plain: &[u8]) -> Result<OutboxEntryV1, OutboxError> {
    let entry: OutboxEntryV1 = bincode_opts()
        .deserialize(plain)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    if entry.schema_version != OUTBOX_SCHEMA_VERSION {
        return Err(OutboxError::UnsupportedVersion(entry.schema_version));
    }
    entry.validate()?;
    Ok(entry)
}

/// Check magic and frame version (against `supported`), find the key by
/// fingerprint and decrypt. Returns the frame version and the plaintext body.
fn open_frame(
    list: &ContentKeyList,
    bytes: &[u8],
    supported: &[u16],
) -> Result<(u16, Vec<u8>), OutboxError> {
    if bytes.len() < OUTBOX_MAGIC.len() {
        return Err(OutboxError::ShortBuffer);
    }
    if bytes[..OUTBOX_MAGIC.len()] != OUTBOX_MAGIC {
        return Err(OutboxError::BadMagic);
    }

    let payload: SealedOutboxEntryPayload = bincode_opts()
        .deserialize(&bytes[OUTBOX_MAGIC.len()..])
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    // Version is checked before any key work so an unreadable newer file is
    // always `UnsupportedVersion` (importer: `skipped_version`), never `corrupt`.
    if !supported.contains(&payload.schema_version) {
        return Err(OutboxError::UnsupportedVersion(payload.schema_version));
    }

    // Locate matching key by fingerprint
    let mut matching_key = None;
    for content in list.keys.values() {
        let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
        if key_fingerprint(&key) == payload.key_fingerprint {
            matching_key = Some(key);
            break;
        }
    }
    let key = matching_key.ok_or(OutboxError::FingerprintMismatch)?;

    let (version, ct) = payload
        .ciphertext
        .split_first()
        .ok_or(OutboxError::ShortBuffer)?;
    if *version != 0x01 {
        return Err(OutboxError::Envelope(format!(
            "unsupported envelope version: {}",
            version
        )));
    }
    if ct.len() < NONCE_SIZE + TAG_SIZE {
        return Err(OutboxError::ShortBuffer);
    }

    let plain = decrypt_data(&key, ct).map_err(|_| OutboxError::WrongKey)?;
    Ok((payload.schema_version, plain))
}

/// Outbox frame versions this build can read: v1 = entry intent (bincode),
/// v2 = journal/tag/template/trash intents (JSON, closed), v3 = open-kind
/// intents (JSON, `OutboxIntentV3`). `OUTBOX_SCHEMA_VERSION` stays 1 because
/// v0.2.2 desktops compare the frame version against it.
pub const SUPPORTED_OUTBOX_VERSIONS: &[u16] = &[1, 2, 3];

/// Frame version carrying an `OutboxIntentV2` JSON body.
pub const OUTBOX_INTENT_V2_SCHEMA_VERSION: u16 = 2;

/// Maximum journal / tag / template name length (chars).
pub const MAX_INTENT_NAME_CHARS: usize = 200;
/// Maximum number of `auto_tag_ids` on a journal intent.
pub const MAX_AUTO_TAG_IDS: usize = 100;
/// Decoded template body cap. Mirror of desktop
/// `src-tauri/src/db/queries.rs` `MAX_TEMPLATE_CONTENT_BYTES`; keep identical so
/// a v2 intent never carries a template the desktop refuses to store.
pub const MAX_TEMPLATE_CONTENT_BYTES: usize = 8 * 1024 * 1024;
/// Template description cap in bytes. Mirror of desktop
/// `src-tauri/src/db/queries.rs` `MAX_TEMPLATE_DESCRIPTION_BYTES`; keep identical.
pub const MAX_TEMPLATE_DESCRIPTION_BYTES: usize = 4 * 1024;

/// Decrypted v2 outbox intent. CLOSED schema: any new kind or field is a new
/// frame version, never an edit here, so a body is rejected whole rather than
/// half-applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutboxIntentV2 {
    CreateJournal {
        web_device_id: String,
        web_updated_at_secs: i64,
        journal_id: String,
        name: String,
        color: Option<String>,
        auto_tag_ids: Vec<String>,
    },
    CreateTag {
        web_device_id: String,
        web_updated_at_secs: i64,
        tag_id: String,
        name: String,
        color: Option<String>,
    },
    /// `base_updated_at: None` = create.
    UpsertTemplate {
        web_device_id: String,
        web_updated_at_secs: i64,
        template_id: String,
        name: String,
        description: Option<String>,
        content_b64: Option<String>,
        sort_order: i64,
        base_updated_at: Option<i64>,
    },
    DeleteTemplate {
        web_device_id: String,
        web_updated_at_secs: i64,
        template_id: String,
        base_updated_at: i64,
    },
    TrashEntry {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        base_updated_at: i64,
    },
}

/// File-name prefix of a v2 intent in `<webId>/outbox/`. Entry intents keep
/// the bare `<uuid>.bin` name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxIntentPrefix {
    Journal,
    Tag,
    Template,
    Trash,
}

impl OutboxIntentPrefix {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Journal => "j-",
            Self::Tag => "t-",
            Self::Template => "p-",
            Self::Trash => "d-",
        }
    }

    /// File letter of the prefix (`as_str` without the dash).
    pub fn letter(self) -> char {
        match self {
            Self::Journal => 'j',
            Self::Tag => 't',
            Self::Template => 'p',
            Self::Trash => 'd',
        }
    }

    /// The v2 prefix for a file letter, if any.
    pub fn from_letter(letter: char) -> Option<Self> {
        [Self::Journal, Self::Tag, Self::Template, Self::Trash]
            .into_iter()
            .find(|p| p.letter() == letter)
    }
}

/// Same shape the desktop enforces for tag colors (`#RRGGBB`); journal
/// colors come from the same palette.
fn is_valid_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

/// Longest attacker string an error echoes.
const MAX_ECHOED_CHARS: usize = 64;

/// Ids, colors, emotions and mime types are attacker text that the importer logs:
/// echo at most `MAX_ECHOED_CHARS` chars, anything outside printable ASCII replaced
/// by `?`, so a hostile body never writes a long or multi-line log record.
fn bounded_echo(text: &str) -> String {
    text.chars()
        .take(MAX_ECHOED_CHARS)
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '?'
            }
        })
        .collect()
}

fn check_id(id: &str) -> Result<(), OutboxError> {
    if is_safe_id(id) {
        Ok(())
    } else {
        Err(OutboxError::InvalidId(bounded_echo(id)))
    }
}

/// A v2 tag / journal / template name: not blank, at most `MAX_INTENT_NAME_CHARS`. Frozen
/// as shipped: web builds sealed v2 names unstripped, so a stricter rule here would drop
/// their intents as corrupt.
fn check_name_v2(name: &str) -> Result<(), OutboxError> {
    if name.trim().is_empty() {
        return Err(OutboxError::EmptyText { field: "name" });
    }
    if name.chars().count() > MAX_INTENT_NAME_CHARS {
        return Err(OutboxError::TextTooLong {
            field: "name",
            max: MAX_INTENT_NAME_CHARS,
        });
    }
    Ok(())
}

/// A v3 name: `check_name_v2`, and plain text as `is_plain_location_text` defines it (no
/// control or disguising char), so two names never differ by something that does not show.
fn check_name(name: &str) -> Result<(), OutboxError> {
    check_name_v2(name)?;
    if !is_plain_location_text(name) {
        return Err(OutboxError::InvalidValue { field: "name" });
    }
    Ok(())
}

fn check_color(color: &Option<String>) -> Result<(), OutboxError> {
    match color {
        Some(c) if !is_valid_color(c) => Err(OutboxError::InvalidColor(bounded_echo(c))),
        _ => Ok(()),
    }
}

fn check_template_content(content_b64: &str) -> Result<(), OutboxError> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    // Reject before decoding: base64 is 4/3 of the decoded size.
    if content_b64.len() > MAX_TEMPLATE_CONTENT_BYTES * 4 / 3 + 16 {
        return Err(OutboxError::DocTooLarge {
            len: content_b64.len() / 4 * 3,
            max: MAX_TEMPLATE_CONTENT_BYTES,
        });
    }
    let decoded = B64
        .decode(content_b64)
        // Fixed message: base64 errors name the offending byte and offset.
        .map_err(|_| OutboxError::Serialization("content_b64: invalid base64".to_string()))?;
    if decoded.len() > MAX_TEMPLATE_CONTENT_BYTES {
        return Err(OutboxError::DocTooLarge {
            len: decoded.len(),
            max: MAX_TEMPLATE_CONTENT_BYTES,
        });
    }
    Ok(())
}

fn check_template_description(description: &Option<String>) -> Result<(), OutboxError> {
    match description {
        Some(d) if d.len() > MAX_TEMPLATE_DESCRIPTION_BYTES => Err(OutboxError::TextTooLong {
            field: "description",
            max: MAX_TEMPLATE_DESCRIPTION_BYTES,
        }),
        _ => Ok(()),
    }
}

impl OutboxIntentV2 {
    pub fn web_device_id(&self) -> &str {
        match self {
            Self::CreateJournal { web_device_id, .. }
            | Self::CreateTag { web_device_id, .. }
            | Self::UpsertTemplate { web_device_id, .. }
            | Self::DeleteTemplate { web_device_id, .. }
            | Self::TrashEntry { web_device_id, .. } => web_device_id,
        }
    }

    /// Id of the journal / tag / template / entry the intent acts on.
    pub fn target_id(&self) -> &str {
        match self {
            Self::CreateJournal { journal_id, .. } => journal_id,
            Self::CreateTag { tag_id, .. } => tag_id,
            Self::UpsertTemplate { template_id, .. } | Self::DeleteTemplate { template_id, .. } => {
                template_id
            }
            Self::TrashEntry { entry_id, .. } => entry_id,
        }
    }

    pub fn prefix(&self) -> OutboxIntentPrefix {
        match self {
            Self::CreateJournal { .. } => OutboxIntentPrefix::Journal,
            Self::CreateTag { .. } => OutboxIntentPrefix::Tag,
            Self::UpsertTemplate { .. } | Self::DeleteTemplate { .. } => {
                OutboxIntentPrefix::Template
            }
            Self::TrashEntry { .. } => OutboxIntentPrefix::Trash,
        }
    }

    /// Outbox file name: `<prefix><target_id>.bin`.
    pub fn file_name(&self) -> String {
        format!("{}{}.bin", self.prefix().as_str(), self.target_id())
    }

    pub fn validate(&self) -> Result<(), OutboxError> {
        check_id(self.web_device_id())?;
        check_id(self.target_id())?;
        match self {
            Self::CreateJournal {
                name,
                color,
                auto_tag_ids,
                ..
            } => {
                check_name_v2(name)?;
                check_color(color)?;
                if auto_tag_ids.len() > MAX_AUTO_TAG_IDS {
                    return Err(OutboxError::TooManyItems {
                        field: "auto_tag_ids",
                        max: MAX_AUTO_TAG_IDS,
                    });
                }
                auto_tag_ids.iter().try_for_each(|id| check_id(id))
            }
            Self::CreateTag { name, color, .. } => {
                check_name_v2(name)?;
                check_color(color)
            }
            Self::UpsertTemplate {
                name,
                description,
                content_b64,
                ..
            } => {
                check_name_v2(name)?;
                check_template_description(description)?;
                content_b64
                    .as_deref()
                    .map_or(Ok(()), check_template_content)
            }
            Self::DeleteTemplate { .. } | Self::TrashEntry { .. } => Ok(()),
        }
    }
}

/// File letter of the media blob (`m-<id>`, `m-<id>.thumb`); never an intent.
const MEDIA_BLOB_LETTER: char = 'm';

/// Parse a v2/v3 intent file name: `^[a-z]-<safe id>\.bin$`, letter != `m`.
/// Returns the letter and the id. Any other letter parses, so a future kind
/// can take a new letter without a parser change. Entry intents (`<uuid>.bin`:
/// a UUID's 2nd char is hex, never `-`) and media files (`m-…`) are rejected.
pub fn parse_intent_name(name: &str) -> Result<(char, &str), OutboxError> {
    let invalid = || OutboxError::InvalidIntentName(bounded_echo(name));
    let stem = name.strip_suffix(".bin").ok_or_else(invalid)?;
    let (head, id) = stem.split_at_checked(2).ok_or_else(invalid)?;
    let mut chars = head.chars();
    let letter = chars.next().ok_or_else(invalid)?;
    if !letter.is_ascii_lowercase()
        || letter == MEDIA_BLOB_LETTER
        || chars.next() != Some('-')
        || !is_safe_id(id)
    {
        return Err(invalid());
    }
    Ok((letter, id))
}

/// Name check shared by v2 and v3: letter ↔ kind and id ↔ target id.
fn check_name_parts(name: &str, letter: char, target_id: &str) -> Result<(), OutboxError> {
    let (name_letter, id) = parse_intent_name(name)?;
    if name_letter != letter || id != target_id {
        return Err(OutboxError::IntentNameMismatch(bounded_echo(name)));
    }
    Ok(())
}

/// Check that a file's name agrees with its decrypted body: prefix ↔ kind
/// and id ↔ target id.
pub fn check_intent_name(name: &str, intent: &OutboxIntentV2) -> Result<(), OutboxError> {
    check_name_parts(name, intent.prefix().letter(), intent.target_id())
}

/// Frame version carrying an `OutboxIntentV3` JSON body.
pub const OUTBOX_INTENT_V3_SCHEMA_VERSION: u16 = 3;

/// Persona traits / style cap (chars). Same value as the app's
/// `ai/persona_builder.rs` `PERSONA_SECTION_MAX_CHARS`, which truncates there;
/// `update_persona` rejects above it instead.
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const PERSONA_SECTION_MAX_CHARS: usize = 1200;
/// Maximum `items` in one `empty_trash` intent.
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const MAX_EMPTY_TRASH_ITEMS: usize = 1000;
/// Location `label` / `address` cap (chars).
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const MAX_LOCATION_TEXT_CHARS: usize = 1000;
/// `attach_media` display file name cap (chars). Display only, never a path.
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const MAX_ATTACH_FILE_NAME_CHARS: usize = 255;
/// `attach_media` `duration_ms` cap: 24 h. At the 50 MiB attachment cap even 8 kbps
/// audio lasts about 14.5 h, so no real file reaches it; it fits `i64` and the desktop
/// `media.duration_seconds REAL` exactly.
/// Part of the frozen v3 format: widening it is a format change, so add a NEW kind
/// name (advertised through the desktop manifest's `outbox_kinds`), never edit this value.
pub const MAX_ATTACH_DURATION_MS: u64 = 24 * 60 * 60 * 1000;
/// Maximum length of a v3 `kind` token.
const MAX_KIND_CHARS: usize = 48;

/// Fixed target id of the `empty_trash` singleton (`d-empty-trash.bin`).
pub const EMPTY_TRASH_TARGET_ID: &str = "empty-trash";
/// Fixed target id of the `update_persona` singleton (`q-user-persona.bin`).
pub const USER_PERSONA_TARGET_ID: &str = "user-persona";

/// Every v3 kind this build can DECODE (not necessarily apply). A well-formed
/// kind outside this list opens as `OutboxError::UnknownKind`.
/// Part of the frozen v3 format: an entry is never removed, renamed or reshaped; a
/// new or widened kind is a NEW kind name, advertised through the desktop manifest's
/// `outbox_kinds`.
pub const SUPPORTED_OUTBOX_KINDS: &[&str] = &[
    "upsert_tag",
    "upsert_journal",
    "upsert_template",
    "delete_template",
    "set_entry_location",
    "attach_media",
    "delete_media",
    "set_media_insertion_mode",
    "restore_entry",
    "trash_entry",
    "purge_entry",
    "empty_trash",
    "delete_tag",
    "delete_journal",
    "delete_memory_item",
    "update_persona",
];

/// `^[a-z][a-z0-9_]{0,47}$`.
fn is_kind_token(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_KIND_CHARS
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// Entry location carried by `set_entry_location` (desktop `entries` columns).
/// `latitude` / `longitude` are both present or both absent (a label-only location,
/// as the desktop LocationPicker saves); one without the other is `InvalidCoordinates`.
/// Without coordinates, a non-blank `label` or `address` is required (`InvalidValue`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutboxLocation {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub label: Option<String>,
    pub address: Option<String>,
}

/// One trashed entry the web listed for `empty_trash`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyTrashItem {
    pub entry_id: String,
    pub base_updated_at: i64,
}

/// Media insertion mode, as desktop `validate_insertion_mode` accepts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaInsertionMode {
    Inline,
    Attached,
}

/// Decrypted v3 outbox intent. The kind name is OPEN (an unknown kind is
/// `UnknownKind`, skipped by the importer), but each kind is CLOSED: every
/// variant rejects unknown fields. A field addition to a kind later is a NEW
/// kind name, never an edit to an existing variant — a v0.x desktop would
/// otherwise refuse or half-apply it. Every kind carries `web_device_id` and
/// `web_updated_at_secs`; `base_updated_at: None` on an upsert = create.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutboxIntentV3 {
    UpsertTag {
        web_device_id: String,
        web_updated_at_secs: i64,
        tag_id: String,
        name: String,
        color: Option<String>,
        base_updated_at: Option<i64>,
    },
    UpsertJournal {
        web_device_id: String,
        web_updated_at_secs: i64,
        journal_id: String,
        name: String,
        color: Option<String>,
        auto_tag_ids: Vec<String>,
        base_updated_at: Option<i64>,
    },
    UpsertTemplate {
        web_device_id: String,
        web_updated_at_secs: i64,
        template_id: String,
        name: String,
        description: Option<String>,
        content_b64: Option<String>,
        sort_order: i64,
        base_updated_at: Option<i64>,
    },
    DeleteTemplate {
        web_device_id: String,
        web_updated_at_secs: i64,
        template_id: String,
        base_updated_at: i64,
    },
    /// `value: None` clears the location; `base` is what the web saw.
    SetEntryLocation {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        value: Option<OutboxLocation>,
        base: Option<OutboxLocation>,
        base_updated_at: i64,
    },
    /// Audio or a generic file; the blob is `m-<media_id>`, no thumbnail.
    AttachMedia {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        media_id: String,
        /// Display only, never a path.
        file_name: String,
        file_type: String,
        size: u64,
        has_thumb: bool,
        duration_ms: Option<u64>,
        insertion_mode: MediaInsertionMode,
    },
    DeleteMedia {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        media_id: String,
    },
    /// `base_updated_at` is the ENTRY's stamp (media rows have none).
    SetMediaInsertionMode {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        media_id: String,
        mode: MediaInsertionMode,
        base_mode: MediaInsertionMode,
        base_updated_at: i64,
    },
    RestoreEntry {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        base_updated_at: i64,
    },
    TrashEntry {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        base_updated_at: i64,
    },
    PurgeEntry {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        base_updated_at: i64,
    },
    /// Exactly the trashed entries the web listed; nothing else is purged.
    EmptyTrash {
        web_device_id: String,
        web_updated_at_secs: i64,
        items: Vec<EmptyTrashItem>,
    },
    DeleteTag {
        web_device_id: String,
        web_updated_at_secs: i64,
        tag_id: String,
        base_updated_at: i64,
    },
    DeleteJournal {
        web_device_id: String,
        web_updated_at_secs: i64,
        journal_id: String,
        base_updated_at: i64,
    },
    DeleteMemoryItem {
        web_device_id: String,
        web_updated_at_secs: i64,
        memory_id: String,
        base_updated_at: i64,
    },
    UpdatePersona {
        web_device_id: String,
        web_updated_at_secs: i64,
        traits_text: String,
        style_text: String,
        enabled: bool,
        base_updated_at: i64,
    },
}

/// Which side of a `set_entry_location` a location is (`check_location`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum LocationRole {
    /// What the web writes: its `label` / `address` are at most `MAX_LOCATION_TEXT_CHARS`
    /// and plain text (`is_plain_location_text`).
    Value,
    /// What the desktop stored, echoed by the web for the importer to compare only (never
    /// stored or shown), so its text is checked for neither length nor charset: a desktop
    /// address with a newline, a control char or over 1000 chars (the desktop command has no
    /// cap) must not make the entry's location un-editable from the web. The frame cap
    /// (`MAX_OUTBOX_PAYLOAD_BYTES`, `open_frame`) still bounds it.
    Base,
}

/// Coordinates both or neither and in range, and never an empty struct, for both roles;
/// the text rules of `LocationRole::Value` for a value.
fn check_location(
    location: &Option<OutboxLocation>,
    role: LocationRole,
) -> Result<(), OutboxError> {
    let Some(l) = location else {
        return Ok(());
    };
    let coords_ok = match (l.latitude, l.longitude) {
        (None, None) => true,
        (Some(lat), Some(lon)) => {
            lat.is_finite()
                && (-90.0..=90.0).contains(&lat)
                && lon.is_finite()
                && (-180.0..=180.0).contains(&lon)
        }
        _ => false,
    };
    if !coords_ok {
        return Err(OutboxError::InvalidCoordinates);
    }
    let has_text = |t: &Option<String>| t.as_deref().is_some_and(|t| !t.trim().is_empty());
    if l.latitude.is_none() && !has_text(&l.label) && !has_text(&l.address) {
        // "No location" is `value: null` / `base: null` only, never an empty struct.
        return Err(OutboxError::InvalidValue { field: "location" });
    }
    if role == LocationRole::Base {
        return Ok(());
    }
    for (field, text) in [
        ("location.label", &l.label),
        ("location.address", &l.address),
    ] {
        let Some(text) = text else { continue };
        if text.chars().count() > MAX_LOCATION_TEXT_CHARS {
            return Err(OutboxError::TextTooLong {
                field,
                max: MAX_LOCATION_TEXT_CHARS,
            });
        }
        if !is_plain_location_text(text) {
            return Err(OutboxError::InvalidValue { field });
        }
    }
    Ok(())
}

/// A character that could disguise text without showing: a line / paragraph separator
/// (U+2028 / U+2029), a zero-width space or directional mark (U+200B, U+200E, U+200F,
/// U+061C, U+FEFF), a bidi embedding / override / isolate (U+202A–U+202E, U+2066–U+2069)
/// or a Unicode tag character (U+E0000–U+E007F). ZWNJ / ZWJ (U+200C / U+200D) pass: they
/// only join or split glyphs (emoji sequences, Persian and Indic words), never reorder or
/// hide text.
fn is_disguising_char(c: char) -> bool {
    matches!(
        c,
        '\u{2028}' | '\u{2029}' | '\u{061C}' | '\u{FEFF}' | '\u{200B}' | '\u{200E}' | '\u{200F}'
    ) || ('\u{202A}'..='\u{202E}').contains(&c)
        || ('\u{2066}'..='\u{2069}').contains(&c)
        || ('\u{E0000}'..='\u{E007F}').contains(&c)
}

/// A location `label` / `address`: no control char (Unicode Cc) and no
/// `is_disguising_char`. `/`, accents and any other text pass.
fn is_plain_location_text(text: &str) -> bool {
    !text
        .chars()
        .any(|c| c.is_control() || is_disguising_char(c))
}

/// Persona traits / style: as `is_plain_location_text`, except that `\n`, `\t` and `\r`
/// pass (the desktop collapses them to spaces). The text is injected into AI system
/// prompts, so an invisible instruction must never reach it.
fn is_plain_persona_text(text: &str) -> bool {
    !text
        .chars()
        .any(|c| (c.is_control() && !matches!(c, '\n' | '\t' | '\r')) || is_disguising_char(c))
}

/// An `attach_media` display name: plain text as `is_plain_location_text` defines it
/// (no control char, line / paragraph separator, zero-width or directional mark, or bidi
/// embedding / override / isolate that could disguise an extension), and no `/` or `\`
/// (a display name, never a path). Any other text, accented letters included, passes.
fn is_display_file_name(name: &str) -> bool {
    is_plain_location_text(name) && !name.contains(['/', '\\'])
}

fn check_chars(text: &str, field: &'static str, max: usize) -> Result<(), OutboxError> {
    if text.chars().count() > max {
        return Err(OutboxError::TextTooLong { field, max });
    }
    Ok(())
}

impl OutboxIntentV3 {
    pub fn web_device_id(&self) -> &str {
        match self {
            Self::UpsertTag { web_device_id, .. }
            | Self::UpsertJournal { web_device_id, .. }
            | Self::UpsertTemplate { web_device_id, .. }
            | Self::DeleteTemplate { web_device_id, .. }
            | Self::SetEntryLocation { web_device_id, .. }
            | Self::AttachMedia { web_device_id, .. }
            | Self::DeleteMedia { web_device_id, .. }
            | Self::SetMediaInsertionMode { web_device_id, .. }
            | Self::RestoreEntry { web_device_id, .. }
            | Self::TrashEntry { web_device_id, .. }
            | Self::PurgeEntry { web_device_id, .. }
            | Self::EmptyTrash { web_device_id, .. }
            | Self::DeleteTag { web_device_id, .. }
            | Self::DeleteJournal { web_device_id, .. }
            | Self::DeleteMemoryItem { web_device_id, .. }
            | Self::UpdatePersona { web_device_id, .. } => web_device_id,
        }
    }

    pub fn web_updated_at_secs(&self) -> i64 {
        match self {
            Self::UpsertTag {
                web_updated_at_secs,
                ..
            }
            | Self::UpsertJournal {
                web_updated_at_secs,
                ..
            }
            | Self::UpsertTemplate {
                web_updated_at_secs,
                ..
            }
            | Self::DeleteTemplate {
                web_updated_at_secs,
                ..
            }
            | Self::SetEntryLocation {
                web_updated_at_secs,
                ..
            }
            | Self::AttachMedia {
                web_updated_at_secs,
                ..
            }
            | Self::DeleteMedia {
                web_updated_at_secs,
                ..
            }
            | Self::SetMediaInsertionMode {
                web_updated_at_secs,
                ..
            }
            | Self::RestoreEntry {
                web_updated_at_secs,
                ..
            }
            | Self::TrashEntry {
                web_updated_at_secs,
                ..
            }
            | Self::PurgeEntry {
                web_updated_at_secs,
                ..
            }
            | Self::EmptyTrash {
                web_updated_at_secs,
                ..
            }
            | Self::DeleteTag {
                web_updated_at_secs,
                ..
            }
            | Self::DeleteJournal {
                web_updated_at_secs,
                ..
            }
            | Self::DeleteMemoryItem {
                web_updated_at_secs,
                ..
            }
            | Self::UpdatePersona {
                web_updated_at_secs,
                ..
            } => *web_updated_at_secs,
        }
    }

    /// Id of the target the intent acts on; with `letter()` it is the file
    /// identity, so one file per target carries the latest intent.
    pub fn target_id(&self) -> &str {
        match self {
            Self::UpsertTag { tag_id, .. } | Self::DeleteTag { tag_id, .. } => tag_id,
            Self::UpsertJournal { journal_id, .. } | Self::DeleteJournal { journal_id, .. } => {
                journal_id
            }
            Self::UpsertTemplate { template_id, .. } | Self::DeleteTemplate { template_id, .. } => {
                template_id
            }
            Self::SetEntryLocation { entry_id, .. }
            | Self::RestoreEntry { entry_id, .. }
            | Self::TrashEntry { entry_id, .. }
            | Self::PurgeEntry { entry_id, .. } => entry_id,
            Self::AttachMedia { media_id, .. }
            | Self::DeleteMedia { media_id, .. }
            | Self::SetMediaInsertionMode { media_id, .. } => media_id,
            Self::EmptyTrash { .. } => EMPTY_TRASH_TARGET_ID,
            Self::DeleteMemoryItem { memory_id, .. } => memory_id,
            Self::UpdatePersona { .. } => USER_PERSONA_TARGET_ID,
        }
    }

    /// File letter of the kind. Part of the schema: never change one.
    pub fn letter(&self) -> char {
        match self {
            Self::UpsertJournal { .. } | Self::DeleteJournal { .. } => 'j',
            Self::UpsertTag { .. } | Self::DeleteTag { .. } => 't',
            Self::UpsertTemplate { .. } | Self::DeleteTemplate { .. } => 'p',
            Self::RestoreEntry { .. }
            | Self::TrashEntry { .. }
            | Self::PurgeEntry { .. }
            | Self::EmptyTrash { .. } => 'd',
            Self::SetEntryLocation { .. } => 'l',
            Self::AttachMedia { .. } | Self::DeleteMedia { .. } => 'a',
            Self::SetMediaInsertionMode { .. } => 'i',
            Self::DeleteMemoryItem { .. } => 'y',
            Self::UpdatePersona { .. } => 'q',
        }
    }

    /// The serde `kind` tag. Part of the schema: never change one.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::UpsertTag { .. } => "upsert_tag",
            Self::UpsertJournal { .. } => "upsert_journal",
            Self::UpsertTemplate { .. } => "upsert_template",
            Self::DeleteTemplate { .. } => "delete_template",
            Self::SetEntryLocation { .. } => "set_entry_location",
            Self::AttachMedia { .. } => "attach_media",
            Self::DeleteMedia { .. } => "delete_media",
            Self::SetMediaInsertionMode { .. } => "set_media_insertion_mode",
            Self::RestoreEntry { .. } => "restore_entry",
            Self::TrashEntry { .. } => "trash_entry",
            Self::PurgeEntry { .. } => "purge_entry",
            Self::EmptyTrash { .. } => "empty_trash",
            Self::DeleteTag { .. } => "delete_tag",
            Self::DeleteJournal { .. } => "delete_journal",
            Self::DeleteMemoryItem { .. } => "delete_memory_item",
            Self::UpdatePersona { .. } => "update_persona",
        }
    }

    /// Outbox file name: `<letter>-<target_id>.bin`.
    pub fn file_name(&self) -> String {
        format!("{}-{}.bin", self.letter(), self.target_id())
    }

    pub fn validate(&self) -> Result<(), OutboxError> {
        check_id(self.web_device_id())?;
        check_id(self.target_id())?;
        match self {
            Self::UpsertTag { name, color, .. } => {
                check_name(name)?;
                check_color(color)
            }
            Self::UpsertJournal {
                name,
                color,
                auto_tag_ids,
                ..
            } => {
                check_name(name)?;
                check_color(color)?;
                if auto_tag_ids.len() > MAX_AUTO_TAG_IDS {
                    return Err(OutboxError::TooManyItems {
                        field: "auto_tag_ids",
                        max: MAX_AUTO_TAG_IDS,
                    });
                }
                auto_tag_ids.iter().try_for_each(|id| check_id(id))
            }
            Self::UpsertTemplate {
                name,
                description,
                content_b64,
                ..
            } => {
                check_name(name)?;
                check_template_description(description)?;
                content_b64
                    .as_deref()
                    .map_or(Ok(()), check_template_content)
            }
            Self::SetEntryLocation {
                entry_id,
                value,
                base,
                ..
            } => {
                check_id(entry_id)?;
                check_location(value, LocationRole::Value)?;
                check_location(base, LocationRole::Base)
            }
            Self::AttachMedia {
                entry_id,
                file_name,
                file_type,
                size,
                has_thumb,
                duration_ms,
                insertion_mode,
                ..
            } => {
                check_id(entry_id)?;
                if file_name.trim().is_empty() {
                    return Err(OutboxError::EmptyText { field: "file_name" });
                }
                check_chars(file_name, "file_name", MAX_ATTACH_FILE_NAME_CHARS)?;
                if !is_display_file_name(file_name) {
                    return Err(OutboxError::InvalidValue { field: "file_name" });
                }
                if duration_ms.is_some_and(|d| d > MAX_ATTACH_DURATION_MS) {
                    return Err(OutboxError::InvalidValue {
                        field: "duration_ms",
                    });
                }
                // Images and videos go through the v1 media list only.
                if !matches!(
                    outbox_media_class(file_type),
                    Some(OutboxMediaClass::Audio | OutboxMediaClass::File)
                ) {
                    return Err(OutboxError::UnsupportedMime(bounded_echo(file_type)));
                }
                if *has_thumb {
                    return Err(OutboxError::InvalidValue { field: "has_thumb" });
                }
                if *insertion_mode != MediaInsertionMode::Attached {
                    return Err(OutboxError::InvalidValue {
                        field: "insertion_mode",
                    });
                }
                if *size > MAX_ATTACHED_FILE_BYTES {
                    return Err(OutboxError::MediaTooLarge {
                        size: *size,
                        max: MAX_ATTACHED_FILE_BYTES,
                    });
                }
                Ok(())
            }
            Self::DeleteMedia { entry_id, .. } | Self::SetMediaInsertionMode { entry_id, .. } => {
                check_id(entry_id)
            }
            Self::EmptyTrash { items, .. } => {
                if items.len() > MAX_EMPTY_TRASH_ITEMS {
                    return Err(OutboxError::TooManyItems {
                        field: "items",
                        max: MAX_EMPTY_TRASH_ITEMS,
                    });
                }
                items.iter().try_for_each(|i| check_id(&i.entry_id))
            }
            Self::UpdatePersona {
                traits_text,
                style_text,
                ..
            } => {
                check_chars(traits_text, "traits_text", PERSONA_SECTION_MAX_CHARS)?;
                check_chars(style_text, "style_text", PERSONA_SECTION_MAX_CHARS)?;
                for (field, text) in [
                    ("persona.traits", traits_text),
                    ("persona.style", style_text),
                ] {
                    if !is_plain_persona_text(text) {
                        return Err(OutboxError::InvalidValue { field });
                    }
                }
                Ok(())
            }
            Self::DeleteTemplate { .. }
            | Self::RestoreEntry { .. }
            | Self::TrashEntry { .. }
            | Self::PurgeEntry { .. }
            | Self::DeleteTag { .. }
            | Self::DeleteJournal { .. }
            | Self::DeleteMemoryItem { .. } => Ok(()),
        }
    }
}

/// Check that a v3 file's name agrees with its decrypted body: letter ↔ kind
/// and id ↔ target id. A known kind under another letter is a mismatch.
pub fn check_intent_name_v3(name: &str, intent: &OutboxIntentV3) -> Result<(), OutboxError> {
    check_name_parts(name, intent.letter(), intent.target_id())
}

/// serde_json errors echo input fragments; keep only class and position.
fn v3_json_error(e: &serde_json::Error) -> OutboxError {
    OutboxError::Serialization(format!("v3 body: {}", crate::json_error_summary(e)))
}

/// Only the `kind` of a v3 body; every other field is skipped unbuffered.
#[derive(Deserialize)]
struct V3KindProbe<'a> {
    #[serde(borrow)]
    kind: Option<Cow<'a, str>>,
}

/// Decode a v3 body in two passes over the same bytes so an unknown kind is told
/// apart from a malformed body: probe `kind`, check its grammar and the supported
/// list, then decode the closed per-kind struct and validate. The probe skips every
/// other field unbuffered, but serde's internally tagged enum buffers the body into
/// its `Content` tree before dispatch, so the body is held twice (bytes + tree) during
/// the second pass; both are bounded by the frame cap (`MAX_OUTBOX_PAYLOAD_BYTES`).
fn decode_v3_body(plain: &[u8]) -> Result<OutboxIntentV3, OutboxError> {
    let probe: V3KindProbe = serde_json::from_slice(plain).map_err(|e| v3_json_error(&e))?;
    let kind = probe
        .kind
        .ok_or_else(|| OutboxError::Serialization("v3 body: no kind".to_string()))?;
    if !is_kind_token(&kind) {
        return Err(OutboxError::Serialization(
            "v3 body: invalid kind token".to_string(),
        ));
    }
    if !SUPPORTED_OUTBOX_KINDS.contains(&kind.as_ref()) {
        return Err(OutboxError::UnknownKind(kind.into_owned()));
    }
    let intent: OutboxIntentV3 = serde_json::from_slice(plain).map_err(|e| v3_json_error(&e))?;
    intent.validate()?;
    Ok(intent)
}

/// Any outbox intent this build can read. `PartialEq` only: v3 carries `f64`.
#[derive(Debug, Clone, PartialEq)]
pub enum OutboxIntent {
    V1(OutboxEntryV1),
    V2(OutboxIntentV2),
    V3(OutboxIntentV3),
}

/// Seal a v2 intent: JSON body, same key/AEAD as v1, frame version 2.
pub fn seal_outbox_intent_v2(
    list: &ContentKeyList,
    intent: &OutboxIntentV2,
) -> Result<Vec<u8>, OutboxError> {
    intent.validate()?;
    let plain =
        serde_json::to_vec(intent).map_err(|e| OutboxError::Serialization(e.to_string()))?;
    seal_frame(list, OUTBOX_INTENT_V2_SCHEMA_VERSION, &plain)
}

/// Seal a v3 intent: JSON body, same key/AEAD as v1, frame version 3.
pub fn seal_outbox_intent_v3(
    list: &ContentKeyList,
    intent: &OutboxIntentV3,
) -> Result<Vec<u8>, OutboxError> {
    intent.validate()?;
    let plain = serde_json::to_vec(intent).map_err(|e| v3_json_error(&e))?;
    seal_frame(list, OUTBOX_INTENT_V3_SCHEMA_VERSION, &plain)
}

/// TEST FIXTURES ONLY (feature `test-sealers`): seal `plain` as-is in a frame of
/// `schema_version`, with no body validation, so fixtures can carry hostile bodies
/// that the typed sealers refuse.
#[cfg(feature = "test-sealers")]
pub fn seal_raw_outbox_frame(
    list: &ContentKeyList,
    schema_version: u16,
    plain: &[u8],
) -> Result<Vec<u8>, OutboxError> {
    seal_frame(list, schema_version, plain)
}

/// Open any supported outbox intent, dispatching on the frame version.
/// Versions outside `SUPPORTED_OUTBOX_VERSIONS` → `UnsupportedVersion`.
pub fn open_outbox_intent(
    list: &ContentKeyList,
    bytes: &[u8],
) -> Result<OutboxIntent, OutboxError> {
    let (version, plain) = open_frame(list, bytes, SUPPORTED_OUTBOX_VERSIONS)?;
    match version {
        OUTBOX_SCHEMA_VERSION => decode_v1_body(&plain).map(OutboxIntent::V1),
        OUTBOX_INTENT_V2_SCHEMA_VERSION => {
            let intent: OutboxIntentV2 = serde_json::from_slice(&plain).map_err(|e| {
                OutboxError::Serialization(format!("v2 body: {}", crate::json_error_summary(&e)))
            })?;
            intent.validate()?;
            Ok(OutboxIntent::V2(intent))
        }
        OUTBOX_INTENT_V3_SCHEMA_VERSION => decode_v3_body(&plain).map(OutboxIntent::V3),
        other => Err(OutboxError::UnsupportedVersion(other)),
    }
}

/// Individual field decision recorded in desktop acks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxFieldDecision {
    pub field: String,
    pub change_seq: u64,
    pub decision: String,
    pub decided_updated_at: i64,
    pub reason: Option<String>,
}

/// Individual entry ack in desktop acks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxAckEntry {
    pub path: String,
    pub content_hash: String,
    pub applied_updated_at: Option<i64>,
    pub decided: Vec<OutboxFieldDecision>,
    pub created: bool,
    pub refused_reason: Option<String>,
}

/// Desktop-published acknowledgements file (`outbox-acks.bin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxAcksV1 {
    pub schema_version: u16,
    pub desktop_device_id: String,
    pub acks: Vec<OutboxAckEntry>,
}

/// Seal outbox acknowledgements using the V2 media envelope.
pub fn seal_outbox_acks(
    list: &ContentKeyList,
    acks: &OutboxAcksV1,
) -> Result<Vec<u8>, OutboxError> {
    let plain = bincode_opts()
        .serialize(acks)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    envelope::seal_media(list, &plain).map_err(OutboxError::from)
}

/// Open outbox acknowledgements using the V2 envelope.
pub fn open_outbox_acks(list: &ContentKeyList, bytes: &[u8]) -> Result<OutboxAcksV1, OutboxError> {
    let plain = envelope::open_media(list, bytes).map_err(OutboxError::from)?;
    let acks: OutboxAcksV1 = bincode_opts()
        .deserialize(&plain)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    match acks.schema_version {
        1 => Ok(acks),
        other => Err(OutboxError::UnsupportedVersion(other)),
    }
}

/// Seal media bytes for `<device>/outbox/m-<mediaId>`.
pub fn seal_outbox_media(list: &ContentKeyList, bytes: &[u8]) -> Result<Vec<u8>, OutboxError> {
    envelope::seal_media(list, bytes).map_err(OutboxError::from)
}

/// Seal a thumbnail for `<device>/outbox/m-<mediaId>.thumb`.
pub fn seal_outbox_thumb(list: &ContentKeyList, jpeg: &[u8]) -> Result<Vec<u8>, OutboxError> {
    envelope::seal_thumb(list, jpeg).map_err(OutboxError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::KEY_SIZE;
    use zeroize::Zeroizing;

    fn sample_keyring(master_byte: u8) -> ContentKeyList {
        let mut keys = BTreeMap::new();
        keys.insert(1, Zeroizing::new([master_byte; KEY_SIZE]));
        ContentKeyList {
            keys,
            latest: 1,
            db_key: Zeroizing::new([0u8; KEY_SIZE]),
            master: Zeroizing::new([master_byte; KEY_SIZE]),
        }
    }

    fn sample_entry() -> OutboxEntryV1 {
        OutboxEntryV1 {
            schema_version: 1,
            entry_id: "entry-12345678".to_string(),
            web_device_id: "web-dev-12345678".to_string(),
            created_on_web: true,
            web_updated_at_secs: 1700000000,
            base_state_vector: vec![1, 2, 3],
            yjs_full_state: vec![4, 5, 6],
            content_text: Some("hello web".to_string()),
            preview_text: Some("hello".to_string()),
            fields: OutboxFields {
                title: Some(FieldChange {
                    value: "My Title".to_string(),
                    base: "".to_string(),
                    base_updated_at: 0,
                    change_seq: 1,
                    changed_at_secs: 1700000000,
                }),
                emotion: Some(FieldChange {
                    value: Some("good".to_string()),
                    base: None,
                    base_updated_at: 0,
                    change_seq: 2,
                    changed_at_secs: 1700000000,
                }),
                ..Default::default()
            },
            media: vec![OutboxMediaRef {
                media_id: "media-12345678".to_string(),
                file_name: "photo.jpg".to_string(),
                file_type: "image/jpeg".to_string(),
                size: 1024,
                has_thumb: true,
            }],
        }
    }

    #[test]
    fn test_roundtrip_outbox_entry() {
        let ring = sample_keyring(0x42);
        let entry = sample_entry();
        let sealed = seal_outbox_entry(&ring, &entry).expect("seal");
        let opened = open_outbox_entry(&ring, &sealed).expect("open");
        assert_eq!(opened, entry);
    }

    #[test]
    fn test_wrong_key() {
        let ring1 = sample_keyring(0x42);
        let ring2 = sample_keyring(0x99);
        let entry = sample_entry();
        let sealed = seal_outbox_entry(&ring1, &entry).expect("seal");
        let err = open_outbox_entry(&ring2, &sealed).unwrap_err();
        assert_eq!(err, OutboxError::FingerprintMismatch);
    }

    #[test]
    fn test_truncation() {
        let ring = sample_keyring(0x42);
        let entry = sample_entry();
        let sealed = seal_outbox_entry(&ring, &entry).expect("seal");
        let err = open_outbox_entry(&ring, &sealed[..10]).unwrap_err();
        assert!(matches!(err, OutboxError::Serialization(_)));
    }

    #[test]
    fn test_bad_magic() {
        let ring = sample_keyring(0x42);
        let entry = sample_entry();
        let mut sealed = seal_outbox_entry(&ring, &entry).expect("seal");
        sealed[0] = b'Z';
        assert_eq!(
            open_outbox_entry(&ring, &sealed).unwrap_err(),
            OutboxError::BadMagic
        );
    }

    #[test]
    fn test_unsupported_version() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.schema_version = 2;
        // Sealing validates or serializes version 2
        let plain = bincode_opts().serialize(&entry).unwrap();
        let (epoch, _) = ring.keys.iter().next_back().unwrap();
        let content = ring.keys.get(epoch).unwrap();
        let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
        let fp = key_fingerprint(&key);
        let inner = encrypt_data(&key, &plain).unwrap();
        let mut ct = vec![0x01];
        ct.extend_from_slice(&inner);
        let payload = SealedOutboxEntryPayload {
            schema_version: 2,
            key_fingerprint: fp,
            ciphertext: ct,
        };
        let mut bytes = OUTBOX_MAGIC.to_vec();
        bytes.extend_from_slice(&bincode_opts().serialize(&payload).unwrap());

        let err = open_outbox_entry(&ring, &bytes).unwrap_err();
        assert_eq!(err, OutboxError::UnsupportedVersion(2));
    }

    #[test]
    fn test_unsafe_id() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.entry_id = "bad/id".to_string();
        let err = seal_outbox_entry(&ring, &entry).unwrap_err();
        assert_eq!(err, OutboxError::InvalidId("bad/id".to_string()));
    }

    #[test]
    fn test_oversized_doc() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.yjs_full_state = vec![0u8; MAX_YJS_DOC_BYTES + 1];
        let err = seal_outbox_entry(&ring, &entry).unwrap_err();
        assert_eq!(
            err,
            OutboxError::DocTooLarge {
                len: MAX_YJS_DOC_BYTES + 1,
                max: MAX_YJS_DOC_BYTES
            }
        );
    }

    #[test]
    fn test_svg_mime_rejected() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.media[0].file_type = "image/svg+xml".to_string();
        let err = seal_outbox_entry(&ring, &entry).unwrap_err();
        assert_eq!(
            err,
            OutboxError::UnsupportedMime("image/svg+xml".to_string())
        );
    }

    #[test]
    fn test_roundtrip_acks() {
        let ring = sample_keyring(0x42);
        let acks = OutboxAcksV1 {
            schema_version: 1,
            desktop_device_id: "desktop-dev-12345678".to_string(),
            acks: vec![OutboxAckEntry {
                path: "web-dev-12345678/outbox/entry-12345678.bin".to_string(),
                content_hash: "hash1234".to_string(),
                applied_updated_at: Some(1700000010),
                decided: vec![OutboxFieldDecision {
                    field: "title".to_string(),
                    change_seq: 1,
                    decision: "applied".to_string(),
                    decided_updated_at: 1700000010,
                    reason: None,
                }],
                created: true,
                refused_reason: None,
            }],
        };
        let sealed = seal_outbox_acks(&ring, &acks).expect("seal acks");
        let opened = open_outbox_acks(&ring, &sealed).expect("open acks");
        assert_eq!(opened, acks);
    }

    /// v1 file sealed by the pre-v2 code (`sample_keyring(0x42)`, `sample_entry()`).
    /// Wire bytes on users' Drives must keep opening unchanged.
    const V1_FIXTURE_HEX: &str = "584a4f3101006df7030e6b183f45789d6b97a2f8a97060b03f65e1cf091a018b0df6dd5ab7bf4101000000000000011e0abde7092075c8d85e7c2967538730e6814a954d12ba69005ddf4cc5ed6be0efe587db2708a804dcba2684995e53c3b733dbd55b0cc22a17ae64f03d63504fb2a0cbb6e457dcab69a697025f03c30866c894ae5721fd5a06e4319eb6a99845ee5f6b9a96581bed7fd5b2589e0d522ed1805f703bae27a41c443b6cab29aa6f8bd7db5dbeea5550a16f9da3e8446a8860f8375ebb4d92f39dc9fd7130ec6633183682fe9af17f6f2360ca7111a562d0061a450487454317c5bb68ee27ea14d5f5050121ffd8bdec543821c5f0e141749eb88e46a3c954258e6a9286c00775d5dcb6b371c22fc12e6dc6529e22e4afb86cd2d04922950b426be50dfe19feccf73315075d41496a573182d6044939b4c8951b871454866e547341cd5d555ee9f810d1a26c8870764b50dac26e5f1fe17caf9bf3e734d593b46f8fe8d4128f17e5";

    fn ring_fingerprint(ring: &ContentKeyList) -> [u8; 32] {
        let content = ring.keys.values().next_back().unwrap();
        key_fingerprint(&crate::encryption::derive_sync_key(
            &crate::encryption::derive_sync_key(content),
        ))
    }

    #[test]
    fn v1_fixture_sealed_before_v2_still_opens() {
        let ring = sample_keyring(0x42);
        let bytes = hex::decode(V1_FIXTURE_HEX).unwrap();
        assert_eq!(open_outbox_entry(&ring, &bytes).unwrap(), sample_entry());
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap(),
            OutboxIntent::V1(sample_entry())
        );
    }

    #[test]
    fn v1_seal_frame_layout_unchanged() {
        let ring = sample_keyring(0x42);
        let sealed = seal_outbox_entry(&ring, &sample_entry()).unwrap();
        let fixture = hex::decode(V1_FIXTURE_HEX).unwrap();
        assert_eq!(sealed.len(), fixture.len());
        assert_eq!(&sealed[..4], b"XJO1");
        assert_eq!(&sealed[4..6], &[1, 0]);
        assert_eq!(&sealed[6..38], &ring_fingerprint(&ring));
        // ciphertext length prefix (u64 LE) and envelope byte
        assert_eq!(&sealed[..47], &fixture[..47]);
    }

    #[test]
    fn v1_audio_mime_still_rejected() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.media[0].file_type = "audio/mpeg".to_string();
        assert_eq!(
            seal_outbox_entry(&ring, &entry).unwrap_err(),
            OutboxError::UnsupportedMime("audio/mpeg".to_string())
        );
    }

    const WEB: &str = "web-dev-12345678";

    fn all_v2_kinds() -> Vec<OutboxIntentV2> {
        vec![
            OutboxIntentV2::CreateJournal {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000000,
                journal_id: "journal-12345678".to_string(),
                name: "Travel".to_string(),
                color: Some("#7C3AED".to_string()),
                auto_tag_ids: vec!["tag-aaaaaaaa".to_string()],
            },
            OutboxIntentV2::CreateTag {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000001,
                tag_id: "tag-12345678".to_string(),
                name: "work".to_string(),
                color: None,
            },
            OutboxIntentV2::UpsertTemplate {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000002,
                template_id: "template-12345678".to_string(),
                name: "Gratitude".to_string(),
                description: Some("three things".to_string()),
                content_b64: Some("AQID".to_string()),
                sort_order: 3,
                base_updated_at: None,
            },
            OutboxIntentV2::DeleteTemplate {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000003,
                template_id: "template-12345678".to_string(),
                base_updated_at: 1690000000,
            },
            OutboxIntentV2::TrashEntry {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000004,
                entry_id: "entry-12345678".to_string(),
                base_updated_at: 1690000001,
            },
        ]
    }

    fn sample_journal() -> OutboxIntentV2 {
        all_v2_kinds().remove(0)
    }

    /// Seal an arbitrary JSON body in a v2 frame, bypassing typed validation.
    fn seal_raw_v2(ring: &ContentKeyList, json: &str) -> Vec<u8> {
        seal_frame(ring, OUTBOX_INTENT_V2_SCHEMA_VERSION, json.as_bytes()).unwrap()
    }

    #[test]
    fn v2_roundtrips_every_kind() {
        let ring = sample_keyring(0x42);
        for intent in all_v2_kinds() {
            let sealed = seal_outbox_intent_v2(&ring, &intent).unwrap();
            assert_eq!(&sealed[..4], b"XJO1");
            assert_eq!(&sealed[4..6], &[2, 0]);
            assert_eq!(
                open_outbox_intent(&ring, &sealed).unwrap(),
                OutboxIntent::V2(intent)
            );
        }
    }

    #[test]
    fn v2_kind_tags_are_snake_case() {
        let kinds: Vec<String> = all_v2_kinds()
            .iter()
            .map(|i| {
                serde_json::to_value(i).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "create_journal",
                "create_tag",
                "upsert_template",
                "delete_template",
                "trash_entry"
            ]
        );
    }

    /// A v0.2.2 desktop only calls `open_outbox_entry`; a v2 file must land
    /// as `skipped_version`, never `corrupt` — even under a key it lacks.
    #[test]
    fn v2_frame_is_unsupported_version_for_v1_opener() {
        let ring = sample_keyring(0x42);
        let sealed = seal_outbox_intent_v2(&ring, &sample_journal()).unwrap();
        assert_eq!(
            open_outbox_entry(&ring, &sealed).unwrap_err(),
            OutboxError::UnsupportedVersion(2)
        );
        assert_eq!(
            open_outbox_entry(&sample_keyring(0x99), &sealed).unwrap_err(),
            OutboxError::UnsupportedVersion(2)
        );
    }

    #[test]
    fn open_intent_rejects_unknown_frame_version() {
        let ring = sample_keyring(0x42);
        let bytes = seal_frame(&ring, 4, b"{}").unwrap();
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::UnsupportedVersion(4)
        );
    }

    #[test]
    fn v2_unknown_field_rejected() {
        let ring = sample_keyring(0x42);
        let mut v = serde_json::to_value(sample_journal()).unwrap();
        v["icon"] = serde_json::json!("book");
        let bytes = seal_raw_v2(&ring, &v.to_string());
        assert!(matches!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::Serialization(_)
        ));
    }

    #[test]
    fn v2_unknown_kind_rejected() {
        let ring = sample_keyring(0x42);
        let bytes = seal_raw_v2(
            &ring,
            r#"{"kind":"rename_journal","web_device_id":"web-dev-12345678","web_updated_at_secs":1,"journal_id":"journal-12345678"}"#,
        );
        assert!(matches!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::Serialization(_)
        ));
    }

    #[test]
    fn v2_open_validates_body() {
        let ring = sample_keyring(0x42);
        let mut v = serde_json::to_value(sample_journal()).unwrap();
        v["journal_id"] = serde_json::json!("../etc/passwd");
        let bytes = seal_raw_v2(&ring, &v.to_string());
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::InvalidId("../etc/passwd".to_string())
        );
    }

    #[test]
    fn v2_rejects_invalid_fields() {
        let ring = sample_keyring(0x42);
        let journal = |f: &dyn Fn(&mut OutboxIntentV2)| {
            let mut i = sample_journal();
            f(&mut i);
            seal_outbox_intent_v2(&ring, &i).unwrap_err()
        };
        assert_eq!(
            journal(&|i| if let OutboxIntentV2::CreateJournal { name, .. } = i {
                *name = "x".repeat(MAX_INTENT_NAME_CHARS + 1)
            }),
            OutboxError::TextTooLong {
                field: "name",
                max: MAX_INTENT_NAME_CHARS
            }
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { color, .. } = i {
                    *color = Some("red".to_string())
                }
            ),
            OutboxError::InvalidColor("red".to_string())
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { auto_tag_ids, .. } = i {
                    *auto_tag_ids = (0..=MAX_AUTO_TAG_IDS)
                        .map(|n| format!("tag-{n:08}"))
                        .collect()
                }
            ),
            OutboxError::TooManyItems {
                field: "auto_tag_ids",
                max: MAX_AUTO_TAG_IDS
            }
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { auto_tag_ids, .. } = i {
                    *auto_tag_ids = vec!["bad/tag".to_string()]
                }
            ),
            OutboxError::InvalidId("bad/tag".to_string())
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { web_device_id, .. } = i {
                    *web_device_id = "short".to_string()
                }
            ),
            OutboxError::InvalidId("short".to_string())
        );

        let template = |content: String| OutboxIntentV2::UpsertTemplate {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1,
            template_id: "template-12345678".to_string(),
            name: "T".to_string(),
            description: None,
            content_b64: Some(content),
            sort_order: 0,
            base_updated_at: None,
        };
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let at_cap = B64.encode(vec![0u8; MAX_TEMPLATE_CONTENT_BYTES]);
        assert!(template(at_cap).validate().is_ok());
        let over = B64.encode(vec![0u8; MAX_TEMPLATE_CONTENT_BYTES + 1]);
        assert!(matches!(
            seal_outbox_intent_v2(&ring, &template(over)).unwrap_err(),
            OutboxError::DocTooLarge { .. }
        ));
        assert!(matches!(
            seal_outbox_intent_v2(&ring, &template("not base64!".to_string())).unwrap_err(),
            OutboxError::Serialization(_)
        ));
    }

    /// Desktop refuses templates over its caps (`db::queries`
    /// `check_template_size`); the closed schema must never accept them.
    #[test]
    fn v2_template_caps_match_desktop() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        assert_eq!(MAX_TEMPLATE_CONTENT_BYTES, 8 * 1024 * 1024);
        assert_eq!(MAX_TEMPLATE_DESCRIPTION_BYTES, 4 * 1024);
        let template =
            |description: Option<String>, content: Option<String>| OutboxIntentV2::UpsertTemplate {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1,
                template_id: "template-12345678".to_string(),
                name: "T".to_string(),
                description,
                content_b64: content,
                sort_order: 0,
                base_updated_at: None,
            };
        // Between the template cap and the Yjs cap: desktop would refuse it.
        let over = B64.encode(vec![0u8; MAX_TEMPLATE_CONTENT_BYTES + 1]);
        assert_eq!(
            template(None, Some(over)).validate().unwrap_err(),
            OutboxError::DocTooLarge {
                len: MAX_TEMPLATE_CONTENT_BYTES + 1,
                max: MAX_TEMPLATE_CONTENT_BYTES
            }
        );
        // Description is measured in bytes, like desktop.
        let at_cap = "\u{e9}".repeat(MAX_TEMPLATE_DESCRIPTION_BYTES / 2);
        assert!(template(Some(at_cap.clone()), None).validate().is_ok());
        assert_eq!(
            template(Some(format!("{at_cap}x")), None)
                .validate()
                .unwrap_err(),
            OutboxError::TextTooLong {
                field: "description",
                max: MAX_TEMPLATE_DESCRIPTION_BYTES
            }
        );
    }

    #[test]
    fn v2_rejects_empty_or_blank_names() {
        let ring = sample_keyring(0x42);
        for intent in all_v2_kinds() {
            for blank in ["", "   ", "\t\n"] {
                let mut v = serde_json::to_value(&intent).unwrap();
                if v.get("name").is_none() {
                    continue;
                }
                v["name"] = serde_json::json!(blank);
                let typed: OutboxIntentV2 = serde_json::from_value(v.clone()).unwrap();
                assert_eq!(
                    typed.validate().unwrap_err(),
                    OutboxError::EmptyText { field: "name" },
                    "{v}"
                );
                // The opener applies the same rule to a raw body.
                assert_eq!(
                    open_outbox_intent(&ring, &seal_raw_v2(&ring, &v.to_string())).unwrap_err(),
                    OutboxError::EmptyText { field: "name" }
                );
            }
        }
    }

    /// Text joined with ZWJ (an emoji family) and ZWNJ (a Persian word): neither reorders
    /// nor hides text, so every plain-text field accepts them (frozen at release).
    const JOINED: &str = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}";

    /// A v3 tag / journal / template name refuses a control or disguising char without
    /// echoing it, and keeps ZWJ / ZWNJ text (frozen at release). A v2 name keeps the rule
    /// it shipped with (blank + length only): shipped web builds sealed v2 names unstripped,
    /// and a stricter check would drop those intents as corrupt for good.
    #[test]
    fn v3_names_refuse_control_and_disguising_chars_v2_names_unchanged() {
        fn check<T: serde::Serialize + serde::de::DeserializeOwned>(
            intent: &T,
            refuses: bool,
            validate: impl Fn(T) -> Result<(), OutboxError>,
        ) -> bool {
            let mut v = serde_json::to_value(intent).unwrap();
            if v.get("name").is_none() {
                return false;
            }
            let mut with = |name: &str| {
                v["name"] = serde_json::json!(name);
                validate(serde_json::from_value(v.clone()).unwrap())
            };
            with(JOINED).unwrap();
            for bad in [
                '\0',
                '\n',
                '\t',
                '\u{85}',
                '\u{2028}',
                '\u{200B}',
                '\u{200F}',
                '\u{202E}',
                '\u{2066}',
                '\u{061C}',
                '\u{FEFF}',
                '\u{E0041}',
            ] {
                let result = with(&format!("Work{bad}x"));
                if refuses {
                    assert_eq!(
                        result.unwrap_err(),
                        OutboxError::InvalidValue { field: "name" },
                        "{:04X}",
                        bad as u32
                    );
                } else {
                    result.unwrap_or_else(|e| panic!("{:04X}: {e:?}", bad as u32));
                }
            }
            true
        }
        let v2 = all_v2_kinds()
            .iter()
            .filter(|i| check(*i, false, |i: OutboxIntentV2| i.validate()))
            .count();
        let v3 = all_v3_kinds()
            .iter()
            .filter(|(i, _)| check(i, true, |i: OutboxIntentV3| i.validate()))
            .count();
        assert_eq!((v2, v3), (3, 3));
    }

    #[test]
    fn intent_file_names_match_kind_and_id() {
        let names: Vec<String> = all_v2_kinds().iter().map(|i| i.file_name()).collect();
        assert_eq!(
            names,
            [
                "j-journal-12345678.bin",
                "t-tag-12345678.bin",
                "p-template-12345678.bin",
                "p-template-12345678.bin",
                "d-entry-12345678.bin"
            ]
        );
        for intent in all_v2_kinds() {
            assert_eq!(
                parse_intent_name(&intent.file_name()).unwrap(),
                (intent.prefix().letter(), intent.target_id())
            );
            check_intent_name(&intent.file_name(), &intent).unwrap();
        }
    }

    #[test]
    fn parse_intent_name_rejects_non_intent_files() {
        for name in [
            "11111111-2222-3333-4444-555555555555.bin",
            "m-media-12345678",
            "m-media-12345678.thumb",
            "m-media-12345678.bin",
            "J-journal-12345678.bin",
            "jj-journal-12345678.bin",
            "-journal-12345678.bin",
            "\u{e9}-journal-12345678.bin",
            "j-journal-12345678",
            "j-short.bin",
            "j-bad/id-12345678.bin",
            "j-",
        ] {
            assert!(
                matches!(
                    parse_intent_name(name),
                    Err(OutboxError::InvalidIntentName(_))
                ),
                "{name}"
            );
        }
    }

    /// serde_json errors echo input fragments ("invalid type: string
    /// \"SECRET\"", "unknown variant `SECRET`"); the opener must not.
    #[test]
    fn v2_open_errors_never_echo_the_decrypted_body() {
        let ring = sample_keyring(0x42);
        let journal = serde_json::to_value(sample_journal()).unwrap();
        let mut wrong_type = journal.clone();
        wrong_type["name"] = serde_json::json!({"SECRET": "SECRET"});
        let mut wrong_type_str = journal.clone();
        wrong_type_str["auto_tag_ids"] = serde_json::json!("SECRET");
        let mut unknown_kind = journal.clone();
        unknown_kind["kind"] = serde_json::json!("SECRET_kind");
        let mut unknown_field = journal.clone();
        unknown_field["SECRET_field"] = serde_json::json!(1);
        for body in [
            wrong_type.to_string(),
            wrong_type_str.to_string(),
            unknown_kind.to_string(),
            unknown_field.to_string(),
            "{\"kind\":\"SECRET".to_string(),
        ] {
            let err = open_outbox_intent(&ring, &seal_raw_v2(&ring, &body)).unwrap_err();
            assert!(matches!(err, OutboxError::Serialization(_)), "{err:?}");
            assert!(!err.to_string().contains("SECRET"), "{err}");
        }

        // Frame 3: the same bodies, plus hostile kind tokens. Only a token that
        // passes the kind grammar may reach `UnknownKind`, and nothing else.
        let tag = serde_json::to_value(sample_v3_tag()).unwrap();
        let mut v3_wrong_type = tag.clone();
        v3_wrong_type["name"] = serde_json::json!({"SECRET": "SECRET"});
        let mut v3_unknown_field = tag.clone();
        v3_unknown_field["SECRET_field"] = serde_json::json!("SECRET");
        let mut v3_upper_kind = tag.clone();
        v3_upper_kind["kind"] = serde_json::json!("SECRET_kind");
        let mut v3_nested_field = serde_json::to_value(sample_v3_location()).unwrap();
        v3_nested_field["value"]["SECRET_field"] = serde_json::json!(1);
        for body in [
            v3_wrong_type.to_string(),
            v3_unknown_field.to_string(),
            v3_upper_kind.to_string(),
            v3_nested_field.to_string(),
            "{\"kind\":\"SECRET".to_string(),
        ] {
            let err = open_outbox_intent(&ring, &seal_raw_v3(&ring, &body)).unwrap_err();
            assert!(matches!(err, OutboxError::Serialization(_)), "{err:?}");
            assert!(!err.to_string().contains("SECRET"), "{err}");
        }
        let mut v3_unknown_kind = tag.clone();
        v3_unknown_kind["kind"] = serde_json::json!("rename_entry");
        v3_unknown_kind["SECRET_field"] = serde_json::json!("SECRET");
        let err = open_outbox_intent(&ring, &seal_raw_v3(&ring, &v3_unknown_kind.to_string()))
            .unwrap_err();
        assert_eq!(err, OutboxError::UnknownKind("rename_entry".to_string()));
        assert!(!err.to_string().contains("SECRET"), "{err}");
    }

    #[test]
    fn template_base64_error_has_no_input_fragment() {
        let err = check_template_content("AQID#SECRET").unwrap_err();
        assert!(matches!(err, OutboxError::Serialization(_)), "{err:?}");
        // Fixed text: no offending symbol, no offset.
        assert_eq!(
            err.to_string(),
            "serialization error: content_b64: invalid base64"
        );
    }

    #[test]
    fn check_intent_name_rejects_prefix_or_id_mismatch() {
        let journal = sample_journal();
        for name in ["t-journal-12345678.bin", "j-journal-87654321.bin"] {
            assert_eq!(
                check_intent_name(name, &journal).unwrap_err(),
                OutboxError::IntentNameMismatch(name.to_string())
            );
        }
    }

    const ENTRY: &str = "entry-12345678";
    const MEDIA: &str = "media-12345678";

    fn sample_v3_tag() -> OutboxIntentV3 {
        OutboxIntentV3::UpsertTag {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1700000000,
            tag_id: "tag-12345678".to_string(),
            name: "work".to_string(),
            color: Some("#7C3AED".to_string()),
            base_updated_at: None,
        }
    }

    fn location(latitude: f64, longitude: f64) -> OutboxLocation {
        coords(Some(latitude), Some(longitude))
    }

    fn coords(latitude: Option<f64>, longitude: Option<f64>) -> OutboxLocation {
        OutboxLocation {
            latitude,
            longitude,
            label: Some("Home".to_string()),
            address: None,
        }
    }

    fn sample_v3_location() -> OutboxIntentV3 {
        OutboxIntentV3::SetEntryLocation {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1700000000,
            entry_id: ENTRY.to_string(),
            value: Some(location(48.8566, 2.3522)),
            base: None,
            base_updated_at: 1690000000,
        }
    }

    fn sample_attach(file_type: &str) -> OutboxIntentV3 {
        OutboxIntentV3::AttachMedia {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1700000000,
            entry_id: ENTRY.to_string(),
            media_id: MEDIA.to_string(),
            file_name: "voice memo.m4a".to_string(),
            file_type: file_type.to_string(),
            size: 4096,
            has_thumb: false,
            duration_ms: Some(61_500),
            insertion_mode: MediaInsertionMode::Attached,
        }
    }

    fn sample_persona(traits_text: String, style_text: String) -> OutboxIntentV3 {
        OutboxIntentV3::UpdatePersona {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1700000000,
            traits_text,
            style_text,
            enabled: true,
            base_updated_at: 1690000000,
        }
    }

    /// Every v3 kind with the file name the web must write it under.
    fn all_v3_kinds() -> Vec<(OutboxIntentV3, &'static str)> {
        let w = || WEB.to_string();
        vec![
            (sample_v3_tag(), "t-tag-12345678.bin"),
            (
                OutboxIntentV3::UpsertJournal {
                    web_device_id: w(),
                    web_updated_at_secs: 1,
                    journal_id: "journal-12345678".to_string(),
                    name: "Travel".to_string(),
                    color: None,
                    auto_tag_ids: vec!["tag-aaaaaaaa".to_string()],
                    base_updated_at: Some(1690000000),
                },
                "j-journal-12345678.bin",
            ),
            (
                OutboxIntentV3::UpsertTemplate {
                    web_device_id: w(),
                    web_updated_at_secs: 2,
                    template_id: "template-12345678".to_string(),
                    name: "Gratitude".to_string(),
                    description: Some("three things".to_string()),
                    content_b64: Some("AQID".to_string()),
                    sort_order: 3,
                    base_updated_at: None,
                },
                "p-template-12345678.bin",
            ),
            (
                OutboxIntentV3::DeleteTemplate {
                    web_device_id: w(),
                    web_updated_at_secs: 3,
                    template_id: "template-12345678".to_string(),
                    base_updated_at: 1690000000,
                },
                "p-template-12345678.bin",
            ),
            (sample_v3_location(), "l-entry-12345678.bin"),
            (
                OutboxIntentV3::SetEntryLocation {
                    web_device_id: w(),
                    web_updated_at_secs: 4,
                    entry_id: ENTRY.to_string(),
                    value: None,
                    base: Some(location(-90.0, 180.0)),
                    base_updated_at: 1690000000,
                },
                "l-entry-12345678.bin",
            ),
            (sample_attach("audio/mp4"), "a-media-12345678.bin"),
            (
                OutboxIntentV3::DeleteMedia {
                    web_device_id: w(),
                    web_updated_at_secs: 5,
                    entry_id: ENTRY.to_string(),
                    media_id: MEDIA.to_string(),
                },
                "a-media-12345678.bin",
            ),
            (
                OutboxIntentV3::SetMediaInsertionMode {
                    web_device_id: w(),
                    web_updated_at_secs: 6,
                    entry_id: ENTRY.to_string(),
                    media_id: MEDIA.to_string(),
                    mode: MediaInsertionMode::Attached,
                    base_mode: MediaInsertionMode::Inline,
                    base_updated_at: 1690000000,
                },
                "i-media-12345678.bin",
            ),
            (
                OutboxIntentV3::RestoreEntry {
                    web_device_id: w(),
                    web_updated_at_secs: 7,
                    entry_id: ENTRY.to_string(),
                    base_updated_at: 1690000000,
                },
                "d-entry-12345678.bin",
            ),
            (
                OutboxIntentV3::TrashEntry {
                    web_device_id: w(),
                    web_updated_at_secs: 8,
                    entry_id: ENTRY.to_string(),
                    base_updated_at: 1690000000,
                },
                "d-entry-12345678.bin",
            ),
            (
                OutboxIntentV3::PurgeEntry {
                    web_device_id: w(),
                    web_updated_at_secs: 9,
                    entry_id: ENTRY.to_string(),
                    base_updated_at: 1690000000,
                },
                "d-entry-12345678.bin",
            ),
            (
                OutboxIntentV3::EmptyTrash {
                    web_device_id: w(),
                    web_updated_at_secs: 10,
                    items: vec![EmptyTrashItem {
                        entry_id: ENTRY.to_string(),
                        base_updated_at: 1690000000,
                    }],
                },
                "d-empty-trash.bin",
            ),
            (
                OutboxIntentV3::DeleteTag {
                    web_device_id: w(),
                    web_updated_at_secs: 11,
                    tag_id: "tag-12345678".to_string(),
                    base_updated_at: 1690000000,
                },
                "t-tag-12345678.bin",
            ),
            (
                OutboxIntentV3::DeleteJournal {
                    web_device_id: w(),
                    web_updated_at_secs: 12,
                    journal_id: "journal-12345678".to_string(),
                    base_updated_at: 1690000000,
                },
                "j-journal-12345678.bin",
            ),
            (
                OutboxIntentV3::DeleteMemoryItem {
                    web_device_id: w(),
                    web_updated_at_secs: 13,
                    memory_id: "memory-12345678".to_string(),
                    base_updated_at: 1690000000,
                },
                "y-memory-12345678.bin",
            ),
            (
                sample_persona("curious".to_string(), "brief".to_string()),
                "q-user-persona.bin",
            ),
        ]
    }

    /// Seal an arbitrary JSON body in a v3 frame, bypassing typed validation.
    fn seal_raw_v3(ring: &ContentKeyList, json: &str) -> Vec<u8> {
        seal_frame(ring, OUTBOX_INTENT_V3_SCHEMA_VERSION, json.as_bytes()).unwrap()
    }

    fn kind_of(intent: &OutboxIntentV3) -> String {
        serde_json::to_value(intent).unwrap()["kind"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn v3_roundtrips_every_kind_under_its_file_name() {
        let ring = sample_keyring(0x42);
        for (intent, name) in all_v3_kinds() {
            let sealed = seal_outbox_intent_v3(&ring, &intent).unwrap();
            assert_eq!(&sealed[..4], b"XJO1");
            assert_eq!(&sealed[4..6], &[3, 0]);
            assert_eq!(
                open_outbox_intent(&ring, &sealed).unwrap(),
                OutboxIntent::V3(intent.clone())
            );
            assert_eq!(intent.file_name(), name);
            assert_eq!(
                parse_intent_name(name).unwrap(),
                (intent.letter(), intent.target_id())
            );
            check_intent_name_v3(name, &intent).unwrap();
        }
    }

    /// `kind()` is the serde tag of every variant, and the decoder accepts it.
    #[test]
    fn v3_kind_is_the_serde_tag_and_supported() {
        for (intent, _) in all_v3_kinds() {
            assert_eq!(intent.kind(), kind_of(&intent));
            assert!(SUPPORTED_OUTBOX_KINDS.contains(&intent.kind()));
        }
    }

    /// `SUPPORTED_OUTBOX_KINDS` is what the decoder lets through to the typed
    /// enum; a kind missing from it would be skipped, an extra one corrupt.
    #[test]
    fn v3_supported_kinds_are_exactly_the_enum_kinds() {
        let mut kinds: Vec<String> = all_v3_kinds().iter().map(|(i, _)| kind_of(i)).collect();
        kinds.sort();
        kinds.dedup();
        let mut supported: Vec<String> = SUPPORTED_OUTBOX_KINDS
            .iter()
            .map(|k| k.to_string())
            .collect();
        supported.sort();
        assert_eq!(kinds, supported);
    }

    #[test]
    fn v3_frame_is_unsupported_version_for_v1_opener() {
        let ring = sample_keyring(0x42);
        let sealed = seal_outbox_intent_v3(&ring, &sample_v3_tag()).unwrap();
        for opener in [sample_keyring(0x42), sample_keyring(0x99)] {
            assert_eq!(
                open_outbox_entry(&opener, &sealed).unwrap_err(),
                OutboxError::UnsupportedVersion(3)
            );
        }
    }

    #[test]
    fn v3_unknown_kind_is_unknown_kind_not_serialization() {
        let ring = sample_keyring(0x42);
        let bytes = seal_raw_v3(
            &ring,
            r#"{"kind":"rename_entry2","web_device_id":"web-dev-12345678","anything":[1,2]}"#,
        );
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::UnknownKind("rename_entry2".to_string())
        );
    }

    #[test]
    fn v3_unknown_field_on_every_kind_is_serialization() {
        let ring = sample_keyring(0x42);
        for (intent, _) in all_v3_kinds() {
            let mut v = serde_json::to_value(&intent).unwrap();
            v["extra"] = serde_json::json!(1);
            let err = open_outbox_intent(&ring, &seal_raw_v3(&ring, &v.to_string())).unwrap_err();
            assert!(matches!(err, OutboxError::Serialization(_)), "{v}: {err:?}");
        }
        // Nested structs are closed too.
        let mut loc = serde_json::to_value(sample_v3_location()).unwrap();
        loc["value"]["altitude"] = serde_json::json!(35.0);
        let (empty_trash, _) = all_v3_kinds()
            .into_iter()
            .find(|(i, _)| matches!(i, OutboxIntentV3::EmptyTrash { .. }))
            .unwrap();
        let mut trash = serde_json::to_value(empty_trash).unwrap();
        trash["items"][0]["purge_media"] = serde_json::json!(true);
        for v in [loc, trash] {
            let err = open_outbox_intent(&ring, &seal_raw_v3(&ring, &v.to_string())).unwrap_err();
            assert!(matches!(err, OutboxError::Serialization(_)), "{v}: {err:?}");
        }
    }

    #[test]
    fn v3_hostile_kind_token_is_serialization() {
        let ring = sample_keyring(0x42);
        let tag = serde_json::to_value(sample_v3_tag()).unwrap();
        for kind in [
            serde_json::json!("a".repeat(49)),
            serde_json::json!("upsert_t\u{e1}g"),
            serde_json::json!("Upsert_tag"),
            serde_json::json!("1upsert"),
            serde_json::json!("_upsert"),
            serde_json::json!("upsert-tag"),
            serde_json::json!(""),
            serde_json::json!(7),
            serde_json::Value::Null,
        ] {
            let mut v = tag.clone();
            v["kind"] = kind.clone();
            let err = open_outbox_intent(&ring, &seal_raw_v3(&ring, &v.to_string())).unwrap_err();
            assert!(
                matches!(err, OutboxError::Serialization(_)),
                "{kind}: {err:?}"
            );
        }
        // The longest legal token is a well-formed unknown kind.
        let mut v = tag.clone();
        v["kind"] = serde_json::json!("a".repeat(48));
        assert_eq!(
            open_outbox_intent(&ring, &seal_raw_v3(&ring, &v.to_string())).unwrap_err(),
            OutboxError::UnknownKind("a".repeat(48))
        );
        for body in ["[]", "\"upsert_tag\"", "{}", "not json"] {
            let err = open_outbox_intent(&ring, &seal_raw_v3(&ring, body)).unwrap_err();
            assert!(
                matches!(err, OutboxError::Serialization(_)),
                "{body}: {err:?}"
            );
        }
    }

    #[test]
    fn v3_open_validates_body() {
        let ring = sample_keyring(0x42);
        let mut v = serde_json::to_value(sample_v3_tag()).unwrap();
        v["tag_id"] = serde_json::json!("../etc/passwd");
        assert_eq!(
            open_outbox_intent(&ring, &seal_raw_v3(&ring, &v.to_string())).unwrap_err(),
            OutboxError::InvalidId("../etc/passwd".to_string())
        );
    }

    #[test]
    fn generic_intent_names_take_any_letter_but_m() {
        for (name, letter, id) in [
            (
                "l-11111111-2222-3333-4444-555555555555.bin",
                'l',
                "11111111-2222-3333-4444-555555555555",
            ),
            ("d-empty-trash.bin", 'd', "empty-trash"),
            ("q-user-persona.bin", 'q', "user-persona"),
            // A future kind's letter parses without a parser change.
            ("z-thing-12345678.bin", 'z', "thing-12345678"),
        ] {
            assert_eq!(parse_intent_name(name).unwrap(), (letter, id), "{name}");
        }
    }

    #[test]
    fn check_intent_name_v3_rejects_wrong_letter_or_id() {
        let attach = sample_attach("audio/wav");
        let (empty_trash, _) = all_v3_kinds()
            .into_iter()
            .find(|(i, _)| matches!(i, OutboxIntentV3::EmptyTrash { .. }))
            .unwrap();
        let persona = sample_persona(String::new(), String::new());
        for (name, intent) in [
            ("l-media-12345678.bin", &attach),
            ("i-media-12345678.bin", &attach),
            ("a-media-87654321.bin", &attach),
            ("a-entry-12345678.bin", &attach),
            ("d-entry-12345678.bin", &empty_trash),
            ("t-empty-trash.bin", &empty_trash),
            ("q-persona-12345678.bin", &persona),
        ] {
            assert_eq!(
                check_intent_name_v3(name, intent).unwrap_err(),
                OutboxError::IntentNameMismatch(name.to_string()),
                "{name}"
            );
        }
        assert!(matches!(
            check_intent_name_v3("m-media-12345678.bin", &attach).unwrap_err(),
            OutboxError::InvalidIntentName(_)
        ));
    }

    #[test]
    fn attach_media_policy() {
        for ok in [
            "audio/wav",
            "audio/mpeg",
            "audio/mp4",
            "application/octet-stream",
        ] {
            sample_attach(ok).validate().unwrap();
        }
        // Images and videos go through the v1 media list, never attach_media.
        for refused in ALLOWED_MIME_TYPES.iter().copied().chain([
            "audio/ogg",
            "text/html",
            "application/octet-stream; x=1",
            "",
        ]) {
            assert_eq!(
                sample_attach(refused).validate().unwrap_err(),
                OutboxError::UnsupportedMime(refused.to_string()),
                "{refused}"
            );
        }
        let with = |f: &dyn Fn(&mut OutboxIntentV3)| {
            let mut i = sample_attach("audio/mpeg");
            f(&mut i);
            i.validate()
        };
        assert_eq!(
            with(
                &|i| if let OutboxIntentV3::AttachMedia { has_thumb, .. } = i {
                    *has_thumb = true
                }
            )
            .unwrap_err(),
            OutboxError::InvalidValue { field: "has_thumb" }
        );
        assert_eq!(
            with(
                &|i| if let OutboxIntentV3::AttachMedia { insertion_mode, .. } = i {
                    *insertion_mode = MediaInsertionMode::Inline
                }
            )
            .unwrap_err(),
            OutboxError::InvalidValue {
                field: "insertion_mode"
            }
        );
        with(&|i| {
            if let OutboxIntentV3::AttachMedia { size, .. } = i {
                *size = MAX_ATTACHED_FILE_BYTES
            }
        })
        .unwrap();
        assert_eq!(
            with(&|i| if let OutboxIntentV3::AttachMedia { size, .. } = i {
                *size = MAX_ATTACHED_FILE_BYTES + 1
            })
            .unwrap_err(),
            OutboxError::MediaTooLarge {
                size: MAX_ATTACHED_FILE_BYTES + 1,
                max: MAX_ATTACHED_FILE_BYTES
            }
        );
    }

    /// `file_type` is attacker text: a v3 refusal echoes a bounded, printable-ASCII token.
    #[test]
    fn attach_media_refusal_bounds_the_echoed_mime() {
        let hostile = format!("audio/\u{202e}\n{}", "x".repeat(10_000));
        assert_eq!(
            sample_attach(&hostile).validate().unwrap_err(),
            OutboxError::UnsupportedMime(format!("audio/??{}", "x".repeat(56)))
        );
    }

    /// Persona text reaches AI system prompts: an invisible character (tag, zero-width,
    /// bidi, other control) is rejected in either field without echoing it, while the
    /// whitespace controls the desktop collapses pass.
    #[test]
    fn persona_text_with_invisible_chars_rejected() {
        sample_persona("a\nb\tc\rd".to_string(), "e\r\nf".to_string())
            .validate()
            .unwrap();
        sample_persona(JOINED.to_string(), JOINED.to_string())
            .validate()
            .unwrap();
        for c in [
            '\u{E0041}',
            '\u{E0001}',
            '\u{E007F}',
            '\u{200B}',
            '\u{200F}',
            '\u{FEFF}',
            '\u{061C}',
            '\u{202A}',
            '\u{202E}',
            '\u{2066}',
            '\u{2069}',
            '\u{0000}',
            '\u{0007}',
            '\u{001B}',
            '\u{007F}',
            '\u{0085}',
        ] {
            let bad = format!("calm{c}writer");
            assert_eq!(
                sample_persona(bad.clone(), String::new())
                    .validate()
                    .unwrap_err(),
                OutboxError::InvalidValue {
                    field: "persona.traits"
                },
                "{:?}",
                c
            );
            assert_eq!(
                sample_persona(String::new(), bad).validate().unwrap_err(),
                OutboxError::InvalidValue {
                    field: "persona.style"
                },
                "{:?}",
                c
            );
        }
    }

    /// Desktop truncates persona text at this cap; the outbox rejects instead,
    /// so the web never sends text that would land cut.
    #[test]
    fn persona_text_over_cap_rejected() {
        let at_cap = "\u{e9}".repeat(PERSONA_SECTION_MAX_CHARS);
        sample_persona(at_cap.clone(), at_cap.clone())
            .validate()
            .unwrap();
        let over = format!("{at_cap}x");
        assert_eq!(
            sample_persona(over.clone(), String::new())
                .validate()
                .unwrap_err(),
            OutboxError::TextTooLong {
                field: "traits_text",
                max: PERSONA_SECTION_MAX_CHARS
            }
        );
        assert_eq!(
            sample_persona(String::new(), over).validate().unwrap_err(),
            OutboxError::TextTooLong {
                field: "style_text",
                max: PERSONA_SECTION_MAX_CHARS
            }
        );
    }

    #[test]
    fn location_coordinates_must_be_finite_and_in_range() {
        let with = |value: Option<OutboxLocation>, base: Option<OutboxLocation>| {
            OutboxIntentV3::SetEntryLocation {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1,
                entry_id: ENTRY.to_string(),
                value,
                base,
                base_updated_at: 1,
            }
            .validate()
        };
        for (lat, lon) in [(90.0, 180.0), (-90.0, -180.0), (0.0, 0.0)] {
            with(Some(location(lat, lon)), Some(location(lat, lon))).unwrap();
        }
        // Label-only (desktop LocationPicker saves lat = lng = null with a label).
        with(Some(coords(None, None)), Some(coords(None, None))).unwrap();
        for half in [coords(Some(1.0), None), coords(None, Some(1.0))] {
            for err in [
                with(Some(half.clone()), None).unwrap_err(),
                with(None, Some(half.clone())).unwrap_err(),
            ] {
                assert_eq!(err, OutboxError::InvalidCoordinates, "{half:?}");
            }
        }
        // No coordinates and no text is not a location ("none" is `null` only).
        let empty = |label: Option<&str>, address: Option<&str>| OutboxLocation {
            latitude: None,
            longitude: None,
            label: label.map(str::to_string),
            address: address.map(str::to_string),
        };
        with(Some(empty(None, Some("1 Rue de Rivoli"))), None).unwrap();
        for blank in [
            empty(None, None),
            empty(Some(""), Some("")),
            empty(Some("  "), None),
        ] {
            for err in [
                with(Some(blank.clone()), None).unwrap_err(),
                with(None, Some(blank.clone())).unwrap_err(),
            ] {
                assert_eq!(err, OutboxError::InvalidValue { field: "location" });
            }
        }
        for (lat, lon) in [
            (f64::NAN, 0.0),
            (0.0, f64::NAN),
            (f64::INFINITY, 0.0),
            (0.0, f64::NEG_INFINITY),
            (90.000001, 0.0),
            (-90.5, 0.0),
            (0.0, 180.5),
            (0.0, -181.0),
        ] {
            for err in [
                with(Some(location(lat, lon)), None).unwrap_err(),
                with(None, Some(location(lat, lon))).unwrap_err(),
            ] {
                assert_eq!(err, OutboxError::InvalidCoordinates, "{lat},{lon}");
            }
        }
        let mut long_label = location(1.0, 1.0);
        long_label.label = Some("x".repeat(MAX_LOCATION_TEXT_CHARS + 1));
        assert!(matches!(
            with(Some(long_label), None).unwrap_err(),
            OutboxError::TextTooLong { .. }
        ));
    }

    /// Frozen at release: a location VALUE label or address with a control, separator,
    /// zero-width or bidi char is refused, never echoed.
    #[test]
    fn location_text_refuses_control_bidi_and_zero_width_chars() {
        let with = |label: &str, address: &str| {
            OutboxIntentV3::SetEntryLocation {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1,
                entry_id: ENTRY.to_string(),
                value: Some(OutboxLocation {
                    latitude: None,
                    longitude: None,
                    label: Some(label.to_string()),
                    address: Some(address.to_string()),
                }),
                base: None,
                base_updated_at: 1,
            }
            .validate()
        };
        let plain = "Café 12/3 Rue de Rivoli, Hà Nội";
        with(plain, plain).unwrap();
        with(JOINED, JOINED).unwrap();
        for bad in [
            '\0',
            '\n',
            '\t',
            '\u{1B}',
            '\u{7F}',
            '\u{85}',
            '\u{2028}',
            '\u{2029}',
            '\u{200B}',
            '\u{200E}',
            '\u{200F}',
            '\u{202A}',
            '\u{202E}',
            '\u{2066}',
            '\u{2069}',
            '\u{061C}',
            '\u{FEFF}',
            '\u{E0001}',
            '\u{E0041}',
            '\u{E007F}',
        ] {
            let text = format!("Home{bad}x");
            assert_eq!(
                with(&text, plain).unwrap_err(),
                OutboxError::InvalidValue {
                    field: "location.label"
                },
                "{:04X}",
                bad as u32
            );
            assert_eq!(
                with(plain, &text).unwrap_err(),
                OutboxError::InvalidValue {
                    field: "location.address"
                },
                "{:04X}",
                bad as u32
            );
        }
    }

    /// A `base` echoes what the desktop stored: a newline, a control char or a text over
    /// `MAX_LOCATION_TEXT_CHARS` in it never makes the entry's location un-editable from the
    /// web (only the value is charset- and length-checked).
    #[test]
    fn location_base_text_is_not_charset_or_length_checked() {
        let long = "x".repeat(MAX_LOCATION_TEXT_CHARS + 1);
        let base = |label: &str, address: &str| OutboxIntentV3::SetEntryLocation {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1,
            entry_id: ENTRY.to_string(),
            value: None,
            base: Some(OutboxLocation {
                latitude: Some(48.85),
                longitude: Some(2.35),
                label: Some(label.to_string()),
                address: Some(address.to_string()),
            }),
            base_updated_at: 1,
        };
        for (label, address) in [
            ("Home\nx\u{1B}", "12 Rue de Rivoli\r\nParis\u{200B}"),
            (long.as_str(), long.as_str()),
        ] {
            base(label, address).validate().unwrap();
        }
    }

    #[test]
    fn empty_trash_items_are_capped_and_checked() {
        let with = |items: Vec<EmptyTrashItem>| {
            OutboxIntentV3::EmptyTrash {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1,
                items,
            }
            .validate()
        };
        let item = |n: usize| EmptyTrashItem {
            entry_id: format!("entry-{n:08}"),
            base_updated_at: 1,
        };
        with((0..MAX_EMPTY_TRASH_ITEMS).map(item).collect()).unwrap();
        assert_eq!(
            with((0..=MAX_EMPTY_TRASH_ITEMS).map(item).collect()).unwrap_err(),
            OutboxError::TooManyItems {
                field: "items",
                max: MAX_EMPTY_TRASH_ITEMS
            }
        );
        assert_eq!(
            with(vec![EmptyTrashItem {
                entry_id: "bad/id".to_string(),
                base_updated_at: 1
            }])
            .unwrap_err(),
            OutboxError::InvalidId("bad/id".to_string())
        );
    }

    /// Ids, colors, mime types and emotions are attacker text that the importer logs:
    /// every frame echoes them bounded and on one line.
    #[test]
    fn hostile_id_and_color_echo_is_bounded_and_single_line() {
        let hostile = format!("bad\nid\r{}", "x".repeat(10_000));
        let mut entry = sample_entry();
        entry.entry_id = hostile.clone();
        let mut journal = sample_journal();
        if let OutboxIntentV2::CreateJournal { color, .. } = &mut journal {
            *color = Some(hostile.clone());
        }
        let mut tag = sample_v3_tag();
        if let OutboxIntentV3::UpsertTag { tag_id, .. } = &mut tag {
            *tag_id = hostile.clone();
        }
        let mut v1_mime = sample_entry();
        v1_mime.media[0].file_type = hostile.clone();
        let mut v1_emotion = sample_entry();
        if let Some(e) = &mut v1_emotion.fields.emotion {
            e.value = Some(hostile.clone());
        }
        for err in [
            entry.validate().unwrap_err(),
            journal.validate().unwrap_err(),
            tag.validate().unwrap_err(),
            v1_mime.validate().unwrap_err(),
            v1_emotion.validate().unwrap_err(),
            sample_attach(&hostile).validate().unwrap_err(),
        ] {
            let echoed = match &err {
                OutboxError::InvalidId(s)
                | OutboxError::InvalidColor(s)
                | OutboxError::UnsupportedMime(s)
                | OutboxError::InvalidEmotion(s) => s.clone(),
                other => panic!("{other:?}"),
            };
            assert_eq!(echoed, format!("bad?id?{}", "x".repeat(57)));
            assert!(!err.to_string().contains(['\n', '\r']));
        }
    }

    /// `file_name` is display text, never a path, and never blank: no controls, bidi,
    /// zero-width or separator chars (frozen at release).
    #[test]
    fn attach_media_file_name_rejects_controls_bidi_and_separators() {
        let with = |name: &str| {
            let mut i = sample_attach("audio/mpeg");
            if let OutboxIntentV3::AttachMedia { file_name, .. } = &mut i {
                *file_name = name.to_string();
            }
            i.validate()
        };
        for ok in [
            "voice memo.m4a",
            "Ghi \u{e2}m caf\u{e9} (1).m4a",
            "a.b-c_d",
            JOINED,
        ] {
            with(ok).unwrap();
        }
        for bad in [
            "a\0b.m4a",
            "a\nb.m4a",
            "a\tb.m4a",
            "a\u{7f}b",
            "a\u{85}b",
            "a\u{202a}b",
            "a\u{202e}b",
            "a\u{2066}b",
            "a\u{2069}b",
            "a\u{200B}b.m4a",
            "a\u{200F}b",
            "a\u{061C}b",
            "a\u{2028}b",
            "a\u{2029}b",
            "\u{FEFF}a.m4a",
            "../a.m4a",
            "a/b",
            "a\\b",
        ] {
            assert_eq!(
                with(bad).unwrap_err(),
                OutboxError::InvalidValue { field: "file_name" },
                "{bad:?}"
            );
        }
        for blank in ["", "   ", "\t"] {
            assert_eq!(
                with(blank).unwrap_err(),
                OutboxError::EmptyText { field: "file_name" },
                "{blank:?}"
            );
        }
    }

    #[test]
    fn attach_media_duration_is_capped() {
        let with = |d: Option<u64>| {
            let mut i = sample_attach("audio/mpeg");
            if let OutboxIntentV3::AttachMedia { duration_ms, .. } = &mut i {
                *duration_ms = d;
            }
            i.validate()
        };
        with(None).unwrap();
        with(Some(MAX_ATTACH_DURATION_MS)).unwrap();
        for over in [MAX_ATTACH_DURATION_MS + 1, u64::MAX] {
            assert_eq!(
                with(Some(over)).unwrap_err(),
                OutboxError::InvalidValue {
                    field: "duration_ms"
                }
            );
        }
    }
}
