import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor, Range } from '@tiptap/react'
import { i18n } from '../../lib/i18n'
import { buildSlashMenuItems, type SlashMenuItem, type SlashMenuItemKey } from './SlashMenu'

/** Monday, 13 April 2026 at 14:30 local — same pin as slashDateTime.test.ts. */
const PINNED = new Date(2026, 3, 13, 14, 30, 0)
const RANGE: Range = { from: 1, to: 2 }

function mockEditor(inserted: string[] = []): Editor {
  const chain = {
    focus() {
      return this
    },
    deleteRange(_range: Range) {
      return this
    },
    insertContent(text: string) {
      inserted.push(text)
      return this
    },
    run() {
      return true
    },
  }
  return { chain: () => chain } as unknown as Editor
}

function itemByKey(items: SlashMenuItem[], key: SlashMenuItemKey): SlashMenuItem {
  const item = items.find((candidate) => candidate.key === key)
  if (!item) throw new Error(`missing slash item ${key}`)
  return item
}

describe('buildSlashMenuItems datetime commands', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(PINNED)
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('inserts English date/time text at command execution time', () => {
    const inserted: string[] = []
    const editor = mockEditor(inserted)
    const items = buildSlashMenuItems(editor, i18n.getFixedT('en', 'editor'))
    const run = (key: SlashMenuItemKey) => itemByKey(items, key).command({ editor, range: RANGE })

    run('today')
    run('today-full')
    run('yesterday')
    run('yesterday-full')
    run('tomorrow')
    run('tomorrow-full')
    run('time')
    run('now')

    expect(inserted).toEqual([
      '2026-04-13',
      'Monday, 2026-04-13',
      '2026-04-12',
      'Sunday, 2026-04-12',
      '2026-04-14',
      'Tuesday, 2026-04-14',
      '14:30',
      '2026-04-13 14:30',
    ])
  })

  it('formats Vietnamese dates from i18n.language when the command runs', async () => {
    await i18n.changeLanguage('vi')
    const inserted: string[] = []
    const editor = mockEditor(inserted)
    const items = buildSlashMenuItems(editor, i18n.getFixedT('vi', 'editor'))
    itemByKey(items, 'today').command({ editor, range: RANGE })
    itemByKey(items, 'now').command({ editor, range: RANGE })
    expect(inserted).toEqual(['13-04-2026', '13-04-2026 14:30'])
  })

  it('formats against new Date() at click time, not menu-build time', () => {
    const inserted: string[] = []
    const editor = mockEditor(inserted)
    const items = buildSlashMenuItems(editor, i18n.getFixedT('en', 'editor'))
    vi.setSystemTime(new Date(2026, 3, 15, 9, 5, 0))
    itemByKey(items, 'today').command({ editor, range: RANGE })
    expect(inserted).toEqual(['2026-04-15'])
  })
})
