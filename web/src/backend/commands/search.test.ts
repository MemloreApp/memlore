import { afterEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../../../../src/types/entry'
import { dispose, lock, setKeyRing, type KeyRing } from '../keys'
import { configureReadEnv } from './readSession'
import {
  installFakeSession,
  installSession,
  realVault,
  type FakeSpec,
  type FakeVault,
} from './readTestKit'
import { SEARCH_LIMIT, cancelSearchScan, searchHandlers, whenSearchScanSettled } from './search'

afterEach(() => {
  cancelSearchScan()
  configureReadEnv({})
})

const search = (query: string, extra: Record<string, unknown> = {}): Promise<SearchResult[]> =>
  Promise.resolve(
    searchHandlers.search_entries({
      query,
      filters: undefined,
      lockedView: 'revealed',
      activeVaultId: null,
      mentionMode: false,
      ...extra,
    }),
  ) as Promise<SearchResult[]>

const ids = (rows: SearchResult[]): string[] => rows.map((r) => r.id)

const SPECS: FakeSpec[] = [
  { id: 'a', updatedAt: 9, entryDate: 10, title: 'Trip to Paris', text: 'sunny day' },
  { id: 'b', updatedAt: 8, entryDate: 30, title: 'Notes', text: 'Việt Nam trip', journal: 'j2' },
  { id: 'c', updatedAt: 7, entryDate: 20, title: 'Plain', text: 'nothing here', emotion: 'good' },
  { id: 'd', updatedAt: 6, entryDate: 40, title: 'Late trip', text: 'x', tags: ['t1'], media: 1 },
  { id: 'e', updatedAt: 5, entryDate: 50, title: 'Hidden trip', locked: true },
]

/** A vault that may hold fewer entries than it has: the scan peeks (Phase 5.2). */
const OVER_CAP = { maxEntries: 2 }

describe('search_entries', () => {
  it('answers from the loaded set at once, newest entry date first', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['a', 'b'])
    vault.loadCalls.length = 0
    const rows = await search('trip')
    expect(ids(rows)).toEqual(['b', 'a'])
    expect(rows[0]).toEqual({
      id: 'b',
      journal_id: 'j2',
      title: 'Notes',
      preview_text: 'preview',
      entry_date: 30,
    })
  })

  it('under the cap, the scan loads every entry: a different query is complete at once', async () => {
    const { vault, emitted } = installFakeSession(SPECS)
    await vault.load(['a'])
    expect(ids(await search('trip'))).toEqual(['a'])
    await whenSearchScanSettled()
    expect(vault.peekCalls).toEqual([])
    expect(emitted).toEqual(['memlore:entries-changed'])
    // No re-scan needed: the first answer of another query already covers the whole vault.
    expect(ids(await search('nothing'))).toEqual(['c'])
    expect(ids(await search('trip'))).toEqual(['d', 'b', 'a'])
  })

  it('over the cap, it scans the remaining text payloads transiently and announces new hits', async () => {
    const { vault, emitted } = installFakeSession(SPECS, OVER_CAP)
    await vault.load(['a'])
    vault.loadCalls.length = 0
    expect(ids(await search('trip'))).toEqual(['a'])
    await whenSearchScanSettled()
    // 12 ids per batch: one batch holds every remaining entry. Nothing is kept loaded.
    expect(vault.peekCalls).toEqual([['b', 'c', 'd', 'e']])
    expect(vault.loadCalls).toEqual([])
    expect(vault.loadedIds).toEqual(['a'])
    expect(emitted).toEqual(['memlore:entries-changed'])
    expect(ids(await search('trip'))).toEqual(['d', 'b', 'a'])
  })

  it('scans more entries than the vault may hold: every hit, none loaded, locked and invisible never listed', async () => {
    const many: FakeSpec[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `n${String(i).padStart(2, '0')}`,
        updatedAt: 100 - i,
        entryDate: i,
        text: 'needle',
      })),
      { id: 'locked', updatedAt: 1, entryDate: 99, text: 'needle', locked: true },
      { id: 'invisible', updatedAt: 1, entryDate: 98, text: 'needle', invisible: true },
    ]
    const { vault } = installFakeSession(many, OVER_CAP)
    await vault.load(['n00', 'n01'])
    vault.loadCalls.length = 0
    expect(ids(await search('needle'))).toEqual(['n01', 'n00'])
    await whenSearchScanSettled()
    expect(vault.loadCalls).toEqual([])
    expect(vault.loadedIds).toEqual(['n00', 'n01'])
    expect(vault.peekCalls.flat()).toHaveLength(30)

    const rows = ids(await search('needle'))
    expect(rows).toHaveLength(30)
    expect(rows[0]).toBe('n29')
    expect(rows).not.toContain('locked')
    expect(rows).not.toContain('invisible')
    await whenSearchScanSettled()
    expect(vault.peekCalls.flat()).toHaveLength(30) // the same query does not scan again
  })

  it.each([
    [
      'its entry changed since (now locked)',
      (spec: FakeSpec) => {
        spec.updatedAt += 100
        spec.locked = true
      },
    ],
    [
      'its journal is excluded now',
      (_spec: FakeSpec, vault: FakeVault) => vault.excludedJournals.add('j2'),
    ],
  ])('never serves an accumulated hit once %s', async (_label, change) => {
    const specs = SPECS.map((s) => ({ ...s }))
    const { vault } = installFakeSession(specs, OVER_CAP)
    await search('trip')
    await whenSearchScanSettled()
    expect(ids(await search('trip'))).toContain('b')
    await whenSearchScanSettled()
    change(specs[1], vault)
    expect(ids(await search('trip'))).not.toContain('b')
    await whenSearchScanSettled()
    expect(ids(await search('trip'))).not.toContain('b')
  })

  it('load mode never keeps a hit whose payload stays older than its index winner, once evicted', async () => {
    // Real bounded vault: under the entry cap the scan loads; `big` overflows the text cap later.
    const vault = realVault(
      [
        { id: 'stale', updatedAt: 10, payloadUpdatedAt: 5, entryDate: 2, text: 'needle' },
        { id: 'fresh', updatedAt: 9, entryDate: 1, text: 'needle' },
        { id: 'big', updatedAt: 1, text: 'x'.repeat(100) },
      ],
      { maxEntries: 10, maxTextChars: 105 },
    )
    vault.setExcludedJournalIds([], ['j1'])
    installSession(vault)
    await search('needle')
    await whenSearchScanSettled()
    await vault.load(['big']) // evicts `stale` and `fresh`, the least recently used
    expect(vault.status('stale')).toBe('not-loaded')
    expect(vault.status('fresh')).toBe('not-loaded')
    // The fresh hit is served from the accumulator; the stale copy never was a hit.
    expect(ids(await search('needle'))).toEqual(['fresh'])
  })

  it('a lock drops the hits a finished scan collected', async () => {
    const { vault } = installFakeSession(SPECS, OVER_CAP)
    await vault.load(['a'])
    await search('trip')
    await whenSearchScanSettled()
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    try {
      lock('manual')
      expect(ids(await search('trip'))).toEqual(['a'])
    } finally {
      dispose()
    }
  })

  it('emits nothing when the background scan finds no new hit', async () => {
    const { emitted } = installFakeSession(SPECS)
    expect(await search('zzzzz')).toEqual([])
    await whenSearchScanSettled()
    expect(emitted).toEqual([])
  })

  it('never lists the locked entry, loaded or not', async () => {
    installFakeSession(SPECS)
    await search('hidden')
    await whenSearchScanSettled()
    expect(await search('hidden')).toEqual([])
    expect(await search('trip')).not.toContainEqual(expect.objectContaining({ id: 'e' }))
  })

  it('matches accent-insensitively and treats a blank query as nothing', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['b'])
    expect(ids(await search('viet'))).toEqual(['b'])
    expect(ids(await search('Việt'))).toEqual(['b'])
    expect(await search('   ')).toEqual([])
    expect(await search('!!!')).toEqual([])
  })

  it('blank query: with filters it lists the filtered loaded set, without them it cancels and stops', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['a', 'b', 'c', 'd'])
    const filtered = await search('', { filters: { emotions: ['good'] } })
    expect(ids(filtered)).toEqual(['c'])
    expect(ids(await search('', { filters: { journalIds: ['j2'] } }))).toEqual(['b'])
    expect(ids(await search('', { filters: { tagIds: ['t1', 'other'] } }))).toEqual(['d'])
    expect(ids(await search('', { filters: { hasMedia: 'has' } }))).toEqual(['d'])
    expect(
      ids(await search('', { filters: { timeRange: { from: 15, toExclusive: 35 } } })),
    ).toEqual(['b', 'c'])
    expect(await search('', { filters: {} })).toEqual([])
  })

  it('combines a query with filters', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['a', 'b', 'd'])
    expect(ids(await search('trip', { filters: { journalIds: ['j2'] } }))).toEqual(['b'])
  })

  it('mention mode prefix-matches the last token and ranks title matches first', async () => {
    const { vault } = installFakeSession([
      { id: 'body', updatedAt: 2, entryDate: 99, title: 'Other', text: 'a parisian morning' },
      { id: 'title', updatedAt: 1, entryDate: 1, title: 'Paris', text: 'x' },
    ])
    await vault.load(['body', 'title'])
    expect(await search('paris')).toHaveLength(1)
    expect(ids(await search('paris', { mentionMode: true }))).toEqual(['title', 'body'])
  })

  it('caps results at the desktop limit of 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      updatedAt: i,
      entryDate: i,
      text: 'needle',
    }))
    const { vault } = installFakeSession(many)
    await vault.load(many.map((m) => m.id))
    const rows = await search('needle')
    expect(rows).toHaveLength(SEARCH_LIMIT)
    expect(rows[0].id).toBe('m59')
  })

  it('a new (here blank) search cancels the running scan after its in-flight batch', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, updatedAt: 100 - i }))
    const { vault } = installFakeSession(many, OVER_CAP)
    const real = vault.peek
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(vault as { peek: typeof real }).peek = async (batch) => {
      await gate
      return real(batch)
    }
    await search('anything') // the first background batch is now waiting on the gate
    expect(await search('')).toEqual([]) // a new search: cancels the scan
    release()
    await whenSearchScanSettled()
    expect(vault.peekCalls).toHaveLength(1)
    expect(vault.peekCalls[0]).toHaveLength(12)
    expect(vault.loadedIds).toHaveLength(0)
  })

  it('a lock hook cancels the scan even when the session reports unlocked again at once', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, updatedAt: 100 - i }))
    const { vault } = installFakeSession(many, OVER_CAP) // isUnlocked stays true: quick re-unlock
    const real = vault.peek
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(vault as { peek: typeof real }).peek = async (batch) => {
      await gate
      return real(batch)
    }
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    try {
      await search('anything')
      lock('manual')
      release()
      await whenSearchScanSettled()
      expect(vault.peekCalls).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('cancelSearchScan and a lock stop further fetches', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, updatedAt: 100 - i }))
    const { vault } = installFakeSession(many, OVER_CAP)
    const real = vault.peek
    ;(vault as { peek: typeof real }).peek = async (batch) => {
      const result = await real(batch)
      cancelSearchScan()
      return result
    }
    await search('x')
    await whenSearchScanSettled()
    expect(vault.peekCalls).toHaveLength(1)

    const second = installFakeSession(many, OVER_CAP)
    const realSecond = second.vault.peek
    ;(second.vault as { peek: typeof realSecond }).peek = async (batch) => {
      const result = await realSecond(batch)
      second.setUnlocked(false)
      return result
    }
    await search('x')
    await whenSearchScanSettled()
    expect(second.vault.peekCalls).toHaveLength(1)
  })

  it('rejects when locked and downloads nothing', async () => {
    const { vault, setUnlocked } = installFakeSession(SPECS)
    setUnlocked(false)
    await expect(search('trip')).rejects.toThrow('vault is locked')
    expect(vault.loadCalls).toEqual([])
    expect(vault.peekCalls).toEqual([])
  })
})
