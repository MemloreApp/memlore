import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import * as core from '../src/core/pkg-test/memlore_wasm.js'
import type { OutboxIntentV3 } from '../src/core/core.ts'

// Frame-3 outbox oracle: one file per known v3 kind (production `sealOutboxIntentV3`) plus
// hostile files the typed sealer refuses (`sealRawOutboxFrame`, test-sealers build only).
// `web-outbox.v1.json` is a separate oracle; this script never touches it.

const fixturesDir = new URL('../../src-tauri/crates/memlore-core/fixtures/', import.meta.url)
const outPath = fileURLToPath(new URL('web-outbox.v3.json', fixturesDir))
const vaultPath = fileURLToPath(new URL('desktop-vault.v1.json', fixturesDir))

if (existsSync(outPath) && process.env.MEMLORE_REGEN_FIXTURES !== '1') {
  console.error(
    `Refusing to overwrite ${outPath}: it is a frozen cross-language oracle.\n` +
      'If a deliberate, reviewed fixture change is really needed, run:\n' +
      '  MEMLORE_REGEN_FIXTURES=1 pnpm web:fixture:outbox-v3',
  )
  process.exit(1)
}

interface Vault {
  files: Record<string, string>
  recovery_phrase: string
  generation: number
}

const vault = JSON.parse(readFileSync(vaultPath, 'utf8')) as Vault
const text = (path: string): string => Buffer.from(vault.files[path], 'base64').toString('utf8')
const recovery = JSON.parse(text('.meta/keyring/_recovery.json')) as { wrapped_master: string }
const meta = JSON.parse(text('.meta/keyring/_meta.json')) as { master_fingerprint: string }

core.initSync({
  module: readFileSync(new URL('../src/core/pkg-test/memlore_wasm_bg.wasm', import.meta.url)),
})
const ring = core.KeyRing.fromRecovery(
  vault.recovery_phrase,
  recovery.wrapped_master,
  meta.master_fingerprint,
)
ring.loadContentList(text('.meta/keyring/_content.json'))

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

const webDeviceId = '00000000-0000-0000-0000-000000000002'
const outbox = `generations/g-${vault.generation}/${webDeviceId}/outbox`
const synthetic = (n: number): string => `00000000-0000-0000-0000-000000000${n}`

// Desktop ids of desktop-vault.v1.json (entries "Golden one".."Golden seven", its media).
const golden = {
  one: '5b7d3a8f-bd0c-4178-94b7-69d19959fecf',
  two: '64c4c37b-27b7-48b6-a0b7-ff83545e0c87',
  three: '1cd8057a-38a2-4883-91cd-a096700ff1b2',
  four: 'd572a028-9099-43cb-88a5-3e0b1e6d5573',
  five: '80c8978d-6e44-41b6-aabd-d2f828958c62',
  seven: 'bfd06ad9-bb0f-43e2-9b24-0bee3fbe1fcd',
  sevenMedia: '32bd8743-077d-4312-b6ff-9cd896e09d1b',
}
const base = { web_device_id: webDeviceId }
const baseStamp = 1700000000

const templateDoc = new Y.Doc()
templateDoc.getText('content').insert(0, 'Gratitude: three things')
const templateB64 = b64(Y.encodeStateAsUpdate(templateDoc))

// One intent per v3 kind, each with its own file (`<letter>-<target>.bin`).
const known: Array<{ name: string; intent: OutboxIntentV3 }> = [
  {
    name: `t-${synthetic(301)}.bin`,
    intent: {
      ...base,
      kind: 'upsert_tag',
      web_updated_at_secs: 1700000301,
      tag_id: synthetic(301),
      name: 'Golden v3 tag',
      color: '#7c3aed',
      base_updated_at: null,
    },
  },
  {
    name: `j-${synthetic(302)}.bin`,
    intent: {
      ...base,
      kind: 'upsert_journal',
      web_updated_at_secs: 1700000302,
      journal_id: synthetic(302),
      name: 'Golden v3 journal',
      color: null,
      auto_tag_ids: [synthetic(301)],
      base_updated_at: null,
    },
  },
  {
    name: `p-${synthetic(303)}.bin`,
    intent: {
      ...base,
      kind: 'upsert_template',
      web_updated_at_secs: 1700000303,
      template_id: synthetic(303),
      name: 'Golden v3 template',
      description: 'Three good things',
      content_b64: templateB64,
      sort_order: 3,
      base_updated_at: null,
    },
  },
  {
    name: `p-${synthetic(304)}.bin`,
    intent: {
      ...base,
      kind: 'delete_template',
      web_updated_at_secs: 1700000304,
      template_id: synthetic(304),
      base_updated_at: baseStamp,
    },
  },
  {
    name: `l-${golden.two}.bin`,
    intent: {
      ...base,
      kind: 'set_entry_location',
      web_updated_at_secs: 1700000305,
      entry_id: golden.two,
      value: { latitude: 48.8566, longitude: 2.3522, label: 'Paris', address: '1 Rue de Rivoli' },
      // Label-only base: the desktop keeps a location with null coordinates.
      base: { latitude: null, longitude: null, label: 'Home', address: null },
      base_updated_at: baseStamp,
    },
  },
  {
    name: `a-${synthetic(306)}.bin`,
    intent: {
      ...base,
      kind: 'attach_media',
      web_updated_at_secs: 1700000306,
      entry_id: golden.three,
      media_id: synthetic(306),
      file_name: 'voice memo.m4a',
      file_type: 'audio/mp4',
      size: 4096,
      has_thumb: false,
      duration_ms: 61500,
      insertion_mode: 'attached',
    },
  },
  {
    name: `a-${golden.sevenMedia}.bin`,
    intent: {
      ...base,
      kind: 'delete_media',
      web_updated_at_secs: 1700000307,
      entry_id: golden.seven,
      media_id: golden.sevenMedia,
    },
  },
  {
    name: `i-${golden.sevenMedia}.bin`,
    intent: {
      ...base,
      kind: 'set_media_insertion_mode',
      web_updated_at_secs: 1700000308,
      entry_id: golden.seven,
      media_id: golden.sevenMedia,
      mode: 'attached',
      base_mode: 'inline',
      base_updated_at: baseStamp,
    },
  },
  {
    name: `d-${golden.four}.bin`,
    intent: {
      ...base,
      kind: 'restore_entry',
      web_updated_at_secs: 1700000309,
      entry_id: golden.four,
      base_updated_at: baseStamp,
    },
  },
  {
    name: `d-${golden.five}.bin`,
    intent: {
      ...base,
      kind: 'trash_entry',
      web_updated_at_secs: 1700000310,
      entry_id: golden.five,
      base_updated_at: baseStamp,
    },
  },
  {
    name: `d-${golden.one}.bin`,
    intent: {
      ...base,
      kind: 'purge_entry',
      web_updated_at_secs: 1700000311,
      entry_id: golden.one,
      base_updated_at: baseStamp,
    },
  },
  {
    name: 'd-empty-trash.bin',
    intent: {
      ...base,
      kind: 'empty_trash',
      web_updated_at_secs: 1700000312,
      items: [
        { entry_id: golden.four, base_updated_at: baseStamp },
        { entry_id: golden.five, base_updated_at: baseStamp + 1 },
      ],
    },
  },
  {
    name: `t-${synthetic(313)}.bin`,
    intent: {
      ...base,
      kind: 'delete_tag',
      web_updated_at_secs: 1700000313,
      tag_id: synthetic(313),
      base_updated_at: baseStamp,
    },
  },
  {
    name: `j-${synthetic(314)}.bin`,
    intent: {
      ...base,
      kind: 'delete_journal',
      web_updated_at_secs: 1700000314,
      journal_id: synthetic(314),
      base_updated_at: baseStamp,
    },
  },
  {
    name: `y-${synthetic(315)}.bin`,
    intent: {
      ...base,
      kind: 'delete_memory_item',
      web_updated_at_secs: 1700000315,
      memory_id: synthetic(315),
      base_updated_at: baseStamp,
    },
  },
  {
    name: 'q-user-persona.bin',
    intent: {
      ...base,
      kind: 'update_persona',
      web_updated_at_secs: 1700000316,
      traits_text: 'Curious, kind, writes in the evening',
      style_text: 'Short sentences, warm tone',
      enabled: true,
      base_updated_at: baseStamp,
    },
  },
]

const limits = JSON.parse(core.outboxLimits()) as { supported_outbox_kinds: string[] }
const covered = known.map((k) => k.intent.kind).sort()
if (JSON.stringify(covered) !== JSON.stringify([...limits.supported_outbox_kinds].sort())) {
  throw new Error(`fixture kinds ${covered.join(',')} != supported kinds`)
}

const files: Record<string, string> = {}
const expectedKnown: Array<{ path: string; kind: string; intent: OutboxIntentV3 }> = []
for (const { name, intent } of known) {
  const path = `${outbox}/${name}`
  files[path] = b64(core.sealOutboxIntentV3(ring, JSON.stringify(intent)))
  expectedKnown.push({ path, kind: intent.kind, intent })
}

// Hostile 1: a well-formed kind this build does not know, under a letter no kind uses.
const unknownKind = 'rename_entry'
const unknownKindPath = `${outbox}/z-${synthetic(321)}.bin`
files[unknownKindPath] = b64(
  core.sealRawOutboxFrame(
    ring,
    3,
    utf8(
      JSON.stringify({
        ...base,
        kind: unknownKind,
        web_updated_at_secs: 1700000321,
        entry_id: synthetic(321),
        title: 'A title a newer web renamed',
      }),
    ),
  ),
)

// Hostile 2: a known kind carrying a field it does not have (each kind is closed).
const unknownFieldPath = `${outbox}/t-${synthetic(322)}.bin`
files[unknownFieldPath] = b64(
  core.sealRawOutboxFrame(
    ring,
    3,
    utf8(
      JSON.stringify({
        ...base,
        kind: 'upsert_tag',
        web_updated_at_secs: 1700000322,
        tag_id: synthetic(322),
        name: 'Tag with an extra field',
        color: null,
        base_updated_at: null,
        icon: 'star',
      }),
    ),
  ),
)

// Hostile 3: a valid known kind (tag, letter `t`) stored under the journal letter `j`.
const wrongLetterPath = `${outbox}/j-${synthetic(323)}.bin`
files[wrongLetterPath] = b64(
  core.sealOutboxIntentV3(
    ring,
    JSON.stringify({
      ...base,
      kind: 'upsert_tag',
      web_updated_at_secs: 1700000323,
      tag_id: synthetic(323),
      name: 'Tag under the journal letter',
      color: null,
      base_updated_at: null,
    } satisfies OutboxIntentV3),
  ),
)

const out = {
  _comment:
    'Generated by `pnpm web:fixture:outbox-v3` (WASM sealers, keys of desktop-vault.v1.json). ' +
    'FROZEN cross-language oracle for outbox frame v3: never regenerate casually, fix the code instead.',
  vault_fixture: 'desktop-vault.v1.json',
  web_device_id: webDeviceId,
  frame_version: 3,
  files,
  expected: {
    known: expectedKnown,
    unknown_kind: { path: unknownKindPath, kind: unknownKind },
    unknown_field: { path: unknownFieldPath },
    wrong_letter: { path: wrongLetterPath },
  },
}

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
ring.lock()
console.log(`wrote ${outPath}`)
