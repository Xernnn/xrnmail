import { describe, expect, it } from 'vitest'
import { cleanSearches, SEARCHES_KEPT, withSearch } from '@shared/searches'

describe('recent searches', () => {
  it('puts the newest first, once whatever its case, tidied', () => {
    expect(withSearch([], '  from:mai  ')).toEqual(['from:mai'])
    expect(withSearch(['invoice', 'from:mai'], 'From:Mai')).toEqual(['From:Mai', 'invoice'])
    expect(withSearch(['invoice'], 'lich   thi')).toEqual(['lich thi', 'invoice'])
  })

  it('keeps the last few, and a blank search changes nothing', () => {
    let list: string[] = []
    for (let i = 0; i < 12; i++) list = withSearch(list, `search ${i}`)
    expect(list).toHaveLength(SEARCHES_KEPT)
    expect(list[0]).toBe('search 11')
    expect(list.at(-1)).toBe(`search ${12 - SEARCHES_KEPT}`)
    expect(withSearch(list, '   ')).toEqual(list)
  })

  it('reads back only what could have been saved', () => {
    expect(cleanSearches(null)).toEqual([])
    expect(cleanSearches({ 0: 'x' })).toEqual([])
    expect(cleanSearches(['a', 3, 'A', ' b ', 'x'.repeat(900)])).toEqual(['a', 'b', 'x'.repeat(500)])
    expect(cleanSearches(Array.from({ length: 20 }, (_, i) => `s${i}`))).toEqual(Array.from({ length: SEARCHES_KEPT }, (_, i) => `s${i}`))
  })
})
