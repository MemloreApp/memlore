import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPath, openUrl } from './plugins'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('opener', () => {
  it('opens https URLs with noopener,noreferrer', async () => {
    const win = vi.fn()
    vi.stubGlobal('window', { open: win })
    await openUrl('https://example.com/a')
    expect(win).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
  })

  it('hands mailto URLs to the mail client without opening a tab', async () => {
    const open = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('window', { open, location: { assign } })
    await openUrl('mailto:contact@memlore.app')
    expect(assign).toHaveBeenCalledWith('mailto:contact@memlore.app')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url'])(
    'rejects %s',
    async (url) => {
      const win = vi.fn()
      vi.stubGlobal('window', { open: win })
      await expect(openUrl(url)).rejects.toThrow()
      expect(win).not.toHaveBeenCalled()
    },
  )
})

describe('opener openPath', () => {
  it('rejects as unsupported on web', async () => {
    await expect(openPath('/tmp/x')).rejects.toThrow('unsupported_on_web: openPath')
  })
})
