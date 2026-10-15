import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Core, OutboxIntentV3 } from '../../core/core'
import type { Journal, Tag } from '../../../../src/types/journal'
import type { Template } from '../../../../src/types/template'
import { setWriteFlagForTest } from '../config'
import { createDraftManager, sha256Hex } from '../drafts'
import { WRITER_LOCK_NAME } from '../drive/client'
import { lock, setKeyRing, type KeyRing } from '../keys'
import type { MetaRecord, WebDb } from '../storage/idb'
import type { SafeUploadDeps } from '../sync/safeUpload'
import { configureTabsEnv, type DraftLocksLike } from '../tabs'
import { WebUnsupportedError } from '../unsupported'
import { configureReadEnv, readTaxonomy, type Taxonomy } from './readSession'
import {
  EMPTY_TAXONOMY,
  fakeMonthIndex,
  installFakeSession,
  type FakeSpec,
  type Harness,
} from './readTestKit'
import { entryHandlers } from './entries'
import { taxonomyHandlers } from './taxonomy'

// Only `safeUpload` is replaced (by the mid-upload test); the intent helpers stay real.
const mocks = vi.hoisted(() => ({ safeUpload: vi.fn() }))
vi.mock('../sync/safeUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync/safeUpload')>()),
  safeUpload: mocks.safeUpload,
}))

afterEach(() => {
  configureReadEnv({})
  configureTabsEnv({})
  setWriteFlagForTest(false)
  lock('manual')
})

const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(taxonomyHandlers[name](args)) as Promise<T>

const journal = (id: string, sort: number) => ({
  id,
  name: `Journal ${id}`,
  color: null,
  created_at: sort,
  updated_at: sort,
  sort_order: sort,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
})

const tag = (id: string, name: string): Tag => ({ id, name, color: null })

const TAXONOMY: Taxonomy = {
  ...EMPTY_TAXONOMY,
  journals: [journal('j1', 1), journal('j2', 2)],
  autoTagIds: { j1: ['t2', 't1'] },
  tags: [tag('t1', 'alpha'), tag('t2', 'beta'), tag('t3', 'gamma')],
  templates: [
    {
      id: 'tp1',
      name: 'Daily',
      description: null,
      content: [1, 2],
      is_predefined: false,
      sort_order: 0,
      created_at: 1,
    },
  ],
}

describe('taxonomy handlers', () => {
  it('serves journals, auto tags, tags and templates read-only', async () => {
    installFakeSession([], { taxonomy: TAXONOMY })
    expect((await call<Array<{ id: string }>>('list_journals')).map((j) => j.id)).toEqual([
      'j1',
      'j2',
    ])
    expect(await call('get_journal', { id: 'j2' })).toMatchObject({ id: 'j2' })
    expect(await call('get_journal', { id: 'hidden' })).toBeNull()
    expect(await call('list_journal_auto_tags', { journalId: 'j1' })).toEqual([
      tag('t1', 'alpha'),
      tag('t2', 'beta'),
    ])
    expect(await call('list_journal_auto_tags', { journalId: 'j2' })).toEqual([])
    expect(await call('list_tags')).toEqual(TAXONOMY.tags)
    expect(await call('list_templates')).toEqual(TAXONOMY.templates)
    expect(await call('get_template', { id: 'tp1' })).toEqual(TAXONOMY.templates[0])
    expect(await call('get_template', { id: 'nope' })).toBeNull()
  })

  it('counts tags over the loaded visible entries, count desc then name', async () => {
    const { vault } = installFakeSession(
      [
        { id: 'a', updatedAt: 3, tags: ['t2'] },
        { id: 'b', updatedAt: 2, tags: ['t2', 't3'] },
        { id: 'c', updatedAt: 1, tags: ['t1'], locked: true },
      ],
      { taxonomy: TAXONOMY },
    )
    await vault.load(['a', 'b', 'c'])
    expect(await call('get_tags_with_counts')).toEqual([
      [tag('t2', 'beta'), 2],
      [tag('t3', 'gamma'), 1],
      [tag('t1', 'alpha'), 0],
    ])
  })

  it('gets the tags of one entry on demand and of many without downloading', async () => {
    const { vault } = installFakeSession(
      [
        { id: 'a', updatedAt: 3, tags: ['t2', 't1'] },
        { id: 'b', updatedAt: 2, tags: ['t3'] },
        { id: 'l', updatedAt: 1, tags: ['t1'], locked: true },
      ],
      { taxonomy: TAXONOMY },
    )
    expect(await call('get_tags_for_entry', { entryId: 'a' })).toEqual([
      tag('t1', 'alpha'),
      tag('t2', 'beta'),
    ])
    expect(vault.loadCalls).toEqual([['a']])
    // Hidden or unknown entries answer an empty list, as on desktop.
    expect(await call('get_tags_for_entry', { entryId: 'l' })).toEqual([])
    expect(await call('get_tags_for_entry', { entryId: 'nope' })).toEqual([])

    vault.loadCalls.length = 0
    expect(await call('get_tags_for_entries', { entryIds: ['a', 'b', 'l', 'nope'] })).toEqual({
      a: [tag('t1', 'alpha'), tag('t2', 'beta')],
    })
    expect(vault.loadCalls).toEqual([])
  })

  it('gets the tags of a row the vault does not hold from its index row, never its payload', async () => {
    const { vault } = installFakeSession([{ id: 'a', updatedAt: 3, tags: ['t1'] }], {
      taxonomy: TAXONOMY,
      monthIndex: fakeMonthIndex(
        [
          { id: 'a', entryDate: 1_700_000_000, tags: ['t1'] },
          { id: 'x', entryDate: 1_700_000_000, tags: ['t2'], journal: 'jx' },
        ],
        ['jx'],
      ),
    })
    expect(await call('get_tags_for_entries', { entryIds: ['a', 'x'] })).toEqual({
      a: [tag('t1', 'alpha')],
    })
    expect(vault.loadCalls).toEqual([])
  })

  it('answers journal ids and entry ids named like Object.prototype keys', async () => {
    const { vault } = installFakeSession([{ id: '__proto__', updatedAt: 1, tags: ['t1'] }], {
      taxonomy: TAXONOMY,
    })
    expect(await call('list_journal_auto_tags', { journalId: '__proto__' })).toEqual([])
    expect(await call('list_journal_auto_tags', { journalId: 'toString' })).toEqual([])
    await vault.load(['__proto__'])
    const out = await call<Record<string, Tag[]>>('get_tags_for_entries', {
      entryIds: ['__proto__'],
    })
    expect(Object.keys(out)).toEqual(['__proto__'])
    expect(out['__proto__']).toEqual([tag('t1', 'alpha')])
  })

  it('rejects every handler when locked', async () => {
    const { setUnlocked } = installFakeSession([], { taxonomy: TAXONOMY })
    setUnlocked(false)
    for (const name of Object.keys(taxonomyHandlers)) {
      await expect(
        call(name, { id: 'x', journalId: 'j1', entryId: 'a', entryIds: [] }),
      ).rejects.toThrow('vault is locked')
    }
  })
})

describe('taxonomy write handlers (outbox v3: Phase 22.1, web gap audit 10.2)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const TPL = '22222222-2222-4222-8222-222222222222'
  const J_SYNCED = '44444444-4444-4444-8444-444444444441'
  const T_SYNCED = '55555555-5555-4555-8555-555555555551'
  const SYNCED: Taxonomy = {
    ...TAXONOMY,
    journals: [...TAXONOMY.journals, { ...journal(J_SYNCED, 3), name: 'Trips', updated_at: 1800 }],
    autoTagIds: { ...TAXONOMY.autoTagIds, [J_SYNCED]: ['t1'] },
    knownJournalIds: ['j1', 'j2', J_SYNCED],
    tags: [...TAXONOMY.tags, tag(T_SYNCED, 'delta')],
    tagUpdatedAt: { [T_SYNCED]: 1900 },
    knownTagIds: ['t1', 't2', 't3', 't-gone', T_SYNCED],
    deletedTagNames: ['retired'],
    templates: [
      {
        id: TPL,
        name: 'Daily',
        description: 'desc',
        content: [1, 2],
        is_predefined: false,
        sort_order: 4,
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
  ]

  function writable(
    taxonomy: Taxonomy = SYNCED,
    outboxKinds: readonly string[] = KINDS,
    specs: FakeSpec[] = [],
  ): Harness {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    return installFakeSession(specs, { taxonomy, outboxV2: true, outboxKinds })
  }

  /** Every stored draft (each sealed as frame 3): key, kind and the opened intent. */
  async function v3Drafts(h: Harness): Promise<Array<[string, string, OutboxIntentV3]>> {
    const out: Array<[string, string, OutboxIntentV3]> = []
    for (const d of await h.db.drafts.list()) {
      expect(d.sealed[0], d.entryId).toBe(3)
      const json = new TextDecoder().decode(d.sealed.subarray(1))
      out.push([d.entryId, String(d.kind), JSON.parse(json) as OutboxIntentV3])
    }
    return out
  }

  it('create_journal stores an upsert_journal create draft and the journal shows at once', async () => {
    const h = writable()
    const journal = await call<Journal>('create_journal', {
      payload: { name: '  Travel  ', color: '#7C3AED', autoTagIds: ['t2'] },
    })

    expect(journal).toMatchObject({ name: 'Travel', color: '#7C3AED', is_deleted: false })
    expect(journal.id).toMatch(UUID)
    const [[key, kind, intent]] = await v3Drafts(h)
    expect(key).toBe(`j-${journal.id}`)
    expect(kind).toBe('journal')
    expect(intent).toEqual({
      kind: 'upsert_journal',
      web_device_id: 'test-device-id',
      web_updated_at_secs: expect.any(Number),
      journal_id: journal.id,
      name: 'Travel',
      color: '#7C3AED',
      auto_tag_ids: ['t2'],
      base_updated_at: null,
    })
    expect((await call<Journal[]>('list_journals')).map((j) => j.id)).toContain(journal.id)
    expect(await call('get_journal', { id: journal.id })).toEqual(journal)
    expect(await call('list_journal_auto_tags', { journalId: journal.id })).toEqual([
      tag('t2', 'beta'),
    ])
  })

  it('create_journal sends a missing color as null and refuses invalid input or a taken name', async () => {
    const h = writable()
    const plain = await call<Journal>('create_journal', { payload: { name: 'Plain' } })
    expect(plain.color).toBeNull()
    const [[, , intent]] = await v3Drafts(h)
    expect(intent).toMatchObject({ color: null, auto_tag_ids: [] })

    const bad: Array<Record<string, unknown>> = [
      { name: '   ' },
      { name: 'x'.repeat(201) },
      { name: 'Ok', color: 'red' },
      { name: 'Ok', autoTagIds: ['nope'] },
      { name: 'Journal j1' }, // a synced journal
      { name: ' Plain ' }, // a pending one
    ]
    for (const payload of bad) {
      await expect(call('create_journal', { payload }), JSON.stringify(payload)).rejects.toThrow()
    }
    await expect(call('create_journal', { payload: { name: 'Journal j1' } })).rejects.toThrow(
      'name_taken',
    )
    expect(await h.db.drafts.list()).toHaveLength(1)
  })

  it('create_journal accepts a pending tag as auto tag', async () => {
    writable()
    const t = await call<Tag>('create_tag', { name: 'fresh' })
    const j = await call<Journal>('create_journal', {
      payload: { name: 'New', autoTagIds: [t.id] },
    })
    expect(await call('list_journal_auto_tags', { journalId: j.id })).toEqual([t])
  })

  it('create_journal refuses the name of a locked journal (desktop create_journal_with_id)', async () => {
    const h = writable({ ...SYNCED, lockedJournalNames: [' Secret '] })
    await expect(call('create_journal', { payload: { name: 'Secret' } })).rejects.toThrow(
      'name_taken',
    )
    expect(await h.db.drafts.list()).toHaveLength(0)
  })

  it('two concurrent create_journal of one name store one draft; the second is name_taken', async () => {
    const h = writable()
    const [first, second] = await Promise.allSettled([
      call<Journal>('create_journal', { payload: { name: 'Twin' } }),
      call<Journal>('create_journal', { payload: { name: 'Twin' } }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({ status: 'rejected', reason: new Error('name_taken') })
    expect(await h.db.drafts.list()).toHaveLength(1)
  })

  it('two concurrent create_tag of one name store one draft and answer the same tag', async () => {
    const h = writable()
    const [a, b] = await Promise.all([
      call<Tag>('create_tag', { name: 'twin' }),
      call<Tag>('create_tag', { name: 'twin' }),
    ])
    expect(b).toEqual(a)
    expect((await v3Drafts(h)).map(([key]) => key)).toEqual([`t-${a.id}`])
  })

  it('create_tag stores an upsert_tag create draft; an existing name returns that tag without a draft', async () => {
    const h = writable()
    const created = await call<Tag>('create_tag', { name: ' sea ', color: '#00aaff' })
    expect(created).toEqual({ id: expect.stringMatching(UUID), name: 'sea', color: '#00aaff' })
    expect(await v3Drafts(h)).toEqual([
      [
        `t-${created.id}`,
        'tag',
        {
          kind: 'upsert_tag',
          web_device_id: 'test-device-id',
          web_updated_at_secs: expect.any(Number),
          tag_id: created.id,
          name: 'sea',
          color: '#00aaff',
          base_updated_at: null,
        },
      ],
    ])
    expect(await call('list_tags')).toContainEqual(created)

    // Desktop `create_tag` is get-or-create: the same name answers the existing tag.
    expect(await call('create_tag', { name: 'alpha' })).toEqual(tag('t1', 'alpha'))
    expect(await call('create_tag', { name: 'sea' })).toEqual(created)
    expect(await h.db.drafts.list()).toHaveLength(1)

    // A deleted tag keeps its name on desktop: refused there, so refused here first.
    await expect(call('create_tag', { name: 'retired' })).rejects.toThrow('name_taken')
    await expect(call('create_tag', { name: '' })).rejects.toThrow()
    await expect(call('create_tag', { name: 'x', color: '#abc' })).rejects.toThrow()
    expect(await h.db.drafts.list()).toHaveLength(1)
  })

  it('create_template stores an upsert with a null base and sort order 0', async () => {
    const h = writable()
    const tpl = await call<Template>('create_template', {
      name: 'Gratitude',
      description: 'three things',
      content: [1, 2, 3],
    })
    expect(tpl).toMatchObject({
      name: 'Gratitude',
      description: 'three things',
      content: [1, 2, 3],
      is_predefined: false,
      sort_order: 0,
    })
    expect(await v3Drafts(h)).toEqual([
      [
        `p-${tpl.id}`,
        'template',
        {
          kind: 'upsert_template',
          web_device_id: 'test-device-id',
          web_updated_at_secs: expect.any(Number),
          template_id: tpl.id,
          name: 'Gratitude',
          description: 'three things',
          content_b64: 'AQID',
          sort_order: 0,
          base_updated_at: null,
        },
      ],
    ])
    expect((await call<Template[]>('list_templates')).map((t) => t.id)).toContain(tpl.id)
    expect(await call('get_template', { id: tpl.id })).toEqual(tpl)

    await call('create_template', { name: 'Bare' })
    const bare = (await v3Drafts(h)).find(([, , i]) => 'name' in i && i.name === 'Bare')
    expect(bare?.[2]).toMatchObject({ description: null, content_b64: null })
    await expect(call('create_template', { name: ' ' })).rejects.toThrow()
    await expect(
      call('create_template', { name: 'Big', description: 'é'.repeat(2049) }),
    ).rejects.toThrow()
  })

  it('update_template of a synced template carries its updated_at and keeps its sort order', async () => {
    const h = writable()
    const updated = await call<Template>('update_template', {
      id: TPL,
      name: 'Daily v2',
      description: null,
      content: [9],
    })
    expect(updated).toMatchObject({ id: TPL, name: 'Daily v2', sort_order: 4, content: [9] })
    expect((await v3Drafts(h))[0]).toEqual([
      `p-${TPL}`,
      'template',
      {
        kind: 'upsert_template',
        web_device_id: 'test-device-id',
        web_updated_at_secs: expect.any(Number),
        template_id: TPL,
        name: 'Daily v2',
        description: null,
        content_b64: 'CQ==',
        sort_order: 4,
        base_updated_at: 1700,
      },
    ])
    expect(await call('list_templates')).toEqual([updated])

    // A second edit keeps the first edit's base (the web's view of the desktop row).
    await call('update_template', { id: TPL, name: 'Daily v3' })
    expect((await v3Drafts(h))[0][2]).toMatchObject({ name: 'Daily v3', base_updated_at: 1700 })
  })

  it('update_template of a template created here stays a create (null base)', async () => {
    const h = writable()
    const tpl = await call<Template>('create_template', { name: 'Mine' })
    await call('update_template', { id: tpl.id, name: 'Mine 2' })
    const [[, , intent]] = await v3Drafts(h)
    expect(intent).toMatchObject({ kind: 'upsert_template', name: 'Mine 2', base_updated_at: null })
    await expect(call('update_template', { id: 'unknown', name: 'x' })).rejects.toThrow()
  })

  it('delete_template carries the synced updated_at; a template created here deletes from 0', async () => {
    const h = writable()
    await call('delete_template', { id: TPL })
    expect((await v3Drafts(h))[0][2]).toEqual({
      kind: 'delete_template',
      web_device_id: 'test-device-id',
      web_updated_at_secs: expect.any(Number),
      template_id: TPL,
      base_updated_at: 1700,
    })
    expect(await call('list_templates')).toEqual([])
    expect(await call('get_template', { id: TPL })).toBeNull()
    await expect(call('delete_template', { id: TPL })).rejects.toThrow()

    const mine = await call<Template>('create_template', { name: 'Mine' })
    await call('delete_template', { id: mine.id })
    const del = (await v3Drafts(h)).find(([k]) => k === `p-${mine.id}`)
    expect(del?.[2]).toMatchObject({ kind: 'delete_template', base_updated_at: 0 })
  })

  it('a pending create disappears from the lists once its draft is gone (reflected, acked or refused)', async () => {
    const h = writable()
    const j = await call<Journal>('create_journal', { payload: { name: 'Gone' } })
    const session = await readEnvSession()
    await h.db.drafts.delete(`j-${j.id}`)
    await session.refreshPendingV2?.()
    expect((await call<Journal[]>('list_journals')).map((x) => x.id)).not.toContain(j.id)
  })

  it('a pending create the synced files already show is not overlaid twice', async () => {
    const h = writable()
    const t = await call<Tag>('create_tag', { name: 'once' })
    // The desktop created it: the synced tags.bin now lists it.
    configureReadEnv({})
    const synced: Taxonomy = { ...SYNCED, tags: [...SYNCED.tags, t], knownTagIds: [t.id] }
    const h2 = installFakeSession([], { taxonomy: synced, outboxV2: true })
    for (const d of await h.db.drafts.list()) await h2.db.drafts.put(d)
    await (await readEnvSession()).refreshPendingV2?.()
    expect((await call<Tag[]>('list_tags')).filter((x) => x.id === t.id)).toHaveLength(1)
  })

  it('a pending rename and recolor overlay the journal and the tag at once, from the synced base', async () => {
    const h = writable()
    const renamed = await call<Journal>('update_journal', {
      payload: { id: J_SYNCED, name: ' Voyages ', color: '#112233' },
    })
    expect(renamed).toMatchObject({ id: J_SYNCED, name: 'Voyages', color: '#112233' })
    expect(await call('get_journal', { id: J_SYNCED })).toMatchObject({ name: 'Voyages' })
    // `autoTagIds` absent keeps the journal's auto tags.
    expect(await call('list_journal_auto_tags', { journalId: J_SYNCED })).toEqual([
      tag('t1', 'alpha'),
    ])
    expect(await call<Tag>('update_tag', { payload: { id: T_SYNCED, name: 'epsilon' } })).toEqual(
      tag(T_SYNCED, 'epsilon'),
    )
    expect((await call<Tag[]>('list_tags')).map((t) => t.name)).toContain('epsilon')
    expect((await call<Tag[]>('list_tags')).map((t) => t.name)).not.toContain('delta')
    const intents = Object.fromEntries((await v3Drafts(h)).map(([key, , i]) => [key, i]))
    expect(intents[`j-${J_SYNCED}`]).toMatchObject({
      kind: 'upsert_journal',
      name: 'Voyages',
      auto_tag_ids: ['t1'],
      base_updated_at: 1800,
    })
    expect(intents[`t-${T_SYNCED}`]).toMatchObject({
      kind: 'upsert_tag',
      name: 'epsilon',
      color: null,
      base_updated_at: 1900,
    })
    // A rename onto another journal's / tag's name is refused first.
    await expect(
      call('update_journal', { payload: { id: J_SYNCED, name: 'Journal j1' } }),
    ).rejects.toThrow('name_taken')
    await expect(
      call('update_tag', { payload: { id: T_SYNCED, name: 'retired' } }),
    ).rejects.toThrow('name_taken')
  })

  it('rename then delete before push leaves one j- draft: the delete, from the synced base', async () => {
    const h = writable()
    await call('update_journal', { payload: { id: J_SYNCED, name: 'Voyages' } })
    await call('delete_journal', { id: J_SYNCED })
    expect(await v3Drafts(h)).toEqual([
      [
        `j-${J_SYNCED}`,
        'journal',
        {
          kind: 'delete_journal',
          web_device_id: 'test-device-id',
          web_updated_at_secs: expect.any(Number),
          journal_id: J_SYNCED,
          base_updated_at: 1800,
        },
      ],
    ])
    expect((await call<Journal[]>('list_journals')).map((j) => j.id)).not.toContain(J_SYNCED)
    expect(await call('get_journal', { id: J_SYNCED })).toBeNull()
    // A deleted tag keeps its name taken, as on desktop.
    await call('delete_tag', { id: T_SYNCED })
    await expect(call('create_tag', { name: 'delta' })).rejects.toThrow('name_taken')
  })

  it('an edit of a journal created here stays a create until uploaded, then waits for the sync', async () => {
    const h = writable()
    const created = await call<Journal>('create_journal', { payload: { name: 'Fresh' } })
    const key = `j-${created.id}`
    await call('update_journal', { payload: { id: created.id, name: 'Fresher' } })
    expect((await v3Drafts(h))[0][2]).toMatchObject({ name: 'Fresher', base_updated_at: null })

    // Uploaded: a desktop that already created it would not apply a new name on a create.
    const stored = await h.db.drafts.get(key)
    const sealed = stored?.sealed ?? new Uint8Array()
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', sealed as Uint8Array<ArrayBuffer>),
    )
    const pushedHash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    // Its upload started: it may be on Drive though not marked pushed.
    await h.db.drafts.put({ ...stored!, uploadStarted: true })
    await expect(
      call('update_journal', { payload: { id: created.id, name: 'Later' } }),
    ).rejects.toThrow('retry_after_sync')
    await h.db.drafts.put({ ...stored!, pushedHash })
    await expect(
      call('update_journal', { payload: { id: created.id, name: 'Later' } }),
    ).rejects.toThrow('retry_after_sync')
    await expect(call('delete_journal', { id: created.id })).rejects.toThrow('retry_after_sync')

    // Unpushed, its delete just drops the create: nothing reaches the desktop.
    const tagCreated = await call<Tag>('create_tag', { name: 'brief' })
    await call('delete_tag', { id: tagCreated.id })
    expect(await h.db.drafts.get(`t-${tagCreated.id}`)).toBeUndefined()
    expect((await call<Tag[]>('list_tags')).map((t) => t.id)).not.toContain(tagCreated.id)
  })

  it('a rename or delete saved between the upload freshness check and markPushed never rewrites or drops the create', async () => {
    const h = writable()
    // One FIFO lock manager for the upload and the handlers, as `navigator.locks`.
    const tails = new Map<string, Promise<unknown>>()
    const locks: DraftLocksLike = {
      request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback)
        tails.set(
          name,
          run.catch(() => undefined),
        )
        return run
      },
    }
    configureTabsEnv({ draftLocks: locks })
    const journalId = (await call<Journal>('create_journal', { payload: { name: 'Fresh' } })).id
    const tagId = (await call<Tag>('create_tag', { name: 'brief' })).id
    const cases: Array<[string, () => Promise<unknown>]> = [
      [`j-${journalId}`, () => call('update_journal', { payload: { id: journalId, name: 'New' } })],
      [`t-${tagId}`, () => call('delete_tag', { id: tagId })],
    ]
    for (const [key, edit] of cases) {
      const sealed = (await h.db.drafts.get(key))?.sealed ?? new Uint8Array()
      let editing: Promise<unknown> = Promise.resolve()
      // The upload's critical section, as the real one: under the writer lock, after beforeWrite.
      mocks.safeUpload.mockImplementationOnce(async (_intents, deps: SafeUploadDeps) =>
        locks.request(WRITER_LOCK_NAME, async () => {
          expect(await deps.beforeWrite?.()).toBe(true)
          editing = edit()
          editing.catch(() => undefined)
          await new Promise((resolve) => setTimeout(resolve, 0))
          return []
        }),
      )
      const flushed = await createDraftManager({ db: h.db }).flush(
        key,
        [],
        {} as SafeUploadDeps,
        sealed,
      )
      expect(flushed, key).toBe('pushed')
      // The create is on Drive: a null-base rename or a dropped draft would be lost for good.
      await expect(editing, key).rejects.toThrow('retry_after_sync')
      const rec = await h.db.drafts.get(key)
      expect(rec?.sealed, key).toEqual(sealed)
      expect(rec?.pushedHash, key).toBe(await sha256Hex(sealed))
    }

    // An edit of an unsynced create waits for an upload batch that holds the writer lock, so it
    // never reads the create before the batch marks it and writes after.
    const fresh = (await call<Journal>('create_journal', { payload: { name: 'Other' } })).id
    const before = (await h.db.drafts.get(`j-${fresh}`))?.sealed
    let release = (): void => undefined
    void locks.request(WRITER_LOCK_NAME, () => new Promise<void>((r) => (release = r)))
    const renaming = call('update_journal', { payload: { id: fresh, name: 'Renamed' } })
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await h.db.drafts.get(`j-${fresh}`))?.sealed).toEqual(before)
    release()
    await renaming
    const renamed = (await v3Drafts(h)).find(([k]) => k === `j-${fresh}`)?.[2]
    expect(renamed).toMatchObject({ name: 'Renamed', base_updated_at: null })
  })

  it('delete_journal is refused on the web while the journal holds an entry it can see', async () => {
    const E_LIVE = '66666666-6666-4666-8666-666666666661'
    const E_TRASH = '66666666-6666-4666-8666-666666666662'
    const E_PENDING = '66666666-6666-4666-8666-666666666663'
    const cases: Array<[string, FakeSpec, boolean]> = [
      ['loaded entry', { id: E_LIVE, updatedAt: 10, journal: J_SYNCED }, false],
      ['desktop Trash row', { id: E_TRASH, updatedAt: 10, journal: J_SYNCED, trashedAt: 5 }, false],
      ['pending web trash', { id: E_PENDING, updatedAt: 10, journal: J_SYNCED }, true],
    ]
    for (const [label, spec, trashOnWeb] of cases) {
      configureReadEnv({})
      const h = writable(SYNCED, KINDS, [spec])
      if (spec.trashedAt === undefined) await h.vault.load([spec.id])
      if (trashOnWeb) await entryHandlers.soft_delete_entry({ id: spec.id })
      await expect(call('delete_journal', { id: J_SYNCED }), label).rejects.toThrow(
        'journal_not_empty',
      )
      expect(
        (await h.db.drafts.list()).filter((d) => d.entryId.startsWith('j-')),
        label,
      ).toEqual([])
    }
  })

  it('refuses every write as unsupported while no desktop advertises its kind (a v2-only one included), and read_only when writes are off', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [
      ['create_journal', { payload: { name: 'J' } }],
      ['update_journal', { payload: { id: J_SYNCED, name: 'J' } }],
      ['delete_journal', { id: J_SYNCED }],
      ['create_tag', { name: 'T' }],
      ['update_tag', { payload: { id: T_SYNCED, name: 'T' } }],
      ['delete_tag', { id: T_SYNCED }],
      ['create_template', { name: 'P' }],
      ['update_template', { id: TPL, name: 'P' }],
      ['delete_template', { id: TPL }],
    ]
    const h = writable(SYNCED, [])
    for (const [name, args] of writes) {
      await expect(call(name, args), name).rejects.toBeInstanceOf(WebUnsupportedError)
    }
    setWriteFlagForTest(false)
    for (const [name, args] of writes) {
      await expect(call(name, args), name).rejects.toThrow('read_only')
    }
    expect(await h.db.drafts.list()).toEqual([])
  })
})

async function readEnvSession() {
  const { readEnv } = await import('./readSession')
  return readEnv().session()
}

describe('readTaxonomy (merge across devices)', () => {
  function build(
    files: Record<string, unknown>,
    metaStore = new Map<string, MetaRecord>(),
  ): { db: WebDb; core: Core; metaStore: Map<string, MetaRecord> } {
    const enc = new TextEncoder()
    const db = {
      files: {
        paths: async () => Object.keys(files),
        get: async (path: string) => ({ ciphertext: enc.encode(JSON.stringify(files[path])) }),
      },
      meta: {
        listByPrefix: async (prefix: string) =>
          [...metaStore.values()].filter((r) => r.key.startsWith(prefix)),
        put: async (record: MetaRecord) => {
          metaStore.set(record.key, record)
        },
      },
    } as unknown as WebDb
    const core = { openDeviceBin: (_ring: KeyRing, bytes: Uint8Array) => bytes } as unknown as Core
    return { db, core, metaStore }
  }
  const ring = {} as KeyRing

  const journalFile = (device: string, patch: Record<string, unknown>) => ({
    journal_id: 'j1',
    device_id: device,
    name: 'Journal',
    color: null,
    sort_order: 1,
    is_deleted: false,
    created_at: 1,
    updated_at: 10,
    ...patch,
  })

  it('takes the newest journal copy and excludes locked and invisible journals', async () => {
    const { db, core } = build({
      'devA/journals/j1.bin': journalFile('devA', { name: 'Old', updated_at: 5 }),
      'devB/journals/j1.bin': journalFile('devB', {
        name: 'New',
        updated_at: 9,
        auto_tag_ids: ['t1'],
      }),
      'devA/journals/j2.bin': journalFile('devA', { journal_id: 'j2', is_locked: true }),
      'devA/journals/j3.bin': journalFile('devA', { journal_id: 'j3', is_invisible: true }),
      'devA/journals/j4.bin': journalFile('devA', { journal_id: 'j4', is_deleted: true }),
      '.meta/journals/zz.bin': journalFile('x', { journal_id: 'ignored' }),
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect(taxonomy.journals.map((j) => [j.id, j.name])).toEqual([['j1', 'New']])
    expect(taxonomy.journals[0]).not.toHaveProperty('autoTagIds')
    expect(taxonomy.autoTagIds.j1).toEqual(['t1'])
    expect(taxonomy.excludedJournalIds.sort()).toEqual(['j2', 'j3'])
  })

  it('lists the names of locked journals that are neither deleted nor invisible', async () => {
    const { db, core } = build({
      'devA/journals/j1.bin': journalFile('devA', { name: 'Open' }),
      'devA/journals/j2.bin': journalFile('devA', {
        journal_id: 'j2',
        name: 'Secret',
        is_locked: true,
      }),
      'devA/journals/j3.bin': journalFile('devA', {
        journal_id: 'j3',
        name: 'Hidden',
        is_locked: true,
        is_invisible: true,
      }),
      'devA/journals/j4.bin': journalFile('devA', {
        journal_id: 'j4',
        name: 'Gone',
        is_locked: true,
        is_deleted: true,
      }),
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect(taxonomy.lockedJournalNames).toEqual(['Secret'])
    expect(taxonomy.journals.map((j) => j.name)).toEqual(['Open'])
  })

  it('merges tags and templates by id and drops tombstones', async () => {
    const { db, core } = build({
      'devA/tags.bin': {
        tags: [
          { id: 't1', name: 'old', color: null, updated_at: 1, is_deleted: false },
          { id: 't2', name: 'gone', color: null, updated_at: 1, is_deleted: false },
        ],
      },
      'devB/tags.bin': {
        tags: [
          { id: 't1', name: 'new', color: '#fff', updated_at: 2, is_deleted: false },
          { id: 't2', name: 'gone', color: null, updated_at: 2, is_deleted: true },
        ],
      },
      'devA/templates.bin': {
        templates: [
          {
            id: 'tp',
            name: 'Tpl',
            description: 'd',
            content_b64: 'AQID',
            sort_order: 3,
            created_at: 4,
            updated_at: 1,
            is_deleted: false,
          },
        ],
      },
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect(taxonomy.tags).toEqual([{ id: 't1', name: 'new', color: '#fff' }])
    expect(taxonomy.templates).toEqual([
      {
        id: 'tp',
        name: 'Tpl',
        description: 'd',
        content: [1, 2, 3],
        is_predefined: false,
        sort_order: 3,
        created_at: 4,
      },
    ])
  })

  it('lists every tag id (live or deleted) and the deleted template ids', async () => {
    const tpl = (id: string, updated_at: number, is_deleted: boolean): Record<string, unknown> => ({
      id,
      name: id,
      description: null,
      content_b64: null,
      sort_order: 0,
      created_at: 0,
      updated_at,
      is_deleted,
    })
    const { db, core } = build({
      'devA/tags.bin': {
        tags: [
          { id: 't1', name: 'a', color: null, updated_at: 1, is_deleted: false },
          { id: 't2', name: 'b', color: null, updated_at: 1, is_deleted: true },
        ],
      },
      'devA/templates.bin': { templates: [tpl('p1', 1, false), tpl('p2', 2, true)] },
      'devB/templates.bin': { templates: [tpl('p1', 3, true), tpl('p2', 1, false)] },
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect([...taxonomy.knownTagIds].sort()).toEqual(['t1', 't2'])
    expect([...taxonomy.deletedTemplateIds].sort()).toEqual(['p1', 'p2'])
    expect(taxonomy.templates).toEqual([])
  })

  it('rejects when the cache itself cannot be read (not one bad file)', async () => {
    const { db, core } = build({ 'devA/journals/j1.bin': journalFile('devA', {}) })
    db.files.get = async () => {
      throw new Error('idb unavailable')
    }
    await expect(readTaxonomy(db, core, ring)).rejects.toThrow('idb unavailable')
  })

  describe('journal lock state is rollback-protected', () => {
    const SEEN = 'journal-seen:j1'
    const seenOf = (store: Map<string, MetaRecord>): unknown => store.get(SEEN)?.value

    it('records the first sight of a locked journal', async () => {
      const { db, core, metaStore } = build({
        'devA/journals/j1.bin': journalFile('devA', { is_locked: true, updated_at: 10 }),
      })
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['j1'])
      expect(seenOf(metaStore)).toBe('10:1:0')
    })

    it('keeps a journal excluded when the cloud copy is rolled back to an older unlocked one', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '20:1:0' }]])
      const { db, core } = build(
        { 'devA/journals/j1.bin': journalFile('devA', { updated_at: 10 }) },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['j1'])
      expect(taxonomy.journals).toEqual([])
      expect(seenOf(store)).toBe('20:1:0')
    })

    it('keeps a journal excluded when its file was deleted', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '20:0:1' }]])
      const { db, core } = build({}, store)
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['j1'])
      expect(taxonomy.knownJournalIds).toEqual(['j1'])
    })

    it('reports an unknown journal id as not known, and a seen unlocked one as known', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '5:0:0' }]])
      const { db, core } = build(
        { 'devA/journals/j2.bin': journalFile('devA', { journal_id: 'j2' }) },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect([...taxonomy.knownJournalIds].sort()).toEqual(['j1', 'j2'])
      expect(taxonomy.excludedJournalIds).toEqual([])
      expect(taxonomy.knownJournalIds).not.toContain('j3')
    })

    it('a legitimate newer unlock re-admits the journal and updates the record', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '20:1:0' }]])
      const { db, core } = build(
        { 'devA/journals/j1.bin': journalFile('devA', { updated_at: 30 }) },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual([])
      expect(taxonomy.journals.map((j) => j.id)).toEqual(['j1'])
      expect(seenOf(store)).toBe('30:0:0')
    })

    it('ignores a damaged record and survives ids named like Object.prototype keys', async () => {
      const store = new Map<string, MetaRecord>([
        [SEEN, { key: SEEN, value: 'garbage' }],
        ['journal-seen:__proto__', { key: 'journal-seen:__proto__', value: '9:1:0' }],
      ])
      const { db, core } = build(
        {
          'devA/journals/j1.bin': journalFile('devA', {}),
          'devA/journals/p.bin': journalFile('devA', {
            journal_id: 'constructor',
            auto_tag_ids: ['t1'],
          }),
        },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['__proto__'])
      expect(taxonomy.autoTagIds.constructor).toEqual(['t1'])
      expect(Object.getPrototypeOf(taxonomy.autoTagIds)).toBeNull()
    })
  })
})
