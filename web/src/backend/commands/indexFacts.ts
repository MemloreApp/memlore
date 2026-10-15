/**
 * Entry facts (Phase 4.1): the one overlay rule every month-index read view counts with (Stats,
 * the calendar reads, emotion by date, journal and tag counts, and the paged list totals).
 *
 * - Index rows of the requested months, already through the reader's FAIL-CLOSED filter: a row is
 *   kept only when its `updated_at` matches the entry-index winner, and never for an excluded
 *   journal (locked, invisible or unknown: the reader asks `vault.isJournalExcluded`). Locked and
 *   invisible entries never reach the index (desktop builder).
 * - An entry the vault holds and shows (`visible`) REPLACES its row: the loaded copy carries web
 *   edits. An entry the vault refuses (locked, invisible, deleted, journal-excluded) is dropped.
 *   A pending web trash (a `d-` draft) is one of those: the session feeds the pending trashes to
 *   `vault.setTrashedIds`, and the vault then reports the entry `deleted`.
 * - Every visible loaded entry with no row read (web creates, rows hidden as `unconfirmed` because
 *   the entry changed after the index was written, rows of degraded or unread months) is added
 *   from its loaded copy, when `pick` keeps the UTC month of its loaded `entry_date`.
 * - Without an index source (or without a readable catalog) the facts are the loaded set.
 *
 * Callers filter by date themselves: a replaced row keeps its place even when the loaded copy's
 * date left the picked months.
 */

import type { EmotionKey } from '../../../../src/types/entry'
import { VaultLockedError } from '../keys'
import type { MonthIndexResult, MonthIndexRow } from '../sync/monthIndex'
import type { VaultEntry } from '../vault'
import { emotionOrNull, numOrNull } from './entryFields'
import { gallerySource, openIndex } from './indexViews'
import { readEnv, type Taxonomy, type VaultApi } from './readSession'

/** What one visible entry contributes to the index-backed views. */
export interface EntryFact {
  entry_id: string
  entry_date: number
  /** One of the three states; any other value counts as none. */
  emotion: EmotionKey | null
  journal_id: string
  tag_ids: string[]
  is_favorite: boolean
  updated_at: number
  /** Whitespace-separated words (the row's `word_count`, or counted in the loaded copy's text). */
  word_count: number
  latitude: number | null
  longitude: number | null
  /** EXIF coordinates of the row's media the entry still carries (none without a row). */
  exif: Array<[number, number]>
  /** The index row the fact was read from; null when it comes from the loaded copy. */
  row: MonthIndexRow | null
}

const countWords = (text: string): number => text.split(/\s+/).filter((w) => w !== '').length

/**
 * UTC `YYYY-MM` of an instant (the index is keyed by UTC month), or null for a date outside years
 * 0..=9999 (NaN included), so one corrupt `entry_date` never throws in an index-backed view.
 */
export function utcMonthOf(secs: number): string | null {
  const d = new Date(secs * 1000)
  const year = d.getUTCFullYear()
  if (Number.isNaN(year) || year < 0 || year > 9999) return null
  return `${String(year).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function loadedFact(held: VaultEntry, exif: Array<[number, number]>): EntryFact {
  const m = held.metadata
  return {
    entry_id: m.entry_id,
    entry_date: m.entry_date,
    emotion: emotionOrNull(m.emotion),
    journal_id: m.journal_id,
    tag_ids: m.tag_ids,
    is_favorite: m.is_favorite,
    updated_at: m.updated_at,
    word_count: countWords(held.contentText),
    latitude: numOrNull(m.latitude),
    longitude: numOrNull(m.longitude),
    exif,
    row: null,
  }
}

/** One row under the vault rule, or null when the vault refuses the entry. */
function rowFact(vault: VaultApi, row: MonthIndexRow): EntryFact | null {
  const source = gallerySource(vault, row)
  if (source === null) return null
  const exif: Array<[number, number]> = []
  for (const media of row.media) {
    const lat = numOrNull(media.exif_latitude)
    const lng = numOrNull(media.exif_longitude)
    if (lat !== null && lng !== null && source.includes(media.id)) exif.push([lat, lng])
  }
  if (vault.status(row.entry_id) !== 'visible') {
    return {
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      emotion: emotionOrNull(row.emotion),
      journal_id: row.journal_id,
      tag_ids: row.tag_ids,
      is_favorite: row.is_favorite,
      updated_at: row.updated_at,
      word_count: Math.max(0, Math.floor(row.word_count)),
      latitude: numOrNull(row.latitude),
      longitude: numOrNull(row.longitude),
      exif,
      row,
    }
  }
  try {
    return loadedFact(vault.getEntry(row.entry_id), exif)
  } catch {
    return null
  }
}

/**
 * Facts of every visible entry in the catalog months `pick` keeps (null `pick`: every month), the
 * taxonomy, and `indexed`: the catalog lists at least one month (false: no index source or no
 * catalog, the facts are the loaded set). Also what the read could not place: `readIds` (every
 * row read, refused ones included), `unconfirmed` and `degraded` (the reader's `MonthIndexResult`).
 * A loaded entry whose date has no month (out of range) is kept only when `pick` is null. A loaded
 * entry with no row read (not indexed yet) is a fact only while loaded: the LRU cap (`vault.ts`)
 * may evict it again. Locked: `VaultLockedError`.
 */
export async function entryFacts(pick: ((month: string) => boolean) | null): Promise<{
  facts: EntryFact[]
  taxonomy: Taxonomy
  indexed: boolean
  readIds: Set<string>
  unconfirmed: string[]
  degraded: string[]
}> {
  const { vault, reader, taxonomy } = await openIndex()
  let result: MonthIndexResult = { rows: [], unconfirmed: [], degraded: [] }
  // No reader, no index source or no readable catalog: the loaded set only.
  const catalog = reader === null ? [] : await reader.listMonths()
  const months = catalog.filter((m) => pick === null || pick(m))
  if (reader !== null && months.length > 0) result = await reader.getMonths(months)
  if (!readEnv().isUnlocked()) throw new VaultLockedError()
  const { rows, unconfirmed, degraded } = result
  const facts = rows.map((row) => rowFact(vault, row)).filter((f): f is EntryFact => f !== null)
  const readIds = new Set(rows.map((row) => row.entry_id))
  for (const held of vault.listLoaded()) {
    const { entry_id: id, entry_date: date } = held.metadata
    if (readIds.has(id)) continue
    if (pick !== null) {
      const month = utcMonthOf(date)
      if (month === null || !pick(month)) continue
    }
    facts.push(loadedFact(held, []))
  }
  return { facts, taxonomy, indexed: catalog.length > 0, readIds, unconfirmed, degraded }
}
