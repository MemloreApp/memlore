/**
 * Drafts Queue and Lifecycle Management (Phase 16.1, retention Phase 16.5).
 *
 *  - Stores sealed ciphertext in IndexedDB (`db.drafts`). A draft is an entry intent (v1, keyed by
 *    entry id; records without `kind` are entry drafts) or one v2 intent (Phase 20.2: journal, tag,
 *    template, trash; keyed `[jtpd]-<id>`). The entry overlay reads `listEntryDrafts` only.
 *  - A draft is KEPT after its upload and marked pushed (`pushedHash`): the overlay is rebuilt
 *    from every draft after a reload, so a pushed-but-unimported edit is never rebuilt from synced
 *    state. Pushed drafts are dropped by the 16.1 retention rule (`sync/retention.ts`).
 *  - "Dirty" = some draft whose `pushedHash` is missing or is not the hash of its `sealed`.
 *  - Provides `beforeunload` warning when there are unpushed drafts, or an editor content save
 *    that failed (`unsavedIds`, set and cleared by content saves only, `saveContentDraft` or
 *    `saveEntryDraft` with `content`, a failure before the put included: the body text is only
 *    in this tab's RAM; a metadata save reseals from the prior intent, so it neither arms nor
 *    clears it). Held drafts (push.ts: waiting
 *    for a desktop that imports outbox v2, or for an earlier draft) count too, on purpose: they are
 *    safe in IndexedDB but exist nowhere else yet, so clearing site data or closing a private
 *    window still loses them. The sync status explains them as waiting, not failed.
 *  - Notifies `onDraftSaved` listeners after every stored draft (the debounced push trigger in
 *    `commands/sync.ts`), so the write commands need no push call of their own.
 *  - Dispatches uploads via `safeUpload`.
 *  - Entry drafts are read-merge-written (`saveEntryDraft`, review C2): under the per-entry Web Lock
 *    the stored draft is re-read and merged with this tab's in-RAM intent before the new intent is
 *    built, so a tab whose intent is stale never overwrites another tab's save. v2 drafts (`[jtpd]-`
 *    keys) stay latest-wins per key. change_seq needs no cross-tab care: `allocateChangeSeq` is one
 *    IndexedDB transaction on the shared device record, so it is monotonic across tabs.
 *  - A save refused by a full quota (`StorageQuotaError`) runs one `quota` evictor pass (it frees a
 *    share of the media/entry cache even under the cache budget, never drafts or outbox blobs),
 *    then retries at most `QUOTA_RETRY_DELAYS_MS.length` times with
 *    backoff, then rethrows: the terminal "storage full" state the editor shows. The next edit
 *    tries again the same bounded way; nothing loops on its own.
 */

import { maybeEvict } from './storage/evictor'
import {
  StorageQuotaError,
  draftKind,
  type DraftKind,
  type DraftRecord,
  type WebDb,
} from './storage/idb'
import { mergeOutboxIntents, withTextFromState, type OutboxEntryV1 } from './sync/outbox'
import { safeUpload, type SafeUploadDeps, type SafeUploadIntent } from './sync/safeUpload'
import { withDraftLock } from './tabs'

export interface DraftManagerDeps {
  db: WebDb
  /**
   * Frees cache space after a quota failure. Default: one `quota` evictor pass, which drops LRU
   * media/entry cache even under the cache budget and never drafts or outbox blobs.
   */
  evict?: () => Promise<unknown>
  /** Waits before a quota retry. Default: `setTimeout`. */
  delay?: (ms: number) => Promise<void>
}

/** Opens a sealed entry draft, or null when it cannot be opened (the caller logs). */
export type OpenEntryDraft = (
  sealed: Uint8Array,
) => OutboxEntryV1 | null | Promise<OutboxEntryV1 | null>

export interface SaveEntryDraftParams {
  /** This tab's in-RAM intent for the entry (`vault.getOutboxIntent`), or null. */
  mine: OutboxEntryV1 | null
  open: OpenEntryDraft
  seal: (intent: OutboxEntryV1) => Uint8Array
  /** Builds the new intent from the merged prior one. Runs under the lock. */
  build: (prior: OutboxEntryV1 | null) => Promise<OutboxEntryV1>
  /** The editor's content save (`saveContentDraft`), not a metadata save. */
  content?: boolean
}

/** JSON with sorted keys: an intent opened from bytes and the one that was sealed compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  )
}

/** The same intent, whatever its key order (no merge needed). */
export const sameIntent = (a: OutboxEntryV1, b: OutboxEntryV1): boolean =>
  canonical(a) === canonical(b)

/** Backoff before each retry of a save refused by the quota; its length is the retry bound. */
export const QUOTA_RETRY_DELAYS_MS = [100, 200, 400] as const

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, ms))

/** Lowercase SHA-256 hex of `bytes` (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function isUnpushed(rec: DraftRecord): Promise<boolean> {
  const hash: unknown = rec.pushedHash
  return typeof hash !== 'string' || hash !== (await sha256Hex(rec.sealed))
}

// Page-wide dirty state. `entries.ts` builds a new manager per command, so it cannot live on an
// instance. `saveGen` stamps every save, so a refresh or a flush that started before a save never
// clears the id that save made dirty.
const unpushedIds = new Set<string>()
const lastSaveGen = new Map<string, number>()
// Ids whose last content save failed: not in IndexedDB, so `#refresh` never touches this set.
const unsavedIds = new Set<string>()
// The newest save call per id: a quota retry of older bytes stops once a newer save started,
// so it can never overwrite the newer draft.
const lastAttempt = new Map<string, number>()
// The newest content save per id: only it may arm or clear the unsaved mark.
const lastContentAttempt = new Map<string, number>()
let attemptGen = 0
let saveGen = 0

const savedSince = (entryId: string, gen: number): boolean => (lastSaveGen.get(entryId) ?? 0) > gen

/** Records a new content save of `entryId` and returns its stamp. */
function stampContentAttempt(entryId: string): number {
  const attempt = ++attemptGen
  lastContentAttempt.set(entryId, attempt)
  return attempt
}

/** True when `contentAttempt` is the newest content save of `entryId` (false for null). */
const isLatestContentAttempt = (entryId: string, contentAttempt: number | null): boolean =>
  contentAttempt !== null && lastContentAttempt.get(entryId) === contentAttempt

const saveListeners = new Set<(entryId: string) => void>()

/**
 * Calls `listener` with the draft key (entry id, or a v2 `[jtpd]-` key) after every successful
 * `saveDraft`. Returns the unsubscribe function.
 */
export function onDraftSaved(listener: (entryId: string) => void): () => void {
  saveListeners.add(listener)
  return () => {
    saveListeners.delete(listener)
  }
}

export class DraftManager {
  readonly #db: WebDb
  readonly #evict: () => Promise<unknown>
  readonly #delay: (ms: number) => Promise<void>

  constructor(deps: DraftManagerDeps) {
    this.#db = deps.db
    this.#evict = deps.evict ?? (() => maybeEvict('quota'))
    this.#delay = deps.delay ?? defaultDelay
  }

  /**
   * `kind` absent: an entry draft. A v2 draft passes its kind and its prefixed key; an `a-` / `i-`
   * draft also passes the entry it acts on (`targetEntryId`, read by the push hold). Never touches
   * the unsaved mark: a failed metadata or v2 save has no text in RAM to lose.
   */
  saveDraft(
    entryId: string,
    sealed: Uint8Array,
    kind?: Exclude<DraftKind, 'entry'>,
    targetEntryId?: string,
  ): Promise<void> {
    return this.#save(entryId, sealed, kind, null, targetEntryId)
  }

  /**
   * The editor's content save of an entry draft. A failure arms the `beforeunload` guard (the body
   * text is only in the editor's RAM) until a later content save of that entry is stored.
   */
  saveContentDraft(entryId: string, sealed: Uint8Array): Promise<void> {
    return this.#save(entryId, sealed, undefined, stampContentAttempt(entryId), undefined)
  }

  /** `contentAttempt`: the content save's stamp (`stampContentAttempt`), null for any other save. */
  async #save(
    entryId: string,
    sealed: Uint8Array,
    kind: Exclude<DraftKind, 'entry'> | undefined,
    contentAttempt: number | null,
    targetEntryId: string | undefined,
  ): Promise<void> {
    const attempt = ++attemptGen
    lastAttempt.set(entryId, attempt)
    const latest = (): boolean => lastAttempt.get(entryId) === attempt
    const latestContent = (): boolean => isLatestContentAttempt(entryId, contentAttempt)
    try {
      await this.#putWithQuotaRetry(entryId, sealed, kind, targetEntryId, latest)
    } catch (error) {
      if (latestContent()) unsavedIds.add(entryId)
      throw error
    }
    if (latestContent()) unsavedIds.delete(entryId)
    saveGen += 1
    lastSaveGen.set(entryId, saveGen)
    unpushedIds.add(entryId)
    for (const listener of [...saveListeners]) listener(entryId)
  }

  /**
   * Builds and stores an entry draft without losing another tab's save (review C2). Under the
   * `memlore-draft:<entryId>` Web Lock: re-reads the stored draft, merges it with `mine` when they
   * differ (`mergeOutboxIntents`), builds the new intent from that, and when the stored draft held
   * edits `mine` lacked, reads the text from the merged doc (the editor's text misses them). Returns
   * the stored intent: the caller makes it the vault's in-RAM intent.
   *
   * A content save is stamped before the lock is requested, and ANY rejection (the lock, the
   * stored-draft read, the build, the put) arms the unsaved mark while it is still the newest
   * content save of the entry: the body text is then only in the editor's RAM.
   */
  async saveEntryDraft(entryId: string, params: SaveEntryDraftParams): Promise<OutboxEntryV1> {
    const { mine, open, seal, build, content = false } = params
    const contentAttempt = content ? stampContentAttempt(entryId) : null
    try {
      return await withDraftLock(entryId, async () => {
        const stored = await this.loadEntryDraft(entryId, open)
        const same = stored !== null && mine !== null && sameIntent(stored, mine)
        const prior =
          stored === null ? mine : mine === null || same ? stored : mergeOutboxIntents(stored, mine)
        const built = await build(prior)
        const intent = stored !== null && !same ? withTextFromState(built) : built
        await this.#save(entryId, seal(intent), undefined, contentAttempt, undefined)
        return intent
      })
    } catch (error) {
      if (isLatestContentAttempt(entryId, contentAttempt)) unsavedIds.add(entryId)
      throw error
    }
  }

  /**
   * The stored ENTRY draft under `key`, opened; null when there is none, it cannot be opened, or
   * the key holds a v2 draft (`j-…`, `d-…`): those are never read as an entry.
   */
  async loadEntryDraft(key: string, open: OpenEntryDraft): Promise<OutboxEntryV1 | null> {
    const rec = await this.#db.drafts.get(key)
    if (rec === undefined || draftKind(rec) !== 'entry') return null
    return await open(rec.sealed)
  }

  /** One put, then on `StorageQuotaError` one eviction and at most the bounded retries. */
  async #putWithQuotaRetry(
    entryId: string,
    sealed: Uint8Array,
    kind: Exclude<DraftKind, 'entry'> | undefined,
    targetEntryId: string | undefined,
    latest: () => boolean,
  ): Promise<void> {
    // A plain put: the record has no `pushedHash`, so it is unpushed.
    const put = (): Promise<void> =>
      this.#db.drafts.put({
        entryId,
        ...(kind === undefined ? {} : { kind }),
        ...(targetEntryId === undefined ? {} : { targetEntryId }),
        sealed,
        updatedAt: Date.now(),
      })
    let quotaError: StorageQuotaError
    try {
      await put()
      return
    } catch (error) {
      if (!(error instanceof StorageQuotaError)) throw error
      quotaError = error
      await this.#evict().catch(() => undefined)
    }
    for (const [i, ms] of QUOTA_RETRY_DELAYS_MS.entries()) {
      await this.#delay(ms)
      if (!latest()) throw quotaError // superseded: never write older bytes
      try {
        await put()
        return
      } catch (error) {
        const last = i === QUOTA_RETRY_DELAYS_MS.length - 1
        if (!(error instanceof StorageQuotaError) || last || !latest()) throw error
      }
    }
  }

  async getDraft(entryId: string): Promise<Uint8Array | undefined> {
    const rec = await this.#db.drafts.get(entryId)
    return rec?.sealed
  }

  async deleteDraft(entryId: string): Promise<void> {
    await this.#db.drafts.delete(entryId)
    unpushedIds.delete(entryId)
    unsavedIds.delete(entryId)
  }

  /** Every draft, pushed or not. Also refreshes the dirty state from IndexedDB. */
  async listDrafts(): Promise<DraftRecord[]> {
    return (await this.#refresh()).all
  }

  /**
   * Entry drafts only (legacy records without a `kind` included), for the entry overlay: journal,
   * tag, template and trash drafts carry v2 intents. Also refreshes the dirty state.
   */
  async listEntryDrafts(): Promise<DraftRecord[]> {
    return (await this.listDrafts()).filter((rec) => draftKind(rec) === 'entry')
  }

  /** Drafts not yet uploaded in their current form. Also refreshes the dirty state. */
  async listUnpushedDrafts(): Promise<DraftRecord[]> {
    return (await this.#refresh()).unpushed
  }

  async isDirty(): Promise<boolean> {
    return (await this.listUnpushedDrafts()).length > 0
  }

  /** The last known dirty state, without reading IndexedDB (for `beforeunload`). */
  isDirtySync(): boolean {
    return isAnyDraftDirty()
  }

  installBeforeUnload(windowObj?: Window): () => void {
    const target = windowObj ?? (typeof window !== 'undefined' ? window : undefined)
    if (!target) return () => undefined

    const handler = (e: BeforeUnloadEvent): void => {
      if (isAnyDraftDirty()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    target.addEventListener('beforeunload', handler)
    return () => {
      target.removeEventListener('beforeunload', handler)
    }
  }

  /**
   * Uploads `intents` (packed from `sealed`, the draft bytes the caller read) through
   * `safeUpload`, then marks the draft pushed, only if its stored bytes are still `sealed`: a
   * `saveDraft` during the upload stays unpushed. The caller passes `sealed` rather than this
   * re-reading the record so the recorded hash is the hash of what was actually packed. The draft
   * is never deleted. A rejected upload changes nothing and rethrows.
   *
   * Under the writer lock, right before the first write, the stored draft is re-read and, in the
   * same transaction, marked `uploadStarted` (`markUploadStarted`): if it is no longer `sealed`
   * (another tab saved, and may already have pushed, a newer one) or is gone, nothing is written,
   * the draft is not marked, and this returns `'stale'`.
   */
  async flush(
    entryId: string,
    intents: SafeUploadIntent[],
    uploadDeps: SafeUploadDeps,
    sealed: Uint8Array,
  ): Promise<'pushed' | 'stale'> {
    const startGen = saveGen
    const hash = await sha256Hex(sealed)
    let stale = false
    const beforeWrite = async (): Promise<boolean> => {
      stale = !(await this.#db.drafts.markUploadStarted(entryId, sealed))
      return !stale
    }
    try {
      await safeUpload(intents, { ...uploadDeps, beforeWrite })
    } catch (error) {
      if (stale) return 'stale'
      throw error
    }
    const marked = await this.#db.drafts.markPushed(entryId, sealed, hash)
    if (marked && !savedSince(entryId, startGen)) unpushedIds.delete(entryId)
    return 'pushed'
  }

  async #refresh(): Promise<{ all: DraftRecord[]; unpushed: DraftRecord[] }> {
    const startGen = saveGen
    const all = await this.#db.drafts.list()
    const unpushed: DraftRecord[] = []
    const seen = new Set<string>()
    for (const rec of all) {
      seen.add(rec.entryId)
      if (await isUnpushed(rec)) {
        unpushed.push(rec)
        unpushedIds.add(rec.entryId)
      } else if (!savedSince(rec.entryId, startGen)) {
        unpushedIds.delete(rec.entryId)
      }
    }
    for (const id of [...unpushedIds]) {
      if (!seen.has(id) && !savedSince(id, startGen)) unpushedIds.delete(id)
    }
    return { all, unpushed }
  }
}

let beforeUnloadInstalled = false

export function isAnyDraftDirty(): boolean {
  return unpushedIds.size > 0 || unsavedIds.size > 0
}

/** Forgets the failed saves (`web_forget_browser`: the user chose to drop this browser's data). */
export function clearUnsavedDrafts(): void {
  unsavedIds.clear()
}

/** The last known number of unpushed drafts, without reading IndexedDB (`entriesPending`). */
export function unpushedDraftCount(): number {
  return unpushedIds.size
}

export function resetDraftsAutostartForTest(): void {
  unpushedIds.clear()
  lastSaveGen.clear()
  unsavedIds.clear()
  lastAttempt.clear()
  lastContentAttempt.clear()
}

export function installDraftsAutostart(windowObj?: Window): () => void {
  const target = windowObj ?? (typeof window !== 'undefined' ? window : undefined)
  if (!target || beforeUnloadInstalled) return () => undefined
  beforeUnloadInstalled = true

  const handler = (e: BeforeUnloadEvent): void => {
    if (isAnyDraftDirty()) {
      e.preventDefault()
      e.returnValue = ''
    }
  }

  target.addEventListener('beforeunload', handler)
  return () => {
    target.removeEventListener('beforeunload', handler)
    beforeUnloadInstalled = false
  }
}

export function createDraftManager(deps: DraftManagerDeps): DraftManager {
  return new DraftManager(deps)
}
