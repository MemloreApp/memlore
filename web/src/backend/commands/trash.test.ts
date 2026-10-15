import { afterEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../../../src/types/entry'
import type { OutboxIntentV3 } from '../../core/core'
import { setWriteFlagForTest } from '../config'
import { WRITER_LOCK_NAME } from '../drive/client'
import { lock, setKeyRing, type KeyRing } from '../keys'
import type { OutboxEntryV1 } from '../sync/outbox'
import type { WebDb } from '../storage/idb'
import { configureTabsEnv, type DraftLocksLike } from '../tabs'
import { entryHandlers } from './entries'
import { configureReadEnv } from './readSession'
import { installFakeSession, type FakeSpec, type Harness } from './readTestKit'
import { trashHandlers } from './trash'

afterEach(() => {
  configureReadEnv({})
  configureTabsEnv({})
  setWriteFlagForTest(false)
  lock('manual')
})

const listTrashed = (args: Record<string, unknown> = {}): Promise<Entry[]> =>
  Promise.resolve(trashHandlers.list_trashed_entries(args)) as Promise<Entry[]>

/** A stored `d-<entryId>` trash draft requested at `updatedAtMs` (the sealed bytes are not read). */
async function putTrashDraft(db: WebDb, entryId: string, updatedAtMs: number): Promise<void> {
  await db.drafts.put({
    entryId: `d-${entryId}`,
    kind: 'trash',
    sealed: new Uint8Array([2]),
    updatedAt: updatedAtMs,
  })
}

describe('list_trashed_entries', () => {
  it('lists desktop-Trash entries as deleted rows with their trashed_at, newest first', async () => {
    const specs: FakeSpec[] = [
      { id: 'a', updatedAt: 10, title: 'Older', trashedAt: 500 },
      { id: 'b', updatedAt: 11, title: 'Newer', trashedAt: 900 },
      { id: 'live', updatedAt: 12, title: 'Live' },
    ]
    const { vault } = installFakeSession(specs)

    const rows = await listTrashed()

    expect(vault.loadTrashedCalls).toEqual([['a', 'b']])
    expect(rows.map((e) => [e.id, e.title, e.trashed_at])).toEqual([
      ['b', 'Newer', 900],
      ['a', 'Older', 500],
    ])
    for (const row of rows) {
      expect(row.is_deleted).toBe(true)
      expect(row.is_locked).toBe(false)
      expect(row.is_invisible).toBe(false)
      expect(row).not.toHaveProperty('trash_pending_desktop')
    }
  })

  it('breaks a trashed_at tie by ascending id, as the desktop does', async () => {
    installFakeSession([
      { id: 'z', updatedAt: 1, trashedAt: 700 },
      { id: 'm', updatedAt: 2, trashedAt: 700 },
    ])
    expect((await listTrashed()).map((e) => e.id)).toEqual(['m', 'z'])
  })

  it('lists a pending web delete from its draft, with the request time and the pending flag', async () => {
    const { vault, db } = installFakeSession([{ id: 'p', updatedAt: 10, title: 'Pending' }])
    await vault.load(['p'])
    await putTrashDraft(db, 'p', 1_700_000_000_999)
    vault.setTrashedIds(['p'])

    const [row] = await listTrashed()

    expect(row).toMatchObject({
      id: 'p',
      title: 'Pending',
      is_deleted: true,
      trashed_at: 1_700_000_000,
      trash_pending_desktop: true,
    })
  })

  it('ignores drafts that are not trash drafts', async () => {
    const { db } = installFakeSession([{ id: 'e', updatedAt: 10 }])
    await db.drafts.put({ entryId: 'e', sealed: new Uint8Array([1]), updatedAt: 1000 })
    await db.drafts.put({
      entryId: 'j-x',
      kind: 'journal',
      sealed: new Uint8Array([2]),
      updatedAt: 1,
    })
    expect(await listTrashed()).toEqual([])
  })

  it('shows an id pending AND in the desktop Trash once, as the desktop row', async () => {
    const { vault, db } = installFakeSession([{ id: 'x', updatedAt: 10, trashedAt: 800 }])
    await putTrashDraft(db, 'x', 1_700_000_000_000)
    vault.setTrashedIds(['x'])

    const rows = await listTrashed()

    expect(rows).toHaveLength(1)
    expect(rows[0].trashed_at).toBe(800)
    expect(rows[0]).not.toHaveProperty('trash_pending_desktop')
  })

  it('loads the synced copy of a pending delete that is not in RAM', async () => {
    const { vault, db } = installFakeSession([{ id: 'p', updatedAt: 10, title: 'Reloaded' }])
    await putTrashDraft(db, 'p', 5000)
    vault.setTrashedIds(['p'])

    const rows = await listTrashed()

    expect(vault.loadCalls).toEqual([['p']])
    expect(rows.map((e) => [e.id, e.title])).toEqual([['p', 'Reloaded']])
  })

  it('serves a pending web-created entry from its intent without loading', async () => {
    const { vault, db } = installFakeSession([])
    vault.setOutboxIntents([
      {
        entry_id: 'w',
        created_on_web: true,
        web_device_id: 'web',
        web_updated_at_secs: 100,
        fields: { title: { value: 'Made on web' } },
        yjs_full_state: [],
      } as unknown as OutboxEntryV1,
    ])
    await putTrashDraft(db, 'w', 9000)
    vault.setTrashedIds(['w'])

    const rows = await listTrashed()

    expect(vault.loadCalls).toEqual([])
    expect(rows.map((e) => [e.id, e.title, e.trash_pending_desktop])).toEqual([
      ['w', 'Made on web', true],
    ])
  })

  it('lists a pending id with nothing to show as an untitled row', async () => {
    const { vault, db } = installFakeSession([])
    await putTrashDraft(db, 'gone', 3000)
    vault.setTrashedIds(['gone'])

    const rows = await listTrashed()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'gone',
      title: null,
      is_deleted: true,
      trashed_at: 3,
      trash_pending_desktop: true,
      media_count: 0,
    })
  })

  it('leaves out locked, invisible and journal-excluded entries, desktop or pending', async () => {
    const { vault, db } = installFakeSession([
      { id: 'dl', updatedAt: 1, trashedAt: 10, locked: true },
      { id: 'di', updatedAt: 2, trashedAt: 20, invisible: true },
      { id: 'dj', updatedAt: 3, trashedAt: 30, journal: 'secret' },
      { id: 'pl', updatedAt: 4, locked: true },
      { id: 'pi', updatedAt: 5, invisible: true },
      { id: 'pj', updatedAt: 6, journal: 'secret' },
      { id: 'ok', updatedAt: 7, trashedAt: 40 },
    ])
    vault.excludedJournals.add('secret')
    for (const id of ['pl', 'pi', 'pj']) await putTrashDraft(db, id, 1000)
    vault.setTrashedIds(['pl', 'pi', 'pj'])

    expect((await listTrashed()).map((e) => e.id)).toEqual(['ok'])
  })

  it('ignores the lockedView and activeVaultId arguments', async () => {
    installFakeSession([{ id: 'a', updatedAt: 1, trashedAt: 10 }])
    const plain = await listTrashed()
    const revealed = await listTrashed({ lockedView: 'revealed', activeVaultId: 'v1' })
    expect(revealed).toEqual(plain)
    expect(plain.map((e) => e.id)).toEqual(['a'])
  })

  it('orders pending and desktop rows together by trashed_at', async () => {
    const { vault, db } = installFakeSession([
      { id: 'd', updatedAt: 1, trashedAt: 2_000 },
      { id: 'p', updatedAt: 2 },
    ])
    await vault.load(['p'])
    await putTrashDraft(db, 'p', 3_000_000)
    vault.setTrashedIds(['p'])
    expect((await listTrashed()).map((e) => e.id)).toEqual(['p', 'd'])
  })

  it('does not list a pending web-created entry of an excluded journal as untitled', async () => {
    const { vault, db } = installFakeSession([])
    vault.setOutboxIntents([
      {
        entry_id: 'w',
        created_on_web: true,
        web_device_id: 'web',
        web_updated_at_secs: 100,
        fields: { title: { value: 'Hidden' }, journal_id: { value: 'secret' } },
        yjs_full_state: [],
      } as unknown as OutboxEntryV1,
    ])
    vault.excludedJournals.add('secret')
    await putTrashDraft(db, 'w', 9000)
    vault.setTrashedIds(['w'])

    expect(await listTrashed()).toEqual([])
  })
})

describe('trash writes (web gap audit Phase 11)', () => {
  const KINDS = ['trash_entry', 'restore_entry', 'purge_entry', 'empty_trash']
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const C = '33333333-3333-4333-8333-333333333333'
  const P = '44444444-4444-4444-8444-444444444444'

  function writable(specs: FakeSpec[]): Harness {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    return installFakeSession(specs, { outboxKinds: KINDS })
  }

  const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
    Promise.resolve((trashHandlers[name] ?? entryHandlers[name])(args))

  /** Every stored draft (each sealed as frame 3 by the fake core): key, kind and its intent. */
  async function drafts(h: Harness): Promise<Array<[string, string, OutboxIntentV3]>> {
    return (await h.db.drafts.list()).map((d) => [
      d.entryId,
      String(d.kind),
      JSON.parse(new TextDecoder().decode(d.sealed.subarray(1))) as OutboxIntentV3,
    ])
  }

  it('offers delete forever and empty trash for desktop rows only, never a pending web trash', async () => {
    const D = '66666666-6666-4666-8666-666666666666'
    const h = writable([
      { id: A, updatedAt: 110, trashedAt: 900 },
      { id: B, updatedAt: 120, trashedAt: 500 },
      { id: C, updatedAt: 130, trashedAt: 700, locked: true },
      { id: D, updatedAt: 150, trashedAt: 800 },
      { id: P, updatedAt: 140 },
    ])
    await h.vault.load([P])
    await call('soft_delete_entry', { id: P })
    const trashDraft = await h.db.drafts.get(`d-${P}`)

    // The pending web trash and the untitled placeholder are in no Trash yet: nothing to purge.
    await expect(call('delete_entry_forever', { id: P })).rejects.toThrow('entry is not in Trash')
    await expect(call('delete_entry_forever', { id: C })).rejects.toThrow('entry is not in Trash')
    expect(await h.db.drafts.get(`d-${P}`)).toEqual(trashDraft)

    // A desktop row purges from the synced row's base, and leaves the list.
    await call('delete_entry_forever', { id: A })
    expect((await drafts(h)).find(([key]) => key === `d-${A}`)).toEqual([
      `d-${A}`,
      'purge',
      {
        kind: 'purge_entry',
        web_device_id: 'test-device-id',
        web_updated_at_secs: expect.any(Number),
        entry_id: A,
        base_updated_at: 110,
      },
    ])

    // Exactly the confirmed rows the list still shows (not the purged, locked or pending ones),
    // oldest first, synced bases.
    expect(await call('empty_trash', { ids: [A, B, C, D, P] })).toBe(2)
    expect((await drafts(h)).find(([key]) => key === 'd-empty-trash')).toEqual([
      'd-empty-trash',
      'empty_trash',
      {
        kind: 'empty_trash',
        web_device_id: 'test-device-id',
        web_updated_at_secs: expect.any(Number),
        items: [
          { entry_id: B, base_updated_at: 120 },
          { entry_id: D, base_updated_at: 150 },
        ],
      },
    ])
    // The queued rows leave the list; the pending web trash stays.
    expect((await listTrashed()).map((e) => e.id)).toEqual([P])
  })

  it('empty_trash never queues a row that reached the Trash after the confirmed list', async () => {
    // The user confirmed [A]; B (older, so it would sort first) arrived from a pull meanwhile.
    const h = writable([
      { id: A, updatedAt: 110, trashedAt: 900 },
      { id: B, updatedAt: 120, trashedAt: 100 },
    ])

    expect(await call('empty_trash', { ids: [A] })).toBe(1)
    const [[key, , intent]] = await drafts(h)
    expect(key).toBe('d-empty-trash')
    expect(intent).toMatchObject({ items: [{ entry_id: A, base_updated_at: 110 }] })
    expect((await listTrashed()).map((e) => e.id)).toEqual([B])
  })

  it.each([
    ['no ids', {}],
    ['ids not an array', { ids: A }],
    ['a non-UUID id', { ids: [A, 'b'] }],
    ['a non-string id', { ids: [A, 7] }],
    ['too many ids', { ids: Array.from({ length: 100_001 }, () => A) }],
  ])('empty_trash refuses %s and queues nothing', async (_label, args) => {
    const h = writable([{ id: A, updatedAt: 110, trashedAt: 900 }])
    await expect(call('empty_trash', args)).rejects.toThrow('invalid empty_trash ids')
    expect(await h.db.drafts.list()).toEqual([])
    expect((await listTrashed()).map((e) => e.id)).toEqual([A])
  })

  it('carries a still-pending empty_trash list on and stops at 1000 items', async () => {
    const ids = Array.from(
      { length: 1001 },
      (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
    )
    const h = writable(ids.map((id, i) => ({ id, updatedAt: 10 + i, trashedAt: 1000 + i })))

    expect(await call('empty_trash', { ids })).toBe(1000)
    // The newest row is left for "Empty again"; the pending list is full, so nothing changes.
    expect((await listTrashed()).map((e) => e.id)).toEqual([ids[1000]])
    expect(await call('empty_trash', { ids: [ids[1000]] })).toBe(0)

    // Once the synced Trash no longer shows a listed row, its slot goes to the next one.
    configureReadEnv({})
    const stored = await h.db.drafts.get('d-empty-trash')
    const next = writable(
      ids.slice(1).map((id, i) => ({ id, updatedAt: 11 + i, trashedAt: 1001 + i })),
    )
    await next.db.drafts.put(stored!)
    expect(await call('empty_trash', { ids: [ids[1000]] })).toBe(1)
    const items = (await drafts(next))[0][2] as Extract<OutboxIntentV3, { kind: 'empty_trash' }>
    expect(items.items).toHaveLength(1000)
    expect(items.items.map((i) => i.entry_id)).toEqual(ids.slice(1))
  })

  it('trash then restore before push leaves no d- draft, and the entry is live again', async () => {
    const h = writable([{ id: P, updatedAt: 140 }])
    await h.vault.load([P])
    await call('soft_delete_entry', { id: P })
    expect(await listTrashed()).toHaveLength(1)

    await call('restore_entry', { id: P })

    expect(await h.db.drafts.list()).toEqual([])
    expect(await listTrashed()).toEqual([])
    expect(h.vault.trashView(P)).toBeNull()
  })

  it('restores a desktop row from its synced base and takes it off the list', async () => {
    const h = writable([{ id: A, updatedAt: 110, trashedAt: 900 }])
    await call('restore_entry', { id: A })
    expect(await drafts(h)).toEqual([
      [
        `d-${A}`,
        'restore',
        {
          kind: 'restore_entry',
          web_device_id: 'test-device-id',
          web_updated_at_secs: expect.any(Number),
          entry_id: A,
          base_updated_at: 110,
        },
      ],
    ])
    expect(await listTrashed()).toEqual([])
  })

  it('a restore during the trash upload waits for it, then seals restore_entry instead of dropping the trash', async () => {
    const h = writable([{ id: P, updatedAt: 140 }])
    // One FIFO lock manager for the upload and the handler, as `navigator.locks`.
    const tails = new Map<string, Promise<unknown>>()
    const locks: DraftLocksLike = {
      request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback)
        tails.set(
          name,
          run.catch(() => undefined),
        )
        return run
      },
    }
    configureTabsEnv({ draftLocks: locks })
    await h.vault.load([P])
    await call('soft_delete_entry', { id: P })
    const key = `d-${P}`
    const sealed = (await h.db.drafts.get(key))!.sealed

    // An upload batch holds the writer lock; the restore starts before its freshness check.
    let release = (): void => undefined
    void locks.request(WRITER_LOCK_NAME, () => new Promise<void>((r) => (release = r)))
    const restoring = call('restore_entry', { id: P })
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    // The batch marks the trash and puts it on Drive: the restore must not have dropped it.
    expect(await h.db.drafts.markUploadStarted(key, sealed)).toBe(true)
    release()
    await restoring

    expect(await drafts(h)).toEqual([
      [
        key,
        'restore',
        {
          kind: 'restore_entry',
          web_device_id: 'test-device-id',
          web_updated_at_secs: expect.any(Number),
          entry_id: P,
          base_updated_at: 140,
        },
      ],
    ])
  })
})
