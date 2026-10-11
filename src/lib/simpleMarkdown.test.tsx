import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderSimpleMarkdown } from './simpleMarkdown'

function html(input: string): string {
  return renderToStaticMarkup(renderSimpleMarkdown(input) as React.ReactElement)
}

describe('renderSimpleMarkdown', () => {
  it('partial bold marker renders as literal text (streaming-safe)', () => {
    const out = html('partial **stream in progress')
    // Open ** with no closer must not break; we expect the asterisks
    // to appear as literal characters in the output.
    expect(out).toContain('**')
    expect(out).not.toContain('<strong')
  })

  it('does NOT inject raw HTML from markdown source', () => {
    // Defence: even if the model returns a literal HTML tag, the
    // renderer treats it as text (React escapes it).
    const out = html('- <script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  describe('[id=…] entry references', () => {
    function htmlWithRefs(input: string): string {
      return renderToStaticMarkup(
        renderSimpleMarkdown(input, {
          renderEntryRef: (id) => <b data-entry={id}>REF</b>,
        }) as React.ReactElement,
      )
    }

    it('renders a marker through renderEntryRef', () => {
      const out = htmlWithRefs('See [id=f611b234-2cb5-4e70-9155-0b5a352ceb50] for details.')
      expect(out).toContain('data-entry="f611b234-2cb5-4e70-9155-0b5a352ceb50"')
      // The raw id must not survive anywhere in the output — the whole
      // point is that the reader never sees a UUID.
      expect(out).not.toContain('[id=')
      expect(out).toContain('See ')
      expect(out).toContain(' for details.')
    })

    it('ignores bracketed text that is not an entry marker', () => {
      const out = htmlWithRefs('A [link](url) and [id = abc] and [ident=abc] stay put.')
      expect(out).not.toContain('data-entry')
      expect(out).toContain('[id = abc]')
      expect(out).toContain('[ident=abc]')
    })

    it('leaves an unterminated marker literal mid-stream', () => {
      // Streaming: the closing bracket has not arrived yet. Rendering a
      // badge for a half-read id would flash the wrong entry.
      const out = htmlWithRefs('Partial [id=abc')
      expect(out).not.toContain('data-entry')
      expect(out).toContain('[id=abc')
    })
  })

  describe('`code` spans', () => {
    it('leaves an unclosed backtick literal without swallowing the line', () => {
      const out = html('See `bundle.createUpdaterArtifacts for the flag.')
      expect(out).not.toContain('<code')
      expect(out).toContain('`bundle.createUpdaterArtifacts for the flag.')
    })
  })
})
