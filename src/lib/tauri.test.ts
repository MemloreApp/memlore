import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import {
  changeInvisibleVaultPassword,
  changeSecondLockPassword,
  disableSecondLock,
  getTagsForEntries,
  getTagsWithCounts,
  listTags,
  openOrCreateInvisibleVault,
  removeEmptyInvisibleVaults,
  importData,
  previewAppleJournalImport,
  writeAppleJournalImportReport,
  type ImportFormat,
  type ImportSummary,
  searchEntries,
  semanticSearch,
  setEntryLocked,
  setEntryInvisible,
  setJournalLocked,
  setJournalInvisible,
  setSecondLockPassword,
  SYNC_RECOVERY_STATUS_EVENT,
  verifySecondLockPassword,
} from './tauri'

describe('second lock wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('invokes password commands with camelCase payloads', async () => {
    await setSecondLockPassword('secret')
    await changeSecondLockPassword('old', 'new')
    await verifySecondLockPassword('secret')
    await disableSecondLock('secret')

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_second_lock_password', { password: 'secret' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'change_second_lock_password', {
      oldPassword: 'old',
      newPassword: 'new',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'verify_second_lock_password', {
      password: 'secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(4, 'disable_second_lock', { password: 'secret' })
  })

  it('invokes lock toggles with entry and journal ids', async () => {
    await setEntryLocked('entry-1', true)
    await setJournalLocked('journal-1', false)

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_entry_locked', {
      entryId: 'entry-1',
      locked: true,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_journal_locked', {
      journalId: 'journal-1',
      locked: false,
    })
  })
})

describe('invisible lock wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('invokes open-or-create / change / remove-empty with backend payloads', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce('vault-a')
      .mockResolvedValueOnce('vault-b')
      .mockResolvedValueOnce(undefined)

    await expect(openOrCreateInvisibleVault('secret')).resolves.toBe('vault-a')
    await expect(changeInvisibleVaultPassword('vault-a', 'old', 'new-secret')).resolves.toBe(
      'vault-b',
    )
    await removeEmptyInvisibleVaults()

    expect(invoke).toHaveBeenNthCalledWith(1, 'open_or_create_invisible_vault', {
      password: 'secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'change_invisible_vault_password', {
      vaultId: 'vault-a',
      current: 'old',
      new: 'new-secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'remove_empty_invisible_vaults')
  })

  it('invokes invisible toggles with entry/journal ids and activeVaultId', async () => {
    await setEntryInvisible('entry-1', true, 'vault-a')
    await setJournalInvisible('journal-1', false, null)

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_entry_invisible', {
      entryId: 'entry-1',
      invisible: true,
      activeVaultId: 'vault-a',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_journal_invisible', {
      journalId: 'journal-1',
      invisible: false,
      activeVaultId: null,
    })
  })
})

describe('tag wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue({})
  })

  it('invokes get_tags_for_entries with camelCase ids and activeVaultId', async () => {
    await getTagsForEntries(['entry-1', 'entry-2'])
    await getTagsForEntries(['entry-3'], 'vault-a')

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_tags_for_entries', {
      entryIds: ['entry-1', 'entry-2'],
      activeVaultId: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_tags_for_entries', {
      entryIds: ['entry-3'],
      activeVaultId: 'vault-a',
    })
  })

  it('invokes list_tags with activeVaultId', async () => {
    await listTags()
    await listTags('vault-a')

    expect(invoke).toHaveBeenNthCalledWith(1, 'list_tags', { activeVaultId: null })
    expect(invoke).toHaveBeenNthCalledWith(2, 'list_tags', { activeVaultId: 'vault-a' })
  })

  it('invokes get_tags_with_counts with activeVaultId', async () => {
    await getTagsWithCounts()
    await getTagsWithCounts('vault-a')

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_tags_with_counts', { activeVaultId: null })
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_tags_with_counts', {
      activeVaultId: 'vault-a',
    })
  })
})

describe('search wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue([])
  })

  // `mention_mode` is a plain `bool` on the Rust side, not an `Option`, so a
  // missing or misspelled key fails argument deserialization at runtime and
  // breaks every entry search. `tsc` cannot see across the IPC boundary.
  it('invokes entry search with mentionMode defaulted to false', async () => {
    await searchEntries('query')

    expect(invoke).toHaveBeenCalledWith('search_entries', {
      query: 'query',
      filters: undefined,
      lockedView: 'revealed',
      activeVaultId: null,
      mentionMode: false,
    })
  })

  it('invokes entry search with mentionMode enabled', async () => {
    await searchEntries('query', undefined, 'hidden', 'vault-a', true)

    expect(invoke).toHaveBeenCalledWith('search_entries', {
      query: 'query',
      filters: undefined,
      lockedView: 'hidden',
      activeVaultId: 'vault-a',
      mentionMode: true,
    })
  })

  it('invokes semantic search with the locked-view and activeVaultId', async () => {
    await semanticSearch('query', 20, undefined, 'hidden', 'vault-a')

    expect(invoke).toHaveBeenCalledWith('semantic_search', {
      query: 'query',
      limit: 20,
      filters: undefined,
      lockedView: 'hidden',
      activeVaultId: 'vault-a',
    })
  })
})

describe('sync recovery wrappers', () => {
  it('uses a stable recovery status event name', () => {
    expect(SYNC_RECOVERY_STATUS_EVENT).toBe('sync:recovery-status-changed')
  })
})

describe('importData', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const existingFormats: ImportFormat[] = [
    'memlore_zip',
    'markdown_folder',
    'plain_text_folder',
    'dayone_zip',
    'journey_zip',
  ]

  it('forwards existing format wire names unchanged', async () => {
    vi.mocked(invoke).mockResolvedValue({ imported: 1, skippedDuplicates: 0, errors: [] })
    for (const format of existingFormats) {
      await importData('/tmp/src', format, 'merge_newer', null)
      expect(invoke).toHaveBeenCalledWith('import_data', {
        src: '/tmp/src',
        format,
        mode: 'merge_newer',
        journalId: null,
      })
    }
  })

  it('accepts apple_journal_folder and an additive apple report', async () => {
    const summary: ImportSummary = {
      imported: 2,
      skippedDuplicates: 0,
      errors: [],
      warnings: [{ kind: 'no_thumbnail', message: 'kept original' }],
      apple: {
        entriesImported: 2,
        entriesFailed: 0,
        resourcesReferenced: 3,
        resourcesImported: 2,
        resourcesMissing: 1,
        resourcesUnsupported: 0,
        resourcesUnreferenced: 0,
        entriesSkippedExact: 1,
        entriesSourceChanged: 2,
      },
    }
    vi.mocked(invoke).mockResolvedValue(summary)

    const result = await importData(
      '/tmp/apple-export',
      'apple_journal_folder',
      'merge_newer',
      'journal-1',
    )

    expect(invoke).toHaveBeenCalledWith('import_data', {
      src: '/tmp/apple-export',
      format: 'apple_journal_folder',
      mode: 'merge_newer',
      journalId: 'journal-1',
    })
    expect(result.imported).toBe(2)
    expect(result.apple?.entriesImported).toBe(2)
    expect(result.apple?.resourcesMissing).toBe(1)
    expect(result.apple?.entriesSkippedExact).toBe(1)
    expect(result.apple?.entriesSourceChanged).toBe(2)
    expect(result.warnings?.[0]?.kind).toBe('no_thumbnail')
  })

  it('forwards optional Apple import options only when provided', async () => {
    vi.mocked(invoke).mockResolvedValue({ imported: 1, skippedDuplicates: 0, errors: [] })

    await importData('/tmp/apple-export', 'apple_journal_folder', 'merge_newer', 'journal-1', {
      conversionTimezone: 'Europe/Berlin',
      expectedSourceHash: 'hash-abc',
    })

    expect(invoke).toHaveBeenCalledWith('import_data', {
      src: '/tmp/apple-export',
      format: 'apple_journal_folder',
      mode: 'merge_newer',
      journalId: 'journal-1',
      options: {
        conversionTimezone: 'Europe/Berlin',
        expectedSourceHash: 'hash-abc',
      },
    })
  })
})

describe('previewAppleJournalImport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes preview_apple_journal_import with src and optional options', async () => {
    const preview = {
      sourceHash: 'hash-abc',
      conversionTimezone: 'Europe/Berlin',
      datePolicy: 'html_visible' as const,
      datePrecision: 'date_only' as const,
      clockIsSynthetic: true,
      entries: 2,
      resourcesReferenced: 3,
      resourcesWouldImport: 3,
      resourcesMissing: 0,
      resourcesUnsupported: 0,
      resourcesUnreferenced: 0,
      warnings: [] as { kind: string; message: string }[],
    }
    vi.mocked(invoke).mockResolvedValue(preview)

    const result = await previewAppleJournalImport('/tmp/apple-export', {
      conversionTimezone: 'Europe/Berlin',
    })

    expect(invoke).toHaveBeenCalledWith('preview_apple_journal_import', {
      src: '/tmp/apple-export',
      options: { conversionTimezone: 'Europe/Berlin' },
    })
    expect(result.sourceHash).toBe('hash-abc')
    expect(result.entries).toBe(2)
    expect(result.clockIsSynthetic).toBe(true)
    expect(result.datePolicy).toBe('html_visible')
  })
})

describe('writeAppleJournalImportReport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes write_apple_journal_import_report with dest, text, and source', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)

    await writeAppleJournalImportReport(
      '/tmp/memlore-apple-journal-import-report.txt',
      'report body',
      '/export-a',
    )

    expect(invoke).toHaveBeenCalledWith('write_apple_journal_import_report', {
      dest: '/tmp/memlore-apple-journal-import-report.txt',
      text: 'report body',
      source: '/export-a',
    })
  })
})
