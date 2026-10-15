/**
 * Format guard (Phase 15.2).
 *
 * Compares every version seen with `knownVersions()` (WASM): payload magic and schema,
 * keyring, control, manifest fields, and decrypted `EntryMetadata` fields.
 *
 * STRICT vs TOLERANT (Phase 9.1 of the web gap audit):
 * - Control, recovery lease, keyring meta and device slots stay STRICT: an unknown field there is
 *   fail-closed fencing data this client cannot honour, so the guard latches the session
 *   read-only until reload and emits a banner event.
 * - Device manifests (and their entry / journal rows) and decrypted `EntryMetadata` (and its
 *   media / deleted_media items) are TOLERANT: an unknown key is ignored, a row that is not an
 *   object still latches, and the known keys keep their checks. A desktop that starts writing a
 *   field the web must honour instead publishes a feature name in the manifest's
 *   `required_features`; one this build does not know latches (`checkRequiredFeatures`).
 */

import type { Core } from '../../core/core'
import { emitFromBackend } from '../../tauri/event'
import { FormatUnsupportedError } from './onboard'

export const FORMAT_GUARD_LATCHED_EVENT = 'memlore:format-guard-latched'

let isLatched = false
let latchedPath: string | null = null
let latchedReason: string | null = null

export function isFormatGuardLatched(): boolean {
  return isLatched
}

/** Why the guard latched (for the read-only status), or null while it is not latched. */
export function getFormatGuardReason(): string | null {
  return isLatched ? (latchedReason ?? 'unknown format') : null
}

export function resetFormatGuardLatch(): void {
  isLatched = false
  latchedPath = null
  latchedReason = null
}

export function latchFormatGuard(path: string, reason: string): void {
  isLatched = true
  latchedPath = path
  latchedReason = reason
  try {
    emitFromBackend(FORMAT_GUARD_LATCHED_EVENT, { path, reason })
  } catch {
    // Best-effort event delivery
  }
}

/**
 * Runs a read-side format check. False when the format is unknown: the check has LATCHED the
 * guard (every write refused for the session) and the caller's read goes on. Other errors throw.
 */
export function passesFormatGuard(check: () => void): boolean {
  try {
    check()
    return true
  } catch (error) {
    if (error instanceof FormatUnsupportedError) return false
    throw error
  }
}

export function assertFormatGuardOk(): void {
  if (isLatched) {
    throw new FormatUnsupportedError(
      latchedPath ?? 'vault',
      0,
      `Format guard latched read-only: ${latchedReason ?? 'unknown format'}`,
    )
  }
}

interface KnownVersions {
  payload_schema_version: number
  keyring_version: number
  content_list_version: number
  recovery_marker_version: number
  sync_control_version: number
  envelope_versions: number[]
  recovery_word_count: number
}

function parseKnownVersions(core: Core): KnownVersions {
  return JSON.parse(core.knownVersions()) as KnownVersions
}

export function assertKnownVersion(
  core: Core,
  path: string,
  key: keyof Omit<KnownVersions, 'envelope_versions'>,
  actualVersion: number,
): void {
  const known = parseKnownVersions(core)
  const expected = known[key]
  if (actualVersion !== expected) {
    const reason = `Unknown ${String(key)} ${actualVersion} (expected ${expected})`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, actualVersion, `${reason} in ${path}`)
  }
}

export function assertKnownEnvelopeVersion(core: Core, path: string, actualVersion: number): void {
  const known = parseKnownVersions(core)
  if (!known.envelope_versions.includes(actualVersion)) {
    const reason = `Unknown envelope version ${actualVersion} (known: ${known.envelope_versions.join(', ')})`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, actualVersion, `${reason} in ${path}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIfString(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error('Expected JSON object')
    return parsed
  }
  if (!isRecord(value)) throw new Error('Expected object')
  return value
}

function latchShape(path: string, reason: string): never {
  latchFormatGuard(path, reason)
  throw new FormatUnsupportedError(path, 0, `Unsupported format in ${path}: ${reason}`)
}

/** Tolerant check: unknown keys are ignored, but a non-object (a newer shape) latches. */
function assertJsonObject(path: string, obj: unknown): asserts obj is Record<string, unknown> {
  // A structurally different shape (e.g. a string where a row object was) is newer too.
  if (!isRecord(obj)) latchShape(path, 'Expected a JSON object')
}

export function assertKnownJsonFields(
  path: string,
  obj: unknown,
  allowedFields: readonly string[],
): void {
  assertJsonObject(path, obj)
  const allowedSet = new Set(allowedFields)
  const unknownKeys = Object.keys(obj).filter((k) => !allowedSet.has(k))
  if (unknownKeys.length > 0) {
    const reason = `Unknown field(s) found: ${unknownKeys.join(', ')}`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, 0, `Unsupported format in ${path}: ${reason}`)
  }
}

// -----------------------------------------------------------------------------
// Control File (.meta/control.json)
// -----------------------------------------------------------------------------

const CONTROL_FIELDS = ['version', 'recovery_generation', 'recovery_lease', 'updated_at'] as const

const RECOVERY_LEASE_FIELDS = [
  'version',
  'job_id',
  'owner_device_id',
  'operation',
  'recovery_generation',
  'nonce',
  'created_at',
  'updated_at',
] as const

export function checkControlFile(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, CONTROL_FIELDS)

  if (typeof obj.version === 'number') {
    assertKnownVersion(core, path, 'sync_control_version', obj.version)
  }

  if (obj.recovery_lease !== null && obj.recovery_lease !== undefined) {
    assertKnownJsonFields(`${path}#recovery_lease`, obj.recovery_lease, RECOVERY_LEASE_FIELDS)
  }
}

// -----------------------------------------------------------------------------
// Keyring Meta (.meta/keyring/_meta.json)
// -----------------------------------------------------------------------------

const KEYRING_META_FIELDS = [
  'version',
  'epoch',
  'content_epoch',
  'recovery_generation',
  'master_fingerprint',
  'created_at',
  'updated_at',
] as const

export function checkKeyringMeta(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, KEYRING_META_FIELDS)

  if (typeof obj.version === 'number') {
    assertKnownVersion(core, path, 'keyring_version', obj.version)
  }
}

// -----------------------------------------------------------------------------
// Device Slot (.meta/keyring/devices/<id>.json)
// -----------------------------------------------------------------------------

const DEVICE_SLOT_FIELDS = ['version', 'device_id', 'name', 'created_at', 'last_seen_at'] as const

export function checkDeviceSlot(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, DEVICE_SLOT_FIELDS)

  if (typeof obj.version === 'number') {
    assertKnownVersion(core, path, 'keyring_version', obj.version)
  }
}

// -----------------------------------------------------------------------------
// Device Manifest (<device_id>/metadata.json)
// -----------------------------------------------------------------------------

// Tolerant: the known keys are `device_id`, `recovery_generation`, `entries`, `journals`,
// `chats_present`, `memory_present`, `generated_at`, `schema_version`, `index_present`,
// `outbox_versions`, `outbox_kinds` and `required_features`; any other key is ignored.
// Entry rows: `entry_id`, `updated_at`, `local_version`, `is_deleted`, `trashed_at`.
// Journal rows: `journal_id`, `updated_at`, `local_version`, `is_deleted`.

/**
 * Required features this build honours. Mirrors core `REQUIRED_FEATURES`
 * (memlore-core metadata.rs): a desktop that starts writing a field the web must honour (one
 * that changes what the web must show or hide) publishes a feature name in its manifest's
 * `required_features` in the same change. A web build adds the name here only once it honours
 * that field; until then such a manifest latches the session read-only. Never remove a name.
 */
export const KNOWN_FEATURES: readonly string[] = []

/** Feature names safe to show in the read-only reason; anything else is only counted. */
const FEATURE_TOKEN = /^[a-z][a-z0-9_]{0,47}$/
const MAX_ECHOED_FEATURES = 3

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/** A present `key` that is not an array of strings is a newer (or broken) shape: latches. */
function assertStringArrayField(path: string, obj: Record<string, unknown>, key: string): void {
  if (obj[key] !== undefined && !isStringArray(obj[key])) {
    latchShape(path, `${key} is not a list of strings`)
  }
}

/**
 * Latches when the manifest's `required_features` names a feature not in `KNOWN_FEATURES`
 * (absent = none). The reason echoes at most a few short token-shaped names, never raw text.
 */
export function checkRequiredFeatures(path: string, manifest: Record<string, unknown>): void {
  assertStringArrayField(path, manifest, 'required_features')
  const features = isStringArray(manifest.required_features) ? manifest.required_features : []
  const unknown = features.filter((f) => !KNOWN_FEATURES.includes(f))
  if (unknown.length === 0) return
  const shown = unknown.filter((f) => FEATURE_TOKEN.test(f)).slice(0, MAX_ECHOED_FEATURES)
  const names = shown.length > 0 ? `: ${shown.join(', ')}` : ''
  latchShape(path, `Unknown required feature(s) (${unknown.length})${names}`)
}

export function checkDeviceManifest(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertJsonObject(path, obj)
  checkRequiredFeatures(path, obj)
  assertStringArrayField(path, obj, 'outbox_kinds')

  if (typeof obj.schema_version === 'number') {
    assertKnownVersion(core, path, 'payload_schema_version', obj.schema_version)
  }

  if (Array.isArray(obj.entries)) {
    for (let i = 0; i < obj.entries.length; i++) {
      assertJsonObject(`${path}#entries[${i}]`, obj.entries[i])
    }
  }

  if (Array.isArray(obj.journals)) {
    for (let i = 0; i < obj.journals.length; i++) {
      assertJsonObject(`${path}#journals[${i}]`, obj.journals[i])
    }
  }
}

// -----------------------------------------------------------------------------
// Entry Metadata (decrypted JSON inside entry payload)
// -----------------------------------------------------------------------------

// Tolerant: the known keys mirror core `EntryMetadata`, `SyncMediaItem` and
// `SyncDeletedMediaItem`; any other key is ignored (a new field the web must honour comes with a
// manifest `required_features` name). Only a non-object entry or media item latches.

export function checkEntryMetadata(
  _core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertJsonObject(path, obj)

  if (Array.isArray(obj.media)) {
    for (let i = 0; i < obj.media.length; i++) {
      assertJsonObject(`${path}#media[${i}]`, obj.media[i])
    }
  }

  if (Array.isArray(obj.deleted_media)) {
    for (let i = 0; i < obj.deleted_media.length; i++) {
      assertJsonObject(`${path}#deleted_media[${i}]`, obj.deleted_media[i])
    }
  }
}

// -----------------------------------------------------------------------------
// Envelope Bytes
// -----------------------------------------------------------------------------

const XJS1_MAGIC = [0x58, 0x4a, 0x53, 0x31]

export function checkEnvelopeBytes(core: Core, path: string, bytes: Uint8Array): void {
  if (bytes.length < 4) {
    const reason = `Envelope in ${path} is too short (${bytes.length} bytes)`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, 0, reason)
  }

  // Check for XJS1 magic
  const isXJS1 =
    bytes[0] === XJS1_MAGIC[0] &&
    bytes[1] === XJS1_MAGIC[1] &&
    bytes[2] === XJS1_MAGIC[2] &&
    bytes[3] === XJS1_MAGIC[3]

  if (isXJS1) {
    if (bytes.length < 6) {
      const reason = `XJS1 envelope in ${path} is too short (${bytes.length} bytes)`
      latchFormatGuard(path, reason)
      throw new FormatUnsupportedError(path, 0, reason)
    }
    const schemaVersion = bytes[4] | (bytes[5] << 8)
    assertKnownVersion(core, path, 'payload_schema_version', schemaVersion)
    return
  }

  // Check bare envelope version byte
  const firstByte = bytes[0]
  assertKnownEnvelopeVersion(core, path, firstByte)
}
