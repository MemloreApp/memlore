import { beforeEach, describe, expect, it } from 'vitest'
import { useCapabilitiesStore } from './capabilitiesStore'

describe('capabilitiesStore', () => {
  beforeEach(() => {
    useCapabilitiesStore.setState({ writes: true, outboxV2: false, monthIndex: false })
  })

  it('runtime web capabilities default to false (fail closed)', () => {
    const s = useCapabilitiesStore.getInitialState()
    expect(s.outboxV2).toBe(false)
    expect(s.monthIndex).toBe(false)
  })

  it('setWebCapabilities coerces a malformed payload to false', () => {
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: 'yes', monthIndex: 1 })
    expect(useCapabilitiesStore.getState()).toMatchObject({ outboxV2: false, monthIndex: false })
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    useCapabilitiesStore.getState().setWebCapabilities(null)
    expect(useCapabilitiesStore.getState()).toMatchObject({ outboxV2: false, monthIndex: false })
  })

  it('setWebCapabilities never touches writes', () => {
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    expect(useCapabilitiesStore.getState().writes).toBe(true)
  })
})
