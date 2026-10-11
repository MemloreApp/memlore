import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_CARD_IDS,
  DEFAULT_DASHBOARD_CARDS,
  isAiGatedCardId,
  parseDashboardCards,
  serializeDashboardCards,
  type DashboardCardId,
  type DashboardCardPref,
} from './dashboardCards'

function appendedEnabled(present: readonly DashboardCardId[]): DashboardCardPref[] {
  return DASHBOARD_CARD_IDS.filter((id) => !present.includes(id)).map((id) => ({
    id,
    enabled: true,
  }))
}

describe('DASHBOARD_CARD_IDS', () => {
  it('lists the fourteen cards in default order', () => {
    expect(DASHBOARD_CARD_IDS).toEqual([
      'streak',
      'quick_stats',
      'prompt',
      'on_this_day',
      'mood_trend',
      'recent_entries',
      'ai_insights',
      'today',
      'heatmap',
      'top_tags',
      'places',
      'photos',
      'weekly_review',
      'chat',
    ])
  })
})

describe('AI_GATED_CARD_IDS', () => {
  it('isAiGatedCardId is true only for those three ids', () => {
    expect(isAiGatedCardId('ai_insights')).toBe(true)
    expect(isAiGatedCardId('weekly_review')).toBe(true)
    expect(isAiGatedCardId('chat')).toBe(true)
    expect(isAiGatedCardId('streak')).toBe(false)
    expect(isAiGatedCardId('mood_trend')).toBe(false)
  })
})

describe('parseDashboardCards', () => {
  it('returns the default prefs when raw is null', () => {
    expect(parseDashboardCards(null)).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('returns the default prefs when raw is not valid JSON', () => {
    expect(parseDashboardCards('not-json')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('{')).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('returns the default prefs when JSON is a non-array', () => {
    expect(parseDashboardCards('{}')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('"streak"')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('1')).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('returns the default prefs when an item lacks a string id and boolean enabled', () => {
    expect(parseDashboardCards('[{"id":"streak"}]')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('[{"enabled":true}]')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('[{"id":1,"enabled":true}]')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('[{"id":"streak","enabled":"yes"}]')).toEqual(
      DEFAULT_DASHBOARD_CARDS,
    )
  })

  it('drops unknown ids', () => {
    expect(
      parseDashboardCards(
        JSON.stringify([
          { id: 'streak', enabled: true },
          { id: 'not_a_card', enabled: true },
          { id: 'prompt', enabled: false },
        ]),
      ),
    ).toEqual([
      { id: 'streak', enabled: true },
      { id: 'prompt', enabled: false },
      ...appendedEnabled(['streak', 'prompt']),
    ])
  })

  it('appends missing known ids at the end, enabled', () => {
    expect(parseDashboardCards(JSON.stringify([{ id: 'prompt', enabled: false }]))).toEqual([
      { id: 'prompt', enabled: false },
      ...appendedEnabled(['prompt']),
    ])
  })

  it('dedupes duplicate ids, keeping the first occurrence', () => {
    expect(
      parseDashboardCards(
        JSON.stringify([
          { id: 'prompt', enabled: false },
          { id: 'prompt', enabled: true },
          { id: 'streak', enabled: true },
        ]),
      ),
    ).toEqual([
      { id: 'prompt', enabled: false },
      { id: 'streak', enabled: true },
      ...appendedEnabled(['prompt', 'streak']),
    ])
  })

  it('preserves the stored order of known ids', () => {
    expect(
      parseDashboardCards(
        JSON.stringify([
          { id: 'ai_insights', enabled: true },
          { id: 'streak', enabled: true },
        ]),
      ),
    ).toEqual([
      { id: 'ai_insights', enabled: true },
      { id: 'streak', enabled: true },
      ...appendedEnabled(['ai_insights', 'streak']),
    ])
  })
})

describe('serializeDashboardCards', () => {
  it('round-trips through parseDashboardCards', () => {
    const originalSeven: DashboardCardPref[] = [
      { id: 'mood_trend', enabled: false },
      { id: 'streak', enabled: true },
      { id: 'quick_stats', enabled: false },
      { id: 'prompt', enabled: true },
      { id: 'on_this_day', enabled: true },
      { id: 'recent_entries', enabled: false },
      { id: 'ai_insights', enabled: true },
    ]
    const prefs: DashboardCardPref[] = [
      ...originalSeven,
      ...appendedEnabled(originalSeven.map((pref) => pref.id)),
    ]
    expect(parseDashboardCards(serializeDashboardCards(prefs))).toEqual(prefs)
    expect(parseDashboardCards(serializeDashboardCards(DEFAULT_DASHBOARD_CARDS))).toEqual(
      DEFAULT_DASHBOARD_CARDS,
    )
  })
})
