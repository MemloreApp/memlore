import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  __resetSearchOverlayKeepResultsForTests,
  searchOverlayRetentionKey,
  shouldRetainSearchOverlayContent,
  useSearchOverlayKeepResults,
} from './useSearchOverlayKeepResults'

beforeEach(() => {
  __resetSearchOverlayKeepResultsForTests()
})

describe('useSearchOverlayKeepResults', () => {
  it('restores last-set ON after remount', () => {
    const first = renderHook(() => useSearchOverlayKeepResults())
    expect(first.result.current.keepResults).toBe(false)

    act(() => {
      first.result.current.setKeepResults(true)
    })
    expect(first.result.current.keepResults).toBe(true)

    first.unmount()

    // Simulates SearchOverlay remounting content after close/reopen.
    const second = renderHook(() => useSearchOverlayKeepResults())
    expect(second.result.current.keepResults).toBe(true)
  })
})

describe('shouldRetainSearchOverlayContent', () => {
  it('is false only when both flags are off', () => {
    expect(shouldRetainSearchOverlayContent(false, false)).toBe(false)
  })
})

describe('searchOverlayRetentionKey', () => {
  it('produces different keys for different vault ids', () => {
    expect(searchOverlayRetentionKey('vault-a', 'hidden')).not.toBe(
      searchOverlayRetentionKey('vault-b', 'hidden'),
    )
  })

  it('produces different keys for the same vault and different lockedView', () => {
    expect(searchOverlayRetentionKey('vault-a', 'hidden')).not.toBe(
      searchOverlayRetentionKey('vault-a', 'revealed'),
    )
  })
})
