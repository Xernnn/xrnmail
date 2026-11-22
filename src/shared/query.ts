/**
 * A search as typed, read the way Gmail reads one: words, "quoted phrases", OR between two terms,
 * -word or NOT word, and operators such as from: or newer_than:. The store turns it into SQL, and
 * searching the server turns it into IMAP SEARCH or Gmail's own syntax, so all three agree on it.
 * Nothing typed is ever passed on as syntax it wasn't meant as.
 */

export type Field = 'any' | 'from' | 'to' | 'subject' | 'filename'

export type Term =
  /** [exact] for a quoted phrase, which matches as it's written; a plain word matches as a prefix. */
  | { kind: 'word'; field: Field; text: string; exact: boolean }
  | { kind: 'is'; what: 'unread' | 'read' | 'starred' | 'snoozed' | 'pinned' | 'important' }
  | { kind: 'has'; what: 'attachment' }
  /** in:inbox, in:sent and so on, or a label or folder by name. */
  | { kind: 'in'; place: string }
  /** A day, as the start of it in UTC. */
  | { kind: 'after' | 'before'; at: number }
  | { kind: 'newer' | 'older'; amount: number; unit: 'd' | 'w' | 'm' | 'y' }
  | { kind: 'larger' | 'smaller'; bytes: number }

/** One thing a match must satisfy: any of its terms, or with [not], none of them. */
export interface Clause {
  not: boolean
  any: Term[]
}

/** One piece of what was typed, as typed, and what it is. */
export interface Token {
  raw: string
  /** Typed with a leading - or after NOT. */
  not: boolean
  /** The operator before the colon, lowercased, or '' for a plain word. */
  op: string
  value: string
  quoted: boolean
  /** OR, AND or NOT on its own. */
  joiner: 'OR' | 'AND' | 'NOT' | null
}

const OPERATORS = new Set([
  'from', 'to', 'subject', 'filename', 'is', 'has', 'in', 'label', 'after', 'before', 'newer_than', 'older_than', 'larger', 'smaller'
])

/** What the search box offers as what's typed is finished: each operator, and the values it takes. */
export const COMPLETIONS = [
  'from:', 'to:', 'subject:', 'filename:', 'label:', 'in:inbox', 'in:sent', 'in:archive', 'in:anywhere',
  'is:unread', 'is:read', 'is:starred', 'is:flagged', 'is:snoozed', 'is:pinned', 'is:important', 'has:attachment',
  'after:', 'before:', 'newer_than:', 'older_than:', 'larger:', 'smaller:'
]

/** Splits what was typed into its pieces, keeping a quoted phrase, or an operator's quoted value
 *  (label:"Family trips"), as one. A quote left open runs to the end. */
export function tokensOf(text: string): Token[] {
  const found: Token[] = []
  let at = 0
  let negate = false
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at] ?? '')) at++
    if (at >= text.length) break
    const start = at
    let not = false
    if (text[at] === '-' && at + 1 < text.length && !/\s/.test(text[at + 1] ?? '')) {
      not = true
      at++
    }
    const op = /^([a-z_]+):/i.exec(text.slice(at))
    const known = op && OPERATORS.has((op[1] ?? '').toLowerCase())
    if (known && op) at += op[0].length
    let value = ''
    let quoted = false
    if (text[at] === '"') {
      const end = text.indexOf('"', at + 1)
      value = text.slice(at + 1, end < 0 ? text.length : end)
      at = end < 0 ? text.length : end + 1
      quoted = true
      // Anything run on after the closing quote belongs to the same piece.
      while (at < text.length && !/\s/.test(text[at] ?? '')) value += text[at++]
    } else {
      while (at < text.length && !/\s/.test(text[at] ?? '')) value += text[at++]
    }
    const raw = text.slice(start, at)
    const joiner = !known && !not && !quoted && (value === 'OR' || value === 'AND' || value === 'NOT') ? value : null
    if (joiner === 'NOT') {
      negate = true
      found.push({ raw, not: false, op: '', value, quoted, joiner })
      continue
    }
    found.push({ raw, not: not || (negate && !joiner), op: known && op ? (op[1] ?? '').toLowerCase() : '', value: value.replace(/"/g, ''), quoted, joiner })
    if (!joiner) negate = false
  }
  return found
}

/** A day typed as 2026-11-01, 2026/11/01 or 2026-11 (the first of the month), as the start of it in UTC. */
export function dayOf(value: string): number | null {
  const parts = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(value)
  if (!parts) return null
  const pad = (n: string | undefined): string => (n ?? '1').padStart(2, '0')
  const day = Date.parse(`${parts[1]}-${pad(parts[2])}-${pad(parts[3])}`)
  return Number.isNaN(day) ? null : day
}

const SIZE_UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }

/** 5M, 200K, 1.5m or a plain count of bytes. */
export function bytesOf(value: string): number | null {
  const parts = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(value)
  if (!parts) return null
  return Math.round(Number(parts[1]) * (SIZE_UNITS[(parts[2] ?? '').toLowerCase()] ?? 1))
}

const IS = new Map<string, Extract<Term, { kind: 'is' }>['what']>([
  ['unread', 'unread'], ['read', 'read'], ['starred', 'starred'], ['flagged', 'starred'],
  ['snoozed', 'snoozed'], ['pinned', 'pinned'], ['important', 'important']
])

/** What one piece means, or a plain word when an operator's value can't be read: after:soon is
 *  searched for as it's written. */
export function termOf(token: Token): Term {
  const { op, value, quoted } = token
  const word = (field: Field, text: string): Term => ({ kind: 'word', field, text, exact: quoted })
  switch (op) {
    case 'from':
    case 'to':
    case 'subject':
    case 'filename':
      return word(op, value)
    case 'is': {
      const what = IS.get(value.toLowerCase())
      return what ? { kind: 'is', what } : word('any', `is:${value}`)
    }
    case 'has':
      return /^attachments?$/i.test(value) ? { kind: 'has', what: 'attachment' } : word('any', `has:${value}`)
    case 'in':
    case 'label':
      return value ? { kind: 'in', place: value } : word('any', `${op}:`)
    case 'after':
    case 'before': {
      const at = dayOf(value)
      return at === null ? word('any', `${op}:${value}`) : { kind: op, at }
    }
    case 'newer_than':
    case 'older_than': {
      const age = /^(\d{1,4})([dwmy])$/i.exec(value)
      if (!age) return word('any', `${op}:${value}`)
      return { kind: op === 'newer_than' ? 'newer' : 'older', amount: Number(age[1]), unit: (age[2] ?? 'd').toLowerCase() as 'd' }
    }
    case 'larger':
    case 'smaller': {
      const bytes = bytesOf(value)
      return bytes === null ? word('any', `${op}:${value}`) : { kind: op, bytes }
    }
    default:
      return word('any', value)
  }
}

/** The clauses a search asks for, all of which a match must satisfy. OR joins the terms either side
 *  of it, as in Gmail: `a OR b c` is (a or b) and c. A word with nothing in it after its quotes are
 *  gone asks for nothing. */
export function parseQuery(text: string): Clause[] {
  const clauses: Clause[] = []
  let joining = false
  for (const token of tokensOf(text)) {
    if (token.joiner === 'OR') {
      joining = clauses.length > 0
      continue
    }
    if (token.joiner) continue
    const term = termOf(token)
    if (term.kind === 'word' && !term.text) continue
    const last = clauses.at(-1)
    // Only terms that aren't negated join one another: Gmail reads `a OR -b` as a or (not b), which
    // isn't worth the trouble of a clause that mixes them.
    if (joining && last && !last.not && !token.not) last.any.push(term)
    else clauses.push({ not: token.not, any: [term] })
    joining = false
  }
  return clauses
}

/** The moment an age reaches back to: newer_than:2w is after two weeks ago. Months and years are the
 *  calendar's, as Gmail counts them. */
export function ageStart(term: Extract<Term, { kind: 'newer' | 'older' }>, now: number): number {
  const day = new Date(now)
  if (term.unit === 'd') day.setDate(day.getDate() - term.amount)
  else if (term.unit === 'w') day.setDate(day.getDate() - term.amount * 7)
  else if (term.unit === 'm') day.setMonth(day.getMonth() - term.amount)
  else day.setFullYear(day.getFullYear() - term.amount)
  return day.getTime()
}
