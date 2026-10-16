import { beforeEach, describe, expect, it, vi } from 'vitest'

type Tabs = typeof import('./tabs')
type Listener = (ev: { data: unknown }) => void

/** BroadcastChannel hub: like the real one, a post never reaches the posting instance. */
class FakeHub {
  readonly channels = new Set<FakeChannel>()
  readonly wire: unknown[] = []
  open(name: string): FakeChannel {
    const ch = new FakeChannel(this, name)
    this.channels.add(ch)
    return ch
  }
}

class FakeChannel {
  readonly listeners = new Set<Listener>()
  readonly hub: FakeHub
  readonly name: string
  constructor(hub: FakeHub, name: string) {
    this.hub = hub
    this.name = name
  }
  postMessage(data: unknown): void {
    this.hub.wire.push(data)
    for (const ch of this.hub.channels) {
      if (ch !== this && ch.name === this.name) ch.deliver(structuredClone(data))
    }
  }
  deliver(data: unknown): void {
    for (const l of [...this.listeners]) l({ data })
  }
  addEventListener(type: string, l: Listener): void {
    if (type === 'message') this.listeners.add(l)
  }
  removeEventListener(type: string, l: Listener): void {
    if (type === 'message') this.listeners.delete(l)
  }
  close(): void {
    this.hub.channels.delete(this)
  }
}

interface LockOptions {
  signal?: AbortSignal
  ifAvailable?: boolean
}
interface Waiter {
  options: LockOptions
  grant: () => void
}

/** Web Locks: exclusive, FIFO queue, `signal` withdraws only while queued, `ifAvailable` honoured. */
class FakeLocks {
  readonly held = new Set<string>()
  readonly queues = new Map<string, Waiter[]>()
  readonly calls: LockOptions[] = []

  request(name: string, options: LockOptions, cb: (lock: unknown) => Promise<void>): Promise<void> {
    this.calls.push(options)
    return new Promise<void>((resolve, reject) => {
      const run = (): void => {
        this.held.add(name)
        Promise.resolve()
          .then(() => cb({ name }))
          .finally(() => {
            this.held.delete(name)
            this.queues.get(name)?.shift()?.grant()
          })
          .then(resolve, reject)
      }
      if (!this.held.has(name)) return run()
      if (options.ifAvailable) {
        cb(null).then(resolve, reject)
        return
      }
      const queue = this.queues.get(name) ?? []
      this.queues.set(name, queue)
      const waiter: Waiter = { options, grant: run }
      queue.push(waiter)
      options.signal?.addEventListener('abort', () => {
        const i = queue.indexOf(waiter)
        if (i === -1) return
        queue.splice(i, 1)
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  }

  pending(name: string): number {
    return this.queues.get(name)?.length ?? 0
  }
}

class FakeWindow {
  readonly listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, l: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(l)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, l: () => void): void {
    this.listeners.get(type)?.delete(l)
  }
  fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l()
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let hub: FakeHub
let locks: FakeLocks

/** A fresh module instance = one browser tab sharing the hub and lock manager. */
async function openTab(): Promise<{ tabs: Tabs; win: FakeWindow }> {
  vi.resetModules()
  const tabs = await import('./tabs')
  const win = new FakeWindow()
  tabs.configureTabsEnv({
    createChannel: (name) => hub.open(name),
    locks,
    window: win,
  })
  return { tabs, win }
}

beforeEach(() => {
  hub = new FakeHub()
  locks = new FakeLocks()
})

describe('tab messages', () => {
  it('ignores malformed or hostile messages and delivers valid ones', async () => {
    const { tabs } = await openTab()
    const got: unknown[] = []
    tabs.onTabMessage('lock', (m) => got.push(m))
    tabs.onTabMessage('activity', (m) => got.push(m))
    tabs.onTabMessage('pulled', (m) => got.push(m))
    tabs.onTabMessage('draft-saved', (m) => got.push(m))
    tabs.onTabMessage('auto-lock', (m) => got.push(m))
    const sender = hub.open('memlore-web-tabs')

    const hostile: unknown[] = [
      null,
      undefined,
      'lock',
      42,
      ['lock'],
      {},
      { type: 'unlock' },
      { type: 'LOCK' },
      { type: 'lock', key: 'secret' },
      { type: 'activity', content: 'diary text' },
      { type: 'pulled', at: 1 },
      { type: 'auto-lock', minutes: 5 },
      { type: 'draft-saved' },
      { type: 'draft-saved', entryId: 7 },
      { type: 'draft-saved', entryId: '' },
      { type: 'draft-saved', entryId: 'a'.repeat(129) },
      { type: 'draft-saved', entryId: '../etc/passwd' },
      { type: 'draft-saved', entryId: 'e1', sealed: [1, 2, 3] },
    ]
    for (const data of hostile) sender.postMessage(data)
    expect(got).toEqual([])

    const valid = [
      { type: 'lock' },
      { type: 'activity' },
      { type: 'pulled' },
      { type: 'draft-saved', entryId: 'j-0b5c7c1e-2f9a-4d1e-9a8b-1c2d3e4f5a6b' },
      { type: 'auto-lock' },
    ]
    for (const data of valid) sender.postMessage(data)
    expect(got).toEqual(valid)
  })

  it('puts only the whitelisted id fields on the wire', async () => {
    const { tabs } = await openTab()
    const wider = { type: 'draft-saved', entryId: 'e1', sealed: new Uint8Array([9]), key: 'k' }
    tabs.postTabMessage(wider as unknown as Parameters<Tabs['postTabMessage']>[0])
    tabs.postTabMessage({ type: 'draft-saved', entryId: '../x' })
    expect(hub.wire).toEqual([{ type: 'draft-saved', entryId: 'e1' }])
  })

  it('never throws when the channel is closed (the caller still runs its next step)', async () => {
    const { tabs } = await openTab()
    tabs.configureTabsEnv({
      createChannel: () => ({
        postMessage: () => {
          throw new DOMException('channel is closed', 'InvalidStateError')
        },
        addEventListener: () => undefined,
      }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => tabs.postTabMessage({ type: 'draft-saved', entryId: 'e1' })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('leader election', () => {
  it.each(['stopLeaderElection', 'pagehide'] as const)(
    'hands leadership to the queued tab when the leader releases (%s)',
    async (how) => {
      const a = await openTab()
      const b = await openTab()
      a.tabs.startLeaderElection()
      await flush()
      b.tabs.startLeaderElection()
      await flush()
      expect(a.tabs.isLeader()).toBe(true)
      expect(b.tabs.isLeader()).toBe(false)

      const changes: boolean[] = []
      b.tabs.onLeaderChange((leader) => changes.push(leader))
      if (how === 'pagehide') a.win.fire('pagehide')
      else a.tabs.stopLeaderElection()
      await flush()

      expect(a.tabs.isLeader()).toBe(false)
      expect(b.tabs.isLeader()).toBe(true)
      expect(changes).toEqual([true])
    },
  )

  it("keeps a follower's request queued, and withdraws it when the follower stops", async () => {
    const a = await openTab()
    const b = await openTab()
    const c = await openTab()
    a.tabs.startLeaderElection()
    await flush()
    b.tabs.startLeaderElection()
    c.tabs.startLeaderElection()
    await flush()

    expect(locks.calls.every((o) => o.ifAvailable !== true)).toBe(true)
    expect(locks.pending('memlore-web-leader')).toBe(2)
    expect(b.tabs.isLeader()).toBe(false)

    // B locks while queued: it must never lead afterwards; C takes over.
    b.tabs.stopLeaderElection()
    await flush()
    expect(locks.pending('memlore-web-leader')).toBe(1)
    a.tabs.stopLeaderElection()
    await flush()
    expect(b.tabs.isLeader()).toBe(false)
    expect(c.tabs.isLeader()).toBe(true)
  })
})
