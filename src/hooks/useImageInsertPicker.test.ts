import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    pickImagesFromLibrary: vi.fn(),
    pickImage: vi.fn(),
  }
})

vi.mock('../lib/platform', () => ({
  isMacOS: vi.fn(() => true),
  detectPlatform: vi.fn(() => 'macos' as const),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}))

import { useImageInsertPicker, parseImageError } from './useImageInsertPicker'
import type { ImageActionResult } from './useImageInsertPicker'
import * as tauri from '../lib/tauri'
import * as platform from '../lib/platform'

const mockPickImagesFromLibrary = vi.mocked(tauri.pickImagesFromLibrary)
const mockPickImage = vi.mocked(tauri.pickImage)
const mockIsMacOS = vi.mocked(platform.isMacOS)

type EditorStub = {
  chain: () => {
    focus: () => { setImage: (opts: unknown) => { run: () => boolean } }
    setImage: (opts: unknown) => { run: () => boolean }
  }
}

function makeEditorStub(): { editor: EditorStub; setImage: ReturnType<typeof vi.fn> } {
  const setImage = vi.fn(() => ({ run: () => true }))
  const chainObj = {
    focus: () => ({ setImage }),
    setImage,
  }
  return {
    editor: { chain: () => chainObj },
    setImage,
  }
}

// `parseImageError` is the mirror of `parseVideoError`. The left-split-on-2
// contract exists because the trailing prose restates byte counts AND
// contains colons, so we must NOT right-split.
describe('parseImageError', () => {
  it('ignores colons and numbers inside the trailing prose', () => {
    // The prose contains `:` and numbers (it restates byte counts). The
    // parser splits on exactly the first two colons after the prefix and
    // discards the rest, so the prose never leaks into the byte fields.
    const result = parseImageError(
      'IMAGE_TOO_LARGE:2000000:1048576:format cannot be compressed (2000000 bytes, 1048576 bytes limit)',
    )
    expect(result).toEqual({
      kind: 'image-too-large',
      actualBytes: 2000000,
      limitBytes: 1048576,
    })
  })

  it('classifies an unrelated error string as unknown', () => {
    const result = parseImageError('some other error')
    expect(result).toEqual({ kind: 'unknown', message: 'some other error' })
  })

  it('falls back to unknown when the byte fields are not parseable', () => {
    // A payload missing the numeric fields must not produce NaN counts.
    const result = parseImageError('IMAGE_TOO_LARGE:abc:def:some prose')
    expect(result).toEqual({ kind: 'unknown', message: 'IMAGE_TOO_LARGE:abc:def:some prose' })
  })
})

describe('useImageInsertPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMacOS.mockReturnValue(true)
  })

  it('insertInlineFromPhotoLibrary inserts and returns saved=1 on a one-photo result', async () => {
    mockPickImagesFromLibrary.mockResolvedValueOnce([{ mediaId: 'm1', localPath: '/tmp/a.jpg' }])
    const { editor, setImage } = makeEditorStub()
    const { result } = renderHook(() => useImageInsertPicker())

    let out: ImageActionResult = { saved: -1, insertedInline: false, error: null }
    await act(async () => {
      out = await result.current.insertInlineFromPhotoLibrary(editor as never, 'e1')
    })
    expect(out).toEqual({ saved: 1, insertedInline: true, error: null })
    expect(setImage).toHaveBeenCalledTimes(1)
    expect(setImage).toHaveBeenCalledWith(
      expect.objectContaining({
        'data-media-id': 'm1',
        src: 'asset://localhost//tmp/a.jpg',
      }),
    )
  })

  it('insertInlineRfd surfaces a typed IMAGE_TOO_LARGE error from the rfd path', async () => {
    // The whole point of the I1 refactor: the rfd path must thread the
    // backend IMAGE_TOO_LARGE error up as a typed ImagePickError rather
    // than swallowing it in a bare catch.
    mockPickImage.mockRejectedValueOnce(
      'IMAGE_TOO_LARGE:5000000:1048576:format cannot be compressed',
    )
    const { editor, setImage } = makeEditorStub()
    const { result } = renderHook(() => useImageInsertPicker())

    let out: ImageActionResult = { saved: -1, insertedInline: false, error: null }
    await act(async () => {
      out = await result.current.insertInlineRfd(editor as never, 'e1')
    })
    expect(out).toEqual({
      saved: 0,
      insertedInline: false,
      error: { kind: 'image-too-large', actualBytes: 5000000, limitBytes: 1048576 },
    })
    expect(setImage).not.toHaveBeenCalled()
  })
})
