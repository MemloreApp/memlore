import { describe, expect, it } from 'vitest'
import { filterSlashItems, matchesSlashItem, type SlashQueryItem } from './slashMenuQuery'

const todayVi: SlashQueryItem = {
  key: 'today',
  label: 'Hôm nay',
  aliases: ['date'],
}

describe('matchesSlashItem', () => {
  it('treats the query as a literal substring, not a regex', () => {
    expect(() => matchesSlashItem(todayVi, 'today(')).not.toThrow()
    // `tod.` as a RegExp would match "today"; includes() must not.
    expect(matchesSlashItem(todayVi, 'tod.')).toBe(false)
  })
})

describe('filterSlashItems', () => {
  const items: SlashQueryItem[] = [
    todayVi,
    { key: 'yesterday', label: 'Hôm qua' },
    { key: 'time', label: 'Giờ', aliases: ['clock'] },
  ]

  it('keeps only items that match key, alias, or label', () => {
    expect(filterSlashItems(items, 'date')).toEqual([todayVi])
    expect(filterSlashItems(items, 'today')).toEqual([todayVi])
    expect(filterSlashItems(items, 'Hôm qua')).toEqual([items[1]])
  })
})
