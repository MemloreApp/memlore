import { useEffect, useRef, useState } from 'react'
import { listAllEntriesPaged } from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { Entry } from '../types/entry'

const ENTRIES_CHANGED_EVENT = 'memlore:entries-changed'

export function useRecentEntries(limit = 3): {
  entries: Entry[]
  isLoading: boolean
  error: string | null
} {
  const [entries, setEntries] = useState<Entry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Mirrors `entries` synchronously so a refetch knows whether a list is on screen.
  const entriesRef = useRef<Entry[]>([])
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  useEffect(() => {
    let cancelled = false
    let requestSequence = 0

    // `quiet` (entries-changed refetch) keeps the current list visible instead of
    // flashing the skeleton; the skeleton still shows when the list is empty.
    const fetchEntries = (quiet: boolean) => {
      const sequence = ++requestSequence
      if (!quiet || entriesRef.current.length === 0) setIsLoading(true)
      setError(null)
      // page=1; PAGE_SIZE is 20 (src/types/pagination.ts). Slice to `limit`.
      listAllEntriesPaged('newest', 'all', null, null, 1, 1, lockedView, activeVaultId, 'all')
        .then((result) => {
          if (cancelled || sequence !== requestSequence) return
          entriesRef.current = result.items.slice(0, limit)
          setEntries(entriesRef.current)
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          if (cancelled || sequence !== requestSequence) return
          entriesRef.current = []
          setEntries([])
          setError(err instanceof Error ? err.message : String(err))
          setIsLoading(false)
        })
    }

    // Mount and lock/vault/limit changes show the skeleton, so a stale list never
    // stays on screen across a lock transition.
    fetchEntries(false)
    const onEntriesChanged = () => fetchEntries(true)
    window.addEventListener(ENTRIES_CHANGED_EVENT, onEntriesChanged)
    return () => {
      cancelled = true
      window.removeEventListener(ENTRIES_CHANGED_EVENT, onEntriesChanged)
    }
  }, [limit, lockedView, activeVaultId])

  return { entries, isLoading, error }
}
