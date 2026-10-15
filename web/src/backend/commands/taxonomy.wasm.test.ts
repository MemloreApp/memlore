import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PERSONA_SECTION_MAX_CHARS } from '../../../../src/lib/memorySettings'
import {
  loadCore,
  openOutboxIntent,
  sealOutboxIntentV3,
  type Core,
  type OutboxIntentV3,
} from '../../core/core'
import { setWriteFlagForTest } from '../config'
import { fixtureBytes, loadDesktopFixture, text } from '../drive/fakeDrive'
import { lock, setKeyRing, type KeyRing } from '../keys'
import type { DeviceBinKind, DeviceBinLoader, DeviceBinResult } from './deviceBins'
import { deviceBinHandlers } from './deviceBins'
import { entryHandlers, setCustomFilesPicker } from './entries'
import { configureReadEnv, type Taxonomy } from './readSession'
import { EMPTY_TAXONOMY, installFakeSession, type Harness } from './readTestKit'
import { taxonomyHandlers } from './taxonomy'
import { trashHandlers } from './trash'

/**
 * The intents the web journal / tag / template / trash / Trash-management / memory / persona /
 * entry location / insertion mode / attachment handlers build (fake session, whose "seal" is the JSON behind a `3` byte) must pass the REAL
 * core's `OutboxIntentV3::validate` and serde shape: sealed and reopened through WASM, each comes
 * back unchanged.
 */

type Ring = ReturnType<Core['KeyRing']['fromRecovery']>

const J_A = '11111111-1111-4111-8111-111111111111'
const J_B = '11111111-1111-4111-8111-111111111112'
const T_A = '22222222-2222-4222-8222-222222222221'
const T_B = '22222222-2222-4222-8222-222222222222'
const TPL = '33333333-3333-4333-8333-333333333331'
const ENTRY = '44444444-4444-4444-8444-444444444441'
const TRASHED = '44444444-4444-4444-8444-444444444442'
const MEM = '55555555-5555-4555-8555-555555555551'
const MEDIA = '66666666-6666-4666-8666-666666666661'
/** A location label the desktop stored with a line break and a control char (a valid base). */
const STORED_LABEL = 'Old\nhome\u0007'

/** Every character memlore-core rejects in persona text, which the handlers strip before sealing. */
const HIDDEN = '\u0000\u0085\u200B\u200F\u202E\u2068\u061C\uFEFF\u2028\u{E0041}'
/** ZWJ (an emoji family) and ZWNJ (a Persian word): plain text core accepts, the web keeps. */
const JOINED =
  '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'

/** One desktop's `memory.bin`: an item sourced from `ENTRY`, a persona carrying `HIDDEN`. */
const MEMORY_BIN: DeviceBinResult<'memory'> = {
  status: 'ok',
  device: 'aaaaaaaa-0000-4000-8000-000000000001',
  payload: {
    items: [
      {
        id: MEM,
        text: 'likes tea',
        source_type: 'journal_entry',
        enabled: true,
        is_deleted: false,
        created_at: 1,
        updated_at: 2000,
        sources: [{ source_type: 'journal_entry', source_id: ENTRY }],
      },
    ],
    persona: {
      answers_json: '{}',
      traits_text: `Calm${HIDDEN} and kind`,
      style_text: 'Short',
      enabled: true,
      user_edited: false,
      generated_at: 1,
      updated_at: 2100,
    },
  },
}

const DEVICE_BINS: DeviceBinLoader = {
  loadDeviceBin: async <K extends DeviceBinKind>(kind: K) =>
    (kind === 'memory' ? [MEMORY_BIN] : []) as Array<DeviceBinResult<K>>,
  readStreaks: async () => [],
  clear: () => undefined,
}

const journal = (id: string, name: string, updatedAt: number) => ({
  id,
  name,
  color: null,
  created_at: 1,
  updated_at: updatedAt,
  sort_order: 1,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
})

const SYNCED: Taxonomy = {
  ...EMPTY_TAXONOMY,
  journals: [journal(J_A, 'Daily', 1800), journal(J_B, 'Trips', 1810)],
  autoTagIds: { [J_A]: [T_A] },
  knownJournalIds: [J_A, J_B],
  tags: [
    { id: T_A, name: 'alpha', color: '#112233' },
    // A name an older desktop stored with a zero-width space: a color-only edit still seals.
    { id: T_B, name: 'beta\u200B', color: null },
  ],
  knownTagIds: [T_A, T_B],
  tagUpdatedAt: { [T_A]: 1900, [T_B]: 1901 },
  templates: [
    {
      id: TPL,
      name: 'Morning',
      description: null,
      content: [1, 2],
      is_predefined: false,
      sort_order: 2,
      created_at: 1,
    },
  ],
  templateUpdatedAt: { [TPL]: 1700 },
}

const KINDS = [
  'upsert_journal',
  'delete_journal',
  'upsert_tag',
  'delete_tag',
  'upsert_template',
  'delete_template',
  'trash_entry',
  'restore_entry',
  'purge_entry',
  'empty_trash',
  'delete_memory_item',
  'update_persona',
  'set_entry_location',
  'set_media_insertion_mode',
  'attach_media',
  'delete_media',
]

const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
  Promise.resolve(
    (
      taxonomyHandlers[name] ??
      entryHandlers[name] ??
      trashHandlers[name] ??
      deviceBinHandlers[name]
    )(args),
  )

let core: Core
let ring: Ring

beforeAll(async () => {
  core = await loadCore()
  const fixture = loadDesktopFixture()
  const json = (path: string): string => text(fixtureBytes(fixture, path))
  const recovery = JSON.parse(json('.meta/keyring/_recovery.json')) as { wrapped_master: string }
  const meta = JSON.parse(json('.meta/keyring/_meta.json')) as { master_fingerprint: string }
  ring = core.KeyRing.fromRecovery(
    fixture.recovery_phrase,
    recovery.wrapped_master,
    meta.master_fingerprint,
  )
  ring.loadContentList(json('.meta/keyring/_content.json'))
})

afterEach(() => {
  setCustomFilesPicker(null)
  configureReadEnv({})
  setWriteFlagForTest(false)
  lock('manual')
})

describe('web-built v3 intents through the real core', () => {
  it.each<[string, string, Record<string, unknown>]>([
    [
      'upsert_journal',
      'create_journal',
      { payload: { name: `Ne${HIDDEN}w ${JOINED}`, color: '#7C3AED', autoTagIds: [T_B] } },
    ],
    [
      'upsert_journal',
      'update_journal',
      { payload: { id: J_A, name: `Da${HIDDEN}ys`, color: '#abcdef' } },
    ],
    ['delete_journal', 'delete_journal', { id: J_B }],
    ['upsert_tag', 'create_tag', { name: `gam${HIDDEN}ma`, color: '#00aaff' }],
    ['upsert_tag', 'update_tag', { payload: { id: T_A, name: `alpha${HIDDEN} 2`, color: null } }],
    ['upsert_tag', 'update_tag', { payload: { id: T_B, color: '#123456' } }],
    ['delete_tag', 'delete_tag', { id: T_B }],
    [
      'upsert_template',
      'create_template',
      { name: `Eve${HIDDEN}ning`, description: 'd', content: [7, 8, 9] },
    ],
    ['upsert_template', 'update_template', { id: TPL, name: `Morning${HIDDEN} 2` }],
    ['delete_template', 'delete_template', { id: TPL }],
    ['trash_entry', 'soft_delete_entry', { id: ENTRY }],
    ['restore_entry', 'restore_entry', { id: TRASHED }],
    ['purge_entry', 'delete_entry_forever', { id: TRASHED }],
    ['empty_trash', 'empty_trash', { ids: [TRASHED] }],
    ['delete_memory_item', 'delete_memory_item', { memoryId: MEM }],
    [
      'update_persona',
      'write_persona_user_edit',
      {
        traitsText: `Warm${HIDDEN}\n\tand kind ${JOINED}`,
        styleText: `Long${HIDDEN} lines`,
        section: 'traits',
      },
    ],
    ['update_persona', 'set_persona_enabled', { enabled: false }],
    [
      'set_entry_location',
      'update_entry_location',
      {
        id: ENTRY,
        latitude: 48.85,
        longitude: 2.35,
        locationLabel: `Home${HIDDEN}\n\tsweet ${JOINED}`,
        locationAddress: `12 Rue${HIDDEN}`,
      },
    ],
    ['set_entry_location', 'update_entry_location', { id: ENTRY, locationLabel: '  ' }],
    [
      'set_media_insertion_mode',
      'update_media_insertion_mode',
      { mediaId: MEDIA, mode: 'attached' },
    ],
    ['delete_media', 'delete_media', { mediaId: MEDIA }],
  ])('%s from %s seals and reopens unchanged', async (kind, command, args) => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const h: Harness = installFakeSession(
      [
        {
          id: ENTRY,
          updatedAt: 1950,
          journal: J_A,
          latitude: 21.03,
          longitude: 105.85,
          locationLabel: STORED_LABEL,
          mediaIds: [MEDIA],
        },
        { id: TRASHED, updatedAt: 1960, journal: J_A, trashedAt: 1970 },
      ],
      { taxonomy: SYNCED, outboxKinds: KINDS, deviceBins: DEVICE_BINS },
    )
    await h.vault.load([ENTRY])

    await call(command, args)

    const drafts = await h.db.drafts.list()
    expect(drafts).toHaveLength(1)
    const intent = JSON.parse(
      new TextDecoder().decode(drafts[0].sealed.subarray(1)),
    ) as OutboxIntentV3
    expect(intent.kind).toBe(kind)
    expect(openOutboxIntent(core, ring, sealOutboxIntentV3(core, ring, intent))).toEqual({
      version: 3,
      intent,
    })
    // ZWJ / ZWNJ text is kept, never stripped with the hidden chars.
    if (JSON.stringify(args).includes(JOINED)) expect(JSON.stringify(intent)).toContain(JOINED)
  })

  // Phase 14: whatever name or type a picked file has, the attach the handler builds seals.
  it('attach_media from pick_files_to_attach seals and reopens unchanged for hostile names', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const h: Harness = installFakeSession([{ id: ENTRY, updatedAt: 1950, journal: J_A }], {
      taxonomy: SYNCED,
      outboxKinds: KINDS,
    })
    await h.vault.load([ENTRY])
    const names = [
      'memo.wav',
      'song.MP3',
      'voice.m4a',
      'page.html',
      '../../etc/passwd',
      'a\\b.txt',
      `in${HIDDEN}voice\u202Efdp.exe`,
      `${JOINED}.m4a`,
      '\u202E  ',
      `${'\u00E9'.repeat(300)}.pdf`,
    ]
    const file = (name: string): File => new File([new Uint8Array([1, 2, 3])], name)
    // One refused file refuses the batch before anything is stored (desktop parity).
    setCustomFilesPicker(async () => [file('ok.pdf'), file('logo.svg')])
    await expect(call('pick_files_to_attach', { entryId: ENTRY })).rejects.toThrow(
      'MEDIA_NOT_ALLOWED:logo.svg',
    )
    expect(await h.db.drafts.list()).toEqual([])

    setCustomFilesPicker(async () => names.map(file))
    expect(await call('pick_files_to_attach', { entryId: ENTRY })).toHaveLength(names.length)

    const drafts = await h.db.drafts.list()
    expect(drafts).toHaveLength(names.length)
    expect(
      drafts.some((d) => new TextDecoder().decode(d.sealed.subarray(1)).includes(`${JOINED}.m4a`)),
    ).toBe(true)
    for (const draft of drafts) {
      const intent = JSON.parse(
        new TextDecoder().decode(draft.sealed.subarray(1)),
      ) as OutboxIntentV3
      expect(intent.kind).toBe('attach_media')
      expect(openOutboxIntent(core, ring, sealOutboxIntentV3(core, ring, intent))).toEqual({
        version: 3,
        intent,
      })
    }
  })

  it('names lose exactly the chars core refuses: ZWJ / ZWNJ stay, a name of hidden chars only is blank', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const h: Harness = installFakeSession([], { taxonomy: SYNCED, outboxKinds: KINDS })
    await call('create_tag', { name: ` ${HIDDEN}ga${HIDDEN}mma ${JOINED}${HIDDEN} ` })
    const [draft] = await h.db.drafts.list()
    const intent = JSON.parse(new TextDecoder().decode(draft.sealed.subarray(1))) as {
      name: string
    }
    expect(intent.name).toBe(`gamma ${JOINED}`)
    await expect(call('create_tag', { name: `${HIDDEN} ` })).rejects.toThrow(
      'name must not be empty',
    )
    const tag = (name: string): OutboxIntentV3 => ({
      kind: 'upsert_tag',
      web_device_id: 'aaaaaaaa-0000-4000-8000-000000000009',
      web_updated_at_secs: 1,
      tag_id: T_A,
      name,
      color: null,
      base_updated_at: null,
    })
    for (const c of HIDDEN) {
      expect(() => sealOutboxIntentV3(core, ring, tag(`a${c}b`)), c).toThrow()
    }
  })

  it('the real core rejects the persona text the handlers strip, and agrees on the cap', () => {
    const intent: OutboxIntentV3 = {
      kind: 'update_persona',
      web_device_id: 'aaaaaaaa-0000-4000-8000-000000000009',
      web_updated_at_secs: 1,
      traits_text: '',
      style_text: '',
      enabled: true,
      base_updated_at: 0,
    }
    for (const c of HIDDEN) {
      expect(
        () => sealOutboxIntentV3(core, ring, { ...intent, traits_text: `a${c}b` }),
        c,
      ).toThrow()
    }
    const atCap = '\u00E9'.repeat(PERSONA_SECTION_MAX_CHARS)
    expect(() => sealOutboxIntentV3(core, ring, { ...intent, style_text: atCap })).not.toThrow()
    expect(() => sealOutboxIntentV3(core, ring, { ...intent, style_text: `${atCap}x` })).toThrow()
  })

  it('the real core refuses the location value text the handler strips, never a stored base', () => {
    const intent: OutboxIntentV3 = {
      kind: 'set_entry_location',
      web_device_id: 'aaaaaaaa-0000-4000-8000-000000000009',
      web_updated_at_secs: 1,
      entry_id: ENTRY,
      value: null,
      base: null,
      base_updated_at: 0,
    }
    const at = (label: string) => ({ latitude: null, longitude: null, label, address: null })
    for (const c of `${HIDDEN}\n\t`) {
      expect(() => sealOutboxIntentV3(core, ring, { ...intent, value: at(`a${c}b`) }), c).toThrow()
    }
    expect(() =>
      sealOutboxIntentV3(core, ring, { ...intent, base: at(STORED_LABEL) }),
    ).not.toThrow()
  })
})
