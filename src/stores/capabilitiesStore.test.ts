import { beforeEach, describe, expect, it } from 'vitest'
import { useCapabilitiesStore } from './capabilitiesStore'

describe('capabilitiesStore', () => {
  beforeEach(() => {
    useCapabilitiesStore.setState({
      writes: true,
      outboxV2: false,
      monthIndex: false,
      outboxKinds: [],
    })
  })

  it('runtime web capabilities default to false (fail closed)', () => {
    const s = useCapabilitiesStore.getInitialState()
    expect(s.outboxV2).toBe(false)
    expect(s.monthIndex).toBe(false)
  })

  it('setWebCapabilities coerces a malformed payload to false / no kinds', () => {
    const none = { outboxV2: false, monthIndex: false, outboxKinds: [] }
    const full = { outboxV2: true, monthIndex: true, outboxKinds: ['trash_entry'] }
    const set = useCapabilitiesStore.getState().setWebCapabilities
    set(full)
    set({ outboxV2: 'yes', monthIndex: 1, outboxKinds: 'trash_entry' })
    expect(useCapabilitiesStore.getState()).toMatchObject(none)
    set(full)
    set(null)
    expect(useCapabilitiesStore.getState()).toMatchObject(none)
    set({ ...full, outboxKinds: ['trash_entry', 1, null, { kind: 'x' }] })
    expect(useCapabilitiesStore.getState().outboxKinds).toEqual(['trash_entry'])
  })

  it('setWebCapabilities never touches writes', () => {
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    expect(useCapabilitiesStore.getState().writes).toBe(true)
  })
})
