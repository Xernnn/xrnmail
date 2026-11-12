import { randomUUID } from 'node:crypto'
import MailComposer from 'nodemailer/lib/mail-composer'
import { splitQuoted } from '@shared/quoted'
import type { Address, Draft, DraftEdit, Quote } from '@shared/types'
import { escapeHtml, formatAddress, type OutgoingMail } from './compose'
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
    attachments: mail.files.map((file) => ({ filename: file.name, path: file.path, contentType: file.type }))
  }).compile()
  composer.keepBcc = true
  return composer.build()
}

const formatted = (people: Address[]): string => people.map(formatAddress).join(', ')

/** What's kept of a draft that came from the server, before its files. Its words go into the
 *  composer as text: the HTML is the server's, and can hold a stranger's, so it never reaches the
 *  page. What it quotes is kept apart, as a reply's quote is, and goes out as it was quoted. The
 *  account's signature, which this laptop puts under what's typed, comes off the end of the words,
 *  so a draft that went up from here and came back isn't signed twice. */
export function importedDraft(parsed: ParsedDraft, account: string, own: string[], signature: string): Omit<DraftEdit, 'account'> & Pick<Draft, 'inReplyTo' | 'references'> {
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
  return {
    from: own.includes(from) && from !== account.toLowerCase() ? from : '',
    to: formatted(parsed.to),
    cc: formatted(parsed.cc),
    bcc: formatted(parsed.bcc),
    subject: parsed.subject,
    text: words,
    html: escapeHtml(words).replace(/\n/g, '<br>'),
    quote,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references
  }
}
