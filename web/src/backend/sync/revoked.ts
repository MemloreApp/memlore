// Persisted "this browser was removed from the vault" flag. Kept in IndexedDB meta (it survives
// `clearCache()`), so a reload after a revoke never loops on the password screen. Imports only the
// storage layer: pull.ts and onboard.ts both use it, and neither may be imported back.

import { DEVICE_REVOKED_KEY, type WebDb } from '../storage/idb'

export { DEVICE_REVOKED_KEY }

/** Backend event fired when this browser is found removed from the vault. */
export const DEVICE_REMOVED_EVENT = 'web:device-removed'

/** Why the browser was removed. The in-memory `'not-enrolled'` is never persisted. */
export type PersistedRevokeReason = 'generation-changed' | 'fingerprint-changed' | 'slot-missing'

const REASONS: ReadonlySet<string> = new Set<PersistedRevokeReason>([
  'generation-changed',
  'fingerprint-changed',
  'slot-missing',
])

export function markRevoked(db: WebDb, reason: PersistedRevokeReason): Promise<void> {
  return db.meta.put({ key: DEVICE_REVOKED_KEY, value: reason })
}

export function clearRevoked(db: WebDb): Promise<void> {
  return db.meta.delete(DEVICE_REVOKED_KEY)
}

/**
 * The stored reason, or null. A value outside the known set reads null. Without a device record
 * the flag is stray (nothing left to unlock), so it reads null and is deleted, best effort.
 */
export async function readRevoked(db: WebDb): Promise<PersistedRevokeReason | null> {
  const value = (await db.meta.get(DEVICE_REVOKED_KEY))?.value
  if (value === undefined) return null
  if ((await db.device.get()) === undefined) {
    await clearRevoked(db).catch(() => undefined)
    return null
  }
  return typeof value === 'string' && REASONS.has(value) ? (value as PersistedRevokeReason) : null
}
