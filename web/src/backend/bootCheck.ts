/**
 * Boot-time browser capability probe (fail closed).
 *
 * `web/main.tsx` awaits this before rendering App. Each feature the web backend
 * cannot run without is probed; anything absent, throwing, or (for IndexedDB)
 * not answering within the timeout counts as missing, and the caller renders
 * `UnsupportedBrowserScreen` instead of App.
 *
 * IndexedDB presence is not enough: private browsing and blocked-storage
 * configs expose `indexedDB` but fail (or never answer) on `open`. So the probe
 * opens AND deletes a throwaway database.
 *
 * Pure and injectable: callers pass the globals in, so tests need no DOM.
 */

import type { BrowserFeature } from '../../../src/components/auth/UnsupportedBrowserScreen'

/** A hung `open`/`deleteDatabase` past this counts as missing. */
export const BOOT_PROBE_TIMEOUT_MS = 5_000
/** Never the real database (`memlore-web`). */
const PROBE_DB_NAME = 'memlore-boot-probe'

export interface BootEnv {
  indexedDB?: IDBFactory
  WebAssembly?: unknown
  crypto?: { subtle?: unknown }
  navigator?: { locks?: unknown }
  BroadcastChannel?: unknown
}

export interface BootCheckResult {
  supported: boolean
  missing: BrowserFeature[]
}

/** Resolves on the request's `success`, rejects on `error`. `blocked` just waits (the timeout bounds it). */
function settle(req: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

async function openAndDelete(idb: IDBFactory): Promise<void> {
  const open = idb.open(PROBE_DB_NAME)
  await settle(open)
  ;(open.result as IDBDatabase).close()
  await settle(idb.deleteDatabase(PROBE_DB_NAME))
}

async function probeIndexedDB(idb: IDBFactory | undefined, timeoutMs: number): Promise<boolean> {
  if (!idb || typeof idb.open !== 'function' || typeof idb.deleteDatabase !== 'function') {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IndexedDB probe timed out')), timeoutMs)
  })
  try {
    await Promise.race([openAndDelete(idb), timeout])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function present(check: () => boolean): boolean {
  try {
    return check()
  } catch {
    return false
  }
}

export async function checkBrowserCapabilities(
  env: BootEnv,
  opts: { timeoutMs?: number } = {},
): Promise<BootCheckResult> {
  const missing: BrowserFeature[] = []
  if (!(await probeIndexedDB(env.indexedDB, opts.timeoutMs ?? BOOT_PROBE_TIMEOUT_MS))) {
    missing.push('indexeddb')
  }
  const wasm = env.WebAssembly as { instantiate?: unknown } | undefined
  if (!present(() => typeof wasm === 'object' && typeof wasm?.instantiate === 'function')) {
    missing.push('webassembly')
  }
  if (!present(() => typeof env.crypto?.subtle === 'object' && env.crypto.subtle !== null)) {
    missing.push('crypto_subtle')
  }
  if (!present(() => typeof env.navigator?.locks === 'object' && env.navigator.locks !== null)) {
    missing.push('web_locks')
  }
  if (!present(() => typeof env.BroadcastChannel === 'function')) {
    missing.push('broadcast_channel')
  }
  return { supported: missing.length === 0, missing }
}
