import type { SearchObject } from 'imapflow'
import type { Address, ThreadRow } from '@shared/types'
import { ageStart, parseQuery, termOf, tokensOf, type Term } from '@shared/query'
import { INBOX, labelsOf, SENT } from './actions'
import type { ParsedMail } from './parse'
import { threadOf, type MailboxRef, type MailSource } from './source'
import type { Store } from './store'

/**
 * Mail from before the keeping window, found by asking the server. The search box shows what's kept
 * here at once, as it always has; a moment after typing stops, each account's server is asked the
 * same question about older mail, and what it finds is added below, as rows made from the headers
 * alone. Gmail is asked in its own words (X-GM-RAW) over All Mail, anything else with IMAP SEARCH
 * in each folder that's read, and both only about mail from before the window, so nothing the
 * list could already show is fetched twice. All of it goes over `MailSource`, read-only.
 */

/** The most one account's server brings: the newest this many. */
export const SERVER_HITS = 200
/** How long after the last change to a search the servers are asked, so typing isn't a search a key. */
export const SEARCH_SETTLE_MS = 500

/** A message a server found, from before the window: what its row shows, and what finds its thread. */
export interface OldHit {
  account: string
  /** The folder it's in, as a row's `box`. */
  box: string
  uid: number
  thread: string
  arrived: number
  subject: string
  from: Address
  seen: boolean
  flagged: boolean
  labels: string[]
  messageId: string
  /** The first Message-ID it traces back to: what the rest of its thread names. */
  root: string
  /** Its type says it has files (multipart/mixed). */
  files: boolean
  warned: boolean
}

const DAY_MS = 86_400_000

const slashed = (at: number): string => {
  const day = new Date(at)
  return `${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`
}

/** Only this laptop knows what's snoozed or pinned, and nothing from before the window is either. */
const localOnly = (term: Term): boolean => term.kind === 'is' && (term.what === 'snoozed' || term.what === 'pinned')

/**
 * What Gmail is asked: what was typed, word for word wherever Gmail reads it the same way, and only
 * about mail from before [before]. Gmail's days have slashes, it counts in days rather than weeks and
 * calls a flag a star. Null when nothing from before the window could match.
 */
export function gmailQuery(text: string, before: number): string | null {
  if (parseQuery(text).some((clause) => !clause.not && clause.any.every(localOnly))) return null
  const said: string[] = []
  const tokens = tokensOf(text)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.joiner) {
      said.push(token.raw)
      continue
    }
    const term = termOf(token)
    const sign = token.not ? '-' : ''
    if (localOnly(term)) {
      // Never true here, or always: either way it says nothing about mail from before the window.
      if (said.at(-1) === 'OR') said.pop()
      else if (tokens[i + 1]?.joiner === 'OR') i++
      continue
    }
    const day = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(token.value)
    if (term.kind === 'is' && token.value.toLowerCase() === 'flagged') said.push(`${sign}is:starred`)
    else if ((term.kind === 'after' || term.kind === 'before') && day) said.push(`${sign}${term.kind}:${day[1]}/${Number(day[2])}/${Number(day[3] ?? 1)}`)
    else if ((term.kind === 'newer' || term.kind === 'older') && term.unit === 'w') said.push(`${sign}${token.op}:${term.amount * 7}d`)
    else said.push(token.raw)
  }
  const asked = said.join(' ')
  // A day either side of the window's edge is mail kept here too, and is left out of what's shown.
  const edge = `before:${slashed(before + DAY_MS)}`
  if (!asked) return edge
  return `${edge} ${/\bOR\b/.test(asked) ? `(${asked})` : asked}`
}

/** How a term is put to a server without Gmail's search: as SEARCH keys, tried here on the headers
 *  that come back, or known to match nothing there. */
type Asked = SearchObject | 'here' | 'never'

function askedOf(term: Term, now: number): Asked {
  switch (term.kind) {
    case 'word':
      if (term.field === 'from') return { from: term.text }
      if (term.field === 'to') return { or: [{ to: term.text }, { cc: term.text }] }
      if (term.field === 'subject') return { subject: term.text }
      // A file's name is in the headers of its part, which are in the body.
      if (term.field === 'filename') return { body: term.text }
      return { text: term.text }
    case 'is':
      if (term.what === 'unread') return { seen: false }
      if (term.what === 'read') return { seen: true }
      if (term.what === 'starred') return { flagged: true }
      return 'never' // importance is Gmail's; snoozes and pins are this laptop's
    case 'has':
    case 'in':
      return 'here'
    case 'after':
      return { since: new Date(term.at) }
    case 'before':
      return { before: new Date(term.at) }
    case 'newer':
      return { since: new Date(ageStart(term, now)) }
    case 'older':
      return { before: new Date(ageStart(term, now)) }
    case 'larger':
      return { larger: term.bytes }
    case 'smaller':
      return { smaller: term.bytes }
  }
}

/** Whether a folder, or a message's place, is what in: or label: names. */
function placeIs(place: string, box: { id: string; labels: string[] }): boolean {
  const wanted = place.toLowerCase()
  if (wanted === 'anywhere') return true
  if (wanted === 'inbox') return box.labels.includes(INBOX)
  if (wanted === 'sent') return box.labels.includes(SENT)
  if (wanted === 'archive') return box.id === '@archive'
  const plain = (name: string): string => name.toLowerCase().replace(/[\s/]+/g, '-')
  return box.labels.some((label) => label.toLowerCase() === wanted || plain(label) === plain(wanted))
}

/** A server without Gmail's search, asked one folder at a time. */
export interface ImapPlan {
  /** Each is asked of a folder; what all of them find there is what the search found. */
  searches: SearchObject[]
  /** The folders worth asking, by what in: says. */
  wants(box: MailboxRef): boolean
  /** What SEARCH can't say, tried on what came back. */
  keeps(hit: OldHit): boolean
}

/** Gmail's syntax as IMAP SEARCH, as far as it goes. A term SEARCH has no key for is tried on the
 *  headers that come back, or, inside an OR, left out: the search finds more rather than less.
 *  Null when nothing on such a server could match. */
export function imapPlan(text: string, before: number, now: number): ImapPlan | null {
  const asks: SearchObject[] = []
  const here: ((hit: OldHit) => boolean)[] = []
  const folders: ((box: MailboxRef) => boolean)[] = []
  for (const clause of parseQuery(text)) {
    const asked = clause.any.map((term) => askedOf(term, now))
    if (clause.any.length === 1) {
      const [term] = clause.any
      const [one] = asked
      if (one === 'never') {
        if (clause.not) continue
        return null
      }
      if (one === 'here' && term) {
        const test = (hit: OldHit): boolean => (term.kind === 'has' ? hit.files : term.kind === 'in' && placeIs(term.place, { id: hit.box, labels: hit.labels }))
        here.push(clause.not ? (hit) => !test(hit) : test)
        if (term.kind === 'in') {
          const fits = (box: MailboxRef): boolean => placeIs(term.place, { id: box.id, labels: labelsOf(box, [], false) })
          folders.push(clause.not ? (box) => !fits(box) : fits)
        }
        continue
      }
      if (one && one !== 'here') asks.push(clause.not ? { not: one } : one)
      continue
    }
    const either = asked.filter((one) => one !== 'never')
    if (either.length === 0) return null
    if (either.some((one) => one === 'here')) continue
    asks.push(either.length === 1 ? (either[0] as SearchObject) : { or: either as SearchObject[] })
  }
  // As few searches as there are clashing keys: words are each their own TEXT, which one search
  // can hold only one of.
  const searches: SearchObject[] = []
  for (const ask of asks) {
    const room = searches.find((search) => Object.keys(ask).every((key) => !(key in search)))
    if (room) Object.assign(room, ask)
    else searches.push({ ...ask })
  }
  const first = searches[0] ?? {}
  if (searches.length === 0) searches.push(first)
  const said = first.before instanceof Date ? first.before.getTime() : Infinity
  first.before = new Date(Math.min(said, before + DAY_MS))
  return {
    searches,
    wants: (box) => box.role !== 'trash' && box.role !== 'junk' && folders.every((fits) => fits(box)),
    keeps: (hit) => here.every((test) => test(hit))
  }
}

const keyOf = (ref: { account: string; thread: string }): string => `${ref.account}\u0000${ref.thread}`

/** A row of the list, from what the headers said. Only what's known is filled in. */
function rowOf(hits: OldHit[]): ThreadRow {
  const seen = new Set<string>()
  const ordered = [...hits].sort((a, b) => a.arrived - b.arrived).filter((hit) => {
    if (!hit.messageId) return true
    if (seen.has(hit.messageId)) return false // a copy in two folders is still one message
    seen.add(hit.messageId)
    return true
  })
  const newest = ordered.at(-1) as OldHit
  const people = new Map<string, Address>()
  for (const hit of ordered) if (!people.has(hit.from.address.toLowerCase())) people.set(hit.from.address.toLowerCase(), hit.from)
  return {
    account: newest.account,
    thread: newest.thread,
    subject: newest.subject,
    fromName: newest.from.name,
    fromAddress: newest.from.address,
    snippet: '',
    date: newest.arrived,
    count: ordered.length,
    unread: ordered.filter((hit) => !hit.seen).length,
    attachment: ordered.some((hit) => hit.files),
    starred: ordered.some((hit) => hit.flagged),
    important: ordered.some((hit) => hit.labels.includes('\\Important')),
    snoozedUntil: null,
    facts: null,
    people: [...people.values()],
    file: null,
    files: 0,
    cards: [],
    pinned: false,
    summaryAt: null,
    warned: newest.warned,
    older: true
  }
}

const refused = (e: unknown): boolean => (e as { responseStatus?: string })?.responseStatus === 'NO'

export interface OldMailDeps {
  store: Store
  /** Every account, in the order the sidebar has them. */
  accounts(): string[]
  /** A read-only connection to an account, signed in. */
  open(account: string): Promise<MailSource>
  /** Where the keeping window starts now. */
  keepFrom(): number
  now(): number
  changed(): void
  parse(source: Buffer): Promise<ParsedMail>
  settleMs: number
}

/** One search of the servers, for one text. */
interface Asking {
  text: string
  /** Each account's hits, once its server has answered. */
  hits: Map<string, OldHit[]>
  sources: Set<MailSource>
  stopped: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class OldMail {
  private asking: Asking | null = null

  constructor(private readonly deps: OldMailDeps) {}

  /** The rows a search adds from the servers, after [local]. The first look at a search starts
   *  asking; until the servers answer it adds nothing, and they say when they have. [complete]
   *  says [local] is all there is here: only then do older rows go below it. */
  rows(text: string, local: ThreadRow[], complete: boolean): ThreadRow[] {
    const asking = this.ask(text.trim())
    if (!complete) return []
    const shown = new Set(local.map(keyOf))
    const threads = new Map<string, OldHit[]>()
    for (const account of this.deps.accounts()) {
      for (const hit of asking.hits.get(account) ?? []) {
        const key = keyOf(hit)
        if (shown.has(key)) continue
        threads.set(key, [...(threads.get(key) ?? []), hit])
      }
    }
    return [...threads.values()].map(rowOf).sort((a, b) => b.date - a.date)
  }

  /** A search that isn't being looked at any more stops, and what it found goes. */
  leave(): void {
    const asking = this.asking
    if (!asking) return
    this.asking = null
    asking.stopped = true
    if (asking.timer) clearTimeout(asking.timer)
    for (const source of asking.sources) source.drop()
    asking.sources.clear()
  }

  private ask(text: string): Asking {
    if (this.asking?.text === text) return this.asking
    this.leave()
    const asking: Asking = { text, hits: new Map(), sources: new Set(), stopped: false, timer: null }
    this.asking = asking
    if (parseQuery(text).length === 0) return asking
    asking.timer = setTimeout(() => {
      asking.timer = null
      void this.run(asking)
    }, this.deps.settleMs)
    asking.timer.unref?.()
    return asking
  }

  /** Every account at once. One that can't be reached, or won't search, adds nothing, and says
   *  nothing: what's kept here is still shown. */
  private async run(asking: Asking): Promise<void> {
    await Promise.all(this.deps.accounts().map(async (account) => {
      let hits: OldHit[] = []
      try {
        hits = await this.search(asking, account)
      } catch {
        // Offline, signed out, or turned down: the search stands on what's here.
      }
      if (asking.stopped) return
      asking.hits.set(account, hits)
      if (hits.length > 0) this.deps.changed()
    }))
  }

  private async search(asking: Asking, account: string): Promise<OldHit[]> {
    const source = await this.deps.open(account)
    asking.sources.add(source)
    try {
      if (asking.stopped) return []
      const keepFrom = this.deps.keepFrom()
      if (source.gmail) {
        const query = gmailQuery(asking.text, keepFrom)
        const box = source.mailboxes().find((b) => b.role === 'all')
        if (query === null || !box) return []
        await source.open(box)
        const uids = await source.search({ gmraw: query })
        return asking.stopped ? [] : await this.read(asking, source, account, box, uids, keepFrom)
      }
      const plan = imapPlan(asking.text, keepFrom, this.deps.now())
      if (!plan) return []
      const found: OldHit[] = []
      for (const box of source.mailboxes()) {
        if (asking.stopped) return []
        if (!plan.wants(box)) continue
        try {
          await source.open(box)
          let uids: number[] | null = null
          for (const query of plan.searches) {
            const some = new Set(await source.search(query))
            uids = (uids ?? [...some]).filter((uid) => some.has(uid))
            if (uids.length === 0) break
          }
          found.push(...(await this.read(asking, source, account, box, uids ?? [], keepFrom)).filter((hit) => plan.keeps(hit)))
        } catch (e) {
          if (!refused(e)) throw e // a folder that won't be opened or searched is passed over
        } finally {
          source.done()
        }
      }
      return found.sort((a, b) => b.arrived - a.arrived).slice(0, SERVER_HITS)
    } finally {
      asking.sources.delete(source)
      await source.close().catch(() => undefined)
    }
  }

  /** The newest of what a folder's search found, from their headers, leaving out what's kept here
   *  already and anything from inside the window, held mail most of all. */
  private async read(asking: Asking, source: MailSource, account: string, box: MailboxRef, uids: number[], keepFrom: number): Promise<OldHit[]> {
    if (asking.stopped) return []
    const kept = this.deps.store.kept(account, box.id, uids)
    const wanted = uids.filter((uid) => !kept.has(uid)).sort((a, b) => b - a).slice(0, SERVER_HITS)
    const hits: OldHit[] = []
    for await (const found of source.headers(wanted)) {
      if (asking.stopped || found.arrived >= keepFrom) continue
      const mail = await this.deps.parse(Buffer.concat([found.header, Buffer.from('\r\n')]))
      const root = /<[^<>]+>/.exec(mail.references)?.[0] ?? /<[^<>]+>/.exec(mail.inReplyTo)?.[0] ?? mail.messageId
      hits.push({
        account,
        box: box.id,
        uid: found.uid,
        thread: found.thread || threadOf(mail.references, mail.inReplyTo, mail.messageId, `${box.id}:${found.uid}`),
        arrived: found.arrived,
        subject: mail.subject,
        from: mail.from,
        seen: found.seen,
        flagged: found.flagged,
        labels: labelsOf(box, found.labels, source.gmail),
        messageId: mail.messageId,
        root,
        files: /^content-type:\s*multipart\/mixed/im.test(found.header.toString('latin1')),
        warned: mail.warnings.length > 0
      })
    }
    return hits
  }
}
