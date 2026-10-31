import { Node, mergeAttributes, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Image from '@tiptap/extension-image'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import { Mathematics } from '@tiptap/extension-mathematics'
import { createLowlight, common } from 'lowlight'

/**
 * The mobile editor's content schema. It must stay IDENTICAL to the desktop
 * one (`buildSharedExtensions` in src/components/editor/sharedExtensions.ts
 * with math on): an editor bound to a Yjs entry document silently strips any
 * node or attribute its schema lacks, and entry documents are a frozen format.
 *
 * Built only from mobile/node_modules — never import src/components/editor/*,
 * which would load a second copy of @tiptap/yjs/prosemirror from the root.
 * The desktop snapshot is mobile/editor/__fixtures__/desktop-schema.json
 * (`node scripts/editor-schema-snapshot.mjs`); `editor/openNoMutation.test.ts`
 * asserts the two are identical.
 *
 * Only the schema is mirrored here, in the desktop order (the first node of a
 * group is its default type). Desktop NodeViews, commands and plugin-only
 * extensions (MathInputRules, Find, SlashMenu, …) add no schema.
 */

const lowlight = createLowlight(common)

function mediaMissingAttribute() {
  return {
    'data-media-missing': {
      default: null as boolean | null,
      parseHTML: (element: HTMLElement) => {
        const raw = element.getAttribute('data-media-missing')
        return raw !== null && raw !== 'false' ? true : null
      },
      renderHTML: (attributes: Record<string, unknown>) => {
        if (!attributes['data-media-missing']) return {}
        return { 'data-media-missing': 'true' }
      },
    },
  }
}

function mediaIdAttribute() {
  return {
    'data-media-id': {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-media-id'),
      renderHTML: (attributes: Record<string, unknown>) => {
        if (!attributes['data-media-id']) return {}
        return { 'data-media-id': attributes['data-media-id'] }
      },
    },
  }
}

function clampedWidth(element: HTMLElement): number | null {
  const raw = element.getAttribute('data-width')
  if (!raw) return null
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.min(100, Math.max(10, parsed))
}

/** Desktop `ImageWithMediaId`. */
const MediaImage = Image.extend({
  draggable: false,

  addAttributes() {
    return {
      ...this.parent?.(),
      ...mediaIdAttribute(),
      ...mediaMissingAttribute(),
      'data-align': {
        default: 'full',
        parseHTML: (element) => {
          const a = element.getAttribute('data-align')
          return a === 'left' || a === 'right' ? a : 'full'
        },
        renderHTML: (attributes) => {
          const align = attributes['data-align']
          if (!align || align === 'full') return {}
          return { 'data-align': align }
        },
      },
      'data-width': {
        default: null,
        parseHTML: clampedWidth,
        renderHTML: (attributes) => {
          const width = attributes['data-width']
          if (!width) return {}
          return { 'data-width': String(width) }
        },
      },
    }
  },
})

/** Desktop `Video` + `VideoWithMediaId`. */
const MediaVideo = Node.create<{ HTMLAttributes: Record<string, unknown> }>({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: false,

  addOptions() {
    return { HTMLAttributes: {} }
  },

  addAttributes() {
    return {
      src: { default: null },
      ...mediaIdAttribute(),
      'data-align': {
        default: null,
        parseHTML: (element) => {
          const a = element.getAttribute('data-align')
          return a === 'left' || a === 'right' ? a : null
        },
        renderHTML: (attributes) => {
          const align = attributes['data-align']
          if (align !== 'left' && align !== 'right') return {}
          return { 'data-align': align }
        },
      },
      'data-width': {
        default: null,
        parseHTML: clampedWidth,
        renderHTML: (attributes) => {
          if (attributes['data-width'] == null) return {}
          return { 'data-width': String(attributes['data-width']) }
        },
      },
      ...mediaMissingAttribute(),
    }
  },

  parseHTML() {
    return [{ tag: 'video[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
  },
})

/** Desktop `Audio` + `AudioWithMediaId`. */
const MediaAudio = Node.create<{ HTMLAttributes: Record<string, unknown> }>({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {} }
  },

  addAttributes() {
    return {
      src: { default: null },
      ...mediaIdAttribute(),
      ...mediaMissingAttribute(),
    }
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
  },
})

/** Desktop `Mention`. Sync reads `label` straight off the Yjs element. */
const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) return {}
          return { 'data-id': attributes.id as string }
        },
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => {
          if (!attributes.label) return {}
          return { 'data-label': attributes.label as string }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'mention' }, HTMLAttributes),
      `@${String(node.attrs.label ?? '')}`,
    ]
  },
})

/** Same order and options as desktop `buildSharedExtensions({ mathExtensions })`. */
export function buildMobileExtensions(): Extensions {
  return [
    StarterKit.configure({
      undoRedo: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
      underline: false,
      dropcursor: false,
    }),
    Underline,
    Highlight,
    // `autolink` sets the link mark's `inclusive`: part of the schema.
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    CodeBlockLowlight.configure({ lowlight }),
    MediaImage,
    MediaVideo,
    MediaAudio,
    // Unconditional, as on desktop: a schema without `mention` (or math)
    // strips those nodes from the Yjs document for good.
    Mention,
    HorizontalRule,
    // Desktop loads math behind a setting; mobile always carries it (superset).
    Mathematics.configure({ katexOptions: { throwOnError: false } }),
  ]
}
