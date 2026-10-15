import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { Entry } from '../../../../src/types/entry'
import type { PagedResult } from '../../../../src/types/pagination'
import {
  EntryNotAvailableError,
  MAX_LOAD_ROUNDS,
  MSG_UNAVAILABLE,
  entryHandlers,
  setCustomFilesPicker,
  setCustomMediaPicker,
  timeRangeBounds,
  toEntry,
} from './entries'
import { configureReadEnv, type Taxonomy } from './readSession'
import {
  EMPTY_TAXONOMY,
  fakeMonthIndex,
  installFakeSession,
  installSession,
  realVault,
  type FakeRow,
  type FakeSpec,
} from './readTestKit'
import { taxonomyHandlers } from './taxonomy'
import type { OutboxIntentV3 } from '../../core/core'
import { StorageQuotaError, type WebDb } from '../storage/idb'
import type { OutboxEntryV1 } from '../sync/outbox'
import { WebUnsupportedError } from '../unsupported'
import { setWriteFlagForTest } from '../config'
import { resetClock, updateClockOffset } from '../clock'
import { lock, setKeyRing, type KeyRing } from '../keys'
import { EntryUnavailableError } from '../vault'

afterEach(() => {
  configureReadEnv({})
  setWriteFlagForTest(false)
  setCustomMediaPicker(null)
  setCustomFilesPicker(null)
  lock('manual')
})

const PAGE_ARGS = {
  sort: 'newest',
  range: 'all',
  fromTs: null,
  toTs: null,
  firstDayOfWeek: 1,
  lockedView: 'revealed',
  activeVaultId: null,
  lockFilter: 'all',
}

const call = <T>(name: string, args: Record<string, unknown>): Promise<T> =>
  Promise.resolve(entryHandlers[name](args)) as Promise<T>

const listAll = (page: number, extra: Record<string, unknown> = {}) =>
  call<PagedResult<Entry>>('list_all_entries_paged', { ...PAGE_ARGS, page, ...extra })

const id = (n: number): string => `e${String(n).padStart(2, '0')}`

/** e01 is the most recently updated; the entry date runs the other way round. */
function many(count: number, patch: (n: number) => Partial<FakeSpec> = () => ({})): FakeSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    updatedAt: 1000 - i,
    entryDate: 100 + i,
    ...patch(i + 1),
  }))
}

describe('paged lists', () => {
  it('fetches pages in updated order and shows the loaded set by entry date', async () => {
    const { vault } = installFakeSession(many(12), { pageSize: 5 })
    const first = await listAll(1)
    expect(vault.loadCalls).toEqual([[id(1), id(2), id(3), id(4), id(5)]])
    // The 5 most recently updated are e01..e05; their entry dates grow with the number.
    expect(first.items.map((e) => e.id)).toEqual([id(5), id(4), id(3), id(2), id(1)])
    // (page 1 of the loaded set; it is re-sorted as more entries load, see the file header)
    // total = loaded matches + one page while untried ids remain (never their count).
    expect(first.total).toBe(10)

    const second = await listAll(2)
    expect(vault.loadCalls[1]).toEqual([id(6), id(7), id(8), id(9), id(10)])
    // The loaded set (e01..e10) is sorted by entry date: page 2 is its 6th to 10th newest.
    expect(second.items.map((e) => e.id)).toEqual([id(5), id(4), id(3), id(2), id(1)])
    expect(second.total).toBe(15)

    const third = await listAll(3)
    expect(third.items.map((e) => e.id)).toEqual([id(2), id(1)])
    // Every id tried: the visible count.
    expect(third.total).toBe(12)
    expect((await listAll(4)).items).toEqual([])
  })

  it('does not download anything when the loaded set already fills the page', async () => {
    const { vault } = installFakeSession(many(6), { pageSize: 3 })
    await vault.load([id(1), id(2), id(3), id(4), id(5)])
    vault.loadCalls.length = 0
    const page = await listAll(1)
    expect(page.items).toHaveLength(3)
    expect(vault.loadCalls).toEqual([])
  })

  it('keeps fetching past locked, invisible and failing ids until the page is full', async () => {
    const specs = many(12, (n) => ({
      locked: n === 3,
      invisible: n === 4,
      fails: n === 5,
    }))
    const { vault } = installFakeSession(specs, { pageSize: 5 })
    const page = await listAll(1)
    expect(page.items).toHaveLength(5)
    const ids = page.items.map((e) => e.id)
    expect(ids).not.toContain(id(3))
    expect(ids).not.toContain(id(4))
    expect(ids).not.toContain(id(5))
    expect(vault.loadCalls.flat().filter((x) => x === id(5))).toHaveLength(1)
    // The 5 matches plus one page for the untried e09..e12; e03..e05 never count.
    expect(page.total).toBe(10)
  })

  it('stops when the index is exhausted and reports an exact total', async () => {
    const specs = [...many(4), { id: 'gone', updatedAt: 1, tombstone: true }]
    const { vault } = installFakeSession(specs, { pageSize: 20 })
    const page = await listAll(1)
    expect(page.items).toHaveLength(4)
    expect(page.total).toBe(4)
    expect(vault.loadCalls.flat().sort()).toEqual([id(1), id(2), id(3), id(4)])
  })

  it('is bounded: a filter that matches nothing stops after MAX_LOAD_ROUNDS pages', async () => {
    const count = MAX_LOAD_ROUNDS * 2 + 10
    const { vault } = installFakeSession(many(count), { pageSize: 2 })
    const page = await call<PagedResult<Entry>>('list_entries_paged', {
      ...PAGE_ARGS,
      journalId: 'nowhere',
      page: 1,
    })
    expect(page.items).toEqual([])
    expect(vault.loadCalls).toHaveLength(MAX_LOAD_ROUNDS)
    // No match, but untried ids remain: one page keeps the next reachable.
    expect(page.total).toBe(2)
  })

  it('supports the oldest and recentlyEdited sorts', async () => {
    installFakeSession(many(4))
    expect((await listAll(1, { sort: 'oldest' })).items.map((e) => e.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ])
    expect((await listAll(1, { sort: 'recentlyEdited' })).items.map((e) => e.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ])
  })

  it('treats an inherited property name as an unknown sort (falls back to newest)', async () => {
    installFakeSession(many(3))
    const newest = (await listAll(1)).items.map((e) => e.id)
    for (const sort of ['toString', 'constructor', '__proto__']) {
      expect((await listAll(1, { sort })).items.map((e) => e.id)).toEqual(newest)
    }
  })

  it('filters by journal, favorites and tag, and applies a custom date range', async () => {
    const specs = many(6, (n) => ({
      journal: n % 2 === 0 ? 'jb' : 'ja',
      favorite: n <= 2,
      tags: n === 2 || n === 3 ? ['t1'] : [],
    }))
    installFakeSession(specs)
    const journal = await call<PagedResult<Entry>>('list_entries_paged', {
      ...PAGE_ARGS,
      journalId: 'jb',
      page: 1,
    })
    expect(journal.items.map((e) => e.id).sort()).toEqual([id(2), id(4), id(6)])
    expect(journal.total).toBe(3)

    const favAll = await call<PagedResult<Entry>>('list_favorite_entries_paged', {
      ...PAGE_ARGS,
      journalId: null,
      page: 1,
    })
    expect(favAll.items.map((e) => e.id).sort()).toEqual([id(1), id(2)])
    const favJournal = await call<PagedResult<Entry>>('list_favorite_entries_paged', {
      ...PAGE_ARGS,
      journalId: 'jb',
      page: 1,
    })
    expect(favJournal.items.map((e) => e.id)).toEqual([id(2)])

    const tag = await call<PagedResult<Entry>>('list_entries_by_tag_paged', {
      ...PAGE_ARGS,
      tagId: 't1',
      journalId: null,
      favoritesOnly: true,
      page: 1,
    })
    expect(tag.items.map((e) => e.id)).toEqual([id(2)])

    // entry dates are 100..105: [101, 103) keeps e02 and e03.
    const ranged = await listAll(1, { fromTs: 101, toTs: 103 })
    expect(ranged.items.map((e) => e.id)).toEqual([id(3), id(2)])
  })

  it('answers the second-lock and invisible views with nothing, without downloading', async () => {
    const { vault } = installFakeSession(many(3))
    for (const lockFilter of ['secondLocked', 'invisibleLocked']) {
      expect(await listAll(1, { lockFilter })).toEqual({ items: [], total: 0 })
    }
    expect(vault.loadCalls).toEqual([])
  })

  it('treats a bad page number as page 1', async () => {
    installFakeSession(many(3))
    expect((await listAll(0)).items).toHaveLength(3)
    expect((await listAll(-4)).items).toHaveLength(3)
  })
})

describe('paged lists over the bounded vault (Phase 5)', () => {
  it('pages past the LRU cap: every page full, no duplicate and no gap', async () => {
    // Entry date order is updated order, so page k is exactly the k-th five of the index.
    const specs = many(30, (n) => ({ entryDate: 1000 - n }))
    installSession(realVault(specs, { maxEntries: 10 }), { pageSize: 5 })
    const seen: string[] = []
    for (let page = 1; page <= 6; page += 1) {
      const { items } = await listAll(page)
      expect(items).toHaveLength(5)
      seen.push(...items.map((e) => e.id))
    }
    expect(seen).toEqual(specs.map((s) => s.id))
    expect((await listAll(7)).items).toEqual([])
  })

  describe('with a month index, deeper than the cap and the load rounds reach', () => {
    const PAGE_SIZE = 2
    const MAX_ENTRIES = 5
    const DAY = 86_400
    const base = Date.UTC(2026, 0, 1) / 1000
    // Entry dates run in another order than updates, across several months.
    const visible = Array.from({ length: 110 }, (_, i) => {
      const n = i + 1
      return {
        id: `e${String(n).padStart(3, '0')}`,
        updatedAt: 1000 + n,
        entryDate: base + ((n * 37) % 110) * 3 * DAY,
        journal: n % 2 === 0 ? 'j2' : 'j1',
        tags: n % 3 === 0 ? ['t1'] : [],
      }
    })
    const specs: FakeSpec[] = [
      ...visible,
      // The most recently updated: an entry locked after the index row was written (the reader
      // hides that row as unconfirmed), an invisible one (never indexed) and a visible one the
      // index source has not written yet.
      { id: 'locked', updatedAt: 2000, entryDate: base, locked: true },
      { id: 'invisible', updatedAt: 1999, entryDate: base, invisible: true },
      { id: 'new', updatedAt: 1998, entryDate: base + 100 * DAY, journal: 'j2' },
    ]
    const rows: FakeRow[] = [
      ...visible.map((s) => ({ ...s, updatedAt: s.updatedAt })),
      { id: 'locked', entryDate: base, updatedAt: 1500, winnerUpdatedAt: 2000 },
    ]
    const trashed = 'e050'

    it.each<[string, string, Record<string, unknown>, (s: (typeof visible)[number]) => boolean]>([
      ['every entry', 'list_all_entries_paged', {}, () => true],
      ['a journal', 'list_entries_paged', { journalId: 'j1' }, (s) => s.journal === 'j1'],
      ['a tag', 'list_entries_by_tag_paged', { tagId: 't1' }, (s) => s.tags.includes('t1')],
    ])(
      '%s: every entry once, in order, the loaded set back under the cap after each page',
      async (_label, name, extra, keep) => {
        expect(MAX_LOAD_ROUNDS * PAGE_SIZE + MAX_ENTRIES).toBeLessThan(visible.length)
        const vault = realVault(specs, { maxEntries: MAX_ENTRIES })
        vault.setExcludedJournalIds([], ['j1', 'j2'])
        vault.setTrashedIds([trashed])
        installSession(vault, { pageSize: PAGE_SIZE, monthIndex: fakeMonthIndex(rows) })
        const listed: Array<{ id: string; entryDate: number }> = [
          ...visible.filter((s) => keep(s) && s.id !== trashed),
          // Not indexed yet: only the all-entries list places it (module doc).
          ...(name === 'list_all_entries_paged'
            ? [{ id: 'new', entryDate: base + 100 * DAY }]
            : []),
        ]
        const expected = listed
          .sort((a, b) => b.entryDate - a.entryDate || (a.id < b.id ? 1 : -1))
          .map((s) => s.id)

        const seen: string[] = []
        let total = -1
        for (let page = 1; page <= 200; page += 1) {
          const result = await call<PagedResult<Entry>>(name, { ...PAGE_ARGS, ...extra, page })
          expect(vault.listLoaded().length).toBeLessThanOrEqual(MAX_ENTRIES)
          total = result.total
          if (result.items.length === 0) break
          seen.push(...result.items.map((e) => e.id))
        }
        expect(seen).toEqual(expected)
        // Locked, invisible and pending-trash entries never count.
        expect(total).toBe(expected.length)
      },
    )
  })

  it('with a month index, lists an unloaded entry moved on the web under its new journal only', async () => {
    const D = Date.UTC(2026, 5, 10, 12) / 1000
    const rows: FakeRow[] = ['a', 'b', 'moved'].map((id) => ({ id, entryDate: D, journal: 'j1' }))
    const { vault } = installFakeSession(
      rows.map((r) => ({ id: r.id, updatedAt: 100, entryDate: D, journal: 'j1' })),
      { pageSize: 1, monthIndex: fakeMonthIndex(rows) },
    )
    // A draft read back after a reload: the overlay is set, the entry is not loaded.
    vault.setOutboxIntents([
      {
        entry_id: 'moved',
        created_on_web: false,
        fields: { journal_id: { value: 'j2' } },
        yjs_full_state: [],
      } as unknown as OutboxEntryV1,
    ])
    const list = async (journalId: string): Promise<string[]> => {
      const seen: string[] = []
      for (let page = 1; page <= 5; page += 1) {
        const { items } = await call<PagedResult<Entry>>('list_entries_paged', {
          ...PAGE_ARGS,
          journalId,
          page,
        })
        seen.push(...items.map((e) => `${e.id}:${e.journal_id}`))
      }
      return seen
    }
    expect(await list('j1')).toEqual(['b:j1', 'a:j1'])
    expect(await list('j2')).toEqual(['moved:j2'])
  })

  it('saves an edit whose entry was evicted between its load and the outbox lock', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const vault = realVault(many(4), { maxEntries: 3 })
    let raced = false
    installSession(vault, {
      // A list page finishing in that gap fills the set and evicts e01 (no draft pins it yet).
      onLockRequest: async () => {
        if (raced) return
        raced = true
        await vault.load([id(2), id(3), id(4)])
      },
    })
    await call('update_entry', { id: id(1), title: 'Renamed entry' })
    expect(raced).toBe(true)
    expect(vault.getEntry(id(1)).metadata.title).toBe('Renamed entry')
  })
})

describe('time ranges', () => {
  // Sat 2026-10-03 12:00 local.
  const now = new Date(2026, 9, 3, 12).getTime()
  const day = (y: number, m: number, d: number): number =>
    Math.floor(new Date(y, m, d).getTime() / 1000)

  it('computes local calendar bounds like the desktop', () => {
    expect(timeRangeBounds('all', 1, now)).toBeNull()
    expect(timeRangeBounds('today', 1, now)).toEqual([day(2026, 9, 3), day(2026, 9, 4)])
    expect(timeRangeBounds('thisMonth', 1, now)).toEqual([day(2026, 9, 1), day(2026, 10, 1)])
    expect(timeRangeBounds('thisYear', 1, now)).toEqual([day(2026, 0, 1), day(2027, 0, 1)])
    // Saturday: week starts Monday 2026-09-28, or Sunday 2026-09-27.
    expect(timeRangeBounds('thisWeek', 1, now)).toEqual([day(2026, 8, 28), day(2026, 9, 5)])
    expect(timeRangeBounds('thisWeek', 0, now)).toEqual([day(2026, 8, 27), day(2026, 9, 4)])
  })
})

describe('single entry', () => {
  it('fetches an unloaded entry on demand and returns the desktop Entry shape', async () => {
    const { vault } = installFakeSession([
      {
        id: 'a',
        updatedAt: 5,
        entryDate: 50,
        title: 'T',
        text: 'B',
        emotion: 'good',
        favorite: true,
        media: 2,
        yjs: [9, 8, 7],
      },
    ])
    const entry = await call<Entry>('get_entry', { id: 'a', activeVaultId: null })
    expect(vault.loadCalls).toEqual([['a']])
    expect(entry).toMatchObject({
      id: 'a',
      journal_id: 'j1',
      title: 'T',
      content_text: 'B',
      entry_date: 50,
      emotion: 'good',
      is_favorite: true,
      is_deleted: false,
      is_locked: false,
      is_invisible: false,
      vault_id: null,
      media_count: 2,
      from_chat: false,
      latitude: null,
      entry_date_user_edited: false,
    })
    await call('get_entry', { id: 'a' })
    expect(vault.loadCalls).toHaveLength(1)
    expect(await call('get_entry_content', { id: 'a' })).toEqual([9, 8, 7])
  })

  it('returns null for an unknown id and for an entry without a body', async () => {
    installFakeSession([{ id: 'empty', updatedAt: 1, yjs: [] }])
    expect(await call('get_entry', { id: 'nope' })).toBeNull()
    expect(await call('get_entry_content', { id: 'nope' })).toBeNull()
    expect(await call('get_entry_content', { id: 'empty' })).toBeNull()
  })

  it('rejects locked, invisible and deleted entries with a clear message', async () => {
    installFakeSession([
      { id: 'l', updatedAt: 3, locked: true },
      { id: 'i', updatedAt: 2, invisible: true },
      { id: 'd', updatedAt: 1, tombstone: true },
    ])
    for (const name of ['get_entry', 'get_entry_content']) {
      for (const entryId of ['l', 'i', 'd']) {
        await expect(call(name, { id: entryId })).rejects.toThrow(MSG_UNAVAILABLE)
      }
    }
  })

  it('serves a desktop-Trash copy the vault already holds, as a deleted entry with its body', async () => {
    const { vault } = installFakeSession([
      { id: 't', updatedAt: 4, trashedAt: 700, title: 'Binned', yjs: [4, 5, 6] },
    ])
    await vault.loadTrashed(['t'])

    const entry = await call<Entry>('get_entry', { id: 't' })
    expect(entry).toMatchObject({ id: 't', title: 'Binned', is_deleted: true, trashed_at: 700 })
    expect(entry.trash_pending_desktop).toBeUndefined()
    expect(await call('get_entry_content', { id: 't' })).toEqual([4, 5, 6])
    expect(vault.loadTrashedCalls).toEqual([['t']])
  })

  it('serves a pending web delete from its overlay, dated by its trash draft', async () => {
    const { vault, db } = installFakeSession([
      { id: 'p', updatedAt: 4, title: 'Synced', yjs: [1, 2] },
    ])
    await vault.load(['p'])
    vault.setOutboxIntents([
      {
        entry_id: 'p',
        created_on_web: false,
        fields: { title: { value: 'Edited on web' } },
        yjs_full_state: [],
      } as unknown as OutboxEntryV1,
    ])
    await db.drafts.put({
      entryId: 'd-p',
      kind: 'trash',
      sealed: new Uint8Array([2]),
      updatedAt: 1_700_000_000_999,
    })
    vault.setTrashedIds(['p'])

    expect(await call<Entry>('get_entry', { id: 'p' })).toMatchObject({
      id: 'p',
      title: 'Edited on web',
      is_deleted: true,
      trash_pending_desktop: true,
      trashed_at: 1_700_000_000,
    })
    expect(await call('get_entry_content', { id: 'p' })).toEqual([1, 2])
    expect(vault.loadTrashedCalls).toEqual([])
  })

  it('serves a pending delete of a web-created entry from its create intent', async () => {
    const { vault } = installFakeSession([])
    vault.setOutboxIntents([
      {
        entry_id: 'w',
        created_on_web: true,
        web_device_id: 'web',
        web_updated_at_secs: 100,
        fields: { title: { value: 'Made on web' } },
        yjs_full_state: [7],
      } as unknown as OutboxEntryV1,
    ])
    vault.setTrashedIds(['w'])

    expect(await call<Entry>('get_entry', { id: 'w' })).toMatchObject({
      id: 'w',
      title: 'Made on web',
      is_deleted: true,
      trash_pending_desktop: true,
      trashed_at: null,
    })
    expect(await call('get_entry_content', { id: 'w' })).toEqual([7])
  })

  it('still rejects a trashed entry the vault does not hold, without fetching it', async () => {
    const { vault } = installFakeSession([{ id: 't', updatedAt: 4, trashedAt: 700 }])
    for (const name of ['get_entry', 'get_entry_content']) {
      await expect(call(name, { id: 't' })).rejects.toThrow(MSG_UNAVAILABLE)
    }
    expect(vault.loadTrashedCalls).toEqual([])
  })

  it('still rejects locked and invisible trashed entries', async () => {
    const { vault } = installFakeSession([
      { id: 'l', updatedAt: 3, trashedAt: 700, locked: true },
      { id: 'i', updatedAt: 2, trashedAt: 700, invisible: true },
    ])
    await vault.loadTrashed(['l', 'i'])
    for (const name of ['get_entry', 'get_entry_content']) {
      for (const entryId of ['l', 'i']) {
        await expect(call(name, { id: entryId })).rejects.toThrow(MSG_UNAVAILABLE)
      }
    }
  })

  it('surfaces an entry that cannot be opened', async () => {
    installFakeSession([{ id: 'x', updatedAt: 1, fails: true }])
    await expect(call('get_entry', { id: 'x' })).rejects.toThrow('Could not open this entry: boom')
  })

  it('coerces an unknown emotion to null and counts media', () => {
    const { vault } = installFakeSession([{ id: 'a', updatedAt: 1, emotion: 'angry', media: 3 }])
    return vault.load(['a']).then(() => {
      const entry = toEntry(vault.getEntry('a'))
      expect(entry.emotion).toBeNull()
      expect(entry.media_count).toBe(3)
    })
  })
})

describe('reads over the loaded set', () => {
  // UTC midnight 2024-03-05 and 2023-03-05 (on-this-day buckets by UTC).
  const d2024 = Date.UTC(2024, 2, 5, 10) / 1000
  const d2023 = Date.UTC(2023, 2, 5, 10) / 1000
  const specs: FakeSpec[] = [
    { id: 'a', updatedAt: 9, entryDate: d2024, journal: 'j1', emotion: 'good' },
    { id: 'b', updatedAt: 8, entryDate: d2023, journal: 'j2', emotion: 'bad' },
    { id: 'c', updatedAt: 7, entryDate: d2024 + 7200, journal: 'j1', emotion: 'neutral' },
    { id: 'z', updatedAt: 1, entryDate: d2024, locked: true, emotion: 'bad' },
  ]

  async function loadAll(): Promise<void> {
    installFakeSession(specs)
    await listAll(1)
  }

  it('lists entry dates, a date range and per-journal counts, never the locked entry', async () => {
    await loadAll()
    expect(await call('list_entry_dates', { journalId: null })).toEqual([
      d2024 + 7200,
      d2024,
      d2023,
    ])
    expect(await call('list_entry_dates', { journalId: 'j2' })).toEqual([d2023])
    const range = await call<Entry[]>('list_entries_for_date_range', {
      journalId: null,
      fromTs: d2024 - 100,
      toTs: d2024 + 100,
    })
    expect(range.map((e) => e.id)).toEqual(['a'])
    expect(await call('count_entries_in_journal', { journalId: 'j1' })).toBe(2)
  })

  it('returns one pair per day and emotion for the year, latest first within a day', async () => {
    await loadAll()
    const pairs = await call<Array<[string, string]>>('get_emotion_by_date', { year: 2024 })
    const dates = pairs.map(([date]) => date)
    expect([...dates].sort()).toEqual(dates)
    expect(pairs.map(([, emotion]) => emotion).sort()).toEqual(['good', 'neutral'])
    expect(pairs.every(([date]) => /^2024-03-0[56]$/.test(date))).toBe(true)
    expect(await call('get_emotion_by_date', { year: 2020 })).toEqual([])
  })
})

describe('reads over the month index', () => {
  const DAY = 86_400
  const D = Date.UTC(2026, 5, 10, 12) / 1000
  const pad = (n: number): string => String(n).padStart(2, '0')
  const localDay = (secs: number): string => {
    const d = new Date(secs * 1000)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const tag = (id: string, name: string) => ({ id, name, color: null })
  const TAGS = [tag('t1', 'alpha'), tag('t2', 'beta'), tag('t3', 'gamma')]
  // Every refused row is a favorite with tag t2 and emotion bad on its own day, so a leak shows.
  const refused = { emotion: 'bad', favorite: true, tags: ['t2'] }
  const rows: FakeRow[] = [
    { id: 'a', entryDate: D, journal: 'j1', emotion: 'good', favorite: true, tags: ['t1'] },
    { id: 'b', entryDate: D + DAY, journal: 'j2', emotion: 'bad', tags: ['t1'] },
    { id: 'locked', entryDate: D + 3 * DAY, ...refused },
    { id: 'invisible', entryDate: D + 4 * DAY, ...refused },
    { id: 'trashed', entryDate: D + 5 * DAY, ...refused },
    { id: 'excluded', entryDate: D + 6 * DAY, journal: 'jx', ...refused },
  ]
  const specs: FakeSpec[] = [
    {
      id: 'a',
      updatedAt: 100,
      entryDate: D,
      journal: 'j1',
      emotion: 'good',
      favorite: true,
      tags: ['t1'],
    },
    { id: 'b', updatedAt: 100, entryDate: D + DAY, journal: 'j2', emotion: 'bad', tags: ['t1'] },
    { id: 'locked', updatedAt: 100, locked: true },
    { id: 'invisible', updatedAt: 100, invisible: true },
    // Locked on the desktop: never indexed, and not loaded yet.
    { id: 'lockedLater', updatedAt: 50, locked: true },
    // Loaded with no row (stands for a web create).
    {
      id: 'web',
      updatedAt: 300,
      entryDate: D + 2 * DAY,
      journal: 'j1',
      emotion: 'neutral',
      favorite: true,
      tags: ['t3'],
    },
  ]
  const paged = async (name: string, extra: Record<string, unknown>) =>
    (await call<PagedResult<Entry>>(name, { ...PAGE_ARGS, page: 1, ...extra })).total

  it.each<[string, () => Promise<unknown>, unknown]>([
    [
      'get_emotion_by_date',
      () => call('get_emotion_by_date', { year: 2026 }),
      [
        [localDay(D), 'good'],
        [localDay(D + DAY), 'bad'],
        [localDay(D + 2 * DAY), 'neutral'],
      ],
    ],
    [
      'list_entry_dates',
      () => call('list_entry_dates', { journalId: null }),
      [D + 2 * DAY, D + DAY, D],
    ],
    [
      'list_entries_for_date_range',
      async () =>
        (
          await call<Entry[]>('list_entries_for_date_range', {
            journalId: null,
            fromTs: D - DAY,
            toTs: D + 10 * DAY,
          })
        ).map((e) => e.id),
      ['web', 'b', 'a'],
    ],
    ['count_entries_in_journal', () => call('count_entries_in_journal', { journalId: 'j1' }), 2],
    // Plus one page (pageSize 1) while `lockedLater` is unloaded with no row, never its count.
    ['list_all_entries_paged total', () => paged('list_all_entries_paged', {}), 4],
    ['list_entries_paged total', () => paged('list_entries_paged', { journalId: 'j1' }), 2],
    ['list_favorite_entries_paged total', () => paged('list_favorite_entries_paged', {}), 2],
    [
      'list_entries_by_tag_paged total',
      () => paged('list_entries_by_tag_paged', { tagId: 't1' }),
      2,
    ],
    [
      'get_tags_with_counts',
      () => Promise.resolve(taxonomyHandlers.get_tags_with_counts({})),
      [
        [TAGS[0], 2],
        [TAGS[2], 1],
        [TAGS[1], 0],
      ],
    ],
  ])(
    '%s counts unloaded index rows, never locked, invisible, pending-trash or excluded rows',
    async (_name, run, expected) => {
      const { vault } = installFakeSession(specs, {
        pageSize: 1,
        taxonomy: { ...EMPTY_TAXONOMY, tags: TAGS, excludedJournalIds: ['jx'] },
        monthIndex: fakeMonthIndex(rows, ['jx']),
      })
      await vault.load(['locked', 'invisible', 'web'])
      vault.setTrashedIds(['trashed'])
      expect(await run()).toEqual(expected)
    },
  )
})

describe('paged totals the month index cannot place', () => {
  const D = Date.UTC(2026, 5, 10, 12) / 1000
  // `stale` changed after the index was written (unconfirmed); `fresh` is not indexed yet.
  const rows: FakeRow[] = [
    { id: 'a', entryDate: D, journal: 'j1', updatedAt: 400 },
    { id: 'stale', entryDate: D, journal: 'j1', winnerUpdatedAt: 200 },
  ]
  const specs: FakeSpec[] = [
    { id: 'a', updatedAt: 400, entryDate: D, journal: 'j1' },
    { id: 'stale', updatedAt: 200, entryDate: D, journal: 'j1' },
    { id: 'fresh', updatedAt: 50, entryDate: D, journal: 'j1' },
  ]
  const total = async (
    name: string,
    extra: Record<string, unknown> = {},
    ids: readonly string[] = specs.map((s) => s.id),
  ) => {
    installFakeSession(
      specs.filter((s) => ids.includes(s.id)),
      { pageSize: 1, monthIndex: fakeMonthIndex(rows.filter((r) => ids.includes(r.id))) },
    )
    // Page 1 of one loads only `a` (most recently updated); `stale` and `fresh` stay unloaded.
    return (await call<PagedResult<Entry>>(name, { ...PAGE_ARGS, page: 1, ...extra })).total
  }
  const j1 = { journalId: 'j1' }

  it('the all-entries list adds one page for the unloaded entries it cannot place', async () => {
    // `stale` and `fresh` are unplaced: one page (1) of slack, never their count.
    expect(await total('list_all_entries_paged')).toBe(2)
  })

  it('a filtered list adds a page for an unloaded unconfirmed entry, not an unknown one', async () => {
    // `a` plus one page for `stale`.
    expect(await total('list_entries_paged', j1, ['a', 'stale'])).toBe(2)
    // `fresh` alone: unplaced in the all-entries list, but a filtered list does not count it.
    expect(await total('list_all_entries_paged', {}, ['a', 'fresh'])).toBe(2)
    expect(await total('list_entries_paged', j1, ['a', 'fresh'])).toBe(1)
  })
})

describe('paged totals never reveal unloaded locked or invisible entries', () => {
  const D = Date.UTC(2026, 5, 10, 12) / 1000
  const visible = ['v1', 'v2', 'v3']
  const rows: FakeRow[] = visible.map((id) => ({ id, entryDate: D, journal: 'j1', updatedAt: 900 }))
  // Never indexed (the desktop builder skips them) and the least recently updated: loaded last.
  const specsWith = (hiddenCount: number): FakeSpec[] => [
    ...visible.map((id) => ({ id, updatedAt: 900, entryDate: D, journal: 'j1' })),
    ...Array.from({ length: hiddenCount }, (_, i) => ({
      id: `h${i}`,
      updatedAt: 10 + i,
      ...(i % 2 === 0 ? { locked: true } : { invisible: true }),
    })),
  ]

  // [list, command, args, degraded months (null: no month index), total of page 1 at pageSize 2]
  it.each<[string, string, Record<string, unknown>, readonly string[] | null, number]>([
    // The 3 visible facts + one page.
    ['the all-entries list', 'list_all_entries_paged', {}, [], 5],
    // A month listed in the catalog with no month file: its rows are unknown.
    ['a list with a degraded month', 'list_entries_paged', { journalId: 'j1' }, ['2026-04'], 5],
    // No month index (older desktop): the 2 loaded matches + one page.
    ['a list without a month index', 'list_all_entries_paged', {}, null, 4],
  ])(
    '%s: one page of slack whatever the hidden count, exact once exhausted',
    async (_n, name, extra, degraded, partial) => {
      const total = async (hiddenCount: number, pageSize: number) => {
        installFakeSession(specsWith(hiddenCount), {
          pageSize,
          ...(degraded === null ? {} : { monthIndex: fakeMonthIndex(rows, [], degraded) }),
        })
        return (await call<PagedResult<Entry>>(name, { ...PAGE_ARGS, page: 1, ...extra })).total
      }
      // Page 1 of 2 loads v1, v2: the hidden ids stay unloaded behind v3. Fewer or more hidden
      // ids than a page report the same total, so it never reveals their count.
      expect(await total(1, 2)).toBe(partial)
      expect(await total(5, 2)).toBe(partial)
      // A page of 20 tries every id: the visible count.
      expect(await total(5, 20)).toBe(visible.length)
    },
  )
})

describe('entry_has_pending_web_change', () => {
  const own = (entryId: string, createdOnWeb = false) =>
    ({
      entry_id: entryId,
      created_on_web: createdOnWeb,
      web_device_id: 'web',
      web_updated_at_secs: 100,
      fields: {},
      yjs_full_state: [1],
    }) as unknown as OutboxEntryV1
  const pending = (id: string) => call<boolean>('entry_has_pending_web_change', { id })
  const docWith = (text: string): number[] => {
    const doc = new Y.Doc()
    doc.getXmlFragment('default').insert(0, [new Y.XmlText(text)])
    return Array.from(Y.encodeStateAsUpdate(doc))
  }
  const edit = (base: number[], text: string): number[] => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(base))
    doc.getXmlFragment('default').insert(1, [new Y.XmlText(text)])
    return Array.from(Y.encodeStateAsUpdate(doc))
  }
  // The synced doc of 'y', another browser's edit on top of it, and the synced doc of 'z': that
  // edit imported by the desktop, which then kept editing (strictly ahead of the intent).
  const syncedDoc = docWith('synced')
  const editedDoc = edit(syncedDoc, 'web edit')
  const aheadDoc = edit(editedDoc, 'desktop edit')
  const foreign = (entryId: string, yjs: number[]) => ({ ...own(entryId), yjs_full_state: yjs })

  it.each<[string, string, OutboxEntryV1[], boolean, OutboxEntryV1[]?]>([
    ['a visible entry with an own intent', 'e', [own('e')], true],
    ['a visible entry without one', 'e', [own('other')], false],
    ['an entry created on this web', 'w', [own('w', true)], true],
    // Another browser's unimported intent is in the editor's overlaid Y.Doc too.
    ['a foreign intent not in the synced doc', 'y', [], true, [foreign('y', editedDoc)]],
    // Imported: the desktop's synced doc holds it, the authoring browser's copy just lingers.
    ['a foreign intent the synced doc holds', 'z', [], false, [foreign('z', editedDoc)]],
    ['a foreign intent that does not decode', 'e', [], true, [own('e')]],
    // Never usable for a refused entry, whatever the outbox holds: restore stays blocked.
    ['a locked entry with an intent', 'locked', [own('locked')], true],
    ['a locked entry without one', 'locked', [], true],
    ['an invisible entry with an intent', 'invisible', [own('invisible')], true],
    ['an invisible entry without one', 'invisible', [], true],
    ['an unknown entry', 'nope', [], true],
  ])('%s', async (_name, entryId, intents, expected, foreign = []) => {
    const { vault } = installFakeSession([
      { id: 'e', updatedAt: 1 },
      { id: 'y', updatedAt: 1, yjs: syncedDoc },
      { id: 'z', updatedAt: 1, yjs: aheadDoc },
      { id: 'locked', updatedAt: 1, locked: true },
      { id: 'invisible', updatedAt: 1, invisible: true },
    ])
    vault.setOutboxIntents(intents)
    vault.setForeignIntents(foreign)
    expect(await pending(entryId)).toBe(expected)
  })

  it('re-loads an entry evicted while it waited for the outbox lock: no spurious block', async () => {
    const vault = realVault([{ id: 'z', updatedAt: 9, yjs: aheadDoc }, ...many(3)], {
      maxEntries: 3,
    })
    vault.setForeignIntents([foreign('z', editedDoc)])
    let raced = false
    installSession(vault, {
      // A list page finishing in that gap fills the set and evicts z.
      onLockRequest: async () => {
        if (raced) return
        raced = true
        await vault.load([id(1), id(2), id(3)])
      },
    })
    expect(await pending('z')).toBe(false)
    expect(raced).toBe(true)
  })

  it('reports a stored entry draft even when no intent is in RAM', async () => {
    const { db } = installFakeSession([{ id: 'e', updatedAt: 1 }])
    await db.drafts.put({ entryId: 'e', sealed: new Uint8Array([1]), updatedAt: 1 })
    expect(await pending('e')).toBe(true)
  })
})

describe('locked vault', () => {
  it('rejects every handler and downloads nothing', async () => {
    const { vault, setUnlocked } = installFakeSession(many(3))
    setUnlocked(false)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_entries_paged', { ...PAGE_ARGS, journalId: 'j1', page: 1 }],
      ['list_all_entries_paged', { ...PAGE_ARGS, page: 1 }],
      ['list_favorite_entries_paged', { ...PAGE_ARGS, journalId: null, page: 1 }],
      ['list_entries_by_tag_paged', { ...PAGE_ARGS, tagId: 't', journalId: null, page: 1 }],
      ['get_entry', { id: id(1) }],
      ['get_entry_content', { id: id(1) }],
      ['list_entry_dates', { journalId: null }],
      ['list_entries_for_date_range', { journalId: null, fromTs: 0, toTs: 1 }],
      ['get_emotion_by_date', { year: 2024 }],
      ['count_entries_in_journal', { journalId: 'j1' }],
      ['entry_has_pending_web_change', { id: id(1) }],
    ]
    for (const [name, args] of calls) {
      await expect(call(name, args), name).rejects.toThrow('vault is locked')
    }
    expect(vault.loadCalls).toEqual([])
  })
})

describe('write commands', () => {
  const TAXONOMY: Taxonomy = {
    journals: [
      {
        id: 'j1',
        name: 'Daily',
        color: null,
        sort_order: 1,
        created_at: 1000,
        updated_at: 1000,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        is_initial_placeholder: false,
      },
      {
        id: 'j2',
        name: 'Work',
        color: null,
        sort_order: 2,
        created_at: 2000,
        updated_at: 2000,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        is_initial_placeholder: false,
      },
    ],
    autoTagIds: { j1: ['t1', 't2'] },
    excludedJournalIds: [],
    knownJournalIds: ['j1', 'j2'],
    tags: [
      { id: 't1', name: 'Work', color: null },
      { id: 't2', name: 'Ideas', color: null },
    ],
    knownTagIds: ['t1', 't2'],
    deletedTagNames: [],
    lockedJournalNames: [],
    templates: [],
    deletedTemplateIds: [],
    templateUpdatedAt: {},
    tagUpdatedAt: {},
  }

  it('rejects every write command with read_only when write flag is disabled', async () => {
    setWriteFlagForTest(false)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(2), { taxonomy: TAXONOMY })

    const writeCalls: Array<[string, Record<string, unknown>]> = [
      ['create_entry', { journalId: 'j1', title: 'New' }],
      ['save_entry_content', { id: id(1), yjsDoc: [], contentText: '', previewText: '' }],
      ['update_entry', { id: id(1), title: 'Updated' }],
      ['update_entry_date', { id: id(1), entryDate: 12345 }],
      ['update_entry_emotion', { id: id(1), emotion: 'good' }],
      ['toggle_favorite', { id: id(1) }],
      ['move_entry_to_journal', { id: id(1), journalId: 'j2' }],
      ['mark_entry_date_user_edited', { id: id(1) }],
      ['add_tag_to_entry', { entryId: id(1), tagId: 't1' }],
      ['remove_tag_from_entry', { entryId: id(1), tagId: 't1' }],
      ['pick_image', { entryId: id(1) }],
      ['pick_video', { entryId: id(1) }],
      ['save_pasted_image', { entryId: id(1), bytes: [1, 2, 3], mime: 'image/png' }],
    ]

    for (const [name, args] of writeCalls) {
      await expect(call(name, args), name).rejects.toThrow('read_only')
    }
  })

  it('get_media_upload_limits returns default caps even when write flag is disabled', async () => {
    setWriteFlagForTest(false)
    const limits = await call<{ photoBytes: number; videoBytes: number }>(
      'get_media_upload_limits',
      {},
    )
    expect(limits.photoBytes).toBe(5 * 1024 * 1024)
    expect(limits.videoBytes).toBe(100 * 1024 * 1024)
  })

  it('create_entry generates UUID, applies auto-tags, saves draft, and overlays into vault', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted, db } = installFakeSession([], { taxonomy: TAXONOMY })

    const created = await call<Entry>('create_entry', {
      journalId: 'j1',
      title: 'First web entry',
      contentText: 'Hello web companion',
      previewText: 'Hello web companion',
      entryDate: 1700000000,
    })

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.title).toBe('First web entry')
    expect(created.journal_id).toBe('j1')
    expect(created.content_text).toBe('Hello web companion')
    expect(created.entry_date).toBe(1700000000)

    // Verify overlaid in vault
    const fromVault = vault.getEntry(created.id)
    expect(fromVault.metadata.title).toBe('First web entry')
    expect(fromVault.metadata.tag_ids).toEqual(['t1', 't2']) // auto tags

    // Verify draft saved
    const drafts = await db.drafts.list()
    expect(drafts.length).toBe(1)
    expect(drafts[0].entryId).toBe(created.id)

    expect(emitted).toContain('memlore:entries-changed')
  })

  it('stamps intents with the Drive-corrected clock, not the browser clock', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { db } = installFakeSession(many(2), { taxonomy: TAXONOMY })
    const browserNow = Date.now()
    // Drive says the time is one hour ahead of this browser.
    updateClockOffset(new Date(browserNow + 3_600_000).toUTCString(), browserNow)
    try {
      await call('toggle_favorite', { id: id(1) })
      const draft = await db.drafts.get(id(1))
      const intent = JSON.parse(new TextDecoder().decode(draft?.sealed)) as {
        web_updated_at_secs: number
        fields: { is_favorite: { changed_at_secs: number } }
      }
      const expected = Math.floor(browserNow / 1000) + 3600
      expect(Math.abs(intent.web_updated_at_secs - expected)).toBeLessThanOrEqual(5)
      expect(Math.abs(intent.fields.is_favorite.changed_at_secs - expected)).toBeLessThanOrEqual(5)
    } finally {
      resetClock()
    }
  })

  it('create_entry writes initial content in the desktop editor shape (XmlFragment default)', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { db } = installFakeSession([], { taxonomy: TAXONOMY })

    const created = await call<Entry>('create_entry', {
      journalId: 'j1',
      contentText: 'First line\nSecond line',
      previewText: 'First line',
    })

    const draft = await db.drafts.get(created.id)
    const intent = JSON.parse(new TextDecoder().decode(draft?.sealed)) as {
      yjs_full_state: number[]
    }
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(intent.yjs_full_state))
    const paragraphs = doc.getXmlFragment('default').toArray()
    expect(paragraphs.map((p) => (p as Y.XmlElement).nodeName)).toEqual(['paragraph', 'paragraph'])
    expect(paragraphs.map((p) => (p as Y.XmlElement).toArray().join(''))).toEqual([
      'First line',
      'Second line',
    ])
    // Never the sync-test-only shape: the desktop editor would show an empty body.
    expect(doc.getText('content').toString()).toBe('')
  })

  it('create_entry rejects when journalId is missing or unknown', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession([], { taxonomy: TAXONOMY })

    await expect(call('create_entry', { journalId: '' })).rejects.toThrow('journalId is required')
    await expect(call('create_entry', { journalId: 'unknown_j' })).rejects.toThrow(
      'Journal not found',
    )
  })

  it('save_entry_content updates Yjs doc, contentText, and draft', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted, db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    await call('save_entry_content', {
      id: id(1),
      yjsDoc: [1, 2, 3, 4],
      contentText: 'Updated body text',
      previewText: 'Updated preview text',
    })

    const fromVault = vault.getEntry(id(1))
    expect(fromVault.contentText).toBe('Updated body text')
    expect(fromVault.previewText).toBe('Updated preview text')

    const drafts = await db.drafts.list()
    expect(drafts.length).toBe(1)
    expect(drafts[0].entryId).toBe(id(1))
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('update_entry updates title and preserves metadata', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const updated = await call<Entry>('update_entry', {
      id: id(1),
      title: 'Renamed entry',
    })

    expect(updated.title).toBe('Renamed entry')
    expect(vault.getEntry(id(1)).metadata.title).toBe('Renamed entry')
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('update_entry_date updates date and emits changed', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    await call('update_entry_date', {
      id: id(1),
      entryDate: 1711111111,
    })

    expect(vault.getEntry(id(1)).metadata.entry_date).toBe(1711111111)
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('update_entry_emotion updates emotion or clears to null, rejecting invalid values', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const withGood = await call<Entry>('update_entry_emotion', { id: id(1), emotion: 'good' })
    expect(withGood.emotion).toBe('good')
    expect(vault.getEntry(id(1)).metadata.emotion).toBe('good')

    const withNull = await call<Entry>('update_entry_emotion', { id: id(1), emotion: null })
    expect(withNull.emotion).toBe(null)
    expect(vault.getEntry(id(1)).metadata.emotion).toBe(null)

    await expect(call('update_entry_emotion', { id: id(1), emotion: 'ecstatic' })).rejects.toThrow(
      'invalid emotion',
    )
  })

  it('toggle_favorite flips is_favorite and returns new boolean', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(
      many(1, () => ({ favorite: false })),
      { taxonomy: TAXONOMY },
    )

    const first = await call<boolean>('toggle_favorite', { id: id(1) })
    expect(first).toBe(true)
    expect(vault.getEntry(id(1)).metadata.is_favorite).toBe(true)

    const second = await call<boolean>('toggle_favorite', { id: id(1) })
    expect(second).toBe(false)
    expect(vault.getEntry(id(1)).metadata.is_favorite).toBe(false)
  })

  it('move_entry_to_journal moves entry to visible journal, rejecting unknown journals', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(
      many(1, () => ({ journal: 'j1' })),
      { taxonomy: TAXONOMY },
    )

    await call('move_entry_to_journal', { id: id(1), journalId: 'j2' })
    expect(vault.getEntry(id(1)).metadata.journal_id).toBe('j2')

    await expect(call('move_entry_to_journal', { id: id(1), journalId: 'bad_j' })).rejects.toThrow(
      'Journal not found',
    )
  })

  it('mark_entry_date_user_edited records the flag on the intent and reports it in the overlay', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted, db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    await call('mark_entry_date_user_edited', { id: id(1) })

    // The intent carries no flag field of its own: `entry_date_user_edited`
    // rides on an entry_date change — the desktop importer sets the flag when
    // it applies one, and the overlay mirrors that. A bare mark confirms the
    // current date (value === base, so the importer reports it "reflected").
    const intent = vault.getOutboxIntent(id(1))
    expect(intent?.fields.entry_date?.value).toBe('100')
    expect(intent?.fields.entry_date?.base).toBe('100')
    expect(vault.getEntry(id(1)).metadata.entry_date_user_edited).toBe(true)
    expect((await call<Entry>('get_entry', { id: id(1) }))?.entry_date_user_edited).toBe(true)
    expect(await db.drafts.get(id(1))).toBeDefined()
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('mark_entry_date_user_edited after a date edit leaves the recorded change intact', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    await call('update_entry_date', { id: id(1), entryDate: 1711111111 })
    await call('mark_entry_date_user_edited', { id: id(1) })

    // The user's date change keeps its original base and change_seq —
    // overwriting it would turn a conflict-detectable edit into a no-op.
    const intent = vault.getOutboxIntent(id(1))
    expect(intent?.fields.entry_date?.value).toBe('1711111111')
    expect(intent?.fields.entry_date?.base).toBe('100')
    expect(vault.getEntry(id(1)).metadata.entry_date_user_edited).toBe(true)
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('mark_entry_date_user_edited rejects an entry the vault cannot serve', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession([...many(1), { id: 'l', updatedAt: 1, locked: true }], {
      taxonomy: TAXONOMY,
    })

    await expect(call('mark_entry_date_user_edited', { id: 'nope' })).rejects.toThrow(
      MSG_UNAVAILABLE,
    )
    await expect(call('mark_entry_date_user_edited', { id: 'l' })).rejects.toThrow(MSG_UNAVAILABLE)
  })

  it('refuses writes on locked, invisible and excluded-journal entries with EntryNotAvailableError', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(
      [
        ...many(1, () => ({ journal: 'j2' })),
        { id: 'l', updatedAt: 2, locked: true },
        { id: 'i', updatedAt: 1, invisible: true },
      ],
      { taxonomy: TAXONOMY },
    )
    // The fake vault has no journal exclusion: e01 stands in for an entry of an excluded journal.
    const realWriteView = vault.getWriteView
    Object.defineProperty(vault, 'getWriteView', {
      value: (entryId: string) => {
        if (entryId === id(1)) throw new EntryUnavailableError(entryId, 'journal')
        return realWriteView(entryId)
      },
    })
    setCustomMediaPicker(async () => {
      throw new Error('the picker must not open for an unavailable entry')
    })

    for (const target of ['l', 'i', id(1)]) {
      const writeCalls: Array<[string, Record<string, unknown>]> = [
        ['save_entry_content', { id: target, yjsDoc: [], contentText: '', previewText: '' }],
        ['update_entry', { id: target, title: 'Updated' }],
        ['update_entry_date', { id: target, entryDate: 12345 }],
        ['update_entry_emotion', { id: target, emotion: 'good' }],
        ['toggle_favorite', { id: target }],
        ['move_entry_to_journal', { id: target, journalId: 'j1' }],
        ['add_tag_to_entry', { entryId: target, tagId: 't1' }],
        ['remove_tag_from_entry', { entryId: target, tagId: 't1' }],
        ['pick_image', { entryId: target }],
        ['pick_video', { entryId: target }],
        ['save_pasted_image', { entryId: target, bytes: [1, 2, 3], mime: 'image/png' }],
      ]
      for (const [name, args] of writeCalls) {
        const error = await Promise.resolve()
          .then(() => call(name, args))
          .then(
            () => null,
            (e: unknown) => e,
          )
        expect(error, `${name} ${target}`).toBeInstanceOf(EntryNotAvailableError)
        expect((error as Error).message).toBe(MSG_UNAVAILABLE)
      }
    }
    expect(vault.getOutboxIntents()).toEqual([])
  })

  it('add_tag_to_entry and remove_tag_from_entry modify existing tags only', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(
      many(1, () => ({ tags: [] })),
      { taxonomy: TAXONOMY },
    )

    await call('add_tag_to_entry', { entryId: id(1), tagId: 't1' })
    expect(vault.getEntry(id(1)).metadata.tag_ids).toContain('t1')

    await call('remove_tag_from_entry', { entryId: id(1), tagId: 't1' })
    expect(vault.getEntry(id(1)).metadata.tag_ids).not.toContain('t1')

    await expect(
      call('add_tag_to_entry', { entryId: id(1), tagId: 'nonexistent' }),
    ).rejects.toThrow('Tag not found')
  })

  it('pick_image returns null when user cancels file picker', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(1), { taxonomy: TAXONOMY })
    setCustomMediaPicker(async () => null) // user cancelled

    const result = await call('pick_image', { entryId: id(1) })
    expect(result).toBeNull()
  })

  it('pick_image enforces photo size limit', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(1), { taxonomy: TAXONOMY })

    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    setCustomMediaPicker(async () => oversized)

    await expect(call('pick_image', { entryId: id(1) })).rejects.toThrow('IMAGE_TOO_LARGE')
  })

  it('pick_image saves media and thumbnail into outbox blobs and updates intent', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { emitted, db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const file = new File([new Uint8Array([10, 20, 30])], 'photo.jpg', { type: 'image/jpeg' })
    setCustomMediaPicker(async () => file)

    const res = await call<{ mediaId: string; localPath: string }>('pick_image', { entryId: id(1) })
    expect(res.mediaId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.localPath).toBe(`memlore-web://media/${res.mediaId}`)

    // Check media blob stored in db.blobs
    const blob = await db.blobs.get(`outbox/m-${res.mediaId}`)
    expect(blob).toBeDefined()
    const thumbBlob = await db.blobs.get(`outbox/m-${res.mediaId}.thumb`)
    expect(thumbBlob).toBeDefined()

    expect(emitted).toContain('media-changed')
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('save_pasted_image saves pasted bytes, generates thumbnail, and returns mediaId', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const res = await call<{ mediaId: string; localPath: string }>('save_pasted_image', {
      entryId: id(1),
      bytes: [50, 60, 70],
      mime: 'image/png',
    })

    expect(res.mediaId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.localPath).toBe(`memlore-web://media/${res.mediaId}`)

    const blob = await db.blobs.get(`outbox/m-${res.mediaId}`)
    expect(blob).toBeDefined()
  })

  it('pick_image and save_pasted_image reject unsupported or dangerous MIME types', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(1), { taxonomy: TAXONOMY })

    const badFile = new File([new Uint8Array([1, 2, 3])], 'attack.html', { type: 'text/html' })
    setCustomMediaPicker(async () => badFile)
    await expect(call('pick_image', { entryId: id(1) })).rejects.toThrow('unsupported mime type')

    await expect(
      call('save_pasted_image', {
        entryId: id(1),
        bytes: [1, 2, 3],
        mime: 'text/html',
      }),
    ).rejects.toThrow('unsupported mime type')
  })

  it('preserves content_text and preview_text across metadata updates', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(
      many(1, () => ({ text: 'My precious journal content' })),
      { taxonomy: TAXONOMY },
    )

    // First save content
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'My updated journal content')
    await call('save_entry_content', {
      id: id(1),
      yjsDoc: Array.from(Y.encodeStateAsUpdate(doc)),
      contentText: 'My updated journal content',
      previewText: 'My updated journal content',
    })

    const intentAfterContent = vault.getOutboxIntent(id(1))
    expect(intentAfterContent?.content_text).toBe('My updated journal content')

    // Now do metadata-only updates
    await call('toggle_favorite', { id: id(1) })
    const intentAfterFav = vault.getOutboxIntent(id(1))
    expect(intentAfterFav?.content_text).toBe('My updated journal content')
    expect(intentAfterFav?.preview_text).toBe('My updated journal content')

    await call('update_entry_emotion', { id: id(1), emotion: 'good' })
    const intentAfterEmotion = vault.getOutboxIntent(id(1))
    expect(intentAfterEmotion?.content_text).toBe('My updated journal content')
  })
})

describe('soft_delete_entry: move to the desktop Trash (outbox v3 trash_entry)', () => {
  // A Day One import: the desktop keeps any safe id (memlore-core `is_safe_id`), not only uuids.
  const E1 = '0123456789ABCDEF0123456789ABCDEF'
  const E2 = '33333333-3333-4333-8333-333333333332'
  const JOURNALS: Taxonomy = {
    ...EMPTY_TAXONOMY,
    journals: [
      {
        id: 'j1',
        name: 'Daily',
        color: null,
        sort_order: 1,
        created_at: 1000,
        updated_at: 1000,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        is_initial_placeholder: false,
      },
    ],
    knownJournalIds: ['j1'],
  }

  function writable(outboxKinds: readonly string[] = ['trash_entry']) {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    return installFakeSession(
      [
        { id: E1, updatedAt: 1500, title: 'Doomed' },
        { id: E2, updatedAt: 1400, title: 'Kept' },
      ],
      { taxonomy: JOURNALS, outboxV2: true, outboxKinds },
    )
  }

  const trashIntent = async (db: WebDb, entryId: string): Promise<OutboxIntentV3 | undefined> => {
    const rec = await db.drafts.get(`d-${entryId}`)
    if (rec === undefined) return undefined
    expect(rec.kind).toBe('trash')
    expect(rec.sealed[0]).toBe(3) // frame 3
    return JSON.parse(new TextDecoder().decode(rec.sealed.subarray(1))) as OutboxIntentV3
  }

  it('stores a trash_entry draft based on the synced updated_at and hides the entry at once', async () => {
    const { db, emitted } = writable()
    expect((await listAll(1)).items.map((e) => e.id)).toEqual([E1, E2])

    await call('soft_delete_entry', { id: E1 })

    expect(await trashIntent(db, E1)).toEqual({
      kind: 'trash_entry',
      web_device_id: 'test-device-id',
      web_updated_at_secs: expect.any(Number),
      entry_id: E1,
      base_updated_at: 1500,
    })
    expect(emitted).toContain('memlore:entries-changed')
    expect((await listAll(1)).items.map((e) => e.id)).toEqual([E2])
    // Still previewable from the Trash, as a pending deleted entry.
    expect(await call<Entry>('get_entry', { id: E1 })).toMatchObject({
      is_deleted: true,
      trash_pending_desktop: true,
    })
    // Further edits of a trashed entry are refused.
    await expect(call('update_entry', { id: E1, title: 'x' })).rejects.toThrow(MSG_UNAVAILABLE)
  })

  // Edit-then-delete. The desktop applies `<E>.bin` before `d-<E>.bin` in one import cycle and
  // accepts the trash when its base is the row's stamp OR the stamp the web's own applied edit
  // fast-forwarded from (`fast_forward_from`, src-tauri/src/sync/outbox_import.rs; the v1 apply
  // records `applied_from_updated_at` = the row's stamp before it, a web create records 0). That
  // stamp is the synced `updated_at` the web saw, so the base is the SYNCED stamp in both cases,
  // never an overlay value, and the edit draft is kept and still pushed first.
  it('edit then delete: the base is still the synced updated_at and the edit draft is kept', async () => {
    const { db, vault } = writable()
    await call('update_entry', { id: E1, title: 'Edited on web' })
    const edit = vault.getOutboxIntent(E1)
    expect(edit?.fields.title?.base_updated_at).toBe(1500)

    await call('soft_delete_entry', { id: E1 })

    expect(await trashIntent(db, E1)).toMatchObject({ base_updated_at: 1500 })
    expect(await db.drafts.get(E1)).toBeDefined()
    expect(vault.getOutboxIntent(E1)).toEqual(edit)
  })

  it('a web-created entry not synced yet is trashed from base 0 (the desktop create chains it)', async () => {
    const { db } = writable()
    const created = await call<Entry>('create_entry', { journalId: 'j1', title: 'Fresh' })

    await call('soft_delete_entry', { id: created.id })

    expect(await trashIntent(db, created.id)).toMatchObject({ base_updated_at: 0 })
    expect(await db.drafts.get(created.id)).toBeDefined()
    expect((await listAll(1)).items.map((e) => e.id)).not.toContain(created.id)
  })

  it('the entry reappears once its trash draft is gone (a final refusal drops it)', async () => {
    const { db } = writable()
    await call('soft_delete_entry', { id: E1 })
    await db.drafts.delete(`d-${E1}`)
    const { readEnv } = await import('./readSession')
    await (await readEnv().session()).refreshPendingV2?.()

    expect((await listAll(1)).items.map((e) => e.id)).toEqual([E1, E2])
  })

  it('refuses an entry the web cannot serve, and stores nothing', async () => {
    const { db } = writable()
    await expect(call('soft_delete_entry', { id: 'not-there' })).rejects.toThrow()
    await call('soft_delete_entry', { id: E1 })
    await expect(call('soft_delete_entry', { id: E1 })).rejects.toThrow(MSG_UNAVAILABLE)
    expect((await db.drafts.list()).map((d) => d.entryId)).toEqual([`d-${E1}`])
  })

  it('is unsupported while no desktop advertises trash_entry (a v2-only one included), read_only when writes are off', async () => {
    const { db } = writable([])
    await expect(call('soft_delete_entry', { id: E1 })).rejects.toBeInstanceOf(WebUnsupportedError)
    setWriteFlagForTest(false)
    await expect(call('soft_delete_entry', { id: E1 })).rejects.toThrow('read_only')
    expect(await db.drafts.list()).toEqual([])
    expect((await listAll(1)).items.map((e) => e.id)).toEqual([E1, E2])
  })
})

describe('update_entry_location / update_media_insertion_mode (outbox v3, web gap audit Phase 13)', () => {
  const E1 = '33333333-3333-4333-8333-333333333341'
  const MEDIA = '33333333-3333-4333-8333-3333333333a1'
  const SYNCED_LOCATION = { latitude: 21.03, longitude: 105.85, label: 'Hồ Gươm', address: null }
  const PARIS = { latitude: 48.85, longitude: 2.35, label: 'Paris', address: null }

  function writable() {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    return installFakeSession(
      [
        {
          id: E1,
          updatedAt: 1500,
          latitude: SYNCED_LOCATION.latitude,
          longitude: SYNCED_LOCATION.longitude,
          locationLabel: SYNCED_LOCATION.label,
          mediaIds: [MEDIA],
        },
      ],
      { outboxKinds: ['set_entry_location', 'set_media_insertion_mode'] },
    )
  }

  const stored = async (db: WebDb, key: string): Promise<OutboxIntentV3> => {
    const rec = await db.drafts.get(key)
    if (rec === undefined) throw new Error(`no draft ${key}`)
    return JSON.parse(new TextDecoder().decode(rec.sealed.subarray(1))) as OutboxIntentV3
  }

  const setLocation = (label: string) =>
    call<Entry>('update_entry_location', {
      id: E1,
      latitude: 48.85,
      longitude: 2.35,
      locationLabel: label,
      locationAddress: null,
    })

  it('bases the location on the synced copy, never the pending overlay, and keeps the first base', async () => {
    const { db } = writable()

    const shown = await setLocation('Paris')
    expect(shown).toMatchObject({ latitude: 48.85, longitude: 2.35, location_label: 'Paris' })
    expect(await stored(db, `l-${E1}`)).toMatchObject({
      kind: 'set_entry_location',
      value: { latitude: 48.85, longitude: 2.35, label: 'Paris', address: null },
      base: SYNCED_LOCATION,
      base_updated_at: 1500,
    })

    // A second edit before the ack: the overlay shows "Paris", the base stays the synced copy.
    await setLocation('Lyon')
    expect(await stored(db, `l-${E1}`)).toMatchObject({
      base: SYNCED_LOCATION,
      base_updated_at: 1500,
    })

    // A stored `l-` draft sealed against an older synced copy keeps ITS base (the desktop chains it).
    const older = { ...(await stored(db, `l-${E1}`)), base: null, base_updated_at: 1200 }
    await db.drafts.put({
      entryId: `l-${E1}`,
      kind: 'location',
      sealed: new Uint8Array([3, ...new TextEncoder().encode(JSON.stringify(older))]),
      updatedAt: 1,
    })
    await setLocation('Nice')
    expect(await stored(db, `l-${E1}`)).toMatchObject({
      value: { label: 'Nice' },
      base: null,
      base_updated_at: 1200,
    })
  })

  // Phase 13 review: once the synced copy shows the stored draft's value, a later edit bases on that
  // synced copy (else the vault overlay, which checks the base, would hide it after the pull).
  it.each([
    { reflected: true, base: PARIS, baseMode: 'attached', baseAt: 1600 },
    { reflected: false, base: SYNCED_LOCATION, baseMode: 'inline', baseAt: 1500 },
  ])(
    'a second edit while the first is stored, synced copy at the first value=$reflected: base $baseMode @$baseAt',
    async ({ reflected, base, baseMode, baseAt }) => {
      setWriteFlagForTest(true)
      setKeyRing({ lock: () => undefined } as unknown as KeyRing)
      // The synced copy moved on (1500 -> 1600): the desktop applied the first edit, or edited
      // something else.
      const shown = reflected ? PARIS : SYNCED_LOCATION
      // A REAL vault: its overlay checks the drafts' bases against the synced copy.
      const { db, vault } = installSession(
        realVault(
          [
            {
              id: E1,
              updatedAt: 1600,
              latitude: shown.latitude,
              longitude: shown.longitude,
              locationLabel: shown.label,
              mediaIds: [MEDIA],
              attachedMediaIds: reflected ? [MEDIA] : [],
            },
          ],
          { maxEntries: 10 },
        ),
        { outboxKinds: ['set_entry_location', 'set_media_insertion_mode'] },
      )
      await vault.load([E1])
      const seal = (intent: OutboxIntentV3) =>
        new Uint8Array([3, ...new TextEncoder().encode(JSON.stringify(intent))])
      const STAMP = { web_device_id: 'test-device-id', web_updated_at_secs: 1 }
      await db.drafts.put({
        entryId: `l-${E1}`,
        kind: 'location',
        sealed: seal({
          ...STAMP,
          kind: 'set_entry_location',
          entry_id: E1,
          value: PARIS,
          base: SYNCED_LOCATION,
          base_updated_at: 1500,
        }),
        updatedAt: 1,
      })
      await db.drafts.put({
        entryId: `i-${MEDIA}`,
        kind: 'insertion_mode',
        targetEntryId: E1,
        sealed: seal({
          ...STAMP,
          kind: 'set_media_insertion_mode',
          entry_id: E1,
          media_id: MEDIA,
          mode: 'attached',
          base_mode: 'inline',
          base_updated_at: 1500,
        }),
        updatedAt: 1,
      })

      await setLocation('Lyon')
      await call('update_media_insertion_mode', { mediaId: MEDIA, mode: 'inline' })

      expect(await stored(db, `l-${E1}`)).toMatchObject({
        value: { label: 'Lyon' },
        base,
        base_updated_at: baseAt,
      })
      expect(await stored(db, `i-${MEDIA}`)).toMatchObject({
        mode: 'inline',
        base_mode: baseMode,
        base_updated_at: baseAt,
      })
      // The second edit shows, never the first value or the synced one.
      const m = vault.getEntry(E1).metadata
      expect(m).toMatchObject({ latitude: 48.85, longitude: 2.35, location_label: 'Lyon' })
      expect(m.media).toEqual([{ id: MEDIA, insertion_mode: 'inline' }])
    },
  )

  it.each([
    ['line breaks and tabs become spaces', 'Home\nsweet\thome', 'Home sweet home'],
    ['bidi, zero-width, tag and control chars are dropped', '‮Ho​me\u{E0041}\u0007 ', 'Home'],
    ['nothing left clears the location', ' ​\n ', null],
  ])('strips the location text before sealing: %s', async (_case, label, expected) => {
    const { db } = writable()
    await call('update_entry_location', {
      id: E1,
      latitude: null,
      longitude: null,
      locationLabel: label,
      locationAddress: '',
    })
    const { value } = (await stored(db, `l-${E1}`)) as Extract<
      OutboxIntentV3,
      { kind: 'set_entry_location' }
    >
    expect(value).toEqual(
      expected === null
        ? null
        : { latitude: null, longitude: null, label: expected, address: null },
    )
  })

  it('stores the insertion mode under i-<mediaId> with its entry on the record (push hold)', async () => {
    const { db, vault } = writable()
    await vault.load([E1]) // open in the editor (a just-pasted media pins it through its draft)
    await call('update_media_insertion_mode', { mediaId: MEDIA, mode: 'attached' })

    const rec = await db.drafts.get(`i-${MEDIA}`)
    expect(rec).toMatchObject({ kind: 'insertion_mode', targetEntryId: E1 })
    expect(await stored(db, `i-${MEDIA}`)).toMatchObject({
      entry_id: E1,
      media_id: MEDIA,
      mode: 'attached',
      base_mode: 'inline',
      base_updated_at: 1500,
    })
  })
})

// Web gap audit Phase 14: file / audio attachments and `attached` media picks.
describe('attachments (Phase 14)', () => {
  const ENTRY = '11111111-2222-4333-8444-555555555555'
  const file = (name: string, size = 3): File => {
    const f = new File([new Uint8Array([1, 2, 3])], name)
    if (size !== 3) Object.defineProperty(f, 'size', { value: size })
    return f
  }
  const open = (kinds: string[]) => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    return installFakeSession([{ id: ENTRY, updatedAt: 1500 }], {
      taxonomy: EMPTY_TAXONOMY,
      outboxKinds: kinds,
    })
  }
  const v3Body = (sealed: Uint8Array): OutboxIntentV3 =>
    JSON.parse(new TextDecoder().decode(sealed.subarray(1))) as OutboxIntentV3

  it('refuses a batch with an oversize file before reading any file', async () => {
    open(['attach_media'])
    const ok = file('ok.pdf')
    const read = vi.spyOn(ok, 'arrayBuffer')
    setCustomFilesPicker(async () => [ok, file('huge.pdf', 60 * 1024 * 1024)])

    await expect(call('pick_files_to_attach', { entryId: ENTRY })).rejects.toThrow(
      'FILE_TOO_LARGE:huge.pdf:50',
    )
    expect(read).not.toHaveBeenCalled()
  })

  // A failure on the second file leaves nothing behind: no attached file 1, no blob to upload.
  it.each<[string, 'blobs' | 'drafts', Error, string]>([
    ['a full quota storing a blob', 'blobs', new StorageQuotaError(), 'StorageQuotaError'],
    ['a failed draft save', 'drafts', new Error('disk on fire'), 'Error'],
  ])('rolls the batch back on %s', async (_name, store, failure, errorName) => {
    const { db, emitted } = open(['attach_media'])
    const blobPaths: string[] = []
    const put = db[store].put.bind(db[store]) as (rec: never) => Promise<void>
    let calls = 0
    Object.defineProperty(db[store], 'put', {
      value: async (rec: { path?: string }) => {
        calls += 1
        if (calls === 2) throw failure
        if (rec.path !== undefined) blobPaths.push(rec.path)
        await put(rec as never)
      },
    })
    if (store === 'drafts') {
      const blobsPut = db.blobs.put.bind(db.blobs)
      Object.defineProperty(db.blobs, 'put', {
        value: async (rec: Parameters<WebDb['blobs']['put']>[0]) => {
          blobPaths.push(rec.path)
          await blobsPut(rec)
        },
      })
    }
    setCustomFilesPicker(async () => [file('a.pdf'), file('b.pdf'), file('c.pdf')])

    const error = await Promise.resolve(call('pick_files_to_attach', { entryId: ENTRY })).catch(
      (e: unknown) => e,
    )
    expect((error as Error).name).toBe(errorName)
    expect(await db.drafts.list()).toEqual([])
    expect(blobPaths.length).toBeGreaterThan(0)
    for (const path of blobPaths) expect(await db.blobs.get(path)).toBeUndefined()
    expect(emitted).not.toContain('media-changed')
  })

  // `attached` seals `i-<mediaId>` (base `inline`) when a desktop applies it; else refused, never
  // a silent inline insert.
  it.each([true, false])('pick_image attached with the kind advertised=%s', async (advertised) => {
    const { db } = open(advertised ? ['set_media_insertion_mode'] : [])
    const picker = vi.fn(
      async () => new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' }),
    )
    setCustomMediaPicker(picker)

    const result = call<{ mediaId: string }>('pick_image', {
      entryId: ENTRY,
      insertionMode: 'attached',
    })
    if (!advertised) {
      await expect(result).rejects.toBeInstanceOf(WebUnsupportedError)
      expect(picker).not.toHaveBeenCalled()
      expect(await db.drafts.list()).toEqual([])
      return
    }
    const { mediaId } = await result
    const mode = await db.drafts.get(`i-${mediaId}`)
    expect(mode).toBeDefined()
    expect(v3Body(mode!.sealed)).toMatchObject({
      kind: 'set_media_insertion_mode',
      entry_id: ENTRY,
      media_id: mediaId,
      mode: 'attached',
      base_mode: 'inline',
    })
  })
})
