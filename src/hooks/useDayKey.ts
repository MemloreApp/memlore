import { useSyncExternalStore } from 'react'
import { localDateKey } from '../lib/dashboardDates'

function getSnapshot(): string {
  return localDateKey(new Date())
}

function msUntilNextMidnight(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  // 1s slack so the timer never fires a hair before the day actually turns.
  return next.getTime() - now.getTime() + 1000
}

function subscribe(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      onChange()
      arm()
    }, msUntilNextMidnight())
  }
  // Timers pause through sleep, so re-check and re-arm when the page is shown again.
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return
    onChange()
    arm()
  }
  arm()
  document.addEventListener('visibilitychange', onVisibility)
  // A desktop window can stay "visible" across a lid-close, so focus re-checks too.
  window.addEventListener('focus', onVisibility)
  return () => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onVisibility)
  }
}

/**
 * Local `YYYY-MM-DD` for today. Changes at local midnight and when the page becomes
 * visible again or the window regains focus (sleep/wake); re-renders only when the key actually changes.
 */
export function useDayKey(): string {
  return useSyncExternalStore(subscribe, getSnapshot)
}
