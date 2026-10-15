import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteEntryForever as tauriDeleteEntryForever,
  emptyTrash as tauriEmptyTrash,
  listTrashedEntries,
  restoreEntry as tauriRestoreEntry,
  type LockedView,
} from '../lib/tauri'
import { emitMediaChanged } from '../lib/mediaEvents'
import type { Entry } from '../types/entry'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import { emitEntriesChanged } from './useEntries'
import { emitStreakRefresh } from './useStreaks'

/** Days an entry stays in Trash. Mirrors `TRASH_RETENTION_SECS` in
 * `src-tauri/src/commands/entries.rs`. */
export const TRASH_RETENTION_DAYS = 30

/** The most rows one web "Empty trash" queues. Mirrors `MAX_EMPTY_TRASH_ITEMS`
 * in `web/src/backend/commands/trash.ts`. */
// TODO(later): see docs/LATER.md - `MAX_EMPTY_TRASH_ITEMS` is mirrored in `trash.ts`
export const WEB_EMPTY_TRASH_LIMIT = 1000

const DAY_SECS = 86_400

/** Whole days since `trashedAt` (unix secs). Never negative: a peer device's
 * clock may be ahead of ours. */
export function trashAgeDays(trashedAt: number, nowSecs: number): number {
  return Math.max(0, Math.floor((nowSecs - trashedAt) / DAY_SECS))
}

/** Days until the retention sweep purges the entry, floored at 0 — the sweep
 * can lag on a device that was offline or clock-skewed. */
export function trashDaysLeft(trashedAt: number, nowSecs: number): number {
  return Math.max(0, TRASH_RETENTION_DAYS - trashAgeDays(trashedAt, nowSecs))
}

export type TrashRowStatus = { kind: 'pending' } | { kind: 'trash'; daysLeft: number }

/** What a Trash row shows: a web delete the desktop has not applied yet, or
 * a row in the desktop Trash with its days left. A row with no `trashed_at`
 * counts as trashed now. */
export function trashRowStatus(entry: Entry, nowSecs: number): TrashRowStatus {
  if (entry.trash_pending_desktop) return { kind: 'pending' }
  return { kind: 'trash', daysLeft: trashDaysLeft(entry.trashed_at ?? nowSecs, nowSecs) }
}

export interface UseTrashResult {
  entries: Entry[]
  isLoading: boolean
  error: string | null
  /** The lock view the list was fetched under; decides which actions a
   * locked row allows. */
  lockedView: LockedView
  refetch: () => Promise<void>
  /** Throws on failure. */
  restore: (id: string) => Promise<void>
  /** Throws on failure. A locked entry needs the `revealed` view. */
  deleteForever: (id: string) => Promise<void>
  /** Throws on failure. `ids`: the rows the user confirmed (the web queues
   * only those). Returns how many entries were purged (web: how many listed
   * rows were queued for the desktop; 0 while its pending list is full). */
  empty: (ids: readonly string[]) => Promise<number>
}

/** After any Trash mutation: the streak and day buckets shift, and media rows
 * come back (restore) or go away (purge). Streak first — see
 * `emitStreakRefresh`. Emitting `entries-changed` also refetches this hook. */
async function broadcastTrashChange(): Promise<void> {
  await emitStreakRefresh()
  emitEntriesChanged()
  emitMediaChanged()
}

/**
 * Settings → Data → Recently deleted. Lists the Trash for the current
 * second-lock view and invisible vault, and refreshes on
 * `memlore:entries-changed` (a soft delete elsewhere adds a row).
 */
export function useTrash(): UseTrashResult {
  const [entries, setEntries] = useState<Entry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const genRef = useRef(0)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  const fetchTrash = useCallback(async (): Promise<void> => {
    const gen = ++genRef.current
    setIsLoading(true)
    setError(null)
    try {
      const result = await listTrashedEntries(lockedView, activeVaultId)
      if (gen !== genRef.current) return
      // A backend without the command (the mockup router) answers null.
      setEntries(result ?? [])
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
    setIsLoading(false)
  }, [lockedView, activeVaultId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fires the memoized data-fetch; would need TanStack Query to fix properly
    void fetchTrash()
  }, [fetchTrash])

  useEffect(() => {
    const handler = () => void fetchTrash()
    window.addEventListener('memlore:entries-changed', handler)
    return () => window.removeEventListener('memlore:entries-changed', handler)
  }, [fetchTrash])

  const restore = useCallback(
    async (id: string): Promise<void> => {
      await tauriRestoreEntry(id, lockedView, activeVaultId)
      await broadcastTrashChange()
    },
    [lockedView, activeVaultId],
  )

  const deleteForever = useCallback(
    async (id: string): Promise<void> => {
      await tauriDeleteEntryForever(id, lockedView, activeVaultId)
      await broadcastTrashChange()
    },
    [lockedView, activeVaultId],
  )

  const empty = useCallback(
    async (ids: readonly string[]): Promise<number> => {
      const purged = await tauriEmptyTrash(ids, lockedView, activeVaultId)
      await broadcastTrashChange()
      return purged
    },
    [lockedView, activeVaultId],
  )

  return {
    entries,
    isLoading,
    error,
    lockedView,
    refetch: fetchTrash,
    restore,
    deleteForever,
    empty,
  }
}
