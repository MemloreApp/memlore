import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, type Core } from '../../core/core'
import { fixtureBytes, loadDesktopFixture } from '../drive/fakeDrive'
import { VaultLockedError, dispose, getAutoLockMinutes, type KeyRing } from '../keys'
import { WEB_SETTING_PREFIX, openWebDb, type WebDb } from '../storage/idb'
import { configureTabsEnv } from '../tabs'
import {
  WEB_SETTING_KEYS,
  applyStoredAutoLock,
  configureWebSettingsEnv,
  deleteWebSetting,
  getWebSetting,
  isWebSetting,
  setWebSetting,
} from './webSettings'

const KEY = 'maptiler_api_key'
const SECRET = 'pk-SECRET-maptiler-0123'
const SEAL_MAGIC = 0x02

// tabs.ts opens its channel once per page: one fake for the whole file.
const tabListeners: Array<(ev: { data: unknown }) => void> = []
const posted: unknown[] = []
configureTabsEnv({
  createChannel: () => ({
    postMessage: (data: unknown) => void posted.push(data),
    addEventListener: (_type: 'message', listener: (ev: { data: unknown }) => void) =>
      void tabListeners.push(listener),
  }),
  locks: null,
  window: null,
})
const fromOtherTab = (data: unknown): void => {
  for (const listener of [...tabListeners]) listener({ data })
}

let factory: IDBFactory
let db: WebDb
let locked: boolean
let openFails: boolean

/** Reversible stand-in for the WASM envelope: a magic byte, then the bytes reversed. */
const fakeCore = {
  sealOutboxMedia: (_ring: unknown, plain: Uint8Array): Uint8Array =>
    Uint8Array.from([SEAL_MAGIC, ...[...plain].reverse()]),
  openMedia: (_ring: unknown, bytes: Uint8Array): Uint8Array => {
    if (openFails || bytes[0] !== SEAL_MAGIC) throw new Error('envelope: wrong key')
    return Uint8Array.from([...bytes.subarray(1)].reverse())
  },
}

function wire(): void {
  configureWebSettingsEnv({
    openDb: () => Promise.resolve(db),
    loadCore: () => Promise.resolve(fakeCore),
    getKeyRing: () => {
      if (locked) throw new VaultLockedError()
      return {} as never
    },
  })
}

beforeEach(async () => {
  factory = new IDBFactory()
  db = await openWebDb({ factory })
  locked = false
  openFails = false
  posted.length = 0
  wire()
})

afterEach(() => {
  configureWebSettingsEnv({})
  dispose()
})

describe('isWebSetting', () => {
  it('names exactly the persisted map and auto-lock settings', () => {
    expect([...WEB_SETTING_KEYS].sort()).toEqual([
      'map_tile_source',
      'maptiler_api_key',
      'web_auto_lock_minutes',
      'web_map_tiles_consent',
    ])
    expect(isWebSetting('map_tile_source')).toBe(true)
    expect(isWebSetting('theme')).toBe(false)
    expect(isWebSetting('__proto__')).toBe(false)
  })
})

describe('maptiler_api_key', () => {
  it('round-trips through the sealed envelope', async () => {
    await setWebSetting(KEY, SECRET)
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })

  it('never stores the plaintext key in IndexedDB', async () => {
    await setWebSetting(KEY, SECRET)
    const records = await db.meta.listByPrefix('')
    expect(records).toHaveLength(1)
    expect(records[0].key).toBe(`${WEB_SETTING_PREFIX}${KEY}`)
    expect(JSON.stringify(records)).not.toContain(SECRET)
    expect(JSON.stringify(records)).not.toContain('SECRET')
  })

  it('reads an unopenable ciphertext (key rotation, re-onboard) as absent', async () => {
    await setWebSetting(KEY, SECRET)
    openFails = true
    expect(await getWebSetting(KEY)).toBeNull()
  })

  it('reads a malformed stored value as absent', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${KEY}`, value: 'not hex !!' })
    expect(await getWebSetting(KEY)).toBeNull()
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${KEY}`, value: 42 })
    expect(await getWebSetting(KEY)).toBeNull()
  })

  it('reads an oversized stored hex as absent without opening it', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${KEY}`, value: '02'.repeat(2049) })
    expect(await getWebSetting(KEY)).toBeNull()
  })

  it('an empty key deletes it; delete removes it', async () => {
    await setWebSetting(KEY, SECRET)
    await setWebSetting(KEY, '')
    expect(await getWebSetting(KEY)).toBeNull()
    await setWebSetting(KEY, SECRET)
    await deleteWebSetting(KEY)
    expect(await getWebSetting(KEY)).toBeNull()
  })
})

describe('maptiler_api_key with the real core', () => {
  /** Read bound on the stored hex (`MAX_SEALED_HEX_LENGTH` in webSettings.ts). */
  const MAX_HEX = 4096
  /** Longest key in UTF-8 bytes: 4096 / 2 - 33 bytes of envelope. */
  const CAP = 2015
  const decode = (path: string): string => new TextDecoder().decode(fixtureBytes(fixture, path))
  let fixture: ReturnType<typeof loadDesktopFixture>
  let realCore: Core
  let ring: KeyRing

  const storedHex = async (): Promise<unknown> =>
    (await db.meta.get(`${WEB_SETTING_PREFIX}${KEY}`))?.value

  beforeAll(async () => {
    realCore = await loadCore()
    fixture = loadDesktopFixture()
    const meta = JSON.parse(decode('.meta/keyring/_meta.json')) as { master_fingerprint: string }
    const recovery = JSON.parse(decode('.meta/keyring/_recovery.json')) as {
      wrapped_master: string
    }
    ring = realCore.KeyRing.fromRecovery(
      fixture.recovery_phrase,
      recovery.wrapped_master,
      meta.master_fingerprint,
    )
    ring.loadContentList(decode('.meta/keyring/_content.json'))
  })

  beforeEach(() => {
    configureWebSettingsEnv({
      openDb: () => Promise.resolve(db),
      loadCore: () => Promise.resolve(realCore),
      getKeyRing: () => ring,
    })
  })

  // '€' is 3 UTF-8 bytes but 1 UTF-16 unit: 672 of them pass a 1024-unit check yet cannot read back.
  it.each([
    ['a real key', SECRET, true],
    ['ASCII at the byte cap', 'x'.repeat(CAP), true],
    ['non-ASCII at the byte cap', `${'€'.repeat(671)}xx`, true],
    ['non-ASCII one byte over the cap', '€'.repeat(672), false],
    ['ASCII one byte over the cap', 'x'.repeat(CAP + 1), false],
  ])('a key that stores reads back: %s', async (_name, key, stores) => {
    const bytes = new TextEncoder().encode(key).length
    expect(bytes <= CAP).toBe(stores)
    if (!stores) {
      await expect(setWebSetting(KEY, key)).rejects.toThrow(TypeError)
      expect(await db.meta.listByPrefix('')).toEqual([])
      return
    }
    await setWebSetting(KEY, key)
    const hex = await storedHex()
    expect(typeof hex === 'string' && hex.length <= MAX_HEX).toBe(true)
    if (bytes === CAP) expect(hex).toHaveLength(MAX_HEX)
    expect(await getWebSetting(KEY)).toBe(key)
  })

  it('seals and opens the key with the real core', async () => {
    await setWebSetting(KEY, SECRET)
    const hex = await storedHex()
    expect(typeof hex).toBe('string')
    expect(String(hex).startsWith('02')).toBe(true) // the media envelope version byte
    expect(String(hex)).not.toContain(Buffer.from(SECRET).toString('hex'))
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })
})

describe('consent and tile source', () => {
  it('persist across a simulated reload (a new connection to the same database)', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    await setWebSetting('map_tile_source', 'maptiler')
    await setWebSetting(KEY, SECRET)
    db.close()
    db = await openWebDb({ factory })
    wire()
    expect(await getWebSetting('web_map_tiles_consent')).toBe('1')
    expect(await getWebSetting('map_tile_source')).toBe('maptiler')
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })

  it('reads the tile source as unset unless consent is stored', async () => {
    await setWebSetting('map_tile_source', 'maptiler')
    expect(await getWebSetting('map_tile_source')).toBeNull()
    await setWebSetting('web_map_tiles_consent', '1')
    expect(await getWebSetting('map_tile_source')).toBe('maptiler')
  })

  it('revoking consent clears consent and the tile source but keeps the key', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    await setWebSetting('map_tile_source', 'maptiler')
    await setWebSetting(KEY, SECRET)
    await setWebSetting('web_map_tiles_consent', '0')
    expect(await getWebSetting('web_map_tiles_consent')).toBeNull()
    expect(await getWebSetting('map_tile_source')).toBeNull()
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })

  it('deleting consent revokes it the same way', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    await setWebSetting('map_tile_source', 'maptiler')
    await deleteWebSetting('web_map_tiles_consent')
    expect(await getWebSetting('map_tile_source')).toBeNull()
  })

  it('an empty tile source unsets it (clearMapTileSource)', async () => {
    await setWebSetting('map_tile_source', 'maptiler')
    await setWebSetting('map_tile_source', '')
    expect(await getWebSetting('map_tile_source')).toBeNull()
  })

  it('refuses values the web cannot honour', async () => {
    await expect(setWebSetting('web_map_tiles_consent', 'yes')).rejects.toThrow(TypeError)
    await expect(setWebSetting('map_tile_source', 'offline')).rejects.toThrow(TypeError)
    await expect(setWebSetting('map_tile_source', 'mapkit')).rejects.toThrow(TypeError)
    await expect(setWebSetting(KEY, 'x'.repeat(2016))).rejects.toThrow(TypeError)
    expect(await db.meta.listByPrefix('')).toEqual([])
  })

  it('reads an unexpected stored value as unset', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}map_tile_source`, value: 'offline' })
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}web_map_tiles_consent`, value: true })
    expect(await getWebSetting('map_tile_source')).toBeNull()
    expect(await getWebSetting('web_map_tiles_consent')).toBeNull()
  })
})

describe('web_auto_lock_minutes', () => {
  const AUTO = 'web_auto_lock_minutes'

  it('persists across a simulated reload and applies on write', async () => {
    await setWebSetting(AUTO, '5')
    expect(getAutoLockMinutes()).toBe(5)
    db = await openWebDb({ factory })
    wire()
    expect(await getWebSetting(AUTO)).toBe('5')
  })

  it('reads as unset until written', async () => {
    expect(await getWebSetting(AUTO)).toBeNull()
  })

  it('refuses values outside 1/5/15/30 (no "never" on the web)', async () => {
    for (const bad of ['0', '2', '60', 'x', '-5']) {
      await expect(setWebSetting(AUTO, bad)).rejects.toThrow(TypeError)
    }
    expect(await getWebSetting(AUTO)).toBeNull()
    expect(getAutoLockMinutes()).toBe(15)
  })

  it('an empty value or a delete drops back to the 15 min default', async () => {
    await setWebSetting(AUTO, '30')
    await setWebSetting(AUTO, '')
    expect(await getWebSetting(AUTO)).toBeNull()
    expect(getAutoLockMinutes()).toBe(15)
    await setWebSetting(AUTO, '1')
    await deleteWebSetting(AUTO)
    expect(await getWebSetting(AUTO)).toBeNull()
    expect(getAutoLockMinutes()).toBe(15)
  })

  it('reads an unexpected stored value as unset', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${AUTO}`, value: '0' })
    expect(await getWebSetting(AUTO)).toBeNull()
  })

  it('applyStoredAutoLock applies the stored value, or the default when none', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${AUTO}`, value: '30' })
    await applyStoredAutoLock()
    expect(getAutoLockMinutes()).toBe(30)
    await db.meta.delete(`${WEB_SETTING_PREFIX}${AUTO}`)
    await applyStoredAutoLock()
    expect(getAutoLockMinutes()).toBe(15)
  })

  it('an auto-lock tab message makes the other tab re-apply the stored minutes', async () => {
    await applyStoredAutoLock() // this tab unlocked
    await setWebSetting(AUTO, '5')
    await setWebSetting(AUTO, '')
    expect(posted).toEqual([{ type: 'auto-lock' }, { type: 'auto-lock' }])

    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${AUTO}`, value: '30' }) // the other tab's write
    fromOtherTab({ type: 'auto-lock' })
    await vi.waitFor(() => expect(getAutoLockMinutes()).toBe(30))

    // A locked tab ignores it and re-applies on its next unlock.
    locked = true
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${AUTO}`, value: '1' })
    fromOtherTab({ type: 'auto-lock' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getAutoLockMinutes()).toBe(30)
  })
})

describe('locked vault', () => {
  it('refuses reads, writes and deletes and touches nothing', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    locked = true
    for (const key of WEB_SETTING_KEYS) {
      await expect(getWebSetting(key)).rejects.toBeInstanceOf(VaultLockedError)
      await expect(setWebSetting(key, '1')).rejects.toBeInstanceOf(VaultLockedError)
      await expect(deleteWebSetting(key)).rejects.toBeInstanceOf(VaultLockedError)
    }
    locked = false
    expect(await getWebSetting('web_map_tiles_consent')).toBe('1')
  })
})
