import type { HeaderDetails } from '@shared/types'

/**
 * What a message's headers say about where it came from and how, for its details panel: the
 * receiving server's checks (SPF, DKIM, DMARC), who mailed it and who signed it as Gmail says them,
 * whether it arrived over TLS, the mailing list it came through, and when the sender dated it.
 *
 * A stranger writes most of a message's headers, so only the lines a receiving server adds on top
 * are read, every value is cut short and kept as text, and nothing here is ever taken as proof: the
 * page shows it as what the server wrote down.
 */

type Lines = readonly { key: string; line: string }[]

const MAX_VALUE = 300
/** Received lines are read from the top only: further down, the sender could have written them. */
const RECEIVED_READ = 6

const valueOf = (line: string): string => line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]*/g, ' ').trim()

const all = (lines: Lines, key: string): string[] => lines.filter((h) => h.key === key).map((h) => valueOf(h.line))

/** Plain printable text, cut to a length a panel can show. */
const tidy = (text: string, max = MAX_VALUE): string =>
  text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max)

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** The domain of an address or a domain, or nothing when it's neither. */
const domainIn = (text: string): string => {
  const domain = text.replace(/^["']|["']$/g, '').split('@').pop()?.toLowerCase().replace(/\.$/, '') ?? ''
  return DOMAIN.test(domain) && domain.length <= 253 ? domain : ''
}

/** The results in one Authentication-Results line (RFC 8601), with comments and quoted strings
 *  taken out first: a sender chooses what goes in those. */
export function readChecks(header: string): Pick<HeaderDetails, 'checks' | 'mailedBy' | 'signedBy'> {
  const none = { checks: null, mailedBy: '', signedBy: [] }
  if (!header.trim()) return none
  const parts = header.slice(0, 8192).replace(/"[^"]*"|\([^()]*\)/g, ' ').split(';').map((part) => part.trim())
  // The first part names the server that checked, unless it's already a result: Microsoft's lines
  // start straight with spf=.
  const first = parts[0] ?? ''
  const by = /^[a-z][\w-]*\s*=/i.test(first) ? '' : tidy(first.split(/\s+/)[0] ?? '', 100)
  const results = by ? parts.slice(1) : parts
  let spf = ''
  let dkim = ''
  let dmarc = ''
  let mailedBy = ''
  const signedBy: string[] = []
  for (const part of results) {
    const found = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part)
    if (!found) continue
    const method = found[1]?.toLowerCase()
    const result = found[2]?.toLowerCase() ?? ''
    const property = (name: string): string => new RegExp(`(?:^|\\s)${name.replace('.', '\\.')}\\s*=\\s*([^\\s;]+)`, 'i').exec(part)?.[1] ?? ''
    if (method === 'spf' && !spf) {
      spf = result
      mailedBy = domainIn(property('smtp.mailfrom')) || domainIn(property('smtp.helo'))
    } else if (method === 'dkim') {
      // Several signatures can be checked; any that passed counts, and each signer is named once.
      if (!dkim || (result === 'pass' && dkim !== 'pass')) dkim = result
      const signer = domainIn(property('header.d')) || domainIn(property('header.i'))
      if (result === 'pass' && signer && !signedBy.includes(signer)) signedBy.push(signer)
    } else if (method === 'dmarc' && !dmarc) dmarc = result
  }
  if (!spf && !dkim && !dmarc) return none
  return { checks: { by, spf, dkim, dmarc }, mailedBy, signedBy: signedBy.slice(0, 4) }
}

/** The name a server signs an Authentication-Results line with, its authserv-id: '' for
 *  Microsoft's, which start straight with a result. */
export function authservId(header: string): string {
  const first = header.slice(0, 1024).replace(/"[^"]*"|\([^()]*\)/g, ' ').split(';')[0]?.trim() ?? ''
  return /^[a-z][\w-]*\s*=/i.test(first) ? '' : (first.split(/\s+/)[0] ?? '').toLowerCase()
}

/** Lines read at most, from the top: the receiving server's are there, and the rest are a sender's. */
const AUTHENTICATION_READ = 8

/**
 * What the receiving server found, from the Authentication-Results it put on top. With [checks],
 * which says whether an authserv-id is the account's own server's, the top line counts only if it
 * is, and so do the lines straight under it that the same server wrote under other names, as
 * iCloud writes one for each check. The first line naming another, or one already read, is where a
 * sender's own begin (RFC 8601 §5). Without [checks], the top line, whoever wrote it.
 */
export function trustedChecks(lines: readonly string[], checks?: (id: string) => boolean): Pick<HeaderDetails, 'checks' | 'mailedBy' | 'signedBy'> {
  const none = { checks: null, mailedBy: '', signedBy: [] }
  const read: ReturnType<typeof readChecks>[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(0, checks ? AUTHENTICATION_READ : 1)) {
    const id = authservId(line)
    if (checks && (!checks(id) || seen.has(id))) break
    seen.add(id)
    read.push(readChecks(line))
  }
  const found = read.filter((one) => one.checks)
  const first = found[0]
  if (!first?.checks) return none
  const pick = (method: 'spf' | 'dkim' | 'dmarc'): string => found.find((one) => one.checks?.[method])?.checks?.[method] ?? ''
  const spf = found.find((one) => one.checks?.spf)
  return {
    checks: { by: first.checks.by, spf: pick('spf'), dkim: found.some((one) => one.checks?.dkim === 'pass') ? 'pass' : pick('dkim'), dmarc: pick('dmarc') },
    mailedBy: spf?.mailedBy ?? '',
    signedBy: [...new Set(found.flatMap((one) => one.signedBy))].slice(0, 4)
  }
}

/** How the message reached the server that received it, from the topmost Received line that says
 *  where it came from: "TLS 1.3", "TLS", or nothing when that line doesn't say. */
export function readTls(received: string[]): string {
  const hop = received.slice(0, RECEIVED_READ).find((line) => /^from\s/i.test(line))
  if (!hop) return ''
  const version = /\(version=TLS(?:v)?1[._]([0-3])\b/i.exec(hop) ?? /\busing\s+TLSv?1\.([0-3])\b/i.exec(hop)
  if (version) return `TLS 1.${version[1]}`
  return /\bwith\s+(E?SMTPS|ESMTPSA|UTF8SMTPSA?|LMTPS|ESMTPS?A)\b/i.test(hop) ? 'TLS' : ''
}

/** A List-Id: the list's own name for itself, and its id, the part between angle brackets. */
export function readList(header: string): HeaderDetails['list'] {
  const value = header.slice(0, 1000)
  const id = /<([^<>\s]+)>/.exec(value)?.[1] ?? ''
  if (!id) return null
  const name = tidy(value.slice(0, value.indexOf('<')).replace(/^\s*"|"\s*$/g, ''), 120)
  return { id: tidy(id, 255), name }
}

/** For a message whose headers couldn't be read. */
export const NO_DETAILS: HeaderDetails = { bcc: [], deliveredTo: '', checks: null, mailedBy: '', signedBy: [], tls: '', list: null, sent: null }

/** Everything the panel needs from a message's headers. [date] is what the parser made of Date;
 *  [checks] says which Authentication-Results are the account's own server's (`trustedChecks`). */
export function headerDetails(lines: Lines, bcc: { name: string; address: string }[], date: Date | undefined, checks?: (id: string) => boolean): HeaderDetails {
  const top = (key: string): string => all(lines, key)[0] ?? ''
  const delivered = /[^\s<>"]+@[^\s<>"]+/.exec(top('delivered-to') || top('x-original-to'))?.[0] ?? ''
  const sent = date && Number.isFinite(date.getTime()) ? date.getTime() : null
  return {
    bcc: bcc.slice(0, 50).map((who) => ({ name: tidy(who.name, 200), address: tidy(who.address, 320) })),
    deliveredTo: tidy(delivered.toLowerCase(), 320),
    ...trustedChecks(all(lines, 'authentication-results'), checks),
    tls: readTls(all(lines, 'received')),
    list: readList(top('list-id')),
    sent
  }
}
