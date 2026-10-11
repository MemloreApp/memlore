import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSemanticSearch } from './useSemanticSearch'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { SearchFilters, SemanticHit } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  semanticSearch: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeHit = (overrides: Partial<SemanticHit> = {}): SemanticHit => ({
  entry_id: 'h1',
  title: 'Result',
  snippet: 'preview',
  score: 0.87,
  entry_date: 1_700_000_000,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  useInvisibleLockStore.setState({ activeVaultId: 'vault-a', autoLockMinutes: 5 })
  // Second lock disabled → lockedView() === 'revealed' (search allowed).
  // showExistence pinned so the second-lock test's expected 'hidden' is stable.
  useSecondLockStore.setState({ isEnabled: false, isSessionUnlocked: false, showExistence: false })
})

describe('useSemanticSearch', () => {
  it('searches with reveal_invisible=false when invisible session is locked', async () => {
    // The backend excludes invisible entries server-side via the flag, so a
    // locked invisible session must NOT block semantic search — it just scopes
    // results to visible entries (mirrors keyword search).
    useInvisibleLockStore.setState({ activeVaultId: null, autoLockMinutes: 5 })
    const visibleHit = makeHit({ entry_id: 'v1', title: 'Visible' })
    vi.mocked(tauri.semanticSearch).mockResolvedValue([visibleHit])

    const { result } = renderHook(() => useSemanticSearch('hidden memory'))

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'hidden memory',
        20,
        undefined,
        'revealed',
        null,
      ),
    )
    await waitFor(() => expect(result.current.results).toEqual([visibleHit]))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('forwards lockedView=hidden so the backend excludes second-lock entries', async () => {
    // `semantic_search` now takes locked_view, so second lock no longer blocks
    // search — the backend excludes locked entries (Covered treated as Hidden)
    // and returns visible-only hits, mirroring keyword search.
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: false })
    const visibleHit = makeHit({ entry_id: 'v1', title: 'Visible' })
    vi.mocked(tauri.semanticSearch).mockResolvedValue([visibleHit])

    const { result } = renderHook(() => useSemanticSearch('locked memory'))

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'locked memory',
        20,
        undefined,
        'hidden',
        'vault-a',
      ),
    )
    await waitFor(() => expect(result.current.results).toEqual([visibleHit]))
    expect(result.current.error).toBeNull()
  })

  it('forwards lockedView=revealed when second lock is enabled but unlocked', async () => {
    // Third lockedView state: enabled + unlocked → 'revealed' → backend sees
    // everything. Completes coverage of the guard-removal across all three states.
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })
    vi.mocked(tauri.semanticSearch).mockResolvedValue([])

    renderHook(() => useSemanticSearch('unlocked memory'))

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'unlocked memory',
        20,
        undefined,
        'revealed',
        'vault-a',
      ),
    )
  })

  it('accepts filters and forwards them to the backend', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([])
    const filters: SearchFilters = { emotions: ['good'] }
    renderHook(() => useSemanticSearch('q', filters))
    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith('q', 20, filters, 'revealed', 'vault-a'),
    )
  })

  it('sets error on backend failure', async () => {
    vi.mocked(tauri.semanticSearch).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSemanticSearch('x'))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.isLoading).toBe(false)
  })

  it('clears results when query is cleared', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([makeHit()])

    const { result, rerender } = renderHook(({ q }: { q: string }) => useSemanticSearch(q), {
      initialProps: { q: 'hello' },
    })
    await waitFor(() => expect(result.current.results).toHaveLength(1))

    rerender({ q: '' })
    expect(result.current.results).toEqual([])
  })
})
