import type { Schema } from '@tiptap/pm/model'

/**
 * A JSON-comparable view of a ProseMirror schema: node and mark names in
 * schema order (the first node matching a content expression is its default
 * type, so order matters), plus each spec's primitive fields and attribute
 * defaults. Functions (parseDOM, toDOM, NodeViews) are left out.
 *
 * Dependency-free on purpose: `scripts/editor-schema-snapshot.mjs` loads this
 * same file for the desktop schema, so both sides serialise identically.
 */
export interface SchemaSnapshot {
  topNode: string
  nodeOrder: string[]
  markOrder: string[]
  nodes: Record<string, SpecSnapshot>
  marks: Record<string, SpecSnapshot>
}

export interface SpecSnapshot {
  attrs: Record<string, AttrSnapshot>
  [field: string]: unknown
}

/** `noDefault` marks a required attribute (JSON would drop `default: undefined`). */
export type AttrSnapshot = { default: unknown; validate?: string } | { noDefault: true }

interface SpecLike {
  attrs?: Record<string, { default?: unknown; validate?: unknown }>
  [field: string]: unknown
}

export function snapshotSchema(schema: Schema): SchemaSnapshot {
  const nodeOrder: string[] = []
  const markOrder: string[] = []
  const nodes: Record<string, SpecSnapshot> = {}
  const marks: Record<string, SpecSnapshot> = {}
  schema.spec.nodes.forEach((name, spec) => {
    nodeOrder.push(name)
    nodes[name] = snapshotSpec(spec as SpecLike)
  })
  schema.spec.marks.forEach((name, spec) => {
    markOrder.push(name)
    marks[name] = snapshotSpec(spec as SpecLike)
  })
  return {
    topNode: schema.topNodeType.name,
    nodeOrder,
    markOrder,
    nodes: sortKeys(nodes),
    marks: sortKeys(marks),
  }
}

function snapshotSpec(spec: SpecLike): SpecSnapshot {
  const out: SpecSnapshot = { attrs: {} }
  for (const field of Object.keys(spec).sort()) {
    const value = spec[field]
    if (field === 'attrs' || !isPrimitive(value)) continue
    out[field] = value
  }
  const attrs = spec.attrs ?? {}
  for (const name of Object.keys(attrs).sort()) {
    const attr = attrs[name]
    if (attr.default === undefined) {
      out.attrs[name] = { noDefault: true }
      continue
    }
    const snap: AttrSnapshot = { default: canonical(attr.default) }
    if (typeof attr.validate === 'string') snap.validate = attr.validate
    out.attrs[name] = snap
  }
  return out
}

function isPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function canonical(value: unknown): unknown {
  if (typeof value === 'function') return '[function]'
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, canonical(obj[k])]))
  }
  return value
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]))
}

/**
 * Every difference between two schema snapshots, as `path: desktop != mobile`
 * lines; empty when they are identical. The mobile editor opens a document
 * read-only unless this is empty (safety contract 4).
 */
export function schemaDifferences(desktop: unknown, mobile: unknown): string[] {
  return diff(desktop, mobile, 'schema', [])
}

function diff(a: unknown, b: unknown, path: string, out: string[]): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  if (!isRecord(a) || !isRecord(b)) {
    out.push(`${path}: desktop ${JSON.stringify(a)} != mobile ${JSON.stringify(b)}`)
    return out
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diff(a[key], b[key], `${path}.${key}`, out)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
