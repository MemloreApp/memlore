import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useJournals } from './useJournals'
import { useJournalStore } from '../stores/journalStore'
import type { Journal } from '../types/journal'

vi.mock('../lib/tauri', () => ({
  listJournals: vi.fn(),
  createJournal: vi.fn(),
  updateJournal: vi.fn(),
  deleteJournal: vi.fn(),
  countEntriesInJournal: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeJournal = (overrides: Partial<Journal> = {}): Journal => ({
  id: 'journal-1',
  name: 'My Journal',
  color: null,
  created_at: 1744640400000,
  updated_at: 1744640400000,
  sort_order: 0,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  useJournalStore.setState({
    journals: [],
    activeJournalId: null,
  })
})

describe('useJournals', () => {
  it('refetches on entries-changed (a dropped web create or trash refusal)', async () => {
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal()])
    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    vi.mocked(tauri.listJournals).mockResolvedValue([])
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })

    await waitFor(() => expect(result.current.journals).toHaveLength(0))
    expect(tauri.listJournals).toHaveBeenCalledTimes(2)
  })

  it('createJournal calls tauri and refreshes list', async () => {
    const created = makeJournal({ id: 'new-j', name: 'New One' })
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal()])
    vi.mocked(tauri.createJournal).mockResolvedValue(created)

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // After createJournal, listJournals is called again to refresh
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal(), created])

    await act(async () => {
      await result.current.createJournal('New One', '#FF0000')
    })

    expect(tauri.createJournal).toHaveBeenCalledWith('New One', '#FF0000', [])
    expect(result.current.journals).toHaveLength(2)
  })

  it('deleteJournal fans out entries-changed so the entry list refetches', async () => {
    // The backend soft-deletes every entry in the journal. Without this event
    // the ['entries'] query cache (staleTime 30s, no refetch-on-focus) keeps
    // showing the deleted journal's entries.
    const j1 = makeJournal({ id: 'j1' })
    const j2 = makeJournal({ id: 'j2', name: 'Second' })
    vi.mocked(tauri.listJournals).mockResolvedValue([j1, j2])
    vi.mocked(tauri.deleteJournal).mockResolvedValue(undefined)

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const onEntriesChanged = vi.fn()
    window.addEventListener('memlore:entries-changed', onEntriesChanged)
    vi.mocked(tauri.listJournals).mockResolvedValue([j1])

    await act(async () => {
      await result.current.deleteJournal('j2')
    })
    window.removeEventListener('memlore:entries-changed', onEntriesChanged)

    expect(onEntriesChanged).toHaveBeenCalledTimes(1)
  })

  it('deleteJournal switches active to first journal if deleted was active', async () => {
    const j1 = makeJournal({ id: 'j1' })
    const j2 = makeJournal({ id: 'j2' })
    vi.mocked(tauri.listJournals).mockResolvedValue([j1, j2])
    vi.mocked(tauri.deleteJournal).mockResolvedValue(undefined)
    useJournalStore.setState({ activeJournalId: 'j2' })

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    vi.mocked(tauri.listJournals).mockResolvedValue([j1])

    await act(async () => {
      await result.current.deleteJournal('j2')
    })

    expect(useJournalStore.getState().activeJournalId).toBe('j1')
  })
})
