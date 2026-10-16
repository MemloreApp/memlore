import { describe, expect, it } from 'vitest'
import type { BrowserFeature } from '../../../src/components/auth/UnsupportedBrowserScreen'
import { checkBrowserCapabilities, type BootEnv } from './bootCheck'

type IdbMode = 'ok' | 'reject' | 'hang' | 'delete-blocked'

interface FakeRequest {
  result?: { close: () => void }
  onsuccess: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onblocked: ((ev: unknown) => void) | null
  onupgradeneeded: ((ev: unknown) => void) | null
}

function fakeRequest(): FakeRequest {
  return { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null }
}

function fakeIndexedDB(mode: IdbMode): IDBFactory {
  // A microtask, not a timer: the probe attaches its handlers synchronously, and every microtask
  // runs before its timeout can fire, so a busy machine never turns 'ok' into a timeout.
  const settle = (req: FakeRequest) => {
    if (mode === 'hang') return
    queueMicrotask(() => (mode === 'reject' ? req.onerror?.({}) : req.onsuccess?.({})))
  }
  const factory = {
    open: () => {
      const req = fakeRequest()
      req.result = { close: () => {} }
      settle(req)
      return req
    },
    deleteDatabase: () => {
      const req = fakeRequest()
      // Another tab holds the probe DB open: the delete reports `blocked` and never `success`.
      if (mode === 'delete-blocked') queueMicrotask(() => req.onblocked?.({}))
      else settle(req)
      return req
    },
  }
  return factory as unknown as IDBFactory
}

function fullEnv(): BootEnv {
  return {
    indexedDB: fakeIndexedDB('ok'),
    WebAssembly: { instantiate: () => {} },
    crypto: { subtle: {} },
    navigator: { locks: { request: () => {} } },
    BroadcastChannel: function BroadcastChannel() {},
  }
}

describe('checkBrowserCapabilities (fail closed)', () => {
  it.each<[string, (env: BootEnv) => BootEnv, BrowserFeature | null]>([
    ['all present', (env) => env, null],
    [
      'IndexedDB delete blocked by another tab',
      (env) => ({ ...env, indexedDB: fakeIndexedDB('delete-blocked') }),
      null,
    ],
    ['no navigator.locks', (env) => ({ ...env, navigator: {} }), 'web_locks'],
    [
      'IndexedDB open rejects',
      (env) => ({ ...env, indexedDB: fakeIndexedDB('reject') }),
      'indexeddb',
    ],
    ['IndexedDB open hangs', (env) => ({ ...env, indexedDB: fakeIndexedDB('hang') }), 'indexeddb'],
    ['no WebAssembly', (env) => ({ ...env, WebAssembly: undefined }), 'webassembly'],
    ['no crypto.subtle', (env) => ({ ...env, crypto: {} }), 'crypto_subtle'],
    [
      'no BroadcastChannel',
      (env) => ({ ...env, BroadcastChannel: undefined }),
      'broadcast_channel',
    ],
  ])('%s', async (_name, mutate, missingFeature) => {
    const result = await checkBrowserCapabilities(mutate(fullEnv()), { timeoutMs: 20 })
    if (missingFeature === null) {
      expect(result).toEqual({ supported: true, missing: [] })
    } else {
      expect(result).toEqual({ supported: false, missing: [missingFeature] })
    }
  })
})

describe('IndexedDB probe connection hygiene', () => {
  it('closes a probe connection that opens after the timeout', async () => {
    let closed = 0
    let lateSuccess: (() => void) | undefined
    const idb = {
      open: () => {
        const req = fakeRequest()
        req.result = { close: () => (closed += 1) }
        lateSuccess = () => req.onsuccess?.({})
        return req
      },
      deleteDatabase: () => fakeRequest(),
    } as unknown as IDBFactory

    const result = await checkBrowserCapabilities(
      { ...fullEnv(), indexedDB: idb },
      { timeoutMs: 5 },
    )
    expect(result).toEqual({ supported: false, missing: ['indexeddb'] })

    lateSuccess?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(1)
  })
})
