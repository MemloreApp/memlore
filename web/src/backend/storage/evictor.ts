/**
 * Cache auto-clean (Phase 11.2). Drops LOCAL ciphertext copies only; they re-download on demand.
 * This module imports no Drive code and never touches the network: eviction can never delete
 * anything in the cloud.
 *
 * WHAT CAN BE EVICTED (a whitelist, so a store added later is safe by default):
 *  - `blobs` rows under `media/` (full media and `.thumb` thumbnails),
 *  - `files` rows that are entry payloads (`<device>/entries/<id>.bin`).
 * Everything else is counted in the usage but never dropped: the authority files (`.meta/...`,
 * including the cached `_content.json`), manifests, `outbox-acks.bin`, journals, tags and templates
 * (small, and needed to render lists), and any `files` row with `pinned: true` (the 5 newest entries
 * `warmStart` pinned). The `drafts`, `device` (holds `change_seq`), `meta` (`journal-seen:` hints)
 * and future `intents` stores are never opened here (`PROTECTED_STORES`); `protect` adds a
 * per-record veto on top.
 *
 * RULES: (1) protected records stay; (2) every evictable record not accessed for 30 days goes;
 * (3) if usage is still over the budget, evict LRU (oldest `lastAccess` first) in the order full
 * media, thumbnails, entry payloads until usage is under 80% of the budget. A `quota` run (the
 * browser refused a draft save) does that same LRU pass whatever the budget, until usage is under
 * `QUOTA_TARGET_FRACTION` of what it was (and under 80% of the budget): a full browser quota
 * usually leaves the cache under its own budget.
 *
 * BUDGET: `min(500 MB, 50% of storage.estimate().quota)`. When the estimate is unavailable or the
 * quota unknown the budget fails toward SMALLER (200 MB). The user limit (11.3) can lower the
 * budget, never raise it above that cap.
 *
 * SCHEDULE (`start`, driven by `app:unlocked` and by this tab becoming the leader, `tabs.ts`;
 * `stop` by the key holder's lock hook and by losing leadership): runs only in the leader tab, so
 * several open tabs never evict side by side. One run on unlock (or on becoming leader), one every 10 minutes while idle (tab visible and no cache write in the last minute), and
 * one 2 s after a burst of cache writes (`notifyCacheWrite`, debounced) which only evicts when the
 * write pushed usage over the budget. Runs are single-flight; errors are swallowed and retried at
 * the next tick. `maybeEvict` itself runs in any tab while stopped: a `quota` pass rescues a draft
 * save in the tab that made it, and a `manual` one follows the user's limit change.
 */

import { listen } from '../../tauri/event'
import { isUnlocked, onLock } from '../keys'
import { isLeader, onLeaderChange } from '../tabs'
import { CACHE_LIMIT_KEY, openWebDb, type CacheMeta, type WebDb } from './idb'

const MB = 1024 * 1024
export const MAX_BUDGET_BYTES = 500 * MB
/** Smallest user override. A lower value is raised to this, then capped by the computed budget. */
export const MIN_BUDGET_OVERRIDE_BYTES = 50 * MB
/** Budget when `storage.estimate()` is unavailable or reports no quota. */
export const UNKNOWN_QUOTA_BUDGET_BYTES = 200 * MB
export const QUOTA_FRACTION = 0.5
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const TARGET_FRACTION = 0.8
/** A `quota` run evicts until usage is under this share of the usage it found. */
export const QUOTA_TARGET_FRACTION = 0.5
export const INTERVAL_MS = 10 * 60 * 1000
export const IDLE_AFTER_WRITE_MS = 60 * 1000
export const WRITE_DEBOUNCE_MS = 2000

/** Stores the evictor must never open. Register new ones (`intents`) with `protectStore`. */
export const PROTECTED_STORES: Set<string> = new Set(['drafts', 'intents', 'device', 'meta'])

export function protectStore(name: string): void {
  PROTECTED_STORES.add(name)
}

/** Budget for a quota (undefined = unknown) and an optional user limit. */
export function computeBudget(quota: number | undefined, override: number | null): number {
  const cap =
    typeof quota === 'number' && Number.isFinite(quota) && quota > 0
      ? Math.min(MAX_BUDGET_BYTES, Math.floor(quota * QUOTA_FRACTION))
      : UNKNOWN_QUOTA_BUDGET_BYTES
  return lowerByLimit(cap, override)
}

/** `cap` lowered by a user limit (any non-number or non-finite value means "no limit"). */
export function lowerByLimit(cap: number, limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return cap
  const wanted = Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_OVERRIDE_BYTES, limit))
  return Math.min(cap, wanted)
}

/**
 * `quota`: a draft save hit the browser quota (`drafts.ts`); one pass before its bounded retries.
 * It frees a share of the cache even under the budget (rule 3), never drafts or outbox blobs.
 */
export type EvictReason = 'unlock' | 'interval' | 'write' | 'manual' | 'quota'

/** One cached record, as seen by the evictor and by `protect`. */
export interface CacheItem extends CacheMeta {
  store: 'files' | 'blobs'
}

export interface EvictResult {
  reason: EvictReason
  budget: number
  usageBefore: number
  usageAfter: number
  evicted: number
}

export interface EvictorEnv {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** Resolves `{quota}`; undefined or a rejection means "unknown". */
  estimate: () => Promise<{ quota?: number } | undefined>
  openDb: () => Promise<Pick<WebDb, 'files' | 'blobs'>>
  isVisible: () => boolean
  /** Extra per-record veto (Phase 16 retained intents). */
  protect: ((item: CacheItem) => boolean) | null
  /** Usage changed (a write-triggered run, or an eviction). Not called for `manual` runs. */
  onStatsChanged: (() => void) | null
}

function defaultEstimate(): Promise<{ quota?: number } | undefined> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
  return storage?.estimate ? storage.estimate() : Promise.resolve(undefined)
}

function defaultVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

const defaultEnv = (): EvictorEnv => ({
  now: () => Date.now(),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  estimate: defaultEstimate,
  openDb: () => openWebDb(),
  isVisible: defaultVisible,
  protect: null,
  onStatsChanged: () => statsListener?.(),
})

const ENTRY_PAYLOAD = /^[^/]+\/entries\/[^/]+\.bin$/
const MEDIA_PREFIX = 'media/'
const THUMB_SUFFIX = '.thumb'

type Tier = 0 | 1 | 2 // full media, thumbnail, entry payload

/** The eviction tier of an item, or null when it is never evictable. */
function tierOf(item: CacheItem): Tier | null {
  if (item.pinned) return null
  if (item.store === 'blobs') {
    if (!item.path.startsWith(MEDIA_PREFIX)) return null
    return item.path.endsWith(THUMB_SUFFIX) ? 1 : 0
  }
  return ENTRY_PAYLOAD.test(item.path) ? 2 : null
}

export interface Evictor {
  /** Evicts per the rules; resolves null when skipped or failed. Never rejects. Single-flight. */
  maybeEvict(reason: EvictReason): Promise<EvictResult | null>
  /** A cache write happened: debounced eviction check. No-op while stopped. */
  notifyCacheWrite(): void
  /** User limit from 11.3 (null = none). It can only lower the budget. */
  setBudgetBytes(bytes: number | null): void
  /** The effective budget now (quota cap lowered by the user limit). Never rejects. */
  budgetBytes(): Promise<number>
  start(): void
  stop(): void
  readonly running: boolean
}

export function createEvictor(overrides: Partial<EvictorEnv> = {}): Evictor {
  const env: EvictorEnv = { ...defaultEnv(), ...overrides }
  let override: number | null = null
  let started = false
  let epoch = 0
  let interval: unknown = null
  let debounce: unknown = null
  let lastWrite = Number.NEGATIVE_INFINITY
  let inflight: Promise<EvictResult | null> | null = null
  let dirty = false
  let limitLoaded = false
  let dbPromise: Promise<Pick<WebDb, 'files' | 'blobs'>> | null = null

  const getDb = (): Promise<Pick<WebDb, 'files' | 'blobs'>> => {
    dbPromise ??= env.openDb().catch((error: unknown) => {
      dbPromise = null
      throw error
    })
    return dbPromise
  }

  async function budget(): Promise<number> {
    let quota: number | undefined
    try {
      quota = (await env.estimate())?.quota
    } catch {
      quota = undefined
    }
    return computeBudget(quota, override)
  }

  /**
   * Applies the persisted user limit once per start, unless `setBudgetBytes` already set one.
   * Marked loaded only after a successful read: a failed read is retried at the next run.
   */
  async function loadLimit(db: Pick<WebDb, 'files' | 'blobs'>): Promise<void> {
    if (limitLoaded) return
    const meta = (db as Partial<Pick<WebDb, 'meta'>>).meta
    if (!meta) {
      limitLoaded = true
      return
    }
    const mine = epoch
    const stored = (await meta.get(CACHE_LIMIT_KEY))?.value
    if (mine !== epoch) return // stopped while reading: the next start re-reads
    limitLoaded = true
    if (typeof stored === 'number' && Number.isFinite(stored) && override === null) {
      override = stored
      try {
        env.onStatsChanged?.() // the UI may have read the default cap before the limit loaded
      } catch {
        // a listener must never break eviction
      }
    }
  }

  async function run(reason: EvictReason): Promise<EvictResult> {
    const mine = epoch
    const db = await getDb()
    await loadLimit(db)
    if (PROTECTED_STORES.has('files') || PROTECTED_STORES.has('blobs')) {
      throw new Error('a protected store cannot be evicted')
    }
    const [files, blobs, limit] = await Promise.all([db.files.sizes(), db.blobs.sizes(), budget()])
    const items: CacheItem[] = [
      ...files.map((m): CacheItem => ({ ...m, store: 'files' })),
      ...blobs.map((m): CacheItem => ({ ...m, store: 'blobs' })),
    ]
    const usageBefore = items.reduce((sum, i) => sum + i.size, 0)
    let usage = usageBefore
    let evicted = 0

    const candidates = items.filter((i) => tierOf(i) !== null && !env.protect?.(i))
    const drop = async (item: CacheItem): Promise<void> => {
      if (epoch !== mine) return // locked while running: stop touching the store
      await (item.store === 'files' ? db.files.delete(item.path) : db.blobs.delete(item.path))
      usage -= item.size
      evicted += 1
    }

    const cutoff = env.now() - STALE_AFTER_MS
    const remaining: CacheItem[] = []
    for (const item of candidates) {
      if (item.lastAccess < cutoff) await drop(item)
      else remaining.push(item)
    }

    if (reason === 'quota' || usage > limit) {
      const target =
        reason === 'quota'
          ? Math.min(limit * TARGET_FRACTION, usage * QUOTA_TARGET_FRACTION)
          : limit * TARGET_FRACTION
      remaining.sort(
        (a, b) => (tierOf(a) as Tier) - (tierOf(b) as Tier) || a.lastAccess - b.lastAccess,
      )
      for (const item of remaining) {
        if (usage < target) break
        await drop(item)
      }
    }
    if (reason !== 'manual' && (reason === 'write' || evicted > 0) && epoch === mine) {
      try {
        env.onStatsChanged?.()
      } catch {
        // a listener must never break eviction
      }
    }
    return { reason, budget: limit, usageBefore, usageAfter: usage, evicted }
  }

  async function budgetBytes(): Promise<number> {
    try {
      // Stopped (locked): never repopulate `override`/`limitLoaded`; use the in-memory state.
      if (started) await loadLimit(await getDb())
    } catch {
      // unreadable store: fall back to the computed cap
    }
    return budget()
  }

  function maybeEvict(reason: EvictReason): Promise<EvictResult | null> {
    if (inflight !== null) {
      if (reason === 'manual' || reason === 'quota') {
        // The running pass may have used the old budget, or was not a quota pass that frees space
        // under the budget: wait for it, then run this one. A lock (`stop`) in between must not
        // start a fresh pass under the new epoch.
        const running = inflight
        const waitedEpoch = epoch
        return running.then(() => (waitedEpoch === epoch ? maybeEvict(reason) : null))
      }
      dirty = true // something changed during the run: check once more afterwards
      return inflight
    }
    const task = run(reason)
      .catch((): null => {
        console.error('[evictor] eviction failed; retrying at the next tick')
        return null
      })
      .finally(() => {
        inflight = null
        if (dirty && started) {
          dirty = false
          void maybeEvict('write')
        }
      })
    inflight = task
    return task
  }

  const idle = (): boolean => env.isVisible() && env.now() - lastWrite >= IDLE_AFTER_WRITE_MS

  function clearTimers(): void {
    if (interval !== null) env.clearInterval(interval)
    if (debounce !== null) env.clearTimeout(debounce)
    interval = null
    debounce = null
  }

  return {
    maybeEvict,
    budgetBytes,
    notifyCacheWrite(): void {
      lastWrite = env.now()
      if (!started) return
      if (debounce !== null) env.clearTimeout(debounce)
      debounce = env.setTimeout(() => {
        debounce = null
        void maybeEvict('write')
      }, WRITE_DEBOUNCE_MS)
    },
    setBudgetBytes(bytes: number | null): void {
      override = bytes
      limitLoaded = true
    },
    start(): void {
      if (started) return
      started = true
      interval = env.setInterval(() => {
        if (idle()) void maybeEvict('interval')
      }, INTERVAL_MS)
      void maybeEvict('unlock')
    },
    stop(): void {
      started = false
      dirty = false
      epoch += 1
      limitLoaded = false
      override = null // a limit set in this session must not outlive the lock; re-read on start
      clearTimers()
    },
    get running(): boolean {
      return started
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Page-wide instance
// ---------------------------------------------------------------------------------------------

let injected: Partial<EvictorEnv> = {}
let statsListener: (() => void) | null = null
let instance: Evictor | null = null

const evictor = (): Evictor => (instance ??= createEvictor(injected))

/** Test seam: override injected pieces and drop the instance. Pass `{}` to restore the defaults. */
export function configureEvictorEnv(partial: Partial<EvictorEnv>): void {
  instance?.stop()
  instance = null
  injected = partial
}

export const maybeEvict = (reason: EvictReason): Promise<EvictResult | null> =>
  evictor().maybeEvict(reason)
/** Call after caching a blob or an entry payload. Cheap, debounced, never throws. */
export const notifyCacheWrite = (): void => evictor().notifyCacheWrite()
export const setBudgetBytes = (bytes: number | null): void => evictor().setBudgetBytes(bytes)
export const getBudgetBytes = (): Promise<number> => evictor().budgetBytes()
/** Registers the single stats-changed listener (11.3 emits `media-cache:stats-changed` from it). */
export function setStatsListener(fn: (() => void) | null): void {
  statsListener = fn
}
export const isEvictorRunning = (): boolean => evictor().running
export const startEvictor = (): void => evictor().start()
export const stopEvictor = (): void => evictor().stop()

let autostartInstalled = false

/**
 * Wires the background schedule to the leader tab: `app:unlocked` or gaining leadership starts it
 * (whichever comes second), the key holder's lock hook or losing leadership stops it. Idempotent.
 */
export function installEvictorAutostart(): void {
  if (autostartInstalled) return
  autostartInstalled = true
  onLock(stopEvictor)
  onLeaderChange((leader) => {
    if (!leader) stopEvictor()
    else if (isUnlocked()) startEvictor()
  })
  void listen('app:unlocked', () => {
    if (isUnlocked() && isLeader()) startEvictor()
  })
}
