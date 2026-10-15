/**
 * `search_entries` (Phase 10.3).
 *
 * 1. The command answers at once from the entries LOADED so far (`vault.search`, desktop token
 *    semantics, see textFold.ts).
 * 2. It then scans the remaining TEXT payloads (entry ciphertext only, never media) in the
 *    background, a few at a time through the puller (concurrency 4), and fires
 *    `memlore:entries-changed` after a batch that added a hit. Nothing is fetched unless the user
 *    runs a search; a NEW search (or a blank one) cancels the previous scan, and a lock stops it.
 *    The search modal re-queries only when its query changes (`useSearch`), so the streamed hits
 *    show on the next run of the same query.
 * 3. When the whole index fits the vault's entry cap (`vault.maxEntries`), the scan LOADS what it
 *    scans, so after one scan every later query (another one, each mention keystroke) answers
 *    complete at once from the loaded set. The text cap cannot be known before decrypting:
 *    `load` enforces it by evicting, and the accumulator below keeps the evicted hits. Past the
 *    entry cap the scan opens entries TRANSIENTLY (`vault.peek`, Phase 5.2): nothing it decrypts
 *    joins the vault's bounded set, and the text is dropped once matched.
 *    Either way the `SearchResult` summaries of the hits are kept in one accumulator per plan
 *    (query, mention mode, filters), together with the `updated_at` of the copy scanned, so running
 *    the same plan again answers with loaded + accumulated hits and scans only what changed. A
 *    copy older than its index winner (a payload still stale after `load`'s re-download) is never
 *    scanned: it may predate a lock on desktop, so it is neither a hit nor marked scanned. A different plan or a new session replaces the accumulator and a lock drops
 *    it. An accumulated hit is served only while its entry is still not loaded, still at the
 *    scanned `updatedAt` and not in an excluded journal; a stale or excluded one is dropped.
 *
 * ORDERING AND LIMIT: desktop ranks by FTS rank (bm25) and returns at most 50. The web has no rank:
 * results are ordered by entry date, newest first (id desc on ties), capped at `SEARCH_LIMIT` = 50.
 * In mention mode (`mentionMode`: the last token is a prefix) title matches come first, as the
 * desktop weights titles 10:1, then by entry date. A blank query with filters lists the filtered
 * entries newest first (desktop "browse mode"). `lockedView` and `activeVaultId` are ignored: only
 * entries the vault serves are searched.
 */

import type { EmotionKey, SearchFilters, SearchResult } from '../../../../src/types/entry'
import { onLock } from '../keys'
import { foldText, matchesQuery, parseQuery } from '../textFold'
import type { VaultEntry } from '../vault'
import type { Handler } from '../router'
import { openForRead, readEnv, type VaultApi } from './readSession'

/** Desktop `LIMIT 50`. */
export const SEARCH_LIMIT = 50
/**
 * Ids per background batch: 3x the puller's concurrency of 4 (the puller, not this count, caps the
 * parallel downloads), small enough that a cancel takes effect within one batch. Not imported from
 * sync/pull.ts so the router bundle does not pull the WASM core in statically.
 */
const SCAN_BATCH = 12
const CHANGED_EVENT = 'memlore:entries-changed'

let scanToken = 0
let scanSettled: Promise<void> = Promise.resolve()

/** Cancels the running background scan (a new search, a lock or a test). */
export function cancelSearchScan(): void {
  scanToken += 1
}

/** Resolves when the most recent background scan has finished or was cancelled. */
export const whenSearchScanSettled = (): Promise<void> => scanSettled

// ---------------------------------------------------------------------------------------------
// Filters (desktop `append_filter_clauses`)
// ---------------------------------------------------------------------------------------------

interface Filters {
  from: number | null
  toExclusive: number | null
  journalIds: string[]
  tagIds: string[]
  emotions: string[]
  hasMedia: 'has' | 'none' | null
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Null when no dimension is active (desktop `SearchFilters::is_empty`). */
function parseFilters(raw: unknown): Filters | null {
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as SearchFilters
  const range = f.timeRange
  const filters: Filters = {
    from: range !== undefined && typeof range.from === 'number' ? range.from : null,
    toExclusive:
      range !== undefined && typeof range.toExclusive === 'number' ? range.toExclusive : null,
    journalIds: stringList(f.journalIds),
    tagIds: stringList(f.tagIds),
    emotions: stringList(f.emotions) as EmotionKey[],
    hasMedia: f.hasMedia === 'has' || f.hasMedia === 'none' ? f.hasMedia : null,
  }
  const active =
    (filters.from !== null && filters.toExclusive !== null) ||
    filters.journalIds.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.emotions.length > 0 ||
    filters.hasMedia !== null
  return active ? filters : null
}

function passesFilters(entry: VaultEntry, f: Filters | null): boolean {
  if (f === null) return true
  const m = entry.metadata
  if (f.from !== null && f.toExclusive !== null) {
    if (m.entry_date < f.from || m.entry_date >= f.toExclusive) return false
  }
  if (f.journalIds.length > 0 && !f.journalIds.includes(m.journal_id)) return false
  if (f.tagIds.length > 0 && !m.tag_ids.some((t) => f.tagIds.includes(t))) return false
  if (f.emotions.length > 0 && (m.emotion === null || !f.emotions.includes(m.emotion))) return false
  if (f.hasMedia !== null) {
    const hasMedia = Array.isArray(m.media) && m.media.length > 0
    if (hasMedia !== (f.hasMedia === 'has')) return false
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// Matching and ordering
// ---------------------------------------------------------------------------------------------

interface Plan {
  query: string
  parsed: string[][]
  prefix: boolean
  filters: Filters | null
}

/** Same haystack as the vault index: the folded title and the folded body, separate streams. */
function matchesPlan(entry: VaultEntry, plan: Plan): boolean {
  if (!passesFilters(entry, plan.filters)) return false
  if (plan.parsed.length === 0) return plan.query === ''
  const m = entry.metadata
  const haystack = [foldText(m.title ?? ''), foldText(m.content_text ?? '')]
  return matchesQuery(haystack, plan.parsed, { prefix: plan.prefix })
}

const newestFirst = (a: SearchResult, b: SearchResult): number =>
  b.entry_date - a.entry_date || (a.id < b.id ? 1 : -1)

/** Newest entry date first; in mention mode title matches first (see the module doc). */
function ordered(rows: SearchResult[], plan: Plan): SearchResult[] {
  rows.sort(newestFirst)
  if (!plan.prefix || plan.parsed.length === 0) return rows
  const titleHit = (r: SearchResult): boolean =>
    matchesQuery(foldText(r.title ?? ''), plan.parsed, { prefix: true })
  return [...rows.filter(titleHit), ...rows.filter((r) => !titleHit(r))]
}

function loadedHits(vault: VaultApi, plan: Plan): VaultEntry[] {
  const base =
    plan.query === '' ? vault.listLoaded() : vault.search(plan.query, { prefix: plan.prefix })
  return base.filter((e) => passesFilters(e, plan.filters))
}

const toResult = (e: VaultEntry): SearchResult => ({
  id: e.metadata.entry_id,
  journal_id: e.metadata.journal_id,
  title: e.metadata.title,
  preview_text: e.metadata.preview_text,
  entry_date: e.metadata.entry_date,
})

// ---------------------------------------------------------------------------------------------
// Per-plan accumulator of the hits the scan found in entries that are not loaded
// ---------------------------------------------------------------------------------------------

interface Accumulator {
  vault: VaultApi
  key: string
  /** `updated_at` of the copy each id was scanned at: a newer winner is scanned again. */
  scanned: Map<string, number>
  /** Summaries only, never the text the match was made on. */
  hits: Map<string, SearchResult>
  offLock: () => void
}

let accumulator: Accumulator | null = null

function dropAccumulator(): void {
  accumulator?.offLock()
  accumulator = null
}

/** The current accumulator when it is for this vault and plan, else a fresh one. */
function accumulatorFor(vault: VaultApi, plan: Plan): Accumulator {
  const key = JSON.stringify([plan.query, plan.prefix, plan.filters])
  if (accumulator !== null && accumulator.vault === vault && accumulator.key === key) {
    return accumulator
  }
  dropAccumulator()
  const offLock = onLock(() => {
    cancelSearchScan()
    dropAccumulator()
  })
  accumulator = { vault, key, scanned: new Map(), hits: new Map(), offLock }
  return accumulator
}

/**
 * The accumulated hits still valid now: the entry is not loaded (a loaded copy answers through
 * `loadedHits`; an excluded one is never served), its index winner is the copy that was scanned
 * and its journal is not excluded. A stale or excluded hit is dropped, and its entry scanned again.
 */
function accumulatedHits(vault: VaultApi, acc: Accumulator): SearchResult[] {
  const winners = new Map(vault.listIndex().map((i) => [i.entryId, i.updatedAt]))
  const rows: SearchResult[] = []
  for (const [id, hit] of acc.hits) {
    if (
      winners.get(id) !== acc.scanned.get(id) ||
      (hit.journal_id !== '' && vault.isJournalExcluded(hit.journal_id))
    ) {
      acc.hits.delete(id)
      acc.scanned.delete(id)
    } else if (vault.status(id) === 'not-loaded') {
      rows.push(hit)
    }
  }
  return rows
}

// ---------------------------------------------------------------------------------------------
// Background scan
// ---------------------------------------------------------------------------------------------

/** Loads `ids` (counted against the vault's caps) and returns the visible ones. */
async function loadVisible(vault: VaultApi, ids: string[]): Promise<VaultEntry[]> {
  await vault.load(ids)
  return ids.filter((id) => vault.isLoaded(id)).map((id) => vault.getEntry(id))
}

function startScan(vault: VaultApi, plan: Plan, acc: Accumulator): void {
  const token = (scanToken += 1)
  const env = readEnv()
  // Under the entry cap the scanned entries stay loaded; past it they are only peeked (module doc).
  const open =
    vault.listIndex().length <= vault.maxEntries
      ? (ids: string[]) => loadVisible(vault, ids)
      : (ids: string[]) => vault.peek(ids)
  // Ids opened by this scan. An id not returned (missing, unopenable, excluded or stale payload)
  // is not marked scanned, so the next search retries it, but this scan does not batch it again.
  const tried = new Set<string>()
  const stopped = (): boolean => token !== scanToken || !env.isUnlocked() || acc !== accumulator
  // A lock followed by a quick unlock inside one batch must not let this scan continue.
  const offLock = onLock(cancelSearchScan)
  scanSettled = (async () => {
    while (!stopped()) {
      const batch = vault
        .listIndex()
        .filter(
          (i) =>
            !vault.isLoaded(i.entryId) &&
            !tried.has(i.entryId) &&
            acc.scanned.get(i.entryId) !== i.updatedAt,
        )
        .slice(0, SCAN_BATCH)
      if (batch.length === 0) return
      for (const i of batch) tried.add(i.entryId)
      let opened: VaultEntry[]
      try {
        opened = await open(batch.map((i) => i.entryId))
      } catch {
        return // offline, locked or revoked: the next search retries
      }
      if (stopped()) return
      const winners = new Map(batch.map((i) => [i.entryId, i.updatedAt]))
      let added = false
      for (const entry of opened) {
        const id = entry.metadata.entry_id
        const winner = winners.get(id)
        // A copy older than its index winner (`load` keeps a payload still stale after one
        // re-download; `peek` skips it) may predate a lock on desktop: never scanned, retried.
        if (winner === undefined || entry.metadata.updated_at < winner) continue
        acc.scanned.set(id, entry.metadata.updated_at)
        if (!matchesPlan(entry, plan)) continue
        acc.hits.set(id, toResult(entry))
        added = true
      }
      if (added) env.emit(CHANGED_EVENT)
    }
  })().finally(offLock)
}

// ---------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------

const searchEntries: Handler = async ({ query, filters, mentionMode }) => {
  const { vault } = await openForRead()
  cancelSearchScan()
  const text = typeof query === 'string' ? query.trim() : ''
  const parsedFilters = parseFilters(filters)
  // Desktop: a blank query without filters finds nothing; a query with no token (punctuation) too.
  const parsed = parseQuery(text)
  if ((text === '' && parsedFilters === null) || (text !== '' && parsed.length === 0)) return []
  const plan: Plan = { query: text, parsed, prefix: mentionMode === true, filters: parsedFilters }
  const acc = accumulatorFor(vault, plan)
  const loaded = loadedHits(vault, plan).map(toResult)
  const loadedIds = new Set(loaded.map((r) => r.id))
  const extra = accumulatedHits(vault, acc).filter((r) => !loadedIds.has(r.id))
  const results = ordered([...loaded, ...extra], plan).slice(0, SEARCH_LIMIT)
  startScan(vault, plan, acc)
  return results
}

export const searchHandlers: Record<string, Handler> = {
  search_entries: searchEntries,
}
