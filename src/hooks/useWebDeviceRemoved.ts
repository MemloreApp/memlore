import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  gdriveBeginConnect,
  gdriveCancelConnect,
  gdriveCompleteConnect,
  webDeviceRemovedStatus,
  webForgetBrowser,
  type WebDeviceRemovedStatus,
} from '../lib/tauri'
import { isWeb } from '../lib/platform'
import { useSettingsStore } from '../stores/settingsStore'
import { useSyncStore } from '../stores/syncStore'

/** Mirrors `DEVICE_REMOVED_EVENT` in `web/src/backend/sync/revoked.ts`. */
const DEVICE_REMOVED_EVENT = 'web:device-removed'

const NOT_REMOVED: WebDeviceRemovedStatus = { removed: false, reason: null, unsentDrafts: 0 }

/** Never throws: a failed probe reads as not removed. */
async function readStatus(): Promise<WebDeviceRemovedStatus> {
  try {
    return await webDeviceRemovedStatus()
  } catch (error) {
    console.warn('Failed to read the web device-removed status:', error)
    return NOT_REMOVED
  }
}

/**
 * Web only: whether this browser was removed from the vault (revoked or the
 * vault was rotated), and the actions the removed screen offers. Desktop
 * always reports not removed and never invokes the web-only commands.
 *
 * A failed probe fails safe to not removed: the backend still refuses unlock
 * while the flag is set, so the worst case is the LockScreen error message.
 */
export function useWebDeviceRemoved() {
  const [status, setStatus] = useState<WebDeviceRemovedStatus>(NOT_REMOVED)
  // Desktop never probes. On web App holds the LockScreen until this settles,
  // so a reload of a removed browser does not flash it first.
  const [initialProbeDone, setInitialProbeDone] = useState(!isWeb)
  // The session of the connect in flight, for `cancelConnect`.
  const pendingSessionRef = useRef<string | null>(null)

  const probe = useCallback(async () => {
    const next = await readStatus()
    setStatus(next)
    return next
  }, [])

  useEffect(() => {
    if (!isWeb) return
    let cancelled = false
    void readStatus().then((next) => {
      if (cancelled) return
      setStatus(next)
      setInitialProbeDone(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isWeb) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen(DEVICE_REMOVED_EVENT, () => {
      // Flip synchronously so App never flashes the LockScreen; the re-probe
      // then fills in the reason and the unsent count.
      setStatus((prev) => ({ ...prev, removed: true }))
      void probe()
    }).then(
      (fn) => {
        if (cancelled) fn()
        else unlisten = fn
      },
      (error: unknown) => console.warn(`Failed to listen for ${DEVICE_REMOVED_EVENT}:`, error),
    )
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [probe])

  // Must be called straight from the click handler: on web, begin opens the
  // OAuth popup and needs the user gesture, so it is the first await.
  const connectDrive = useCallback(async (): Promise<string> => {
    const begin = await gdriveBeginConnect()
    pendingSessionRef.current = begin.sessionId
    try {
      // The web backend ignores the password.
      const outcome = await gdriveCompleteConnect(begin.sessionId, '')
      if (outcome.outcome !== 'needs_onboarding') {
        throw new Error(`Unexpected Drive connect outcome: ${outcome.outcome}`)
      }
      return begin.sessionId
    } finally {
      pendingSessionRef.current = null
    }
  }, [])

  // Closes the popup; the awaiting `connectDrive` then rejects with
  // OAUTH_CANCELLED. Best-effort: never throws.
  const cancelConnect = useCallback(async () => {
    const sessionId = pendingSessionRef.current
    if (!sessionId) return
    try {
      await gdriveCancelConnect(sessionId)
    } catch (error) {
      console.warn('gdriveCancelConnect failed', error)
    }
  }, [])

  const completeReonboard = useCallback(async () => {
    // Re-probe first: unlocking while the flag is still set would drop the
    // user into a shell the backend refuses to serve.
    const next = await probe()
    if (next.removed) return
    useSettingsStore.getState().setLocked(false)
    void useSyncStore
      .getState()
      .syncNow()
      .catch(() => {})
  }, [probe])

  const forget = useCallback(async () => {
    await webForgetBrowser()
    window.location.reload()
  }, [])

  return {
    removed: status.removed,
    reason: status.reason,
    unsentDrafts: status.unsentDrafts,
    initialProbeDone,
    connectDrive,
    cancelConnect,
    completeReonboard,
    forget,
  }
}
