import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import desktopSchema from './__fixtures__/desktop-schema.json'
import vaultFixture from './__fixtures__/desktop-vault-yjs.json'
import { buildMobileExtensions } from './extensions'
import { schemaDifferences, snapshotSchema } from './schemaSnapshot'

// Safety contract 4 (plan phase 15.3, test 2): the mobile editor must never
// mutate an entry document just by opening it. y-prosemirror rewrites the
// Y.Doc whenever the editor schema cannot hold what it reads, so this also
// guards the schema parity with desktop.

const RICH_ENTRY = resolve(
  __dirname,
  '../../src-tauri/crates/memlore-engine/tests/fixtures/apple-journal/expected/rich-entry.update.bin',
)

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Every node and mark type in a ProseMirror JSON tree. */
function contentTypes(node: JSONContent, out = new Set<string>()): Set<string> {
  if (node.type) out.add(node.type)
  for (const mark of node.marks ?? []) out.add(mark.type)
  for (const child of node.content ?? []) contentTypes(child, out)
  return out
}

// Each document with the node and mark types the editor must render from it.
const documents: [name: string, bytes: Uint8Array, expectedTypes: string[]][] = [
  [
    'Apple Journal rich entry',
    new Uint8Array(readFileSync(RICH_ENTRY)),
    [
      ...['paragraph', 'heading', 'bulletList', 'listItem', 'image'],
      ...['bold', 'italic', 'underline', 'strike', 'highlight', 'link'],
    ],
  ],
  ['empty body written by create_entry', fromBase64(vaultFixture.created_empty), ['paragraph']],
  ...Object.entries(vaultFixture.entries).map(
    ([id, b64]): [string, Uint8Array, string[]] => [
      `desktop-vault.v1 entry ${id} (Y.Text "content", no fragment)`,
      fromBase64(b64),
      ['paragraph'],
    ],
  ),
]

describe('mobile editor', () => {
  it('has exactly the desktop schema (node, mark and attribute names and defaults)', () => {
    const mobile = snapshotSchema(getSchema(buildMobileExtensions()))
    expect(schemaDifferences(desktopSchema.schema, mobile)).toEqual([])
  })

  it.each(documents)('opening never mutates the document: %s', async (_name, bytes, types) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, bytes)
    const fragment = doc.getXmlFragment('default')
    const stateVector = Y.encodeStateVector(doc)
    const xml = fragment.toString()
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))

    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: [
        ...buildMobileExtensions(),
        Collaboration.configure({ document: doc, field: 'default' }),
      ],
    })
    editors.push(editor)
    // y-prosemirror renders the Y.Doc into the editor in a macrotask.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Positive control: the binding exists and rendered the document.
    expect(ySyncPluginKey.getState(editor.state)?.binding).toBeTruthy()
    const rendered = contentTypes(editor.getJSON())
    for (const type of types) expect(rendered).toContain(type)

    expect(updates).toHaveLength(0)
    expect(Y.encodeStateVector(doc)).toEqual(stateVector)
    expect(fragment.toString()).toBe(xml)
  })
})
