/**
 * Entry location rules of `set_entry_location` (web gap audit Phase 13), shared by the
 * `update_entry_location` handler and the vault's pending overlay.
 *
 * - `locationValue`: what the web writes. Mirrors memlore-core `check_location` for a value:
 *   coordinates both or neither and in range, text stripped of what `is_plain_location_text`
 *   refuses (line breaks and tabs become spaces, other control / disguising chars are dropped),
 *   trimmed, blank text is no text, at most `MAX_LOCATION_TEXT_CHARS`; nothing left is `null`
 *   (clears the location). So a value built here always seals.
 * - `comparableLocation`: a location as the desktop importer compares it (`comparable_location`,
 *   src-tauri/src/sync/outbox_import.rs): blank text is no text and nothing at all is `null`. Used
 *   for the `base` (the synced copy, text untouched: core checks neither a base's charset nor its
 *   length) and by the overlay. Coordinates are kept only as a valid pair, so a base always seals.
 */

import type { OutboxLocation } from '../core/core'
import { isControlCodePoint, isDisguisingCodePoint, isSurrogateCodePoint } from './plainText'

/** memlore-core `MAX_LOCATION_TEXT_CHARS` (also in WASM `outboxLimits`). */
export const MAX_LOCATION_TEXT_CHARS = 1000

/** Location fields as they come in (command arguments or entry metadata), untrusted. */
export interface LocationFields {
  latitude: unknown
  longitude: unknown
  label: unknown
  address: unknown
}

/** Tab, line feed, carriage return, NEL and the line / paragraph separators: read as a space. */
const isBreak = (cp: number): boolean =>
  cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029

/** `text` with what core refuses replaced (breaks) or dropped (the rest), then trimmed. */
export function plainLocationText(text: string): string {
  return Array.from(text, (c) => {
    const cp = c.codePointAt(0) ?? 0
    if (isBreak(cp)) return ' '
    return isControlCodePoint(cp) || isDisguisingCodePoint(cp) || isSurrogateCodePoint(cp) ? '' : c
  })
    .join('')
    .trim()
}

const isLatitude = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90
const isLongitude = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180

/** The location a web write seals (see the header). Throws on bad coordinates or long text. */
export function locationValue(input: LocationFields): OutboxLocation | null {
  const noLat = input.latitude === null || input.latitude === undefined
  const noLon = input.longitude === null || input.longitude === undefined
  if (noLat !== noLon) throw new Error('Invalid coordinates: latitude and longitude go together')
  if (!noLat && !(isLatitude(input.latitude) && isLongitude(input.longitude))) {
    throw new Error('Invalid coordinates')
  }
  const text = (v: unknown): string | null => {
    if (typeof v !== 'string') return null
    const plain = plainLocationText(v)
    if (Array.from(plain).length > MAX_LOCATION_TEXT_CHARS) {
      throw new Error('The location text is too long')
    }
    return plain === '' ? null : plain
  }
  const label = text(input.label)
  const address = text(input.address)
  const latitude = noLat ? null : (input.latitude as number)
  const longitude = noLon ? null : (input.longitude as number)
  if (latitude === null && label === null && address === null) return null
  return { latitude, longitude, label, address }
}

/** A location as the desktop importer compares it (see the header). */
export function comparableLocation(input: LocationFields): OutboxLocation | null {
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  // A lone coordinate is dropped although the desktop keeps it as stored: core refuses a half pair
  // even in a base, and a base must always seal (such a rare row may refuse `changed_on_desktop`).
  const coords = isLatitude(input.latitude) && isLongitude(input.longitude)
  const latitude = coords ? (input.latitude as number) : null
  const longitude = coords ? (input.longitude as number) : null
  const label = text(input.label)
  const address = text(input.address)
  if (latitude === null && label === null && address === null) return null
  return { latitude, longitude, label, address }
}

/** The location fields of a decrypted entry metadata object (`EntryMetadata`). */
export const metadataLocation = (m: Readonly<Record<string, unknown>>): LocationFields => ({
  latitude: m.latitude,
  longitude: m.longitude,
  label: m.location_label,
  address: m.location_address,
})

/** Field-by-field equality of two comparable locations. */
export function sameLocation(a: OutboxLocation | null, b: OutboxLocation | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.label === b.label &&
    a.address === b.address
  )
}
