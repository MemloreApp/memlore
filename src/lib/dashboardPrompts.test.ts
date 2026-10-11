import { describe, expect, it } from 'vitest'
import { promptSeedHtml } from './dashboardPrompts'

describe('promptSeedHtml', () => {
  it('escapes script tags via the DOM', () => {
    const html = promptSeedHtml('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
