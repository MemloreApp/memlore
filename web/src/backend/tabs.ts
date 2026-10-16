/**
 * Coordination between open tabs of the web companion.
 *
 * - A BroadcastChannel (`memlore-web-tabs`) carries a CLOSED message set. Messages hold ids only,
 *   never key material or content. Every received message is validated (exact shape, known type,
 *   bounded `entryId`); anything else is ignored. Outgoing messages are rebuilt from the same
 *   whitelist, so extra fields a caller passes never reach the wire.
 * - One tab is the leader: it holds the `memlore-web-leader` Web Lock. Each unlocked tab queues a
 *   request (never `ifAvailable`), so when the leader releases (lock, `pagehide`) the next queued tab
 *   takes over. A tab that stops while still queued withdraws its request.
 *
 * - An entry draft is rebuilt under a per-entry Web Lock (`withDraftLock`), so two tabs never
 *   read-merge-write the same draft at once.
 * - `withWriterLock` takes the Drive single-writer lock outside an upload (a journal / tag create
 *   edited or dropped, `commands/taxonomy.ts`).
 *
 * Missing BroadcastChannel / navigator.locks: the boot check already refuses the browser; here
 * posting is a no-op, the tab never leads and `withDraftLock` runs its callback directly.
 */

import { WRITER_LOCK_NAME } from './drive/client'

const TABS_CHANNEL_NAME = 'memlore-web-tabs'
const LEADER_LOCK_NAME = 'memlore-web-leader'
const DRAFT_LOCK_PREFIX = 'memlore-draft:'

export type TabMessage =
  | { type: 'lock' }
  | { type: 'activity' }
  | { type: 'draft-saved'; entryId: string }
  | { type: 'pulled' }
  | { type: 'pushed' }
  | { type: 'auto-lock' }

export type TabMessageType = TabMessage['type']
type MessageOf<T extends TabMessageType> = Extract<TabMessage, { type: T }>

/** Entry ids and prefixed draft keys (`j-…`, `d-…`): no dots, slashes or other characters. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

interface MessageEventLike {
  data: unknown
}
interface ChannelLike {
  postMessage(data: unknown): void
  addEventListener(type: 'message', listener: (ev: MessageEventLike) => void): void
}
/** The 3-argument `LockManager.request`: the signal withdraws a request still queued. */
export interface LeaderLocksLike {
  request(
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>
}
/** The 2-argument `LockManager.request`: resolves with the callback's result once it settles. */
export interface DraftLocksLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}
interface Target {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** Injectable environment. Defaults resolve lazily so importing has no side effects. */
export interface TabsEnv {
  createChannel: (name: string) => ChannelLike | null
  locks: LeaderLocksLike | null
  draftLocks: DraftLocksLike | null
  window: Target | null
}

function defaultEnv(): TabsEnv {
  return {
    createChannel: (name) =>
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name),
    locks: (globalThis.navigator as { locks?: LeaderLocksLike } | undefined)?.locks ?? null,
    draftLocks: (globalThis.navigator as { locks?: DraftLocksLike } | undefined)?.locks ?? null,
    window: typeof window === 'undefined' ? null : (window as unknown as Target),
  }
}

let injected: Partial<TabsEnv> = {}
const resolveEnv = (): TabsEnv => ({ ...defaultEnv(), ...injected })

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureTabsEnv(partial: Partial<TabsEnv>): void {
  injected = partial
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** A fresh, whitelisted copy of `data`, or null when it is not exactly one known message. */
function parseTabMessage(data: unknown): TabMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  const keys = Object.keys(record)
  switch (record.type) {
    case 'lock':
    case 'activity':
    case 'pulled':
    case 'pushed':
    case 'auto-lock':
      return keys.length === 1 ? { type: record.type } : null
    case 'draft-saved': {
      const { entryId } = record
      if (keys.length !== 2 || typeof entryId !== 'string' || !SAFE_ID.test(entryId)) return null
      return { type: 'draft-saved', entryId }
    }
    default:
      return null
  }
}

const handlers = new Map<TabMessageType, Set<(msg: TabMessage) => void>>()
let channel: ChannelLike | null = null
let channelOpened = false

function getChannel(): ChannelLike | null {
  if (channelOpened) return channel
  channelOpened = true
  channel = resolveEnv().createChannel(TABS_CHANNEL_NAME)
  channel?.addEventListener('message', (ev) => {
    const msg = parseTabMessage(ev.data)
    if (!msg) return
    for (const handler of [...(handlers.get(msg.type) ?? [])]) {
      try {
        handler(msg)
      } catch (err) {
        console.error('[tabs] message handler threw', err)
      }
    }
  })
  return channel
}

/**
 * Sends `msg` to the other tabs (never to this one). Only the whitelisted fields are copied, so a
 * wider object never leaks content; a message that is still invalid is dropped. Never throws (a
 * closed channel's `InvalidStateError` is logged), so a caller's next step always runs.
 */
export function postTabMessage(msg: TabMessage): void {
  const clean = parseTabMessage(
    msg.type === 'draft-saved' ? { type: msg.type, entryId: msg.entryId } : { type: msg.type },
  )
  if (!clean) return
  try {
    getChannel()?.postMessage(clean)
  } catch (err) {
    console.warn('[tabs] message not posted to the other tabs', err)
  }
}

/** Calls `handler` for each valid `type` message from another tab. Returns the unsubscribe. */
export function onTabMessage<T extends TabMessageType>(
  type: T,
  handler: (msg: MessageOf<T>) => void,
): () => void {
  getChannel()
  const set = handlers.get(type) ?? new Set()
  handlers.set(type, set)
  const wrapped = handler as (msg: TabMessage) => void
  set.add(wrapped)
  return () => {
    set.delete(wrapped)
  }
}

// ---------------------------------------------------------------------------------------------
// Entry draft lock
// ---------------------------------------------------------------------------------------------

/** Runs `fn` holding the `memlore-draft:<entryId>` Web Lock (directly when there is none). */
export function withDraftLock<T>(entryId: string, fn: () => Promise<T>): Promise<T> {
  const locks = resolveEnv().draftLocks
  return locks ? locks.request(DRAFT_LOCK_PREFIX + entryId, fn) : fn()
}

/**
 * Runs `fn` holding the Drive single-writer Web Lock (`WRITER_LOCK_NAME`, the lock every upload
 * batch holds), so `fn` never interleaves with an upload's freshness check and its put. Without
 * a lock manager it runs directly: no upload can start then (`DriveWriter` fails closed).
 */
export function withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = resolveEnv().draftLocks
  return locks ? locks.request(WRITER_LOCK_NAME, fn) : fn()
}

// ---------------------------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------------------------

interface Election {
  controller: AbortController
  release: (() => void) | null
  removePageHide: () => void
}

let election: Election | null = null
let leader = false
const leaderHooks = new Set<(leader: boolean) => void>()

function setLeader(next: boolean): void {
  if (leader === next) return
  leader = next
  for (const cb of [...leaderHooks]) {
    try {
      cb(next)
    } catch (err) {
      console.error('[tabs] leader hook threw', err)
    }
  }
}

export const isLeader = (): boolean => leader

/** Called with the new state each time this tab gains or loses leadership. */
export function onLeaderChange(cb: (leader: boolean) => void): () => void {
  leaderHooks.add(cb)
  return () => {
    leaderHooks.delete(cb)
  }
}

/** On unlock: queue for the leader lock. A no-op while already running or without Web Locks. */
export function startLeaderElection(): void {
  if (election) return
  const e = resolveEnv()
  if (!e.locks) return
  const win = e.window
  const onPageHide = (): void => stopLeaderElection()
  win?.addEventListener('pagehide', onPageHide)
  const state: Election = {
    controller: new AbortController(),
    release: null,
    removePageHide: () => win?.removeEventListener('pagehide', onPageHide),
  }
  election = state
  e.locks
    .request(LEADER_LOCK_NAME, { signal: state.controller.signal }, () => {
      // Stopped between the grant being queued and running: pass the lock on.
      if (election !== state) return Promise.resolve()
      setLeader(true)
      return new Promise<void>((resolve) => {
        state.release = resolve
      })
    })
    .catch(() => {
      // AbortError: stopped while still queued.
    })
}

/** On lock and `pagehide`: release the leader lock, or withdraw the queued request. */
export function stopLeaderElection(): void {
  const state = election
  if (!state) return
  election = null
  state.removePageHide()
  state.controller.abort()
  state.release?.()
  setLeader(false)
}
