/**
 * Journals, tags and templates (reads Phase 10.3, writes Phase 22.1). The data comes from the device-root
 * `journals/*.bin`, `tags.bin` and `templates.bin` files cached by the puller, merged across
 * devices by last-write-wins per id (see readSession.ts `readTaxonomy`).
 *
 * - Journals: deleted, locked and invisible journals are not listed and `get_journal` answers null
 *   for them. Their ids feed `vault.setExcludedJournalIds` (readSession.ts).
 * - Tags: every live tag is listed (a tag only used by hidden entries cannot be told apart without
 *   loading them). `get_tags_with_counts` counts the entry facts (`indexFacts.ts`: month index rows
 *   overlaid with the vault; the loaded visible entries only without an index source), so locked,
 *   invisible, excluded and pending-trash entries never count; the order is count desc, name asc as
 *   on desktop.
 * - Templates: user templates only. Desktop seeds its predefined templates per device and never
 *   syncs them, so the web has none.
 * - `get_tags_for_entry` loads that one entry when needed; `get_tags_for_entries` never downloads an
 *   entry payload: a loaded entry answers from its copy, one not loaded from its entry fact
 *   (`entryFacts`, which may download the month index files not cached yet).
 *
 * Writes (Phase 22.1; outbox v3 since web gap audit Phase 10.2): every journal, tag and template
 * write stores ONE frame-3 draft through `saveIntent` (`j-` / `t-` / `p-<id>`, new lowercase UUIDs
 * for creates); push uploads it once a desktop advertises its kind (`outbox_kinds`). Creates are
 * `upsert_journal` / `upsert_tag` / `upsert_template` with a null base. Every list here shows the
 * pending overlay at once (`pendingTaxonomy.ts`), so entries can be moved into a pending journal or
 * tagged with a pending tag (push holds those entry drafts back until the create is reflected).
 * Gates, in order: locked (`VaultLockedError`), writes off (`read_only`, as the entry writes), no
 * desktop advertising EVERY kind the command may seal (`WebUnsupportedError`): each command checks
 * its own kinds and never trusts the UI capability flag.
 * Validation mirrors the desktop and memlore-core `OutboxIntentV3::validate`: names trimmed
 * (journal, tag), non-empty, at most 200 characters; colors `#RRGGBB`; template description /
 * content caps.
 * A journal name taken by another visible or locked synced journal or a pending one, or a tag name
 * of another tag (live or deleted, pending deletes included), is refused with `name_taken` (the
 * desktop importer would refuse it for good); a live tag name answers that tag on create, as
 * desktop `create_tag` (get-or-create) does. The writes run under the outbox lock and re-read the
 * pending overlay there, so two concurrent writes of one name in a tab cannot both store a draft.
 * Template bases (`base_updated_at`, desktop-wins on the desktop): a template only this browser
 * created stays a create (upsert `null`, delete `0`: the desktop chains both on its own create);
 * a pending edit keeps its base; otherwise the synced template's `updated_at`.
 * Journal and tag bases (`journalTarget` / `tagTarget`): the synced `updated_at` (`journals/*.bin`,
 * `tags.bin`), or the base of a pending edit. A desktop re-reading a create it already applied does
 * NOT apply its new name (`decide_create_v3`), so a journal / tag only this browser created is
 * edited as a create (null base) while its create is unpushed, deleted by dropping that draft, and
 * refused with `retry_after_sync` once its upload started (`uploadStarted`, set by push under the
 * Drive writer lock, which that decision and write also hold) but the synced files do not show it.
 * `delete_journal` (Q1): only an empty journal. "Empty" counts what the web can see of it: the
 * entry facts (loaded entries and month index rows), the desktop-Trash rows and the pending web
 * trashes (`journal_not_empty`); the last journal is refused (`last_journal`). Entries the web
 * cannot see (locked, invisible vault) are guarded by the desktop's own `journal_not_empty`
 * refusal, which the sync notice shows with "sync and try again" copy.
 */

import type { Journal, Tag } from '../../../../src/types/journal'
import type { Template } from '../../../../src/types/template'
import type { OutboxIntentV3 } from '../../core/core'
import { nowSecs } from '../clock'
import { sha256Hex } from '../drafts'
import { isIntentTargetId } from '../drive/paths'
import { getKeyRing } from '../keys'
import { isControlCodePoint, isDisguisingCodePoint, isSurrogateCodePoint } from '../plainText'
import type { Handler } from '../router'
import { draftKind, draftTargetId } from '../storage/idb'
import { withWriterLock } from '../tabs'
import { intentTarget, openV2Intent, type NonEntryIntent } from '../sync/safeUpload'
import { WebUnsupportedError } from '../unsupported'
import { EntryNotAvailableError, assertWritesEnabled, loadVisible, outboxWrite } from './entries'
import { entryFacts } from './indexFacts'
import { NO_PENDING, overlayTaxonomy } from './pendingTaxonomy'
import { openForRead, openForWrite, type Taxonomy } from './readSession'
import { saveIntent } from './saveIntent'

export { saveIntent }

const byName = (a: Tag, b: Tag): number => a.name.localeCompare(b.name)

function tagsOf(ids: readonly string[], taxonomy: Taxonomy): Tag[] {
  const wanted = new Set(ids)
  return taxonomy.tags.filter((t) => wanted.has(t.id)).sort(byName)
}

const listJournals: Handler = async () => (await openForRead()).taxonomy.journals

const getJournal: Handler = async ({ id }) =>
  (await openForRead()).taxonomy.journals.find((j) => j.id === id) ?? null

const listJournalAutoTags: Handler = async ({ journalId }) => {
  const { taxonomy } = await openForRead()
  const key = String(journalId)
  return tagsOf(Object.hasOwn(taxonomy.autoTagIds, key) ? taxonomy.autoTagIds[key] : [], taxonomy)
}

const listTags: Handler = async () => (await openForRead()).taxonomy.tags

const getTagsWithCounts: Handler = async () => {
  // Tags from the read taxonomy (pending creates included), counts from the facts.
  const { taxonomy } = await openForRead()
  const { facts } = await entryFacts(null)
  const counts = new Map<string, number>()
  for (const f of facts) {
    for (const id of new Set(f.tag_ids)) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return taxonomy.tags
    .map((tag): [Tag, number] => [tag, counts.get(tag.id) ?? 0])
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
}

const getTagsForEntry: Handler = async ({ entryId }) => {
  const { vault, taxonomy } = await openForRead()
  try {
    const entry = await loadVisible(vault, String(entryId))
    return entry === null ? [] : tagsOf(entry.metadata.tag_ids, taxonomy)
  } catch (error) {
    // Desktop answers an empty list for an entry the caller may not see.
    if (error instanceof EntryNotAvailableError) return []
    throw error
  }
}

/**
 * Tags of the visible entries among `entryIds`, never downloading an entry payload: a loaded entry
 * answers from its copy; one the vault does not hold (an index row of the calendar, or a page row
 * evicted by the LRU cap since it was fetched) from its entry fact (`indexFacts.ts`: the month index
 * row under the vault rule, so locked, invisible, excluded and pending-trash entries get none).
 */
const getTagsForEntries: Handler = async ({ entryIds }) => {
  const { vault, taxonomy } = await openForRead()
  const ids = (Array.isArray(entryIds) ? entryIds : []).filter(
    (id): id is string => typeof id === 'string',
  )
  const tagIds = new Map<string, string[]>()
  for (const id of ids) if (vault.isLoaded(id)) tagIds.set(id, vault.getEntry(id).metadata.tag_ids)
  if (ids.some((id) => !tagIds.has(id) && vault.status(id) === 'not-loaded')) {
    const wanted = new Set(ids)
    for (const f of (await entryFacts(null)).facts) {
      if (wanted.has(f.entry_id) && !tagIds.has(f.entry_id)) tagIds.set(f.entry_id, f.tag_ids)
    }
  }
  // No prototype: an entry id such as `__proto__` is an ordinary key.
  const out: Record<string, Tag[]> = Object.create(null) as Record<string, Tag[]>
  for (const [id, tags] of tagIds) {
    const named = tagsOf(tags, taxonomy)
    if (named.length > 0) out[id] = named
  }
  return out
}

const listTemplates: Handler = async () => (await openForRead()).taxonomy.templates

const getTemplate: Handler = async ({ id }) =>
  (await openForRead()).taxonomy.templates.find((t) => t.id === id) ?? null

// ---------------------------------------------------------------------------------------------
// Writes (outbox v3: Phase 22.1, web gap audit Phase 10.2)
// ---------------------------------------------------------------------------------------------

/** memlore-core `outbox.rs` caps (`MAX_INTENT_NAME_CHARS`, `MAX_AUTO_TAG_IDS`, template caps). */
const MAX_NAME_CHARS = 200
const MAX_AUTO_TAG_IDS = 100
const MAX_TEMPLATE_DESCRIPTION_BYTES = 4 * 1024
const MAX_TEMPLATE_CONTENT_BYTES = 8 * 1024 * 1024
const COLOR = /^#[0-9a-fA-F]{6}$/

type WriteSession = Awaited<ReturnType<typeof openForWrite>>

/** Opens the write session behind the three gates of the header; `kinds`: what `command` seals. */
async function openWrite(command: string, ...kinds: string[]): Promise<WriteSession> {
  const w = await openForWrite()
  assertWritesEnabled()
  if (!kinds.every((kind) => w.kindsAdvertised.has(kind))) throw new WebUnsupportedError(command)
  return w
}

const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

/** A char memlore-core `check_name` refuses (control or disguising) or no Rust string holds. */
const isHiddenNameChar = (cp: number): boolean =>
  isControlCodePoint(cp) || isDisguisingCodePoint(cp) || isSurrogateCodePoint(cp)

/** `raw` without the chars core refuses in a name (they do not show), then trimmed if `trim`. */
function checkName(raw: unknown, trim: boolean): string {
  if (typeof raw !== 'string') throw new Error('name is required')
  const plain = Array.from(raw)
    .filter((c) => !isHiddenNameChar(c.codePointAt(0) ?? 0))
    .join('')
  const name = trim ? plain.trim() : plain
  if (name.trim() === '') throw new Error('name must not be empty')
  if ([...name].length > MAX_NAME_CHARS) {
    throw new Error(`name is longer than ${MAX_NAME_CHARS} characters`)
  }
  return name
}

function checkColor(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || !COLOR.test(raw)) {
    throw new Error(`invalid color ${String(raw)}: expected #RRGGBB`)
  }
  return raw
}

function checkAutoTags(raw: unknown, taxonomy: Taxonomy): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('autoTagIds must be a list')
  const ids = [...new Set(raw as unknown[])]
  if (ids.length > MAX_AUTO_TAG_IDS) throw new Error(`more than ${MAX_AUTO_TAG_IDS} auto tags`)
  const live = new Set(taxonomy.tags.map((t) => t.id))
  for (const id of ids) {
    if (typeof id !== 'string' || !live.has(id)) throw new Error(`Tag not found: ${String(id)}`)
  }
  return ids as string[]
}

function checkDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new Error('description must be text')
  if (new TextEncoder().encode(raw).length > MAX_TEMPLATE_DESCRIPTION_BYTES) {
    throw new Error(`template description exceeds ${MAX_TEMPLATE_DESCRIPTION_BYTES} bytes`)
  }
  return raw
}

const isByte = (b: unknown): boolean =>
  Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255

/** The template body (`Vec<u8>` on desktop) as standard base64, or null. */
function contentB64(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : Array.isArray(raw) && raw.every(isByte)
        ? Uint8Array.from(raw as number[])
        : null
  if (bytes === null) throw new Error('template content must be bytes')
  if (bytes.length > MAX_TEMPLATE_CONTENT_BYTES) {
    throw new Error(`template content exceeds ${MAX_TEMPLATE_CONTENT_BYTES} bytes`)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** `web_device_id` and `web_updated_at_secs` (Drive-corrected clock) of a new intent. */
async function intentStamp(
  w: WriteSession,
): Promise<{ web_device_id: string; web_updated_at_secs: number }> {
  const device = await w.db.device.get()
  if (!device) throw new Error('Device record missing')
  return { web_device_id: device.deviceId, web_updated_at_secs: nowSecs() }
}

/** The synced taxonomy with just this intent applied (the record a create / edit returns). */
const withIntent = (w: WriteSession, intent: NonEntryIntent): Taxonomy =>
  overlayTaxonomy(w.synced, { ...NO_PENDING, intents: [intent] })

/**
 * Where a journal / tag edit or delete starts (see the header): `{ base }` = an update or delete
 * from this desktop stamp; `create` = only this browser's create exists, not uploaded yet.
 */
type EditTarget = { kind: 'base'; base: number } | { kind: 'create' }

/**
 * The target of an edit or delete of the journal / tag stored under `key` (`j-` / `t-<id>`).
 * `syncedBase`: the record's synced `updated_at` when the synced files show it live and visible,
 * else null. Reads the stored draft: call it under the outbox lock. Throws `notFound` when the
 * record is not visible here, `retry_after_sync` for an uploaded create the synced files do not
 * show yet (its desktop stamp is unknown).
 */
async function editTarget(
  w: WriteSession,
  key: string,
  syncedBase: number | null,
  notFound: Error,
): Promise<EditTarget> {
  const stored = await w.db.drafts.get(key)
  if (stored === undefined) {
    if (syncedBase === null) throw notFound
    return { kind: 'base', base: syncedBase }
  }
  const prior = openV2Intent(w.core, getKeyRing(), stored.sealed)
  const { prefix, id } = intentTarget(prior)
  if (`${prefix}-${id}` !== key) throw notFound
  switch (prior.kind) {
    case 'upsert_journal':
    case 'upsert_tag':
      if (prior.base_updated_at !== null) return { kind: 'base', base: prior.base_updated_at }
      break
    case 'create_journal':
    case 'create_tag':
      break
    default:
      throw notFound // a pending delete
  }
  // A create of this browser: the desktop's own copy wins once the synced files show it.
  if (syncedBase !== null) return { kind: 'base', base: syncedBase }
  // Its upload started (it may be on Drive even without `pushedHash`) or finished.
  if (stored.uploadStarted === true || stored.pushedHash === (await sha256Hex(stored.sealed))) {
    throw new Error('retry_after_sync')
  }
  return { kind: 'create' }
}

/**
 * Runs `act` (the write or drop) with the `editTarget` of `key`. A record the synced files do not
 * show may be this browser's create while push uploads it: then the read, the decision and `act`
 * run under the Drive writer lock, which `flush` holds from marking the draft `uploadStarted` to
 * its put, so a create whose upload started is never rewritten or dropped as a create. Call it
 * under the outbox lock (lock order: outbox lock, then writer lock; push and retention never
 * take them the other way round).
 */
async function withEditTarget<T>(
  w: WriteSession,
  key: string,
  syncedBase: number | null,
  notFound: Error,
  act: (target: EditTarget) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => act(await editTarget(w, key, syncedBase, notFound))
  return syncedBase === null ? withWriterLock(run) : run()
}

/** The synced `updated_at` of a live, visible synced journal, else null. */
const syncedJournalBase = (w: WriteSession, id: string): number | null =>
  w.synced.journals.find((j) => j.id === id)?.updated_at ?? null

/** The synced `updated_at` of a live synced tag, else null. */
const syncedTagBase = (w: WriteSession, id: string): number | null =>
  w.synced.tags.some((t) => t.id === id) && Object.hasOwn(w.synced.tagUpdatedAt, id)
    ? w.synced.tagUpdatedAt[id]
    : null

/**
 * Drops the unpushed create stored under `key` (a delete of it), then refreshes the overlay.
 * Only inside `withEditTarget`, which holds the writer lock for a create.
 */
async function dropCreate(w: WriteSession, key: string): Promise<void> {
  await w.db.drafts.delete(key)
  await w.refreshPendingV2()
}

/** Another visible or locked journal holds `name` (the desktop refuses it `name_taken`). */
const journalNameTaken = (taxonomy: Taxonomy, name: string, self: string | null): boolean =>
  taxonomy.journals.some((j) => j.id !== self && j.name.trim() === name) ||
  taxonomy.lockedJournalNames.some((n) => n.trim() === name)

const createJournal = outboxWrite(async ({ payload }, lock) => {
  const w = await openWrite('create_journal', 'upsert_journal')
  const p = asRecord(payload)
  const name = checkName(p.name, true)
  const color = checkColor(p.color)
  // Under the lock, the name check and the draft save are atomic within this tab.
  await lock()
  const taxonomy = w.currentTaxonomy()
  const autoTagIds = checkAutoTags(p.autoTagIds, taxonomy)
  if (journalNameTaken(taxonomy, name, null)) throw new Error('name_taken')
  const intent: OutboxIntentV3 = {
    ...(await intentStamp(w)),
    kind: 'upsert_journal',
    journal_id: crypto.randomUUID(),
    name,
    color,
    auto_tag_ids: autoTagIds,
    base_updated_at: null,
  }
  await saveIntent(w, intent)
  return withIntent(w, intent).journals.find((j) => j.id === intent.journal_id) as Journal
})

/**
 * `update_journal` (`{ payload: { id, name, color?, autoTagIds? } }`, as desktop): `color` absent
 * clears it, `autoTagIds` absent keeps the current auto tags.
 */
const updateJournal = outboxWrite(async ({ payload }, lock) => {
  const w = await openWrite('update_journal', 'upsert_journal')
  const p = asRecord(payload)
  const id = String(p.id ?? '')
  const name = checkName(p.name, true)
  const color = checkColor(p.color)
  await lock()
  const taxonomy = w.currentTaxonomy()
  const notFound = new Error(`Journal not found: ${id}`)
  const current = taxonomy.journals.find((j) => j.id === id)
  if (current === undefined || !isIntentTargetId(id)) throw notFound
  const live = new Set(taxonomy.tags.map((t) => t.id))
  const autoTagIds =
    p.autoTagIds === undefined
      ? (Object.hasOwn(taxonomy.autoTagIds, id) ? taxonomy.autoTagIds[id] : []).filter((t) =>
          live.has(t),
        )
      : checkAutoTags(p.autoTagIds, taxonomy)
  if (name !== current.name.trim() && journalNameTaken(taxonomy, name, id)) {
    throw new Error('name_taken')
  }
  return withEditTarget(w, `j-${id}`, syncedJournalBase(w, id), notFound, async (target) => {
    const intent: OutboxIntentV3 = {
      ...(await intentStamp(w)),
      kind: 'upsert_journal',
      journal_id: id,
      name,
      color,
      auto_tag_ids: autoTagIds,
      base_updated_at: target.kind === 'base' ? target.base : null,
    }
    await saveIntent(w, intent)
    return withIntent(w, intent).journals.find((j) => j.id === id) as Journal
  })
})

/**
 * Whether the journal holds an entry the web can see (see the header): an entry fact, a desktop
 * Trash row or a pending web trash. Downloads the Trash payloads: call it BEFORE the outbox lock.
 */
async function journalHasEntries(w: WriteSession, journalId: string): Promise<boolean> {
  if ((await entryFacts(null)).facts.some((f) => f.journal_id === journalId)) return true
  const { vault } = w
  const desktopIds = vault.listTrashedIndex().map((e) => e.entryId)
  await vault.loadTrashed(desktopIds)
  const pendingIds = (await w.db.drafts.list())
    .filter((d) => draftKind(d) === 'trash')
    .map(draftTargetId)
  const notInRam = pendingIds.filter((id) => vault.trashView(id) === null)
  if (notInRam.length > 0) await vault.load(notInRam)
  return [...desktopIds, ...pendingIds].some(
    (id) => vault.trashView(id)?.held.metadata.journal_id === journalId,
  )
}

const deleteJournal = outboxWrite(async ({ id: rawId }, lock) => {
  const w = await openWrite('delete_journal', 'delete_journal')
  const id = String(rawId ?? '')
  const notFound = new Error(`Journal not found: ${id}`)
  if (!isIntentTargetId(id) || !w.taxonomy.journals.some((j) => j.id === id)) throw notFound
  if (await journalHasEntries(w, id)) throw new Error('journal_not_empty')
  await lock()
  const taxonomy = w.currentTaxonomy()
  if (!taxonomy.journals.some((j) => j.id === id)) throw notFound
  // Desktop `delete_journal` refuses the last journal (locked ones count there).
  if (taxonomy.journals.length + taxonomy.lockedJournalNames.length <= 1) {
    throw new Error('last_journal')
  }
  const key = `j-${id}`
  await withEditTarget(w, key, syncedJournalBase(w, id), notFound, async (target) => {
    if (target.kind === 'create') return dropCreate(w, key)
    await saveIntent(w, {
      ...(await intentStamp(w)),
      kind: 'delete_journal',
      journal_id: id,
      base_updated_at: target.base,
    })
  })
})

/** Another tag, live or deleted, holds `name` (`tags.name` is unique on desktop). */
const tagNameTaken = (taxonomy: Taxonomy, name: string, self: string | null): boolean =>
  taxonomy.tags.some((t) => t.id !== self && t.name === name) ||
  taxonomy.deletedTagNames.includes(name)

const createTag = outboxWrite(async ({ name: rawName, color: rawColor }, lock) => {
  const w = await openWrite('create_tag', 'upsert_tag')
  const name = checkName(rawName, true)
  const color = checkColor(rawColor)
  // Under the lock, the name check and the draft save are atomic within this tab.
  await lock()
  const taxonomy = w.currentTaxonomy()
  const existing = taxonomy.tags.find((t) => t.name === name)
  if (existing !== undefined) return existing
  // `tags.name` is unique over live AND deleted rows on desktop; the web cannot resurrect one.
  if (tagNameTaken(taxonomy, name, null)) throw new Error('name_taken')
  const intent: OutboxIntentV3 = {
    ...(await intentStamp(w)),
    kind: 'upsert_tag',
    tag_id: crypto.randomUUID(),
    name,
    color,
    base_updated_at: null,
  }
  await saveIntent(w, intent)
  const tag: Tag = { id: intent.tag_id, name, color }
  return tag
})

/**
 * `update_tag` (`{ payload: { id, name?, color? } }`, as desktop): an absent field keeps its
 * value, `color: null` clears it.
 */
const updateTag = outboxWrite(async ({ payload }, lock) => {
  const w = await openWrite('update_tag', 'upsert_tag')
  const p = asRecord(payload)
  const id = String(p.id ?? '')
  const rawName = p.name
  const rawColor = p.color
  await lock()
  const taxonomy = w.currentTaxonomy()
  const notFound = new Error(`Tag not found: ${id}`)
  const current = taxonomy.tags.find((t) => t.id === id)
  if (current === undefined || !isIntentTargetId(id)) throw notFound
  // An older desktop may have stored a hidden char: a color-only edit drops it so the intent seals.
  const name = rawName === undefined ? checkName(current.name, false) : checkName(rawName, true)
  const color = rawColor === undefined ? current.color : checkColor(rawColor)
  if (name !== current.name && tagNameTaken(taxonomy, name, id)) throw new Error('name_taken')
  return withEditTarget(w, `t-${id}`, syncedTagBase(w, id), notFound, async (target) => {
    await saveIntent(w, {
      ...(await intentStamp(w)),
      kind: 'upsert_tag',
      tag_id: id,
      name,
      color,
      base_updated_at: target.kind === 'base' ? target.base : null,
    })
    const tag: Tag = { id, name, color }
    return tag
  })
})

const deleteTag = outboxWrite(async ({ id: rawId }, lock) => {
  const w = await openWrite('delete_tag', 'delete_tag')
  const id = String(rawId ?? '')
  await lock()
  const notFound = new Error(`Tag not found: ${id}`)
  if (!isIntentTargetId(id) || !w.currentTaxonomy().tags.some((t) => t.id === id)) throw notFound
  const key = `t-${id}`
  await withEditTarget(w, key, syncedTagBase(w, id), notFound, async (target) => {
    if (target.kind === 'create') return dropCreate(w, key)
    await saveIntent(w, {
      ...(await intentStamp(w)),
      kind: 'delete_tag',
      tag_id: id,
      base_updated_at: target.base,
    })
  })
})

const createTemplate = outboxWrite(async (args, lock) => {
  const w = await openWrite('create_template', 'upsert_template')
  const name = checkName(args.name, false)
  const description = checkDescription(args.description)
  const content = contentB64(args.content)
  await lock()
  const intent: OutboxIntentV3 = {
    ...(await intentStamp(w)),
    kind: 'upsert_template',
    template_id: crypto.randomUUID(),
    name,
    description,
    content_b64: content,
    sort_order: 0, // desktop `create_template`
    base_updated_at: null,
  }
  await saveIntent(w, intent)
  return withIntent(w, intent).templates.find((t) => t.id === intent.template_id) as Template
})

/**
 * The template an edit or delete acts on and its desktop base (see the header). Reads the stored
 * `p-<id>` draft: call it under the outbox lock. Throws when the template is not visible here.
 */
async function templateTarget(
  w: WriteSession,
  id: string,
): Promise<{ sortOrder: number; upsertBase: number | null; deleteBase: number }> {
  const notFound = new Error(`Template not found: ${id}`)
  if (!isIntentTargetId(id)) throw notFound
  const stored = await w.db.drafts.get(`p-${id}`)
  if (stored !== undefined) {
    const prior = openV2Intent(w.core, getKeyRing(), stored.sealed)
    if (prior.kind !== 'upsert_template' || prior.template_id !== id) throw notFound
    return {
      sortOrder: prior.sort_order,
      upsertBase: prior.base_updated_at,
      deleteBase: prior.base_updated_at ?? 0,
    }
  }
  const synced = w.synced.templates.find((t) => t.id === id)
  const base = Object.hasOwn(w.synced.templateUpdatedAt, id) ? w.synced.templateUpdatedAt[id] : null
  if (synced === undefined || base === null) throw notFound
  return { sortOrder: synced.sort_order, upsertBase: base, deleteBase: base }
}

const updateTemplate = outboxWrite(async (args, lock) => {
  const w = await openWrite('update_template', 'upsert_template')
  const id = String(args.id ?? '')
  const name = checkName(args.name, false)
  const description = checkDescription(args.description)
  const content = contentB64(args.content)
  await lock()
  const target = await templateTarget(w, id)
  const intent: OutboxIntentV3 = {
    ...(await intentStamp(w)),
    kind: 'upsert_template',
    template_id: id,
    name,
    description,
    content_b64: content,
    sort_order: target.sortOrder,
    base_updated_at: target.upsertBase,
  }
  await saveIntent(w, intent)
  return withIntent(w, intent).templates.find((t) => t.id === id) as Template
})

const deleteTemplate = outboxWrite(async (args, lock) => {
  const w = await openWrite('delete_template', 'delete_template')
  const id = String(args.id ?? '')
  await lock()
  const target = await templateTarget(w, id)
  await saveIntent(w, {
    ...(await intentStamp(w)),
    kind: 'delete_template',
    template_id: id,
    base_updated_at: target.deleteBase,
  })
})

export const taxonomyHandlers: Record<string, Handler> = {
  list_journals: listJournals,
  get_journal: getJournal,
  list_journal_auto_tags: listJournalAutoTags,
  list_tags: listTags,
  get_tags_with_counts: getTagsWithCounts,
  get_tags_for_entry: getTagsForEntry,
  get_tags_for_entries: getTagsForEntries,
  list_templates: listTemplates,
  get_template: getTemplate,
  create_journal: createJournal,
  update_journal: updateJournal,
  delete_journal: deleteJournal,
  create_tag: createTag,
  update_tag: updateTag,
  delete_tag: deleteTag,
  create_template: createTemplate,
  update_template: updateTemplate,
  delete_template: deleteTemplate,
}
