import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the tauri wrappers so we never hit real IPC.
vi.mock('../lib/tauri', () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  saveAudioMemo: vi.fn(),
  readAudioMemoBytes: vi.fn(),
  discardAudioMemo: vi.fn(),
}))

import {
  discardAudioMemo,
  readAudioMemoBytes,
  saveAudioMemo,
  startRecording,
  stopRecording,
} from '../lib/tauri'
import { useAudioRecorder } from './useAudioRecorder'

const mockStart = vi.mocked(startRecording)
const mockStop = vi.mocked(stopRecording)
const mockSave = vi.mocked(saveAudioMemo)
const mockRead = vi.mocked(readAudioMemoBytes)
const mockDiscard = vi.mocked(discardAudioMemo)

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL — stub both.
beforeEach(() => {
  vi.useFakeTimers()
  mockStart.mockReset()
  mockStop.mockReset()
  mockSave.mockReset()
  mockRead.mockReset()
  mockDiscard.mockReset()

  // Default: read returns minimal WAV bytes, discard succeeds silently.
  mockRead.mockResolvedValue([82, 73, 70, 70])
  mockDiscard.mockResolvedValue(undefined)

  // URL.createObjectURL is not implemented in jsdom.
  global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  global.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAudioRecorder', () => {
  it('save transitions preview → saving → idle and calls onDone', async () => {
    mockStart.mockResolvedValue('session-1')
    mockStop.mockResolvedValue({ tempPath: '/tmp/memo.wav', durationSeconds: 5.0 })
    mockSave.mockResolvedValue({ mediaId: 'media-123', localPath: '/app/media/memo.wav' })

    const onDone = vi.fn()
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      result.current.start()
    })
    await act(async () => {
      result.current.stop()
    })
    await act(async () => {
      result.current.save('entry-1', onDone)
    })

    expect(mockSave).toHaveBeenCalledWith('entry-1', '/tmp/memo.wav', 5.0)
    expect(onDone).toHaveBeenCalledWith({ mediaId: 'media-123', localPath: '/app/media/memo.wav' })
    expect(result.current.state).toBe('idle')
    expect(result.current.elapsed).toBe(0)
    expect(result.current.previewUrl).toBeNull()
  })

  it('discard deletes temp file and returns to idle', async () => {
    mockStart.mockResolvedValue('session-1')
    mockStop.mockResolvedValue({ tempPath: '/tmp/memo.wav', durationSeconds: 5.0 })

    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      result.current.start()
    })
    await act(async () => {
      result.current.stop()
    })
    expect(result.current.state).toBe('preview')

    await act(async () => {
      result.current.discard()
    })

    expect(mockDiscard).toHaveBeenCalledWith('/tmp/memo.wav')
    expect(result.current.state).toBe('idle')
    expect(result.current.previewUrl).toBeNull()
  })

  it('transitions to error state if startRecording rejects', async () => {
    mockStart.mockRejectedValue(new Error('Mic denied'))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      result.current.start()
    })

    expect(result.current.state).toBe('error')
    expect(result.current.error).toMatch(/Mic denied/)
  })
})
