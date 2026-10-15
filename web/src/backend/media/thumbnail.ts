/**
 * Client-side thumbnail generation and media upload limits (Phase 16.3).
 *
 * - Limits mirror desktop defaults (`commands/media.rs:149-153`, `:1949`):
 *     photo: 5 MB (`DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES`)
 *     video: 100 MB (`DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES`)
 * - Thumbnail dimensions clamp to `DEFAULT_THUMB_MAX_EDGE = 512`.
 * - Video poster frame captured via HTML5 `<video>` element.
 * - Image thumbnail rendered via `<canvas>`.
 */

export const DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES = 5 * 1024 * 1024
export const DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024
export const DEFAULT_THUMB_MAX_EDGE = 512
export const DEFAULT_THUMB_QUALITY = 0.8

/** Allowed MIME types matching core outbox ALLOWED_MIME_TYPES. */
export const ALLOWED_MEDIA_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
])

export function isAllowedMimeType(mime: string): boolean {
  return ALLOWED_MEDIA_MIME_TYPES.has(mime.toLowerCase())
}

// ---------------------------------------------------------------------------------------------
// Attachments (web gap audit Phase 14): mirror of the core outbox media policy for `attach_media`
// (memlore-core outbox.rs `outbox_media_class`) and of the desktop file picker
// (`commands/media.rs` `pick_files_to_attach`, `mime_from_ext`, `sanitize_attachment_filename`).
// ---------------------------------------------------------------------------------------------

/** Core `OCTET_STREAM_MIME`: every other attached file. */
export const OCTET_STREAM_MIME = 'application/octet-stream'
/** Core `MAX_ATTACHED_FILE_BYTES` = desktop `MAX_ATTACHED_FILE_SIZE`. */
export const MAX_ATTACHED_FILE_BYTES = 50 * 1024 * 1024
/** Desktop `MAX_ATTACHED_BATCH`. */
export const MAX_ATTACHED_BATCH = 20
/** Core `MAX_ATTACH_DURATION_MS` (24 h). */
const MAX_ATTACH_DURATION_MS = 24 * 60 * 60 * 1000
/** Desktop `SANITIZED_FILENAME_MAX_BYTES` (UTF-8). */
const SANITIZED_FILENAME_MAX_BYTES = 200

/**
 * The web audio files (Q5: wav, mp3, m4a), by extension, to core `AUDIO_MIME_TYPES`. The
 * browser's `File.type` is not trusted (`audio/x-wav`, `audio/wave`, `audio/x-m4a`, `audio/m4a`,
 * `audio/mp3`, or empty): the extension normalises it to the core type, whose storage extension
 * the desktop derives from it.
 */
const AUDIO_EXTENSION_MIME: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
}

/**
 * Extensions desktop `mime_from_ext` maps to an image, video or audio type: its attach picker
 * refuses them (`MEDIA_NOT_ALLOWED`) and its importer refuses them as a generic file
 * (`media_not_allowed`, `attach_extension`). `wav` is the audio path on the web.
 */
const DESKTOP_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'heic',
  'heif',
  'svg',
  'mp4',
  'mov',
  'webm',
  'm4v',
  'wav',
])

/**
 * Core `is_disguising_char`: a line / paragraph separator, a zero-width space or directional mark,
 * a bidi embedding / override / isolate or a Unicode tag character (ZWNJ / ZWJ pass). Core refuses
 * them in a file name; the web strips them (they do not show).
 */
const DISGUISING_CHARS =
  /[\u2028\u2029\u061C\uFEFF\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu
/** Rust `char::is_control` (Unicode Cc: U+0000-001F, U+007F-009F) or a path separator. */
function isControlOrSeparator(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || ch === '/' || ch === '\\'
}

/**
 * The display name `attach_media` carries: desktop `sanitize_attachment_filename` (separators and
 * control chars to `_`, leading dots stripped, at most 200 UTF-8 bytes, `file.bin` when empty),
 * with the disguising chars core refuses removed first, so core validate always accepts it.
 */
function sanitizeAttachmentFileName(original: string): string {
  const cleaned = Array.from(original.replace(DISGUISING_CHARS, ''), (ch) =>
    isControlOrSeparator(ch) ? '_' : ch,
  )
    .join('')
    .replace(/^\.+/, '')
  let bounded = ''
  let bytes = 0
  for (const ch of cleaned) {
    const size = new TextEncoder().encode(ch).length
    if (bytes + size > SANITIZED_FILENAME_MAX_BYTES) break
    bounded += ch
    bytes += size
  }
  // 200 bytes is at most 200 chars (core `MAX_ATTACH_FILE_NAME_CHARS` is 255); core refuses a
  // blank name.
  return bounded.trim() === '' ? 'file.bin' : bounded
}

/** Rust `Path::extension` of a sanitised name (no separators, no leading dot), lowercased. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export type AttachPolicy =
  | { ok: true; fileName: string; fileType: string; audio: boolean }
  | { ok: false; error: string }

/**
 * The `attach_media` shape of one picked file, or the desktop picker's error string
 * (`MEDIA_NOT_ALLOWED:<name>`, `FILE_TOO_LARGE:<name>:<max_mb>`, parsed by `useFilePicker`). The
 * error names the sanitised file, so a bidi or control char in the picked name cannot spoof it.
 * Extension-driven like desktop: an image / video extension is refused, `.wav` / `.mp3` / `.m4a`
 * is audio, anything else is `application/octet-stream` whatever the browser's type says.
 */
export function attachPolicy(originalName: string, size: number): AttachPolicy {
  const fileName = sanitizeAttachmentFileName(originalName)
  const ext = extensionOf(fileName)
  const audioType = Object.hasOwn(AUDIO_EXTENSION_MIME, ext) ? AUDIO_EXTENSION_MIME[ext] : undefined
  if (audioType === undefined && DESKTOP_MEDIA_EXTENSIONS.has(ext)) {
    return { ok: false, error: `MEDIA_NOT_ALLOWED:${fileName}` }
  }
  if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHED_FILE_BYTES) {
    return {
      ok: false,
      error: `FILE_TOO_LARGE:${fileName}:${MAX_ATTACHED_FILE_BYTES / (1024 * 1024)}`,
    }
  }
  return audioType === undefined
    ? { ok: true, fileName, fileType: OCTET_STREAM_MIME, audio: false }
    : { ok: true, fileName, fileType: audioType, audio: true }
}

/** Seconds -> core `duration_ms`, or null when unknown, non-finite or over 24 h. */
function durationMsOf(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const ms = Math.round(seconds * 1000)
  return ms > MAX_ATTACH_DURATION_MS ? null : ms
}

/**
 * An audio file's duration in ms (core `duration_ms`) read from an `HTMLAudioElement`'s
 * metadata, or null when it cannot be read (no DOM, a decode error, a 5 s timeout).
 */
export async function probeAudioDurationMs(
  bytes: Uint8Array,
  mimeType: string,
): Promise<number | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null
  const objectUrl = URL.createObjectURL(
    new Blob([bytes as unknown as BlobPart], { type: mimeType }),
  )
  const audio = document.createElement('audio')
  try {
    const seconds = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => finish(null), 5000)
      const finish = (value: number | null): void => {
        clearTimeout(timer)
        audio.removeEventListener('loadedmetadata', onLoaded)
        audio.removeEventListener('error', onError)
        resolve(value)
      }
      const onLoaded = (): void => finish(audio.duration)
      const onError = (): void => finish(null)
      audio.addEventListener('loadedmetadata', onLoaded)
      audio.addEventListener('error', onError)
      audio.preload = 'metadata'
      audio.src = objectUrl
    })
    return durationMsOf(seconds)
  } finally {
    audio.removeAttribute('src')
    URL.revokeObjectURL(objectUrl)
  }
}

export interface ThumbnailResult {
  thumbnailBytes: Uint8Array
  width: number
  height: number
  duration?: number
}

export interface ThumbnailOptions {
  maxEdge?: number
  quality?: number
}

/** Formats the typed error string expected by `parseImageError`. */
export function formatImageTooLargeError(actualBytes: number, limitBytes: number): string {
  return `IMAGE_TOO_LARGE:${actualBytes}:${limitBytes}:Image exceeds upload limit of ${limitBytes} bytes`
}

/** Formats the typed error string expected by `parseVideoError`. */
export function formatVideoTooLargeError(filename: string, limitBytes: number): string {
  const maxMb = Math.round(limitBytes / (1024 * 1024))
  return `VIDEO_TOO_LARGE:${filename}:${maxMb}`
}

function calculateScaledDimensions(
  origW: number,
  origH: number,
  maxEdge: number,
): { width: number; height: number } {
  if (origW <= 0 || origH <= 0) {
    return { width: Math.max(1, maxEdge), height: Math.max(1, maxEdge) }
  }
  if (origW <= maxEdge && origH <= maxEdge) {
    return { width: Math.round(origW), height: Math.round(origH) }
  }
  if (origW >= origH) {
    const scale = maxEdge / origW
    return { width: maxEdge, height: Math.max(1, Math.round(origH * scale)) }
  }
  const scale = maxEdge / origH
  return { width: Math.max(1, Math.round(origW * scale)), height: maxEdge }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) throw new Error('invalid data URL')
  const base64 = dataUrl.slice(comma + 1)
  if (typeof atob === 'function') {
    const bin = atob(base64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i)
    }
    return out
  }
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

// Test hooks for custom generator overrides (e.g. in headless Node tests)
type ImageGenerator = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
) => Promise<ThumbnailResult>
type VideoGenerator = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
) => Promise<ThumbnailResult>

let customImageGenerator: ImageGenerator | null = null
let customVideoGenerator: VideoGenerator | null = null

export function setCustomThumbnailGenerators(
  imageGen: ImageGenerator | null,
  videoGen: VideoGenerator | null,
): void {
  customImageGenerator = imageGen
  customVideoGenerator = videoGen
}

/**
 * Generates a JPEG thumbnail from raw image bytes using Canvas.
 */
export async function generateImageThumbnail(
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
): Promise<ThumbnailResult> {
  if (customImageGenerator) {
    return customImageGenerator(bytes, mimeType, options)
  }

  const maxEdge = options?.maxEdge ?? DEFAULT_THUMB_MAX_EDGE
  const quality = options?.quality ?? DEFAULT_THUMB_QUALITY

  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    // In headless test environments without DOM or canvas, return a minimal stub JPEG
    const fallbackJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0xff, 0xd9])
    return {
      thumbnailBytes: fallbackJpeg,
      width: Math.min(100, maxEdge),
      height: Math.min(100, maxEdge),
    }
  }

  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)

  try {
    const img = document.createElement('img')
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image for thumbnail generation'))
      img.src = objectUrl
    })

    const { width, height } = calculateScaledDimensions(
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      maxEdge,
    )

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context not available')

    ctx.drawImage(img, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const thumbnailBytes = dataUrlToBytes(dataUrl)

    return {
      thumbnailBytes,
      width,
      height,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Generates a JPEG thumbnail from raw video bytes using HTML5 `<video>` and Canvas.
 */
export async function generateVideoThumbnail(
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
): Promise<ThumbnailResult> {
  if (customVideoGenerator) {
    return customVideoGenerator(bytes, mimeType, options)
  }

  const maxEdge = options?.maxEdge ?? DEFAULT_THUMB_MAX_EDGE
  const quality = options?.quality ?? DEFAULT_THUMB_QUALITY

  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    const fallbackJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0xff, 0xd9])
    return {
      thumbnailBytes: fallbackJpeg,
      width: Math.min(100, maxEdge),
      height: Math.min(100, maxEdge),
      duration: 1.0,
    }
  }

  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)

  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    video.src = objectUrl

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Failed to load video for thumbnail generation'))
      }
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onError)
      }
      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', onError)
    })

    const duration = video.duration || 0
    const targetTime = Math.min(0.1, duration > 0 ? duration / 2 : 0)

    if (video.currentTime !== targetTime) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          resolve()
        }, 1500)
        const onSeeked = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error('Failed to seek video for thumbnail generation'))
        }
        const cleanup = () => {
          clearTimeout(timer)
          video.removeEventListener('seeked', onSeeked)
          video.removeEventListener('error', onError)
        }
        video.addEventListener('seeked', onSeeked)
        video.addEventListener('error', onError)
        video.currentTime = targetTime
      })
    }

    const { width, height } = calculateScaledDimensions(
      video.videoWidth || 320,
      video.videoHeight || 240,
      maxEdge,
    )

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context not available')

    ctx.drawImage(video, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const thumbnailBytes = dataUrlToBytes(dataUrl)

    return {
      thumbnailBytes,
      width,
      height,
      duration,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
