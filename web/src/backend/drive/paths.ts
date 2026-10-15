/**
 * Pure path rules of the Drive layout shared with the desktop app (no network, no state).
 *
 * Physical layout under the Drive appDataFolder (see memlore-core envelope.rs "Path namespace
 * and read rules"): `Memlore/generations/g-<N>/<device>/...` for writes (always, even at N = 0,
 * because the desktop production provider always enables the recovery fence), and the legacy
 * flat `Memlore/<device>/...` that desktops still READ. The web writes only its own outbox and
 * its device slot; everything else here is read-side.
 */

export const APPDATA_PARENT = 'appDataFolder'
export const ROOT_FOLDER_NAME = 'Memlore'
export const GENERATIONS_FOLDER = 'generations'
export const OUTBOX_FOLDER = 'outbox'

/** Shared ancestors of the device slot, from the Memlore root. */
export const DEVICE_SLOT_FOLDERS = ['.meta', 'keyring', 'devices'] as const

/** Lowercase hyphenated uuid, case-sensitive (no uppercase, no braces). Web-minted ids only. */
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * A desktop-minted id (memlore-core outbox.rs `is_safe_id`): 8-128 ASCII alphanumerics, `-` or
 * `_`. Desktop ids need not be uuids (a Day One or Journey import keeps the source id). No `.`,
 * `/` or `\`, so it can never traverse or change folders.
 */
export const SAFE_ID_SOURCE = '[A-Za-z0-9_-]{8,128}'

/**
 * Own device id as accepted by the desktop keyring validator (memlore-core keyring_types
 * `validate_device_id`): 8-64 chars of hex digits and `-`, never starting or ending with `-`.
 * This charset has no `.`, `/` or `\`, so a valid id can never traverse or change folders.
 */
export function isValidOwnId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-fA-F-]{8,64}$/.test(value) &&
    !value.startsWith('-') &&
    !value.endsWith('-')
  )
}

/** Recovery generation: a non-negative safe integer (0 is a real, fenced generation). */
export function isValidGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function generationFolderName(generation: number): string {
  if (!isValidGeneration(generation)) throw new RangeError('invalid generation')
  return `g-${generation}`
}

export function isSafeId(value: string): boolean {
  return new RegExp(`^${SAFE_ID_SOURCE}$`).test(value)
}

export function deviceSlotPath(ownId: string): string {
  return `${DEVICE_SLOT_FOLDERS.join('/')}/${ownId}.json`
}

/** `generations/g-<N>/<ownId>/outbox/<entryId>.bin` */
export function outboxEntryPath(ownId: string, generation: number, entryId: string): string {
  return `${outboxFolderPath(ownId, generation)}/${entryId}.bin`
}

/** `generations/g-<N>/<ownId>/outbox/m-<mediaId>` or `...m-<mediaId>.thumb` */
export function outboxMediaPath(
  ownId: string,
  generation: number,
  mediaId: string,
  thumb = false,
): string {
  return `${outboxFolderPath(ownId, generation)}/m-${mediaId}${thumb ? '.thumb' : ''}`
}

/**
 * File-name letters of the v2/v3 outbox intents (README "File naming"): journal, tag, template,
 * entry trash state, location, attached media, media insertion mode, memory item, persona. Never
 * `m`: `m-` is the media blob.
 */
const OUTBOX_INTENT_LETTERS = 'jtpdlaiyq'

/** File-name prefix of a v2/v3 outbox intent (memlore-core `OutboxIntentPrefix`). */
export type OutboxIntentPrefix = 'j' | 't' | 'p' | 'd' | 'l' | 'a' | 'i' | 'y' | 'q'

/**
 * The target id of every intent but the two singletons: a safe id that is not exactly one of
 * their fixed ids (`d-empty-trash`, `q-user-persona`), so no stem ever names both.
 */
const TARGET_ID_SOURCE = `(?!(?:empty-trash|user-persona)(?![A-Za-z0-9_-]))${SAFE_ID_SOURCE}`

/**
 * An intent file stem: a known letter + a target id (a safe id), or exactly one of the fixed ids
 * `d-empty-trash` (empty_trash) and `q-user-persona` (update_persona). Shared by the writer
 * allowlist (`isOwnOutboxPath`) and upload check 5 (`sync/safeUpload.ts` `isOutboxIntentPath`).
 */
export const INTENT_STEM_SOURCE = `(?:[${OUTBOX_INTENT_LETTERS}]-${TARGET_ID_SOURCE}|d-empty-trash|q-user-persona)`

/**
 * The stem of a v1 entry intent (`<entryId>.bin`): a safe id that does not look like a letter
 * stem (`<letter>-…`), which the desktop importer reads as corrupt and foreign readers skip
 * (`isLetterOutboxStem`).
 */
export const ENTRY_STEM_SOURCE = `(?![a-z]-)${SAFE_ID_SOURCE}`

/** The target id of an intent other than the two singletons (`TARGET_ID_SOURCE`). */
export function isIntentTargetId(value: string): boolean {
  return new RegExp(`^${TARGET_ID_SOURCE}$`).test(value)
}

/**
 * A letter-prefixed outbox file stem (`<letter>-...`): a media blob or a v2/v3 intent, never a
 * v1 entry intent (`<entryId>.bin`: `ENTRY_STEM_SOURCE` refuses this shape). Readers of another
 * browser's outbox skip these so only v1 entry intents reach the v1-only foreign reader, whatever
 * letter a newer build adds.
 */
export function isLetterOutboxStem(stem: string): boolean {
  return /^[a-z]-/.test(stem)
}

/**
 * An entry id the web may write for: its `<id>.bin` is a valid v1 stem and its `<letter>-<id>`
 * intents are valid stems (never a fixed id, which idb and upload check 6 refuse too).
 */
export function isEntryId(value: string): boolean {
  return isIntentTargetId(value) && !isLetterOutboxStem(value)
}

/**
 * `generations/g-<N>/<ownId>/outbox/<prefix>-<id>.bin`: a v2/v3 intent. `<id>` is a safe id, or the
 * fixed id of `d-empty-trash` / `q-user-persona`. The desktop importer refuses the file unless
 * `<id>` is the body's target id.
 */
export function outboxIntentPath(
  ownId: string,
  generation: number,
  prefix: OutboxIntentPrefix,
  id: string,
): string {
  const stem = `${prefix}-${id}`
  if (!new RegExp(`^${INTENT_STEM_SOURCE}$`).test(stem)) {
    throw new RangeError('intent id must be a safe id or a fixed intent id')
  }
  return `${outboxFolderPath(ownId, generation)}/${stem}.bin`
}

export function outboxFolderPath(ownId: string, generation: number): string {
  return `${GENERATIONS_FOLDER}/${generationFolderName(generation)}/${ownId}/${OUTBOX_FOLDER}`
}

/**
 * A file the web may write in the FLAT own outbox of the local generation (any generation number,
 * 0 included): `<entryId>.bin` (entry intent, `ENTRY_STEM_SOURCE`), `<letter>-<id>.bin` /
 * `d-empty-trash.bin` / `q-user-persona.bin` (v2/v3 intents, `INTENT_STEM_SOURCE`; `<id>` a safe
 * id), and the web-minted media blobs `m-<uuid>` and `m-<uuid>.thumb`.
 * `isOutboxIntentPath` in `sync/safeUpload.ts` (upload check 5) builds the same grammar from the
 * same sources. Validates its inputs before building a pattern.
 */
export function isOwnOutboxPath(path: unknown, ownId: unknown, localGen: unknown): boolean {
  if (typeof path !== 'string' || !isValidOwnId(ownId) || !isValidGeneration(localGen)) {
    return false
  }
  return new RegExp(
    `^generations/g-${localGen}/${ownId}/outbox/(?:(?:${INTENT_STEM_SOURCE}|${ENTRY_STEM_SOURCE})\\.bin|m-${UUID_SOURCE}(?:\\.thumb)?)$`,
  ).test(path)
}

/**
 * The ONLY paths the web may write (safety contract 1): the own device slot and
 * `isOwnOutboxPath`. Anything else is false: protocol files, entries/, media/, peers, other
 * generations, traversal, unusual characters. Validates its inputs before building a pattern.
 */
export function isAllowedWritePath(path: unknown, ownId: unknown, localGen: unknown): boolean {
  if (typeof path !== 'string' || !isValidOwnId(ownId) || !isValidGeneration(localGen)) {
    return false
  }
  const slot = new RegExp(`^\\.meta/keyring/devices/${ownId}\\.json$`)
  return slot.test(path) || isOwnOutboxPath(path, ownId, localGen)
}

/** Path component safe for Drive `q=` queries and other providers: `[A-Za-z0-9._-]`, not `.`/`..`. */
export function isSafeComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    value !== '.' &&
    value !== '..'
  )
}

/** Split a Memlore-relative physical path into folder segments and the final file name. */
export function splitPath(path: string): { folders: string[]; name: string } | null {
  const parts = path.split('/')
  if (parts.length < 1 || !parts.every(isSafeComponent)) return null
  const name = parts[parts.length - 1]
  return { folders: parts.slice(0, -1), name }
}

/**
 * Device folder names that count as payload devices when listing: desktop `is_safe_device_id`
 * (4-64 of `[A-Za-z0-9_-]`) and never the reserved `generations` sibling (`.meta` already fails
 * the charset).
 */
export function isPayloadDeviceFolderName(name: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(name) && name !== GENERATIONS_FOLDER
}

/** Logical sync path `<device>/<file>` or `<device>/<subfolder>/<file>` (desktop parse_drive_path). */
export interface LogicalPath {
  device: string
  subfolder: string | null
  filename: string
}

export function parseLogicalPath(path: string): LogicalPath | null {
  const parts = path.split('/')
  if (parts.length !== 2 && parts.length !== 3) return null
  if (!parts.every((part) => isSafeComponent(part) && !part.startsWith('.'))) return null
  if (parts.length === 2) return { device: parts[0], subfolder: null, filename: parts[1] }
  return { device: parts[0], subfolder: parts[1], filename: parts[2] }
}

/** Shared (non-device) files the web may READ, mirroring desktop `parse_shared_path`. */
const SHARED_READ_EXACT: ReadonlySet<string> = new Set([
  '.meta/control.json',
  '.meta/_recovery_marker.json',
  '.meta/keyring/_meta.json',
  '.meta/keyring/_recovery.json',
  '.meta/keyring/_content.json',
])

export function isAllowedSharedReadPath(path: string): boolean {
  if (SHARED_READ_EXACT.has(path)) return true
  const prefix = `${DEVICE_SLOT_FOLDERS.join('/')}/`
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return false
  const stem = path.slice(prefix.length, -'.json'.length)
  return stem.length > 0 && isSafeComponent(stem) && !stem.includes('/')
}
