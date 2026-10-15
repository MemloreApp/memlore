import type { Core } from '../core/core'
import { emitFromBackend } from '../tauri/event'
import { ERROR_NAMES } from './errorNames'
import { onTabMessage, postTabMessage, startLeaderElection, stopLeaderElection } from './tabs'

/** The WASM key ring (its constructor is private in the d.ts, hence the alias). */
export type KeyRing = ReturnType<Core['KeyRing']['fromRecovery']>

/** `remote`: an explicit or idle lock in another tab (a `{lock}` message or the lock epoch). */
export type LockReason = 'manual' | 'idle' | 'hidden' | 'revoked' | 'format' | 'remote'

export class VaultLockedError extends Error {
  constructor() {
    super('vault is locked')
    this.name = ERROR_NAMES.vaultLocked
  }
}

const DEFAULT_IDLE_MINUTES = 15
const MIN_IDLE_MINUTES = 1
const MAX_IDLE_MINUTES = 24 * 60
const HIDDEN_LIMIT_MS = 5 * 60 * 1000
const ACTIVITY_THROTTLE_MS = 1000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
/**
 * Local activity is announced to the other tabs at most this often. Activity inside the window is
 * announced by one trailing post when it ends, so another tab's idle deadline never lags this
 * tab's (a 1-minute auto-lock there would otherwise lock every tab ~31 s after the last activity).
 */
const ACTIVITY_POST_THROTTLE_MS = 30 * 1000

/**
 * Cross-tab locks (user decision Q7): only an explicit lock and the idle auto-lock lock every tab.
 * They post `{lock}` and bump a counter in localStorage (no key material), so a tab that missed
 * the message (frozen, bfcache) still locks on `pageshow`, `visibilitychange` or a `storage` event,
 * and a reload session saved under an older epoch is not restored (auth.ts).
 */
export const LOCK_EPOCH_KEY = 'memlore-web-lock-epoch'
const BROADCAST_REASONS: ReadonlySet<LockReason> = new Set<LockReason>(['manual', 'idle'])

interface Target {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}
interface DocumentLike extends Target {
  visibilityState: string
}
type EpochStore = Pick<Storage, 'getItem' | 'setItem'>

/** Injectable environment. Defaults resolve lazily so importing has no side effects. */
export interface KeysEnv {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  emit: (event: string, payload?: unknown) => void
  document: DocumentLike | null
  window: Target | null
  /** Holds the lock epoch. Default: localStorage (null when missing or blocked). */
  localStorage: () => EpochStore | null
}

function defaultEnv(): KeysEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    emit: emitFromBackend,
    document: typeof document === 'undefined' ? null : (document as unknown as DocumentLike),
    window: typeof window === 'undefined' ? null : (window as unknown as Target),
    localStorage: () => (typeof localStorage === 'undefined' ? null : localStorage),
  }
}

let injected: Partial<KeysEnv> = {}
const resolveEnv = (): KeysEnv => ({ ...defaultEnv(), ...injected })

let ring: KeyRing | null = null
let idleMinutes = DEFAULT_IDLE_MINUTES
const hooks = new Set<() => void>()
const deadlineHooks = new Set<(deadline: number) => void>()

let idleTimer: unknown = null
let hiddenTimer: unknown = null
let activityPostTimer: unknown = null
let hiddenAt: number | null = null
let lastActivity = 0
let idleDeadline = 0
let lockDeadline = 0
let lastActivityPost = 0
let unlockEpoch = 0
let watching: { e: KeysEnv; remove: () => void } | null = null

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureKeysEnv(partial: Partial<KeysEnv>): void {
  injected = partial
}

/**
 * Auto-lock minutes from the `web_auto_lock_minutes` web setting (`commands/webSettings.ts`).
 * null/NaN/<=0/non-number fall back to the default. Desktop's auto-lock settings (`*_auto_lock_minutes`, options 1/5/15/30 and
 * 0 = "never") belong to the second/invisible locks, but if "never" (0) ever arrives
 * here it is NOT honoured: a browser tab is less trusted, so it becomes the 15 min
 * default. Other values are clamped to [1, 24*60].
 */
export function setAutoLockMinutes(minutes: number | null): void {
  idleMinutes =
    typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, minutes))
      : DEFAULT_IDLE_MINUTES
  if (watching) resetIdle()
}

export const getAutoLockMinutes = (): number => idleMinutes

export function onLock(cb: () => void): () => void {
  hooks.add(cb)
  return () => {
    hooks.delete(cb)
  }
}

/**
 * Called with the new lock deadline (`getLockDeadline`) each time it changes: the idle timer
 * restarts, or the tab is hidden.
 */
export function onLockDeadline(cb: (deadline: number) => void): () => void {
  deadlineHooks.add(cb)
  return () => {
    deadlineHooks.delete(cb)
  }
}

export const isUnlocked = (): boolean => ring !== null

export function getKeyRing(): KeyRing {
  if (!ring) throw new VaultLockedError()
  return ring
}

/** The lock epoch in localStorage; 0 when missing, unreadable or not a counter. */
export function readLockEpoch(): number {
  try {
    const n = Number(resolveEnv().localStorage()?.getItem(LOCK_EPOCH_KEY) ?? 0)
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** The lock epoch this tab saw when its ring was installed. */
export const getUnlockEpoch = (): number => unlockEpoch

function bumpLockEpoch(): void {
  try {
    resolveEnv()
      .localStorage()
      ?.setItem(LOCK_EPOCH_KEY, String(readLockEpoch() + 1))
  } catch (err) {
    console.error('[keys] lock epoch not saved', err)
  }
}

/** Locks this tab when another tab locked after this one unlocked. True when it locked. */
function lockIfEpochAdvanced(): boolean {
  if (readLockEpoch() <= unlockEpoch) return false
  lock('remote')
  return true
}

/** Restarts the idle timer from now, or for what is left until `until` when that is sooner. */
function resetIdle(until?: number): void {
  if (!watching) return
  const { e } = watching
  if (idleTimer !== null) e.clearTimeout(idleTimer)
  const now = e.now()
  const ms = idleMinutes * 60 * 1000
  idleDeadline = until === undefined ? now + ms : Math.min(until, now + ms)
  lastActivity = idleDeadline - ms
  idleTimer = e.setTimeout(() => lock('idle'), Math.max(0, idleDeadline - now))
  emitDeadline()
}

function emitDeadline(): void {
  lockDeadline =
    hiddenAt === null ? idleDeadline : Math.min(idleDeadline, hiddenAt + HIDDEN_LIMIT_MS)
  for (const cb of [...deadlineHooks]) {
    try {
      cb(lockDeadline)
    } catch (err) {
      console.error('[keys] idle deadline hook threw', err)
    }
  }
}

/** Reset the idle timer (user activity). */
export function touch(): void {
  resetIdle()
}

/**
 * The earliest time (Unix ms) the vault locks by itself: idle, or the hidden-tab limit. 0 when no
 * ring is watched: an already-passed deadline, never "no limit".
 */
export const getLockDeadline = (): number => lockDeadline

/** The idle part of `getLockDeadline` alone (the hidden-tab limit left out). */
export const getIdleDeadline = (): number => idleDeadline

/** Brings the idle deadline forward to `until` (never later): a restored reload is not activity. */
export function limitIdleDeadline(until: number): void {
  resetIdle(until)
}

function stopWatchers(): void {
  if (!watching) return
  const { e, remove } = watching
  watching = null
  if (idleTimer !== null) e.clearTimeout(idleTimer)
  if (hiddenTimer !== null) e.clearTimeout(hiddenTimer)
  if (activityPostTimer !== null) e.clearTimeout(activityPostTimer)
  idleTimer = null
  hiddenTimer = null
  activityPostTimer = null
  hiddenAt = null
  idleDeadline = 0
  lockDeadline = 0
  lastActivityPost = 0
  remove()
}

function startWatchers(): void {
  const e = resolveEnv()
  const postActivity = (): void => {
    lastActivityPost = e.now()
    postTabMessage({ type: 'activity' })
  }
  const onActivity = (): void => {
    const now = e.now()
    if (now - lastActivity >= ACTIVITY_THROTTLE_MS) resetIdle()
    if (now - lastActivityPost >= ACTIVITY_POST_THROTTLE_MS) {
      postActivity()
    } else if (activityPostTimer === null) {
      activityPostTimer = e.setTimeout(
        () => {
          activityPostTimer = null
          postActivity()
        },
        lastActivityPost + ACTIVITY_POST_THROTTLE_MS - now,
      )
    }
  }
  // Another tab's activity extends this tab's idle deadline, without being posted again.
  const onRemoteActivity = (): void => {
    if (e.now() - lastActivity >= ACTIVITY_THROTTLE_MS) resetIdle()
  }
  const onEpochChange = (): void => {
    lockIfEpochAdvanced()
  }
  const onPageShow = (): void => {
    // tabs.ts gives up the leader lock on `pagehide`; a tab back from the bfcache queues again.
    if (!lockIfEpochAdvanced()) startLeaderElection()
  }
  const onVisibility = (): void => {
    if (!e.document) return
    if (lockIfEpochAdvanced()) return
    if (e.document.visibilityState === 'hidden') {
      if (hiddenAt !== null) return
      hiddenAt = e.now()
      hiddenTimer = e.setTimeout(() => lock('hidden'), HIDDEN_LIMIT_MS)
      emitDeadline()
      return
    }
    if (hiddenTimer !== null) e.clearTimeout(hiddenTimer)
    hiddenTimer = null
    const since = hiddenAt
    hiddenAt = null
    // Background tabs throttle timers, so trust the wall clock on return.
    if (since !== null && e.now() - since > HIDDEN_LIMIT_MS) {
      lock('hidden')
      return
    }
    resetIdle()
  }
  const { window: win, document: doc } = e
  for (const t of ACTIVITY_EVENTS) win?.addEventListener(t, onActivity)
  win?.addEventListener('storage', onEpochChange)
  win?.addEventListener('pageshow', onPageShow)
  doc?.addEventListener('visibilitychange', onVisibility)
  const offLock = onTabMessage('lock', () => lock('remote'))
  const offActivity = onTabMessage('activity', onRemoteActivity)
  watching = {
    e,
    remove: () => {
      for (const t of ACTIVITY_EVENTS) win?.removeEventListener(t, onActivity)
      win?.removeEventListener('storage', onEpochChange)
      win?.removeEventListener('pageshow', onPageShow)
      doc?.removeEventListener('visibilitychange', onVisibility)
      offLock()
      offActivity()
    },
  }
  resetIdle()
  // A ring installed while the tab is already hidden must start the hidden timer too.
  if (doc?.visibilityState === 'hidden') onVisibility()
}

function safeLockRing(r: KeyRing): void {
  try {
    r.lock()
  } catch (err) {
    console.error('[keys] ring.lock() failed', err)
  }
}

/** Install the ring after a successful unlock/onboard; locks any previous ring. */
export function setKeyRing(next: KeyRing): void {
  stopWatchers()
  if (ring && ring !== next) safeLockRing(ring)
  ring = next
  unlockEpoch = readLockEpoch()
  startWatchers()
  startLeaderElection()
}

/**
 * Idempotent, never throws: zeroize, drop handle, run every hook, emit once. An explicit or idle
 * lock also locks the other tabs; a `remote` one never posts back (no ping-pong).
 */
export function lock(reason: LockReason): void {
  const r = ring
  if (!r) return
  ring = null
  stopWatchers()
  stopLeaderElection()
  safeLockRing(r)
  if (BROADCAST_REASONS.has(reason)) {
    bumpLockEpoch()
    try {
      postTabMessage({ type: 'lock' })
    } catch (err) {
      console.error('[keys] lock not posted to the other tabs', err)
    }
  }
  for (const hook of [...hooks]) {
    try {
      hook()
    } catch (err) {
      console.error('[keys] lock hook threw', reason, err)
    }
  }
  try {
    resolveEnv().emit('app:locked')
  } catch (err) {
    console.error('[keys] emit app:locked failed', err)
  }
}

/** Tests only: drop everything without emitting or running hooks. */
export function dispose(): void {
  stopWatchers()
  stopLeaderElection()
  if (ring) safeLockRing(ring)
  ring = null
  hooks.clear()
  deadlineHooks.clear()
  idleMinutes = DEFAULT_IDLE_MINUTES
  injected = {}
}
