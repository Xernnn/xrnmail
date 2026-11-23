import { randomUUID } from 'node:crypto'
import MailComposer from 'nodemailer/lib/mail-composer'
import { splitQuoted } from '@shared/quoted'
import type { Address, Draft, DraftEdit, Quote } from '@shared/types'
import { escapeHtml, formatAddress, partsOf, type OutgoingMail } from './compose'
import type { ParsedDraft } from './parse'

/**
 * Drafts kept in the account's Drafts folder as well as here, as Edison keeps them: what goes up,
 * and what's made of a draft that comes down. Nothing here touches the outside; `service.ts` decides
 * when, and `writer.ts` and `source.ts` do the asking.
 */

/** A draft goes up once it has been left alone this long, so typing doesn't send every keystroke. */
export const DRAFT_QUIET_MS = 4_000
/** ...or once it's been changing for this long, so a long stretch of typing is still kept. */
export const DRAFT_MOST_MS = 60_000
/** The most of a draft read from the server. Past it a draft comes without its files, which is
 *  about what a service takes anyway. */
export const MAX_DRAFT_SOURCE = 36 * 1024 * 1024

/** Nothing in it: a new message nothing has been put in, which isn't kept on the server. */
export function isBlank(draft: Pick<Draft, 'to' | 'cc' | 'bcc' | 'subject' | 'text' | 'files' | 'quote'>): boolean {
  return !draft.to.trim() && !draft.cc.trim() && !draft.bcc.trim() && !draft.subject.trim() && !draft.text.trim() && draft.files.length === 0 && !draft.quote
}

/** Whether saving [edit] would change anything. A composer saves when it's closed, changed or not,
 *  and an unchanged draft needn't go up again. */
export function changes(draft: Draft, edit: DraftEdit): boolean {
  const keys: (keyof DraftEdit)[] = ['account', 'from', 'to', 'cc', 'bcc', 'subject', 'html', 'text']
  return keys.some((key) => draft[key] !== edit[key]) || JSON.stringify(draft.quote) !== JSON.stringify(edit.quote)
}

export function draftMessageId(from: string): string {
  return `<${randomUUID()}@${from.split('@')[1] ?? 'localhost'}>`
}

/** The copy as the server keeps it. Bcc stays on it, as it does on your own copy of what's sent. */
export async function draftRaw(mail: OutgoingMail, messageId: string): Promise<Buffer> {
  const composer = new MailComposer({
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    messageId,
    date: new Date(mail.date),
    inReplyTo: mail.inReplyTo || undefined,
    references: mail.references || undefined,
    attachments: partsOf(mail)
  }).compile()
  composer.keepBcc = true
  return composer.build()
}

const formatted = (people: Address[]): string => people.map(formatAddress).join(', ')

/** Where a draft's text says a picture was, as Gmail and xrnmail write it in the text part. */
const STAND_IN = /\[image: ([^\]\n]{1,200})\]/g
const SAFE_CID = /^[\w.@+$%=-]{1,200}$/

/** The words as the composer's HTML, with each picture where the text says it was, and any the text
 *  doesn't place after them. Only the pictures, and only by Content-ID, come from the copy. */
function wordsWithPictures(words: string, pictures: ParsedDraft['pictures']): { text: string; html: string; placed: ParsedDraft['pictures'] } {
  const cids = new Set<string>()
  const ready = pictures.map((picture) => {
    const cid = SAFE_CID.test(picture.cid) && !cids.has(picture.cid) ? picture.cid : `${randomUUID()}@xrnmail`
    cids.add(cid)
    return { ...picture, cid }
  })
  const left = [...ready]
  const img = (picture: ParsedDraft['pictures'][number]): string =>
    `<img src="cid:${escapeHtml(picture.cid)}" alt="${escapeHtml(picture.name)}" style="max-width:100%">`
  const paragraphs = (text: string): string => escapeHtml(text).replace(/\n/g, '<br>')
  let html = ''
  let from = 0
  for (const match of words.matchAll(STAND_IN)) {
    const at = left.findIndex((picture) => picture.name === match[1])
    if (at < 0) continue
    html += paragraphs(words.slice(from, match.index)) + img(left[at] as ParsedDraft['pictures'][number])
    left.splice(at, 1)
    from = match.index + match[0].length
  }
  html += paragraphs(words.slice(from))
  let text = words
  for (const picture of left) {
    html += `<br>${img(picture)}`
    text += `\n[image: ${picture.name}]`
  }
  return { text, html, placed: ready }
}

/** What's kept of a draft that came from the server, before its files. Its words go into the
 *  composer as text: the HTML is the server's, and can hold a stranger's, so it never reaches the
 *  page. What it quotes is kept apart, as a reply's quote is, and goes out as it was quoted. The
 *  account's signature, which this laptop puts under what's typed, comes off the end of the words,
 *  so a draft that went up from here and came back isn't signed twice. */
export function importedDraft(parsed: ParsedDraft, account: string, own: string[], signature: string):
  Omit<DraftEdit, 'account'> & Pick<Draft, 'inReplyTo' | 'references'> & { pictures: ParsedDraft['pictures'] } {
  const { fresh, quoted } = splitQuoted(parsed.text.replace(/\r\n/g, '\n'))
  // Lines compared without what trails them: a server making text of the HTML drops the space after "--".
  const lines = (text: string): string => text.split('\n').map((line) => line.trimEnd()).join('\n').trimEnd()
  let words = lines(fresh)
  const tail = `--\n${lines(signature.trim())}`
  if (signature.trim() && words.endsWith(tail)) words = words.slice(0, -tail.length)
  words = words.trimEnd()
  const from = parsed.from.address.toLowerCase()
  const quote: Quote | null = quoted.trim()
    ? { kind: parsed.inReplyTo ? 'reply' : 'forward', intro: '', html: null, text: quoted, asIs: true }
    : null
  const placed = wordsWithPictures(words, parsed.pictures ?? [])
  return {
    from: own.includes(from) && from !== account.toLowerCase() ? from : '',
    to: formatted(parsed.to),
    cc: formatted(parsed.cc),
    bcc: formatted(parsed.bcc),
    subject: parsed.subject,
    text: placed.text,
    html: placed.html,
    quote,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    pictures: placed.placed
  }
}
