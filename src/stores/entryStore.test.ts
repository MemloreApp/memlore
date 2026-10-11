import { describe, it, expect, beforeEach } from 'vitest'
import { useEntryStore } from './entryStore'
import type { Entry } from '../types/entry'

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: 'Test Entry',
  preview_text: 'Preview',
  content_text: 'Full content',
  entry_date: 1744640400,
  created_at: 1744640400,
  updated_at: 1744640400,
  latitude: null,
  longitude: null,
  location_label: null,
  location_address: null,
  weather_summary: null,
  weather_icon: null,
  emotion: null,
  is_favorite: false,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  cover_media_id: null,
  media_count: 0,
  from_chat: false,
  content_language: null,
  entry_date_user_edited: false,
  ...overrides,
})

beforeEach(() => {
  useEntryStore.setState({
    entries: [],
    entriesById: {},
    isLoading: false,
    error: null,
  })
})

describe('setEntries', () => {
  it('overwrites stale entries in entriesById with the newer copy', () => {
    const stale = makeEntry({ id: 'a', title: 'Old' })
    const fresh = makeEntry({ id: 'a', title: 'New' })
    useEntryStore.getState().setEntries([stale])
    useEntryStore.getState().setEntries([fresh])
    expect(useEntryStore.getState().entriesById['a'].title).toBe('New')
  })
})

describe('regression: cross-journal tab switch preserves entry title', () => {
  // Originally reported as: "When I select an entry, the tab title shows
  // the entry title. After switching to another tab, the previous tab's
  // title falls back to 'Entries'."
  // Root cause: tab-title resolution used to read from `entries`, which is
  // wholesale-replaced when `useEntries` refetches for a different journal.
  it("does not drop a tab's entry from entriesById when a different scope is fetched", () => {
    const tabAEntry = makeEntry({ id: 'tabA', journal_id: 'j1', title: 'Hike notes' })
    const tabBEntries = [
      makeEntry({ id: 'tabB-1', journal_id: 'j2' }),
      makeEntry({ id: 'tabB-2', journal_id: 'j2' }),
    ]
    // Tab A's scope loads — selectedEntryId='tabA' is then resolved via
    // entriesById and the tab shows "Hike notes".
    useEntryStore.getState().setEntries([tabAEntry])
    // User switches to Tab B (different journal). useEntries refetches and
    // calls setEntries with j2 entries.
    useEntryStore.getState().setEntries(tabBEntries)
    // The visible list is j2; entriesById must still contain tabA so the
    // inactive Tab A keeps rendering "Hike notes" instead of "Entries".
    expect(useEntryStore.getState().entries.map((e) => e.id)).toEqual(['tabB-1', 'tabB-2'])
    expect(useEntryStore.getState().entriesById['tabA']?.title).toBe('Hike notes')
  })
})

describe('mergeEntries', () => {
  it('merges entries into entriesById without touching the entries array', () => {
    const main = makeEntry({ id: 'main', title: 'Main' })
    const extra = makeEntry({ id: 'extra', title: 'Extra' })
    useEntryStore.getState().setEntries([main])
    useEntryStore.getState().mergeEntries([extra])
    expect(useEntryStore.getState().entries.map((e) => e.id)).toEqual(['main'])
    expect(useEntryStore.getState().entriesById['main']).toEqual(main)
    expect(useEntryStore.getState().entriesById['extra']).toEqual(extra)
  })
})

describe('updateEntry', () => {
  it('updates entriesById even when entry is not in the visible entries array', () => {
    // Simulates an entry that lives in entriesById (cached from a previous
    // journal scope) but is not in the current entries list.
    const entry = makeEntry({ id: 'cached', title: 'Original' })
    useEntryStore.setState({ entries: [], entriesById: { cached: entry } })
    useEntryStore.getState().updateEntry({ ...entry, title: 'Renamed' })
    expect(useEntryStore.getState().entriesById['cached'].title).toBe('Renamed')
  })
})
