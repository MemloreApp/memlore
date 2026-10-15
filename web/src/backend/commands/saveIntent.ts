/**
 * The single seal-and-save path of every outbox v3 write (web gap audit Phases 10–14). Its own
 * module so `entries.ts` can use it without importing `taxonomy.ts` (which imports `entries.ts`);
 * `taxonomy.ts` re-exports it.
 */

import { sealOutboxIntentV3, type OutboxIntentV3 } from '../../core/core'
import { createDraftManager } from '../drafts'
import { getKeyRing } from '../keys'
import { v3IntentTarget } from '../sync/outbox'
import { draftKindOfIntent } from '../sync/safeUpload'
import type { openForWrite } from './readSession'

type WriteSession = Awaited<ReturnType<typeof openForWrite>>

/**
 * The entry an `a-` / `i-` draft acts on: its key holds the media id, so the record carries the
 * entry for the push hold (README "Web push order"). Undefined for every other kind (`d-` / `l-`
 * keys already name their entry).
 */
function targetEntryIdOf(intent: OutboxIntentV3): string | undefined {
  switch (intent.kind) {
    case 'attach_media':
    case 'delete_media':
    case 'set_media_insertion_mode':
      return intent.entry_id
    default:
      return undefined
  }
}

/**
 * Seals frame 3, stores the draft under the intent's letter-id stem (`j-<id>`, `d-<entryId>`,
 * `d-empty-trash`, …; README "File naming") with the draft kind its body implies (and, for an
 * `a-` / `i-` draft, its `targetEntryId`), then re-reads
 * the pending overlay so every view shows it. One file per target: a later intent on the same
 * target replaces the stored one. Call it under the outbox lock.
 */
export async function saveIntent(
  w: Pick<WriteSession, 'core' | 'db' | 'refreshPendingV2'>,
  intent: OutboxIntentV3,
): Promise<void> {
  const sealed = sealOutboxIntentV3(w.core, getKeyRing(), intent)
  const { prefix, id } = v3IntentTarget(intent)
  await createDraftManager({ db: w.db }).saveDraft(
    `${prefix}-${id}`,
    sealed,
    draftKindOfIntent(intent),
    targetEntryIdOf(intent),
  )
  await w.refreshPendingV2()
}
