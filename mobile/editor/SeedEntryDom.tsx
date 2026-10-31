'use dom'

import { getSchema } from '@tiptap/core'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import type { DOMProps } from 'expo/dom'
import { useEffect } from 'react'
import * as Y from 'yjs'

import { buildMobileExtensions } from './extensions'

const WORDS =
  'morning light coffee walk river notes quiet garden friend letter train window rain city book music evening memory home journey'.split(
    ' ',
  )
const WORDS_PER_PARAGRAPH = 50

/**
 * Dev-only (Phase 15 fix): a link and remote media for the content-policy
 * check. A local `python3 -m http.server 8099` logs any request they make.
 */
const REMOTE = 'http://localhost:8099'
const REMOTE_PARAGRAPHS = ['Tap the link: remote link', 'After the media.']

interface Props {
  words: number
  /** Seed the link + remote media body instead of `words` plain words. */
  remoteMedia?: boolean
  /** The full Yjs state (base64) and its search text, like the editor's save. */
  onSeeded: (fullStateB64: string, contentText: string) => Promise<void>
  dom?: DOMProps
}

/**
 * Dev-only (spike 15.4): builds a long entry body through the mobile schema
 * (`buildMobileExtensions`), paragraphs of plain words, for the first-paint
 * measurement. Renders nothing.
 */
export default function SeedEntryDom({ words, remoteMedia, onSeeded }: Props) {
  useEffect(() => {
    if (remoteMedia) {
      const doc = prosemirrorJSONToYDoc(
        getSchema(buildMobileExtensions()),
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Tap the link: ' },
                {
                  type: 'text',
                  text: 'remote link',
                  // No `target`: a plain link that would navigate the WebView itself.
                  marks: [{ type: 'link', attrs: { href: `${REMOTE}/link`, target: null } }],
                },
              ],
            },
            { type: 'image', attrs: { src: `${REMOTE}/x.png` } },
            { type: 'video', attrs: { src: `${REMOTE}/v.mp4` } },
            { type: 'audio', attrs: { src: `${REMOTE}/a.mp3` } },
            { type: 'paragraph', content: [{ type: 'text', text: REMOTE_PARAGRAPHS[1] }] },
          ],
        },
        'default',
      )
      void onSeeded(toBase64(Y.encodeStateAsUpdate(doc)), REMOTE_PARAGRAPHS.join('\n'))
      return
    }
    const paragraphs: string[] = []
    for (let i = 0; i < words; i += WORDS_PER_PARAGRAPH) {
      const count = Math.min(WORDS_PER_PARAGRAPH, words - i)
      paragraphs.push(
        Array.from({ length: count }, (_, j) => WORDS[(i + j * 7) % WORDS.length]).join(' '),
      )
    }
    const doc = prosemirrorJSONToYDoc(
      getSchema(buildMobileExtensions()),
      {
        type: 'doc',
        content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
      },
      'default',
    )
    // Desktop `extractPlainText` for paragraphs: each ends with '\n', then trim.
    void onSeeded(toBase64(Y.encodeStateAsUpdate(doc)), paragraphs.join('\n'))
    // Seeds once per mount.
  }, [])
  return null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
