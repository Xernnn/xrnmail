import { describe, expect, it } from 'vitest'
import { BREAK, fold, hasMatch, matchCount, matchesIn, step } from '../src/shared/find'
import { KEY_SETS, keyList, keysFor, RESERVED, unbindable } from '../src/shared/keys'

const found = (text: string, query: string): string[] => matchesIn(text, query).map(([start, end]) => text.slice(start, end))

describe('finding words in a thread', () => {
  it('ignores case and marks, as search does, so "lich thi" finds "Lịch thi"', () => {
    expect(found('Lịch thi cuối kỳ. LỊCH THI đã có.', 'lich thi')).toEqual(['Lịch thi', 'LỊCH THI'])
    expect(found('Đọc trước khi họp', 'doc')).toEqual(['Đọc'])
    expect(found('Café au lait', 'CAFE')).toEqual(['Café'])
  })

  it('takes a letter written with its marks after it whole', () => {
    const decomposed = 'Lịch thi'
    expect(found(decomposed, 'lich')).toEqual(['Lịch'])
  })

  it('reads a run of spaces and line breaks as one space', () => {
    expect(found('the  quarterly\n   report', 'quarterly report')).toEqual(['quarterly\n   report'])
    expect(found('quarterly report', 'quarterly   report')).toEqual(['quarterly report'])
  })

  it('never runs a match from one block into the next', () => {
    expect(found(`ends here${BREAK}here starts`, 'here here')).toEqual([])
    expect(found(`ends here${BREAK}here starts`, 'here')).toEqual(['here', 'here'])
  })

  it('finds every place, without overlaps, and nothing for blank words', () => {
    expect(matchesIn('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
    expect(matchesIn('words', '   ')).toEqual([])
    expect(matchesIn('words', '')).toEqual([])
    expect(hasMatch('Invoice 4471 attached', 'invoice 44')).toBe(true)
    expect(hasMatch('Invoice 4471 attached', 'receipt')).toBe(false)
  })

  it('keeps where each folded letter came from', () => {
    const { folded, from } = fold('A  b')
    expect(folded).toBe('a b')
    expect(from).toEqual([0, 1, 3])
  })

  it('steps round at either end, and counts as "2/7"', () => {
    expect([step(-1, 3, 1), step(-1, 3, -1), step(2, 3, 1), step(0, 3, -1), step(0, 0, 1)]).toEqual([0, 2, 0, 2, -1])
    expect([matchCount(1, 7), matchCount(-1, 0)]).toEqual(['2/7', '0/0'])
  })
})

// Ctrl+F is the menu's Search in every set, so finding inside a message needs a key of its own.
describe('the key for finding in a message', () => {
  it('is Ctrl+G where Ctrl+Shift+F is taken, as Apple Mail and Outlook find the next match, and Ctrl+Shift+F elsewhere', () => {
    const findKeys = Object.fromEntries(KEY_SETS.map(([set]) => [set, Object.entries(keysFor(set)).filter(([, command]) => command === 'find').map(([key]) => key)]))
    expect(findKeys).toEqual({ edison: ['Ctrl+G'], gmail: ['Ctrl+Shift+F'], apple: ['Ctrl+G'], outlook: ['Ctrl+G'], inbox: ['Ctrl+Shift+F'] })
    expect([keysFor('edison')['Ctrl+Shift+F'], keysFor('apple')['Ctrl+Shift+F'], keysFor('outlook')['Ctrl+Shift+F']]).toEqual(['forward', 'forward', 'search'])
    expect(keysFor('gmail')['Ctrl+F']).toBeUndefined()
  })

  it('is listed, with F3 for the next and the match before, which no action can take', () => {
    expect(keyList('gmail')).toContainEqual(['Ctrl+Shift+F', 'Find in message'])
    expect(keyList('edison')).toContainEqual(['F3, Shift+F3', 'Next or previous match'])
    expect(['F3', 'Shift+F3'].every((key) => key in RESERVED)).toBe(true)
    expect(unbindable('F3', 'F3')).toBe('F3 is for finding in a message.')
  })
})
