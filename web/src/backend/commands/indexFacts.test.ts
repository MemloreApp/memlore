import { afterEach, describe, expect, it } from 'vitest'
import type { MonthIndexReader } from '../sync/monthIndex'
import { entryFacts, type EntryFact } from './indexFacts'
import { configureReadEnv } from './readSession'
import {
  EMPTY_TAXONOMY,
  FakeVault,
  fakeMonthIndex,
  type FakeRow,
  type FakeSpec,
} from './readTestKit'

const JUNE = Date.UTC(2026, 5, 14) / 1000

/** A June index of these rows (none: no index source), the vault holding `specs`. */
function rig(
  rows: Array<Omit<FakeRow, 'entryDate'>> | null,
  specs: FakeSpec[],
  excludedJournal = 'jx',
): FakeVault {
  const vault = new FakeVault(specs)
  const monthIndex: MonthIndexReader | undefined =
    rows === null
      ? undefined
      : fakeMonthIndex(
          rows.map((r) => ({ ...r, entryDate: JUNE })),
          [excludedJournal],
        )
  configureReadEnv({
    isUnlocked: () => true,
    session: async () => ({
      vault,
      ...(monthIndex === undefined ? {} : { monthIndex }),
      ready: async () => EMPTY_TAXONOMY,
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
  })
  return vault
}

const byId = (facts: readonly EntryFact[]): Record<string, EntryFact> =>
  Object.fromEntries(facts.map((f) => [f.entry_id, f]))

afterEach(() => {
  configureReadEnv({})
})

describe('entryFacts', () => {
  it('overlays the vault on the index rows: refused rows dropped, loaded copies win, web creates added', async () => {
    const vault = rig(
      [
        { id: 'plain', emotion: 'good', words: 4 },
        { id: 'locked', emotion: 'bad', words: 9 },
        { id: 'invisible', emotion: 'bad', words: 9 },
        { id: 'excluded', journal: 'jx', emotion: 'bad', words: 9 },
        { id: 'trashed', emotion: 'bad', words: 9 },
        // Edited after the index was written: the reader hides the row, the loaded copy counts.
        { id: 'stale', emotion: 'bad', words: 9, winnerUpdatedAt: 200 },
      ],
      [
        { id: 'locked', updatedAt: 100, locked: true },
        { id: 'invisible', updatedAt: 100, invisible: true },
        {
          id: 'stale',
          updatedAt: 200,
          entryDate: JUNE + 3600,
          emotion: 'neutral',
          text: 'three  short\nwords',
        },
        // Stands for a web-created entry: visible in the vault, no index row.
        { id: 'web', updatedAt: 300, entryDate: JUNE, emotion: 'good', text: 'hi', favorite: true },
      ],
    )
    await vault.load(['locked', 'invisible', 'stale', 'web'])
    vault.setTrashedIds(['trashed'])

    const facts = byId((await entryFacts(null)).facts)

    expect(Object.keys(facts).sort()).toEqual(['plain', 'stale', 'web'])
    expect(facts.plain).toMatchObject({ emotion: 'good', word_count: 4, entry_date: JUNE })
    expect(facts.stale).toMatchObject({
      emotion: 'neutral',
      word_count: 3,
      entry_date: JUNE + 3600,
      updated_at: 200,
    })
    expect(facts.web).toMatchObject({ emotion: 'good', is_favorite: true, word_count: 1 })
  })

  it.each([
    ['NaN', Number.NaN],
    ['past year 9999', 2.6e11],
  ])('never throws on a loaded entry dated %s under a month pick', async (_name, entryDate) => {
    const vault = rig([{ id: 'plain' }], [{ id: 'bad', updatedAt: 100, entryDate }])
    await vault.load(['bad'])

    const { facts } = await entryFacts((month) => month === '2026-06')

    expect(facts.map((f) => f.entry_id)).toEqual(['plain'])
  })

  it('is the loaded set when there is no index source', async () => {
    const vault = rig(null, [
      { id: 'a', updatedAt: 100, emotion: 'bad' },
      { id: 'b', updatedAt: 100 },
      { id: 'locked', updatedAt: 100, locked: true },
    ])
    await vault.load(['a', 'b', 'locked'])
    vault.setTrashedIds(['b'])

    const { facts } = await entryFacts(null)

    expect(facts.map((f) => f.entry_id)).toEqual(['a'])
  })
})
