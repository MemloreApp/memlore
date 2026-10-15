import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInlineMediaDeletionTracker,
  detachMustAwaitSave,
  emitEntryDocDetached,
  emitEntryDocSaved,
  ENTRY_DOC_DETACHED_EVENT,
  ENTRY_DOC_SAVED_EVENT,
  type InlineMediaDeletionTracker,
} from './inlineMediaDeletionTracker'

function ids(...v: string[]): Set<string> {
  return new Set(v)
}

/** The editor leaves the entry; `awaitSave` = a save of its final doc is still owed. */
function detach(entryId: string, finalIds: Set<string>, awaitSave = false): void {
  emitEntryDocDetached(entryId, finalIds, awaitSave)
}

describe('createInlineMediaDeletionTracker', () => {
  let deleteMedia: ReturnType<typeof vi.fn>
  let onDeleted: ReturnType<typeof vi.fn>
  let tracker: InlineMediaDeletionTracker

  beforeEach(() => {
    deleteMedia = vi.fn().mockResolvedValue(undefined)
    onDeleted = vi.fn()
    tracker = createInlineMediaDeletionTracker({
      deleteMedia: deleteMedia as unknown as (id: string) => Promise<void>,
      onDeleted: onDeleted as unknown as () => void,
    })
  })

  afterEach(() => {
    tracker.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not delete on a save alone (waits for the editor to detach)', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('undo after save before detach keeps the media', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    tracker.observe('e1', ids('a'))
    emitEntryDocSaved('e1')
    detach('e1', ids('a'))
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('deletes on detach when the node is still gone after the save', async () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    detach('e1', ids())
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
    await Promise.resolve()
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('never deletes an id the final doc still shows', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids('a'))
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('never deletes an id the last persisted doc still shows, even with no edit marked unsaved', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    // A pure delete never marked as an edit (or a save in flight): the stored doc still shows `a`.
    detach('e1', ids(), detachMustAwaitSave(false, ids('a'), ids()))
    expect(deleteMedia).not.toHaveBeenCalled()
    emitEntryDocSaved('e1')
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('detach with a save still owed waits for that save', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids(), true)
    expect(deleteMedia).not.toHaveBeenCalled()
    emitEntryDocSaved('e1')
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('keeps the media when the owed save never lands and the entry is reopened', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids(), true)
    // Save failed: no saved event. The entry is reopened from the stored doc
    // (which still shows the node) and saved again.
    tracker.resetBaseline()
    tracker.observe('e1', ids('a'))
    emitEntryDocSaved('e1')
    detach('e1', ids('a'))
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('re-attaching cancels an owed-save drain', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids(), true)
    tracker.resetBaseline()
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    expect(deleteMedia).not.toHaveBeenCalled()
    detach('e1', ids())
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('deletes only ids pending for the detached entry, and only once', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    tracker.resetBaseline()
    tracker.observe('e2', ids('b'))
    tracker.observe('e2', ids())
    detach('e1', ids())
    detach('e1', ids())
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('never deletes a media that was never in the doc (save-bug orphan)', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids('a'))
    detach('e1', ids('a'))
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('cancelPending stops a scheduled deletion', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    tracker.cancelPending('a')
    detach('e1', ids())
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('resetBaseline prevents a new/empty doc from deleting the old entry media', () => {
    tracker.observe('e1', ids('a'))
    tracker.resetBaseline()
    tracker.observe('e2', ids())
    detach('e1', ids('a'))
    detach('e2', ids())
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('swallows a "not found" rejection without logging (benign double-delete)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValueOnce('Media not found: a')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids())
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })

  it('retries a transient failure and succeeds on the retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValueOnce('database is locked')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids())
    await Promise.resolve()
    await Promise.resolve()
    expect(deleteMedia).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(2)
    expect(onDeleted).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('gives up after maxRetries and stops calling deleteMedia', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValue('database is locked')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids())
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('cancels a re-inserted node during the retry window', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValueOnce('database is locked')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids())
    await Promise.resolve()
    await Promise.resolve()
    tracker.observe('e1', ids('a'))
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('ignores a saved or detached event with no entryId', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    detach('e1', ids(), true)
    window.dispatchEvent(new CustomEvent(ENTRY_DOC_SAVED_EVENT, { detail: {} }))
    window.dispatchEvent(new CustomEvent(ENTRY_DOC_DETACHED_EVENT, { detail: {} }))
    expect(deleteMedia).not.toHaveBeenCalled()
  })
})

describe('detachMustAwaitSave', () => {
  it.each([
    { saveOwed: false, persisted: ids('a'), final: ids('a', 'b'), expected: false },
    { saveOwed: false, persisted: ids(), final: ids(), expected: false },
    { saveOwed: false, persisted: ids('a', 'b'), final: ids('a'), expected: true },
    { saveOwed: true, persisted: ids('a'), final: ids('a'), expected: true },
  ])(
    'saveOwed=$saveOwed persisted=$persisted final=$final -> $expected',
    ({ saveOwed, persisted, final, expected }) => {
      expect(detachMustAwaitSave(saveOwed, persisted, final)).toBe(expected)
    },
  )
})
