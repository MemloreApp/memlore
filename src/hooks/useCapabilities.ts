import { useMemo } from 'react'
import { capabilities, isWeb, type Capabilities } from '../lib/platform'
import { WEB_IMPLEMENTED_KINDS } from '../lib/webImplementedKinds'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'

/**
 * Static platform capabilities; on web the runtime flags apply: `writes`, plus the ones the
 * synced desktops enable (the outbox v3 kinds they apply, a desktop month index). Each write flag needs `writes` AND every kind its feature seals, each
 * advertised by a desktop AND implemented by the web backend (`WEB_IMPLEMENTED_KINDS`).
 */
function deriveCapabilities(
  writes: boolean,
  monthIndex: boolean,
  outboxKinds: readonly string[],
): Capabilities {
  if (!isWeb) return capabilities
  const applies = (...kinds: string[]): boolean =>
    writes && kinds.every((kind) => WEB_IMPLEMENTED_KINDS.has(kind) && outboxKinds.includes(kind))
  const taxonomyCreate = applies('upsert_journal', 'upsert_tag')
  return {
    ...capabilities,
    writes,
    // Every web write seals frame 3 (Phase 10.2): a v2-only desktop enables none of these.
    taxonomyCreate,
    taxonomyEdits: taxonomyCreate && applies('delete_journal', 'delete_tag'),
    templates: applies('upsert_template', 'delete_template'),
    deleteEntries: applies('trash_entry'),
    trashManage: applies('restore_entry', 'purge_entry', 'empty_trash'),
    entryLocation: applies('set_entry_location'),
    fileAttachments: applies('attach_media', 'delete_media'),
    mediaInsertionMode: applies('set_media_insertion_mode'),
    memoryEdit: applies('delete_memory_item'),
    personaEdit: applies('update_persona'),
    gallery: monthIndex,
    lookback: monthIndex,
    stats: monthIndex,
    // Home's cards read the same index views as Stats / Gallery / On this day.
    dashboard: monthIndex,
    mapView: monthIndex,
    versionsRead: monthIndex,
    // Web restore is a normal editor content change (v1 outbox intent); the desktop
    // snapshots the pre-import text when it imports it.
    versionsRestore: writes && monthIndex,
  }
}

/** The current capabilities outside React (command palette `available` checks). */
export function currentCapabilities(): Capabilities {
  const { writes, monthIndex, outboxKinds } = useCapabilitiesStore.getState()
  return deriveCapabilities(writes, monthIndex, outboxKinds)
}

export function useCapabilities(): Capabilities {
  const writes = useCapabilitiesStore((s) => s.writes)
  const monthIndex = useCapabilitiesStore((s) => s.monthIndex)
  const outboxKinds = useCapabilitiesStore((s) => s.outboxKinds)
  return useMemo(
    () => deriveCapabilities(writes, monthIndex, outboxKinds),
    [writes, monthIndex, outboxKinds],
  )
}
