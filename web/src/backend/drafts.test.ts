import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { extractPlainText } from '../../../src/lib/yjs'
import { StorageQuotaError, openWebDb, type WebDb } from './storage/idb'
import { buildOutboxIntent, type FieldChange, type OutboxEntryV1 } from './sync/outbox'
import type { SafeUploadDeps } from './sync/safeUpload'
import { configureTabsEnv, type DraftLocksLike } from './tabs'
import {
  DraftManager,
  createDraftManager,
  isAnyDraftDirty,
  onDraftSaved,
  resetDraftsAutostartForTest,
  sha256Hex,
  unpushedDraftCount,
} from './drafts'

const mocks = vi.hoisted(() => ({
  safeUpload: vi.fn(
    async (_intents: unknown, _deps: SafeUploadDeps): Promise<unknown> => undefined,
  ),
}))
vi.mock('./sync/safeUpload', () => ({ safeUpload: mocks.safeUpload }))

const UPLOAD_DEPS = {} as SafeUploadDeps

describe('DraftManager', () => {
  let factory: IDBFactory
  let db: WebDb
  let manager: DraftManager

  beforeEach(async () => {
    factory = new IDBFactory()
    db = await openWebDb({ factory })
    manager = createDraftManager({ db })
    resetDraftsAutostartForTest()
    mocks.safeUpload.mockReset()
    mocks.safeUpload.mockResolvedValue(undefined)
  })

  it('saves, retrieves, and deletes sealed drafts in db.drafts', async () => {
    expect(await manager.isDirty()).toBe(false)
    const sealed = new Uint8Array([1, 2, 3, 4])
    await manager.saveDraft('entry-1', sealed)

    expect(await manager.isDirty()).toBe(true)
    const stored = await manager.getDraft('entry-1')
    expect(stored).toEqual(sealed)

    const list = await manager.listDrafts()
    expect(list).toHaveLength(1)
    expect(list[0].entryId).toBe('entry-1')
    expect(list[0].sealed).toEqual(sealed)

    await manager.deleteDraft('entry-1')
    expect(await manager.isDirty()).toBe(false)
    expect(await manager.getDraft('entry-1')).toBeUndefined()
  })

  it('lists entry drafts only for the entry overlay, legacy drafts included', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await db.drafts.put({ entryId: id, sealed: new Uint8Array([1]), updatedAt: 1 })
    await db.drafts.put({ entryId: 'e2', kind: 'entry', sealed: new Uint8Array([2]), updatedAt: 2 })
    await db.drafts.put({
      entryId: `j-${id}`,
      kind: 'journal',
      sealed: new Uint8Array([3]),
      updatedAt: 3,
    })
    await db.drafts.put({
      entryId: `d-${id}`,
      kind: 'trash',
      sealed: new Uint8Array([4]),
      updatedAt: 4,
    })

    const entries = await manager.listEntryDrafts()

    expect(entries.map((d) => d.entryId).sort()).toEqual([id, 'e2'].sort())
    // Every kind is still an unsent change.
    expect(await manager.listUnpushedDrafts()).toHaveLength(4)
    expect(unpushedDraftCount()).toBe(4)
  })

  it('stores the kind of a v2 draft under its prefixed key, unpushed', async () => {
    const sealed = new Uint8Array([7, 8])
    await manager.saveDraft('t-11111111-1111-4111-8111-111111111111', sealed, 'tag')

    const rec = await db.drafts.get('t-11111111-1111-4111-8111-111111111111')
    expect(rec).toMatchObject({ kind: 'tag', sealed })
    expect(await manager.listEntryDrafts()).toEqual([])
    expect((await manager.listUnpushedDrafts()).map((d) => d.entryId)).toEqual([
      't-11111111-1111-4111-8111-111111111111',
    ])
  })

  it('installs beforeunload listener that warns when dirty', async () => {
    const listeners: Record<string, ((e: BeforeUnloadEvent) => void)[]> = {}
    const mockWindow = {
      addEventListener: (type: string, listener: (e: BeforeUnloadEvent) => void) => {
        listeners[type] = listeners[type] || []
        listeners[type].push(listener)
      },
      removeEventListener: (type: string, listener: (e: BeforeUnloadEvent) => void) => {
        listeners[type] = (listeners[type] || []).filter((l) => l !== listener)
      },
    }

    const cleanup = manager.installBeforeUnload(mockWindow as unknown as Window)
    expect(listeners['beforeunload']).toBeDefined()

    const event = {
      preventDefault: vi.fn(),
      returnValue: '',
    } as unknown as BeforeUnloadEvent

    // Not dirty: no preventDefault / returnValue set
    for (const l of listeners['beforeunload']) {
      l(event)
    }
    expect(event.returnValue).toBe('')

    // Dirty: sets returnValue and calls preventDefault
    await manager.saveDraft('entry-1', new Uint8Array([5, 6]))
    for (const l of listeners['beforeunload']) {
      l(event)
    }
    expect(event.returnValue).toBeDefined()
    expect(event.preventDefault).toHaveBeenCalled()

    cleanup()
    expect(listeners['beforeunload']).toHaveLength(0)
  })

  it('flush keeps the draft and marks it pushed', async () => {
    const sealed = new Uint8Array([1, 2, 3])
    await manager.saveDraft('e1', sealed)
    expect(isAnyDraftDirty()).toBe(true)

    await manager.flush('e1', [], UPLOAD_DEPS, sealed)

    expect(mocks.safeUpload).toHaveBeenCalledTimes(1)
    const rec = await db.drafts.get('e1')
    expect(rec?.sealed).toEqual(sealed)
    expect(rec?.pushedHash).toBe(await sha256Hex(sealed))
    expect(await manager.listUnpushedDrafts()).toEqual([])
    expect(isAnyDraftDirty()).toBe(false)
    expect(manager.isDirtySync()).toBe(false)
  })

  it('a saveDraft that lands during the upload stays unpushed', async () => {
    const first = new Uint8Array([1])
    const second = new Uint8Array([2])
    await manager.saveDraft('e1', first)
    let release!: () => void
    mocks.safeUpload.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    )

    const flushing = manager.flush('e1', [], UPLOAD_DEPS, first)
    await vi.waitFor(() => expect(mocks.safeUpload).toHaveBeenCalled())
    // Another command instance, as entries.ts creates one per call.
    await createDraftManager({ db }).saveDraft('e1', second)
    release()
    await flushing

    const rec = await db.drafts.get('e1')
    expect(rec?.sealed).toEqual(second)
    expect(rec?.pushedHash).toBeUndefined()
    expect((await manager.listUnpushedDrafts()).map((d) => d.entryId)).toEqual(['e1'])
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('a safeUpload rejection leaves the draft unpushed and rethrows', async () => {
    const sealed = new Uint8Array([9])
    await manager.saveDraft('e1', sealed)
    mocks.safeUpload.mockRejectedValueOnce(new Error('refused'))

    await expect(manager.flush('e1', [], UPLOAD_DEPS, sealed)).rejects.toThrow('refused')

    expect(await db.drafts.get('e1')).toMatchObject({ entryId: 'e1', sealed })
    expect((await db.drafts.get('e1'))?.pushedHash).toBeUndefined()
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('counts an old record without pushedHash, or with a stale one, as unpushed', async () => {
    await db.drafts.put({ entryId: 'old', sealed: new Uint8Array([1]), updatedAt: 1 })
    await db.drafts.put({
      entryId: 'stale',
      sealed: new Uint8Array([2]),
      updatedAt: 1,
      pushedHash: await sha256Hex(new Uint8Array([3])),
    })
    await db.drafts.put({
      entryId: 'pushed',
      sealed: new Uint8Array([4]),
      updatedAt: 1,
      pushedHash: await sha256Hex(new Uint8Array([4])),
    })

    const unpushed = await manager.listUnpushedDrafts()
    expect(unpushed.map((d) => d.entryId).sort()).toEqual(['old', 'stale'])
    expect(await manager.isDirty()).toBe(true)
  })

  it('is dirty after a reload: a new manager over an IDB that already holds an unpushed draft', async () => {
    await db.drafts.put({ entryId: 'e1', sealed: new Uint8Array([1]), updatedAt: 1 })
    // A fresh page: module state is empty, no saveDraft ran.
    resetDraftsAutostartForTest()
    const reloaded = await openWebDb({ factory })
    const fresh = createDraftManager({ db: reloaded })
    expect(isAnyDraftDirty()).toBe(false)

    await fresh.listDrafts()

    expect(isAnyDraftDirty()).toBe(true)
    expect(fresh.isDirtySync()).toBe(true)
  })

  it('notifies save listeners once per stored draft, until unsubscribed', async () => {
    const saved = vi.fn()
    const off = onDraftSaved(saved)
    await manager.saveDraft('e1', new Uint8Array([1]))
    expect(saved).toHaveBeenCalledTimes(1)
    off()
    await manager.saveDraft('e1', new Uint8Array([2]))
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the draft could not be stored', async () => {
    const saved = vi.fn()
    const off = onDraftSaved(saved)
    vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new Error('quota'))
    await expect(manager.saveDraft('e1', new Uint8Array([1]))).rejects.toThrow('quota')
    expect(saved).not.toHaveBeenCalled()
    off()
  })

  it('a failed content save still arms the beforeunload guard, even after a recount', async () => {
    vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new Error('disk error'))
    await expect(manager.saveContentDraft('e1', new Uint8Array([1]))).rejects.toThrow('disk error')

    // Nothing reached IndexedDB, so the IDB-backed recount must not clear it.
    await manager.listUnpushedDrafts()
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('on a full quota evicts once, retries, and a stored save clears the unsaved mark', async () => {
    const evict = vi.fn(async () => undefined)
    const quotaManager = createDraftManager({ db, evict, delay: async () => undefined })
    const sealed = new Uint8Array([1, 2])
    vi.spyOn(db.drafts, 'put')
      .mockRejectedValueOnce(new StorageQuotaError())
      .mockRejectedValueOnce(new StorageQuotaError())

    await quotaManager.saveContentDraft('e1', sealed)

    expect(evict).toHaveBeenCalledTimes(1)
    expect(await db.drafts.get('e1')).toMatchObject({ sealed })
    await quotaManager.flush('e1', [], UPLOAD_DEPS, sealed)
    expect(isAnyDraftDirty()).toBe(false)
  })

  it('stops after three retries when the quota stays full, and still warns', async () => {
    const evict = vi.fn(async () => undefined)
    const delay = vi.fn(async () => undefined)
    const quotaManager = createDraftManager({ db, evict, delay })
    const put = vi.spyOn(db.drafts, 'put').mockRejectedValue(new StorageQuotaError())

    const err: unknown = await quotaManager
      .saveContentDraft('e1', new Uint8Array([1]))
      .catch((e) => e)

    expect(err).toBeInstanceOf(StorageQuotaError)
    expect(put).toHaveBeenCalledTimes(4)
    expect(evict).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledTimes(3)
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('a quota retry never overwrites a newer save of the same entry', async () => {
    let release!: () => void
    const delay = (): Promise<void> => new Promise((resolve) => (release = resolve))
    const older = new Uint8Array([1])
    const newer = new Uint8Array([2])
    const put = vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new StorageQuotaError())

    const first = createDraftManager({ db, evict: async () => undefined, delay })
      .saveDraft('e1', older)
      .catch((e: unknown) => e)
    await vi.waitFor(() => expect(release).toBeDefined())
    await manager.saveDraft('e1', newer)
    release()

    expect(await first).toBeInstanceOf(StorageQuotaError)
    expect(put).toHaveBeenCalledTimes(2)
    expect((await db.drafts.get('e1'))?.sealed).toEqual(newer)
    await manager.flush('e1', [], UPLOAD_DEPS, newer)
    expect(isAnyDraftDirty()).toBe(false)
  })

  it('only the content save arms or clears the unsaved mark, not a metadata save', async () => {
    const put = vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new Error('disk error'))
    // A failed favorite/create save: nothing is held in editor RAM, so no warning.
    await expect(manager.saveDraft('e2', new Uint8Array([3]))).rejects.toThrow()
    expect(isAnyDraftDirty()).toBe(false)

    put.mockRejectedValueOnce(new Error('disk error'))
    await expect(manager.saveContentDraft('e1', new Uint8Array([1]))).rejects.toThrow()
    // A title/tag save resealed from the prior intent: it does not hold the lost body text.
    await manager.saveDraft('e1', new Uint8Array([2]))
    await manager.flush('e1', [], UPLOAD_DEPS, new Uint8Array([2]))
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('counts the unpushed drafts without reading IndexedDB', async () => {
    expect(unpushedDraftCount()).toBe(0)
    await manager.saveDraft('e1', new Uint8Array([1]))
    await manager.saveDraft('e2', new Uint8Array([2]))
    expect(unpushedDraftCount()).toBe(2)
    await manager.flush('e1', [], UPLOAD_DEPS, new Uint8Array([1]))
    expect(unpushedDraftCount()).toBe(1)
  })

  it('flush writes nothing and leaves the draft unmarked when it changed before the lock', async () => {
    const older = new Uint8Array([1])
    const newer = new Uint8Array([2])
    await manager.saveDraft('e1', older)
    let checked: boolean | undefined
    mocks.safeUpload.mockImplementationOnce(async (_intents, deps) => {
      // Another tab saves while this batch waits on the writer lock.
      await createDraftManager({ db }).saveDraft('e1', newer)
      checked = await deps.beforeWrite?.()
      if (checked === false) throw new Error('stale')
      return undefined
    })

    expect(await manager.flush('e1', [], UPLOAD_DEPS, older)).toBe('stale')

    expect(checked).toBe(false)
    const rec = await db.drafts.get('e1')
    expect(rec?.sealed).toEqual(newer)
    expect(rec?.pushedHash).toBeUndefined()
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('flush reports pushed when the stored draft still holds the uploaded bytes', async () => {
    const sealed = new Uint8Array([3])
    await manager.saveDraft('e1', sealed)
    let checked: boolean | undefined
    mocks.safeUpload.mockImplementationOnce(async (_intents, deps) => {
      checked = await deps.beforeWrite?.()
      return undefined
    })

    expect(await manager.flush('e1', [], UPLOAD_DEPS, sealed)).toBe('pushed')
    expect(checked).toBe(true)
  })
})

describe('entry drafts across tabs (review C2)', () => {
  const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const seal = (intent: OutboxEntryV1): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(intent))
  const open = (sealed: Uint8Array): OutboxEntryV1 =>
    JSON.parse(new TextDecoder().decode(sealed)) as OutboxEntryV1

  /** A FIFO `navigator.locks` per name, as the browser grants them. */
  function fifoLocks(): DraftLocksLike {
    const tails = new Map<string, Promise<unknown>>()
    return {
      request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback)
        tails.set(
          name,
          run.catch(() => undefined),
        )
        return run
      },
    }
  }

  function docWith(text: string): Uint8Array {
    const doc = new Y.Doc()
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(text)])
    doc.getXmlFragment('default').insert(0, [paragraph])
    return Y.encodeStateAsUpdate(doc)
  }

  function change<T>(value: T, base: T, seq: number): FieldChange<T> {
    return { value, base, base_updated_at: 5, change_seq: seq, changed_at_secs: 100 + seq }
  }

  let db: WebDb

  beforeEach(async () => {
    db = await openWebDb({ factory: new IDBFactory() })
    resetDraftsAutostartForTest()
    configureTabsEnv({ draftLocks: fifoLocks() })
  })

  afterEach(() => {
    configureTabsEnv({})
  })

  it('two tabs saving the same entry from a stale intent keep both tabs field and Yjs edits', async () => {
    const tabA = createDraftManager({ db })
    const tabB = createDraftManager({ db })
    const build =
      (
        local: Uint8Array,
        text: string,
        newFields: Parameters<typeof buildOutboxIntent>[0]['newFields'],
        now: number,
      ) =>
      async (prior: OutboxEntryV1 | null) =>
        buildOutboxIntent({
          entryId: ID,
          webDeviceId: 'dev',
          createdOnWeb: false,
          baseSyncedDocBytes: null,
          priorIntent: prior,
          localDocBytes: local,
          contentText: text,
          previewText: text,
          newFields,
          nowSecs: now,
        })

    // Both tabs start from the same (empty) in-RAM intent: neither knows the other's save.
    await Promise.all([
      tabA.saveEntryDraft(ID, {
        mine: null,
        open,
        seal,
        content: true,
        build: build(docWith('from tab A'), 'from tab A', { title: change('A title', '', 1) }, 101),
      }),
      tabB.saveEntryDraft(ID, {
        mine: null,
        open,
        seal,
        content: true,
        build: build(
          docWith('from tab B'),
          'from tab B',
          { emotion: change('good', null, 2) },
          102,
        ),
      }),
    ])

    const rec = await db.drafts.get(ID)
    const stored = open(rec!.sealed)
    expect(stored.fields.title?.value).toBe('A title')
    expect(stored.fields.emotion?.value).toBe('good')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(stored.yjs_full_state))
    const text = extractPlainText(doc)
    expect(text).toContain('from tab A')
    expect(text).toContain('from tab B')
    expect(stored.content_text).toBe(text)
  })

  it('a content save whose stored-draft read fails still arms the beforeunload guard', async () => {
    vi.spyOn(db.drafts, 'get').mockRejectedValueOnce(new Error('idb read error'))
    const build = vi.fn()

    await expect(
      createDraftManager({ db }).saveEntryDraft(ID, {
        mine: null,
        open,
        seal,
        content: true,
        build,
      }),
    ).rejects.toThrow('idb read error')

    expect(build).not.toHaveBeenCalled()
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('never reloads a {draft-saved} journal key as an entry draft', async () => {
    await db.drafts.put({
      entryId: `j-${ID}`,
      kind: 'journal',
      sealed: new Uint8Array([2, 1]),
      updatedAt: 1,
    })
    const opener = vi.fn(open)

    expect(await createDraftManager({ db }).loadEntryDraft(`j-${ID}`, opener)).toBeNull()
    expect(opener).not.toHaveBeenCalled()
  })
})
