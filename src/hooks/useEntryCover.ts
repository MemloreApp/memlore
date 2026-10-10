import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureVideoThumbnail,
  getMediaStatus,
  listMediaForEntry,
  type MediaRow,
  type MediaStatus,
} from '../lib/tauri'
import {
  ensureMediaCached,
  peekCachedMedia,
  resolveCachedMedia,
} from '../components/media/mediaCache'

/**
 * What an entry card paints in its cover slot:
 *   - `'loading'` — still resolving (skeleton backdrop)
 *   - `{ src }` — a blob URL ready for `<img>`
 *   - `{ videoOnly: true }` — video cover with no poster and no image (video icon box)
 *   - `'none'` — no candidate image loads; render no cover at all
 */
export type EntryCover = 'loading' | { src: string } | { videoOnly: true } | 'none'

interface UseEntryCoverArgs {
  entryId: string
  coverMediaId: string | null
  activeVaultId: string | null
}

const isImageType = (fileType: string) => fileType.startsWith('image/')

function seedCover(coverMediaId: string | null): EntryCover {
  if (!coverMediaId) return 'none'
  const cached = peekCachedMedia(coverMediaId, true)
  return cached ? { src: cached.blobUrl } : 'loading'
}

function sameCover(a: EntryCover, b: EntryCover): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if ('src' in a && 'src' in b) return a.src === b.src
  return 'videoOnly' in a && 'videoOnly' in b
}

async function resolveSrc(mediaId: string, useThumbnail: boolean): Promise<string | null> {
  const hit = await resolveCachedMedia(mediaId, useThumbnail)
  return hit ? hit.blobUrl : null
}

/**
 * Candidate ladder for one media id: local thumbnail → download thumbnail →
 * (when `allowFull`) download the full file. A throw at any step (e.g. the
 * row is gone: "Media not found") means this candidate failed.
 */
async function loadCandidate(
  mediaId: string,
  allowFull: boolean,
  isCancelled: () => boolean,
): Promise<string | null> {
  try {
    const local = await resolveSrc(mediaId, true)
    if (local || isCancelled()) return local
    if (await ensureMediaCached(mediaId, true)) {
      if (isCancelled()) return null
      const thumb = await resolveSrc(mediaId, true)
      if (thumb) return thumb
    }
    if (!allowFull || isCancelled()) return null
    if (!(await ensureMediaCached(mediaId, false)) || isCancelled()) return null
    return await resolveSrc(mediaId, false)
  } catch {
    return null
  }
}

/**
 * Resolves an entry card's cover. Order: the cover (thumbnail, then full
 * image) → the entry's other images in sort order → `'none'`. A video cover
 * only ever uses its poster thumbnail (backfilled on demand, never the full
 * video), then the first loadable image, then `{ videoOnly: true }`.
 *
 * Cache hits seed synchronously so cards never flash a skeleton. A
 * `memlore:media-cached` event re-runs the resolution upgrade-only (it never
 * replaces a shown image with a worse one or `'none'`), and `reportBroken`
 * skips an image that failed to decode. The stored `cover_media_id` is never
 * changed; the fallback is display-only.
 */
export function useEntryCover({ entryId, coverMediaId, activeVaultId }: UseEntryCoverArgs): {
  cover: EntryCover
  reportBroken: () => void
} {
  const key = `${entryId}|${coverMediaId ?? ''}|${activeVaultId ?? ''}`
  const [cover, setCover] = useState<EntryCover>(() => seedCover(coverMediaId))
  const [prevKey, setPrevKey] = useState(key)
  const [attempt, setAttempt] = useState(0)
  // Media ids whose blob failed to decode; skipped until the key changes.
  const brokenRef = useRef<Set<string>>(new Set())
  // Media id behind the currently shown `{ src }`, if any.
  const shownIdRef = useRef<string | null>(typeof cover === 'object' ? coverMediaId : null)

  // Entry, cover or vault changed (e.g. a generated image became the cover):
  // reseed during render so the old cover never paints for the new key.
  if (prevKey !== key) {
    const seeded = seedCover(coverMediaId)
    setPrevKey(key)
    setCover(seeded)
    brokenRef.current = new Set()
    shownIdRef.current = typeof seeded === 'object' ? coverMediaId : null
  }

  useEffect(() => {
    // Nothing to resolve, or the cover is already shown from the cache.
    if (!coverMediaId || shownIdRef.current === coverMediaId) return

    let cancelled = false
    const isCancelled = () => cancelled
    const broken = brokenRef.current

    const show = (next: EntryCover, mediaId: string | null) => {
      if (cancelled) return
      shownIdRef.current = mediaId
      setCover((prev) => (sameCover(prev, next) ? prev : next))
    }

    const loadVideoPoster = async (initial: MediaStatus): Promise<string | null> => {
      let status = initial
      if (!status.thumbnailPath) {
        // Legacy row or failed extraction: backfill the poster on demand.
        try {
          if (await ensureVideoThumbnail(coverMediaId)) {
            if (cancelled) return null
            status = await getMediaStatus(coverMediaId)
          }
        } catch {
          // Best-effort; fall through to the image fallback.
        }
      }
      if (!status.thumbnailPath || cancelled) return null
      return loadCandidate(coverMediaId, false, isCancelled)
    }

    // `stopAt`: the shown fallback; rows from it on are not an upgrade.
    const loadOtherImage = async (
      stopAt: string | null,
    ): Promise<{ id: string; src: string } | null> => {
      let rows: MediaRow[] = []
      try {
        rows = await listMediaForEntry(entryId, undefined, activeVaultId)
      } catch {
        return null
      }
      for (const row of rows) {
        if (cancelled || row.id === stopAt) return null
        if (!isImageType(row.file_type) || row.id === coverMediaId || broken.has(row.id)) continue
        const src = await loadCandidate(row.id, true, isCancelled)
        if (src) return { id: row.id, src }
      }
      return null
    }

    // `upgradeOnly` (event-triggered): with a fallback image shown, only the
    // cover or an earlier candidate replaces it; otherwise it is kept, so a
    // transient failure never downgrades a working image.
    const walk = async (upgradeOnly: boolean) => {
      const keepId = upgradeOnly ? shownIdRef.current : null
      let status: MediaStatus | null = null
      try {
        status = await getMediaStatus(coverMediaId)
      } catch {
        // No row (or IPC failure): the cover is not a candidate.
      }
      if (cancelled) return
      const isVideo = status?.fileType.startsWith('video/') ?? false
      if (status && !broken.has(coverMediaId)) {
        const src = isVideo
          ? await loadVideoPoster(status)
          : await loadCandidate(coverMediaId, isImageType(status.fileType), isCancelled)
        if (cancelled) return
        if (src) return show({ src }, coverMediaId)
      }
      const other = await loadOtherImage(keepId)
      if (cancelled) return
      if (other) return show({ src: other.src }, other.id)
      // A failed lookup on an event re-walk can't tell video from image, so
      // it keeps the current state (e.g. `{ videoOnly }`) instead of `'none'`.
      if (keepId || (upgradeOnly && !status)) return
      show(isVideo ? { videoOnly: true } : 'none', null)
    }

    // Coalesce: an event during a walk queues exactly one more walk.
    let running = false
    let again = false
    const run = async (fromEvent: boolean) => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        let upgradeOnly = fromEvent
        do {
          again = false
          await walk(upgradeOnly)
          // A queued re-walk always comes from an event.
          upgradeOnly = true
        } while (again && !cancelled && shownIdRef.current !== coverMediaId)
      } finally {
        running = false
      }
    }

    void run(false)

    // A download finished somewhere in the app: it may be one of ours.
    const onMediaCached = () => {
      if (cancelled || shownIdRef.current === coverMediaId) return
      void run(true)
    }
    window.addEventListener('memlore:media-cached', onMediaCached)

    return () => {
      cancelled = true
      window.removeEventListener('memlore:media-cached', onMediaCached)
      // Blob URLs belong to the module-level LRU in mediaCache.ts; never revoke here.
    }
  }, [entryId, coverMediaId, activeVaultId, attempt])

  const reportBroken = useCallback(() => {
    const mediaId = shownIdRef.current
    if (!mediaId) return
    brokenRef.current.add(mediaId)
    shownIdRef.current = null
    setCover('loading')
    setAttempt((n) => n + 1)
  }, [])

  return { cover, reportBroken }
}
