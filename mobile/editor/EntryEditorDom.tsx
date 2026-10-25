'use dom'

import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { useDOMImperativeHandle, type DOMProps } from 'expo/dom'
import { useEffect, useRef, useState, type Ref } from 'react'
import * as Y from 'yjs'

import desktopSchema from './__fixtures__/desktop-schema.json'
import { buildMobileExtensions } from './extensions'
import { schemaDifferences, snapshotSchema } from './schemaSnapshot'

/** Desktop `AUTO_SAVE_DEBOUNCE_MS` (EditorPanel.tsx). */
const SAVE_DEBOUNCE_MS = 1500
/** Desktop `previewText = contentText.slice(0, 150)` (EditorPanel.tsx). */
const PREVIEW_LENGTH = 150

/**
 * Entry content is untrusted (synced from other devices, imported): nothing
 * in it may load from the network (an `<img src="https://…">` would leak the
 * IP and the open time) or navigate the WebView. Installed when this module
 * evaluates, so before the editor mounts and renders any media node.
 * Scripts, styles and fonts are left alone: the DOM runtime and KaTeX need them.
 */
const CONTENT_SECURITY_POLICY = [
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  // Nothing in the editor embeds, posts or rebases; keep a future node from doing so.
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  // Dev: Metro's Fast Refresh socket is ws://, which WebKit may not count as 'self'.
  __DEV__ ? "connect-src 'self' ws://localhost:*" : "connect-src 'self'",
].join('; ')

function installContentPolicy() {
  if (typeof document === 'undefined' || document.querySelector('meta[data-memlore-csp]')) return
  const meta = document.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = CONTENT_SECURITY_POLICY
  meta.setAttribute('data-memlore-csp', '')
  document.head.prepend(meta)
  // No long-press "Open link" preview either.
  const style = document.createElement('style')
  style.textContent = 'a { -webkit-touch-callout: none; }'
  document.head.append(style)
  // A tap on a link never navigates, editable or read-only.
  // TODO(later): see docs/LATER.md (open links natively, after a confirmation).
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault()
    },
    true,
  )
}
installContentPolicy()

/** Native calls `flush()`; the DOM side answers with `onFlushed` once the save is done. */
export type EntryEditorHandle = { flush: () => void }

interface Props {
  /** The entry's Yjs full state (base64); '' for an entry with no body yet. */
  initialStateB64: string
  /**
   * Debounced save: the FULL state (`Y.encodeStateAsUpdate`, base64), never an
   * incremental update, plus the search text and the preview, computed like
   * the desktop editor.
   */
  onUpdate: (fullStateB64: string, contentText: string, previewText: string) => Promise<void>
  /** Called after each `flush()`: any pending save has completed (or failed). */
  onFlushed: () => Promise<void>
  readOnly: boolean
  /**
   * Dev-only spike instrumentation (plan 15.4): first-paint timing, focus and
   * caret positions, as `event` + JSON `detail`. Never passed in production.
   * TODO(later): see docs/LATER.md (remove with the spike screen).
   */
  onDebug?: (event: string, detail: string) => Promise<void>
  ref?: Ref<EntryEditorHandle>
  dom?: DOMProps
}

type Mode = 'editable' | 'read-only' | 'unsafe'

/** The whole WebView is the writing surface: a tap anywhere below the text focuses it. */
const EDITOR_PROPS = {
  attributes: { style: 'min-height: 80vh; outline: none; font-size: 17px; line-height: 1.5' },
}

/**
 * The entry editor in a WebView. The Y.Doc lives here; only the full state
 * crosses to native. Safety contract 4: opening never mutates the document,
 * and a document that cannot be loaded safely (schema differs from desktop,
 * bytes do not decode) is shown read-only WITHOUT binding Collaboration,
 * because the binding itself deletes nodes the schema lacks.
 */
export default function EntryEditorDom({
  initialStateB64,
  onUpdate,
  onFlushed,
  readOnly,
  onDebug,
  ref,
}: Props) {
  const mountedAt = useRef(performance.now())
  const mountRef = useRef<HTMLDivElement>(null)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onFlushedRef = useRef(onFlushed)
  onFlushedRef.current = onFlushed
  /** Saves now what the debounce would save later; a no-op when read-only. */
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const [mode, setMode] = useState<Mode | null>(null)

  // Expo's DOM root never unmounts: when native removes this component (Back,
  // another entry) the page is just torn down and no React cleanup runs. So
  // the screen calls `flush()` and waits for `onFlushed` before leaving.
  useDOMImperativeHandle(
    ref ?? null,
    () => ({
      flush: () => {
        void flushRef.current().finally(() => void onFlushedRef.current())
      },
    }),
    [],
  )

  // Mounted once per entry: the screen keys this component by entry id.
  useEffect(() => {
    const element = mountRef.current
    if (!element) return
    const doc = new Y.Doc()
    let safe = schemaDifferences(desktopSchemaSnapshot(), mobileSchemaSnapshot()).length === 0
    try {
      if (initialStateB64) Y.applyUpdate(doc, fromBase64(initialStateB64))
    } catch {
      safe = false
    }

    if (!safe) {
      setMode('unsafe')
      const editor = new Editor({
        element,
        editable: false,
        editorProps: EDITOR_PROPS,
        extensions: buildMobileExtensions(),
        content: readOnlyContent(doc),
      })
      return () => {
        editor.destroy()
        doc.destroy()
      }
    }

    setMode(readOnly ? 'read-only' : 'editable')
    const editor = new Editor({
      element,
      editable: !readOnly,
      editorProps: EDITOR_PROPS,
      extensions: [
        ...buildMobileExtensions(),
        Collaboration.configure({ document: doc, field: 'default' }),
      ],
    })
    if (onDebug) instrument(editor, mountedAt.current, initialStateB64 !== '', onDebug)
    if (readOnly) {
      return () => {
        editor.destroy()
        doc.destroy()
      }
    }

    // Like the desktop's skip of the initial Collaboration sync: save only
    // when the document really differs from what was last stored.
    let lastSaved = Y.snapshot(doc)
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight: Promise<void> = Promise.resolve()
    const save = () => {
      if (timer) clearTimeout(timer)
      timer = null
      const current = Y.snapshot(doc)
      if (Y.equalSnapshots(lastSaved, current)) return
      lastSaved = current
      const contentText = extractPlainText(doc)
      inFlight = onUpdateRef
        .current(
          toBase64(Y.encodeStateAsUpdate(doc)),
          contentText,
          contentText.slice(0, PREVIEW_LENGTH),
        )
        .catch(() => {
          // Retry on the next edit or flush: the stored doc is unchanged.
          lastSaved = Y.snapshot(new Y.Doc())
        })
    }
    flushRef.current = async () => {
      await inFlight
      save()
      await inFlight
    }
    const onDocUpdate = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, SAVE_DEBOUNCE_MS)
    }
    // Backgrounding the app: start the save now. It cannot be awaited, so
    // a kill right after may still lose it.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') save()
    }
    doc.on('update', onDocUpdate)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', save)
    return () => {
      // Only runs on an in-page unmount, never on native teardown (see flush).
      doc.off('update', onDocUpdate)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', save)
      flushRef.current = () => Promise.resolve()
      save()
      editor.destroy()
      doc.destroy()
    }
    // One document per mount: later prop changes are ignored on purpose.
  }, [])

  return (
    // Expo's DOM root (`#root`) is a row flexbox, which shrinks this wrapper
    // to its content: an empty entry's editor was 0 px wide, so a tap could
    // never land on it. `flex: 1` makes the writing surface the full width.
    <div
      style={{
        flex: 1,
        minWidth: 0,
        fontFamily: '-apple-system, system-ui, sans-serif',
        padding: 12,
      }}
    >
      {mode === 'unsafe' ? (
        <p data-testid="editor-read-only-fallback">
          This entry opens read-only on mobile.
        </p>
      ) : null}
      <div ref={mountRef} data-mode={mode ?? 'loading'} />
    </div>
  )
}

/**
 * Spike 15.4: reports the first painted frame that shows the document
 * (`performance.now()` since the WebView navigation started and since this
 * component mounted, plus `Date.now()` for the native side's own clock),
 * then focus, blur and every caret move with its on-screen position.
 * TODO(later): see docs/LATER.md (dev instrumentation in a shippable file).
 */
function instrument(
  editor: Editor,
  mountedAt: number,
  hasContent: boolean,
  onDebug: (event: string, detail: string) => Promise<void>,
) {
  const report = (event: string, detail: object) => void onDebug(event, JSON.stringify(detail))
  const waitForContent = (frames: number) => {
    if (editor.isDestroyed) return
    if (hasContent && editor.view.dom.textContent === '' && frames < 600) {
      requestAnimationFrame(() => waitForContent(frames + 1))
      return
    }
    // The frame after the content is in the DOM is the first one painted with it.
    requestAnimationFrame(() => {
      const now = performance.now()
      report('firstPaint', {
        sinceNavigationMs: Math.round(now),
        sinceMountMs: Math.round(now - mountedAt),
        wallClock: Date.now(),
        words: editor.getText().split(/\s+/).filter(Boolean).length,
      })
    })
  }
  waitForContent(0)
  const caret = () => {
    const { from } = editor.state.selection
    const viewport = window.visualViewport
    return {
      from,
      caretTop: Math.round(editor.view.coordsAtPos(from).top),
      viewportHeight: Math.round(viewport?.height ?? window.innerHeight),
      scrollY: Math.round(window.scrollY),
    }
  }
  editor.on('focus', () => report('focus', caret()))
  editor.on('blur', () => report('blur', caret()))
  editor.on('selectionUpdate', () => report('selection', caret()))
  window.visualViewport?.addEventListener('resize', () => {
    if (!editor.isDestroyed) report('viewportResize', caret())
  })
}

let desktopSnapshotCache: unknown
function desktopSchemaSnapshot(): unknown {
  desktopSnapshotCache ??= desktopSchema.schema
  return desktopSnapshotCache
}

function mobileSchemaSnapshot(): unknown {
  return snapshotSchema(getSchema(buildMobileExtensions()))
}

/** Best-effort content for the read-only fallback, from a copy of the doc. */
function readOnlyContent(doc: Y.Doc): JSONContent | undefined {
  try {
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    return yDocToProsemirrorJSON(copy, 'default') as JSONContent
  } catch {
    return undefined
  }
}

// --- Desktop `extractPlainText` (src/lib/yjs.ts), copied verbatim ---------
// Including its quirk: the tag is lowercased before the camelCase set is
// checked, so only paragraph/heading/blockquote end with a newline. The Rust
// merge (`yjs_doc::extract_entry_text`) mirrors the same quirk.

function extractPlainText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment('default')
  return xmlFragmentToText(fragment).trim()
}

function xmlFragmentToText(fragment: Y.XmlFragment): string {
  let result = ''
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i)
    if (child instanceof Y.XmlText) {
      result += child.toString()
    } else if (child instanceof Y.XmlElement) {
      result += xmlElementToText(child)
    }
  }
  return result
}

const BLOCK_TAGS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'taskList',
  'tableRow',
  'tableCell',
  'tableHeader',
  'horizontalRule',
])

function xmlElementToText(elem: Y.XmlElement): string {
  if (elem.nodeName?.toLowerCase() === 'mention') {
    return elem.getAttribute('label') ?? ''
  }
  let result = ''
  for (let i = 0; i < elem.length; i++) {
    const child = elem.get(i)
    if (child instanceof Y.XmlText) {
      result += child.toString()
    } else if (child instanceof Y.XmlElement) {
      result += xmlElementToText(child)
    }
  }
  const tag = elem.nodeName?.toLowerCase() ?? ''
  return BLOCK_TAGS.has(tag) ? result + '\n' : result
}

// --- base64 (no Uint8Array.fromBase64 on the iOS 17 WebView) --------------

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
