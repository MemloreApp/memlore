// Generates src-tauri/crates/memlore-engine/tests/fixtures/mobile-editor/append-paragraph.update.bin
// (plan phase 15.3, test 3): open the Apple Journal rich entry in the MOBILE
// editor (its extension set + Collaboration on `default`, under happy-dom),
// append the paragraph "mobile edit" through the editor, and write the full
// state the editor would save (`Y.encodeStateAsUpdate`, what `saveEntryYjs`
// receives). The Rust test `yjs_doc::tests::mobile_editor_update_merges_into_desktop_doc`
// merges it into the original document with yrs.
//
// FROZEN: generated once on 2026-10-25 with TipTap 3.22.4, @tiptap/y-tiptap
// 3.0.3 and yjs 13.6.30. Never regenerate it to make the Rust test pass; a
// failure there means the mobile editor or the merge broke the format.
// Regenerate only for a deliberate, reviewed change (the bytes differ on every
// run: Yjs client ids are random). Refuses to overwrite unless
// MEMLORE_REGEN_FIXTURES=1:
//
//   MEMLORE_REGEN_FIXTURES=1 pnpm --dir mobile exec node scripts/gen-mobile-editor-fixture.ts
//
// Needs Node >= 22.18 (TypeScript type stripping on by default).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../../src-tauri/crates/memlore-engine/tests/fixtures')
const source = resolve(fixtures, 'apple-journal/expected/rich-entry.update.bin')
const dest = resolve(fixtures, 'mobile-editor/append-paragraph.update.bin')

if (existsSync(dest) && process.env.MEMLORE_REGEN_FIXTURES !== '1') {
  console.error(`${dest} exists and is frozen; set MEMLORE_REGEN_FIXTURES=1 to regenerate`)
  process.exit(1)
}

// ProseMirror needs a DOM; expose happy-dom's globals before TipTap loads.
const window = new Window()
const globals = globalThis as Record<string, unknown>
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) globals[key] = (window as unknown as Record<string, unknown>)[key]
}
globals.window = window

const { Editor } = await import('@tiptap/core')
const { default: Collaboration } = await import('@tiptap/extension-collaboration')
const Y = await import('yjs')
const { buildMobileExtensions } = await import('../editor/extensions.ts')

const doc = new Y.Doc()
Y.applyUpdate(doc, new Uint8Array(readFileSync(source)))
const element = window.document.createElement('div')
window.document.body.appendChild(element)
const editor = new Editor({
  element: element as unknown as HTMLElement,
  extensions: [
    ...buildMobileExtensions(),
    Collaboration.configure({ document: doc, field: 'default' }),
  ],
})
// y-prosemirror renders the Y.Doc into the editor in a macrotask.
await new Promise((done) => setTimeout(done, 50))

editor.commands.insertContentAt(editor.state.doc.content.size, {
  type: 'paragraph',
  content: [{ type: 'text', text: 'mobile edit' }],
})
await new Promise((done) => setTimeout(done, 50))

const last = doc.getXmlFragment('default').toArray().at(-1)
if (!(last instanceof Y.XmlElement) || last.toString() !== '<paragraph>mobile edit</paragraph>') {
  throw new Error(`the editor did not append the paragraph: ${String(last)}`)
}

mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, Y.encodeStateAsUpdate(doc))
console.log(`wrote ${dest}`)
editor.destroy()
await window.happyDOM.close()
