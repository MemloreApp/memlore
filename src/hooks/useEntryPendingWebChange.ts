import { useQuery } from '@tanstack/react-query'
import { entryHasPendingWebChange } from '../lib/tauri'
import { isWeb } from '../lib/platform'

/**
 * Whether the entry has a web edit the desktop has not imported yet, which a web version restore
 * would lose (no version keeps it). Always `false` on desktop, which snapshots the current text
 * before restoring. On web, `null` while loading and `'failed'` when the check errored: callers
 * treat both as blocked.
 */
export function useEntryPendingWebChange(entryId: string | null): boolean | 'failed' | null {
  const query = useQuery<boolean>({
    queryKey: ['entry-pending-web-change', entryId],
    queryFn: () => entryHasPendingWebChange(entryId as string),
    enabled: isWeb && entryId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  if (!isWeb) return false
  if (query.isError) return 'failed'
  return query.data ?? null
}
