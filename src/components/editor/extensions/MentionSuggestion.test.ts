import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { invoke } from '@tauri-apps/api/core'
import { EmojiShortcodes } from './EmojiShortcodes'
import { Mention } from './Mention'
import { MentionSuggestion } from './MentionSuggestion'
import { SlashMenuExtension } from './SlashMenu'
import {
  __resetMentionIncludeLockedForTests,
  setMentionIncludeLocked,
} from '../../../hooks/useMentionIncludeLocked'
import { useInvisibleLockStore } from '../../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../../stores/secondLockStore'
import type { MentionCandidate } from '../../../lib/mentionSearch'
import type { SearchResult } from '../../../types/entry'

const renderSpy = vi.hoisted(() => vi.fn())
const createRootSpy = vi.hoisted(() => vi.fn(() => ({ render: renderSpy, unmount: () => {} })))

// Read what the menu is *driven with* instead of asserting on the DOM: the
// mocked root captures the `createElement(MentionMenu, props)` element.
vi.mock('react-dom/client', () => ({ createRoot: createRootSpy }))

const mockedInvoke = vi.mocked(invoke)

const makeResult = (id: string): SearchResult => ({
  id,
  journal_id: 'j1',
  title: `Entry ${id}`,
  preview_text: null,
  entry_date: 1_700_000_000,
})

interface MenuProps {
  items: MentionCandidate[]
  isLoading: boolean
  onSelect: (index: number) => void
}

type RenderedElement = { props: MenuProps } | null

function lastMenuProps(): MenuProps {
  const element = renderSpy.mock.lastCall?.[0] as RenderedElement | undefined
  return element?.props ?? { items: [], isLoading: false, onSelect: () => {} }
}

const lastMenuItems = (): MentionCandidate[] => lastMenuProps().items

let editor: Editor | null = null

function mountEditor(): Editor {
  editor = new Editor({ extensions: [StarterKit, Mention, MentionSuggestion] })
  return editor
}

beforeEach(() => {
  vi.useFakeTimers()
  mockedInvoke.mockImplementation(async () => null)
  __resetMentionIncludeLockedForTests()
  useSecondLockStore.setState({ isEnabled: false, isSessionUnlocked: false, showExistence: false })
  useInvisibleLockStore.setState({ activeVaultId: null })
})

afterEach(() => {
  editor?.destroy()
  editor = null
  vi.runAllTimers()
  vi.useRealTimers()
  renderSpy.mockReset()
  createRootSpy.mockClear()
  mockedInvoke.mockReset()
})

describe('MentionSuggestion', () => {
  // Three suggestion plugins now share one editor. Without distinct
  // `pluginKey`s ProseMirror throws `RangeError: Adding different instances of
  // a keyed plugin (suggestion$)` and takes the whole <Editor> tree down — the
  // two-extension test in EmojiShortcodes.test.ts cannot catch a third clash.
  it('mounts alongside Mention, SlashMenuExtension and EmojiShortcodes', () => {
    expect(
      () =>
        new Editor({
          extensions: [StarterKit, Mention, MentionSuggestion, SlashMenuExtension, EmojiShortcodes],
        }),
    ).not.toThrow()
  })

  it('ignores a stale response that arrives after a newer one', async () => {
    const pending = new Map<string, (results: SearchResult[]) => void>()
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd !== 'search_entries') return null
      const { query } = args as { query: string }
      return new Promise<SearchResult[]>((resolve) => pending.set(query, resolve))
    })
    const resolveSearch = (query: string, results: SearchResult[]) => {
      const resolve = pending.get(query)
      if (!resolve) throw new Error(`no in-flight search for "${query}"`)
      resolve(results)
    }

    const instance = mountEditor()
    instance.commands.insertContent('@h')
    // Past the debounce, so request #1 really reaches the backend before the
    // query grows — otherwise the debounce alone would hide a broken guard.
    await vi.advanceTimersByTimeAsync(200)
    instance.commands.insertContent('u')
    await vi.advanceTimersByTimeAsync(200)
    expect(pending.has('h')).toBe(true)
    expect(pending.has('hu')).toBe(true)
    // The superseded query released the menu without results — it must report
    // itself as loading so MentionMenu hides instead of flashing "no results".
    expect(lastMenuProps()).toMatchObject({ items: [], isLoading: true })

    resolveSearch('hu', [makeResult('new')])
    await vi.waitFor(() => expect(lastMenuItems().map((i) => i.id)).toEqual(['new']))

    resolveSearch('h', [makeResult('stale')])
    await vi.advanceTimersByTimeAsync(200)
    expect(lastMenuItems().map((i) => i.id)).toEqual(['new'])
  })
})

// Candidates are fetched under one lock state and picked later. The auto-lock
// can re-engage in between (useSecondLockAutoLock), and inserting then would
// write a now-protected title into a plain entry's text.
describe('MentionSuggestion lock re-check', () => {
  async function openMenuWithUnlockedResult(): Promise<Editor> {
    await setMentionIncludeLocked(true)
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })
    mockedInvoke.mockImplementation(async (cmd) =>
      cmd === 'search_entries' ? [makeResult('locked')] : null,
    )

    const instance = mountEditor()
    instance.commands.insertContent('@trip')
    await vi.advanceTimersByTimeAsync(200)
    expect(lastMenuItems().map((i) => i.id)).toEqual(['locked'])
    return instance
  }

  it('inserts the picked mention while the lock state is unchanged', async () => {
    const instance = await openMenuWithUnlockedResult()

    lastMenuProps().onSelect(0)

    expect(instance.getHTML()).toContain('data-label="Entry locked"')
  })

  it('refuses to insert when the second lock re-engaged since the fetch', async () => {
    const instance = await openMenuWithUnlockedResult()

    useSecondLockStore.setState({ isSessionUnlocked: false })
    lastMenuProps().onSelect(0)

    expect(instance.getHTML()).not.toContain('data-type="mention"')
    expect(instance.getText()).toContain('@trip')
  })

  it('refuses to insert when the open vault changed since the fetch', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-1' })
    const instance = await openMenuWithUnlockedResult()

    useInvisibleLockStore.setState({ activeVaultId: null })
    lastMenuProps().onSelect(0)

    expect(instance.getHTML()).not.toContain('data-type="mention"')
  })

  // Blocking the insert is not enough: whoever is looking at the screen after
  // the auto-lock fires must not keep reading a title the lock just revoked.
  it('clears the open menu when the second lock re-engages', async () => {
    await openMenuWithUnlockedResult()

    useSecondLockStore.setState({ isSessionUnlocked: false })

    expect(lastMenuItems()).toEqual([])
  })

  it('clears the open menu when the open vault changes', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-1' })
    await openMenuWithUnlockedResult()

    useInvisibleLockStore.setState({ activeVaultId: null })

    expect(lastMenuItems()).toEqual([])
  })

  // A lock landing mid-search must discard the results without stranding the
  // menu: `isLoading` left raised renders nothing at all, so the user sees a
  // dead popup instead of the empty state.
  it('discards a search that resolves after the lock re-engaged, and stops loading', async () => {
    await setMentionIncludeLocked(true)
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })

    let resolveSearch: ((results: SearchResult[]) => void) | null = null
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd !== 'search_entries') return null
      return new Promise<SearchResult[]>((resolve) => {
        resolveSearch = resolve
      })
    })

    mountEditor().commands.insertContent('@trip')
    await vi.advanceTimersByTimeAsync(200)
    expect(resolveSearch).not.toBeNull()

    // The auto-lock fires while the query is still on the wire.
    useSecondLockStore.setState({ isSessionUnlocked: false })
    resolveSearch!([makeResult('locked')])
    await vi.advanceTimersByTimeAsync(200)

    expect(lastMenuProps()).toMatchObject({ items: [], isLoading: false })
  })
})
