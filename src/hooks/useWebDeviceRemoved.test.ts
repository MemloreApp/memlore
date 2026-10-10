import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { listen } from '@tauri-apps/api/event'
import { useWebDeviceRemoved } from './useWebDeviceRemoved'
import { useSettingsStore } from '../stores/settingsStore'
import { useSyncStore } from '../stores/syncStore'
import * as tauri from '../lib/tauri'
import type { WebDeviceRemovedStatus } from '../lib/tauri'

// `isWeb` is a module-level const; a getter lets each test pick the platform.
const platform = vi.hoisted(() => ({ isWeb: true }))
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>()
  return {
    ...actual,
    get isWeb() {
      return platform.isWeb
    },
  }
})

type EventHandler = (event: { payload: unknown }) => void
const eventHandlers: Record<string, EventHandler> = {}
const unlistenSpy = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  webDeviceRemovedStatus: vi.fn(),
  webForgetBrowser: vi.fn(),
  gdriveBeginConnect: vi.fn(),
  gdriveCompleteConnect: vi.fn(),
  gdriveCancelConnect: vi.fn(),
}))

vi.mock('../stores/syncStore', () => ({
  useSyncStore: { getState: vi.fn() },
}))

const REMOVED: WebDeviceRemovedStatus = {
  removed: true,
  reason: 'fingerprint-changed',
  unsentDrafts: 3,
}
const NOT_REMOVED: WebDeviceRemovedStatus = { removed: false, reason: null, unsentDrafts: 0 }

const syncNowSpy = vi.fn()
const reloadSpy = vi.fn()
const originalLocation = window.location

describe('useWebDeviceRemoved', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    platform.isWeb = true
    for (const name of Object.keys(eventHandlers)) delete eventHandlers[name]
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      eventHandlers[name] = handler as EventHandler
      return unlistenSpy
    })
    vi.mocked(tauri.webDeviceRemovedStatus).mockResolvedValue(NOT_REMOVED)
    vi.mocked(tauri.webForgetBrowser).mockResolvedValue()
    syncNowSpy.mockResolvedValue({})
    vi.mocked(useSyncStore.getState).mockReturnValue({
      syncNow: syncNowSpy,
    } as unknown as ReturnType<typeof useSyncStore.getState>)
    useSettingsStore.setState({ isLocked: true })
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('desktop: reports not removed and never invokes or listens', async () => {
    platform.isWeb = false
    const { result } = renderHook(() => useWebDeviceRemoved())
    await act(async () => {})
    expect(result.current.removed).toBe(false)
    expect(result.current.reason).toBeNull()
    expect(result.current.unsentDrafts).toBe(0)
    expect(tauri.webDeviceRemovedStatus).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  })

  it('desktop: initialProbeDone is true at once, without probing', () => {
    platform.isWeb = false
    const { result } = renderHook(() => useWebDeviceRemoved())
    expect(result.current.initialProbeDone).toBe(true)
    expect(tauri.webDeviceRemovedStatus).not.toHaveBeenCalled()
  })

  it('web: initialProbeDone stays false until the mount probe resolves', async () => {
    let resolveProbe: (s: WebDeviceRemovedStatus) => void = () => {}
    vi.mocked(tauri.webDeviceRemovedStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve
      }),
    )
    const { result } = renderHook(() => useWebDeviceRemoved())
    await act(async () => {})
    expect(result.current.initialProbeDone).toBe(false)

    await act(async () => resolveProbe(REMOVED))
    expect(result.current.initialProbeDone).toBe(true)
    expect(result.current.removed).toBe(true)
  })

  it('web: initialProbeDone turns true after a failed mount probe', async () => {
    vi.mocked(tauri.webDeviceRemovedStatus).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(result.current.initialProbeDone).toBe(true))
    expect(result.current.removed).toBe(false)
  })

  it('web: probes the status on mount', async () => {
    vi.mocked(tauri.webDeviceRemovedStatus).mockResolvedValue(REMOVED)
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(result.current.removed).toBe(true))
    expect(result.current.reason).toBe('fingerprint-changed')
    expect(result.current.unsentDrafts).toBe(3)
    expect(tauri.webDeviceRemovedStatus).toHaveBeenCalledTimes(1)
  })

  it('web: the event flips removed before the re-probe resolves, then applies it', async () => {
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(eventHandlers['web:device-removed']).toBeDefined())
    await act(async () => {})
    expect(result.current.removed).toBe(false)

    let resolveProbe: (s: WebDeviceRemovedStatus) => void = () => {}
    vi.mocked(tauri.webDeviceRemovedStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve
      }),
    )
    act(() => eventHandlers['web:device-removed']({ payload: 'slot-missing' }))
    expect(result.current.removed).toBe(true)
    expect(tauri.webDeviceRemovedStatus).toHaveBeenCalledTimes(2)

    await act(async () => resolveProbe({ ...REMOVED, reason: 'slot-missing' }))
    expect(result.current.reason).toBe('slot-missing')
    expect(result.current.unsentDrafts).toBe(3)
  })

  it('web: a failed probe fails safe to not removed', async () => {
    vi.mocked(tauri.webDeviceRemovedStatus).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(tauri.webDeviceRemovedStatus).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.removed).toBe(false)
    expect(result.current.reason).toBeNull()
  })

  it('web: unlistens on unmount', async () => {
    const { unmount } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(eventHandlers['web:device-removed']).toBeDefined())
    unmount()
    expect(unlistenSpy).toHaveBeenCalled()
  })

  it('connectDrive: begins before completing with an empty password and returns the session', async () => {
    const calls: string[] = []
    vi.mocked(tauri.gdriveBeginConnect).mockImplementation(async () => {
      calls.push('begin')
      return { sessionId: 'sess-1', authUrl: 'https://example.test' }
    })
    vi.mocked(tauri.gdriveCompleteConnect).mockImplementation(async () => {
      calls.push('complete')
      return { outcome: 'needs_onboarding' }
    })
    const { result } = renderHook(() => useWebDeviceRemoved())
    let sessionId = ''
    await act(async () => {
      sessionId = await result.current.connectDrive()
    })
    expect(calls).toEqual(['begin', 'complete'])
    expect(tauri.gdriveCompleteConnect).toHaveBeenCalledWith('sess-1', '')
    expect(sessionId).toBe('sess-1')
  })

  it('connectDrive: throws on any outcome other than needs_onboarding', async () => {
    vi.mocked(tauri.gdriveBeginConnect).mockResolvedValue({
      sessionId: 'sess-1',
      authUrl: 'https://example.test',
    })
    vi.mocked(tauri.gdriveCompleteConnect).mockResolvedValue({ outcome: 'ready' })
    const { result } = renderHook(() => useWebDeviceRemoved())
    await expect(result.current.connectDrive()).rejects.toThrow('ready')
  })

  it('cancelConnect: cancels the session of the connect in flight', async () => {
    vi.mocked(tauri.gdriveBeginConnect).mockResolvedValue({
      sessionId: 'sess-1',
      authUrl: 'https://example.test',
    })
    let rejectComplete: (e: Error) => void = () => {}
    vi.mocked(tauri.gdriveCompleteConnect).mockReturnValue(
      new Promise((_, reject) => {
        rejectComplete = reject
      }),
    )
    vi.mocked(tauri.gdriveCancelConnect).mockImplementation(async () => {
      rejectComplete(new Error('OAUTH_CANCELLED'))
      return true
    })
    const { result } = renderHook(() => useWebDeviceRemoved())
    const connecting = result.current.connectDrive().catch((e: unknown) => e)
    await waitFor(() => expect(tauri.gdriveCompleteConnect).toHaveBeenCalled())
    await act(async () => {
      await result.current.cancelConnect()
    })
    expect(tauri.gdriveCancelConnect).toHaveBeenCalledWith('sess-1')
    expect(await connecting).toEqual(new Error('OAUTH_CANCELLED'))
  })

  it('cancelConnect: does nothing when no connect is in flight', async () => {
    const { result } = renderHook(() => useWebDeviceRemoved())
    await act(async () => {
      await result.current.cancelConnect()
    })
    expect(tauri.gdriveCancelConnect).not.toHaveBeenCalled()
  })

  it('cancelConnect: swallows a failing cancel', async () => {
    vi.mocked(tauri.gdriveBeginConnect).mockResolvedValue({
      sessionId: 'sess-1',
      authUrl: 'https://example.test',
    })
    vi.mocked(tauri.gdriveCompleteConnect).mockReturnValue(new Promise(() => {}))
    vi.mocked(tauri.gdriveCancelConnect).mockRejectedValue(new Error('gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useWebDeviceRemoved())
    void result.current.connectDrive()
    await waitFor(() => expect(tauri.gdriveCompleteConnect).toHaveBeenCalled())
    await expect(result.current.cancelConnect()).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('completeReonboard: re-probes before unlocking', async () => {
    vi.mocked(tauri.webDeviceRemovedStatus).mockResolvedValueOnce(REMOVED)
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(result.current.removed).toBe(true))

    let lockedDuringProbe: boolean | undefined
    vi.mocked(tauri.webDeviceRemovedStatus).mockImplementationOnce(async () => {
      lockedDuringProbe = useSettingsStore.getState().isLocked
      return NOT_REMOVED
    })
    await act(async () => {
      await result.current.completeReonboard()
    })
    expect(lockedDuringProbe).toBe(true)
    expect(useSettingsStore.getState().isLocked).toBe(false)
  })

  it('completeReonboard: stays locked and fires no sync while still removed', async () => {
    vi.mocked(tauri.webDeviceRemovedStatus).mockResolvedValue(REMOVED)
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(result.current.removed).toBe(true))
    await act(async () => {
      await result.current.completeReonboard()
    })
    expect(useSettingsStore.getState().isLocked).toBe(true)
    expect(result.current.removed).toBe(true)
    expect(syncNowSpy).not.toHaveBeenCalled()
  })

  it('completeReonboard: unlocks, re-probes and fires a sync', async () => {
    vi.mocked(tauri.webDeviceRemovedStatus).mockResolvedValueOnce(REMOVED)
    const { result } = renderHook(() => useWebDeviceRemoved())
    await waitFor(() => expect(result.current.removed).toBe(true))

    vi.mocked(tauri.webDeviceRemovedStatus).mockResolvedValueOnce(NOT_REMOVED)
    await act(async () => {
      await result.current.completeReonboard()
    })
    expect(useSettingsStore.getState().isLocked).toBe(false)
    expect(tauri.webDeviceRemovedStatus).toHaveBeenCalledTimes(2)
    expect(result.current.removed).toBe(false)
    expect(syncNowSpy).toHaveBeenCalledTimes(1)
  })

  it('forget: calls the command, then reloads', async () => {
    const calls: string[] = []
    vi.mocked(tauri.webForgetBrowser).mockImplementation(async () => {
      calls.push('forget')
    })
    reloadSpy.mockImplementation(() => calls.push('reload'))
    const { result } = renderHook(() => useWebDeviceRemoved())
    await act(async () => {
      await result.current.forget()
    })
    expect(calls).toEqual(['forget', 'reload'])
  })
})
