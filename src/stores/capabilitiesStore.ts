import { create } from 'zustand'

// Runtime capabilities that the web backend sets. `writes` defaults to the
// desktop value (writes allowed) and is flipped before first render; the
// desktop-derived flags default to false (fail closed) until the first pull's
// `memlore:web-capabilities` event. Desktop ignores this store.
// Must NOT import `lib/platform` at module load.
interface CapabilitiesState {
  writes: boolean
  /** A slotted desktop imports outbox v2 intents (journal/tag create, entry delete). */
  outboxV2: boolean
  /** A desktop publishes the encrypted month index. */
  monthIndex: boolean
  /** Outbox v3 kinds the synced desktops apply (empty: none). */
  outboxKinds: string[]
  setWrites: (writes: boolean) => void
  /**
   * Applies a `memlore:web-capabilities` payload; a flag that is not `true` is false, and
   * `outboxKinds` keeps only strings (anything but an array is none).
   */
  setWebCapabilities: (payload: unknown) => void
}

const field = (payload: unknown, key: string): unknown =>
  typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined

const flag = (payload: unknown, key: string): boolean => field(payload, key) === true

const kinds = (payload: unknown): string[] => {
  const value = field(payload, 'outboxKinds')
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : []
}

export const useCapabilitiesStore = create<CapabilitiesState>((set) => ({
  writes: true,
  outboxV2: false,
  monthIndex: false,
  outboxKinds: [],
  setWrites: (writes) => set({ writes }),
  setWebCapabilities: (payload) =>
    set({
      outboxV2: flag(payload, 'outboxV2'),
      monthIndex: flag(payload, 'monthIndex'),
      outboxKinds: kinds(payload),
    }),
}))
