import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as exitGhost from '../lib/exitGhost'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      isLocked: false,
      encryptionMode: null,
      isBiometricEnabled: false,
    })
  })

  // Locking unmounts every open overlay; their exit copies would replay the
  // closed content over the lock screen.
  it('locking suppresses overlay exit animations, unlocking does not', () => {
    const spy = vi.spyOn(exitGhost, 'suppressExitGhosts')
    useSettingsStore.getState().setLocked(false)
    expect(spy).not.toHaveBeenCalled()
    useSettingsStore.getState().setLocked(true)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
