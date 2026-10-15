/**
 * safeUpload: the only write path (Phase 15.4).
 *
 * `safeUpload.ts` is the ONLY importer of `DriveWriter`, other than `onboard.ts`. The push session
 * (`push.ts`) gets its writer from `createOutboxWriter` and creates the outbox folder only through
 * `safeEnsureOutboxFolder`, which runs checks 1-4 below first.
 * Each batch runs inside the `navigator.locks` single-writer lock, and checks in order:
 *  1. a FRESH `fetchWriteFlag()` (fail-closed);
 *  2. `assertClockOk()`;
 *  3. the fence (`assertRecoveryFence`);
 *  4. the format guard (`assertFormatGuardOk`);
 *  5. every target path matches the outbox allowlist (`generations/g-<localGen>/<webId>/outbox/…`);
 *  6. seal-then-verify: re-open the sealed bytes with WASM (`openOutboxEntry` / `openMedia`, and
 *     `openOutboxIntent` for a v2 / v3 intent) and require an exact match with the intended content
 *     and frame (a pre-upgrade frame-2 draft uploads as frame 2, a new draft as frame 3). An intent
 *     must also sit under the name of its letter and target id (`<letter>-<id>.bin`, README "File
 *     naming"), which the desktop importer checks too (a mismatch there is a final `corrupt`); the
 *     id is a safe id, except the fixed `d-empty-trash` / `q-user-persona` of their own kind. A
 *     failure is a `SealVerifyError`, so a caller can skip that one batch; every other refusal
 *     concerns the whole vault;
 *  7. the caller's optional `beforeWrite` freshness check (still under the lock): `false` is a
 *     `StaleWriteError`, so the caller can skip that one batch, nothing written.
 *
 * Only then does it write each intent through the lock-scoped `put` handed to the batch by
 * `DriveWriter.withLock` (update-in-place).
 */

import {
  openOutboxIntent,
  type Core,
  type OutboxIntentV2,
  type OutboxIntentV3,
} from '../../core/core'
import type { KeyRing } from '../keys'
import { assertClockOk } from '../clock'
import { fetchWriteFlag } from '../config'
import {
  DriveWriter,
  type DriveReader,
  type DriveWriterDeps,
  type EnsureFolderResult,
  type LockManagerLike,
  type PutResult,
  type WriterIdentity,
} from '../drive/client'
import {
  ENTRY_STEM_SOURCE,
  INTENT_STEM_SOURCE,
  UUID_SOURCE,
  isIntentTargetId,
  isValidGeneration,
  isValidOwnId,
  outboxIntentPath,
  type OutboxIntentPrefix,
} from '../drive/paths'
import { sameBytes, type DraftKind } from '../storage/idb'
import { assertRecoveryFence, type ExpectedVaultState } from './fence'
import { assertFormatGuardOk } from './formatGuard'
import { v3IntentTarget } from './outbox'

/** Seal-then-verify (check 6) refused this batch: its bytes do not round-trip. */
export class SealVerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealVerifyError'
  }
}

/** The caller's `beforeWrite` (check 7) refused this batch: its source changed. Nothing written. */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleWriteError'
  }
}

export interface SafeUploadIntent {
  path: string
  bytes: Uint8Array
  intended:
    | { kind: 'entry'; entry: unknown }
    | { kind: 'media'; plaintext: Uint8Array }
    | { kind: 'thumb'; plaintext: Uint8Array }
    | { kind: 'intent_v2'; intent: OutboxIntentV2 }
    | { kind: 'intent_v3'; intent: OutboxIntentV3 }
}

/** A non-entry outbox intent of either frame: v2 (pre-upgrade drafts) or v3. */
export type NonEntryIntent = OutboxIntentV2 | OutboxIntentV3

/** An opened non-entry intent with its frame version. */
export type OpenedNonEntryIntent =
  | { version: 2; intent: OutboxIntentV2 }
  | { version: 3; intent: OutboxIntentV3 }

/**
 * File-name letter and target id of a v2 / v3 intent (memlore-core `prefix` / `target_id`,
 * README "File naming"): the draft key and the file stem. One file per target: a journal's create,
 * rename and delete share `j-<journalId>`, an entry's trash, restore and purge share `d-<entryId>`.
 */
export function intentTarget(intent: NonEntryIntent): { prefix: OutboxIntentPrefix; id: string } {
  switch (intent.kind) {
    case 'create_journal':
      return { prefix: 'j', id: intent.journal_id }
    case 'create_tag':
      return { prefix: 't', id: intent.tag_id }
    default:
      return v3IntentTarget(intent)
  }
}

/**
 * The draft kind that stores this intent (`DraftRecord.kind`). A reader that opens a draft's body
 * checks its stored kind against this, so a mis-kinded record is never routed as another kind.
 */
export function draftKindOfIntent(intent: NonEntryIntent): Exclude<DraftKind, 'entry'> {
  switch (intent.kind) {
    case 'create_journal':
    case 'upsert_journal':
    case 'delete_journal':
      return 'journal'
    case 'create_tag':
    case 'upsert_tag':
    case 'delete_tag':
      return 'tag'
    case 'upsert_template':
    case 'delete_template':
      return 'template'
    case 'trash_entry':
      return 'trash'
    case 'restore_entry':
      return 'restore'
    case 'purge_entry':
      return 'purge'
    case 'empty_trash':
      return 'empty_trash'
    case 'set_entry_location':
      return 'location'
    case 'attach_media':
    case 'delete_media':
      return 'media'
    case 'set_media_insertion_mode':
      return 'insertion_mode'
    case 'delete_memory_item':
      return 'memory'
    case 'update_persona':
      return 'persona'
  }
}

/** Opens sealed non-entry intent bytes, frame 2 or 3 (a v1 entry frame throws). */
export function openIntentBody(
  core: Pick<Core, 'openOutboxIntent'>,
  ring: KeyRing,
  bytes: Uint8Array,
): OpenedNonEntryIntent {
  const opened = openOutboxIntent(core, ring, bytes)
  if (opened.version === 1) throw new SealVerifyError('not a v2 / v3 intent (frame 1)')
  return opened
}

/** The body of sealed v2 / v3 intent bytes (frames 2 and 3; a v1 entry frame throws). */
export function openV2Intent(
  core: Pick<Core, 'openOutboxIntent'>,
  ring: KeyRing,
  bytes: Uint8Array,
): NonEntryIntent {
  return openIntentBody(core, ring, bytes).intent
}

export interface SafeUploadDeps {
  writer: DriveWriter
  reader: DriveReader
  core: Core
  ring: KeyRing
  localGen: number
  ownDeviceId: string
  expectedFence: ExpectedVaultState
  fetchWriteFlagImpl?: () => Promise<boolean>
  locks?: LockManagerLike | null
  revalidatePull?: () => Promise<void> | void
  /**
   * Check 7, run under the lock after checks 1-6 and before the first write: is the source of
   * these intents still current? `false` aborts with `StaleWriteError`.
   */
  beforeWrite?: () => Promise<boolean>
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.hasOwn(bRecord, k) || !deepEqual(aRecord[k], bRecord[k])) {
      return false
    }
  }
  return true
}

/**
 * Check 5's allowlist: `<entryId>.bin` (entry, a safe id not shaped `<letter>-…`), the intent
 * stems of README "Web path grammar" (`<letter>-<safe id>.bin`, `d-empty-trash.bin`,
 * `q-user-persona.bin`), `m-<uuid>` and `m-<uuid>.thumb` in the flat own outbox of `localGen`. Built from the same sources as
 * `isOwnOutboxPath` in `drive/paths.ts` (the writer's own check), so the two agree.
 */
export function isOutboxIntentPath(path: string, localGen: number, ownId: string): boolean {
  if (!isValidGeneration(localGen) || !isValidOwnId(ownId)) return false
  const outboxPattern = new RegExp(
    `^generations/g-${localGen}/${ownId}/outbox/(?:(?:${INTENT_STEM_SOURCE}|${ENTRY_STEM_SOURCE})\\.bin|m-${UUID_SOURCE}(?:\\.thumb)?)$`,
  )
  return outboxPattern.test(path)
}

/** Check 6 for a v2 / v3 intent: the bytes open to exactly `expected`, under its own file name. */
function verifyIntent(
  path: string,
  bytes: Uint8Array,
  expected: OpenedNonEntryIntent,
  deps: SafeUploadDeps,
): void {
  const what = `v${expected.version} intent at ${path}`
  let opened: OpenedNonEntryIntent
  try {
    opened = openIntentBody(deps.core, deps.ring, bytes)
  } catch (err: unknown) {
    throw new SealVerifyError(
      `Seal-then-verify failed to open ${what}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (opened.version !== expected.version) {
    throw new SealVerifyError(`Seal-then-verify: frame ${opened.version} bytes for ${what}`)
  }
  if (!deepEqual(opened.intent, expected.intent)) {
    throw new SealVerifyError(`Seal-then-verify payload mismatch for ${what}`)
  }
  const { prefix, id } = intentTarget(opened.intent)
  // The fixed stems belong to their one singleton kind; every other kind targets a safe id.
  const singleton = opened.intent.kind === 'empty_trash' || opened.intent.kind === 'update_persona'
  let named: string
  try {
    if (!singleton && !isIntentTargetId(id)) throw new RangeError('not a target id')
    named = outboxIntentPath(deps.ownDeviceId, deps.localGen, prefix, id)
  } catch {
    throw new SealVerifyError(`Seal-then-verify: intent id is not a target id at ${path}`)
  }
  if (path !== named) {
    throw new SealVerifyError(`Seal-then-verify: intent name does not match its body at ${path}`)
  }
}

/** A writer for the outbox of `identity` (the push session's only way to get one). */
export function createOutboxWriter(
  reader: DriveReader,
  deps: DriveWriterDeps,
  identity: WriterIdentity,
): DriveWriter {
  const writer = new DriveWriter(reader, deps)
  writer.setIdentity(identity)
  return writer
}

/** Checks 1-4: write flag, clock, fence, format guard. The caller holds the writer lock. */
async function assertBatchAllowed(deps: SafeUploadDeps): Promise<void> {
  // 1. Fresh fetchWriteFlag (fail-closed)
  const fetchFlag = deps.fetchWriteFlagImpl ?? fetchWriteFlag
  const writeAllowed = await fetchFlag()
  if (!writeAllowed) {
    throw new Error('Writes disabled: write flag is false')
  }

  // 2. assertClockOk
  assertClockOk()

  // 3. The recovery fence (also contacts server and updates clock offset)
  await assertRecoveryFence({
    reader: deps.reader,
    core: deps.core,
    expected: deps.expectedFence,
    revalidatePull: deps.revalidatePull,
  })

  // Re-assert clock now that server Date header was sampled during fence read
  assertClockOk()

  // 4. The format guard
  assertFormatGuardOk()
}

/**
 * Creates `<ownId>` and `<ownId>/outbox` (the only folders the web may create) under the writer
 * lock, after the same checks 1-4 as an upload batch: a folder is a write too.
 */
export async function safeEnsureOutboxFolder(deps: SafeUploadDeps): Promise<EnsureFolderResult> {
  return deps.writer.withLock(async (locked) => {
    await assertBatchAllowed(deps)
    return locked.ensureFolder()
  }, deps.locks)
}

export async function safeUpload(
  intents: readonly SafeUploadIntent[],
  deps: SafeUploadDeps,
): Promise<PutResult[]> {
  return deps.writer.withLock(async (locked) => {
    // 1-4. Write flag, clock, fence, format guard
    await assertBatchAllowed(deps)

    // 5. Every target path matches the outbox allowlist
    for (const intent of intents) {
      if (!isOutboxIntentPath(intent.path, deps.localGen, deps.ownDeviceId)) {
        throw new Error(
          `Target path does not match outbox allowlist: ${intent.path} (localGen=${deps.localGen}, ownDeviceId=${deps.ownDeviceId})`,
        )
      }
    }

    // 6. Seal-then-verify: re-open sealed bytes and require exact match
    for (const intent of intents) {
      if (intent.intended.kind === 'entry') {
        let openedJson: string
        try {
          openedJson = deps.core.openOutboxEntry(deps.ring, intent.bytes)
        } catch (err: unknown) {
          throw new SealVerifyError(
            `Seal-then-verify failed to open entry at ${intent.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const opened = JSON.parse(openedJson)
        const expected =
          typeof intent.intended.entry === 'string'
            ? JSON.parse(intent.intended.entry)
            : intent.intended.entry
        if (!deepEqual(opened, expected)) {
          throw new SealVerifyError(`Seal-then-verify payload mismatch for entry at ${intent.path}`)
        }
      } else if (intent.intended.kind === 'intent_v2') {
        verifyIntent(
          intent.path,
          intent.bytes,
          { version: 2, intent: intent.intended.intent },
          deps,
        )
      } else if (intent.intended.kind === 'intent_v3') {
        verifyIntent(
          intent.path,
          intent.bytes,
          { version: 3, intent: intent.intended.intent },
          deps,
        )
      } else {
        let openedBytes: Uint8Array
        try {
          openedBytes = deps.core.openMedia(deps.ring, intent.bytes)
        } catch (err: unknown) {
          throw new SealVerifyError(
            `Seal-then-verify failed to open media at ${intent.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const expected = intent.intended.plaintext
        if (!sameBytes(openedBytes, expected)) {
          throw new SealVerifyError(
            `Seal-then-verify plaintext mismatch for media at ${intent.path}`,
          )
        }
      }
    }

    // 7. The caller's freshness check, under the same lock as the writes
    if (deps.beforeWrite !== undefined && !(await deps.beforeWrite())) {
      throw new StaleWriteError('The source of this batch changed before it was written')
    }

    // All 7 checks passed: perform mutating writes in place through the lock-scoped handle (it
    // does not re-acquire the lock this batch holds, and re-runs the writer's own path checks).
    const results: PutResult[] = []
    for (const intent of intents) {
      const result = await locked.put(intent.path, intent.bytes)
      results.push(result)
    }
    return results
  }, deps.locks)
}
