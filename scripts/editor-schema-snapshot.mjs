#!/usr/bin/env node
// Snapshot the desktop editor's ProseMirror schema into
// mobile/editor/__fixtures__/desktop-schema.json so the mobile editor can prove
// it carries the same schema (frozen Yjs entry format; plan phase 15.1).
//
//   node scripts/editor-schema-snapshot.mjs           write the snapshot
//   node scripts/editor-schema-snapshot.mjs --check   exit 1 when it is stale
//
// sharedExtensions.ts imports .tsx NodeViews and extensionless paths, which
// plain Node cannot load, so the desktop modules go through Vite's SSR loader
// (root deps only). HMR and its websocket are off so nothing binds a port next
// to a running `pnpm tauri dev`. Every conditional extension is turned on: the
// mobile editor must carry the superset schema.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { getSchema } from '@tiptap/core'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'mobile/editor/__fixtures__/desktop-schema.json')
const EDITOR_DIR = '/src/components/editor'
const EDITOR_FILE = `${EDITOR_DIR}/Editor.tsx`
const check = process.argv.includes('--check')

/** Text of the `extensions: [...]` array inside `useEditor(` in Editor.tsx. */
function extensionsArraySource(source) {
  const start = source.indexOf('extensions: [', source.indexOf('useEditor('))
  if (start < 0) throw new Error(`${EDITOR_FILE}: no \`extensions: [\` inside useEditor(`)
  let depth = 0
  for (let i = source.indexOf('[', start); i < source.length; i++) {
    if ('([{'.includes(source[i])) depth++
    if (')]}'.includes(source[i])) depth--
    if (depth === 0) return source.slice(source.indexOf('[', start) + 1, i)
  }
  throw new Error(`${EDITOR_FILE}: unbalanced extensions array`)
}

/** Top-level comma-separated elements of an array literal body. */
function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Drop call arguments (`.configure({...})`, `fn(...)`) but keep grouping parens. */
function stripCallArgs(text) {
  let out = ''
  let skipDepth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (skipDepth > 0) {
      if (ch === '(') skipDepth++
      if (ch === ')') skipDepth--
      continue
    }
    if (ch === '(' && /[\w$]/.test(text[i - 1] ?? '')) {
      skipDepth = 1
      continue
    }
    out += ch
  }
  return out
}

/** `{ localName: moduleSpecifier }` for every named/default import in a file. */
function importMap(source) {
  const map = {}
  for (const m of source.matchAll(/import\s+(?!type\b)([^;]+?)\s+from\s+'([^']+)'/g)) {
    const clause = m[1]
    const named = clause.match(/\{([^}]*)\}/)
    const defaultName = clause
      .replace(/\{[^}]*\}/, '')
      .replace(',', '')
      .trim()
    if (defaultName) map[defaultName] = m[2]
    for (const part of named?.[1].split(',') ?? []) {
      const name = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        .trim()
      if (name) map[name] = m[2]
    }
  }
  return map
}

/** The extensions Editor.tsx adds on top of buildSharedExtensions, re-read from source. */
function editorOnlyEntries(source) {
  const imports = importMap(source)
  const entries = []
  for (const element of splitTopLevel(extensionsArraySource(source))) {
    const head = stripCallArgs(element)
    const ids = [...head.matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((m) => m[0])
      .filter((id) => id in imports)
    if (ids.length !== 1) {
      throw new Error(`${EDITOR_FILE}: cannot map extension entry to one import: ${element}`)
    }
    const [id] = ids
    if (id === 'buildSharedExtensions') continue
    const spec = imports[id]
    entries.push({
      export: id,
      module: spec.startsWith('.') ? posix.join(EDITOR_DIR, spec) : spec,
      conditional: head.includes('?'),
    })
  }
  return entries
}

async function buildSnapshot(server) {
  const { snapshotSchema } = await server.ssrLoadModule('/mobile/editor/schemaSnapshot.ts')
  const { buildSharedExtensions } = await server.ssrLoadModule(`${EDITOR_DIR}/sharedExtensions.ts`)
  const { ensureMathExtensions } = await server.ssrLoadModule('/src/lib/editorMath.ts')
  const mathExtensions = await ensureMathExtensions()
  const shared = buildSharedExtensions({ mathExtensions })
  const base = JSON.stringify(snapshotSchema(getSchema(shared)))

  const editorSource = await readFile(resolve(ROOT, `.${EDITOR_FILE}`), 'utf8')
  const editorOnly = []
  for (const entry of editorOnlyEntries(editorSource)) {
    const extension = (await server.ssrLoadModule(entry.module))[entry.export]
    if (!extension?.type) throw new Error(`${entry.module} has no TipTap export ${entry.export}`)
    const withIt = JSON.stringify(snapshotSchema(getSchema([...shared, extension])))
    editorOnly.push({ ...entry, extension, addsSchema: withIt !== base })
  }

  const all = [...shared, ...editorOnly.map((e) => e.extension)]
  return {
    _generated:
      'node scripts/editor-schema-snapshot.mjs — do not edit by hand; --check fails when stale',
    extensions: {
      shared: shared.map((e) => ({ name: e.name, type: e.type })),
      math: mathExtensions.map((e) => ({ name: e.name, type: e.type })),
      editorOnly: editorOnly.map((e) => ({
        export: e.export,
        module: e.module,
        name: e.extension.name,
        type: e.extension.type,
        conditional: e.conditional,
        addsSchema: e.addsSchema,
      })),
    },
    schema: snapshotSchema(getSchema(all)),
  }
}

const server = await createServer({
  configFile: resolve(ROOT, 'vite.config.ts'),
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
})
try {
  const json = `${JSON.stringify(await buildSnapshot(server), null, 2)}\n`
  const current = await readFile(OUT, 'utf8').catch(() => null)
  if (check) {
    if (current !== json) {
      console.error(
        `${OUT} is stale: the desktop editor schema changed. Run node scripts/editor-schema-snapshot.mjs and update mobile/editor/extensions.ts to match.`,
      )
      process.exitCode = 1
    } else console.log('desktop-schema.json is up to date')
  } else {
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, json)
    console.log(`wrote ${OUT}`)
  }
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await server.close()
}
