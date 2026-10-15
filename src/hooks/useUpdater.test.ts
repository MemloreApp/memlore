import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('./useTabSessionRestore', () => ({
  flushTabSession: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { useUiStore } from '../stores/uiStore'
import { flushTabSession } from './useTabSessionRestore'
import {
  useUpdater,
  checkForUpdates,
  installUpdate,
  restartApp,
  runStartupUpdateCheck,
  dismissUpdate,
  __resetUpdaterForTests,
} from './useUpdater'

const mockedInvoke = vi.mocked(invoke)
const mockedFlush = vi.mocked(flushTabSession)

const AVAILABLE = { version: '0.2.0', notes: 'Fixed things', pub_date: '2026-09-15T00:00:00+00:00' }

/** A promise plus its resolver, for the "still in flight" scenarios. */
function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetUpdaterForTests()
  vi.resetAllMocks()
  // The automock resolves to `undefined`; the real command returns `null`
  // when there is nothing to install.
  mockedInvoke.mockResolvedValue(null)
  globalThis.localStorage.clear()
  useUiStore.setState({ autoCheckUpdates: true })
})

describe('useUpdater', () => {
  it('keeps state across a consumer remount — the modal mounts late', async () => {
    mockedInvoke.mockResolvedValue(AVAILABLE)
    const first = renderHook(() => useUpdater())
    await act(async () => {
      await first.result.current.check()
    })
    expect(first.result.current.status).toBe('available')

    first.unmount()
    const second = renderHook(() => useUpdater())

    expect(second.result.current.status).toBe('available')
    expect(second.result.current.update).toEqual(AVAILABLE)
  })

  describe('explicit check', () => {
    it('reports an available update', async () => {
      mockedInvoke.mockResolvedValue(AVAILABLE)
      const { result } = renderHook(() => useUpdater())

      await act(async () => {
        await result.current.check()
      })

      expect(mockedInvoke).toHaveBeenCalledWith('check_for_update')
      expect(result.current.status).toBe('available')
      expect(result.current.update).toEqual(AVAILABLE)
    })

    it('surfaces a rejecting invoke as an error with its message', async () => {
      mockedInvoke.mockRejectedValue('network unreachable')
      const { result } = renderHook(() => useUpdater())

      await act(async () => {
        await result.current.check()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('network unreachable')
    })

  })

  describe('one check at a time', () => {
    it('makes an explicit check wait for an in-flight silent one', async () => {
      const check = deferred<unknown>()
      mockedInvoke.mockReturnValue(check.promise)
      const { result } = renderHook(() => useUpdater())

      const silent = checkForUpdates({ silent: true })
      const explicit = checkForUpdates()
      await waitFor(() => expect(result.current.status).toBe('checking'))

      await act(async () => {
        check.resolve(null)
        await Promise.all([silent, explicit])
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(result.current.status).toBe('up-to-date')
    })

    it('skips a silent check while an explicit one is in flight', async () => {
      const check = deferred<unknown>()
      mockedInvoke.mockReturnValue(check.promise)
      const { result } = renderHook(() => useUpdater())

      const explicit = checkForUpdates()
      await waitFor(() => expect(result.current.status).toBe('checking'))
      await checkForUpdates({ silent: true })

      await act(async () => {
        check.resolve(AVAILABLE)
        await explicit
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(result.current.status).toBe('available')
    })
  })

  describe('a check the user closed before it finished', () => {
    it('does not re-open even when an update was found', async () => {
      const check = deferred<unknown>()
      mockedInvoke.mockReturnValue(check.promise)
      const { result } = renderHook(() => useUpdater())
      const pending = checkForUpdates()
      await waitFor(() => expect(result.current.status).toBe('checking'))

      act(() => {
        result.current.dismiss()
      })
      await act(async () => {
        check.resolve(AVAILABLE)
        await pending
      })

      expect(result.current.status).toBe('idle')
    })
  })

  describe('silent check', () => {
    it('says nothing when up to date', async () => {
      const { result } = renderHook(() => useUpdater())

      await act(async () => {
        await result.current.check({ silent: true })
      })

      expect(result.current.status).toBe('idle')
    })

    it('stays silent when the check fails', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockedInvoke.mockRejectedValue('offline')
      const { result } = renderHook(() => useUpdater())

      await act(async () => {
        await result.current.check({ silent: true })
      })

      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
      logged.mockRestore()
    })

    it('still surfaces an available update', async () => {
      mockedInvoke.mockResolvedValue(AVAILABLE)
      const { result } = renderHook(() => useUpdater())

      await act(async () => {
        await result.current.check({ silent: true })
      })

      expect(result.current.status).toBe('available')
    })

    it('never clobbers a running install when it resolves late', async () => {
      const late = deferred<unknown>()
      let checks = 0
      // First check answers at once; the second one is still in flight when the
      // user starts the install. `install_update` is held open so the state
      // machine stays on `downloading`.
      mockedInvoke.mockImplementation((cmd) => {
        if (cmd !== 'check_for_update') return new Promise(() => {})
        checks += 1
        return checks === 1 ? Promise.resolve(AVAILABLE) : late.promise
      })
      const { result } = renderHook(() => useUpdater())
      await act(async () => {
        await result.current.check()
      })
      const pending = checkForUpdates({ silent: true })

      act(() => {
        void result.current.install()
      })
      await waitFor(() => expect(result.current.status).toBe('downloading'))
      await act(async () => {
        late.resolve(AVAILABLE)
        await pending
      })

      expect(result.current.status).toBe('downloading')
    })
  })

  describe('runStartupUpdateCheck', () => {
    it('checks without rehydrating the already-hydrated store', async () => {
      const rehydrate = vi.spyOn(useUiStore.persist, 'rehydrate')

      await runStartupUpdateCheck()

      expect(mockedInvoke).toHaveBeenCalledWith('check_for_update')
      // zustand hydrates synchronously at import; a second rehydrate would merge
      // storage back over every other persisted field.
      expect(rehydrate).not.toHaveBeenCalled()
      rehydrate.mockRestore()
    })

    it('checks only once per launch', async () => {
      await runStartupUpdateCheck()
      await runStartupUpdateCheck()

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
    })

    it('reaches the network not at all when the user turned auto-check off', async () => {
      useUiStore.setState({ autoCheckUpdates: false })

      await runStartupUpdateCheck()

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('leaves the menu item working when auto-check is off', async () => {
      useUiStore.setState({ autoCheckUpdates: false })
      mockedInvoke.mockResolvedValue(AVAILABLE)
      const { result } = renderHook(() => useUpdater())

      await act(async () => {
        await result.current.check()
      })

      expect(mockedInvoke).toHaveBeenCalledWith('check_for_update')
      expect(result.current.status).toBe('available')
    })
  })

  describe('install', () => {
    it('flushes the tab session before installing', async () => {
      mockedInvoke.mockReturnValue(new Promise(() => {}))

      void installUpdate()

      await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('install_update'))
      expect(mockedFlush).toHaveBeenCalledTimes(1)
      expect(mockedFlush.mock.invocationCallOrder[0]).toBeLessThan(
        mockedInvoke.mock.invocationCallOrder[0],
      )
    })

    it('ignores a second install while one is running', async () => {
      mockedInvoke.mockReturnValue(new Promise(() => {}))

      void installUpdate()
      await waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1))
      void installUpdate()

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
    })

    it('surfaces an install failure as install-failed, not a check failure', async () => {
      mockedInvoke.mockRejectedValue('signature mismatch')

      await installUpdate()

      const { result } = renderHook(() => useUpdater())
      expect(result.current.status).toBe('install-failed')
      expect(result.current.error).toBe('signature mismatch')
    })
  })

  describe('a background install that finished', () => {
    /** Drive a check + install to completion, leaving an update staged. */
    async function installFrom(update = AVAILABLE) {
      mockedInvoke.mockResolvedValue(update)
      await checkForUpdates()
      mockedInvoke.mockResolvedValue(null)
      await installUpdate()
    }

    it('asks to restart instead of restarting on its own', async () => {
      await installFrom()

      const { result } = renderHook(() => useUpdater())
      expect(result.current.status).toBe('ready-to-restart')
      // The version is what the card shows.
      expect(result.current.update).toEqual(AVAILABLE)
      expect(mockedInvoke).not.toHaveBeenCalledWith('restart_app')
    })

    it('re-raises the card on an explicit check after Later, instead of doing nothing', async () => {
      // The menu item must never look dead — that was the whole point of the
      // in-flight guard fix. Once a build is staged, "Check For Updates…" has
      // an honest answer ("restart to apply"), so silence is the wrong one.
      await installFrom()
      dismissUpdate()
      mockedInvoke.mockClear()

      await checkForUpdates()

      const { result } = renderHook(() => useUpdater())
      expect(result.current.status).toBe('ready-to-restart')
      expect(result.current.update).toEqual(AVAILABLE)
      // …and it must not re-download the 85 MB bundle to say so.
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('stays silent on a startup check after Later — no uninvited card', async () => {
      await installFrom()
      dismissUpdate()

      await checkForUpdates({ silent: true })

      const { result } = renderHook(() => useUpdater())
      expect(result.current.status).toBe('idle')
    })

    it('flushes the tab session before restart_app — the real exit point', async () => {
      await installFrom()
      mockedInvoke.mockClear()
      mockedFlush.mockClear()

      await restartApp()

      expect(mockedFlush).toHaveBeenCalledTimes(1)
      expect(mockedFlush.mock.invocationCallOrder[0]).toBeLessThan(
        mockedInvoke.mock.invocationCallOrder[0],
      )
      expect(mockedInvoke).toHaveBeenCalledWith('restart_app')
    })

    it('keeps the card up when restart_app fails, instead of losing the update', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      await installFrom()
      mockedInvoke.mockRejectedValue('ipc gone')

      await restartApp()

      const { result } = renderHook(() => useUpdater())
      expect(result.current.status).toBe('ready-to-restart')
      logged.mockRestore()
    })

    it('refuses a second install of an update already on disk', async () => {
      await installFrom()
      mockedInvoke.mockClear()

      await installUpdate()

      expect(mockedInvoke).not.toHaveBeenCalled()
    })
  })

  describe('a background install that failed', () => {
    it('leaves the updater usable — nothing was staged, so a retry can check', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockedInvoke.mockRejectedValue('signature mismatch')
      await installUpdate()
      const { result } = renderHook(() => useUpdater())

      // What `UpdateReadyCard` does after toasting the failure.
      act(() => {
        result.current.dismiss()
      })
      mockedInvoke.mockResolvedValue(AVAILABLE)
      await act(async () => {
        await result.current.check()
      })

      expect(result.current.status).toBe('available')
      logged.mockRestore()
    })
  })
})
