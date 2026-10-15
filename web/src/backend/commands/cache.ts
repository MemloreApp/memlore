/**
 * Media cache settings and stats (Phase 11.3): the existing Settings UI (`MediaCacheSettings`)
 * drives the web cache through the desktop command names and wire shape.
 *
 *  - `get_media_cache_stats` -> `{usedBytes, maxBytes, persisted, usage?, quota?, unsentDrafts?}`:
 *    usage as the evictor defines it (every cached `files` and `blobs` ciphertext byte, from
 *    `sizes()`: no bytes are loaded) and the EFFECTIVE budget (`min(500 MB, 50% of quota)`,
 *    lowered by the user limit).
 *    Web only: `persisted` is the stored durable-storage answer (`STORAGE_PERSISTED_KEY`, false when
 *    unknown), `usage`/`quota` the whole origin from `navigator.storage.estimate()` (omitted when
 *    the browser does not report them), `unsentDrafts` the number of drafts not yet uploaded, read
 *    from the browser-wide IndexedDB (`listUnpushedDrafts`: another tab's saves count too), so the
 *    "unsent changes" warning shows only when something is unsent. It is omitted (= unknown, the
 *    warning shows) when the drafts cannot be read and in the evictor-triggered event, which runs
 *    after every cache write and so skips hashing every draft. Desktop sends none of the four.
 *  - `set_media_cache_limit {bytes}`: the user limit can only LOWER the budget (the evictor clamps
 *    it to 50 MB..cap). It is persisted in `meta` (`cache-limit-bytes`, kept by `clearCache()`) and
 *    re-applied by the evictor on unlock. Enforced immediately; returns the new stats.
 *  - `clear_media_cache` deletes ONLY the `blobs` rows (full media and thumbnails). Drafts, retained
 *    intents, the device record (`change_seq`), `meta` hints, the authority files and entry payloads
 *    are never opened. `clear_font_cache` is desktop-only and is not mapped.
 *  - `media-cache:stats-changed` (payload = the stats) is emitted after a limit change, a clear and
 *    any write-triggered or evicting run of the evictor (`installCacheStatsEmitter`).
 *
 * Every handler rejects with `VaultLockedError` while locked (the Settings page only exists in an
 * unlocked app).
 *
 * DURABLE STORAGE (`installStoragePersistence`): every `app:unlocked` asks `persisted()` and, only
 * when not persisted, `persist()`, at most once per page session (Firefox may prompt on each call;
 * onboarding's own request counts, see `markPersistRequested`). The answer is stored in `meta`.
 * Best effort: a missing API or a rejection is "not persisted" and never blocks the unlock.
 */

import { emitFromBackend, listen } from '../../tauri/event'
import { createDraftManager } from '../drafts'
import { getKeyRing } from '../keys'
import type { Handler } from '../router'
import {
  getBudgetBytes,
  isEvictorRunning,
  lowerByLimit,
  maybeEvict,
  setBudgetBytes,
  setStatsListener,
} from '../storage/evictor'
import { CACHE_LIMIT_KEY, STORAGE_PERSISTED_KEY, openWebDb, type WebDb } from '../storage/idb'

export const MEDIA_CACHE_STATS_EVENT = 'media-cache:stats-changed'

export interface MediaCacheStats {
  usedBytes: number
  maxBytes: number
  /** Whether the browser granted durable storage (false when refused, unknown or unsupported). */
  persisted: boolean
  /** Whole-origin bytes used and allowed, from `navigator.storage.estimate()`. */
  usage?: number
  quota?: number
  /** Drafts not yet uploaded to Drive; omitted when unknown. */
  unsentDrafts?: number
}

/** The `navigator.storage` methods this module uses; any of them may be missing. */
export interface BrowserStorage {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

export interface CacheEnv {
  openDb: () => Promise<WebDb>
  /** Throws `VaultLockedError` when locked. */
  assertUnlocked: () => void
  /** `navigator.storage`, or undefined where the browser has none. */
  storage: () => BrowserStorage | undefined
}

let injected: Partial<CacheEnv> = {}
let dbPromise: Promise<WebDb> | null = null
/** `persist()` was called in this page session (by an unlock or by onboarding). */
let persistRequested = false

const cacheEnv = (): CacheEnv => ({
  openDb: () => openWebDb(),
  assertUnlocked: () => {
    getKeyRing()
  },
  storage: () => (globalThis.navigator as { storage?: BrowserStorage } | undefined)?.storage,
  ...injected,
})

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureCacheEnv(partial: Partial<CacheEnv>): void {
  injected = partial
  dbPromise = null
  persistRequested = false
}

function getDb(): Promise<WebDb> {
  dbPromise ??= cacheEnv()
    .openDb()
    .catch((error: unknown) => {
      dbPromise = null
      throw error
    })
  return dbPromise
}

/** `drafts: false` skips the draft count (the evictor path): the stats then omit it. */
async function readStats({ drafts = true } = {}): Promise<MediaCacheStats> {
  const db = await getDb()
  const [files, blobs, budget] = await Promise.all([
    db.files.sizes(),
    db.blobs.sizes(),
    getBudgetBytes(),
  ])
  // Before the evictor starts (between unlock and `app:unlocked`) it knows no limit: show the
  // persisted one, read-only, without touching the evictor's state.
  const maxBytes = isEvictorRunning()
    ? budget
    : lowerByLimit(budget, (await db.meta.get(CACHE_LIMIT_KEY).catch(() => undefined))?.value)
  const usedBytes = [...files, ...blobs].reduce((sum, m) => sum + m.size, 0)
  const persisted =
    (await db.meta.get(STORAGE_PERSISTED_KEY).catch(() => undefined))?.value === true
  return {
    usedBytes,
    maxBytes,
    persisted,
    ...(drafts ? await unsentDrafts(db) : {}),
    ...(await originEstimate()),
  }
}

/** Unpushed drafts in the IndexedDB every tab shares; omitted on a read failure (warning shows). */
async function unsentDrafts(db: WebDb): Promise<Pick<MediaCacheStats, 'unsentDrafts'>> {
  try {
    return { unsentDrafts: (await createDraftManager({ db }).listUnpushedDrafts()).length }
  } catch {
    return {}
  }
}

const isByteCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

/** Whole-origin usage and quota; each field is omitted when the browser does not report it. */
async function originEstimate(): Promise<Pick<MediaCacheStats, 'usage' | 'quota'>> {
  try {
    const estimate = await cacheEnv().storage()?.estimate?.()
    return {
      ...(isByteCount(estimate?.usage) ? { usage: estimate.usage } : {}),
      ...(isByteCount(estimate?.quota) ? { quota: estimate.quota } : {}),
    }
  } catch {
    return {}
  }
}

async function statsAndEmit(): Promise<MediaCacheStats> {
  const stats = await readStats()
  emitFromBackend(MEDIA_CACHE_STATS_EVENT, stats)
  return stats
}

/** Parses the `bytes` argument: a finite number >= 0; a huge value is clamped to a safe integer. */
function parseLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('set_media_cache_limit: bytes must be a finite number >= 0')
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
}

export const cacheHandlers: Record<string, Handler> = {
  get_media_cache_stats: async () => {
    cacheEnv().assertUnlocked()
    return readStats()
  },
  set_media_cache_limit: async ({ bytes }) => {
    cacheEnv().assertUnlocked()
    const limit = parseLimit(bytes)
    const db = await getDb()
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: limit })
    cacheEnv().assertUnlocked() // a lock during the write must not set a limit on a stopped evictor
    setBudgetBytes(limit)
    await maybeEvict('manual')
    return statsAndEmit()
  },
  clear_media_cache: async () => {
    cacheEnv().assertUnlocked()
    const db = await getDb()
    await db.blobs.clear()
    return statsAndEmit()
  },
}

/** Emits `media-cache:stats-changed` after write-triggered and evicting evictor runs. Idempotent. */
export function installCacheStatsEmitter(): void {
  setStatsListener(() => {
    void readStats({ drafts: false }).then(
      (stats) => emitFromBackend(MEDIA_CACHE_STATS_EVENT, stats),
      () => undefined,
    )
  })
}

/** Onboarding called `persist()` in this page session: the unlock that follows must not prompt again. */
export function markPersistRequested(): void {
  persistRequested = true
}

/** Asks for durable storage only when not already granted, once per page session. Never rejects. */
async function refreshPersistence(): Promise<void> {
  const storage = cacheEnv().storage()
  let persisted = false
  try {
    persisted = (await storage?.persisted?.()) === true
    if (!persisted && !persistRequested && storage?.persist) {
      persistRequested = true
      persisted = (await storage.persist()) === true
    }
  } catch {
    persisted = false
  }
  try {
    await (await getDb()).meta.put({ key: STORAGE_PERSISTED_KEY, value: persisted })
  } catch (err) {
    console.warn('[cache] durable storage answer not saved', err)
  }
}

let persistenceInstalled = false

/** Wires `app:unlocked` to `refreshPersistence` (detached: a browser prompt never holds the unlock). Idempotent. */
export function installStoragePersistence(): void {
  if (persistenceInstalled) return
  persistenceInstalled = true
  void listen('app:unlocked', () => {
    void refreshPersistence()
  })
}
