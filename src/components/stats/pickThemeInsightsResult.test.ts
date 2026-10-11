import { describe, expect, it } from 'vitest'
import type { ThemeInsightsPhase } from '../../hooks/useThemeInsights'
import type { ThemeInsightsResult } from '../../types/ai'
import { pickThemeInsightsResult, themeInsightsRegenerateFlag } from './pickThemeInsightsResult'

const CACHED: ThemeInsightsResult = {
  start: 1,
  end: 2,
  entryCount: 3,
  themes: ['cached-theme'],
  moodDrivers: ['cached-driver'],
  cached: true,
  modelId: 'cache:v1',
}

const FRESH: ThemeInsightsResult = {
  start: 1,
  end: 2,
  entryCount: 4,
  themes: ['fresh-theme'],
  moodDrivers: ['fresh-driver'],
  cached: false,
  modelId: 'fresh:v1',
}

describe('pickThemeInsightsResult', () => {
  it('returns the ready-phase result even when a cache exists', () => {
    const phase: ThemeInsightsPhase = { kind: 'ready', result: FRESH }
    expect(pickThemeInsightsResult(phase, CACHED)).toBe(FRESH)
  })

  it('prefers the last in-session generate over cache while loading or on error', () => {
    expect(pickThemeInsightsResult({ kind: 'loading' }, CACHED, FRESH)).toBe(FRESH)
    expect(
      pickThemeInsightsResult({ kind: 'error', code: 'AI_NOT_CONFIGURED' }, CACHED, FRESH),
    ).toBe(FRESH)
  })

  it('returns cached after an error so a failed regenerate does not hide themes', () => {
    expect(pickThemeInsightsResult({ kind: 'error', code: 'AI_NOT_CONFIGURED' }, CACHED)).toBe(
      CACHED,
    )
  })
})

describe('themeInsightsRegenerateFlag', () => {
  it('maps generate / regenerate / compact to the generate(regenerate) flag', () => {
    expect(themeInsightsRegenerateFlag('generate', true)).toBe(false)
    expect(themeInsightsRegenerateFlag('generate', false)).toBe(false)
    expect(themeInsightsRegenerateFlag('regenerate', false)).toBe(true)
    expect(themeInsightsRegenerateFlag('compact', false)).toBe(false)
    expect(themeInsightsRegenerateFlag('compact', true)).toBe(true)
  })
})
