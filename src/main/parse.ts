import { htmlToText } from 'html-to-text'
import { simpleParser, type AddressObject, type Attachment } from 'mailparser'
import { plainName, reorders } from '@shared/names'
import { splitQuoted } from '@shared/quoted'
import type { Address, AttachmentInfo, HeaderDetails, SenderWarning } from '@shared/types'
import { headerDetails } from './details'
import { inviteOf, type Invite } from './invite'

/** The most of one message kept on this laptop. Attachments are the usual reason to go past it,
 *  and text and HTML normally come first, so a cut message still reads. */
export const MAX_SOURCE = 4 * 1024 * 1024
const MAX_HTML = 2 * 1024 * 1024
/** The most of the pictures placed in a message's HTML written into it, on top of the markup: no more
 *  than a whole message may be. One picture placed many times could make it far more. */
const MAX_PICTURES = MAX_SOURCE
const MAX_TEXT = 512 * 1024
const SNIPPET = 180

/** Where a sender says to go to stop hearing from them. */
export interface Unsubscribe {
  web: string | null
  mail: string | null
  /** The sender takes a plain POST to [web], so no page has to be opened (RFC 8058). */
  oneClick: boolean
}

export interface ParsedMail {
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  messageId: string
  inReplyTo: string
  references: string
  unsubscribe: Unsubscribe | null
  text: string
  html: string | null
  /** Its HTML was too long to keep whole, and was cut. */
  cut: boolean
  snippet: string
  attachments: AttachmentInfo[]
  /** Sent to a list or by a machine, by its own headers. */
  bulk: boolean
  warnings: SenderWarning[]
  invite: Invite | null
  /** Where it came from and how, for its details. */
  details: HeaderDetails
}

/** The people a header names. Their names lose what turns text around or draws nothing, unless
 *  [asWritten], for a warning to see what the sender did. */
function addresses(field: AddressObject | AddressObject[] | undefined, asWritten = false): Address[] {
  const found: Address[] = []
  const named = (name: string | undefined): string => (asWritten ? name ?? '' : plainName(name ?? ''))
  for (const group of Array.isArray(field) ? field : field ? [field] : []) {
    for (const item of group.value) {
      if (item.address) found.push({ name: named(item.name), address: item.address })
      for (const member of item.group ?? []) {
        if (member.address) found.push({ name: named(member.name), address: member.address })
      }
    }
  }
  return found
}

function attachmentInfo(parts: Attachment[]): AttachmentInfo[] {
  // Pictures placed in the body aren't things to list as attachments.
  return parts
    .filter((a) => !a.related)
    .map((a) => ({ name: plainName(a.filename ?? 'attachment'), type: a.contentType, size: a.size }))
}

const headerValue = (lines: readonly { key: string; line: string }[], key: string): string => {
  const found = lines.find((h) => h.key === key)?.line ?? ''
  return found.slice(found.indexOf(':') + 1).replace(/\r?\n[ \t]*/g, ' ').trim()
}

/** A header a stranger wrote: only what's between angle brackets, and only web and mail addresses. */
export function parseUnsubscribe(list: string, post: string): Unsubscribe | null {
  let web: string | null = null
  let mail: string | null = null
  for (const [, target = ''] of list.matchAll(/<([^<>\s]+)>/g)) {
    if (!web && /^https?:\/\//i.test(target)) web = target
    else if (!mail && /^mailto:/i.test(target)) mail = target
  }
  if (!web && !mail) return null
  const oneClick = /^https:/i.test(web ?? '') && /List-Unsubscribe\s*=\s*One-Click/i.test(post)
  return { web, mail, oneClick }
}

const domainOf = (address: string): string => address.split('@')[1]?.toLowerCase() ?? ''

/** The part of a domain that's bought, so mail.example.com and example.com count as the same. */
const baseOf = (domain: string): string => domain.split('.').slice(-2).join('.')

/**
 * Whether a sender may not be who they say. Only ever a warning: the top Authentication-Results is
 * the receiving server's, but a sender can add their own below it, so a pass proves nothing here and
 * none is ever shown. A sender can only forge a failure against themselves.
 */
export function senderWarnings(mail: { from: Address; replyTo: Address[]; authentication: string; bulk: boolean }): SenderWarning[] {
  const found: SenderWarning[] = []
  // Each result opens its own part of the line, after a semicolon. The rest of a part, its comments
  // and quoted values most of all, repeats addresses the sender chose, and `dmarc=pass@evil.example`
  // is a valid one: searched for anywhere, it would be read as the server's answer.
  const results = mail.authentication.replace(/"[^"]*"|\([^()]*\)/g, ' ').split(';').map((part) => part.trim())
  const said = (check: string): string => {
    const result = new RegExp(`^${check}\\s*=\\s*(\\w+)`, 'i')
    for (const part of results) {
      const answer = result.exec(part)?.[1]
      if (answer) return answer.toLowerCase()
    }
    return ''
  }
  const both = said('spf') === 'fail' && said('dkim') === 'fail'
  if (said('dmarc') === 'fail' || both) found.push('forged')
  const inName = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,}/i.exec(plainName(mail.from.name.slice(0, 300)))?.[0]?.toLowerCase()
  if (inName && inName !== mail.from.address.toLowerCase()) found.push('name-mismatch')
  // A name can turn itself around to show "security@paypal.com" while the check above sees it as
  // written, backwards. No real name needs that.
  if (reorders(mail.from.name.slice(0, 300)) || reorders(mail.from.address)) found.push('hidden')
  const domain = domainOf(mail.from.address)
  if (domain.split('.').some((part) => part.startsWith('xn--')) || /[^\x00-\x7f]/.test(domain)) found.push('lookalike')
  const elsewhere = mail.replyTo.find((who) => baseOf(domainOf(who.address)) !== baseOf(domain))
  if (elsewhere && !mail.bulk) found.push('replies-elsewhere')
  return found
}

const PLAIN_MAIL = /^(no|false)?$/i

function looksBulk(lines: readonly { key: string; line: string }[]): boolean {
  const header = (key: string): string => headerValue(lines, key)
  return Boolean(header('list-id') || header('x-campaign') || header('x-mailchimp-campaign')) ||
    /^(bulk|list|junk)$/i.test(header('precedence')) ||
    !PLAIN_MAIL.test(header('auto-submitted'))
}

const PREVIEW_TEXT = {
  wordwrap: false as const,
  limits: { maxDepth: 200, maxInputLength: MAX_HTML },
  selectors: [
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } })),
    { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'hr', format: 'skip' }
  ]
}

/** A picture written into HTML, which says nothing in a preview and can be most of the HTML's length. */
const PICTURE_DATA = /\bdata:image\/[\w.+-]{1,40};base64,[\w+/=]{200,}/gi

/** What a mail's HTML says, for a preview: no shouted headings, no addresses, no picture names. */
const readableHtml = (html: string): string => {
  try {
    return htmlToText(html.replace(PICTURE_DATA, ''), PREVIEW_TEXT)
  } catch {
    return ''
  }
}

/** Addresses in brackets, as plain parts of newsletters are full of, and rows of dashes. */
const NOISE = /[([<]?https?:\/\/[^\s)\]>]{1,2000}[)\]>]?|[-=_*~#]{4,}/g

/** The line newsletters open with, which is about the email and not in it. */
const BROWSER_LINE = /^\s{0,20}(?:view|read|open|having trouble|trouble viewing|can'?t see)\b.{0,80}\bbrowser\b.{0,30}$/im
const BROWSER_LINE_WITHIN = 400

const withoutBrowserLine = (text: string): string =>
  text.slice(0, BROWSER_LINE_WITHIN).replace(BROWSER_LINE, ' ') + text.slice(BROWSER_LINE_WITHIN)

/** How snippets are made. Counted up when that changes, so the ones already kept are made again. */
export const SNIPPET_RULES = 2

/** A plain part that's really HTML source, as some senders' software writes one: it opens with a tag
 *  or a doctype, or has a few of the tags only markup has. Words about a tag or two are still words. */
const OPENS_AS_HTML = /^\s{0,200}<(?:!doctype|!--|html|head|body|div|p|table|meta|style)\b/i
const MARKUP = /<(?:\/?(?:p|div|br|span|table|tbody|tr|td|a|img|html|body|head|style|font|center)\b[^<>]{0,300}>|!--)/gi
function looksLikeHtml(text: string): boolean {
  if (OPENS_AS_HTML.test(text)) return true
  let tags = 0
  for (const _ of text.slice(0, 20_000).matchAll(MARKUP)) if (++tags >= 3) return true
  return false
}

/** What a plain part writes as entities, as if it were HTML: "We&#39;ve", "&amp;". */
const ENTITY = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,8}));/gi
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: ''
}
const decoded = (text: string): string => text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
  if (name) return NAMED[name.toLowerCase()] ?? whole
  const code = decimal ? Number(decimal) : parseInt(hex ?? '', 16)
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
})

/** What stands in for a picture in text made from HTML, "[image: Logo]" and "[cid:…]"; a template's
 *  blank the sender forgot to fill in, "${first_name}"; and brackets left empty once a link has gone. */
const STAND_INS = /\[(?:image|cid):[^\]\n]{0,200}\]|\$\{[^}\n]{0,80}\}/gi
const EMPTY_BRACKETS = /\(\s{0,20}\)|\[\s{0,20}\]|<\s{0,20}>/g

/** A line or two about what's new in a message: not what it quotes, and not its machinery. */
export function makeSnippet(text: string, html: string | null = null): string {
  const tidy = (words: string): string => withoutBrowserLine(splitQuoted(words).fresh).replace(STAND_INS, ' ').replace(NOISE, ' ')
    .replace(EMPTY_BRACKETS, ' ').replace(/\s+/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim()
  // A plain part that's HTML is read as HTML: the message's own HTML part if it has one, or itself.
  const plain = looksLikeHtml(text) ? readableHtml(html ?? text) : decoded(text)
  const preview = tidy(plain) || (html ? tidy(readableHtml(html)) : '') || plain.replace(/\s+/g, ' ').trim()
  return preview.slice(0, SNIPPET)
}

/** Whether a message carries its own plain text, instead of only HTML for the parser to turn into it. */
function hasTextPart(lines: readonly { key: string; line: string }[], source: Buffer): boolean {
  const type = headerValue(lines, 'content-type')
  if (/^text\/plain/i.test(type)) return true
  if (/^text\/html/i.test(type)) return false
  return source.subarray(0, MAX_SOURCE).includes('text/plain')
}

/** HTML no longer than [max], cut where a tag starts, so no tag is left half-written. */
function capped(html: string, max: number): { html: string; cut: boolean } {
  if (html.length <= max) return { html, cut: false }
  const tag = html.lastIndexOf('<', max)
  return { html: html.slice(0, tag > 0 ? tag : max), cut: true }
}

/** The pictures a message places in its HTML, written in where it names them, as the frame can show
 *  them. They come after the markup is cut, so a large one can't push the words after it out. */
function withPictures(html: string, parts: readonly Attachment[]): string {
  const pictures = new Map<string, Attachment>()
  for (const part of parts) {
    if (part.cid && /^image\/[\w]+$/i.test(part.contentType) && !pictures.has(part.cid)) pictures.set(part.cid, part)
  }
  if (pictures.size === 0) return html
  const urls = new Map<string, string>()
  let room = MAX_PICTURES
  return html.replace(/\bcid:([^'"\s]{1,256})/g, (whole, cid: string) => {
    const part = pictures.get(cid)
    if (!part) return whole
    const url = urls.get(cid) ?? `data:${part.contentType};base64,${part.content.toString('base64')}`
    urls.set(cid, url)
    if (url.length > room) return whole
    room -= url.length
    return url
  })
}

/** Anything a stranger can put in an email ends up here, so it must never throw on bad input. */
export async function parseMail(source: Buffer): Promise<ParsedMail> {
  // Pictures stay as cid: links until the markup is cut, so it's only markup that's measured.
  const mail = await simpleParser(source, { maxHtmlLengthToParse: MAX_HTML, keepCidLinks: true })
  const markup = typeof mail.html === 'string' ? capped(mail.html, MAX_HTML) : null
  const text = (mail.text ?? '').slice(0, MAX_TEXT)
  const sender = addresses(mail.from, true)[0] ?? { name: '', address: '' }
  const from = { name: plainName(sender.name), address: sender.address }
  const replyTo = addresses(mail.replyTo)
  const bulk = looksBulk(mail.headerLines)
  const calendar = (mail.attachments ?? []).find((a) => a.contentType === 'text/calendar')
  return {
    subject: plainName(mail.subject ?? ''),
    from,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    replyTo,
    messageId: mail.messageId ?? '',
    inReplyTo: mail.inReplyTo ?? '',
    references: [mail.references ?? []].flat().join(' '),
    unsubscribe: parseUnsubscribe(headerValue(mail.headerLines, 'list-unsubscribe'), headerValue(mail.headerLines, 'list-unsubscribe-post')),
    text,
    html: markup ? withPictures(markup.html, mail.attachments ?? []) : null,
    cut: markup?.cut ?? false,
    // Text a server made from the HTML shouts its headings, so it only counts if the sender wrote it.
    snippet: makeSnippet(mail.html && !hasTextPart(mail.headerLines, source) ? '' : text, markup?.html ?? null),
    attachments: attachmentInfo(mail.attachments ?? []),
    bulk,
    warnings: senderWarnings({ from: sender, replyTo, bulk, authentication: headerValue(mail.headerLines, 'authentication-results') }),
    invite: calendar ? inviteOf(calendar.content.toString('utf8')) : null,
    details: headerDetails(mail.headerLines, addresses(mail.bcc), mail.date)
  }
}

/** The details from a message's headers alone, as fetched for mail stored before they were kept. */
export async function detailsOf(header: Buffer): Promise<HeaderDetails> {
  const mail = await simpleParser(Buffer.concat([header, Buffer.from('\r\n')]), { maxHtmlLengthToParse: 0 })
  return headerDetails(mail.headerLines, addresses(mail.bcc), mail.date)
}

export interface WholeAttachment {
  name: string
  type: string
  content: Buffer
}

/** The attachments of a message fetched whole, in the same order as `ParsedMail.attachments`. */
export async function attachmentsOf(source: Buffer): Promise<WholeAttachment[]> {
  const mail = await simpleParser(source, { maxHtmlLengthToParse: MAX_HTML })
  return (mail.attachments ?? [])
    .filter((a) => !a.related)
    .map((a) => ({ name: plainName(a.filename ?? 'attachment'), type: a.contentType, content: a.content }))
}

/** A draft from the account's Drafts folder: the person's own, written on another device, or this
 *  laptop's own copy. Its words are kept as text, so nothing of its HTML reaches the composer. */
export interface ParsedDraft {
  messageId: string
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  inReplyTo: string
  references: string
  /** Its files, not the pictures placed in its HTML. Cut drafts list none, since what's there of them is broken. */
  files: WholeAttachment[]
}

export async function parseDraft(source: Buffer, cut = false): Promise<ParsedDraft> {
  const mail = await simpleParser(source, { maxHtmlLengthToParse: MAX_HTML })
  const html = typeof mail.html === 'string' ? mail.html : ''
  const text = mail.text ?? (html ? readableHtml(html) : '')
  return {
    messageId: mail.messageId ?? '',
    from: addresses(mail.from)[0] ?? { name: '', address: '' },
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    bcc: addresses(mail.bcc),
    subject: mail.subject ?? '',
    text: text.slice(0, MAX_TEXT),
    inReplyTo: mail.inReplyTo ?? '',
    references: [mail.references ?? []].flat().join(' '),
    files: cut ? [] : (mail.attachments ?? []).filter((a) => !a.related).map((a) => ({ name: a.filename ?? 'attachment', type: a.contentType, content: a.content }))
  }
}
