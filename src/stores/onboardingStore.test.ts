import { describe, expect, it, beforeEach } from 'vitest'
import { useOnboardingStore } from './onboardingStore'

describe('useOnboardingStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.setState({
      pending: false,
      celebrationPending: false,
      celebrationVariant: 'setup',
    })
  })

  describe('onRehydrateStorage coercion', () => {
    const getOptions = () => useOnboardingStore.persist.getOptions()

    it('coerces a non-boolean stored pending value (string) to false', () => {
      const state = {
        pending: 'yes' as unknown as boolean,
        celebrationPending: false,
      }
      expect(() =>
        getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined),
      ).not.toThrow()
      expect(state.pending).toBe(false)
    })

    it('coerces a non-boolean stored pending value (null) to false', () => {
      const state = {
        pending: null as unknown as boolean,
        celebrationPending: false,
      }
      expect(() =>
        getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined),
      ).not.toThrow()
      expect(state.pending).toBe(false)
    })

    it('keeps a valid stored pending: true value as true', () => {
      const state = { pending: true, celebrationPending: false }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.pending).toBe(true)
    })

    it('coerces a non-boolean celebrationPending value to false', () => {
      const state = {
        pending: false,
        celebrationPending: 'yes' as unknown as boolean,
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationPending).toBe(false)
    })

    it('keeps a valid celebrationPending: true value as true', () => {
      const state = { pending: false, celebrationPending: true }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationPending).toBe(true)
    })

    it('coerces an unknown celebrationVariant to setup', () => {
      const state = {
        pending: false,
        celebrationPending: true,
        celebrationVariant: 'confetti' as unknown as 'setup',
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationVariant).toBe('setup')
    })

    it('keeps a valid stored joined-sync variant', () => {
      const state = {
        pending: false,
        celebrationPending: true,
        celebrationVariant: 'joined-sync' as const,
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationVariant).toBe('joined-sync')
    })

    it('keeps a valid stored setup-sync variant', () => {
      const state = {
        pending: false,
        celebrationPending: true,
        celebrationVariant: 'setup-sync' as const,
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationVariant).toBe('setup-sync')
    })

    it('does not throw when state is undefined', () => {
      expect(() =>
        getOptions().onRehydrateStorage?.(undefined as never)?.(undefined as never, undefined),
      ).not.toThrow()
    })
  })
})
