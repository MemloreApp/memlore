import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetEmbeddingStatusStoreForTests,
  useEmbeddingStatusStore,
} from './embeddingStatusStore'

beforeEach(() => {
  __resetEmbeddingStatusStoreForTests()
})

describe('embeddingStatusStore', () => {
  // Regression: resuming with an already-drained queue emits NO progress and
  // NO completion event (`run_backfill_loop` only emits when work happens),
  // so the `paused` flag survived forever and the settings row + footer kept
  // reading "Paused" while the worker was live. `get_backfill_status` is the
  // only signal in that case.
  it('a running worker clears a stale paused flag', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(10, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    useEmbeddingStatusStore.getState().setWorkerRunning(true)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(false)
    expect(s.status).toBe('idle')
  })

  // The load-bearing half of the invariant: the slot is ALSO vacant right
  // after a pause (`BackfillRunGuard::drop` clears it before emitting
  // `ai:backfill-complete`), so a `running: false` reading must never be
  // mistaken for "resume" — a genuine pause has to survive it.
  it('a NOT-running worker leaves a genuine pause intact', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    useEmbeddingStatusStore.getState().setWorkerRunning(false)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(true)
    expect(s.status).toBe('paused')
  })

  // A running worker only clears `paused`; it must not promote the status
  // past a higher-priority state (error, needs_consent, …).
  it('a running worker does not override a higher-priority status', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')

    useEmbeddingStatusStore.getState().setWorkerRunning(true)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(false)
    expect(s.status).toBe('needs_consent')
  })

  // ── needs_consent derivation ─────────────────────────────────────────────

  it('hosted provider enabled without consent surfaces needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')
  })

  it('hosted provider becomes allowed after consent, clearing needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')

    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('needs_consent overrides a stale paused flag (model swap clears consent while paused persists)', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    // Simulates an embedding-model swap: the backend clears hosted consent
    // (`allowed` flips false) while the stale local `paused` flag is still
    // true — `needs_consent` must win over `paused` (cf-review C2).
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })

    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(true)
    expect(s.status).toBe('needs_consent')
  })
})
