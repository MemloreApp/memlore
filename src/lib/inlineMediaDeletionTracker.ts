/**
 * Tracks inline media nodes that disappear from the editor doc (Backspace, cut,
 * delete, explicit remove) and deletes their backing media (DB row + disk file)
 * only once the editor has DETACHED from that entry and its final doc is saved.
 *
 * Design notes:
 * - Only ids that were SEEN in the doc and then disappeared are deleted. A DB
 *   row that was never in the doc (a "save-bug orphan") never enters the
 *   baseline, so it is never deleted here — it keeps its recovery banner.
 * - A save alone never deletes: while the entry is open, undo can still bring
 *   the node back after a save. Deletion waits for `memlore:entry-doc-detached`
 *   (entry switch, close, unmount), which carries the final doc's media ids;
 *   only ids that final doc no longer shows are deleted. When a save of that
 *   final doc is still owed (`awaitSave`, see `detachMustAwaitSave`: an edit
 *   not yet stored, OR the last persisted doc still shows an id the final doc
 *   lacks), the editor flushes that save and the drain waits for its
 *   `memlore:entry-doc-saved`; if it never lands, the media stays (the orphan
 *   banner offers Recover). Re-attaching the entry cancels that wait. So media
 *   is never deleted while the stored doc still shows its node.
 *   Attached media (footer strip, never in the doc) are never tracked.
 * - The cloud copy is not deleted here; the sync engine's own-cloud media prune
 *   sweeps a blob once its local row is gone.
 */

export const ENTRY_DOC_SAVED_EVENT = 'memlore:entry-doc-saved'

export interface EntryDocSavedDetail {
  entryId: string
}

export function emitEntryDocSaved(entryId: string): void {
  window.dispatchEvent(
    new CustomEvent<EntryDocSavedDetail>(ENTRY_DOC_SAVED_EVENT, { detail: { entryId } }),
  )
}

export const ENTRY_DOC_DETACHED_EVENT = 'memlore:entry-doc-detached'

export interface EntryDocDetachedDetail {
  entryId: string
  /** Media ids the final doc of the entry still shows. */
  mediaIds: string[]
  /** A save of that final doc is still owed (pending, in flight, or failed). */
  awaitSave: boolean
}

export function emitEntryDocDetached(
  entryId: string,
  mediaIds: Set<string>,
  awaitSave: boolean,
): void {
  window.dispatchEvent(
    new CustomEvent<EntryDocDetachedDetail>(ENTRY_DOC_DETACHED_EVENT, {
      detail: { entryId, mediaIds: [...mediaIds], awaitSave },
    }),
  )
}

/**
 * Whether the drain on detach must wait for a save of the final doc: a save is
 * still owed (an edit not yet stored), or the last PERSISTED doc still shows a
 * media id the final doc lacks. Deleting such an id would leave the stored doc
 * (and every synced peer) with a broken node.
 */
export function detachMustAwaitSave(
  saveOwed: boolean,
  persistedIds: Set<string>,
  finalIds: Set<string>,
): boolean {
  if (saveOwed) return true
  for (const id of persistedIds) if (!finalIds.has(id)) return true
  return false
}

export interface InlineMediaDeletionTracker {
  /** Call on every editor update with the media ids currently in the doc. */
  observe(entryId: string, currentIds: Set<string>): void
  /**
   * Reset the baseline (call when a new editor/doc is attached) so the next
   * `observe` seeds from the loaded doc without treating its ids as removals.
   * Does NOT cancel already-pending deletions.
   */
  resetBaseline(): void
  /**
   * Cancel a scheduled deletion — used when another path already deleted this
   * id, so the next detach drain does not fire a redundant delete.
   */
  cancelPending(id: string): void
  /** Remove the event listeners. Tests must call this; production does not. */
  dispose(): void
}

export interface InlineMediaDeletionOptions {
  deleteMedia: (id: string) => Promise<void>
  /** Invoked after a successful deletion (e.g. to refresh the attachment strip). */
  onDeleted?: () => void
  /**
   * How many times to retry a media whose delete failed transiently (e.g. a
   * `database is locked` / locked-app error), before giving up and logging.
   * A "not found" rejection is always treated as success (benign). Default 1.
   */
  maxRetries?: number
  /** Injectable target for tests; default `window`. */
  eventTarget?: EventTarget
}

export function createInlineMediaDeletionTracker(
  opts: InlineMediaDeletionOptions,
): InlineMediaDeletionTracker {
  const maxRetries = opts.maxRetries ?? 1
  const eventTarget = opts.eventTarget ?? window

  // Ids present in the doc on the previous observe (to diff removals against).
  let prevIds = new Set<string>()
  // Ids present in the doc on the MOST RECENT observe (the recheck at drain
  // time reads this so a re-insert after scheduling still wins).
  let lastIds = new Set<string>()
  // Observed-then-disappeared ids waiting for that entry to detach.
  const pending = new Map<string, { entryId: string; attempt: number }>()
  // Detached entries whose final doc still awaits its save: entryId -> the
  // media ids that final doc shows.
  const awaitingSave = new Map<string, Set<string>>()

  const attemptDelete = (id: string, attempt: number) => {
    if (lastIds.has(id)) return
    void opts
      .deleteMedia(id)
      .then(() => {
        opts.onDeleted?.()
      })
      .catch((err: unknown) => {
        const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        if (/not found/i.test(msg)) return
        if (attempt < maxRetries) {
          console.warn(`[media] delete of removed inline media ${id} failed, retrying:`, err)
          setTimeout(() => attemptDelete(id, attempt + 1), 50)
        } else {
          console.warn(`[media] gave up deleting removed inline media ${id}:`, err)
        }
      })
  }

  const cancelPending: InlineMediaDeletionTracker['cancelPending'] = (id) => {
    pending.delete(id)
  }

  const drain = (entryId: string, finalIds: Set<string>) => {
    for (const [id, p] of [...pending]) {
      if (p.entryId !== entryId) continue
      pending.delete(id)
      if (!finalIds.has(id)) attemptDelete(id, p.attempt)
    }
  }

  const onSaved = (event: Event) => {
    const entryId = (event as CustomEvent<EntryDocSavedDetail>).detail?.entryId
    if (typeof entryId !== 'string' || entryId.length === 0) return
    const finalIds = awaitingSave.get(entryId)
    if (!finalIds) return
    awaitingSave.delete(entryId)
    drain(entryId, finalIds)
  }

  const onDetached = (event: Event) => {
    const detail = (event as CustomEvent<Partial<EntryDocDetachedDetail>>).detail
    const entryId = detail?.entryId
    if (typeof entryId !== 'string' || entryId.length === 0) return
    if (!Array.isArray(detail?.mediaIds)) return
    const finalIds = new Set(detail.mediaIds)
    if (detail.awaitSave === true) {
      awaitingSave.set(entryId, finalIds)
      return
    }
    awaitingSave.delete(entryId)
    drain(entryId, finalIds)
  }

  eventTarget.addEventListener(ENTRY_DOC_SAVED_EVENT, onSaved)
  eventTarget.addEventListener(ENTRY_DOC_DETACHED_EVENT, onDetached)

  const observe: InlineMediaDeletionTracker['observe'] = (entryId, currentIds) => {
    // Attached again: the next detach decides, not a save owed by the last one.
    awaitingSave.delete(entryId)
    lastIds = new Set(currentIds)
    for (const id of currentIds) cancelPending(id)
    for (const id of prevIds) {
      if (currentIds.has(id) || pending.has(id)) continue
      pending.set(id, { entryId, attempt: 0 })
    }
    prevIds = new Set(currentIds)
  }

  const resetBaseline: InlineMediaDeletionTracker['resetBaseline'] = () => {
    prevIds = new Set()
    lastIds = new Set()
  }

  const dispose: InlineMediaDeletionTracker['dispose'] = () => {
    eventTarget.removeEventListener(ENTRY_DOC_SAVED_EVENT, onSaved)
    eventTarget.removeEventListener(ENTRY_DOC_DETACHED_EVENT, onDetached)
  }

  return { observe, resetBaseline, cancelPending, dispose }
}
