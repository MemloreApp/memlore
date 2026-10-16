/**
 * Unlock error sentinels the web backend (`web/src/backend/commands/auth.ts`) throws and the lock
 * screen translates. The desktop backend never returns these strings, so its errors are unaffected.
 */

/** This browser was removed from the vault: the UI routes to the removed screen, never a retry. */
export const WEB_DEVICE_REMOVED = 'WEB_DEVICE_REMOVED'
export const WEB_STORAGE_UNAVAILABLE = 'WEB_STORAGE_UNAVAILABLE'
export const WEB_STORAGE_FULL = 'WEB_STORAGE_FULL'
/** A recovery holds the vault lease on another device. */
export const WEB_RECOVERY_LEASE = 'WEB_RECOVERY_LEASE'
/** Wrong-password backoff: sent as `WEB_UNLOCK_BLOCKED:<seconds>`. */
export const WEB_UNLOCK_BLOCKED = 'WEB_UNLOCK_BLOCKED'

export const unlockBlockedError = (seconds: number): string => `${WEB_UNLOCK_BLOCKED}:${seconds}`

const BLOCKED_RE = new RegExp(`^${WEB_UNLOCK_BLOCKED}:(\\d+)$`)

/** The seconds left in a `WEB_UNLOCK_BLOCKED:<seconds>` error, or null for any other error. */
export function parseUnlockBlocked(error: string | undefined): number | null {
  const match = error === undefined ? null : BLOCKED_RE.exec(error)
  return match ? Number(match[1]) : null
}
