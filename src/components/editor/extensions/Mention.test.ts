import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Mention } from './Mention'

describe('Mention', () => {
  // The stored `id`/`label` attrs are the whole payload of a mention — they ride
  // in the Yjs doc and are re-parsed from HTML by VersionHistoryModal /
  // EntryPreviewModal, so a one-way serialisation would silently drop mentions.
  it('round-trips id and label through HTML', () => {
    const editor = new Editor({ extensions: [StarterKit, Mention] })
    editor.commands.insertMention({ id: 'e1', label: 'Trip to Paris' })

    const html = editor.getHTML()
    expect(html).toContain('data-type="mention"')
    expect(html).toContain('data-id="e1"')
    expect(html).toContain('data-label="Trip to Paris"')

    editor.commands.setContent(html)
    const attrs: Record<string, unknown>[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'mention') attrs.push(node.attrs)
    })
    expect(attrs).toEqual([{ id: 'e1', label: 'Trip to Paris' }])
    editor.destroy()
  })
})
