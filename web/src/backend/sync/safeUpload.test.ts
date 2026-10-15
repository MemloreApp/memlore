import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadCore,
  sealOutboxIntentV2,
  sealOutboxIntentV3,
  type Core,
  type OutboxIntentV2,
  type OutboxIntentV3,
} from '../../core/core'
import type { KeyRing } from '../keys'
import { ClockSkewError, resetClock, updateClockOffset } from '../clock'
import {
  DriveReader,
  DriveWriter,
  LockUnavailableError,
  type DriveWriterDeps,
  type LockManagerLike,
} from '../drive/client'
import {
  FakeDrive,
  fakeLocks,
  fixtureBytes,
  loadDesktopFixture,
  seedFromFixture,
} from '../drive/fakeDrive'
import {
  ROOT_FOLDER_NAME,
  isOwnOutboxPath,
  outboxEntryPath,
  outboxIntentPath,
  outboxMediaPath,
} from '../drive/paths'
import { resumeWrites } from './fence'
import { latchFormatGuard, resetFormatGuardLatch } from './formatGuard'
import {
  SealVerifyError,
  StaleWriteError,
  isOutboxIntentPath,
  safeUpload,
  type SafeUploadIntent,
  type SafeUploadDeps,
} from './safeUpload'

const WEB_DEVICE_ID = '00000000-0000-0000-0000-000000000002'
const DESKTOP_DEVICE_ID = '00000000-0000-0000-0000-000000000001'

describe('safeUpload: the only write path', () => {
  let core: Core
  let ring: KeyRing
  let drive: FakeDrive
  let reader: DriveReader
  let writer: DriveWriter
  let lockManager: LockManagerLike
  let writeFlag: boolean

  const localGen = 0

  beforeEach(async () => {
    resetClock()
    resumeWrites()
    resetFormatGuardLatch()
    writeFlag = true

    core = await loadCore()

    // Build a mock lock manager that enforces non-reentrancy
    let lockHeld = false
    lockManager = {
      request: vi.fn(async (_name, cb) => {
        if (lockHeld) {
          throw new Error('Lock deadlock: non-reentrant lock requested while already held')
        }
        lockHeld = true
        try {
          return await cb()
        } finally {
          lockHeld = false
        }
      }),
    }

    const fixture = loadDesktopFixture()
    const metaJson = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_meta.json')),
    ) as { master_fingerprint: string }
    const recoveryJson = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_recovery.json')),
    ) as { wrapped_master: string }
    const contentList = new TextDecoder().decode(
      fixtureBytes(fixture, '.meta/keyring/_content.json'),
    )

    drive = new FakeDrive()
    seedFromFixture(drive, fixture)
    drive.chain(ROOT_FOLDER_NAME, 'generations', 'g-0', WEB_DEVICE_ID, 'outbox')

    ring = core.KeyRing.fromRecovery(
      fixture.recovery_phrase,
      recoveryJson.wrapped_master,
      metaJson.master_fingerprint,
    )
    ring.loadContentList(contentList)

    reader = new DriveReader({
      getToken: async () => 'test-token',
      fetchImpl: drive.fetch,
    })

    const writerDeps: DriveWriterDeps = {
      getToken: async () => 'test-token',
      fetchImpl: drive.fetch,
      locks: lockManager,
    }
    writer = new DriveWriter(reader, writerDeps)
    writer.setIdentity({ ownId: WEB_DEVICE_ID, localGen })
  })

  function makeDeps(overrides: Partial<SafeUploadDeps> = {}): SafeUploadDeps {
    const fixture = loadDesktopFixture()
    const metaJson = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_meta.json')),
    ) as { master_fingerprint: string }
    return {
      writer,
      reader,
      core,
      ring,
      localGen,
      ownDeviceId: WEB_DEVICE_ID,
      expectedFence: {
        recoveryGeneration: 0,
        masterFingerprint: metaJson.master_fingerprint,
        epoch: 1,
        contentEpoch: 1,
      },
      fetchWriteFlagImpl: async () => writeFlag,
      locks: lockManager,
      ...overrides,
    }
  }

  it('uploads a verified outbox entry and media intent under writer lock', async () => {
    const entryId = '00000000-0000-0000-0000-000000000010'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [1, 2, 3],
      content_text: 'Hello world',
      preview_text: 'Hello',
      fields: {
        title: {
          value: 'Hello',
          base: '',
          base_updated_at: 0,
          change_seq: 1,
          changed_at_secs: 1700000000,
        },
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    }

    const entryBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const entryPath = outboxEntryPath(WEB_DEVICE_ID, localGen, entryId)

    const mediaId = '00000000-0000-0000-0000-000000000020'
    const mediaPlain = new Uint8Array([10, 20, 30, 40])
    const mediaBytes = core.sealOutboxMedia(ring, mediaPlain)
    const mediaPath = outboxMediaPath(WEB_DEVICE_ID, localGen, mediaId, false)

    const intents: SafeUploadIntent[] = [
      {
        path: entryPath,
        bytes: entryBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
      {
        path: mediaPath,
        bytes: mediaBytes,
        intended: { kind: 'media', plaintext: mediaPlain },
      },
    ]

    const results = await safeUpload(intents, makeDeps())
    expect(results).toHaveLength(2)
    expect(lockManager.request).toHaveBeenCalled()

    // Verify mutating calls reached the fake drive
    const putCalls = drive.mutating()
    expect(putCalls.length).toBeGreaterThanOrEqual(2)
  })

  describe('v2 intents (seal-then-verify with openOutboxIntent)', () => {
    const JOURNAL_ID = '00000000-0000-4000-8000-000000000030'
    const journal = (): OutboxIntentV2 => ({
      kind: 'create_journal',
      web_device_id: WEB_DEVICE_ID,
      web_updated_at_secs: 1_700_000_000,
      journal_id: JOURNAL_ID,
      name: 'Travel',
      color: '#aabbcc',
      auto_tag_ids: [],
    })
    const v2 = (path: string, bytes: Uint8Array, intent: OutboxIntentV2): SafeUploadIntent => ({
      path,
      bytes,
      intended: { kind: 'intent_v2', intent },
    })
    const journalPath = () => outboxIntentPath(WEB_DEVICE_ID, localGen, 'j', JOURNAL_ID)
    const upsertJournal = (): OutboxIntentV3 => ({
      kind: 'upsert_journal',
      web_device_id: WEB_DEVICE_ID,
      web_updated_at_secs: 1_700_000_000,
      journal_id: JOURNAL_ID,
      name: 'Travel',
      color: '#aabbcc',
      auto_tag_ids: [],
      base_updated_at: 100,
    })
    const emptyTrash = (): OutboxIntentV3 => ({
      kind: 'empty_trash',
      web_device_id: WEB_DEVICE_ID,
      web_updated_at_secs: 1_700_000_000,
      items: [{ entry_id: JOURNAL_ID, base_updated_at: 100 }],
    })

    it('uploads a verified v2 intent under its prefixed name', async () => {
      const bytes = sealOutboxIntentV2(core, ring, journal())

      await safeUpload([v2(journalPath(), bytes, journal())], makeDeps())

      const file = drive.find([
        ROOT_FOLDER_NAME,
        'generations',
        'g-0',
        WEB_DEVICE_ID,
        'outbox',
        `j-${JOURNAL_ID}.bin`,
      ])
      expect(file?.content).toEqual(bytes)
    })

    // Pre-upgrade frame-2 drafts stay in IndexedDB and upload as-is; new drafts are frame 3.
    it.each<[string, () => SafeUploadIntent, string]>([
      [
        'a pre-upgrade frame-2 draft',
        () => v2(journalPath(), sealOutboxIntentV2(core, ring, journal()), journal()),
        `j-${JOURNAL_ID}.bin`,
      ],
      [
        'a frame-3 draft',
        () => ({
          path: journalPath(),
          bytes: sealOutboxIntentV3(core, ring, upsertJournal()),
          intended: { kind: 'intent_v3', intent: upsertJournal() },
        }),
        `j-${JOURNAL_ID}.bin`,
      ],
      [
        'a frame-3 singleton (d-empty-trash)',
        () => ({
          path: outboxIntentPath(WEB_DEVICE_ID, localGen, 'd', 'empty-trash'),
          bytes: sealOutboxIntentV3(core, ring, emptyTrash()),
          intended: { kind: 'intent_v3', intent: emptyTrash() },
        }),
        'd-empty-trash.bin',
      ],
    ])('passes seal-verify and uploads %s', async (_name, build, name) => {
      const intent = build()
      await safeUpload([intent], makeDeps())
      const file = drive.find([
        ROOT_FOLDER_NAME,
        'generations',
        'g-0',
        WEB_DEVICE_ID,
        'outbox',
        name,
      ])
      expect(file?.content).toEqual(intent.bytes)
    })

    it('refuses bytes of another frame than the intended one', async () => {
      // Same body, other frame: the desktop decodes and ranks them differently.
      const template = {
        kind: 'upsert_template',
        web_device_id: WEB_DEVICE_ID,
        web_updated_at_secs: 1_700_000_000,
        template_id: JOURNAL_ID,
        name: 'Daily',
        description: null,
        content_b64: null,
        sort_order: 0,
        base_updated_at: null,
      } as const
      const path = outboxIntentPath(WEB_DEVICE_ID, localGen, 'p', JOURNAL_ID)
      const cases: SafeUploadIntent[] = [
        {
          path,
          bytes: sealOutboxIntentV2(core, ring, template),
          intended: { kind: 'intent_v3', intent: template },
        },
        {
          path,
          bytes: sealOutboxIntentV3(core, ring, template),
          intended: { kind: 'intent_v2', intent: template },
        },
      ]
      for (const intent of cases) {
        await expect(safeUpload([intent], makeDeps())).rejects.toBeInstanceOf(SealVerifyError)
      }
      expect(drive.mutating()).toEqual([])
    })

    it('refuses a v2 body that differs from the intended intent, or a v1 frame', async () => {
      const other = { ...journal(), name: 'Work' }
      const entryBytes = core.sealOutboxEntry(
        ring,
        JSON.stringify({
          schema_version: 1,
          entry_id: JOURNAL_ID,
          web_device_id: WEB_DEVICE_ID,
          created_on_web: true,
          web_updated_at_secs: 1700000000,
          base_state_vector: [],
          yjs_full_state: [],
          content_text: null,
          preview_text: null,
          fields: {
            title: null,
            entry_date: null,
            emotion: null,
            is_favorite: null,
            journal_id: null,
            tags_add: {},
            tags_remove: {},
          },
          media: [],
        }),
      )
      const cases: Array<[Uint8Array, RegExp]> = [
        [sealOutboxIntentV2(core, ring, other), /payload mismatch for v2 intent/],
        [entryBytes, /failed to open v2 intent/],
      ]
      for (const [bytes, message] of cases) {
        const upload = safeUpload([v2(journalPath(), bytes, journal())], makeDeps())
        await expect(upload).rejects.toBeInstanceOf(SealVerifyError)
        await expect(upload).rejects.toThrow(message)
      }
      expect(drive.mutating()).toEqual([])
    })

    it('refuses a v2 intent whose file name does not match its kind and id (desktop: corrupt)', async () => {
      const bytes = sealOutboxIntentV2(core, ring, journal())
      const otherId = '00000000-0000-4000-8000-000000000031'
      for (const path of [
        outboxIntentPath(WEB_DEVICE_ID, localGen, 't', JOURNAL_ID),
        outboxIntentPath(WEB_DEVICE_ID, localGen, 'j', otherId),
        outboxEntryPath(WEB_DEVICE_ID, localGen, JOURNAL_ID),
      ]) {
        const upload = safeUpload([v2(path, bytes, journal())], makeDeps())
        await expect(upload, path).rejects.toBeInstanceOf(SealVerifyError)
        await expect(upload, path).rejects.toThrow(/name does not match its body/)
      }
      expect(drive.mutating()).toEqual([])
    })

    it('refuses a fixed stem (d-empty-trash) for any kind but its singleton', async () => {
      // A core that opens whatever body it is handed, so only safeUpload's own check stands.
      const trash: OutboxIntentV3 = {
        kind: 'trash_entry',
        web_device_id: WEB_DEVICE_ID,
        web_updated_at_secs: 1_700_000_000,
        entry_id: 'empty-trash',
        base_updated_at: 100,
      }
      const lenient = {
        ...core,
        openOutboxIntent: () => ({
          version: 3,
          json: JSON.stringify(trash),
          free: () => undefined,
        }),
      } as unknown as Core
      const upload = safeUpload(
        [
          {
            path: outboxIntentPath(WEB_DEVICE_ID, localGen, 'd', 'empty-trash'),
            bytes: new Uint8Array([3]),
            intended: { kind: 'intent_v3', intent: trash },
          },
        ],
        makeDeps({ core: lenient }),
      )
      await expect(upload).rejects.toBeInstanceOf(SealVerifyError)
      await expect(upload).rejects.toThrow(/not a target id/)
      expect(drive.mutating()).toEqual([])
    })
  })

  it('rejects upload when seal-then-verify detects a 1-bit corruption in entry bytes', async () => {
    const entryId = '00000000-0000-0000-0000-000000000011'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Safe text',
      preview_text: 'Safe',
      fields: {
        title: null,
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    }

    const validBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const corruptBytes = new Uint8Array(validBytes)
    corruptBytes[validBytes.length - 1] ^= 0x01 // flip 1 bit in tag

    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: corruptBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
    ]

    const mutatingBefore = drive.mutating().length
    const upload = safeUpload(intents, makeDeps())
    await expect(upload).rejects.toThrow(/seal.*verify/i)
    await expect(upload).rejects.toBeInstanceOf(SealVerifyError)
    expect(drive.mutating().length).toBe(mutatingBefore)
  })

  function entryIntent(entryId: string): SafeUploadIntent {
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Text',
      preview_text: 'Text',
      fields: {
        title: null,
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    }
    return {
      path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
      bytes: core.sealOutboxEntry(ring, JSON.stringify(entryObj)),
      intended: { kind: 'entry', entry: entryObj },
    }
  }

  it('writes nothing and throws StaleWriteError when beforeWrite returns false', async () => {
    const intent = entryIntent('00000000-0000-0000-0000-000000000013')
    const beforeWrite = vi.fn(async () => false)

    const upload = safeUpload([intent], makeDeps({ beforeWrite }))

    await expect(upload).rejects.toBeInstanceOf(StaleWriteError)
    expect(beforeWrite).toHaveBeenCalledTimes(1)
    expect(drive.mutating()).toEqual([])
  })

  it('runs beforeWrite under the lock, after every other check, right before the writes', async () => {
    const intent = entryIntent('00000000-0000-0000-0000-000000000014')
    const order: string[] = []
    const serial = fakeLocks(drive)
    const beforeWrite = vi.fn(async () => {
      order.push(`check@${drive.mutating().length}:${serial.events.join(',')}`)
      return true
    })

    // Refused by an earlier check: never asked.
    writeFlag = false
    await expect(safeUpload([intent], makeDeps({ beforeWrite, locks: serial }))).rejects.toThrow()
    const corrupt = { ...intent, bytes: new Uint8Array(intent.bytes) }
    corrupt.bytes[corrupt.bytes.length - 1] ^= 0x01
    writeFlag = true
    await expect(
      safeUpload([corrupt], makeDeps({ beforeWrite, locks: serial })),
    ).rejects.toBeInstanceOf(SealVerifyError)
    expect(beforeWrite).not.toHaveBeenCalled()

    serial.events.length = 0
    await safeUpload([intent], makeDeps({ beforeWrite, locks: serial }))

    expect(order).toEqual([`check@0:${serial.events[0]}`])
    expect(serial.events[0]).toMatch(/^enter@/)
    expect(drive.mutating().length).toBeGreaterThan(0)
  })

  it('stops the second batch when write flag flips OFF between batches', async () => {
    const entryId = '00000000-0000-0000-0000-000000000012'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Text',
      preview_text: 'Text',
      fields: {
        title: null,
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    }
    const entryBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: entryBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
    ]

    // Batch 1 succeeds
    await expect(safeUpload(intents, makeDeps())).resolves.toBeDefined()

    // Flip flag off
    writeFlag = false

    // Batch 2 must fail closed
    const mutatingCount = drive.mutating().length
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/writes disabled/i)
    expect(drive.mutating().length).toBe(mutatingCount)
  })

  it('blocks upload when browser clock is skewed > 120s', async () => {
    const entryId = '00000000-0000-0000-0000-000000000013'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Clock test',
      preview_text: 'Clock',
      fields: {
        title: null,
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    }
    const entryBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: entryBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
    ]

    // Simulate clock skew: 150 seconds skew
    const clientNow = 1775000000000
    updateClockOffset(new Date(clientNow + 150000).toUTCString(), clientNow)

    const mutatingCount = drive.mutating().length
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(ClockSkewError)
    expect(drive.mutating().length).toBe(mutatingCount)
  })

  // README "Web path grammar". Check 5 and the writer's own allowlist (`isOwnOutboxPath`) share
  // `INTENT_STEM_SOURCE`, so they must agree on every name.
  it('accepts the web path grammar and agrees with the writer allowlist', () => {
    const outbox = `generations/g-0/${WEB_DEVICE_ID}/outbox`
    const id = 'abcdef00-0000-4000-8000-00000000001f'
    // Desktop-minted ids are any safe id (memlore-core `is_safe_id`), e.g. a Day One import.
    const dayOne = '0123456789ABCDEF0123456789ABCDEF'
    const allowed = [
      ...[id, dayOne, id.toUpperCase(), `jj-${id}`, 'a_b-c_d0'].map((e) => `${e}.bin`),
      `m-${id}`,
      `m-${id}.thumb`,
      ...'jtpdlaiyq'.split('').flatMap((p) => [`${p}-${id}.bin`, `${p}-${dayOne}.bin`]),
      `t-tag-0001.bin`,
      'd-empty-trash.bin',
      'q-user-persona.bin',
    ]
    const refused = [
      `m-${id}.bin`, // `m-` is the media blob, never an intent
      `x-${id}.bin`, // an entry id never looks like a letter stem (desktop: corrupt)
      `x-${dayOne}.bin`,
      `m-${dayOne}`, // media blobs are web-minted: uuid only
      `m-${id.toUpperCase()}`,
      `j-${id}.thumb`,
      'abcdefg.bin', // shorter than a safe id
      'j-abcdefg.bin',
      `${'a'.repeat(129)}.bin`,
      'abc.defgh.bin',
      'd-empty-trash',
      'q-empty-trash.bin',
      'd-user-persona.bin',
      'x/../y',
      `../outbox/j-${id}.bin`,
    ]
    for (const [names, expected] of [
      [allowed, true],
      [refused, false],
    ] as const) {
      for (const name of names) {
        const path = `${outbox}/${name}`
        expect(isOutboxIntentPath(path, 0, WEB_DEVICE_ID), name).toBe(expected)
        expect(isOwnOutboxPath(path, WEB_DEVICE_ID, 0), name).toBe(expected)
      }
    }
  })

  it('throws and performs zero writes when target path is not in outbox', async () => {
    const badPaths = [
      `.meta/control.json`,
      `.meta/keyring/_meta.json`,
      `generations/g-0/${DESKTOP_DEVICE_ID}/outbox/00000000-0000-0000-0000-000000000010.bin`,
      `generations/g-0/${WEB_DEVICE_ID}/metadata.json`,
      `generations/g-1/${WEB_DEVICE_ID}/outbox/00000000-0000-0000-0000-000000000010.bin`,
      `generations/g-0/${WEB_DEVICE_ID}/outbox/x-00000000-0000-0000-0000-000000000010.bin`,
      `generations/g-0/${WEB_DEVICE_ID}/outbox/j-short.bin`,
      `generations/g-0/${WEB_DEVICE_ID}/outbox/j-00000000-0000-0000-0000-000000000010`,
      `generations/g-0/${WEB_DEVICE_ID}/outbox/j-../00000000-0000-0000-0000-000000000010.bin`,
    ]

    for (const badPath of badPaths) {
      const intents: SafeUploadIntent[] = [
        {
          path: badPath,
          bytes: new Uint8Array([1, 2, 3]),
          intended: { kind: 'media', plaintext: new Uint8Array([1, 2, 3]) },
        },
      ]

      const mutatingCount = drive.mutating().length
      await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/outbox allowlist/i)
      expect(drive.mutating().length).toBe(mutatingCount)
    }
  })

  it('blocks upload when recovery fence refuses due to active recovery lease', async () => {
    // Put an active lease in control.json
    const ctrl = drive.find([ROOT_FOLDER_NAME, '.meta', 'control.json'])!
    ctrl.content = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        recovery_generation: 1,
        recovery_lease: {
          version: 1,
          job_id: 1,
          owner_device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          operation: 'local_to_cloud',
          recovery_generation: 1,
          nonce: '0123456789abcdef0123456789abcdef',
          created_at: 1000,
          updated_at: 2000,
        },
        updated_at: 2000,
      }),
    )
    ctrl.version++

    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, '00000000-0000-0000-0000-000000000010'),
        bytes: new Uint8Array([1, 2, 3]),
        intended: { kind: 'media', plaintext: new Uint8Array([1, 2, 3]) },
      },
    ]

    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/recovery/i)
  })

  it('serializes two concurrent batches: each acquires the lock, critical sections never overlap', async () => {
    const serial = fakeLocks(drive)
    const serialWriter = new DriveWriter(reader, {
      getToken: async () => 'test-token',
      fetchImpl: drive.fetch,
      locks: serial,
    })
    serialWriter.setIdentity({ ownId: WEB_DEVICE_ID, localGen })
    const intentFor = (entryId: string): SafeUploadIntent => {
      const entryObj = {
        schema_version: 1,
        entry_id: entryId,
        web_device_id: WEB_DEVICE_ID,
        created_on_web: true,
        web_updated_at_secs: 1700000000,
        base_state_vector: [],
        yjs_full_state: [],
        content_text: 'Concurrent',
        preview_text: 'Concurrent',
        fields: {
          title: null,
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: null,
          tags_add: {},
          tags_remove: {},
        },
        media: [],
      }
      return {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: core.sealOutboxEntry(ring, JSON.stringify(entryObj)),
        intended: { kind: 'entry', entry: entryObj },
      }
    }
    const first = [intentFor('00000000-0000-0000-0000-000000000030')]
    const second = [intentFor('00000000-0000-0000-0000-000000000031')]

    const mutatingAtStart = drive.mutating().length
    const mutatingAtSecondCheck: number[] = []
    const started: Array<Promise<unknown>> = []
    const deps = makeDeps({
      writer: serialWriter,
      locks: serial,
      fetchWriteFlagImpl: async () => {
        if (started.length === 0) {
          // Start the second batch while the first one holds the lock.
          started.push(
            safeUpload(
              second,
              makeDeps({
                writer: serialWriter,
                locks: serial,
                fetchWriteFlagImpl: async () => {
                  mutatingAtSecondCheck.push(drive.mutating().length)
                  return true
                },
              }),
            ),
          )
        }
        return true
      },
    })

    await expect(safeUpload(first, deps)).resolves.toHaveLength(1)
    await expect(Promise.all(started)).resolves.toBeDefined()
    expect(serial.maxActive).toBe(1)
    expect(serial.events.map((e) => e.split('@')[0])).toEqual(['enter', 'exit', 'enter', 'exit'])
    // The second batch's first check ran only after the first batch's write landed.
    expect(mutatingAtSecondCheck).toEqual([mutatingAtStart + 1])
  })

  it('fails closed when navigator.locks is unavailable', async () => {
    const intents: SafeUploadIntent[] = []
    await expect(safeUpload(intents, makeDeps({ locks: null }))).rejects.toThrow(
      LockUnavailableError,
    )
  })

  it('blocks upload when format guard is latched', async () => {
    latchFormatGuard('some/path', 'unknown format')
    const intents: SafeUploadIntent[] = []
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/format guard/i)
  })
})
