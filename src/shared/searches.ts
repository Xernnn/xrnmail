/** The searches made lately, newest first, which the empty search box offers again. They're this
 *  laptop's own, kept with the profile. */

export const SEARCHES_KEPT = 8
const LONGEST = 500

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, LONGEST)

/** [text] first, once (whatever its case), and the oldest let go past [SEARCHES_KEPT]. A blank one
 *  changes nothing. */
export function withSearch(list: string[], text: string): string[] {
  const search = tidy(text)
  if (!search) return list.slice(0, SEARCHES_KEPT)
  return [search, ...list.filter((kept) => kept.toLowerCase() !== search.toLowerCase())].slice(0, SEARCHES_KEPT)
}

/** As saved, made whole: text only, tidied, each once, no more than are kept. */
export function cleanSearches(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').reverse().reduce<string[]>((list, text) => withSearch(list, text), [])
}
