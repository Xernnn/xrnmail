import addressparser from 'nodemailer/lib/addressparser'
import type { Address, Draft, DraftFile, DraftStart, Identity, Quote } from '@shared/types'
import type { MessageDetail } from './store'

/** Turning a message into a reply, and a draft into what's sent. Nothing here touches the outside. */

export interface OutgoingFile extends DraftFile {
  path: string
}

export interface OutgoingMail {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  text: string
  inReplyTo: string
  references: string
  files: OutgoingFile[]
  /** An answer to a calendar invitation, as an .ics. */
  ical?: string
  /** When it's going out, in ms. */
  date: number
}

const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const paragraphs = (text: string): string => escapeHtml(text).replace(/\r?\n/g, '<br>')

export const formatAddress = (who: Address): string =>
  who.name ? `"${who.name.replace(/["\\\r\n]/g, '')}" <${who.address}>` : who.address

const formatList = (list: Address[]): string => list.map(formatAddress).join(', ')

/** What was typed into To, Cc or Bcc. Anything that isn't an address is said, not dropped. */
export function parseRecipients(text: string): Address[] {
  if (!text.trim()) return []
  const found: Address[] = []
  for (const item of addressparser(text.replace(/[\r\n]+/g, ' '), { flatten: true })) {
    const address = item.address.trim()
    if (!EMAIL.test(address)) throw new Error(`Check this address: ${address || item.name}`)
    found.push({ name: item.name, address })
  }
  return found
}

/** A percent sign in an address needn't be an escape, and one that isn't mustn't cost the link. */
const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** A mailto: link only ever fills in a draft for the person to read. Nothing sends itself, and a
 *  Cc or Bcc it asks for is shown in the composer like any other. */
export function parseMailto(raw: string): Extract<DraftStart, { kind: 'new' }> {
  const url = new URL(raw)
  if (url.protocol !== 'mailto:') throw new Error('Bad request')
  const param = (name: string): string => url.searchParams.get(name) ?? ''
  return {
    kind: 'new',
    to: [decoded(url.pathname), param('to')].filter(Boolean).join(', '),
    cc: param('cc'),
    bcc: param('bcc'),
    subject: param('subject'),
    text: param('body')
  }
}

const prefixed = (subject: string, prefix: string, already: RegExp): string =>
  already.test(subject) ? subject : `${prefix} ${subject}`.trim()

export const replySubject = (subject: string): string => prefixed(subject, 'Re:', /^re:/i)
export const forwardSubject = (subject: string): string => prefixed(subject, 'Fwd:', /^fwd?:/i)

/** Who a reply goes to. Your own message is answered to whoever you sent it to. */
export function replyTargets(message: MessageDetail, own: string[], all: boolean): { to: string; cc: string } {
  const fromMe = own.includes(message.from.address.toLowerCase())
  const to = fromMe ? message.to : message.replyTo.length > 0 ? message.replyTo : [message.from]
  if (!all) return { to: formatList(to), cc: '' }
  const seen = new Set([...own, ...to.map((a) => a.address.toLowerCase())])
  const cc = [...message.to, ...message.cc].filter((a) => {
    const address = a.address.toLowerCase()
    if (seen.has(address)) return false
    seen.add(address)
    return true
  })
  return { to: formatList(to), cc: formatList(cc) }
}

const stamp = (at: number): string =>
  new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

export function quoteOf(message: MessageDetail, kind: Quote['kind']): Quote {
  const intro = kind === 'reply'
    ? `On ${stamp(message.date)}, ${formatAddress(message.from)} wrote:`
    : [
        '---------- Forwarded message ---------',
        `From: ${formatAddress(message.from)}`,
        `Date: ${stamp(message.date)}`,
        `Subject: ${message.subject}`,
        `To: ${formatList(message.to)}`
      ].join('\n')
  return { kind, intro, html: message.html, text: message.text }
}

const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex'

function quotedHtml(quote: Quote): string {
  const body = quote.html ?? paragraphs(quote.text)
  const intro = `<div>${paragraphs(quote.intro)}</div>`
  if (quote.kind === 'forward') return `<br>${intro}<br>${body}`
  return `<br>${intro}<blockquote style="${QUOTE_STYLE}">${body}</blockquote>`
}

function quotedText(quote: Quote): string {
  if (quote.kind === 'forward') return `\n\n${quote.intro}\n\n${quote.text}`
  return `\n\n${quote.intro}\n${quote.text.replace(/^/gm, '> ')}`
}

/** What leaves: the person's words, their signature, then what they're answering. */
export function outgoing(draft: Draft, email: string, identity: Identity | undefined, paths: (file: DraftFile) => string, date: number): OutgoingMail {
  const to = parseRecipients(draft.to)
  const cc = parseRecipients(draft.cc)
  const bcc = parseRecipients(draft.bcc)
  if (to.length + cc.length + bcc.length === 0) throw new Error('Add someone to send this to.')
  const signature = identity?.signature.trim() ?? ''
  return {
    date,
    from: { name: identity?.name.trim() ?? '', address: email },
    to,
    cc,
    bcc,
    subject: draft.subject.replace(/[\r\n]+/g, ' '),
    html: [
      draft.html,
      signature ? `<br><div>-- <br>${paragraphs(signature)}</div>` : '',
      draft.quote ? quotedHtml(draft.quote) : ''
    ].join(''),
    text: [
      draft.text,
      signature ? `\n\n-- \n${signature}` : '',
      draft.quote ? quotedText(draft.quote) : ''
    ].join(''),
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    files: draft.files.map((file) => ({ ...file, path: paths(file) })),
    ical: draft.ical
  }
}
