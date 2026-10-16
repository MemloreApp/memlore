/**
 * In-RAM vault (Phase 10.2): decrypted entries live ONLY in JS maps owned by this object.
 *
 * - Plaintext is never written to IndexedDB (the `files` store keeps ciphertext only), nor to
 *   localStorage/sessionStorage, nor the console. Nothing here logs.
 * - `load(ids)` fetches the winning ciphertext through the puller, opens it with the CURRENT key
 *   ring (`keys.getKeyRing()`, `VaultLockedError` when locked) and stores it. When an id is already
 *   in RAM the opened copy is merged with it through the WASM `mergeMetadataLww`, so the desktop
 *   LWW rule (newer `updated_at`, tie: greater device id) decides, never the arrival order.
 *   A copy that opens OLDER than its index winner (a cached payload that raced a desktop upload)
 *   has its cached ciphertext dropped and is downloaded again, once per `load`; if it is still
 *   older it is kept (the newest obtainable) but reported in `stale` and never counted as fresh.
 * - `clear()` is registered as a lock hook: on lock the maps are replaced by empty ones (no
 *   reference to the old ones survives) and in-flight loads discard their result.
 *
 * VISIBILITY (README "Desktop safety contract" 6, desktop `locked_entry_exclusion_predicate` and
 * `invisible_entry_exclusion_predicate`, `src-tauri/src/db/queries.rs`): desktop lists locked
 * entries but gates their content behind the second lock, and hides invisible entries/journals
 * outside an unlocked invisible vault. The web has no second lock and no invisible vault, so a
 * locked entry, an invisible entry (or an entry in a locked/invisible journal) and a deleted entry
 * are EXCLUDED from every view (lists, favorites, search, counts, tag/journal counts). They are
 * reduced to a minimal STUB (ids, timestamps and flags only): title, text, preview, tags, media
 * and the Yjs body are dropped right after `openEntry`, so their plaintext is never retained.
 * `getEntry` / `getContentBytes` throw `EntryUnavailableError` for them. Entry flags come from the
 * entry metadata; journal flags live in the journal channel, so Phase 10.3 feeds them through
 * `setExcludedJournalIds`. Ids that are only in the index (not loaded yet) are listed by
 * `listIndex()` because their flags are unknown until opened; the page logic loads before it shows.
 *
 * OVERLAY (Phase 16.2): own intents (`setOutboxIntents`, from this browser's drafts) and FOREIGN
 * intents (`setForeignIntents`, the outbox of OTHER web devices of the vault, read by the pull)
 * are shown on top of synced state with the desktop importer's field rules. Per entry exactly one
 * intent applies: the own one when present, otherwise the foreign winner. Foreign intents are
 * read-only: `getOutboxIntent(s)` (drafts, retention, push) never return them, `getWriteView`
 * ignores them, and a foreign `created_on_web` entry no synced manifest knows yet refuses writes
 * (`ForeignEntryReadOnlyError`).
 *
 * BOUNDED (Phase 5.1): the decrypted copies in `#entries` are capped by count
 * (`MAX_LOADED_ENTRIES`) and by text size (`MAX_LOADED_TEXT_CHARS`), least recently used evicted
 * first. A use is a `load` of the id, `getEntry` / `getContentBytes` / `getWriteView`, or `touch`;
 * bulk views (`status`, `listLoaded`, `count`, `search`) are not uses. Eviction runs after each
 * `load` (never evicting that load's ids) and drops only the plaintext: the ciphertext stays in
 * IndexedDB, the entry reads `not-loaded` and the next `load` reopens it. Never evicted: entries
 * with an own outbox intent, a stored entry draft (`setPinnedDraftIds`) or a pending web trash, and
 * nothing while a `holdEviction` hold is open. Stubs and Trash copies are not capped. `peek` (the
 * search scan) opens entries without keeping them, so a scan never grows or churns the set.
 *
 * PENDING ENTRY FIELDS (web gap audit Phase 13): this browser's pending `set_entry_location` and
 * `set_media_insertion_mode` drafts (`setPendingEntryFields`) are shown on top of the synced copy
 * (after the entry intent) while the synced copy still holds their base: its `updated_at` is the
 * draft's `base_updated_at`, or its location / the media's mode equals the draft's base (desktop
 * `comparable_location`; a mode a row does not carry is `inline`). A web-created entry with no
 * synced copy always shows them. Pending `attach_media` / `delete_media` drafts (Phase 14) add the
 * attached row (served from the outbox blob) unless the synced copy has it, and hide a deleted
 * one (`withPendingMedia`). `getSynced` and `getWriteView` never do.
 *
 * TRASH (read-only Trash view): `loadTrashed` decrypts desktop-Trash entries into a SEPARATE map,
 * never `#entries`/`#stubs`, so they never reach a live list, search, count or the month index.
 * `trashView` serves those copies and the pending web trashes (`setTrashedIds`). Locked, invisible
 * and journal-excluded entries are excluded there too, and the copies are dropped by `clear()`.
 */

import * as Y from 'yjs'
import { extractPlainText } from '../../../src/lib/yjs'
import type { Core, OutboxIntentV3 } from '../core/core'
import { comparableLocation, metadataLocation, sameLocation } from './location'
import { getKeyRing, onLock, type KeyRing } from './keys'
import { isLive, type IndexEntry } from './sync/entryIndex'
import type { OutboxEntryV1 } from './sync/outbox'
import { foldText, matchesQuery, parseQuery, type MatchOptions } from './textFold'

type VaultCore = Pick<Core, 'openEntry' | 'mergeMetadataLww'>

/** Same cut as the editor's autosave (`EditorPanel`). */
const PREVIEW_LENGTH = 150

/**
 * Most decrypted entries held in RAM at once (least recently used evicted first). With a month
 * index the paged lists (`commands/entries.ts`) decrypt at most this many per request and page from
 * the index rows, so every position is reachable. Without one they sort the LOADED set, holding
 * eviction while a request loads up to `MAX_LOAD_ROUNDS` x `PAGE_SIZE` (50 x 20) ids, so they reach
 * only about this many plus that many positions in last-updated order.
 */
export const MAX_LOADED_ENTRIES = 1000

/**
 * Most text held decrypted at once, as plain-text characters plus Yjs state bytes (`sizeOf`). Each
 * entry also keeps a folded copy of its text, so RAM is a small multiple of this: 16 M keeps the
 * set to tens of MB, while an average entry of 16 000 characters still fits `MAX_LOADED_ENTRIES`.
 */
export const MAX_LOADED_TEXT_CHARS = 16_000_000

export interface VaultLimits {
  /** Default `MAX_LOADED_ENTRIES`. */
  maxEntries?: number
  /** Default `MAX_LOADED_TEXT_CHARS`. */
  maxTextChars?: number
}

export interface VaultKeys {
  getKeyRing: () => KeyRing
  onLock: (cb: () => void) => () => void
}

/** The part of the puller the vault needs. */
export interface VaultSource {
  fetchEntries: (ids: readonly string[]) => Promise<Map<string, Uint8Array>>
  /** Drops the cached ciphertext of these ids so the next `fetchEntries` downloads them again. */
  dropCached: (ids: readonly string[]) => Promise<void>
  readonly index: ReadonlyMap<string, IndexEntry> | null
}

export interface VaultDeps {
  core: VaultCore
  /** Defaults to the key holder (`getKeyRing`, `onLock`). */
  keys?: VaultKeys
  /** Without a puller `load` throws; the loaded set can still be queried. */
  puller?: VaultSource
  /** Unix milliseconds for `loadedAt`. Default `Date.now`. */
  now?: () => number
  /**
   * Read-side format check of each opened entry's decrypted metadata JSON. An unknown field must
   * LATCH the format guard (writes refused) and NOT throw: the entry is still shown. Injected by
   * the read session so this module stays out of the WASM-free router bundle. Default: none.
   */
  guardMetadata?: (id: string, metadataJson: string) => void
  /** Caps on the decrypted set; defaults to the module constants (tests pass tiny ones). */
  limits?: VaultLimits
}

/** Decrypted `EntryMetadata` (memlore-core `metadata.rs`); times are Unix SECONDS. */
export interface EntryMetadata {
  entry_id: string
  device_id: string
  updated_at: number
  entry_date: number
  created_at: number
  journal_id: string
  journal_name: string | null
  title: string | null
  preview_text: string | null
  content_text: string | null
  emotion: string | null
  is_favorite: boolean
  is_deleted: boolean
  is_locked: boolean
  is_invisible: boolean
  vault_id: string | null
  tag_ids: string[]
  /** Set when the entry is in the desktop Trash (v0.2.3+): hidden like a deleted entry. */
  trashed_at?: number
  /** Everything else (location, weather, media, ...), passed through untouched. */
  [key: string]: unknown
}

export interface VaultEntry {
  metadata: EntryMetadata
  /** Yjs full-state bytes (empty when the entry has no body yet). */
  content: Uint8Array
  contentText: string
  previewText: string
  /** Unix milliseconds when this copy was opened. */
  loadedAt: number
}

export type ExcludedReason = 'locked' | 'invisible' | 'deleted' | 'journal'
export type EntryStatus = 'visible' | ExcludedReason | 'not-loaded'

/** `Vault.getSynced`: synced state only, no overlay. */
export interface SyncedView {
  status: EntryStatus
  /** Full metadata when visible, the stub (ids, timestamps, flags) when excluded. */
  metadata: EntryMetadata | null
  /** Yjs full state when visible. */
  content: Uint8Array | null
}

/** Thrown by `getEntry` / `getContentBytes` for locked, invisible, deleted or not-loaded ids. */
export class EntryUnavailableError extends Error {
  readonly reason: Exclude<EntryStatus, 'visible'>
  constructor(id: string, reason: Exclude<EntryStatus, 'visible'>) {
    super(`entry ${id} is unavailable (${reason})`)
    this.name = 'EntryUnavailableError'
    this.reason = reason
  }
}

/** Writes refuse an entry known only from ANOTHER web device's outbox (plan 16.1). */
export class ForeignEntryReadOnlyError extends Error {
  constructor() {
    super(
      'This entry was created in another browser. It is read-only here until your desktop has synced it.',
    )
    this.name = 'ForeignEntryReadOnlyError'
  }
}

/**
 * The foreign intent shown for one entry when several web devices have one: the greater
 * `web_updated_at_secs` (the newest edit), then the greater `web_device_id` (desktop LWW's tie
 * rule). Deterministic whatever the listing order.
 */
function foreignWins(a: OutboxEntryV1, b: OutboxEntryV1): boolean {
  if (a.web_updated_at_secs !== b.web_updated_at_secs)
    return a.web_updated_at_secs > b.web_updated_at_secs
  return a.web_device_id > b.web_device_id
}

export interface LoadResult {
  /** Ids now visible in the vault (opened or already fresh). */
  loaded: string[]
  /** Ids that are locked, invisible, deleted or in an excluded journal (stubs only). */
  excluded: string[]
  /** Ids unknown to the index or whose file is confirmed missing. */
  missing: string[]
  /** Ids whose payload could not be opened (corrupt, wrong key, mismatched id). */
  failed: Array<{ id: string; message: string }>
  /**
   * Ids whose best obtainable copy is still older than the index winner, even after dropping the
   * cached payload and downloading it again (the desktop's upload lags its manifest row, or the
   * payload was rolled back). They stay not fresh, so the next `load` retries.
   */
  stale: string[]
}

export interface EntryFilter {
  journalId?: string
  tagId?: string
  favorite?: boolean
  emotion?: string
}

/** Everything kept for an excluded entry: no title, text, preview, tags, media or body. */
interface Stub {
  reason: ExcludedReason
  metadata: EntryMetadata
}

interface Held extends VaultEntry {
  /** Folded title and folded body, SEPARATE streams (FTS columns); same lifetime as the entry. */
  folded: string[]
}

/** A decrypted desktop-Trash entry (`loadTrashed`), kept apart from the live maps. */
interface TrashedCopy {
  held: Held
  /** Unix seconds the desktop moved it to the Trash. */
  trashedAt: number
  /** The index winner's `updatedAt` this copy was fetched for. */
  winnerUpdatedAt: number
}

/** `Vault.trashView`: a desktop-Trash copy, or a pending web trash (`trashedAt` null). */
export interface TrashView {
  held: VaultEntry
  trashedAt: number | null
  /** True while the trash is a web draft the desktop has not applied yet. */
  pending: boolean
}

/** An index winner in the desktop Trash: trashed, not yet purged to a tombstone. */
const isTrashedWinner = (e: IndexEntry): boolean => typeof e.trashedAt === 'number' && !e.isDeleted

const EMPTY = new Uint8Array(0)
const decoder = new TextDecoder()

/**
 * Whether the `synced` Yjs doc already holds every insertion of `state` (an intent's
 * `yjs_full_state`): each client clock of `state`'s state vector is at most `synced`'s.
 * FAIL-CLOSED: no synced copy (an entry created on web, not imported yet), or bytes that do not
 * decode, count as not contained. An empty `state` against a synced copy carries no content (the
 * overlay and the desktop importer ignore it), so it is contained.
 * Deletions are not in a state vector: a delete-only intent reads as contained, which loses no
 * text a restore could need (the deleted text is in the synced copy).
 */
export function isYjsStateContained(state: number[], synced: Uint8Array | null): boolean {
  if (synced === null) return false
  if (state.length === 0) return true
  try {
    const wanted = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(new Uint8Array(state)))
    const held =
      synced.length === 0
        ? new Map<number, number>()
        : Y.decodeStateVector(Y.encodeStateVectorFromUpdate(synced))
    for (const [client, clock] of wanted) {
      if ((held.get(client) ?? 0) < clock) return false
    }
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Validates the required fields and normalizes the optional ones (typeof, never truthiness). */
function parseMetadata(json: string, expectedId: string): EntryMetadata {
  const raw: unknown = JSON.parse(json)
  if (
    !isRecord(raw) ||
    typeof raw.entry_id !== 'string' ||
    typeof raw.device_id !== 'string' ||
    typeof raw.updated_at !== 'number' ||
    typeof raw.entry_date !== 'number' ||
    typeof raw.created_at !== 'number' ||
    typeof raw.journal_id !== 'string' ||
    typeof raw.is_deleted !== 'boolean'
  ) {
    throw new Error('entry metadata is malformed')
  }
  if (raw.entry_id !== expectedId) throw new Error('entry id does not match its file')
  // `...raw` would pass a non-numeric `trashed_at` through: drop it, never trust it.
  const { trashed_at: trashedAt, ...rest } = raw
  return {
    ...rest,
    ...(typeof trashedAt === 'number' ? { trashed_at: trashedAt } : {}),
    entry_id: raw.entry_id,
    device_id: raw.device_id,
    updated_at: raw.updated_at,
    entry_date: raw.entry_date,
    created_at: raw.created_at,
    journal_id: raw.journal_id,
    journal_name: str(raw.journal_name),
    title: str(raw.title),
    preview_text: str(raw.preview_text),
    content_text: str(raw.content_text),
    emotion: str(raw.emotion),
    is_favorite: raw.is_favorite === true,
    is_deleted: raw.is_deleted,
    is_locked: raw.is_locked === true,
    is_invisible: raw.is_invisible === true,
    vault_id: str(raw.vault_id),
    tag_ids: Array.isArray(raw.tag_ids)
      ? raw.tag_ids.filter((t): t is string => typeof t === 'string')
      : [],
  }
}

/** Minimal metadata that still deserializes as `EntryMetadata` (so it can be LWW-merged). */
type StubSource = Pick<
  EntryMetadata,
  | 'entry_id'
  | 'device_id'
  | 'updated_at'
  | 'journal_id'
  | 'is_deleted'
  | 'is_locked'
  | 'is_invisible'
  | 'vault_id'
> &
  Pick<Partial<EntryMetadata>, 'trashed_at'>

function makeStub(source: StubSource, reason: ExcludedReason): Stub {
  const keepJournal = reason === 'deleted' || reason === 'journal'
  return {
    reason,
    metadata: {
      entry_id: source.entry_id,
      device_id: source.device_id,
      updated_at: source.updated_at,
      entry_date: 0,
      created_at: 0,
      journal_id: keepJournal ? source.journal_id : '',
      journal_name: null,
      title: null,
      preview_text: null,
      content_text: null,
      emotion: null,
      is_favorite: false,
      is_deleted: source.is_deleted,
      is_locked: source.is_locked,
      is_invisible: source.is_invisible,
      vault_id: source.vault_id,
      tag_ids: [],
      // A desktop-Trash entry stays one in `getSynced`: retention keeps its drafts (restorable).
      ...(typeof source.trashed_at === 'number' ? { trashed_at: source.trashed_at } : {}),
    },
  }
}

/** A pending `l-<entryId>` draft's intent (`Vault.setPendingEntryFields`). */
export type PendingLocation = Extract<OutboxIntentV3, { kind: 'set_entry_location' }>
/** A pending `i-<mediaId>` draft's intent (`Vault.setPendingEntryFields`). */
export type PendingInsertionMode = Extract<OutboxIntentV3, { kind: 'set_media_insertion_mode' }>
/** A pending `a-<mediaId>` draft's intent: an attach or a delete (`Vault.setPendingEntryFields`). */
export type PendingMedia = Extract<OutboxIntentV3, { kind: 'attach_media' | 'delete_media' }>

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A media row's insertion mode; a row without one (or with an unknown one) is `inline`. */
const rowMode = (row: Record<string, unknown>): string =>
  row.insertion_mode === 'attached' ? 'attached' : 'inline'

/**
 * `rows` (an entry's media) with this browser's pending `a-` drafts: an attach adds its attached
 * row (`is_outbox`: served from `outbox/m-<id>`) unless the synced copy already has it; a delete
 * hides the row.
 */
export function withPendingMedia(rows: unknown, pending: readonly PendingMedia[]): unknown[] {
  const list: unknown[] = Array.isArray(rows) ? [...rows] : []
  const has = (id: string): boolean => list.some((r) => isObject(r) && r.id === id)
  for (const p of pending) {
    if (p.kind !== 'attach_media' || has(p.media_id)) continue
    list.push({
      id: p.media_id,
      file_name: p.file_name,
      file_type: p.file_type,
      file_size: p.size,
      has_thumb: false,
      insertion_mode: 'attached',
      duration_seconds: p.duration_ms === null ? null : p.duration_ms / 1000,
      created_at: p.web_updated_at_secs,
      is_outbox: true,
      outbox_device: p.web_device_id,
    })
  }
  const deleted = new Set(pending.filter((p) => p.kind === 'delete_media').map((p) => p.media_id))
  return deleted.size === 0 ? list : list.filter((r) => !(isObject(r) && deleted.has(String(r.id))))
}

/** What one decrypted copy weighs against `MAX_LOADED_TEXT_CHARS`. */
const sizeOf = (held: Held): number => held.contentText.length + held.content.byteLength

const byEntryDateDesc = (a: Held, b: Held): number =>
  b.metadata.entry_date - a.metadata.entry_date ||
  b.metadata.created_at - a.metadata.created_at ||
  (a.metadata.entry_id < b.metadata.entry_id ? -1 : 1)

export class Vault {
  readonly #core: VaultCore
  readonly #guardMetadata: (id: string, metadataJson: string) => void
  readonly #keys: VaultKeys
  readonly #puller: VaultSource | undefined
  readonly #now: () => number
  readonly #unregister: () => void
  readonly #maxEntries: number
  readonly #maxTextChars: number
  /** Visible synced copies; Map order is recency (least recently used first, see `#touch`). */
  #entries = new Map<string, Held>()
  #stubs = new Map<string, Stub>()
  #excludedJournals = new Set<string>()
  /**
   * Journal ids with a known record, or null before the first `setExcludedJournalIds` with a known
   * set (and after `clear()`): while null every entry is excluded, so `#entries` stays empty.
   */
  #knownJournals: Set<string> | null = null
  /** Pending outbox intents overlaid on top of synced state. */
  #outboxIntents = new Map<string, OutboxEntryV1>()
  /** Other web devices' intents (read-only), one winner per entry (`foreignWins`). */
  #foreignIntents = new Map<string, OutboxEntryV1>()
  /** Entries this browser moved to the desktop Trash (pending `d-<id>` drafts, Phase 22.2). */
  #trashed = new Set<string>()
  /** Pending `l-` intents by entry id (`setPendingEntryFields`). */
  #pendingLocations = new Map<string, PendingLocation>()
  /** Pending `i-` intents by entry id, then media id (`setPendingEntryFields`). */
  #pendingModes = new Map<string, Map<string, PendingInsertionMode>>()
  /** Pending `a-` intents by entry id (`setPendingEntryFields`). */
  #pendingMedia = new Map<string, PendingMedia[]>()
  /** Entries with an entry draft in IndexedDB (`setPinnedDraftIds`), opened or not. */
  #draftIds = new Set<string>()
  /** Desktop-Trash copies opened by `loadTrashed`; never read by the live views. */
  #trashedCopies = new Map<string, TrashedCopy>()
  /** Bumped by `clear()`; a load that started under an older epoch discards its result. */
  #epoch = 0
  /** Open `holdEviction` holds: while above zero nothing is evicted. */
  #holds = 0

  constructor(deps: VaultDeps) {
    this.#core = deps.core
    this.#keys = deps.keys ?? { getKeyRing, onLock }
    this.#puller = deps.puller
    this.#now = deps.now ?? Date.now
    this.#guardMetadata = deps.guardMetadata ?? (() => undefined)
    this.#maxEntries = deps.limits?.maxEntries ?? MAX_LOADED_ENTRIES
    this.#maxTextChars = deps.limits?.maxTextChars ?? MAX_LOADED_TEXT_CHARS
    this.#unregister = this.#keys.onLock(() => this.clear())
  }

  /** Sets the active outbox intents to overlay on top of synced state. */
  setOutboxIntents(intents: OutboxEntryV1[]): void {
    this.#outboxIntents = new Map(intents.map((i) => [i.entry_id, i]))
  }

  /**
   * Sets the entries with a pending web trash (`d-<id>` drafts). They are served as deleted in
   * every view (`getSynced` excepted: retention compares against the synced copy) until the set is
   * replaced, i.e. until the desktop reflects the trash or finally refuses it.
   */
  setTrashedIds(ids: Iterable<string>): void {
    this.#trashed = new Set(ids)
  }

  /**
   * Sets this browser's pending location, insertion-mode and attach / delete media intents (the
   * stored `l-` / `i-` / `a-` drafts). Shown as the header's PENDING ENTRY FIELDS until the set is
   * replaced.
   */
  setPendingEntryFields(
    locations: readonly PendingLocation[],
    modes: readonly PendingInsertionMode[],
    media: readonly PendingMedia[] = [],
  ): void {
    this.#pendingLocations = new Map(locations.map((l) => [l.entry_id, l]))
    const byEntry = new Map<string, Map<string, PendingInsertionMode>>()
    for (const m of modes) {
      const media = byEntry.get(m.entry_id) ?? new Map<string, PendingInsertionMode>()
      media.set(m.media_id, m)
      byEntry.set(m.entry_id, media)
    }
    this.#pendingModes = byEntry
    const mediaByEntry = new Map<string, PendingMedia[]>()
    for (const m of media)
      mediaByEntry.set(m.entry_id, [...(mediaByEntry.get(m.entry_id) ?? []), m])
    this.#pendingMedia = mediaByEntry
  }

  /**
   * Sets the entries with an entry draft stored in IndexedDB, including a draft that did not open
   * (it has no intent in the overlay). Their decrypted copy is never evicted.
   */
  setPinnedDraftIds(ids: Iterable<string>): void {
    this.#draftIds = new Set(ids)
  }

  /**
   * Sets the intents read from OTHER web devices' outboxes. Read-only: they are overlaid but never
   * returned by `getOutboxIntent(s)`, so they never reach drafts, retention or push.
   */
  setForeignIntents(intents: OutboxEntryV1[]): void {
    const winners = new Map<string, OutboxEntryV1>()
    for (const intent of intents) {
      const current = winners.get(intent.entry_id)
      if (current === undefined || foreignWins(intent, current))
        winners.set(intent.entry_id, intent)
    }
    this.#foreignIntents = winners
  }

  /** The intent overlaid on an entry: this browser's own draft wins over any foreign one. */
  #intentFor(id: string): OutboxEntryV1 | undefined {
    return this.#outboxIntents.get(id) ?? this.#foreignIntents.get(id)
  }

  /**
   * A `created_on_web` intent shown on its own (no synced copy, no stub). A foreign one only while
   * no synced manifest knows the id: once one does, the entry is loaded like any other. An own one
   * not while the index winner is trashed or deleted (`anyWinner` false): retention keeps a pushed
   * draft of a desktop-Trash entry for a restore, and it must not list as live before the load
   * that stubs it.
   */
  #webCreated(id: string, anyWinner = false): OutboxEntryV1 | undefined {
    const own = this.#outboxIntents.get(id)
    const winner = this.#puller?.index?.get(id)
    if (own !== undefined) {
      const hidden = !anyWinner && winner !== undefined && !isLive(winner)
      return own.created_on_web && !hidden ? own : undefined
    }
    const foreign = this.#foreignIntents.get(id)
    if (foreign?.created_on_web !== true || this.#puller?.index?.has(id) === true) return undefined
    return foreign
  }

  getOutboxIntents(): OutboxEntryV1[] {
    return Array.from(this.#outboxIntents.values())
  }

  getOutboxIntent(entryId: string): OutboxEntryV1 | undefined {
    return this.#outboxIntents.get(entryId)
  }

  /**
   * Whether another web device holds an intent for the entry whose Yjs content the synced copy
   * does not cover yet (see `isYjsStateContained`): once the desktop imported it, the edit is in
   * the synced doc, whatever the authoring browser's retention still keeps on Drive.
   */
  hasUnimportedForeignIntent(entryId: string): boolean {
    const intent = this.#foreignIntents.get(entryId)
    if (intent === undefined) return false
    return !isYjsStateContained(intent.yjs_full_state, this.getSynced(entryId).content)
  }

  /**
   * The SYNCED state of an entry, never the outbox overlay (intent retention compares against it):
   * a loaded entry's metadata and Yjs bytes, an excluded entry's stub (flags kept), or
   * `not-loaded` with nulls.
   */
  getSynced(id: string): SyncedView {
    const held = this.#entries.get(id)
    if (held !== undefined) {
      return { status: 'visible', metadata: { ...held.metadata }, content: held.content }
    }
    const stub = this.#stubs.get(id)
    if (stub !== undefined)
      return { status: stub.reason, metadata: { ...stub.metadata }, content: null }
    return { status: 'not-loaded', metadata: null, content: null }
  }

  /** Visible (non-excluded) entries in RAM (including web-created ones). */
  get size(): number {
    return this.#getAllVisibleHeld().length
  }

  /** Empties every map and forgets the excluded-journal set. Idempotent; also the lock hook. */
  clear(): void {
    this.#epoch += 1
    this.#entries = new Map()
    this.#stubs = new Map()
    this.#excludedJournals = new Set()
    this.#knownJournals = null
    this.#outboxIntents = new Map()
    this.#foreignIntents = new Map()
    this.#trashed = new Set()
    this.#pendingLocations = new Map()
    this.#pendingModes = new Map()
    this.#pendingMedia = new Map()
    this.#draftIds = new Set()
    this.#trashedCopies = new Map()
    this.#holds = 0
  }

  /** Unregisters the lock hook and clears. */
  dispose(): void {
    this.#unregister()
    this.clear()
  }

  isLoaded(id: string): boolean {
    return this.status(id) === 'visible'
  }

  /**
   * Visibility with the overlay applied. A stub (locked, invisible, deleted, journal) always wins
   * over an outbox intent, and the overlaid journal is subject to journal exclusion.
   */
  status(id: string): EntryStatus {
    if (this.#trashed.has(id)) return 'deleted'
    const held = this.#entries.get(id)
    if (held !== undefined) {
      const journalId = this.#overlaidJournalId(held.metadata, this.#intentFor(id))
      return this.#journalExcluded(journalId) ? 'journal' : 'visible'
    }
    const stub = this.#stubs.get(id)
    if (stub !== undefined) return stub.reason
    const created = this.#webCreated(id)
    if (created !== undefined) {
      const journalId = created.fields.journal_id?.value ?? ''
      return this.#journalExcluded(journalId) ? 'journal' : 'visible'
    }
    return 'not-loaded'
  }

  /** Throws `EntryUnavailableError` for locked, invisible, deleted and not-loaded entries. */
  getEntry(id: string): VaultEntry {
    return this.#held(id)
  }

  /** Yjs bytes of a visible entry. Same errors as `getEntry`. */
  getContentBytes(id: string): Uint8Array {
    return this.#held(id).content
  }

  /**
   * The view a write builds on: synced state with only THIS browser's draft overlaid, never a
   * foreign intent (the write's `base` must be the synced value). Same errors as `getEntry`, plus
   * `ForeignEntryReadOnlyError` for an entry known only from another web device's outbox.
   */
  getWriteView(id: string): VaultEntry {
    const status = this.status(id)
    if (status !== 'visible') throw new EntryUnavailableError(id, status)
    const held = this.#touch(id)
    const own = this.#outboxIntents.get(id)
    if (held !== undefined) return own === undefined ? held : this.#computeOverlaidHeld(held, own)
    if (own !== undefined) return this.#syntheticHeldFromIntent(own)
    throw new ForeignEntryReadOnlyError()
  }

  #held(id: string): Held {
    const status = this.status(id)
    if (status !== 'visible') throw new EntryUnavailableError(id, status)
    const held = this.#touch(id)
    if (held !== undefined) return this.#applyOverlay(held)
    const intent = this.#webCreated(id)
    if (intent !== undefined) return this.#withPendingFields(this.#syntheticHeldFromIntent(intent))
    throw new EntryUnavailableError(id, 'not-loaded')
  }

  /** The journal id after the intent's journal move, if that move applies to this base. */
  #overlaidJournalId(base: EntryMetadata, intent: OutboxEntryV1 | undefined): string {
    const f = intent?.fields.journal_id
    if (f && (base.updated_at === f.base_updated_at || base.journal_id === f.base)) return f.value
    return base.journal_id
  }

  #applyOverlay(base: Held): Held {
    const intent = this.#intentFor(base.metadata.entry_id)
    const view = intent ? this.#computeOverlaidHeld(base, intent) : base
    return this.#withPendingFields(view, base.metadata)
  }

  /**
   * `view` with the pending location and insertion modes of its entry (see the header). `synced`:
   * the synced metadata the drafts' bases are checked against; absent for a web-created entry.
   */
  #withPendingFields(view: Held, synced?: EntryMetadata): Held {
    const id = view.metadata.entry_id
    const location = this.#pendingLocations.get(id)
    const modes = this.#pendingModes.get(id)
    const media = this.#pendingMedia.get(id)
    if (location === undefined && modes === undefined && media === undefined) return view
    const holdsBase = (baseUpdatedAt: number, sameBase: () => boolean): boolean =>
      synced === undefined || synced.updated_at === baseUpdatedAt || sameBase()
    const m: EntryMetadata = { ...view.metadata }
    if (
      location !== undefined &&
      holdsBase(location.base_updated_at, () =>
        sameLocation(comparableLocation(metadataLocation(synced ?? {})), location.base),
      )
    ) {
      m.latitude = location.value?.latitude ?? null
      m.longitude = location.value?.longitude ?? null
      m.location_label = location.value?.label ?? null
      m.location_address = location.value?.address ?? null
    }
    if (modes !== undefined && Array.isArray(m.media)) {
      const syncedRows: unknown[] = Array.isArray(synced?.media) ? synced.media : []
      const syncedMode = (mediaId: string): string => {
        const row = syncedRows.find((r) => isObject(r) && r.id === mediaId)
        return isObject(row) ? rowMode(row) : 'inline'
      }
      m.media = (m.media as unknown[]).map((row) => {
        if (!isObject(row) || typeof row.id !== 'string') return row
        const pending = modes.get(row.id)
        if (pending === undefined) return row
        const applies = holdsBase(
          pending.base_updated_at,
          () => syncedMode(pending.media_id) === pending.base_mode,
        )
        return applies ? { ...row, insertion_mode: pending.mode } : row
      })
    }
    if (media !== undefined) m.media = withPendingMedia(m.media, media)
    return { ...view, metadata: m }
  }

  #computeOverlaidHeld(base: Held, intent: OutboxEntryV1): Held {
    const m: EntryMetadata = { ...base.metadata }
    const { fields } = intent

    let content = base.content
    let mergedText: string | null = null
    if (intent.yjs_full_state && intent.yjs_full_state.length > 0) {
      try {
        const doc = new Y.Doc()
        if (base.content.length > 0) {
          Y.applyUpdate(doc, base.content)
        }
        Y.applyUpdate(doc, new Uint8Array(intent.yjs_full_state))
        content = Y.encodeStateAsUpdate(doc)
        // The draft's own text misses whatever the desktop copy added since
        // the draft was written; read the text from the merged doc instead.
        if (base.content.length > 0) mergedText = extractPlainText(doc)
      } catch {
        // Corrupt intent yjs state: keep base content
      }
    }

    const contentText = mergedText ?? intent.content_text ?? base.contentText
    const previewText =
      mergedText !== null
        ? mergedText.slice(0, PREVIEW_LENGTH)
        : (intent.preview_text ?? base.previewText)
    if (mergedText !== null) {
      m.content_text = contentText
      m.preview_text = previewText
    } else {
      if (intent.content_text !== null && intent.content_text !== undefined) {
        m.content_text = intent.content_text
      }
      if (intent.preview_text !== null && intent.preview_text !== undefined) {
        m.preview_text = intent.preview_text
      }
    }

    if (fields.title) {
      const f = fields.title
      if (
        base.metadata.updated_at === f.base_updated_at ||
        (base.metadata.title ?? '') === (f.base ?? '')
      ) {
        m.title = f.value
      }
    }

    if (fields.entry_date) {
      const f = fields.entry_date
      const valTs = Number(f.value)
      const baseTs = Number(f.base)
      if (base.metadata.updated_at === f.base_updated_at || base.metadata.entry_date === baseTs) {
        m.entry_date = valTs
        // Mirrors the desktop importer (`outbox_import.rs`): applying an entry_date
        // change marks `entry_date_user_edited` — the intent carries no flag of its own.
        m.entry_date_user_edited = true
      }
    }

    if (fields.emotion) {
      const f = fields.emotion
      if (
        base.metadata.updated_at === f.base_updated_at ||
        (base.metadata.emotion ?? null) === (f.base ?? null)
      ) {
        m.emotion = f.value
      }
    }

    if (fields.is_favorite) {
      const f = fields.is_favorite
      if (
        base.metadata.updated_at === f.base_updated_at ||
        Boolean(base.metadata.is_favorite) === Boolean(f.base)
      ) {
        m.is_favorite = f.value
      }
    }

    m.journal_id = this.#overlaidJournalId(base.metadata, intent)

    if (fields.tags_add || fields.tags_remove) {
      const currentTags = new Set(base.metadata.tag_ids)
      for (const [tagId, f] of Object.entries(fields.tags_add || {})) {
        if (base.metadata.updated_at === f.base_updated_at || !currentTags.has(tagId)) {
          currentTags.add(tagId)
        }
      }
      for (const [tagId, f] of Object.entries(fields.tags_remove || {})) {
        if (base.metadata.updated_at === f.base_updated_at || currentTags.has(tagId)) {
          currentTags.delete(tagId)
        }
      }
      m.tag_ids = Array.from(currentTags)
    }

    if (intent.media && intent.media.length > 0) {
      const baseMedia = Array.isArray(base.metadata.media)
        ? [...(base.metadata.media as Array<Record<string, unknown>>)]
        : []
      const existingIds = new Set(baseMedia.map((x) => x.id ?? x.media_id))
      for (const mRef of intent.media) {
        if (!existingIds.has(mRef.media_id)) {
          baseMedia.push({
            id: mRef.media_id,
            file_name: mRef.file_name,
            file_type: mRef.file_type,
            file_size: mRef.size,
            has_thumb: mRef.has_thumb,
            created_at: intent.web_updated_at_secs,
            is_outbox: true,
            outbox_device: intent.web_device_id,
          })
        }
      }
      m.media = baseMedia
    }

    return {
      metadata: m,
      content,
      contentText,
      previewText,
      loadedAt: base.loadedAt,
      folded: [foldText(m.title ?? ''), foldText(contentText)],
    }
  }

  #syntheticHeldFromIntent(intent: OutboxEntryV1): Held {
    const doc = new Y.Doc()
    if (intent.yjs_full_state && intent.yjs_full_state.length > 0) {
      try {
        Y.applyUpdate(doc, new Uint8Array(intent.yjs_full_state))
      } catch {
        // Corrupt intent yjs state: keep empty doc
      }
    }
    const content = Y.encodeStateAsUpdate(doc)
    const contentText = intent.content_text ?? ''
    const previewText = intent.preview_text ?? ''
    const tagIds = Object.keys(intent.fields.tags_add || {})
    const mediaList = (intent.media || []).map((mRef) => ({
      id: mRef.media_id,
      file_name: mRef.file_name,
      file_type: mRef.file_type,
      file_size: mRef.size,
      has_thumb: mRef.has_thumb,
      created_at: intent.web_updated_at_secs,
      is_outbox: true,
      outbox_device: intent.web_device_id,
    }))
    const entryDate = intent.fields.entry_date
      ? Number(intent.fields.entry_date.value)
      : intent.web_updated_at_secs

    const metadata: EntryMetadata = {
      entry_id: intent.entry_id,
      device_id: intent.web_device_id,
      updated_at: intent.web_updated_at_secs,
      entry_date: entryDate,
      created_at: intent.web_updated_at_secs,
      journal_id: intent.fields.journal_id?.value ?? '',
      journal_name: null,
      title: intent.fields.title?.value ?? null,
      preview_text: previewText,
      content_text: contentText,
      emotion: intent.fields.emotion?.value ?? null,
      is_favorite: intent.fields.is_favorite?.value ?? false,
      is_deleted: false,
      is_locked: false,
      is_invisible: false,
      vault_id: null,
      tag_ids: tagIds,
      media: mediaList,
      // Created-on-web intents always carry entry_date; the importer marks the
      // flag for any created entry that has one (`outbox_import.rs`).
      entry_date_user_edited:
        intent.fields.entry_date !== null && intent.fields.entry_date !== undefined,
    }

    return {
      metadata,
      content,
      contentText,
      previewText,
      loadedAt: this.#now(),
      folded: [foldText(metadata.title ?? ''), foldText(contentText)],
    }
  }

  #getAllVisibleHeld(): Held[] {
    const list: Held[] = []
    const seenIds = new Set<string>()

    for (const [id, held] of this.#entries) {
      seenIds.add(id)
      if (this.#trashed.has(id)) continue
      const view = this.#applyOverlay(held)
      if (!this.#journalExcluded(view.metadata.journal_id)) list.push(view)
    }

    for (const id of new Set([...this.#outboxIntents.keys(), ...this.#foreignIntents.keys()])) {
      const hidden = seenIds.has(id) || this.#stubs.has(id) || this.#trashed.has(id)
      const intent = hidden ? undefined : this.#webCreated(id)
      if (intent !== undefined) {
        const journalId = intent.fields.journal_id?.value ?? ''
        if (!this.#journalExcluded(journalId)) {
          list.push(this.#withPendingFields(this.#syntheticHeldFromIntent(intent)))
        }
      }
    }

    return list
  }

  /**
   * Excludes every entry of these journals (locked or invisible journals, from the journal
   * channel). Loaded entries of them are reduced to stubs immediately. When `known` is given, an
   * entry whose (non-empty) journal id is not in it is excluded too: its journal record is missing
   * or deleted, so its lock state is unknown (fail closed). Until a known set has been given, every
   * entry is excluded (the journals are not known yet). Journal stubs of a journal that is no
   * longer excluded are dropped, so those entries are listed and loaded again. Desktop-Trash copies
   * (`loadTrashed`) of an excluded journal are dropped.
   */
  setExcludedJournalIds(ids: Iterable<string>, known?: Iterable<string>): void {
    this.#excludedJournals = new Set(ids)
    if (known !== undefined) this.#knownJournals = new Set(known)
    for (const [id, held] of [...this.#entries]) {
      if (this.#journalExcluded(held.metadata.journal_id)) {
        this.#entries.delete(id)
        this.#stubs.set(id, makeStub(held.metadata, 'journal'))
      }
    }
    for (const [id, stub] of [...this.#stubs]) {
      if (stub.reason === 'journal' && !this.#journalExcluded(stub.metadata.journal_id)) {
        this.#stubs.delete(id)
      }
    }
    for (const [id, copy] of [...this.#trashedCopies]) {
      if (this.#journalExcluded(copy.held.metadata.journal_id)) this.#trashedCopies.delete(id)
    }
  }

  /**
   * True when entries of this journal are hidden: the journal is locked or invisible, or (once the
   * known set is given) its record is unknown. Stricter than the vault views, for callers that
   * filter rows the vault never loaded (the month index): it fails closed before the first
   * `setExcludedJournalIds` with a known set, and for an empty journal id.
   */
  isJournalExcluded(journalId: string): boolean {
    if (this.#knownJournals === null || journalId === '') return true
    return this.#journalExcluded(journalId)
  }

  #journalExcluded(journalId: string): boolean {
    // Fail closed: before the journals are known any entry may sit in a locked/invisible journal.
    if (this.#knownJournals === null) return true
    if (this.#excludedJournals.has(journalId)) return true
    return journalId !== '' && !this.#knownJournals.has(journalId)
  }

  // -------------------------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------------------------

  /**
   * Opens these ids (see the module doc) and counts each as used. Then evicts the least recently
   * used decrypted copies over the caps (`#evict`), never one of these ids.
   */
  async load(ids: readonly string[]): Promise<LoadResult> {
    try {
      return await this.#load(ids)
    } finally {
      this.#evict(new Set(ids))
    }
  }

  async #load(ids: readonly string[]): Promise<LoadResult> {
    const puller = this.#puller
    if (puller === undefined) throw new Error('vault has no puller')
    this.#keys.getKeyRing() // VaultLockedError early, before any download
    const epoch = this.#epoch
    const result: LoadResult = { loaded: [], excluded: [], missing: [], failed: [], stale: [] }
    const index = puller.index
    if (index === null) throw new Error('vault.load needs a prior pull refresh()')

    const toFetch: string[] = []
    for (const id of new Set(ids)) {
      const winner = index.get(id)
      if (winner === undefined) result.missing.push(id)
      // Before `#isFresh`: a live copy held at the same `updated_at` loses to a trashed winner.
      else if (!isLive(winner)) this.#markDeleted(winner, result)
      else if (this.#isFresh(winner)) this.#report(id, result)
      else toFetch.push(id)
    }
    if (toFetch.length === 0) return result

    const payloads = await puller.fetchEntries(toFetch)
    if (epoch !== this.#epoch)
      return { loaded: [], excluded: [], missing: [], failed: [], stale: [] }
    const ring = this.#keys.getKeyRing()
    const behind: string[] = []
    for (const id of toFetch) {
      const bytes = payloads.get(id)
      if (bytes === undefined) {
        result.missing.push(id)
        continue
      }
      try {
        const updatedAt = this.#ingest(id, this.#core.openEntry(ring, bytes))
        if (updatedAt < (index.get(id)?.updatedAt ?? 0)) behind.push(id)
        else this.#report(id, result)
      } catch (error) {
        result.failed.push({ id, message: error instanceof Error ? error.message : 'open failed' })
      }
    }
    if (behind.length === 0) return result

    // Older than the winner: drop the cached copy and download it again, once.
    await puller.dropCached(behind)
    const again = await puller.fetchEntries(behind)
    if (epoch !== this.#epoch)
      return { loaded: [], excluded: [], missing: [], failed: [], stale: [] }
    const ringAgain = this.#keys.getKeyRing()
    for (const id of behind) {
      const bytes = again.get(id)
      let updatedAt = -1
      if (bytes !== undefined) {
        try {
          updatedAt = this.#ingest(id, this.#core.openEntry(ringAgain, bytes))
        } catch {
          // keep the copy opened first
        }
      }
      if (updatedAt < (index.get(id)?.updatedAt ?? 0)) result.stale.push(id)
      this.#report(id, result)
    }
    return result
  }

  /**
   * Opens these ids TRANSIENTLY (the search scan, Phase 5.2) and returns the visible ones with the
   * overlay applied, as `load` would serve them. No decrypted copy is kept: nothing enters the
   * bounded set, nothing is evicted or counted as a use, and the caller drops the result after
   * matching. A held fresh copy is served as is. Deleted, trashed, locked, invisible and
   * journal-excluded entries are skipped (an opened one records its stub, which holds no text, so
   * `listIndex` stops listing it), and so are
   * missing or unopenable payloads. A payload older than the index winner is downloaded again once;
   * if it is still older it is skipped, never served (it may predate a lock on desktop).
   */
  async peek(ids: readonly string[]): Promise<VaultEntry[]> {
    const puller = this.#puller
    if (puller === undefined) throw new Error('vault has no puller')
    this.#keys.getKeyRing() // VaultLockedError early, before any download
    const epoch = this.#epoch
    const index = puller.index
    if (index === null) throw new Error('vault.peek needs a prior pull refresh()')

    const out: VaultEntry[] = []
    const toFetch: string[] = []
    for (const id of new Set(ids)) {
      const winner = index.get(id)
      if (winner === undefined || !isLive(winner) || this.#trashed.has(id)) continue
      if (this.#isFresh(winner)) {
        const held = this.#entries.get(id)
        if (held !== undefined && this.status(id) === 'visible') out.push(this.#applyOverlay(held))
      } else toFetch.push(id)
    }
    if (toFetch.length === 0) return out

    const payloads = await puller.fetchEntries(toFetch)
    if (epoch !== this.#epoch) return []
    const behind = this.#peekOpen(toFetch, payloads, index, out)
    if (behind.length === 0) return out

    await puller.dropCached(behind)
    const again = await puller.fetchEntries(behind)
    if (epoch !== this.#epoch) return []
    this.#peekOpen(behind, again, index, out)
    return out
  }

  /** Opens `ids` for `peek` into `out`; returns the ids whose payload is older than the winner. */
  #peekOpen(
    ids: readonly string[],
    payloads: Map<string, Uint8Array>,
    index: ReadonlyMap<string, IndexEntry>,
    out: VaultEntry[],
  ): string[] {
    const ring = this.#keys.getKeyRing()
    const behind: string[] = []
    for (const id of ids) {
      const bytes = payloads.get(id)
      const winner = index.get(id)
      if (bytes === undefined || winner === undefined) continue
      try {
        const opened = this.#core.openEntry(ring, bytes)
        const metadata = parseMetadata(opened.metadataJson, id)
        this.#guardMetadata(id, opened.metadataJson)
        if (metadata.updated_at < winner.updatedAt) {
          behind.push(id)
          continue
        }
        const reason = this.#exclusionReason(metadata)
        if (reason !== null) {
          // As `#ingest`: a held copy this payload supersedes is dropped, never kept beside it.
          const held = this.#entries.get(id)
          if (held === undefined || this.#incomingWins(held.metadata, metadata, opened)) {
            this.#entries.delete(id)
            this.#stubs.set(id, makeStub(metadata, reason))
          }
          continue
        }
        if (this.#journalExcluded(this.#overlaidJournalId(metadata, this.#intentFor(id)))) continue
        this.#stubs.delete(id) // an older stub (e.g. locked before) no longer applies
        const contentText = metadata.content_text ?? ''
        out.push(
          this.#applyOverlay({
            metadata,
            content: opened.yjs.length === 0 ? EMPTY : opened.yjs,
            contentText,
            previewText: metadata.preview_text ?? '',
            loadedAt: this.#now(),
            folded: [foldText(metadata.title ?? ''), foldText(contentText)],
          }),
        )
      } catch {
        // unopenable: skipped, as `load` reports it failed
      }
    }
    return behind
  }

  #isStubbed(winner: IndexEntry): boolean {
    const stub = this.#stubs.get(winner.entryId)
    return stub !== undefined && stub.metadata.updated_at >= winner.updatedAt
  }

  /** Already in RAM at least as new as the index winner (journal stubs are never fresh). */
  #isFresh(winner: IndexEntry): boolean {
    const held = this.#entries.get(winner.entryId)
    if (held !== undefined) return held.metadata.updated_at >= winner.updatedAt
    const stub = this.#stubs.get(winner.entryId)
    return (
      stub !== undefined &&
      stub.reason !== 'journal' &&
      stub.metadata.updated_at >= winner.updatedAt
    )
  }

  #report(id: string, result: LoadResult): void {
    if (this.#touch(id) !== undefined) result.loaded.push(id)
    else result.excluded.push(id)
  }

  #markDeleted(winner: IndexEntry, result: LoadResult): void {
    this.#entries.delete(winner.entryId)
    this.#stubs.set(
      winner.entryId,
      makeStub(
        {
          entry_id: winner.entryId,
          device_id: winner.authorDevice,
          updated_at: winner.updatedAt,
          journal_id: '',
          is_deleted: true,
          is_locked: false,
          is_invisible: false,
          vault_id: null,
          ...(winner.trashedAt === undefined ? {} : { trashed_at: winner.trashedAt }),
        },
        'deleted',
      ),
    )
    result.excluded.push(winner.entryId)
  }

  /** Merges an opened copy into RAM (LWW) and returns ITS `updated_at`, whether it won or not. */
  #ingest(id: string, opened: { metadataJson: string; yjs: Uint8Array }): number {
    const incoming = parseMetadata(opened.metadataJson, id)
    this.#guardMetadata(id, opened.metadataJson)
    const existing = this.#entries.get(id)?.metadata ?? this.#stubs.get(id)?.metadata
    if (existing !== undefined && !this.#incomingWins(existing, incoming, opened)) {
      return incoming.updated_at // the copy already in RAM is newer: keep it
    }
    this.#entries.delete(id)
    this.#stubs.delete(id)
    const reason = this.#exclusionReason(incoming)
    if (reason !== null) {
      this.#stubs.set(id, makeStub(incoming, reason))
      return incoming.updated_at
    }
    const contentText = incoming.content_text ?? ''
    this.#entries.set(id, {
      metadata: incoming,
      content: opened.yjs.length === 0 ? EMPTY : opened.yjs,
      contentText,
      previewText: incoming.preview_text ?? '',
      loadedAt: this.#now(),
      folded: [foldText(incoming.title ?? ''), foldText(contentText)],
    })
    return incoming.updated_at
  }

  /** Whether the opened payload (`incoming`) wins the metadata LWW against the copy in RAM. */
  #incomingWins(
    existing: EntryMetadata,
    incoming: EntryMetadata,
    opened: { metadataJson: string },
  ): boolean {
    const merged = parseMetadata(
      this.#core.mergeMetadataLww(JSON.stringify(existing), opened.metadataJson),
      incoming.entry_id,
    )
    return merged.device_id === incoming.device_id && merged.updated_at === incoming.updated_at
  }

  // -------------------------------------------------------------------------------------------
  // Bounded decrypted set (LRU)
  // -------------------------------------------------------------------------------------------

  /** Marks a held copy as the most recently used (moves it to the end of `#entries`). */
  #touch(id: string): Held | undefined {
    const held = this.#entries.get(id)
    if (held !== undefined) {
      this.#entries.delete(id)
      this.#entries.set(id, held)
    }
    return held
  }

  /** The cap on decrypted entries held at once (`VaultLimits.maxEntries`). */
  get maxEntries(): number {
    return this.#maxEntries
  }

  /** Counts these ids as used now (e.g. shown on a page), so they are evicted last. */
  touch(ids: Iterable<string>): void {
    for (const id of ids) this.#touch(id)
  }

  /**
   * Defers every eviction until the returned release runs (idempotent; a release from before a
   * `clear()` is a no-op), which then evicts down to the caps. The read session holds it with the
   * outbox mutex, so the entry a write builds on is not evicted between its awaits.
   */
  holdEviction(): () => void {
    const epoch = this.#epoch
    this.#holds += 1
    let released = false
    return () => {
      if (released || epoch !== this.#epoch) return
      released = true
      this.#holds -= 1
      this.#evict(new Set())
    }
  }

  /**
   * Never evicted: the base of an unsent web edit (an own intent or a stored draft: a write and
   * retention build on the synced copy) and of a pending web trash (`trashView` serves it).
   */
  #isPinned(id: string): boolean {
    return this.#outboxIntents.has(id) || this.#draftIds.has(id) || this.#trashed.has(id)
  }

  /**
   * Drops the least recently used decrypted copies until the caps hold. Only the plaintext goes:
   * the ciphertext stays in the IndexedDB files store, so the entry is `not-loaded` again and the
   * next `load` reopens it. Stubs are never touched. `keep` (the ids of the current load) and pinned
   * copies stay even over the caps: the caps are soft for them.
   */
  #evict(keep: ReadonlySet<string>): void {
    if (this.#holds > 0) return
    let count = this.#entries.size
    let chars = 0
    for (const held of this.#entries.values()) chars += sizeOf(held)
    const over = (): boolean => count > this.#maxEntries || chars > this.#maxTextChars
    for (const [id, held] of [...this.#entries]) {
      if (!over()) break
      if (keep.has(id) || this.#isPinned(id)) continue
      this.#entries.delete(id)
      count -= 1
      chars -= sizeOf(held)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Trash (read-only, kept apart from the live maps)
  // -------------------------------------------------------------------------------------------

  /** Index winners in the desktop Trash (`trashedAt` set, not a tombstone), loaded or not. */
  listTrashedIndex(): IndexEntry[] {
    const index = this.#puller?.index
    if (index === null || index === undefined) return []
    return [...index.values()].filter(isTrashedWinner)
  }

  /**
   * Opens the desktop-Trash payloads of these ids into `#trashedCopies`, never `#entries`/`#stubs`.
   * Ids whose winner is not trashed are ignored; a copy already held for the winner's `updatedAt`
   * or newer is not fetched again. Deleted, locked, invisible and journal-excluded payloads are not
   * kept (an older copy of them is dropped), nor are copies of ids that left the Trash or whose
   * journal is now excluded. As in `load()`, a payload older than the winner (a stale cache) is
   * dropped from the cache and downloaded again, once; if it is still older, no copy is kept (fail
   * closed). A payload that fails to open drops the held copy too.
   */
  async loadTrashed(ids: readonly string[]): Promise<void> {
    const puller = this.#puller
    if (puller === undefined) throw new Error('vault has no puller')
    this.#keys.getKeyRing() // VaultLockedError early, before any download
    const epoch = this.#epoch
    const index = puller.index
    if (index === null) throw new Error('vault.loadTrashed needs a prior pull refresh()')

    for (const [id, copy] of [...this.#trashedCopies]) {
      const winner = index.get(id)
      if (
        winner === undefined ||
        !isTrashedWinner(winner) ||
        this.#journalExcluded(copy.held.metadata.journal_id)
      ) {
        this.#trashedCopies.delete(id)
      }
    }
    const toFetch: string[] = []
    for (const id of new Set(ids)) {
      const winner = index.get(id)
      if (winner === undefined || !isTrashedWinner(winner)) continue
      const copy = this.#trashedCopies.get(id)
      if (copy === undefined || copy.winnerUpdatedAt < winner.updatedAt) toFetch.push(id)
    }
    if (toFetch.length === 0) return

    const payloads = await puller.fetchEntries(toFetch)
    if (epoch !== this.#epoch) return
    const behind = this.#keepTrashed(toFetch, payloads, index)
    if (behind.length === 0) return

    // Older than the winner: drop the cached copy and download it again, once.
    await puller.dropCached(behind)
    const again = await puller.fetchEntries(behind)
    if (epoch !== this.#epoch) return
    this.#keepTrashed(behind, again, index)
  }

  /**
   * Opens and keeps the trashed payloads of `ids`. Returns the ids whose payload is older than the
   * index winner; no copy is kept for those (a stale payload is never recorded against the
   * winner's `updatedAt`), nor for one that fails to open.
   */
  #keepTrashed(
    ids: readonly string[],
    payloads: Map<string, Uint8Array>,
    index: ReadonlyMap<string, IndexEntry>,
  ): string[] {
    const ring = this.#keys.getKeyRing()
    const behind: string[] = []
    for (const id of ids) {
      const bytes = payloads.get(id)
      const winner = index.get(id)
      if (bytes === undefined || winner === undefined) continue
      try {
        const opened = this.#core.openEntry(ring, bytes)
        const metadata = parseMetadata(opened.metadataJson, id)
        this.#guardMetadata(id, opened.metadataJson)
        const trashedAt = metadata.trashed_at ?? winner.trashedAt
        if (trashedAt === undefined || this.#trashExcluded(metadata)) {
          this.#trashedCopies.delete(id)
          continue
        }
        if (metadata.updated_at < winner.updatedAt) {
          this.#trashedCopies.delete(id)
          behind.push(id)
          continue
        }
        const contentText = metadata.content_text ?? ''
        const held: Held = {
          metadata,
          content: opened.yjs.length === 0 ? EMPTY : opened.yjs,
          contentText,
          previewText: metadata.preview_text ?? '',
          loadedAt: this.#now(),
          folded: [foldText(metadata.title ?? ''), foldText(contentText)],
        }
        this.#trashedCopies.set(id, { held, trashedAt, winnerUpdatedAt: winner.updatedAt })
      } catch {
        // corrupt or unopenable: not listed, and no older copy is kept
        this.#trashedCopies.delete(id)
      }
    }
    return behind
  }

  /** Deleted, locked, invisible or in an excluded journal: never kept as a trashed copy. */
  #trashExcluded(metadata: EntryMetadata): boolean {
    return (
      metadata.is_deleted ||
      metadata.is_locked ||
      metadata.is_invisible ||
      this.#journalExcluded(metadata.journal_id)
    )
  }

  /**
   * The Trash view of an entry, RAM only (never fetches): its desktop-Trash copy while the index
   * winner is still trashed, else a pending web trash (`setTrashedIds`) from the synced copy with
   * the overlay applied or from a `created_on_web` intent. Null when excluded, or when the copy
   * was fetched for an older winner (the entry changed since, e.g. it was locked while trashed).
   */
  trashView(id: string): TrashView | null {
    const copy = this.#trashedCopies.get(id)
    const winner = this.#puller?.index?.get(id)
    if (copy !== undefined && winner !== undefined && isTrashedWinner(winner)) {
      // The winner moved on (e.g. locked or moved while still trashed): this copy is stale.
      if (copy.winnerUpdatedAt < winner.updatedAt) return null
      if (this.#journalExcluded(copy.held.metadata.journal_id)) return null
      return { held: copy.held, trashedAt: copy.trashedAt, pending: false }
    }
    if (!this.#trashed.has(id) || this.#stubs.has(id)) return null
    const synced = this.#entries.get(id)
    const created = synced === undefined ? this.#webCreated(id, true) : undefined
    let held: Held
    if (synced !== undefined) held = this.#applyOverlay(synced)
    else if (created !== undefined) held = this.#syntheticHeldFromIntent(created)
    else return null
    if (this.#journalExcluded(held.metadata.journal_id)) return null
    return { held, trashedAt: null, pending: true }
  }

  #exclusionReason(metadata: EntryMetadata): ExcludedReason | null {
    if (metadata.is_deleted || typeof metadata.trashed_at === 'number') return 'deleted'
    if (metadata.is_locked) return 'locked'
    if (metadata.is_invisible) return 'invisible'
    if (this.#journalExcluded(metadata.journal_id)) return 'journal'
    return null
  }

  // -------------------------------------------------------------------------------------------
  // Views (visible entries only)
  // -------------------------------------------------------------------------------------------

  /** Loaded entries sorted by entry date, newest first (as on desktop), then created, then id. */
  listLoaded(filter: EntryFilter = {}): VaultEntry[] {
    return this.#getAllVisibleHeld()
      .filter((h) => matchesFilter(h, filter))
      .sort(byEntryDateDesc)
  }

  listFavorites(): VaultEntry[] {
    return this.listLoaded({ favorite: true })
  }

  count(filter: EntryFilter = {}): number {
    let n = 0
    for (const held of this.#getAllVisibleHeld()) if (matchesFilter(held, filter)) n += 1
    return n
  }

  journalCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const { metadata } of this.#getAllVisibleHeld()) {
      counts.set(metadata.journal_id, (counts.get(metadata.journal_id) ?? 0) + 1)
    }
    return counts
  }

  /**
   * Search over the LOADED visible set with desktop semantics (see textFold.ts): all words must
   * match whole tokens of title + body, accent- and case-insensitive; `prefix` makes the last
   * token a prefix. Newest entry date first; no limit (the command layer decides).
   */
  search(query: string, options: MatchOptions & { filter?: EntryFilter } = {}): VaultEntry[] {
    const parsed = parseQuery(query)
    if (parsed.length === 0) return []
    const filter = options.filter ?? {}
    return this.#getAllVisibleHeld()
      .filter((h) => matchesFilter(h, filter) && matchesQuery(h.folded, parsed, options))
      .sort(byEntryDateDesc)
  }

  /**
   * The index (all known entries, loaded or not), `updated_at` descending (the fetch order of the
   * lazy pages), without tombstones or trashed entries and without ids already known to be excluded. A stub older
   * than the index winner is listed again: its entry changed and may be visible now.
   */
  listIndex(): IndexEntry[] {
    const index = this.#puller?.index
    if (index === null || index === undefined) return []
    return [...index.values()]
      .filter((e) => isLive(e) && !this.#isStubbed(e) && !this.#trashed.has(e.entryId))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.entryId < b.entryId ? -1 : 1))
  }

  /**
   * TESTS ONLY. JSON of everything the vault holds (visible entries, stubs, trashed copies, bytes
   * as text) so a test can assert that a plaintext marker is, or is not, retained in RAM.
   */
  __debugDump(): string {
    return JSON.stringify({
      entries: [...this.#entries.values()].map((h) => ({
        ...h,
        content: decoder.decode(h.content),
      })),
      stubs: [...this.#stubs.values()],
      trashed: [...this.#trashedCopies.values()].map((c) => ({
        ...c,
        held: { ...c.held, content: decoder.decode(c.held.content) },
      })),
    })
  }
}

function matchesFilter(held: Held, filter: EntryFilter): boolean {
  const m = held.metadata
  return (
    (filter.journalId === undefined || m.journal_id === filter.journalId) &&
    (filter.tagId === undefined || m.tag_ids.includes(filter.tagId)) &&
    (filter.favorite === undefined || m.is_favorite === filter.favorite) &&
    (filter.emotion === undefined || m.emotion === filter.emotion)
  )
}

export function createVault(deps: VaultDeps): Vault {
  return new Vault(deps)
}
