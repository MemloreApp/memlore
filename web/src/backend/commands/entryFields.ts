/**
 * Field coercions shared by the live (`entries.ts`) and Trash (`trash.ts`) `Entry` builders, and
 * the live builder itself (here so `indexViews.ts` can use it without importing `entries.ts`).
 */

import type { EmotionKey, Entry } from '../../../../src/types/entry'
import type { VaultEntry } from '../vault'

export const EMOTIONS: readonly string[] = ['bad', 'neutral', 'good']

export const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
/** The emotion of a payload if it is one of the 3 keys, else null. */
export const emotionOrNull = (v: string | null): EmotionKey | null =>
  v !== null && EMOTIONS.includes(v) ? (v as EmotionKey) : null

/**
 * Desktop `Entry` from a visible vault entry. Fields the wire does not carry: `from_chat` is a
 * local-only flag (false); the lock / invisible / deleted flags are false for everything served.
 */
export function toEntry(entry: VaultEntry): Entry {
  const m = entry.metadata
  return {
    id: m.entry_id,
    journal_id: m.journal_id,
    title: m.title,
    preview_text: m.preview_text,
    content_text: m.content_text,
    entry_date: m.entry_date,
    created_at: m.created_at,
    updated_at: m.updated_at,
    latitude: numOrNull(m.latitude),
    longitude: numOrNull(m.longitude),
    location_label: strOrNull(m.location_label),
    location_address: strOrNull(m.location_address),
    weather_summary: strOrNull(m.weather_summary),
    weather_icon: strOrNull(m.weather_icon),
    emotion: emotionOrNull(m.emotion),
    is_favorite: m.is_favorite,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: strOrNull(m.cover_media_id),
    content_language: strOrNull(m.content_language),
    entry_date_user_edited: m.entry_date_user_edited === true,
    media_count: Array.isArray(m.media) ? m.media.length : 0,
    from_chat: false,
  }
}
