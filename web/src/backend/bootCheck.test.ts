import { describe, expect, it } from 'vitest'
import type { BrowserFeature } from '../../../src/components/auth/UnsupportedBrowserScreen'
import { checkBrowserCapabilities, type BootEnv } from './bootCheck'

type IdbMode = 'ok' | 'reject' | 'hang'

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
    queueMicrotask(() => (mode === 'ok' ? req.onsuccess?.({}) : req.onerror?.({})))
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
      settle(req)
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
