import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MoodHistogramRow, WritingVolumePoint } from '../../../../src/lib/tauri'
import type { KeyRing } from '../keys'
import type { IndexEntry } from '../sync/entryIndex'
import { createMonthIndexReader } from '../sync/monthIndex'
import { indexStatsHandlers } from './indexStats'
import { configureReadEnv } from './readSession'
import { EMPTY_TAXONOMY, FakeVault, type FakeSpec } from './readTestKit'

const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'
const encoder = new TextEncoder()
const enc = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))
/** Unix seconds of a LOCAL wall-clock time (the desktop buckets with `'localtime'`). */
const local = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m - 1, d, h).getTime() / 1000
const NOW = local(2026, 6, 15)
const DAY = 86_400

interface RowSpec {
  id: string
  date: number
  emotion?: string | null
  words?: number
  updatedAt?: number
}

const toRow = (r: RowSpec) => ({
  entry_id: r.id,
  updated_at: r.updatedAt ?? 100,
  entry_date: r.date,
  journal_id: 'j1',
  emotion: r.emotion === undefined ? null : r.emotion,
  is_favorite: false,
  tag_ids: [],
  word_count: r.words ?? 0,
  title: null,
  preview_text: null,
  latitude: null,
  longitude: null,
  location_label: null,
  media: [],
  versions: [],
})

function rig(
  rows: RowSpec[],
  options: { specs?: FakeSpec[] } = {},
): { vault: FakeVault; index: Map<string, IndexEntry> } {
  const remote = new Map<string, Uint8Array>()
  const index = new Map<string, IndexEntry>()
  const byMonth = new Map<string, RowSpec[]>()
  for (const r of rows) {
    const month = new Date(r.date * 1000).toISOString().slice(0, 7)
    byMonth.set(month, [...(byMonth.get(month) ?? []), r])
    index.set(r.id, {
      entryId: r.id,
      authorDevice: SRC,
      updatedAt: r.updatedAt ?? 100,
      isDeleted: false,
    })
  }
  remote.set(
    `${SRC}/index/months.bin`,
    enc({
      schema_version: 1,
      device_id: SRC,
      generated_at: 1,
      months: [...byMonth.keys()].map((month) => ({ month, hash_hex: `h-${month}` })),
    }),
  )
  for (const [month, list] of byMonth) {
    remote.set(
      `${SRC}/index/${month}.bin`,
      enc({ schema_version: 1, device_id: SRC, month, generated_at: 1, rows: list.map(toRow) }),
    )
  }
  const monthIndex = createMonthIndexReader({
    puller: {
      indexSource: SRC,
      pulls: 1,
      get index() {
        return index
      },
      readDeviceBin: async (path) => remote.get(path) ?? null,
    },
    db: {
      files: {
        get: async () => undefined,
        put: async () => undefined,
        delete: async () => undefined,
        paths: async () => [],
      },
    },
    core: { openDeviceBin: (_ring, bytes) => bytes },
    isJournalExcluded: () => false,
    isUnlocked: () => true,
    getKeyRing: () => ({}) as KeyRing,
  })
  const vault = new FakeVault(options.specs ?? [])
  configureReadEnv({
    isUnlocked: () => true,
    session: async () => ({
      vault,
      monthIndex,
      ready: async () => EMPTY_TAXONOMY,
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
  })
  return { vault, index }
}

const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(indexStatsHandlers[name](args)) as Promise<T>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
  vi.useRealTimers()
  configureReadEnv({})
})

describe('stats_entries_over_time', () => {
  it('rejects a range that is not a non-negative integer', async () => {
    rig([])
    await expect(call('stats_entries_over_time', { period: 'day', range: -1 })).rejects.toThrow(
      /range/,
    )
  })
})

describe('the vault rule', () => {
  it('never counts a refused entry and takes a loaded entry from its copy', async () => {
    const { vault } = rig(
      [
        { id: 'plain', date: local(2026, 6, 14), emotion: 'good', words: 4 },
        { id: 'locked', date: local(2026, 6, 14), emotion: 'bad', words: 9 },
        { id: 'loaded', date: local(2026, 6, 14), emotion: 'good', words: 50 },
      ],
      {
        specs: [
          { id: 'locked', updatedAt: 100, locked: true },
          {
            id: 'loaded',
            updatedAt: 100,
            entryDate: local(2026, 6, 13),
            emotion: 'neutral',
            text: 'three  short\nwords',
          },
        ],
      },
    )
    await vault.load(['locked', 'loaded'])
    const volume = await call<WritingVolumePoint[]>('stats_writing_volume', {
      period: 'day',
      range: 7,
    })
    expect(volume).toEqual([
      { period_start: '2026-06-13', total_words: 3, entry_count: 1 },
      { period_start: '2026-06-14', total_words: 4, entry_count: 1 },
    ])
    const moods = await call<MoodHistogramRow[]>('stats_mood_histogram', { rangeDays: 7 })
    expect(moods).toEqual([
      { emotion: 'good', count: 1 },
      { emotion: 'neutral', count: 1 },
    ])
  })
})

describe('emotion stats (bad / neutral / good only)', () => {
  const ROWS: RowSpec[] = [
    { id: 'a', date: local(2026, 6, 14), emotion: 'good' },
    { id: 'b', date: local(2026, 6, 14), emotion: 'bad' },
    { id: 'c', date: local(2026, 6, 14), emotion: 'good' },
    { id: 'd', date: local(2026, 6, 13), emotion: 'neutral' },
    { id: 'none', date: local(2026, 6, 13), emotion: null },
    { id: 'legacy', date: local(2026, 6, 13), emotion: 'ecstatic' },
    { id: 'old', date: NOW - 40 * DAY, emotion: 'bad' },
  ]

  it('histogram counts by emotion, most frequent first', async () => {
    rig(ROWS)
    expect(await call<MoodHistogramRow[]>('stats_mood_histogram', { rangeDays: 30 })).toEqual([
      { emotion: 'good', count: 2 },
      { emotion: 'bad', count: 1 },
      { emotion: 'neutral', count: 1 },
    ])
  })
})

describe('stats_streak_calendar', () => {
  it('rejects a year out of range', async () => {
    rig([])
    await expect(call('stats_streak_calendar', { year: 999 })).rejects.toThrow(/year out of range/)
  })
})
