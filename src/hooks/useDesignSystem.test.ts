import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useDesignSystem } from './useDesignSystem'
import { useUiStore } from '../stores/uiStore'

beforeEach(() => {
  useUiStore.setState({
    designSystem: 'signature',
    surfaceStyle: 'deep',
  })
  document.documentElement.className = ''
})

describe('useDesignSystem', () => {
  it('lightAllowed is true for Signature while LIGHT_MODE_ENABLED is true', () => {
    useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'deep' })
    const { result } = renderHook(() => useDesignSystem())
    expect(result.current.lightAllowed).toBe(true)
  })

  it('mounting signature + lumen stamps ds-signature AND surface-lumen; lightAllowed is false', async () => {
    useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'lumen' })
    const { result } = renderHook(() => useDesignSystem())

    await waitFor(() => {
      expect(document.documentElement.classList.contains('ds-signature')).toBe(true)
      expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)
    })
    expect(document.documentElement.classList.contains('ds-lumen')).toBe(false)
    expect(document.documentElement.classList.contains('ds-clean')).toBe(false)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
    expect(result.current.lightAllowed).toBe(false)
    expect(result.current.designSystem).toBe('signature')
  })
})
