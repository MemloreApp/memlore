/**
 * Intent retention (Phase 16.1 rules, wired in Phase 16.6.8).
 *
 * After every read-session pull, and once after the drafts hydrate the overlay, every draft is
 * evaluated against the synced state (the vault's synced copy, never the overlay; tombstones of
 * every manifest), every desktop's cached `outbox-acks.bin`, and the importer-capable desktops:
 *  - a PUSHED draft no longer needed (`shouldRetainIntent`) is deleted with its `outbox/m-<id>`
 *    media and leaves the overlay. An unpushed draft is never deleted: its newest bytes are not on
 *    Drive;
 *  - resolved fields leave the overlay intent at once, so the synced value shows. The stored draft
 *    keeps them until the next rewrite, which builds on the overlay intent (`priorIntent`), so they
 *    are omitted then: resolving alone causes no upload;
 *  - each "replaced" / "refused" notice (a structured `WebNotice`, translated by the UI) is
 *    returned once.
 *
 * Importer-capable desktop: a device with a slot (`.meta/keyring/devices/<id>.json`) AND a manifest
 * that has an `outbox-acks.bin`. A slot holder with a manifest but no acks file yet counts as
 * UNDECIDED for 7 days after the intent revision was first seen pushed, then is ignored.
 *
 * Clocks: only the web's own clock (`nowSecs`, Drive `Date`-corrected) times the 7-day and 30-day
 * bounds, from first-seen times persisted in IndexedDB `meta` (`outbox-` keys, kept with the drafts
 * by `clearCache`). Desktop-stamped values are only compared with each other (`outbox.ts`).
 *
 * Desktop Trash: a draft of an entry in the desktop Trash is kept silently; only a
 * hard delete (`RetentionDesktops.hardDeleted`) drops it. Once the entry is restored, a pushed
 * revision a capable desktop refused `entry_trashed` (and none applied) is sealed again (a fresh
 * nonce, so new bytes the desktop re-reads) and stored unpushed: once per revision, at most
 * `MAX_REQUEUES` times per entry. Before that, every field whose `base` the restored entry still
 * holds is rebased onto its `updated_at`, so the desktop applies it instead of refusing it as
 * changed by the trash and restore stamps.
 *
 * Fail safe: any read error (an unknown slot list, an acks file that does not open, a missing
 * device record) keeps every draft and shows nothing; a synced payload that cannot be read keeps
 * that draft.
 *
 * Outbox v2 drafts (journal, tag, template, trash; Phase 21) never reach the entry rules above.
 * Without `v2` (the capable set and the taxonomy) they are all kept, silently. A PUSHED one is
 * dropped when:
 *  - reflected in the synced state: the journal is in `journals/` (any state), the tag in
 *    `tags.bin` (live OR deleted: a tag the desktop created then deleted must still lift the
 *    push hold-back of the entry drafts naming it), the upserted template is live with the same
 *    content (a deleted one waits for the desktop's `changed_on_desktop` refusal), the deleted
 *    template is deleted, the trashed entry is trashed or tombstoned in a manifest. Silent;
 *  - acked by a v2-capable desktop (`resolveV2Ack`): applied silently, or finally refused with a
 *    `refused` notice whose `field` is the v2 kind. Capable = slot-holding desktops advertising
 *    `outbox_versions ∋ 2`; the others' acks are ignored (a v0.2.2 desktop acks a v2 file with
 *    every field null). The 7-day undecided grace applies as for entry intents.
 * While NO slot-holding desktop advertises v2, every v2 draft (pushed or not) is kept and raises
 * one `waiting_newer_desktop` notice (`field` = the v2 kind), once per draft.
 *
 * Frame-3 drafts (Phase 9.3, README "Acks" -> "Per-kind resolution on the web", review C1) follow
 * the same flow, per kind: capable = slot-holding desktops advertising the body kind in
 * `outbox_kinds` (`RetentionV2.kindDesktops`; absent: none, so every frame-3 draft is kept). An
 * ack counts only for this exact revision (`content_hash`); `created` never resolves one. The
 * destructive kinds (purge_entry, empty_trash, delete_journal, delete_tag, delete_media,
 * delete_memory_item) and restore_entry (web gap audit Phase 11: a stale synced copy can look
 * restored) resolve by ack only; the others may also resolve by a kind-specific value
 * in the synced state (`isReflectedV3`), never because the target merely exists. While no
 * slot-holding desktop advertises its kind, a frame-3 draft raises one `waiting_desktop_update`
 * notice (its own copy: a v0.2.3 desktop does not apply it), but not while a slot-holding desktop's
 * manifest could not be read this pull (`RetentionV2.degraded`): its kinds are unknown, so the
 * one-shot notice waits for a pull that can tell.
 *
 * An `a-` draft (attach_media / delete_media, Phase 14) drops its `outbox/m-<mediaId>` blob with
 * it once resolved, except an attach refused `absent` on an entry this browser created
 * (`resolvedBlobs`): the bytes stay in IndexedDB. An `i-` refused `absent` while a `delete_media`
 * of the same media is in the pass shows no note (the user deleted that media here).
 *
 * Attached paste (stability 2, task 3.2): push uploads an `i-` right behind the entry draft that
 * brings its media, so a desktop may read it before that `.bin` applied (read alone, or a v1 it
 * could not apply yet) and refuse it `absent`. Such a refusal (no `delete_media` of that media in
 * the pass) is not final while a stored entry draft still lists the media: kept, silently. Once
 * the synced entry lists the media (retention loads every `i-` target), the same intent is sealed
 * again and stored unpushed, like a restored entry's draft above: once per revision, at most
 * `MAX_REQUEUES` times per `i-` key. Neither, or the bound used up: final, as before.
 *
 * Every non-entry draft is checked against its body (both frames): the key must be the body's
 * letter-id stem and the stored kind the body's (`draftKindOfIntent`), else it is kept untouched.
 *
 * Outbox blob sweep (stability 2, task 3.3): each pass ends (also with no draft stored) by deleting
 * the `outbox/m-*` blobs that no draft still stored names (entry media refs, an `a-` or `i-` media
 * id; a requeued draft counts), that this pass did not keep (`resolvedBlobs`), and whose
 * `lastAccess` is more than `BLOB_SWEEP_GRACE_SECS` ago on the web clock: a tab closed between an
 * attach's blobs and its drafts, or a kept attach blob nothing re-attaches. A blob without a
 * timestamp is kept, and so is every blob when any stored draft does not open (its refs are
 * unknown). The media cache is never touched.
 */

import {
  openOutboxIntent,
  type Core,
  type OutboxIntentV2,
  type OutboxIntentV3,
  type OutboxLocation,
} from '../../core/core'
import type { Taxonomy, VaultApi } from '../commands/readSession'
import { noteDraftRequeued, sha256Hex } from '../drafts'
import type { KeyRing } from '../keys'
import {
  OUTBOX_BLOB_PREFIX,
  OUTBOX_META_PREFIX,
  OUTBOX_PUSHED_AT_PREFIX,
  OUTBOX_REFUSED_AT_PREFIX,
  draftKind,
  type DraftRecord,
  type WebDb,
} from '../storage/idb'
import { withDraftLock } from '../tabs'
import type { EntryMetadata } from '../vault'
import {
  ackIntentPath,
  decisionKey,
  formatNotice,
  resolveV2Ack,
  shouldRetainIntent,
  type FieldChange,
  type FieldNotice,
  type OutboxAcksV1,
  type OutboxEntryV1,
  type OutboxFields,
  type WebNotice,
} from './outbox'
import { draftKindOfIntent, intentTarget } from './safeUpload'

export const UNDECIDED_GRACE_SECS = 7 * 86400
/** An unnamed outbox blob younger than this is kept: its attach may still be saving its drafts. */
export const BLOB_SWEEP_GRACE_SECS = 86400

const RESOLVED = `${OUTBOX_META_PREFIX}resolved:`
const REFUSED_AT = OUTBOX_REFUSED_AT_PREFIX
/** `<prefix><entryId>` -> `<count>:<content_hash>`: the re-queues of an entry, and the last one. */
const REQUEUED = `${OUTBOX_META_PREFIX}requeued:`
const MAX_REQUEUES = 3
const ENTRY_TRASHED = 'entry_trashed'
const PUSHED_AT = OUTBOX_PUSHED_AT_PREFIX
const WAITING = `${OUTBOX_META_PREFIX}waiting:`
const ACKS_FILE = 'outbox-acks.bin'

/** What the last pull saw of the other devices. */
export interface RetentionDesktops {
  /** Devices with a manifest (desktops). */
  manifests: readonly string[]
  /** Device slot ids; null when the slot list is unknown (keep everything). */
  slots: ReadonlySet<string> | null
  /**
   * Entry ids with a deleted row in ANY manifest, or whose LWW winner is in the desktop Trash
   * (`pull.ts` `tombstonesOf`). Read by the v2 / v3 trash reflection.
   */
  tombstones: ReadonlySet<string>
  /**
   * The hard-deleted ones: a deleted row WITHOUT `trashed_at` in any manifest (a purge or a legacy
   * delete). An entry draft is dropped on these only; a trashed entry can still be restored.
   */
  hardDeleted: ReadonlySet<string>
}

/** What the v2 rules read (see the header); the taxonomy is the synced one, never an overlay. */
export interface RetentionV2 {
  /** Slot-holding desktops advertising `outbox_versions ∋ 2` (`Puller.v2Desktops`). */
  desktops: ReadonlySet<string>
  /** Per desktop, the `outbox_kinds` it advertises (frame-3 capability). Absent: none. */
  kindDesktops?: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Devices whose manifest could not be read this pull (`Puller.getDegradedDevices`): their kinds
   * are unknown, so no frame-3 `waiting_desktop_update` notice while one of them holds a slot.
   * Absent: none.
   */
  degraded?: ReadonlySet<string>
  /** The frame-3 value predicates also read `journals`, `autoTagIds`, `tags` (absent: ack only). */
  taxonomy: Pick<Taxonomy, 'knownJournalIds' | 'knownTagIds' | 'templates' | 'deletedTemplateIds'> &
    Partial<Pick<Taxonomy, 'journals' | 'autoTagIds' | 'tags'>>
}

export interface RetentionDeps {
  db: Pick<WebDb, 'drafts' | 'files' | 'meta' | 'device' | 'blobs'>
  core: Pick<
    Core,
    | 'openOutboxAcks'
    | 'openOutboxEntry'
    | 'openOutboxIntent'
    | 'sealOutboxEntry'
    | 'sealOutboxIntentV3'
  >
  ring: KeyRing
  /** Web clock, Unix seconds. */
  nowSecs: () => number
  desktops: RetentionDesktops
  vault: Pick<
    VaultApi,
    'load' | 'getSynced' | 'getOutboxIntent' | 'getOutboxIntents' | 'setOutboxIntents'
  >
  /** Absent: every v2 draft is kept, silently. */
  v2?: RetentionV2
}

export interface RetentionResult {
  dropped: string[]
  /** New notices, oldest first; each is persisted as shown before it is returned. */
  notices: WebNotice[]
  /** The overlay changed (a draft dropped or a field hidden). */
  changed: boolean
}

const NOTHING: RetentionResult = { dropped: [], notices: [], changed: false }

/**
 * `<journal id>:<entry id>` pairs: a refused journal create showed one note naming that entry
 * moved into it (`retainV2`). Push holds those entry drafts until the create resolves, so their
 * `journal_id` refusal comes a later pass; it then shows no second note for that entry. An entry
 * the note did not name (skipped that pass, or moved in later) still gets its own. In memory
 * only (ids, no names): after a reload that note shows again, as before.
 */
const toldJournals = new Set<string>()

/** The UI's view of a field notice: its decision identity (`change_seq`) stays here. */
function toWebNotice({ change_seq: _seq, ...notice }: FieldNotice): WebNotice {
  return notice
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every manifest device's acks (absent file: none). Throws when a present file does not open. An
 * entry that is not an object with a string `path` and a `decided` array is skipped: it decides
 * nothing, so its draft is kept (the field types are checked where they are read).
 */
async function readAcks(deps: RetentionDeps): Promise<Map<string, OutboxAcksV1>> {
  const out = new Map<string, OutboxAcksV1>()
  for (const device of deps.desktops.manifests) {
    const rec = await deps.db.files.get(`${device}/${ACKS_FILE}`)
    if (rec === undefined) continue
    const parsed: unknown = JSON.parse(deps.core.openOutboxAcks(deps.ring, rec.ciphertext))
    if (!isRecord(parsed) || !Array.isArray(parsed.acks)) throw new Error('acks file is malformed')
    const acks = (parsed.acks as unknown[]).filter(
      (a) => isRecord(a) && typeof a.path === 'string' && Array.isArray(a.decided),
    ) as OutboxAcksV1['acks']
    // Capability is about the folder it was read from, whatever id the file claims.
    out.set(device, { ...(parsed as unknown as OutboxAcksV1), acks, desktop_device_id: device })
  }
  return out
}

function openIntent(deps: RetentionDeps, draft: DraftRecord): OutboxEntryV1 | null {
  try {
    const parsed: unknown = JSON.parse(deps.core.openOutboxEntry(deps.ring, draft.sealed))
    if (!isRecord(parsed) || parsed.entry_id !== draft.entryId || !isRecord(parsed.fields)) {
      return null
    }
    return parsed as unknown as OutboxEntryV1
  } catch {
    return null // hydration already logged it; it is kept
  }
}

/** JSON with sorted keys: the same intent opened from bytes or built by a write compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  )
}

/** `<field>@<seq>` -> web-clock seconds of the first refusal seen (recorded now when new). */
async function refusalTimes(
  deps: RetentionDeps,
  entryId: string,
  path: string,
  acks: OutboxAcksV1[],
  now: number,
): Promise<Map<string, number>> {
  const times = new Map<string, number>()
  for (const file of acks) {
    for (const a of file.acks) {
      if (a.path !== path) continue
      for (const d of a.decided) {
        const k = decisionKey(d.field, d.change_seq)
        if (d.decision !== 'refused' || times.has(k)) continue
        const key = `${REFUSED_AT}${entryId}:${k}`
        const value = (await deps.db.meta.get(key))?.value
        if (typeof value === 'number') times.set(k, value)
        else {
          await deps.db.meta.put({ key, value: now })
          times.set(k, now)
        }
      }
    }
  }
  return times
}

async function resolvedKeys(
  deps: { db: Pick<WebDb, 'meta'> },
  entryId: string,
): Promise<Set<string>> {
  const prefix = `${RESOLVED}${entryId}:`
  const records = await deps.db.meta.listByPrefix(prefix)
  return new Set(records.map((r) => r.key.slice(prefix.length)))
}

async function forgetEntry(deps: RetentionDeps, entryId: string): Promise<void> {
  for (const prefix of [`${RESOLVED}${entryId}:`, `${REFUSED_AT}${entryId}:`]) {
    for (const r of await deps.db.meta.listByPrefix(prefix)) await deps.db.meta.delete(r.key)
  }
  await deps.db.meta.delete(`${PUSHED_AT}${entryId}`)
  await deps.db.meta.delete(`${REQUEUED}${entryId}`)
}

function withoutKeys(fields: OutboxFields, keys: ReadonlySet<string>): OutboxFields {
  const keep = <T extends { change_seq: number } | null>(name: string, c: T): T | null =>
    c !== null && keys.has(decisionKey(name, c.change_seq)) ? null : c
  const tags = (prefix: string, map: OutboxFields['tags_add']): OutboxFields['tags_add'] =>
    Object.fromEntries(Object.entries(map).filter(([id, c]) => keep(`${prefix}:${id}`, c) !== null))
  return {
    title: keep('title', fields.title),
    entry_date: keep('entry_date', fields.entry_date),
    emotion: keep('emotion', fields.emotion),
    is_favorite: keep('is_favorite', fields.is_favorite),
    journal_id: keep('journal_id', fields.journal_id),
    tags_add: tags('tag_add', fields.tags_add),
    tags_remove: tags('tag_remove', fields.tags_remove),
  }
}

/**
 * A stored entry draft without the field changes retention already resolved. The draft keeps them
 * until its next rewrite; a write or reload that merges the stored draft into the overlay intent
 * (review C2) must not bring them back.
 */
export async function withoutResolvedFields(
  db: Pick<WebDb, 'meta'>,
  intent: OutboxEntryV1,
): Promise<OutboxEntryV1> {
  const known = await resolvedKeys({ db }, intent.entry_id)
  return known.size === 0 ? intent : { ...intent, fields: withoutKeys(intent.fields, known) }
}

/** Replaces (or removes) the overlay intent, only while it is still this draft's revision. */
function updateOverlay(
  deps: RetentionDeps,
  draftIntent: OutboxEntryV1,
  known: ReadonlySet<string>,
  next: OutboxEntryV1 | null,
): boolean {
  const current = deps.vault.getOutboxIntent(draftIntent.entry_id)
  if (current === undefined) return false
  const seen = canonical(current)
  const fresh = canonical(draftIntent)
  const cleaned = canonical({ ...draftIntent, fields: withoutKeys(draftIntent.fields, known) })
  if (seen !== fresh && seen !== cleaned) return false // a write set a newer revision meanwhile
  if (next !== null && canonical(next) === seen) return false
  const others = deps.vault.getOutboxIntents().filter((i) => i.entry_id !== draftIntent.entry_id)
  deps.vault.setOutboxIntents(next === null ? others : [...others, next])
  return true
}

/** The synced entry still holds this field's `base`: the desktop did not change it. */
function holdsBase(field: string, base: unknown, synced: EntryMetadata): boolean {
  switch (field) {
    case 'title':
      return (synced.title ?? '') === (base ?? '')
    case 'entry_date':
      return String(synced.entry_date) === String(base)
    case 'emotion':
      return (synced.emotion ?? null) === (base ?? null)
    case 'is_favorite':
      return Boolean(synced.is_favorite) === Boolean(base)
    case 'journal_id':
      return synced.journal_id === base
  }
  return false
}

/**
 * `fields` with each change whose `base` the synced entry still holds rebased onto its
 * `updated_at` (a tag's base is whether the entry had it). The others keep their base: the
 * desktop changed them, so it refuses them, correctly.
 */
function rebaseFields(fields: OutboxFields, synced: EntryMetadata): OutboxFields {
  const at = synced.updated_at
  const one = <T>(field: string, c: FieldChange<T> | null): FieldChange<T> | null =>
    c !== null && holdsBase(field, c.base, synced) ? { ...c, base_updated_at: at } : c
  const tags = (map: OutboxFields['tags_add']): OutboxFields['tags_add'] =>
    Object.fromEntries(
      Object.entries(map).map(([id, c]) => [
        id,
        synced.tag_ids.includes(id) === c.base ? { ...c, base_updated_at: at } : c,
      ]),
    )
  return {
    title: one('title', fields.title),
    entry_date: one('entry_date', fields.entry_date),
    emotion: one('emotion', fields.emotion),
    is_favorite: one('is_favorite', fields.is_favorite),
    journal_id: one('journal_id', fields.journal_id),
    tags_add: tags(fields.tags_add),
    tags_remove: tags(fields.tags_remove),
  }
}

/** A capable desktop refused this exact revision `entry_trashed`, and no desktop applied it. */
function refusedTrashed(
  acks: readonly OutboxAcksV1[],
  path: string,
  hash: string,
  capable: readonly string[],
): boolean {
  let refused = false
  for (const file of acks) {
    for (const a of file.acks) {
      if (a.path !== path || a.content_hash !== hash) continue
      if (typeof a.applied_updated_at === 'number') return false
      if (a.refused_reason === ENTRY_TRASHED && capable.includes(file.desktop_device_id)) {
        refused = true
      }
    }
  }
  return refused
}

/**
 * Records one re-queue of this revision before it is made (so a reload never grants one more).
 * False when this revision was re-queued already or the entry used up `MAX_REQUEUES`.
 */
async function claimRequeue(deps: RetentionDeps, entryId: string, hash: string): Promise<boolean> {
  const key = `${REQUEUED}${entryId}`
  const value = (await deps.db.meta.get(key))?.value
  const m = typeof value === 'string' ? /^(\d+):([0-9a-f]{64})$/.exec(value) : null
  const count = m === null ? 0 : Number(m[1])
  if (m?.[2] === hash || count >= MAX_REQUEUES) return false
  await deps.db.meta.put({ key, value: `${count + 1}:${hash}` })
  return true
}

function mediaPaths(media: ReadonlyArray<{ media_id: string }>): string[] {
  return media.flatMap((m) => [
    `${OUTBOX_BLOB_PREFIX}m-${m.media_id}`,
    `${OUTBOX_BLOB_PREFIX}m-${m.media_id}.thumb`,
  ])
}

/** One pass over every draft. Never rejects for a read error: it keeps everything instead. */
export async function runRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const { desktops } = deps
  if (desktops.slots === null) return NOTHING
  const device = await deps.db.device.get()
  const drafts = await deps.db.drafts.list()
  if (device === undefined) return NOTHING
  if (drafts.length === 0) {
    await sweepOutboxBlobs(deps, new Set())
    return NOTHING
  }

  let acksByDevice: Map<string, OutboxAcksV1>
  try {
    acksByDevice = await readAcks(deps)
  } catch {
    return NOTHING
  }
  const allAcks = [...acksByDevice.values()]
  const slots = desktops.slots
  const slotDesktops = desktops.manifests.filter((d) => slots.has(d))

  const entryDrafts = drafts.filter((d) => draftKind(d) === 'entry')
  const v2Drafts = drafts.filter((d) => draftKind(d) !== 'entry')
  // An `i-` reads its entry's synced media list (the attached paste self-heal, `retainV2`).
  const modeTargets = v2Drafts
    .filter((d) => draftKind(d) === 'insertion_mode')
    .map((d): unknown => d.targetEntryId)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  const toLoad = [...entryDrafts.map((d) => d.entryId), ...modeTargets]
  const load = toLoad.length > 0 ? await deps.vault.load(toLoad) : { failed: [] }
  const failed = new Set(load.failed.map((f) => f.id))

  const opened = new Map(entryDrafts.map((d) => [d.entryId, openIntent(deps, d)]))
  // Entries created on this browser whose `<E>.bin` draft is stored at the start of this pass (one
  // that does not open counts): an attach refused `absent` on one keeps its blob (`resolvedBlobs`).
  const webCreated = new Set(
    entryDrafts
      .filter((d) => opened.get(d.entryId)?.created_on_web !== false)
      .map((d) => d.entryId),
  )

  const result: RetentionResult = { dropped: [], notices: [], changed: false }
  for (const draft of entryDrafts) {
    const id = draft.entryId
    const intent = opened.get(id) ?? null
    if (intent === null || failed.has(id)) continue
    const synced = deps.vault.getSynced(id)
    if (synced.status === 'journal') continue // its metadata is hidden: cannot tell, keep
    const now = deps.nowSecs()
    const hash = await sha256Hex(draft.sealed)
    const since =
      draft.pushedHash === hash ? await deps.db.drafts.recordPushedAt(id, hash, now) : null
    // Read as pushed but unmarked meanwhile (a re-onboard's `clearPushed`): keep it, say nothing.
    if (draft.pushedHash === hash && since === null) continue
    const pushed = since !== null
    const capable = slotDesktops.filter(
      (d) => acksByDevice.has(d) || since === null || now - since < UNDECIDED_GRACE_SECS,
    )
    const path = ackIntentPath(device.deviceId, id)
    const known = await resolvedKeys(deps, id)
    const syncedEntry: EntryMetadata | null = synced.metadata
    const res = shouldRetainIntent({
      intent,
      intentPath: path,
      contentHash: pushed ? hash : null,
      syncedEntry,
      syncedContent: synced.content,
      tombstoned: desktops.hardDeleted.has(id),
      allAcks,
      capableDesktops: capable,
      firstRefusalTimes: await refusalTimes(deps, id, path, allAcks, now),
      resolvedKeys: known,
      nowSecs: now,
      refusedJournals: toldJournals,
    })

    if (!res.retain && pushed) {
      // Defense in depth: never delete media another stored draft still references.
      // (A draft that does not open is kept, but its references are unknown.)
      const shared = new Set(
        [...opened].flatMap(([other, i]) => (other === id ? [] : mediaPaths(i?.media ?? []))),
      )
      const blobs = mediaPaths(intent.media).filter((p) => !shared.has(p))
      if (await deps.db.drafts.dropPushed(id, draft.sealed, hash, blobs)) {
        opened.delete(id)
        await forgetEntry(deps, id)
        updateOverlay(deps, intent, known, null)
        result.dropped.push(id)
        result.changed = true
        if (res.notice !== undefined) result.notices.push(res.notice)
        for (const n of res.fieldNotices) result.notices.push(toWebNotice(n))
      }
      continue
    }

    // Persist first, so a notice is never repeated (a reload between the two loses it instead).
    for (const k of res.resolvedKeys)
      await deps.db.meta.put({ key: `${RESOLVED}${id}:${k}`, value: true })
    for (const n of res.fieldNotices) result.notices.push(toWebNotice(n))
    const all = new Set([...known, ...res.resolvedKeys])
    if (all.size > 0) {
      const next = { ...intent, fields: withoutKeys(intent.fields, all) }
      if (updateOverlay(deps, intent, known, next)) result.changed = true
    }

    // Restored after the desktop refused this revision `entry_trashed`: it never re-reads the
    // same bytes, so the intent is sealed again and stored unpushed (see the header).
    if (
      pushed &&
      synced.status === 'visible' &&
      syncedEntry !== null &&
      !desktops.tombstones.has(id) &&
      refusedTrashed(allAcks, path, hash, capable) &&
      (await claimRequeue(deps, id, hash))
    ) {
      const next = { ...intent, fields: rebaseFields(withoutKeys(intent.fields, all), syncedEntry) }
      const requeued = await withDraftLock(id, () =>
        deps.db.drafts.requeue(
          id,
          draft.sealed,
          deps.core.sealOutboxEntry(deps.ring, JSON.stringify(next)),
        ),
      )
      if (requeued) {
        noteDraftRequeued(id)
        if (updateOverlay(deps, intent, all, next)) result.changed = true
      }
    }
  }
  // The entry drafts still stored after the pass: does one list this media (a paste pending)?
  const pendingMedia = (entryId: string, mediaId: string): boolean => {
    if (!opened.has(entryId)) return false
    const stored = opened.get(entryId) ?? null
    return stored === null || stored.media.some((m) => m.media_id === mediaId) // fail safe: keep
  }
  // The stored entry drafts moving an entry into `journalId`: their ids and titles ('' when
  // untitled). An entry hidden on the web (locked, invisible, deleted, excluded journal) or not
  // loaded this pass is left out.
  const movedInto = (journalId: string): MovedEntry[] =>
    [...opened].flatMap(([entryId, intent]) => {
      if (intent?.fields.journal_id?.value !== journalId || failed.has(entryId)) return []
      const view = deps.vault.getSynced(entryId)
      if (view.status !== 'visible' && view.status !== 'not-loaded') return []
      const synced = view.status === 'visible' ? view.metadata?.title : undefined
      return [{ entryId, title: synced || intent.fields.title?.value || '' }]
    })
  const v2Context = {
    webId: device.deviceId,
    acksByDevice,
    allAcks,
    slotDesktops,
    webCreated,
    pendingMedia,
    movedInto,
    keptBlobs: new Set<string>(),
  }
  if (v2Drafts.length > 0) await retainV2(deps, v2Drafts, v2Context, result)
  await sweepOutboxBlobs(deps, v2Context.keptBlobs)
  return result
}

/** The outbox blobs a draft names, or null when its body does not open (refs unknown). */
function namedBlobs(deps: RetentionDeps, draft: DraftRecord): string[] | null {
  if (draftKind(draft) === 'entry') {
    const intent = openIntent(deps, draft)
    return intent === null ? null : mediaPaths(intent.media)
  }
  const opened = openNonEntry(deps, draft)
  if (opened === null) return null
  const { intent } = opened
  return 'media_id' in intent ? mediaPaths([{ media_id: intent.media_id }]) : []
}

/**
 * Deletes the `outbox/m-*` blobs no stored draft names, not in `kept`, past the grace (see the
 * header). Reads the drafts stored after the pass. Never rejects: on any error it deletes no more.
 */
async function sweepOutboxBlobs(deps: RetentionDeps, kept: ReadonlySet<string>): Promise<void> {
  try {
    const named = new Set(kept)
    for (const draft of await deps.db.drafts.list()) {
      const paths = namedBlobs(deps, draft)
      if (paths === null) return // fail safe: keep every blob
      for (const p of paths) named.add(p)
    }
    const cutoffMs = (deps.nowSecs() - BLOB_SWEEP_GRACE_SECS) * 1000
    for (const blob of await deps.db.blobs.sizes()) {
      if (!blob.path.startsWith(`${OUTBOX_BLOB_PREFIX}m-`) || named.has(blob.path)) continue
      const at = blob.lastAccess
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at >= cutoffMs) continue
      await deps.db.blobs.delete(blob.path)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Outbox blob sweep skipped (${reason})`)
  }
}

// ---------------------------------------------------------------------------------------------
// Outbox v2 drafts (Phase 21)
// ---------------------------------------------------------------------------------------------

/** A non-entry draft's body: frame 2 or frame 3. */
type OpenedIntent = { version: 2; intent: OutboxIntentV2 } | { version: 3; intent: OutboxIntentV3 }

/**
 * The draft's v2 / v3 intent, or null (kept) when it does not open, or its key or stored kind is
 * not the body's (see the header).
 */
function openNonEntry(deps: RetentionDeps, draft: DraftRecord): OpenedIntent | null {
  try {
    const opened = openOutboxIntent(deps.core, deps.ring, draft.sealed)
    if (opened.version === 1) return null
    const { prefix, id } = intentTarget(opened.intent)
    const named =
      draft.entryId === `${prefix}-${id}` && draftKind(draft) === draftKindOfIntent(opened.intent)
    return named ? opened : null
  } catch {
    return null
  }
}

function decodeBase64(b64: string): number[] | null {
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function sameContent(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Only equal content counts: a deleted target is the desktop's `changed_on_desktop` refusal. */
function isTemplateReflected(
  intent: Extract<OutboxIntentV2 | OutboxIntentV3, { kind: 'upsert_template' }>,
  taxonomy: RetentionV2['taxonomy'],
): boolean {
  const live = taxonomy.templates.find((t) => t.id === intent.template_id)
  if (live === undefined) return false
  const content = intent.content_b64 === null ? null : decodeBase64(intent.content_b64)
  if (intent.content_b64 !== null && content === null) return false
  return (
    live.name === intent.name &&
    (live.description ?? null) === intent.description &&
    live.sort_order === intent.sort_order &&
    sameContent(live.content, content)
  )
}

/** The synced state already shows this intent (see the header). */
function isReflectedV2(
  intent: OutboxIntentV2,
  taxonomy: RetentionV2['taxonomy'],
  tombstones: ReadonlySet<string>,
): boolean {
  switch (intent.kind) {
    case 'create_journal':
      return taxonomy.knownJournalIds.includes(intent.journal_id)
    case 'create_tag':
      return taxonomy.knownTagIds.includes(intent.tag_id)
    case 'upsert_template':
      return isTemplateReflected(intent, taxonomy)
    case 'delete_template':
      return taxonomy.deletedTemplateIds.includes(intent.template_id)
    case 'trash_entry':
      return tombstones.has(intent.entry_id)
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((id) => set.has(id))
}

/** A pass-through metadata field (location, media), read with `typeof`-safe access. */
function metaField(metadata: EntryMetadata, key: string): unknown {
  return (metadata as unknown as Record<string, unknown>)[key] ?? null
}

function sameLocation(metadata: EntryMetadata, value: OutboxLocation | null): boolean {
  const field = (key: string): unknown => metaField(metadata, key)
  return (
    field('latitude') === (value?.latitude ?? null) &&
    field('longitude') === (value?.longitude ?? null) &&
    field('location_label') === (value?.label ?? null) &&
    field('location_address') === (value?.address ?? null)
  )
}

function insertionModeOf(metadata: EntryMetadata, mediaId: string): unknown {
  const media = metaField(metadata, 'media')
  if (!Array.isArray(media)) return null
  const row: unknown = media.find((m: unknown) => isRecord(m) && m.id === mediaId)
  return isRecord(row) ? row.insertion_mode : null
}

/**
 * The synced state shows this frame-3 intent's VALUE (see the header). `synced`: the visible
 * synced metadata of an entry, or null (not loaded or hidden: not reflected, the ack decides).
 */
function isReflectedV3(
  intent: OutboxIntentV3,
  taxonomy: RetentionV2['taxonomy'],
  tombstones: ReadonlySet<string>,
  synced: (entryId: string) => EntryMetadata | null,
): boolean {
  switch (intent.kind) {
    case 'upsert_tag': {
      const tag = taxonomy.tags?.find((t) => t.id === intent.tag_id)
      return tag !== undefined && tag.name === intent.name && tag.color === intent.color
    }
    case 'upsert_journal': {
      const journal = taxonomy.journals?.find((j) => j.id === intent.journal_id)
      const autoTags = taxonomy.autoTagIds
      if (journal === undefined || autoTags === undefined) return false
      const current = Object.hasOwn(autoTags, intent.journal_id) ? autoTags[intent.journal_id] : []
      return (
        journal.name === intent.name &&
        journal.color === intent.color &&
        sameIds(current, intent.auto_tag_ids)
      )
    }
    case 'upsert_template':
      return isTemplateReflected(intent, taxonomy)
    case 'delete_template':
      return taxonomy.deletedTemplateIds.includes(intent.template_id)
    case 'trash_entry':
      return tombstones.has(intent.entry_id)
    case 'set_entry_location': {
      const metadata = synced(intent.entry_id)
      return metadata !== null && sameLocation(metadata, intent.value)
    }
    case 'set_media_insertion_mode': {
      const metadata = synced(intent.entry_id)
      return metadata !== null && insertionModeOf(metadata, intent.media_id) === intent.mode
    }
    // Destructive kinds resolve by ack only. The desktop rewrites persona text, and an attach
    // has no value of its own beyond its target: both by ack only too. A restore too: a synced
    // copy that predates the trash (or an index not re-pulled since) looks live, and dropping the
    // restore on it would release the entry draft it holds before the desktop applied it.
    case 'restore_entry':
    case 'purge_entry':
    case 'empty_trash':
    case 'delete_journal':
    case 'delete_tag':
    case 'delete_media':
    case 'delete_memory_item':
    case 'update_persona':
    case 'attach_media':
      return false
  }
}

/** A `create_journal`, or an `upsert_journal` without a base (a create too). */
function isJournalCreate(
  intent: OutboxIntentV2 | OutboxIntentV3,
): intent is Extract<
  OutboxIntentV2 | OutboxIntentV3,
  { kind: 'create_journal' | 'upsert_journal' }
> {
  return (
    intent.kind === 'create_journal' ||
    (intent.kind === 'upsert_journal' && intent.base_updated_at === null)
  )
}

/** The name a notice shows, when the intent carries one. */
function titleOf(intent: OutboxIntentV2 | OutboxIntentV3): string | undefined {
  return 'name' in intent && intent.name !== '' ? intent.name : undefined
}

async function forgetV2(deps: RetentionDeps, key: string): Promise<void> {
  await deps.db.meta.delete(`${PUSHED_AT}${key}`)
  await deps.db.meta.delete(`${WAITING}${key}`)
  await deps.db.meta.delete(`${REQUEUED}${key}`)
}

function listsMedia(metadata: EntryMetadata | null, mediaId: string): boolean {
  const media = metadata === null ? null : metaField(metadata, 'media')
  return Array.isArray(media) && media.some((m: unknown) => isRecord(m) && m.id === mediaId)
}

/**
 * An `i-` refused `absent` that must not resolve yet (attached paste, see the header): kept while
 * a stored entry draft still lists its media; once the synced entry lists it, sealed again and
 * stored unpushed, once per revision and at most `MAX_REQUEUES` times per `i-` key. False: the
 * refusal is final (the bound is used up, or neither lists the media).
 */
async function keepAbsentMode(
  deps: RetentionDeps,
  draft: DraftRecord,
  intent: Extract<OutboxIntentV3, { kind: 'set_media_insertion_mode' }>,
  hash: string,
  ctx: V2Context,
  synced: EntryMetadata | null,
): Promise<boolean> {
  const key = draft.entryId
  if (!listsMedia(synced, intent.media_id))
    return ctx.pendingMedia(intent.entry_id, intent.media_id)
  if (!(await claimRequeue(deps, key, hash))) return false
  const requeued = await withDraftLock(key, () =>
    deps.db.drafts.requeue(
      key,
      draft.sealed,
      deps.core.sealOutboxIntentV3(deps.ring, JSON.stringify(intent)),
    ),
  )
  if (requeued) noteDraftRequeued(key)
  return true
}

/** A stored entry draft moving its entry into a journal (`V2Context.movedInto`). */
interface MovedEntry {
  entryId: string
  title: string
}

interface V2Context {
  webId: string
  acksByDevice: ReadonlyMap<string, OutboxAcksV1>
  allAcks: OutboxAcksV1[]
  slotDesktops: readonly string[]
  /** Web-created entries whose entry draft was stored when this pass began. */
  webCreated: ReadonlySet<string>
  /** A stored entry draft of `entryId` lists `mediaId` (or does not open). */
  pendingMedia: (entryId: string, mediaId: string) => boolean
  /** The stored entry drafts moving an entry into this journal (title '' when untitled). */
  movedInto: (journalId: string) => MovedEntry[]
  /** Filled by the pass: the blobs a dropped `a-` kept (`resolvedBlobs`), spared by the sweep. */
  keptBlobs: Set<string>
}

/**
 * The outbox blobs a resolved draft drops with it (README "Web push order"): an `a-` draft's
 * `m-<mediaId>`, attach or delete, applied or refused (`media_deleted` included: the id is
 * tombstoned on the desktop for good). Except an attach refused `absent` on an entry this browser
 * created: the desktop may have read the `a-` before that entry's `.bin`, so the bytes stay.
 */
function resolvedBlobs(
  intent: OutboxIntentV2 | OutboxIntentV3,
  outcome: { kind: 'applied' } | { kind: 'refused'; reason: string },
  webCreated: ReadonlySet<string>,
): string[] {
  if (intent.kind !== 'attach_media' && intent.kind !== 'delete_media') return []
  if (
    intent.kind === 'attach_media' &&
    outcome.kind === 'refused' &&
    outcome.reason === 'absent' &&
    webCreated.has(intent.entry_id)
  ) {
    return []
  }
  return [
    `${OUTBOX_BLOB_PREFIX}m-${intent.media_id}`,
    `${OUTBOX_BLOB_PREFIX}m-${intent.media_id}.thumb`,
  ]
}

async function retainV2(
  deps: RetentionDeps,
  drafts: readonly DraftRecord[],
  ctx: V2Context,
  result: RetentionResult,
): Promise<void> {
  const v2 = deps.v2
  if (v2 === undefined) return
  const v2Capable = ctx.slotDesktops.filter((d) => v2.desktops.has(d))
  const slots = deps.desktops.slots
  const synced = (entryId: string): EntryMetadata | null => {
    const view = deps.vault.getSynced(entryId)
    return view.status === 'visible' ? view.metadata : null
  }
  // Media this browser deletes (an `a-` delete_media of this pass): the desktop applies the
  // delete (rank 40) before an `i-` pushed earlier (rank 45), whose `absent` is then no news.
  const deletedHere = new Set<string>()
  for (const draft of drafts) {
    const opened = openNonEntry(deps, draft)
    if (opened?.intent.kind === 'delete_media') deletedHere.add(opened.intent.media_id)
  }
  for (const draft of drafts) {
    const opened = openNonEntry(deps, draft)
    if (opened === null) continue
    const { intent } = opened
    const capableAll =
      opened.version === 2
        ? v2Capable
        : ctx.slotDesktops.filter((d) => v2.kindDesktops?.get(d)?.has(intent.kind) === true)
    const key = draft.entryId
    const now = deps.nowSecs()
    const hash = await sha256Hex(draft.sealed)
    const since =
      draft.pushedHash === hash ? await deps.db.drafts.recordPushedAt(key, hash, now) : null
    if (draft.pushedHash === hash && since === null) continue // unmarked meanwhile: keep
    if (since !== null) {
      const capable = capableAll.filter(
        (d) => ctx.acksByDevice.has(d) || now - since < UNDECIDED_GRACE_SECS,
      )
      const reflected =
        opened.version === 2
          ? isReflectedV2(opened.intent, v2.taxonomy, deps.desktops.tombstones)
          : isReflectedV3(opened.intent, v2.taxonomy, deps.desktops.tombstones, synced)
      const outcome = reflected
        ? ({ kind: 'applied' } as const)
        : resolveV2Ack({
            allAcks: ctx.allAcks,
            intentPath: ackIntentPath(ctx.webId, key),
            contentHash: hash,
            capableDesktops: capable,
            frame: opened.version,
          })
      const absentMode =
        intent.kind === 'set_media_insertion_mode' &&
        outcome.kind === 'refused' &&
        outcome.reason === 'absent' &&
        !deletedHere.has(intent.media_id)
      if (
        absentMode &&
        (await keepAbsentMode(deps, draft, intent, hash, ctx, synced(intent.entry_id)))
      ) {
        continue
      }
      if (outcome.kind !== 'pending') {
        const blobs = resolvedBlobs(intent, outcome, ctx.webCreated)
        if (await deps.db.drafts.dropPushed(key, draft.sealed, hash, blobs)) {
          if (intent.kind === 'attach_media' && blobs.length === 0) {
            for (const p of mediaPaths([intent])) ctx.keptBlobs.add(p)
          }
          await forgetV2(deps, key)
          result.dropped.push(key)
          result.changed = true
          const deletedMode =
            intent.kind === 'set_media_insertion_mode' &&
            outcome.kind === 'refused' &&
            outcome.reason === 'absent' &&
            deletedHere.has(intent.media_id)
          if (outcome.kind === 'refused' && !deletedMode) {
            const title = titleOf(intent)
            const base = { field: intent.kind, title, reason: outcome.reason }
            // A journal create with entries moved into it: one note per entry says both.
            const moved = isJournalCreate(intent) ? ctx.movedInto(intent.journal_id) : []
            if (moved.length === 0) result.notices.push(formatNotice('refused', base))
            for (const { entryId, title: entry } of moved) {
              if (isJournalCreate(intent)) toldJournals.add(`${intent.journal_id}:${entryId}`)
              result.notices.push(formatNotice('refused', { ...base, entry }))
            }
          }
        }
        continue
      }
    }
    if (capableAll.length > 0) continue
    // A slotted desktop whose manifest this pull could not read may advertise the kind.
    if (opened.version === 3 && [...(v2.degraded ?? [])].some((d) => slots?.has(d) === true)) {
      continue
    }
    // Persist first, so the notice is never repeated.
    const waitingKey = `${WAITING}${key}`
    if ((await deps.db.meta.get(waitingKey)) !== undefined) continue
    await deps.db.meta.put({ key: waitingKey, value: true })
    result.notices.push(
      formatNotice(opened.version === 2 ? 'waiting_newer_desktop' : 'waiting_desktop_update', {
        field: intent.kind,
        title: titleOf(intent),
      }),
    )
  }
}
