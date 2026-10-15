/**
 * The pending outbox v2 overlay (Phase 22): what this browser created, edited or deleted that no
 * synced file shows yet.
 *
 * - Journal / tag creates, renames / recolors and deletes and template upserts / deletes come from
 *   the stored `j-` / `t-` / `p-` drafts (pushed or not, frame 2 or 3), opened with the current
 *   ring. A draft that does not open, or whose body does not match its key or its stored kind, is
 *   skipped (logged by error name) and kept, as push and retention do. An `upsert_journal` /
 *   `upsert_tag` with a null base is a create; with a base it edits the synced record in place
 *   (web gap audit Phase 10.2). A pending `delete_journal` / `delete_tag` hides the record, and a
 *   deleted tag's name stays taken (`deletedTagNames`), as on desktop.
 * - Entry locations and media insertion modes (web gap audit Phase 13) and media attaches and
 *   deletes (Phase 14) come from the stored `l-` / `i-` / `a-` drafts, opened and checked the same
 *   way; the vault overlays them (`setPendingEntryFields`).
 * - Trashed entries come from the `d-<entryId>` draft KEYS of kind `trash` only: nothing to
 *   decrypt. A restore or purge draft shares the `d-` letter but hides nothing here (a restore
 *   replacing a pushed trash shows the synced entry again; the Trash list, `trash.ts`, drops
 *   restored and purged rows itself).
 *
 * `overlayTaxonomy` is applied by `openForRead` / `openForWrite` only. The session's own taxonomy
 * (`ready()`, read by push hold-back and by retention) stays the SYNCED one: a pending create seen
 * there would lift the push hold-back of the entries naming it, and a pending template upsert would
 * look reflected and be dropped. A pending create already present in the synced files (any state)
 * is not overlaid: the synced record wins.
 *
 * The overlay disappears with its draft: retention drops a draft once it is reflected, acked or
 * finally refused (Phase 21), and the session re-reads this overlay after every retention pass.
 */

import type { Core } from '../../core/core'
import type { PendingInsertionMode, PendingLocation, PendingMedia } from '../vault'
import type { Journal, Tag } from '../../../../src/types/journal'
import type { Template } from '../../../../src/types/template'
import type { KeyRing } from '../keys'
import { draftKind, draftTargetId, type DraftRecord } from '../storage/idb'
import {
  draftKindOfIntent,
  intentTarget,
  openV2Intent,
  type NonEntryIntent,
} from '../sync/safeUpload'
import type { Taxonomy } from './readSession'

export interface PendingV2 {
  /** Journal, tag and template intents of this browser's stored drafts. */
  intents: readonly NonEntryIntent[]
  /** Entry ids with a stored trash draft. */
  trashedEntryIds: readonly string[]
  /** `set_entry_location` intents of the stored `l-` drafts. */
  locations: readonly PendingLocation[]
  /** `set_media_insertion_mode` intents of the stored `i-` drafts. */
  insertionModes: readonly PendingInsertionMode[]
  /** `attach_media` / `delete_media` intents of the stored `a-` drafts. */
  media: readonly PendingMedia[]
}

export const NO_PENDING: PendingV2 = {
  intents: [],
  trashedEntryIds: [],
  locations: [],
  insertionModes: [],
  media: [],
}

/** The draft kinds whose opened body feeds this overlay. */
const OPENED_KINDS: ReadonlySet<string> = new Set([
  'journal',
  'tag',
  'template',
  'location',
  'insertion_mode',
  'media',
])

/** The pending overlay of these stored drafts (see the header). Never throws for one bad draft. */
export function pendingFromDrafts(
  drafts: readonly DraftRecord[],
  core: Pick<Core, 'openOutboxIntent'>,
  ring: KeyRing,
): PendingV2 {
  const intents: NonEntryIntent[] = []
  const trashedEntryIds: string[] = []
  const locations: PendingLocation[] = []
  const insertionModes: PendingInsertionMode[] = []
  const media: PendingMedia[] = []
  for (const draft of drafts) {
    const kind = draftKind(draft)
    if (kind === 'trash') {
      trashedEntryIds.push(draftTargetId(draft))
      continue
    }
    if (!OPENED_KINDS.has(kind)) continue
    try {
      const intent = openV2Intent(core, ring, draft.sealed)
      const { prefix, id } = intentTarget(intent)
      if (draft.entryId !== `${prefix}-${id}` || draftKindOfIntent(intent) !== kind) {
        throw new Error('not an intent for this draft')
      }
      if (intent.kind === 'set_entry_location') locations.push(intent)
      else if (intent.kind === 'set_media_insertion_mode') insertionModes.push(intent)
      else if (intent.kind === 'attach_media' || intent.kind === 'delete_media') media.push(intent)
      else intents.push(intent)
    } catch (error) {
      // Log the error name only: a JSON.parse message can quote decrypted text.
      const reason = error instanceof Error ? error.name : typeof error
      console.warn(`Skipping draft ${draft.entryId}: it could not be opened (${reason})`)
    }
  }
  return { intents, trashedEntryIds, locations, insertionModes, media }
}

/** A journal create: v2 `create_journal`, or v3 `upsert_journal` with a null base. */
const isJournalCreate = (
  i: NonEntryIntent,
): i is Extract<NonEntryIntent, { kind: 'create_journal' | 'upsert_journal' }> =>
  i.kind === 'create_journal' || (i.kind === 'upsert_journal' && i.base_updated_at === null)

/** Journal ids this browser created that the synced files do not show yet. */
export function pendingJournalIds(synced: Taxonomy, pending: PendingV2): string[] {
  const known = new Set(synced.knownJournalIds)
  return pending.intents.flatMap((i) =>
    isJournalCreate(i) && !known.has(i.journal_id) ? [i.journal_id] : [],
  )
}

function decodeBase64(b64: string | null): number[] | null {
  if (b64 === null) return null
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const byJournalOrder = (a: Journal, b: Journal): number =>
  a.sort_order - b.sort_order || a.created_at - b.created_at
const byName = (a: Tag, b: Tag): number => a.name.localeCompare(b.name)
const byTemplateOrder = (a: Template, b: Template): number =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name)

/**
 * The synced taxonomy with this browser's pending journal / tag creates, edits and deletes and
 * template edits and deletes applied.
 */
export function overlayTaxonomy(synced: Taxonomy, pending: PendingV2): Taxonomy {
  if (pending.intents.length === 0) return synced
  const knownJournals = new Set(synced.knownJournalIds)
  const knownTags = new Set(synced.knownTagIds)
  let journals = [...synced.journals]
  const knownJournalIds = [...synced.knownJournalIds]
  // No prototype: a journal id such as `__proto__` is an ordinary key.
  const autoTagIds = Object.assign(
    Object.create(null) as Record<string, string[]>,
    synced.autoTagIds,
  )
  let tags = [...synced.tags]
  const deletedTagNames = [...synced.deletedTagNames]
  let templates = [...synced.templates]
  for (const intent of pending.intents) {
    switch (intent.kind) {
      case 'create_journal':
      case 'upsert_journal':
        if (intent.kind === 'create_journal' || intent.base_updated_at === null) {
          if (knownJournals.has(intent.journal_id)) break
          journals.push({
            id: intent.journal_id,
            name: intent.name,
            color: intent.color,
            created_at: intent.web_updated_at_secs,
            updated_at: intent.web_updated_at_secs,
            sort_order: 0,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: null,
            is_initial_placeholder: false,
          })
          knownJournalIds.push(intent.journal_id)
          autoTagIds[intent.journal_id] = [...intent.auto_tag_ids]
          break
        }
        // An edit applies to a visible journal only (a locked or hidden one stays hidden).
        if (!journals.some((j) => j.id === intent.journal_id)) break
        journals = journals.map((j) =>
          j.id === intent.journal_id ? { ...j, name: intent.name, color: intent.color } : j,
        )
        autoTagIds[intent.journal_id] = [...intent.auto_tag_ids]
        break
      case 'delete_journal':
        journals = journals.filter((j) => j.id !== intent.journal_id)
        delete autoTagIds[intent.journal_id]
        break
      case 'create_tag':
      case 'upsert_tag': {
        const create = intent.kind === 'create_tag' || intent.base_updated_at === null
        if (create && knownTags.has(intent.tag_id)) break
        const next: Tag = { id: intent.tag_id, name: intent.name, color: intent.color }
        if (create) {
          tags.push(next)
        } else if (tags.some((t) => t.id === intent.tag_id)) {
          tags = tags.map((t) => (t.id === intent.tag_id ? next : t))
        }
        break
      }
      case 'delete_tag': {
        const gone = tags.find((t) => t.id === intent.tag_id)
        if (gone === undefined) break
        tags = tags.filter((t) => t.id !== intent.tag_id)
        // `tags.name` stays unique over deleted rows on desktop.
        deletedTagNames.push(gone.name)
        break
      }
      case 'upsert_template': {
        const current = templates.find((t) => t.id === intent.template_id)
        const next: Template = {
          id: intent.template_id,
          name: intent.name,
          description: intent.description,
          content: decodeBase64(intent.content_b64),
          is_predefined: false,
          sort_order: intent.sort_order,
          created_at: current?.created_at ?? intent.web_updated_at_secs,
        }
        templates = [...templates.filter((t) => t.id !== intent.template_id), next]
        break
      }
      case 'delete_template':
        templates = templates.filter((t) => t.id !== intent.template_id)
        break
      default:
        break // entry kinds (`trash_entry`, …): carried by the draft keys, not the taxonomy
    }
  }
  return {
    ...synced,
    journals: journals.sort(byJournalOrder),
    autoTagIds,
    knownJournalIds,
    tags: tags.sort(byName),
    deletedTagNames,
    templates: templates.sort(byTemplateOrder),
  }
}
