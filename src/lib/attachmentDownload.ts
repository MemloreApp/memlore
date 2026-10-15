import { save } from '@tauri-apps/plugin-dialog'

import { ensureMediaCached } from '../components/media/mediaCache'
import { isWeb } from './platform'
import { exportMediaToPath, readMediaBytes, type MediaRow } from './tauri'

export type DownloadResult = 'saved' | 'cancelled' | 'error'

/**
 * Save a non-media attachment. Desktop drives the OS "Save As…" dialog and
 * copies the decrypted bytes to the user-chosen path, auto-downloading from
 * the cloud first if the row is not yet cached locally (mirrors the auto-DL
 * policy MediaAttachment uses for inline media). Web reads the decrypted
 * bytes and hands them to the browser as a download.
 *
 * Returns:
 * - `'saved'` — file written to disk (web: download handed to the browser).
 * - `'cancelled'` — user dismissed the Save dialog (desktop only).
 * - `'error'` — bytes could not be fetched or the copy failed.
 */
export async function downloadAttachment(media: MediaRow): Promise<DownloadResult> {
  try {
    if (isWeb) {
      // `read_media_bytes` downloads, verifies and caches on its own, so
      // `ensureMediaCached` would only read the file a second time.
      const bytes = new Uint8Array(await readMediaBytes(media.id))
      const type = media.file_type || 'application/octet-stream'
      downloadBlob(new Blob([bytes], { type }), media.file_name)
      return 'saved'
    }

    // Ensure the file is on disk before opening the save dialog so the
    // user does not see the dialog open against an empty source. The
    // call is idempotent + deduped at the cache layer.
    const cached = await ensureMediaCached(media.id, false)
    if (!cached) return 'error'

    const destPath = await save({
      defaultPath: media.file_name,
      title: 'Save attachment',
    })
    if (destPath === null || destPath === undefined) return 'cancelled'

    await exportMediaToPath(media.id, destPath)
    return 'saved'
  } catch (err) {
    console.error('downloadAttachment failed', err)
    return 'error'
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    // Deferred: Safari and Firefox can drop the download when the URL is
    // revoked in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
