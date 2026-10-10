import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useEntryCover } from './useEntryCover'
import type { MediaRow, MediaStatus } from '../lib/tauri'
import type { CachedMedia } from '../components/media/mediaCache'

vi.mock('../lib/tauri', () => ({
  getMediaStatus: vi.fn(),
  listMediaForEntry: vi.fn(),
  ensureVideoThumbnail: vi.fn(),
}))

vi.mock('../components/media/mediaCache', () => ({
  peekCachedMedia: vi.fn(),
  resolveCachedMedia: vi.fn(),
  ensureMediaCached: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import * as mediaCache from '../components/media/mediaCache'

const getMediaStatus = vi.mocked(tauri.getMediaStatus)
const listMediaForEntry = vi.mocked(tauri.listMediaForEntry)
const ensureVideoThumbnail = vi.mocked(tauri.ensureVideoThumbnail)
const peekCachedMedia = vi.mocked(mediaCache.peekCachedMedia)
const resolveCachedMedia = vi.mocked(mediaCache.resolveCachedMedia)
const ensureMediaCached = vi.mocked(mediaCache.ensureMediaCached)

const makeStatus = (overrides: Partial<MediaStatus> = {}): MediaStatus => ({
  mediaId: 'cover',
  cachedLocally: false,
  hasCloudCopy: true,
  localPath: null,
  thumbnailPath: null,
  fileType: 'image/jpeg',
  fileSize: null,
  compressed: false,
  width: null,
  height: null,
  ...overrides,
})

const makeRow = (overrides: Partial<MediaRow> = {}): MediaRow => ({
  id: 'img-2',
  entry_id: 'e1',
  file_name: 'img.jpg',
  file_type: 'image/jpeg',
  storage_provider: 'local',
  storage_path: '',
  thumbnail_path: null,
  upload_status: 'uploaded',
  uploaded_at: null,
  file_size: null,
  cloud_path: null,
  last_accessed_at: null,
  sort_order: 0,
  created_at: 0,
  exif_date: null,
  exif_latitude: null,
  exif_longitude: null,
  insertion_mode: 'inline',
  duration_seconds: null,
  ...overrides,
})

const hit = (id: string, useThumbnail = true): CachedMedia => ({
  blobUrl: `blob:${id}${useThumbnail ? '' : ':full'}`,
  status: makeStatus({ mediaId: id }),
  useThumbnail,
})

/** Resolve exactly the listed `(id, useThumbnail)` pairs; everything else is null. */
function resolvable(pairs: Array<[string, boolean]>) {
  resolveCachedMedia.mockImplementation(async (id, useThumbnail) =>
    pairs.some(([i, t]) => i === id && t === useThumbnail) ? hit(id, useThumbnail) : null,
  )
}

const props = (coverMediaId: string | null) => ({
  entryId: 'e1',
  coverMediaId,
  activeVaultId: null,
})

beforeEach(() => {
  vi.resetAllMocks()
  peekCachedMedia.mockReturnValue(null)
  resolveCachedMedia.mockResolvedValue(null)
  ensureMediaCached.mockResolvedValue(false)
  listMediaForEntry.mockResolvedValue([])
  ensureVideoThumbnail.mockResolvedValue(false)
  getMediaStatus.mockResolvedValue(makeStatus())
})

describe('useEntryCover', () => {
  it('none when coverMediaId is null', () => {
    const { result } = renderHook(() => useEntryCover(props(null)))
    expect(result.current.cover).toBe('none')
    expect(getMediaStatus).not.toHaveBeenCalled()
  })

  it('seeds image synchronously from cache', () => {
    peekCachedMedia.mockImplementation((id, thumb) =>
      id === 'cover' && thumb ? hit('cover') : null,
    )
    const { result } = renderHook(() => useEntryCover(props('cover')))
    expect(result.current.cover).toEqual({ src: 'blob:cover' })
  })

  it('resolves cover thumbnail', async () => {
    resolvable([['cover', true]])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    expect(result.current.cover).toBe('loading')
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
  })

  it('falls back to full image when thumbnail fails', async () => {
    resolvable([['cover', false]])
    ensureMediaCached.mockImplementation(async (_id, thumb) => !thumb)
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover:full' }))
    expect(ensureMediaCached).toHaveBeenCalledWith('cover', true)
    expect(ensureMediaCached).toHaveBeenCalledWith('cover', false)
  })

  it('advances to next image when cover status throws', async () => {
    getMediaStatus.mockRejectedValue(new Error('Media not found'))
    resolveCachedMedia.mockImplementation(async (id, thumb) => {
      if (id === 'cover') throw new Error('Media not found')
      return thumb ? hit(id) : null
    })
    listMediaForEntry.mockResolvedValue([
      makeRow({ id: 'cover' }),
      makeRow({ id: 'vid', file_type: 'video/mp4' }),
      makeRow({ id: 'img-2' }),
      makeRow({ id: 'img-3' }),
    ])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:img-2' }))
    expect(listMediaForEntry).toHaveBeenCalledWith('e1', undefined, null)
    expect(resolveCachedMedia).not.toHaveBeenCalledWith('vid', expect.anything())
  })

  it('none when every candidate fails', async () => {
    listMediaForEntry.mockResolvedValue([makeRow({ id: 'img-2' })])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toBe('none'))
    expect(resolveCachedMedia).toHaveBeenCalledWith('img-2', true)
  })

  it('media-cached event upgrades none to image', async () => {
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toBe('none'))
    resolvable([['cover', true]])
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:media-cached'))
    })
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
  })

  it('media-cached event keeps fallback image when re-walk fails', async () => {
    listMediaForEntry.mockResolvedValue([makeRow({ id: 'img-2' })])
    resolvable([['img-2', true]])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:img-2' }))
    listMediaForEntry.mockRejectedValue(new Error('ipc'))
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:media-cached'))
    })
    await waitFor(() => expect(listMediaForEntry).toHaveBeenCalledTimes(2))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.cover).toEqual({ src: 'blob:img-2' })
  })

  it('media-cached event upgrades fallback image to cover', async () => {
    listMediaForEntry.mockResolvedValue([makeRow({ id: 'img-2' })])
    resolvable([['img-2', true]])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:img-2' }))
    resolvable([
      ['cover', true],
      ['img-2', true],
    ])
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:media-cached'))
    })
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
  })

  it('video cover with poster resolves', async () => {
    getMediaStatus.mockResolvedValue(
      makeStatus({ fileType: 'video/mp4', thumbnailPath: '/t/cover.thumb.jpg' }),
    )
    resolvable([['cover', true]])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
    expect(ensureVideoThumbnail).not.toHaveBeenCalled()
  })

  it('video cover backfills a missing poster', async () => {
    getMediaStatus
      .mockResolvedValueOnce(makeStatus({ fileType: 'video/mp4' }))
      .mockResolvedValue(makeStatus({ fileType: 'video/mp4', thumbnailPath: '/t/cover.thumb.jpg' }))
    ensureVideoThumbnail.mockResolvedValue(true)
    resolvable([['cover', true]])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
    expect(ensureVideoThumbnail).toHaveBeenCalledWith('cover')
  })

  it('video cover without poster falls back to first image', async () => {
    getMediaStatus.mockResolvedValue(makeStatus({ fileType: 'video/mp4' }))
    listMediaForEntry.mockResolvedValue([
      makeRow({ id: 'cover', file_type: 'video/mp4' }),
      makeRow({ id: 'img-2' }),
    ])
    resolvable([['img-2', true]])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:img-2' }))
  })

  it('video cover without poster or images is videoOnly', async () => {
    getMediaStatus.mockResolvedValue(makeStatus({ fileType: 'video/mp4' }))
    listMediaForEntry.mockResolvedValue([makeRow({ id: 'cover', file_type: 'video/mp4' })])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ videoOnly: true }))
  })

  it('media-cached event keeps videoOnly when status lookup fails', async () => {
    getMediaStatus.mockResolvedValue(makeStatus({ fileType: 'video/mp4' }))
    listMediaForEntry.mockResolvedValue([makeRow({ id: 'cover', file_type: 'video/mp4' })])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ videoOnly: true }))
    getMediaStatus.mockRejectedValue(new Error('ipc'))
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:media-cached'))
    })
    await waitFor(() => expect(listMediaForEntry).toHaveBeenCalledTimes(2))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.cover).toEqual({ videoOnly: true })
  })

  it('never requests full video', async () => {
    getMediaStatus.mockResolvedValue(
      makeStatus({ fileType: 'video/mp4', thumbnailPath: '/t/cover.thumb.jpg' }),
    )
    ensureMediaCached.mockResolvedValue(true)
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ videoOnly: true }))
    expect(ensureMediaCached).toHaveBeenCalledWith('cover', true)
    expect(ensureMediaCached).not.toHaveBeenCalledWith('cover', false)
    expect(resolveCachedMedia).not.toHaveBeenCalledWith('cover', false)
  })

  it('reportBroken advances to next candidate', async () => {
    listMediaForEntry.mockResolvedValue([makeRow({ id: 'img-2' })])
    resolvable([
      ['cover', true],
      ['img-2', true],
    ])
    const { result } = renderHook(() => useEntryCover(props('cover')))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
    const coverResolves = resolveCachedMedia.mock.calls.filter(([id]) => id === 'cover').length
    act(() => result.current.reportBroken())
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:img-2' }))
    expect(resolveCachedMedia.mock.calls.filter(([id]) => id === 'cover')).toHaveLength(
      coverResolves,
    )
  })

  it('reacts to a new coverMediaId', async () => {
    resolvable([
      ['cover', true],
      ['gen', true],
    ])
    const { result, rerender } = renderHook((p) => useEntryCover(p), {
      initialProps: props('cover'),
    })
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:cover' }))
    rerender(props('gen'))
    await waitFor(() => expect(result.current.cover).toEqual({ src: 'blob:gen' }))
  })

  it('ignores results after unmount', async () => {
    let release: (s: MediaStatus) => void = () => {}
    getMediaStatus.mockReturnValue(
      new Promise<MediaStatus>((resolve) => {
        release = resolve
      }),
    )
    const { unmount } = renderHook(() => useEntryCover(props('cover')))
    unmount()
    await act(async () => {
      release(makeStatus())
    })
    expect(resolveCachedMedia).not.toHaveBeenCalled()
    expect(ensureMediaCached).not.toHaveBeenCalled()
    expect(listMediaForEntry).not.toHaveBeenCalled()
  })
})
