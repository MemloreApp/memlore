/**
 * Push: uploads the unpushed drafts to this device's outbox (Phase 16.5).
 *
 * `pushAll()` is the web companion's only write path after onboarding. Every upload goes through
 * `safeUpload` (write flag, clock, fence, format guard, allowlist, seal-then-verify, under the Web
 * Lock); the one other write is `safeEnsureOutboxFolder` (`<webId>` and `<webId>/outbox` only),
 * once per session, behind the same checks. Push deletes nothing, on Drive or in IndexedDB; only
 * `retention.ts` drops pushed drafts from IndexedDB, and nothing ever deletes on Drive.
 *
 * Session (one per unlock, dropped by the lock hook):
 *  - `ExpectedVaultState` comes from the device record (`recoveryGeneration`, `masterFingerprint`)
 *    and the `_meta.json` text cached pinned at onboarding (`epoch`, `contentEpoch`). Missing,
 *    unparsable or disagreeing with the record: `MissingVaultStateError` (re-onboard). A fresh read
 *    of `_meta.json` is never trusted as "expected": the fence compares against it.
 *  - One writer with `{ownId: deviceId, localGen: recoveryGeneration}`.
 *
 * A run, for each unpushed draft (oldest `updatedAt` first): open it, open its outbox media and
 * thumbs from `blobs` (the seal-then-verify plaintext), pack, `DraftManager.flush`.
 *  - Draft or media that cannot be opened, or missing outbox media: that entry is skipped (logged,
 *    kept). Seal-then-verify failure (`SealVerifyError`): that entry is skipped. A draft whose
 *    stored bytes changed before its batch got the lock (another tab saved it): skipped, unmarked,
 *    nothing written; the newer draft is pushed by the run its save triggered.
 *  - Anything else (write flag, fence, clock, format guard, Drive errors, a lock): the run stops,
 *    every remaining draft stays unpushed, and the error is returned as `error`.
 *
 * `pushAll()` never rejects. Locked: a no-op (`{pushed: 0, skipped: 0, pending: 0}`). Cached write
 * flag off: returns without touching Drive. Single-flight per tab: a call during a run returns ONE
 * shared follow-up run, so a save made during a push is pushed by it. The Web Lock serializes tabs.
 *
 * Outbox v2 / v3 (Phase 20.3, web gap audit Phase 10.1): a non-entry draft holds sealed frame-2
 * (pre-upgrade) or frame-3 bytes and is uploaded as-is under its letter-id stem (`j-<id>.bin`,
 * `d-empty-trash.bin`, …; safeUpload re-opens it with `openOutboxIntent` and checks the frame). Its
 * stored kind must be the one its body implies (`draftKindOfIntent`), else it is skipped. Entry
 * drafts are untouched: the same v1 bytes under `<entryId>.bin`. These rules keep drafts queued
 * (counted in `held` and `pending`, never `skipped`, nothing written for them):
 *  - per kind (Phase 9.3): a frame-2 draft while no slot-holding desktop advertises
 *    `outbox_versions ∋ 2` (`outboxV2Capable`), a frame-3 draft while no desktop advertises its
 *    body kind in `outbox_kinds` (`kindsAdvertised`);
 *  - entry dependency (Phase 9.3): a draft targeting an entry (`d-` trash / purge, `l-`, `a-`,
 *    `i-`; `entryTargetOf`) while that entry was created on this browser and its `<E>.bin` has not
 *    resolved: its entry draft is still stored and the pulled index does not show the entry. The
 *    desktop can skip `<E>.bin` for a cycle and still read the later file, which it would then
 *    refuse for good (`absent`). Retention drops the entry draft once it resolves (refused,
 *    reflected); the index shows an applied one. Inverted for a restore: the entry draft `<E>`
 *    waits while a restore `d-<E>` is stored, pushed or not, so the restore lands first and the
 *    edit waits until it resolves (retention drops a restore on its own ack only, applied or
 *    refused);
 *  - media dependency (Phase 13 review): an `a-` draft (a `delete_media`) while a stored entry
 *    draft (pushed or not) of its target lists its media, i.e. an image pasted into an entry,
 *    synced or not, that only that draft's `.bin` brings to the desktop. Read first, the delete
 *    applies as "already gone" before the `.bin` creates the media. Retention drops the entry
 *    draft once it resolves. Likewise (Phase 14) an `i-` draft while an `a-` draft of its media is
 *    stored (an attach not resolved yet: retention drops it on its ack). An `l-` needs no such
 *    hold: location is not a v1 entry field and a synced entry exists on the desktop in any order
 *    (the own-apply chain absorbs either order);
 *  - attached paste (stability 2, task 3.2): an `i-` draft whose media the stored entry draft of
 *    its target lists rides behind that draft instead of waiting for it to resolve: it is held
 *    while that entry draft is held, and otherwise uploads after the entry drafts of the run, only
 *    if that entry draft is no longer unpushed at its turn (pushed now or earlier). That listing is
 *    its only entry wait, even on an entry created on this browser (the create is the same
 *    `.bin`). The desktop applies `<E>.bin` before the `i-` in one cycle; an `i-` it still refuses
 *    `absent` (read alone, or a v1 it could not apply yet) is re-queued by retention once the
 *    synced entry lists the media;
 *  - an `attach_media` draft uploads its blob `m-<mediaId>` then `a-<mediaId>.bin` in one batch
 *    (Phase 14, no thumbnail). Its record's `targetEntryId` holds it like any `a-` draft above;
 *  - hold-back: an entry draft whose `journal_id` or `tags_add` names a journal / tag this browser
 *    created (a journal or tag draft is still stored, pushed or not) that the pulled `journals/` /
 *    `tags.bin` do not show yet. So no desktop ever reads the entry before the create, whose
 *    absence it would refuse for good (`journal_not_found` / `tag_not_found`). A held draft is
 *    retried by the next push (every interval pull requests one while drafts are pending);
 *  - hold-back of a journal create (v2 `create_journal`, v3 `upsert_journal` without a base) whose
 *    `auto_tag_ids` name a tag this browser created that the pulled `tags.bin` does not show yet:
 *    the desktop silently drops an unknown auto tag;
 *  - a trash or purge draft `d-<E>` while an entry draft `<E>` is still unpushed after this run's
 *    entry uploads (held, failed or skipped). Trash, purge and empty_trash drafts (and riding
 *    `i-` drafts, above) upload after every entry draft of a run. A desktop refuses a trash of an
 *    entry it does not have for good (`absent`), and that entry would then appear live. (Its importer applies `<E>.bin` before `d-<E>.bin` in one cycle.)
 *
 * Heavy modules are imported lazily by the default env, so importing this file has no side effects.
 */

import { openOutboxIntent, type Core } from '../../core/core'
import { getCachedWriteFlag } from '../config'
import type { DriveReader, DriveWriterDeps } from '../drive/client'
import { createDraftManager, type DraftManager } from '../drafts'
import { ERROR_NAMES } from '../errorNames'
import { VaultLockedError, getKeyRing, isUnlocked, onLock, type KeyRing } from '../keys'
import { isEntryId, outboxIntentPath, outboxMediaPath } from '../drive/paths'
import {
  OUTBOX_BLOB_PREFIX,
  draftKind,
  draftTargetId,
  type DraftRecord,
  type WebDb,
} from '../storage/idb'
import type { ExpectedVaultState } from './fence'
import { META_PATH, parseMetaText, readVersions, type MetaState } from './onboard'
import { packOutboxUploadIntents, type OutboxEntryV1 } from './outbox'
import {
  SealVerifyError,
  createOutboxWriter,
  draftKindOfIntent,
  intentTarget,
  openIntentBody,
  safeEnsureOutboxFolder,
  type OpenedNonEntryIntent,
  type SafeUploadDeps,
  type SafeUploadIntent,
} from './safeUpload'

export interface PushResult {
  /** Drafts uploaded by this run. */
  pushed: number
  /** Drafts this run skipped (cannot be opened, missing media, seal-then-verify, stale). Kept. */
  skipped: number
  /** Unpushed drafts after the run. */
  pending: number
  /** Drafts kept queued by the v2 capability, hold-back or trash rule (see the header). Absent: none. */
  held?: number
  /**
   * Of `held`, the frame-3 drafts no slot-holding desktop advertises the kind of: they wait for a
   * desktop update, not for an earlier change. Absent: none.
   */
  heldUpdate?: number
  /** Why the run stopped early. Every draft not yet pushed is kept. */
  error?: unknown
}

/** The cached vault state cannot build a fence: the user must re-onboard this browser. */
export class MissingVaultStateError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(
      `Cannot push web edits: ${detail}. Reconnect Google Drive and re-onboard this browser with the recovery phrase.`,
      { cause },
    )
    this.name = ERROR_NAMES.missingVaultState
  }
}

export interface PushDeps {
  db: WebDb
  reader: DriveReader
  core: Core
  /** Transport for the session's writer (token, fetch, locks). */
  driveDeps: DriveWriterDeps
  /** Default `fetchWriteFlag` (inside `safeUpload`). */
  fetchWriteFlagImpl?: () => Promise<boolean>
  revalidatePull?: () => Promise<void> | void
  /**
   * The v2 capability and the reflected taxonomy, read only when some draft is a v2 draft.
   * Absent or failing: no capability and nothing reflected (fail-closed: v2 and dependent entry
   * drafts stay queued).
   */
  v2State?: () => Promise<V2PushState>
}

/** What the pulled cloud says, for the v2 rules (see the header). */
export interface V2PushState {
  /** Some slot-holding desktop advertises `outbox_versions ∋ 2` (`Puller.v2Desktops`). */
  outboxV2Capable: boolean
  /** Journal ids in the pulled `journals/`, any state (`Taxonomy.knownJournalIds`). */
  journalIds: ReadonlySet<string>
  /** Live tag ids in the pulled `tags.bin`. */
  tagIds: ReadonlySet<string>
  /** Outbox v3 kinds some slotted desktop advertises (`ReadSession.kindsAdvertised`). */
  kindsAdvertised: ReadonlySet<string>
  /**
   * Entry ids the synced state shows (the index lists, live or in the desktop Trash, plus every
   * loaded synced copy of an own draft's entry): a web create there resolved.
   */
  syncedEntryIds: ReadonlySet<string>
  /** Media ids the synced copies of those entries list (`Vault.getSynced`, no overlay). */
  syncedMediaIds: ReadonlySet<string>
}

const NO_V2: V2PushState = {
  outboxV2Capable: false,
  journalIds: new Set(),
  tagIds: new Set(),
  kindsAdvertised: new Set(),
  syncedEntryIds: new Set(),
  syncedMediaIds: new Set(),
}

export interface PushEnv {
  isUnlocked: () => boolean
  /** The last fetched write flag (`getCachedWriteFlag`). Off: no Drive call at all. */
  cachedWriteFlag: () => boolean
  /** Built once per unlock. */
  deps: () => Promise<PushDeps>
}

function defaultEnv(): PushEnv {
  return { isUnlocked, cachedWriteFlag: getCachedWriteFlag, deps: buildDeps }
}

let injected: Partial<PushEnv> = {}
const pushEnv = (): PushEnv => ({ ...defaultEnv(), ...injected })

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configurePushEnv(partial: Partial<PushEnv>): void {
  injected = partial
  resetSession()
}

async function buildDeps(): Promise<PushDeps> {
  const [{ openWebDb }, { DriveReader }, { oauth }, { readEnv }, core] = await Promise.all([
    import('../storage/idb'),
    import('../drive/client'),
    import('../drive/oauth'),
    import('../commands/readSession'),
    import('../../core/core').then((m) => m.loadCore()),
  ])
  const driveDeps: DriveWriterDeps = {
    getToken: () => oauth.getAccessToken(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }
  return {
    db: await openWebDb(),
    reader: new DriveReader(driveDeps),
    core,
    driveDeps,
    // A fence refusal re-validates through the read session's pull (it never writes).
    revalidatePull: async () => {
      await (await readEnv().session()).pull()
    },
    v2State: async () => {
      const session = await readEnv().session()
      const taxonomy = await session.ready()
      const { vault } = session
      // The index lists hide a pending web trash; a loaded synced copy (retention loads every
      // entry with a draft) covers it.
      const indexed = [...vault.listIndex(), ...vault.listTrashedIndex()].map((e) => e.entryId)
      const loaded = vault
        .getOutboxIntents()
        .map((i) => i.entry_id)
        .filter((id) => vault.getSynced(id).status !== 'not-loaded')
      const syncedEntryIds = new Set([...indexed, ...loaded])
      const syncedMediaIds = new Set<string>()
      for (const id of syncedEntryIds) {
        const media: unknown = vault.getSynced(id).metadata?.media
        if (!Array.isArray(media)) continue
        for (const row of media as unknown[]) {
          if (typeof row !== 'object' || row === null) continue
          const mediaId: unknown = (row as { id?: unknown }).id
          if (typeof mediaId === 'string') syncedMediaIds.add(mediaId)
        }
      }
      return {
        outboxV2Capable: session.outboxV2Capable?.() ?? false,
        journalIds: new Set(taxonomy.knownJournalIds),
        tagIds: new Set(taxonomy.tags.map((t) => t.id)),
        kindsAdvertised: session.kindsAdvertised?.() ?? new Set(),
        syncedEntryIds,
        syncedMediaIds,
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Session (per unlock)
// ---------------------------------------------------------------------------------------------

interface Prepared {
  writer: SafeUploadDeps['writer']
  expected: ExpectedVaultState
  ownId: string
  localGen: number
}

interface PushSession {
  deps: PushDeps
  drafts: DraftManager
  /** Set once the vault state is validated and the writer built. */
  prepared: Prepared | null
  /** The outbox folder was ensured in this session. */
  folderReady: boolean
}

let session: Promise<PushSession> | null = null
let unhook: (() => void) | null = null
// Bumped by the lock hook: a run that started before a lock stops at its next step.
let epoch = 0

function resetSession(): void {
  epoch += 1
  session = null
  unhook?.()
  unhook = null
}

function getSession(): Promise<PushSession> {
  if (session === null) {
    unhook ??= onLock(resetSession)
    const building = pushEnv()
      .deps()
      .then((deps) => ({
        deps,
        drafts: createDraftManager({ db: deps.db }),
        prepared: null,
        folderReady: false,
      }))
    building.catch(() => {
      if (session === building) session = null
    })
    session = building
  }
  return session
}

/** Validates the cached vault state against the device record, then builds the writer. */
async function prepare(s: PushSession): Promise<Prepared> {
  if (s.prepared !== null) return s.prepared
  const { db, core, reader, driveDeps } = s.deps
  const record = await db.device.get()
  if (record === undefined) throw new MissingVaultStateError('this browser has no device record')
  const cached = await db.files.get(META_PATH)
  if (cached === undefined) throw new MissingVaultStateError('the cached _meta.json is missing')
  let meta: MetaState
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(cached.ciphertext)
    meta = parseMetaText(core, readVersions(core), text)
  } catch (error) {
    throw new MissingVaultStateError('the cached _meta.json cannot be parsed', error)
  }
  if (
    meta.masterFingerprint !== record.masterFingerprint ||
    meta.recoveryGeneration !== record.recoveryGeneration
  ) {
    throw new MissingVaultStateError('the cached _meta.json does not match this device')
  }
  const identity = { ownId: record.deviceId, localGen: record.recoveryGeneration }
  s.prepared = {
    writer: createOutboxWriter(reader, driveDeps, identity),
    expected: {
      recoveryGeneration: record.recoveryGeneration,
      masterFingerprint: record.masterFingerprint,
      epoch: meta.epoch,
      contentEpoch: meta.contentEpoch,
    },
    ...identity,
  }
  return s.prepared
}

function uploadDeps(s: PushSession, p: Prepared, ring: KeyRing): SafeUploadDeps {
  return {
    writer: p.writer,
    reader: s.deps.reader,
    core: s.deps.core,
    ring,
    localGen: p.localGen,
    ownDeviceId: p.ownId,
    expectedFence: p.expected,
    fetchWriteFlagImpl: s.deps.fetchWriteFlagImpl,
    revalidatePull: s.deps.revalidatePull,
  }
}

// ---------------------------------------------------------------------------------------------
// One draft
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openEntry(core: Core, ring: KeyRing, draft: DraftRecord): OutboxEntryV1 {
  const parsed = JSON.parse(core.openOutboxEntry(ring, draft.sealed)) as unknown
  if (
    !isRecord(parsed) ||
    parsed.entry_id !== draft.entryId ||
    !isRecord(parsed.fields) ||
    !Array.isArray(parsed.media)
  ) {
    throw new Error('not an outbox intent for this entry')
  }
  return parsed as unknown as OutboxEntryV1
}

/**
 * The upload intents of one v2 / v3 draft, or null (logged) when it must be skipped. An
 * `attach_media` draft packs its blob `m-<mediaId>` first, then `a-<mediaId>.bin` (README "Web
 * push order"; no `.thumb`): one batch, in that order, so the intent never lands without its
 * blob. A missing or unopenable blob skips the draft (kept), as for an entry draft.
 */
async function packV2Draft(
  s: PushSession,
  p: Prepared,
  ring: KeyRing,
  draft: DraftRecord,
): Promise<SafeUploadIntent[] | null> {
  try {
    const body = openIntentBody(s.deps.core, ring, draft.sealed)
    const { prefix, id } = intentTarget(body.intent)
    // The key names the body's letter and id, as the desktop requires of the file name, and the
    // stored kind is the body's (a mis-kinded record is never routed as another kind).
    if (
      draft.entryId !== `${prefix}-${id}` ||
      draftKind(draft) !== draftKindOfIntent(body.intent)
    ) {
      throw new Error('not an intent for this draft')
    }
    const intended: SafeUploadIntent['intended'] =
      body.version === 2
        ? { kind: 'intent_v2', intent: body.intent }
        : { kind: 'intent_v3', intent: body.intent }
    const blob: SafeUploadIntent[] = []
    if (body.intent.kind === 'attach_media') {
      const mediaId = body.intent.media_id
      const media = await openBlob(s, ring, `${OUTBOX_BLOB_PREFIX}m-${mediaId}`)
      blob.push({
        path: outboxMediaPath(p.ownId, p.localGen, mediaId),
        bytes: media.sealed,
        intended: { kind: 'media', plaintext: media.plain },
      })
    }
    return [
      ...blob,
      { path: outboxIntentPath(p.ownId, p.localGen, prefix, id), bytes: draft.sealed, intended },
    ]
  } catch (error) {
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Skipping draft ${draft.entryId}: it cannot be pushed yet (${reason})`)
    return null
  }
}

/** The sealed outbox blob at `path` and its plaintext (throws when missing or unopenable). */
async function openBlob(
  s: PushSession,
  ring: KeyRing,
  path: string,
): Promise<{ sealed: Uint8Array; plain: Uint8Array }> {
  const rec = await s.deps.db.blobs.get(path)
  if (rec === undefined) throw new Error(`outbox media ${path} is missing`)
  return { sealed: rec.bytes, plain: s.deps.core.openMedia(ring, rec.bytes) }
}

/** The upload intents of one draft, or null (logged) when it must be skipped. */
async function packDraft(
  s: PushSession,
  p: Prepared,
  ring: KeyRing,
  draft: DraftRecord,
): Promise<SafeUploadIntent[] | null> {
  try {
    const entry = openEntry(s.deps.core, ring, draft)
    // `<id>.bin` must parse as an entry on the desktop: an id shaped like an intent stem would be
    // refused by the allowlist (stopping the run) or read as a corrupt intent, so it is skipped.
    if (!isEntryId(entry.entry_id)) throw new RangeError('entry id cannot name an outbox file')
    const sealedMediaMap = new Map<string, Uint8Array>()
    const plainMediaMap = new Map<string, Uint8Array>()
    const sealedThumbMap = new Map<string, Uint8Array>()
    const plainThumbMap = new Map<string, Uint8Array>()
    // Every ref must be present BEFORE packing: the packer silently drops incomplete media, and a
    // `.bin` must never land without the media it references.
    for (const ref of entry.media) {
      const id = ref.media_id
      const media = await openBlob(s, ring, `${OUTBOX_BLOB_PREFIX}m-${id}`)
      sealedMediaMap.set(id, media.sealed)
      plainMediaMap.set(id, media.plain)
      if (ref.has_thumb) {
        const thumb = await openBlob(s, ring, `${OUTBOX_BLOB_PREFIX}m-${id}.thumb`)
        sealedThumbMap.set(id, thumb.sealed)
        plainThumbMap.set(id, thumb.plain)
      }
    }
    return packOutboxUploadIntents({
      localGen: p.localGen,
      ownDeviceId: p.ownId,
      entry,
      sealedEntryBytes: draft.sealed,
      sealedMediaMap,
      plainMediaMap,
      sealedThumbMap,
      plainThumbMap,
    })
  } catch (error) {
    // Log the error name only: a JSON.parse message can quote decrypted text.
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Skipping draft ${draft.entryId}: it cannot be pushed yet (${reason})`)
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// v2 capability and hold-back
// ---------------------------------------------------------------------------------------------

async function readV2State(s: PushSession): Promise<V2PushState> {
  if (s.deps.v2State === undefined) return NO_V2
  try {
    return await s.deps.v2State()
  } catch (error) {
    if (error instanceof VaultLockedError) throw error
    return NO_V2
  }
}

/** Does this entry draft name a journal / tag created on this browser and not reflected yet? */
function isHeldBack(
  core: Core,
  ring: KeyRing,
  draft: DraftRecord,
  created: { journals: ReadonlySet<string>; tags: ReadonlySet<string> },
  state: V2PushState,
): boolean {
  let entry: OutboxEntryV1
  try {
    entry = openEntry(core, ring, draft)
  } catch {
    return false // `packDraft` logs and skips it
  }
  const journal = entry.fields.journal_id?.value
  if (journal !== undefined && created.journals.has(journal) && !state.journalIds.has(journal)) {
    return true
  }
  return Object.keys(entry.fields.tags_add).some(
    (tag) => created.tags.has(tag) && !state.tagIds.has(tag),
  )
}

/** The body of a non-entry draft (frame 2 or 3), or null when it does not open. */
type IntentBody = OpenedNonEntryIntent

function openBody(core: Core, ring: KeyRing, draft: DraftRecord): IntentBody | null {
  try {
    const opened = openOutboxIntent(core, ring, draft.sealed)
    return opened.version === 1 ? null : opened
  } catch {
    return null // `packV2Draft` logs and skips it
  }
}

/**
 * Per-kind capability (README "Per-kind capabilities"): a frame-2 draft needs a v2 desktop, a
 * frame-3 draft a desktop advertising its kind. A draft that does not open follows the v2 rule
 * (`packV2Draft` logs and skips it once it is not held).
 */
function isCapable(body: IntentBody | null, state: V2PushState): boolean {
  if (body?.version === 3) return state.kindsAdvertised.has(body.intent.kind)
  return state.outboxV2Capable
}

/**
 * Is this a journal create that auto-applies a tag created on this browser and not reflected yet?
 * The desktop drops an unknown auto tag id silently (`create_journal_with_id`), so it must wait.
 */
function isJournalHeldBack(
  body: IntentBody | null,
  createdTags: ReadonlySet<string>,
  state: V2PushState,
): boolean {
  const intent = body?.intent
  const creates =
    intent?.kind === 'create_journal' ||
    (intent?.kind === 'upsert_journal' && intent.base_updated_at === null)
  if (!creates) return false
  return intent.auto_tag_ids.some((tag) => createdTags.has(tag) && !state.tagIds.has(tag))
}

/** The `targetEntryId` of an `a-` / `i-` record, or null. */
function recordTargetEntryId(draft: DraftRecord): string | null {
  const value: unknown = draft.targetEntryId
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The entry an entry-targeting draft acts on (README "Web push order"): a STATIC map by key
 * letter, so a tab pushing drafts another tab saved never needs the module that saved them.
 * `undefined`: not entry-targeting. `null`: entry-targeting but the target is unknown (held).
 */
function entryTargetOf(draft: DraftRecord): string | null | undefined {
  const key = draft.entryId
  if (key === 'd-empty-trash') return undefined
  switch (key.slice(0, 2)) {
    case 'd-':
    case 'l-':
      return key.slice(2)
    case 'a-':
    case 'i-':
      return recordTargetEntryId(draft)
    default:
      return undefined
  }
}

/**
 * Splits the unpushed drafts into those this run may push and the number held (see the header).
 * The v2 state is read only when a non-entry draft exists, so a vault without any keeps today's
 * path.
 */
async function selectDrafts(
  s: PushSession,
  unpushed: readonly DraftRecord[],
): Promise<{
  ready: DraftRecord[]
  held: number
  heldUpdate: number
  /** Draft key -> the entry whose draft must be pushed before it (see `pushOnce`). */
  after: ReadonlyMap<string, string>
}> {
  const all = await s.deps.db.drafts.list()
  const createdOf = (kind: 'journal' | 'tag'): Set<string> =>
    new Set(all.filter((d) => draftKind(d) === kind).map(draftTargetId))
  const created = { journals: createdOf('journal'), tags: createdOf('tag') }
  const anyV2 = all.some((d) => draftKind(d) !== 'entry')
  if (!anyV2) return { ready: [...unpushed], held: 0, heldUpdate: 0, after: new Map() }
  const state = await readV2State(s)
  const ring = getKeyRing()
  const { core } = s.deps

  const bodies = new Map<string, IntentBody | null>()
  const bodyOf = (draft: DraftRecord): IntentBody | null => {
    if (!bodies.has(draft.entryId)) bodies.set(draft.entryId, openBody(core, ring, draft))
    return bodies.get(draft.entryId) ?? null
  }
  const isRestore = (draft: DraftRecord): boolean => draftKind(draft) === 'restore'
  const restoring = new Set(all.filter(isRestore).map((d) => d.entryId.slice(2)))
  const entryDrafts = new Map(
    all.filter((d) => draftKind(d) === 'entry').map((d) => [d.entryId, d] as const),
  )
  // An entry created on this browser whose `<E>.bin` has not resolved. A stored entry draft that
  // does not open counts (fail closed) unless the index already shows the entry.
  const unresolvedCreate = (entryId: string): boolean => {
    const draft = entryDrafts.get(entryId)
    if (draft === undefined || state.syncedEntryIds.has(entryId)) return false
    try {
      return openEntry(core, ring, draft).created_on_web
    } catch {
      return true
    }
  }
  const waitsForEntry = (draft: DraftRecord): boolean => {
    const target = entryTargetOf(draft)
    if (target === undefined || isRestore(draft)) return false
    // A pending restore of the target goes first, like its entry draft.
    return target === null || restoring.has(target) || unresolvedCreate(target)
  }
  // Does the stored entry draft of this `i-` / `a-` draft's target list its media (a paste not
  // applied yet)? A stored entry draft that does not open counts (fail closed) until the synced
  // copy lists the media (the desktop has it). An attach never names an entry draft's media.
  const listedByEntryDraft = (draft: DraftRecord): boolean => {
    const mediaId = draftTargetId(draft)
    const target = entryTargetOf(draft)
    const entryDraft = target == null ? undefined : entryDrafts.get(target)
    if (entryDraft === undefined) return false
    try {
      return openEntry(core, ring, entryDraft).media.some((m) => m.media_id === mediaId)
    } catch {
      return !state.syncedMediaIds.has(mediaId)
    }
  }
  // An `a-` (a delete) whose media its entry draft lists, an `i-` whose media a stored `a-` draft
  // still carries (an attach not resolved yet; key match, nothing opened). Read first, the desktop
  // applies the delete as "already gone" and then creates the media from the entry draft, or
  // refuses the `i-` `absent`.
  const keys = new Set(all.map((d) => d.entryId))
  const waitsForMedia = (draft: DraftRecord): boolean => {
    const kind = draftKind(draft)
    if (kind === 'insertion_mode') return keys.has(`a-${draftTargetId(draft)}`)
    return kind === 'media' && listedByEntryDraft(draft)
  }
  // An `i-` whose media its entry draft lists rides behind that draft (see the header): that
  // listing is its only entry wait, even on an entry created here (the create is the same `.bin`).
  const ridesEntryDraft = (draft: DraftRecord): boolean =>
    draftKind(draft) === 'insertion_mode' &&
    !restoring.has(entryTargetOf(draft) ?? '') &&
    listedByEntryDraft(draft)

  const ready: DraftRecord[] = []
  const heldEntries = new Set<string>()
  // Draft key -> the entry whose draft it must follow in this run (trash, riding `i-`).
  const after = new Map<string, string>()
  let heldUpdate = 0
  for (const draft of unpushed) {
    const kind = draftKind(draft)
    const incapable = kind !== 'entry' && !isCapable(bodyOf(draft), state)
    if (incapable && bodyOf(draft)?.version === 3) heldUpdate += 1
    const rides = !incapable && ridesEntryDraft(draft)
    const hold =
      kind === 'entry'
        ? restoring.has(draft.entryId) || isHeldBack(core, ring, draft, created, state)
        : incapable ||
          isJournalHeldBack(bodyOf(draft), created.tags, state) ||
          (!rides && waitsForEntry(draft)) ||
          waitsForMedia(draft)
    if (!hold) ready.push(draft)
    else if (kind === 'entry') heldEntries.add(draft.entryId)
    if (!hold && rides) after.set(draft.entryId, entryTargetOf(draft) ?? '')
  }
  // A trash or purge waits for its held entry draft; the rest of the trash goes after every entry.
  for (const d of ready) {
    const kind = draftKind(d)
    if (kind === 'trash' || kind === 'purge' || kind === 'empty_trash') {
      after.set(d.entryId, draftTargetId(d))
    }
  }
  const last = ready.filter((d) => after.has(d.entryId))
  const pushable = [
    ...ready.filter((d) => !after.has(d.entryId)),
    ...last.filter((d) => !heldEntries.has(after.get(d.entryId) ?? '')),
  ]
  return { ready: pushable, held: unpushed.length - pushable.length, heldUpdate, after }
}

/** Entry ids with an unpushed entry draft right now. */
async function unpushedEntryIds(s: PushSession): Promise<Set<string>> {
  const unpushed = await s.drafts.listUnpushedDrafts()
  return new Set(unpushed.filter((d) => draftKind(d) === 'entry').map((d) => d.entryId))
}

// ---------------------------------------------------------------------------------------------
// pushAll
// ---------------------------------------------------------------------------------------------

async function pending(s: PushSession): Promise<number> {
  return (await s.drafts.listUnpushedDrafts()).length
}

async function pushOnce(): Promise<PushResult> {
  const env = pushEnv()
  if (!env.isUnlocked()) return { pushed: 0, skipped: 0, pending: 0 }
  const started = epoch
  const assertSameEpoch = (): void => {
    if (started !== epoch) throw new VaultLockedError()
  }
  let pushed = 0
  let skipped = 0
  let held = 0
  let heldUpdate = 0
  let s: PushSession | null = null
  const withHeld = (r: PushResult): PushResult => ({
    ...r,
    ...(held > 0 ? { held } : {}),
    ...(heldUpdate > 0 ? { heldUpdate } : {}),
  })
  try {
    s = await getSession()
    assertSameEpoch()
    if (!env.cachedWriteFlag()) return { pushed, skipped, pending: await pending(s) }
    const unpushed = [...(await s.drafts.listUnpushedDrafts())].sort(
      (a, b) => a.updatedAt - b.updatedAt,
    )
    if (unpushed.length === 0) return { pushed, skipped, pending: 0 }
    const selected = await selectDrafts(s, unpushed)
    assertSameEpoch()
    held = selected.held
    heldUpdate = selected.heldUpdate
    const drafts = selected.ready
    if (drafts.length === 0) return withHeld({ pushed, skipped, pending: await pending(s) })
    const p = await prepare(s)
    assertSameEpoch()
    if (!s.folderReady) {
      await safeEnsureOutboxFolder(uploadDeps(s, p, getKeyRing()))
      assertSameEpoch()
      s.folderReady = true
    }
    let unpushedEntries: Set<string> | null = null
    for (const draft of drafts) {
      assertSameEpoch()
      const follows = selected.after.get(draft.entryId)
      if (follows !== undefined) {
        // Every entry draft of this run is done (these go last): is the target's still pending?
        unpushedEntries ??= await unpushedEntryIds(s)
        if (unpushedEntries.has(follows)) {
          held += 1
          continue
        }
      }
      const ring = getKeyRing()
      const intents =
        draftKind(draft) === 'entry'
          ? await packDraft(s, p, ring, draft)
          : await packV2Draft(s, p, ring, draft)
      if (intents === null) {
        assertSameEpoch() // a lock zeroizes the ring, so the open failed: stop, do not skip
        skipped += 1
        continue
      }
      try {
        const outcome = await s.drafts.flush(
          draft.entryId,
          intents,
          uploadDeps(s, p, ring),
          draft.sealed,
        )
        if (outcome === 'pushed') {
          pushed += 1
        } else {
          console.warn(`Skipping draft ${draft.entryId}: it changed before its upload`)
          skipped += 1
        }
      } catch (error) {
        if (!(error instanceof SealVerifyError)) throw error
        assertSameEpoch() // a lock mid-batch zeroizes the ring: report locked, not a bad draft
        console.warn(`Skipping draft ${draft.entryId}: seal-then-verify failed`)
        skipped += 1
      }
    }
    return withHeld({ pushed, skipped, pending: await pending(s) })
  } catch (error) {
    const left = s === null ? 0 : await pending(s).catch(() => 0)
    return withHeld({ pushed, skipped, pending: left, error })
  }
}

let running: Promise<PushResult> | null = null
let followUp: Promise<PushResult> | null = null

function launch(): Promise<PushResult> {
  const run = pushOnce().finally(() => {
    if (running === run) running = null
  })
  running = run
  return run
}

/**
 * Pushes every unpushed draft. Never rejects (see the header). A call during a run returns the
 * one shared follow-up run, which starts when the current run settles.
 */
export function pushAll(): Promise<PushResult> {
  if (running === null) return launch()
  followUp ??= running.then(() => {
    followUp = null
    return running ?? launch()
  })
  return followUp
}
