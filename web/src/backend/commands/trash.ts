/**
 * The Trash for the web companion: the list (`list_trashed_entries`) and, since web gap audit
 * Phase 11, its actions (`restore_entry`, `delete_entry_forever`, `empty_trash`) as outbox v3
 * drafts the desktop applies.
 *
 * Two sources, merged and ordered as the desktop does (`ORDER BY trashed_at DESC, id`):
 *   1. Desktop Trash: index winners with `trashedAt` (`vault.listTrashedIndex`), decrypted on demand
 *      by `vault.loadTrashed` into a map apart from the live views. `trashed_at` comes from the copy
 *      (the index winner's when the payload lacks it).
 *   2. Pending web deletes: the `d-<entryId>` TRASH drafts of this browser (`kind === 'trash'`
 *      only; restore, purge and empty_trash drafts share the `d-` letter). `trashed_at` is the
 *      local request time (`DraftRecord.updatedAt`, plaintext ms), `trash_pending_desktop` is set.
 *      An id that is also in the desktop Trash is shown once, as the desktop row.
 * A desktop row with a pending restore or purge draft, or listed by the pending `d-empty-trash`
 * draft, leaves the list at once: it waits for the desktop, which brings a restored entry back
 * live in the synced files (the web does not show it live before that).
 *
 * VISIBILITY: locked, invisible and journal-excluded entries are never listed (second lock is not
 * supported on the web), so `lockedView` and `activeVaultId` are ignored, by every command here. A
 * pending id the vault cannot show after one `vault.load` is listed as an untitled row only when
 * nothing synced is known about it (`getSynced` status `'not-loaded'`: no index winner or an
 * unreadable payload, and no create intent). Any other status means it is excluded (locked,
 * invisible, journal) or purged on the desktop (`'deleted'`), and it is left out.
 *
 * WRITES (one file per entry, `d-<entryId>`, the latest intent wins; README "Web push order"). Gates,
 * in order: locked (`VaultLockedError`), writes off (`read_only`), no desktop advertising the kind
 * the command seals (`WebUnsupportedError`; never the UI flag).
 * - `restore_entry`: a desktop row seals `restore_entry` from the synced row's `updated_at`. A
 *   pending web trash whose draft may be on Drive (`pushedHash` or `uploadStarted` set) seals
 *   `restore_entry` from that trash's own base (the desktop chains it whether or not it applied the
 *   trash); one that was never uploaded is just dropped, sealing nothing. That decision and its
 *   write run under the Drive writer lock, which push holds from marking a draft `uploadStarted` to
 *   its put, so a trash whose upload started is never dropped as unpushed.
 * - `delete_entry_forever`: desktop rows only (never a pending web trash or an untitled
 *   placeholder), `purge_entry` from the synced row's `updated_at`.
 * - `empty_trash`: takes the ids of the rows the user confirmed (`ids`; refused when missing or
 *   invalid, never read as "everything") and queues those this list still shows, oldest
 *   `trashed_at` first, each with the synced row's `updated_at`. A row that reached the Trash after
 *   the confirmation is never queued. Merged with the still-pending `d-empty-trash` list (its items
 *   the list would show but for that list), at most `MAX_EMPTY_TRASH_ITEMS`. Answers how many
 *   listed rows it queued; the rest stays listed ("Empty again").
 */

import type { Entry } from '../../../../src/types/entry'
import type { Core, EmptyTrashItem, OutboxIntentV3 } from '../../core/core'
import { nowSecs } from '../clock'
import { isEntryId, isSafeId } from '../drive/paths'
import { getKeyRing } from '../keys'
import type { Handler } from '../router'
import { draftKind, draftTargetId, type DraftRecord } from '../storage/idb'
import { openV2Intent } from '../sync/safeUpload'
import { withWriterLock } from '../tabs'
import { WebUnsupportedError } from '../unsupported'
import type { TrashView, VaultEntry } from '../vault'
import { assertWritesEnabled, outboxWrite } from './entries'
import { emotionOrNull, numOrNull, strOrNull } from './entryFields'
import { openForRead, openForWrite, readEnv, type VaultApi } from './readSession'
import { saveIntent } from './saveIntent'

/**
 * Desktop `Entry` of a Trash row. `trashed_at` defaults to the view's (null for a pending web
 * delete, whose request time only the draft knows). Never built through `toEntry`: that one marks
 * everything served as live.
 */
export function toTrashedEntry(view: TrashView, extra: { trashedAt?: number } = {}): Entry {
  const m = view.held.metadata
  return {
    id: m.entry_id,
    journal_id: m.journal_id,
    title: m.title,
    preview_text: m.preview_text,
    content_text: m.content_text,
    entry_date: m.entry_date,
    created_at: m.created_at,
    updated_at: m.updated_at,
    latitude: numOrNull(m.latitude),
    longitude: numOrNull(m.longitude),
    location_label: strOrNull(m.location_label),
    location_address: strOrNull(m.location_address),
    weather_summary: strOrNull(m.weather_summary),
    weather_icon: strOrNull(m.weather_icon),
    emotion: emotionOrNull(m.emotion),
    is_favorite: m.is_favorite,
    is_deleted: true,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: strOrNull(m.cover_media_id),
    content_language: strOrNull(m.content_language),
    entry_date_user_edited: m.entry_date_user_edited === true,
    media_count: Array.isArray(m.media) ? m.media.length : 0,
    from_chat: false,
    trashed_at: extra.trashedAt ?? view.trashedAt,
    ...(view.pending ? { trash_pending_desktop: true } : {}),
  }
}

/** A pending web delete with nothing to show: the UI renders it "Untitled", not previewable. */
function untitledPendingEntry(id: string, trashedAt: number): Entry {
  return {
    id,
    journal_id: '',
    title: null,
    preview_text: null,
    content_text: null,
    entry_date: trashedAt,
    created_at: trashedAt,
    updated_at: trashedAt,
    latitude: null,
    longitude: null,
    location_label: null,
    location_address: null,
    weather_summary: null,
    weather_icon: null,
    emotion: null,
    is_favorite: false,
    is_deleted: true,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: null,
    content_language: null,
    entry_date_user_edited: false,
    media_count: 0,
    from_chat: false,
    trashed_at: trashedAt,
    trash_pending_desktop: true,
  }
}

const byTrashedDesc = (a: Entry, b: Entry): number =>
  (b.trashed_at ?? 0) - (a.trashed_at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** memlore-core `MAX_EMPTY_TRASH_ITEMS`: the most entries one `empty_trash` intent lists. */
// TODO(later): see docs/LATER.md - `MAX_EMPTY_TRASH_ITEMS` is mirrored in `trash.ts`
export const MAX_EMPTY_TRASH_ITEMS = 1000

const EMPTY_TRASH_KEY = 'd-empty-trash'

/** The most ids one `empty_trash` confirmation may carry (the whole listed Trash, not one intent). */
const MAX_CONFIRMED_IDS = 100 * MAX_EMPTY_TRASH_ITEMS

/** What this browser's stored `d-` drafts say about the Trash (see the header). */
interface TrashDrafts {
  /** Pending web trash: entry id -> request time (unix seconds). */
  trashed: Map<string, number>
  /** Entry ids a stored restore or purge draft acts on. */
  restoredOrPurged: Set<string>
  /** `restoredOrPurged` and the ids the stored empty_trash lists. */
  leaving: Set<string>
  /** The stored `d-empty-trash` items (none when absent or unreadable). */
  emptyItems: EmptyTrashItem[]
}

/** The items of a stored `d-empty-trash` draft; none when it does not open as one (logged). */
function emptyTrashItems(core: Core | undefined, draft: DraftRecord): EmptyTrashItem[] {
  try {
    if (core === undefined) throw new Error('core unavailable')
    const intent = openV2Intent(core, getKeyRing(), draft.sealed)
    if (intent.kind !== 'empty_trash') throw new Error('not an empty_trash intent')
    return intent.items
  } catch (error) {
    // Log the error name only: a JSON.parse message can quote decrypted text.
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Skipping draft ${draft.entryId}: it could not be opened (${reason})`)
    return []
  }
}

function readTrashDrafts(drafts: readonly DraftRecord[], core: Core | undefined): TrashDrafts {
  const out: TrashDrafts = {
    trashed: new Map(),
    restoredOrPurged: new Set(),
    leaving: new Set(),
    emptyItems: [],
  }
  for (const draft of drafts) {
    switch (draftKind(draft)) {
      case 'trash':
        out.trashed.set(draftTargetId(draft), Math.floor(draft.updatedAt / 1000))
        break
      case 'restore':
      case 'purge':
        out.restoredOrPurged.add(draftTargetId(draft))
        out.leaving.add(draftTargetId(draft))
        break
      case 'empty_trash':
        if (draft.entryId !== EMPTY_TRASH_KEY) break
        out.emptyItems = emptyTrashItems(core, draft)
        for (const item of out.emptyItems) out.leaving.add(item.entry_id)
        break
      default:
        break
    }
  }
  return out
}

/** Downloads the desktop-Trash payloads not held yet (never under the outbox lock). */
async function loadDesktopTrash(vault: VaultApi): Promise<void> {
  await vault.loadTrashed(vault.listTrashedIndex().map((e) => e.entryId))
}

/**
 * The desktop-Trash rows the web shows (held by `loadDesktopTrash`), keyed by entry id, minus the
 * rows a pending restore, purge or empty_trash takes away. RAM only.
 */
function desktopRows(vault: VaultApi, leaving: ReadonlySet<string>): Map<string, TrashView> {
  const rows = new Map<string, TrashView>()
  for (const id of vault.listTrashedIndex().map((w) => w.entryId)) {
    const view = vault.trashView(id)
    if (view !== null && !view.pending && !leaving.has(id)) rows.set(id, view)
  }
  return rows
}

const listTrashedEntries: Handler = async () => {
  const { vault } = await openForRead()
  const { db, core } = await readEnv().session()

  const drafts = readTrashDrafts((await db?.drafts.list()) ?? [], core)
  const allDesktopIds = new Set(vault.listTrashedIndex().map((w) => w.entryId))
  await loadDesktopTrash(vault)
  const shown = desktopRows(vault, drafts.leaving)
  const rows: Entry[] = [...shown.values()].map((view) => toTrashedEntry(view))

  // Request time (unix seconds) per pending id, minus the ids the desktop already shows.
  const pending = new Map(
    [...drafts.trashed].filter(([id]) => !allDesktopIds.has(id) && !drafts.leaving.has(id)),
  )
  const notInRam = [...pending.keys()].filter((id) => vault.trashView(id) === null)
  if (notInRam.length > 0) await vault.load(notInRam)
  for (const [id, trashedAt] of pending) {
    const view = vault.trashView(id)
    if (view !== null) rows.push(toTrashedEntry(view, { trashedAt }))
    else if (
      vault.getSynced(id).status === 'not-loaded' &&
      vault.getOutboxIntent(id)?.created_on_web !== true
    ) {
      rows.push(untitledPendingEntry(id, trashedAt))
    }
  }
  return rows.sort(byTrashedDesc)
}

// ---------------------------------------------------------------------------------------------
// Writes (web gap audit Phase 11)
// ---------------------------------------------------------------------------------------------

type WriteSession = Awaited<ReturnType<typeof openForWrite>>

/**
 * `outboxWrite` resolved when the command runs: `entries.ts` imports this module (`toTrashedEntry`),
 * so nothing of `entries.ts` may run while this module loads.
 */
const trashWrite =
  (body: Parameters<typeof outboxWrite>[0]): Handler =>
  (args) =>
    outboxWrite(body)(args)

/** Opens the write session behind the gates of the header; `kind`: what `command` seals. */
async function openWrite(command: string, kind: string): Promise<WriteSession> {
  const w = await openForWrite()
  assertWritesEnabled()
  if (!w.kindsAdvertised.has(kind)) throw new WebUnsupportedError(command)
  return w
}

/** `web_device_id` and `web_updated_at_secs` (Drive-corrected clock) of a new intent. */
async function intentStamp(
  w: WriteSession,
): Promise<{ web_device_id: string; web_updated_at_secs: number }> {
  const device = await w.db.device.get()
  if (!device) throw new Error('Device record missing')
  return { web_device_id: device.deviceId, web_updated_at_secs: nowSecs() }
}

const notInTrash = (): Error => new Error('entry is not in Trash')

/** The base of a desktop row: the synced trashed row's `updated_at`, as the desktop compares it. */
const baseOf = (held: VaultEntry): number => held.metadata.updated_at

/**
 * The desktop rows the list shows right now (see `desktopRows`). Reads the stored drafts: call it
 * under the outbox lock, after `loadDesktopTrash`.
 */
async function shownDesktopRows(w: WriteSession): Promise<Map<string, TrashView>> {
  const drafts = readTrashDrafts(await w.db.drafts.list(), w.core)
  return desktopRows(w.vault, drafts.leaving)
}

/**
 * Restores a pending web trash of `id` (see the header). Under the writer lock: the upload marks
 * `uploadStarted` under it, so the decision never races an upload of this trash.
 */
async function restorePendingTrash(w: WriteSession, id: string): Promise<void> {
  const key = `d-${id}`
  await withWriterLock(async () => {
    const stored = await w.db.drafts.get(key)
    if (stored === undefined || draftKind(stored) !== 'trash') throw notInTrash()
    if (stored.pushedHash === undefined && stored.uploadStarted !== true) {
      // Never on Drive: the desktop has nothing to undo.
      await w.db.drafts.delete(key)
      await w.refreshPendingV2()
      return
    }
    const trash = openV2Intent(w.core, getKeyRing(), stored.sealed)
    if (trash.kind !== 'trash_entry' || trash.entry_id !== id) throw notInTrash()
    await saveIntent(w, {
      ...(await intentStamp(w)),
      kind: 'restore_entry',
      entry_id: id,
      base_updated_at: trash.base_updated_at,
    })
  })
}

const restoreEntry = trashWrite(async ({ id: rawId }, lock) => {
  const w = await openWrite('restore_entry', 'restore_entry')
  const id = String(rawId ?? '')
  if (!isEntryId(id)) throw notInTrash()
  await loadDesktopTrash(w.vault)
  await lock()
  const row = (await shownDesktopRows(w)).get(id)
  if (row !== undefined) {
    // TODO(later): see docs/LATER.md - A web restore of a desktop-Trash row leaves the entry nowhere
    await saveIntent(w, {
      ...(await intentStamp(w)),
      kind: 'restore_entry',
      entry_id: id,
      base_updated_at: baseOf(row.held),
    })
  } else {
    await restorePendingTrash(w, id)
  }
  readEnv().emit('memlore:entries-changed')
})

const deleteEntryForever = trashWrite(async ({ id: rawId }, lock) => {
  const w = await openWrite('delete_entry_forever', 'purge_entry')
  const id = String(rawId ?? '')
  if (!isEntryId(id)) throw notInTrash()
  await loadDesktopTrash(w.vault)
  await lock()
  // Desktop rows only: a pending web trash is in no Trash yet, and a placeholder has no base.
  const row = (await shownDesktopRows(w)).get(id)
  if (row === undefined) throw notInTrash()
  await saveIntent(w, {
    ...(await intentStamp(w)),
    kind: 'purge_entry',
    entry_id: id,
    base_updated_at: baseOf(row.held),
  })
  readEnv().emit('memlore:entries-changed')
})

const byTrashedAsc = ([a, va]: [string, TrashView], [b, vb]: [string, TrashView]): number =>
  (va.trashedAt ?? 0) - (vb.trashedAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0)

/**
 * The `ids` of `empty_trash`: an array of at most `MAX_CONFIRMED_IDS` safe ids (desktop ids, not
 * only uuids: one imported row must not refuse the whole list), else it throws.
 */
function confirmedIds(raw: unknown): Set<string> {
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_CONFIRMED_IDS ||
    !raw.every((id): id is string => typeof id === 'string' && isSafeId(id))
  ) {
    throw new Error('invalid empty_trash ids')
  }
  return new Set(raw)
}

const emptyTrash = trashWrite(async ({ ids }, lock) => {
  const w = await openWrite('empty_trash', 'empty_trash')
  const confirmed = confirmedIds(ids)
  await loadDesktopTrash(w.vault)
  await lock()
  const drafts = readTrashDrafts(await w.db.drafts.list(), w.core)
  // The rows the list shows, the pending empty_trash list aside.
  const rows = desktopRows(w.vault, drafts.restoredOrPurged)
  // The pending list keeps the items still shown that way (the rest the desktop applied, or they
  // left the Trash): one file per target, so the new list must carry them on.
  const items = drafts.emptyItems.filter((i) => rows.has(i.entry_id))
  const listed = new Set(items.map((i) => i.entry_id))
  const shown = [...rows].filter(([id]) => confirmed.has(id) && !listed.has(id)).sort(byTrashedAsc)
  const added = shown.slice(0, Math.max(0, MAX_EMPTY_TRASH_ITEMS - items.length))
  if (added.length === 0) return 0
  const intent: OutboxIntentV3 = {
    ...(await intentStamp(w)),
    kind: 'empty_trash',
    items: [
      ...items,
      ...added.map(([id, view]) => ({ entry_id: id, base_updated_at: baseOf(view.held) })),
    ],
  }
  await saveIntent(w, intent)
  readEnv().emit('memlore:entries-changed')
  return added.length
})

export const trashHandlers: Record<string, Handler> = {
  list_trashed_entries: listTrashedEntries,
  restore_entry: restoreEntry,
  delete_entry_forever: deleteEntryForever,
  empty_trash: emptyTrash,
}
