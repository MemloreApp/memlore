import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { WRAPPED_MASTER_HEX_LEN, openWebDb, type DeviceRecord, type WebDb } from '../storage/idb'
import { DEVICE_REVOKED_KEY, clearRevoked, markRevoked, readRevoked } from './revoked'

const device: DeviceRecord = {
  deviceId: 'web-1234',
  wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
  kekSaltHex: 'cd'.repeat(16),
  recoveryGeneration: 1,
  masterFingerprint: 'fp-1',
  name: 'Memlore Web (Chrome)',
}

let db: WebDb

beforeEach(async () => {
  db = await openWebDb({ factory: new IDBFactory() })
  await db.device.put(device)
})

describe('revoked flag', () => {
  it('reads null when never marked', async () => {
    expect(await readRevoked(db)).toBeNull()
  })

  it.each(['generation-changed', 'fingerprint-changed', 'slot-missing'] as const)(
    'marks and reads %s',
    async (reason) => {
      await markRevoked(db, reason)
      expect(await readRevoked(db)).toBe(reason)
    },
  )

  it('clearRevoked removes the flag', async () => {
    await markRevoked(db, 'slot-missing')
    await clearRevoked(db)
    expect(await readRevoked(db)).toBeNull()
    expect(await db.meta.get(DEVICE_REVOKED_KEY)).toBeUndefined()
  })

  it.each([42, 'x', true, 'not-enrolled'])(
    'reads a bogus stored value %j as null',
    async (value) => {
      await db.meta.put({ key: DEVICE_REVOKED_KEY, value })
      expect(await readRevoked(db)).toBeNull()
    },
  )

  it('reads null and removes a stray flag when there is no device record', async () => {
    await markRevoked(db, 'generation-changed')
    await db.device.clear()
    expect(await readRevoked(db)).toBeNull()
    expect(await db.meta.get(DEVICE_REVOKED_KEY)).toBeUndefined()
  })

  it('removes a stray bogus flag when there is no device record', async () => {
    await db.meta.put({ key: DEVICE_REVOKED_KEY, value: 42 })
    await db.device.clear()
    expect(await readRevoked(db)).toBeNull()
    expect(await db.meta.get(DEVICE_REVOKED_KEY)).toBeUndefined()
  })
})
