import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/core', () => ({ loadCore: vi.fn() }))

import {
  LOCK_EPOCH_KEY,
  VaultLockedError,
  configureKeysEnv,
  dispose,
  getAutoLockMinutes,
  getKeyRing,
  getLockDeadline,
  isUnlocked,
  limitIdleDeadline,
  lock,
  onLockDeadline,
  onLock,
  setAutoLockMinutes,
  setKeyRing,
  touch,
  type KeyRing,
} from './keys'
import { configureTabsEnv } from './tabs'

const MIN = 60 * 1000

/** This tab's BroadcastChannel (tabs.ts opens it once per module): what it posts, what it hears. */
const posted: unknown[] = []
const tabListeners = new Set<(ev: { data: unknown }) => void>()
configureTabsEnv({
  createChannel: () => ({
    postMessage: (data) => posted.push(data),
    addEventListener: (_type, listener) => tabListeners.add(listener),
  }),
  locks: null,
  window: null,
})
function fromOtherTab(data: unknown) {
  for (const l of [...tabListeners]) l({ data })
}
const epochStore = new Map<string, string>()

function fakeRing(lockImpl?: () => void) {
  const ring = { lock: vi.fn(lockImpl ?? (() => undefined)), isLocked: vi.fn(() => false) }
  return { ring, asRing: ring as unknown as KeyRing }
}

class FakeTarget {
  listeners = new Map<string, Set<() => void>>()
  visibilityState = 'visible'
  addEventListener(t: string, l: () => void) {
    const s = this.listeners.get(t) ?? new Set()
    s.add(l)
    this.listeners.set(t, s)
  }
  removeEventListener(t: string, l: () => void) {
    this.listeners.get(t)?.delete(l)
  }
  fire(t: string) {
    for (const l of [...(this.listeners.get(t) ?? [])]) l()
  }
  count() {
    let n = 0
    for (const s of this.listeners.values()) n += s.size
    return n
  }
}

let win: FakeTarget
let doc: FakeTarget
let emit: ReturnType<typeof vi.fn<(event: string, payload?: unknown) => void>>
let clock: number

function hide() {
  doc.visibilityState = 'hidden'
  doc.fire('visibilitychange')
}
function show() {
  doc.visibilityState = 'visible'
  doc.fire('visibilitychange')
}
function advance(ms: number) {
  clock += ms
  vi.advanceTimersByTime(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000_000
  win = new FakeTarget()
  doc = new FakeTarget()
  emit = vi.fn<(event: string, payload?: unknown) => void>()
  posted.length = 0
  epochStore.clear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  configureKeysEnv({
    now: () => clock,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    emit,
    document: doc,
    window: win,
    localStorage: () => ({
      getItem: (k) => epochStore.get(k) ?? null,
      setItem: (k, v) => void epochStore.set(k, v),
    }),
  })
})

afterEach(() => {
  dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('keys', () => {
  it('getKeyRing throws VaultLockedError before any setKeyRing', () => {
    expect(isUnlocked()).toBe(false)
    expect(() => getKeyRing()).toThrow(VaultLockedError)
  })

  it('lock() zeroizes once, drops the handle, is idempotent, emits once', () => {
    const { ring, asRing } = fakeRing()
    setKeyRing(asRing)
    expect(getKeyRing()).toBe(asRing)
    lock('manual')
    lock('manual')
    expect(ring.lock).toHaveBeenCalledTimes(1)
    expect(() => getKeyRing()).toThrow(VaultLockedError)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('app:locked')
  })

  it('lock() with no ring does nothing', () => {
    lock('manual')
    expect(emit).not.toHaveBeenCalled()
  })

  it('still drops the handle and runs hooks when ring.lock() throws', () => {
    const { asRing } = fakeRing(() => {
      throw new Error('wasm trap')
    })
    const hook = vi.fn()
    onLock(hook)
    setKeyRing(asRing)
    expect(() => lock('format')).not.toThrow()
    expect(isUnlocked()).toBe(false)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('a throwing hook does not stop the others, ring is zeroized first, event once', () => {
    const { ring, asRing } = fakeRing()
    const order: string[] = []
    ring.lock.mockImplementation(() => order.push('ring'))
    onLock(() => {
      order.push('bad')
      throw new Error('boom')
    })
    onLock(() => order.push('good'))
    emit.mockImplementation(() => order.push('emit'))
    setKeyRing(asRing)
    lock('revoked')
    expect(order).toEqual(['ring', 'bad', 'good', 'emit'])
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('onLock returns an unsubscribe', () => {
    const hook = vi.fn()
    const off = onLock(hook)
    off()
    setKeyRing(fakeRing().asRing)
    lock('manual')
    expect(hook).not.toHaveBeenCalled()
  })

  it('replacing a ring locks the old one without emitting', () => {
    const a = fakeRing()
    const b = fakeRing()
    setKeyRing(a.asRing)
    setKeyRing(b.asRing)
    expect(a.ring.lock).toHaveBeenCalledTimes(1)
    expect(b.ring.lock).not.toHaveBeenCalled()
    expect(getKeyRing()).toBe(b.asRing)
    expect(emit).not.toHaveBeenCalled()
  })

  describe('idle', () => {
    it('locks after 15 min and activity resets the timer', () => {
      const { ring, asRing } = fakeRing()
      setKeyRing(asRing)
      advance(14 * MIN)
      win.fire('keydown')
      advance(14 * MIN)
      expect(isUnlocked()).toBe(true)
      advance(1 * MIN)
      expect(isUnlocked()).toBe(false)
      expect(ring.lock).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledTimes(1)
    })

    it('reports each new idle deadline until unsubscribed', () => {
      const deadlines: number[] = []
      const off = onLockDeadline((d) => deadlines.push(d))
      setKeyRing(fakeRing().asRing)
      expect(deadlines).toEqual([clock + 15 * MIN])
      advance(2 * MIN)
      win.fire('keydown')
      setAutoLockMinutes(5)
      expect(deadlines.slice(1)).toEqual([clock + 15 * MIN, clock + 5 * MIN])
      off()
      touch()
      expect(deadlines).toHaveLength(3)
    })

    it('limitIdleDeadline only brings the deadline forward, and the timer fires then', () => {
      setKeyRing(fakeRing().asRing)
      limitIdleDeadline(clock + 99 * MIN)
      expect(getLockDeadline()).toBe(clock + 15 * MIN)
      limitIdleDeadline(clock + 2 * MIN)
      expect(getLockDeadline()).toBe(clock + 2 * MIN)
      advance(2 * MIN)
      expect(isUnlocked()).toBe(false)
    })

    it('the lock deadline stays the hidden one while hidden, even when the idle timer restarts', () => {
      setKeyRing(fakeRing().asRing)
      hide()
      setAutoLockMinutes(30)
      expect(getLockDeadline()).toBe(clock + 5 * MIN)
    })

    it('a hidden tab reports the earlier hidden deadline; showing it restores the idle one', () => {
      const deadlines: number[] = []
      onLockDeadline((d) => deadlines.push(d))
      setKeyRing(fakeRing().asRing)
      hide()
      expect(deadlines.at(-1)).toBe(clock + 5 * MIN)
      advance(1 * MIN)
      show()
      expect(deadlines.at(-1)).toBe(clock + 15 * MIN)
    })

    it('ignores activity bursts inside the throttle window', () => {
      setKeyRing(fakeRing().asRing)
      advance(10 * MIN)
      win.fire('pointerdown')
      advance(500)
      win.fire('pointerdown') // throttled: timer still anchored at the first reset
      advance(15 * MIN - 500)
      expect(isUnlocked()).toBe(false)
    })

    it('touch() resets the timer', () => {
      setKeyRing(fakeRing().asRing)
      advance(10 * MIN)
      touch()
      advance(14 * MIN)
      expect(isUnlocked()).toBe(true)
      advance(1 * MIN)
      expect(isUnlocked()).toBe(false)
    })

    it('honours custom minutes', () => {
      setAutoLockMinutes(5)
      setKeyRing(fakeRing().asRing)
      advance(4 * MIN)
      expect(isUnlocked()).toBe(true)
      advance(1 * MIN)
      expect(isUnlocked()).toBe(false)
    })

    it('clamps to [1, 24*60]', () => {
      setAutoLockMinutes(0.2)
      expect(getAutoLockMinutes()).toBe(1)
      setAutoLockMinutes(99999)
      expect(getAutoLockMinutes()).toBe(24 * 60)
    })

    it.each([0, NaN, -5, null, Infinity, 'never' as unknown as number])(
      'falls back to the default for %s',
      (v) => {
        setAutoLockMinutes(5)
        setAutoLockMinutes(v)
        expect(getAutoLockMinutes()).toBe(15)
      },
    )

    it('changing minutes while unlocked reschedules', () => {
      setKeyRing(fakeRing().asRing)
      setAutoLockMinutes(2)
      advance(2 * MIN)
      expect(isUnlocked()).toBe(false)
    })
  })

  describe('hidden tab', () => {
    it('locks when hidden for 5 min (timer fires)', () => {
      setKeyRing(fakeRing().asRing)
      hide()
      advance(5 * MIN)
      expect(isUnlocked()).toBe(false)
      expect(emit).toHaveBeenCalledTimes(1)
    })

    it('starts the hidden timer for a ring installed while the tab is already hidden', () => {
      doc.visibilityState = 'hidden'
      setKeyRing(fakeRing().asRing)
      advance(5 * MIN)
      expect(isUnlocked()).toBe(false)
      expect(emit).toHaveBeenCalledTimes(1)
    })

    it('does not lock when visible again within 5 min', () => {
      setKeyRing(fakeRing().asRing)
      hide()
      advance(4 * MIN)
      show()
      advance(3 * MIN)
      expect(isUnlocked()).toBe(true)
    })

    it('locks immediately on return after a clock jump without the timer firing', () => {
      setKeyRing(fakeRing().asRing)
      hide()
      clock += 6 * MIN // throttled background timer never ran
      show()
      expect(isUnlocked()).toBe(false)
      expect(emit).toHaveBeenCalledTimes(1)
    })
  })

  describe('across tabs', () => {
    it.each([
      ['manual', () => lock('manual'), true],
      ['idle', () => advance(15 * MIN), true],
      ['hidden', () => (hide(), advance(5 * MIN)), false],
      ['revoked', () => lock('revoked'), false],
      ['format', () => lock('format'), false],
    ] as const)(
      'a %s lock reaches the other tabs only when explicit or idle',
      (_reason, lockNow, crosses) => {
        setKeyRing(fakeRing().asRing)
        lockNow()
        expect(isUnlocked()).toBe(false)
        expect(posted).toEqual(crosses ? [{ type: 'lock' }] : [])
        expect(epochStore.get(LOCK_EPOCH_KEY)).toBe(crosses ? '1' : undefined)
      },
    )

    it('a {lock} from another tab locks this one, runs the lock hooks, and posts nothing back', () => {
      const clearSession = vi.fn()
      onLock(clearSession)
      setKeyRing(fakeRing().asRing)
      fromOtherTab({ type: 'lock' })
      expect(isUnlocked()).toBe(false)
      expect(clearSession).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledWith('app:locked')
      expect(posted).toEqual([])
      expect(epochStore.has(LOCK_EPOCH_KEY)).toBe(false)
    })

    it.each([
      ['pageshow', () => win.fire('pageshow')],
      ['storage', () => win.fire('storage')],
      ['visibilitychange', () => (hide(), show())],
    ] as const)('a missed {lock} is caught by the lock epoch on %s', (_event, fire) => {
      epochStore.set(LOCK_EPOCH_KEY, '3')
      const clearSession = vi.fn()
      onLock(clearSession)
      setKeyRing(fakeRing().asRing)
      fire()
      expect(isUnlocked()).toBe(true)
      epochStore.set(LOCK_EPOCH_KEY, 'garbage')
      fire()
      expect(isUnlocked()).toBe(true)
      epochStore.set(LOCK_EPOCH_KEY, '4') // another tab locked while this one slept
      fire()
      expect(isUnlocked()).toBe(false)
      expect(clearSession).toHaveBeenCalledTimes(1)
      expect(posted).toEqual([])
    })

    it('activity in any tab extends the idle deadline; local activity is posted at most every 30 s', () => {
      setKeyRing(fakeRing().asRing)
      win.fire('keydown')
      advance(1000)
      win.fire('keydown')
      expect(posted).toEqual([{ type: 'activity' }])
      advance(14 * MIN)
      expect(posted).toHaveLength(2) // the trailing post for the keydown inside the window
      fromOtherTab({ type: 'activity' })
      expect(posted).toHaveLength(2) // a received activity is not posted again
      advance(14 * MIN)
      expect(isUnlocked()).toBe(true)
      advance(1 * MIN)
      expect(isUnlocked()).toBe(false)
    })

    it('with a 1-minute auto-lock, another tab never idle-locks before this still-active one', () => {
      setAutoLockMinutes(1)
      setKeyRing(fakeRing().asRing)
      // Tab B restarts its idle timer each time it hears an activity post from this tab.
      const postTimes: number[] = []
      const record = () => {
        const n = posted.filter((m) => (m as { type: string }).type === 'activity').length
        while (postTimes.length < n) postTimes.push(clock)
      }
      for (let s = 0; s < 90; s++) {
        win.fire('keydown')
        record()
        advance(1000)
        record()
      }
      const lastActivityAt = clock - 1000
      while (isUnlocked()) {
        advance(1000)
        record()
      }
      expect(clock).toBe(lastActivityAt + MIN) // this tab's own idle lock
      expect(postTimes.at(-1)! + MIN).toBeGreaterThanOrEqual(clock) // tab B's idle deadline
    })
  })

  it('removes all watchers and timers on lock', () => {
    setKeyRing(fakeRing().asRing)
    hide()
    expect(win.count()).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(2)
    lock('manual')
    expect(win.count()).toBe(0)
    expect(doc.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not leak listeners when the ring is replaced', () => {
    setKeyRing(fakeRing().asRing)
    const n = win.count() + doc.count()
    setKeyRing(fakeRing().asRing)
    expect(win.count() + doc.count()).toBe(n)
    expect(vi.getTimerCount()).toBe(1)
  })
})
