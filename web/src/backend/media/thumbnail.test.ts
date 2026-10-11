import { describe, expect, it } from 'vitest'
import { formatImageTooLargeError, formatVideoTooLargeError } from './thumbnail'
import { parseImageError } from '../../../../src/hooks/useImageInsertPicker'
import { parseVideoError } from '../../../../src/hooks/useVideoInsertPicker'

describe('thumbnail constants & error formatters', () => {
  it('formatImageTooLargeError round-trips through parseImageError', () => {
    const raw = formatImageTooLargeError(6_000_000, 5_242_880)
    const parsed = parseImageError(raw)
    expect(parsed).toEqual({
      kind: 'image-too-large',
      actualBytes: 6_000_000,
      limitBytes: 5_242_880,
    })
  })

  it('formatVideoTooLargeError round-trips through parseVideoError', () => {
    const raw = formatVideoTooLargeError('my_trip.mp4', 104_857_600)
    const parsed = parseVideoError(raw)
    expect(parsed).toEqual({
      kind: 'video-too-large',
      filename: 'my_trip.mp4',
      maxSizeMb: 100,
    })
  })
})
