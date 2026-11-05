import { simpleParser, type AddressObject, type Attachment } from 'mailparser'
import type { Address, AttachmentInfo } from '@shared/types'

/** The most of one message kept on this laptop. Attachments are the usual reason to go past it,
 *  and text and HTML normally come first, so a cut message still reads. */
export const MAX_SOURCE = 4 * 1024 * 1024
const MAX_HTML = 2 * 1024 * 1024
const MAX_TEXT = 512 * 1024
const SNIPPET = 180

export interface ParsedMail {
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  messageId: string
  text: string
  html: string | null
  snippet: string
  attachments: AttachmentInfo[]
}

function addresses(field: AddressObject | AddressObject[] | undefined): Address[] {
  const found: Address[] = []
  for (const group of Array.isArray(field) ? field : field ? [field] : []) {
    for (const item of group.value) {
      if (item.address) found.push({ name: item.name ?? '', address: item.address })
      for (const member of item.group ?? []) {
        if (member.address) found.push({ name: member.name ?? '', address: member.address })
      }
    }
  }
  return found
}

function attachmentInfo(parts: Attachment[]): AttachmentInfo[] {
  // Pictures placed in the body aren't things to list as attachments.
  return parts
    .filter((a) => !a.related)
    .map((a) => ({ name: a.filename ?? 'attachment', type: a.contentType, size: a.size }))
}

export function makeSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET)
}

/** Anything a stranger can put in an email ends up here, so it must never throw on bad input. */
export async function parseMail(source: Buffer): Promise<ParsedMail> {
  const mail = await simpleParser(source, { maxHtmlLengthToParse: MAX_HTML })
  const text = (mail.text ?? '').slice(0, MAX_TEXT)
  return {
    subject: mail.subject ?? '',
    from: addresses(mail.from)[0] ?? { name: '', address: '' },
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    messageId: mail.messageId ?? '',
    text,
    html: typeof mail.html === 'string' ? mail.html.slice(0, MAX_HTML) : null,
    snippet: makeSnippet(text),
    attachments: attachmentInfo(mail.attachments ?? [])
  }
}
