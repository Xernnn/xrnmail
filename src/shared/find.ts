/** Finding words in an open thread, apart from the page so it can be tested without one. Matching is
 *  as search's: case and marks don't count, so "lich" finds "Lịch", and a run of spaces or line
 *  breaks is one space. */

/** Between two blocks of a message, so a match can't run from the end of one into the next. */
export const BREAK = '\u0000'

const MARK = /\p{M}/u
const SPACE = /\s/

/** One character as matching sees it: lower case, without its marks, and đ as d. Empty for a mark
 *  on its own, which a decomposed letter carries after it. */
function foldChar(ch: string): string {
  if (MARK.test(ch)) return ''
  const lower = ch.toLowerCase()
  const base = (lower.length === 1 ? lower : ch).normalize('NFD').replace(/\p{M}/gu, '')
  const one = base.length === 1 ? base : lower.length === 1 ? lower : ch
  return one === 'đ' ? 'd' : one
}

/** [text] folded for matching, and for each folded character where it came from in [text]. */
export function fold(text: string): { folded: string; from: number[] } {
  let folded = ''
  const from: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === BREAK) {
      folded += BREAK
      from.push(i)
      continue
    }
    if (SPACE.test(ch)) {
      if (folded.endsWith(' ')) continue
      folded += ' '
      from.push(i)
      continue
    }
    const code = ch.charCodeAt(0)
    // Half of a pair stays as it is: nothing outside the first plane has marks to lose.
    const each = code >= 0xd800 && code <= 0xdfff ? ch : foldChar(ch)
    for (const part of each) {
      folded += part
      from.push(i)
    }
  }
  return { folded, from }
}

/** What's typed, as it's matched: folded, with spaces at its ends kept as one. */
export const foldQuery = (query: string): string => fold(query.replace(new RegExp(BREAK, 'g'), '')).folded

/** Each place [query] is in [text], as [start, end) in [text], in order and not overlapping. */
export function matchesIn(text: string, query: string): [number, number][] {
  const wanted = foldQuery(query)
  if (!wanted.trim()) return []
  const { folded, from } = fold(text)
  const found: [number, number][] = []
  for (let at = folded.indexOf(wanted); at >= 0; at = folded.indexOf(wanted, at + wanted.length)) {
    const start = from[at] ?? 0
    let end = (from[at + wanted.length - 1] ?? start) + 1
    // A letter's marks, written after it, go with it.
    while (end < text.length && MARK.test(text[end] ?? '')) end++
    found.push([start, end])
  }
  return found
}

/** Whether [text] has [query] in it anywhere. */
export const hasMatch = (text: string, query: string): boolean => matchesIn(text, query).length > 0

/** The match after [current] of [count], or before it, going round at either end. */
export function step(current: number, count: number, by: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return by === 1 ? 0 : count - 1
  return (current + by + count) % count
}

/** "2/7" for the second of seven, "0/0" for none. */
export const matchCount = (current: number, count: number): string => `${count === 0 ? 0 : current + 1}/${count}`
