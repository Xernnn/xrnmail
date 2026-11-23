import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MessageDetails, MessageView, SenderWarning } from '@shared/types'
import { senderWarnings, type ParsedMail } from './parse'
import type { MessageDetail } from './store'

/**
 * Messages opened from .eml files: `xrnmail some.eml`, or a file manager's Open With. A file is
 * anyone's bytes, whoever wrote its headers, so it's read and parsed and nothing in it is followed:
 * its Authentication-Results are a claim like any other line, so it's unverified and never "from
 * you", and it's shown read-only, behind the same walls as mail. It's kept here only while its
 * window is open, under a token the window is told and a number below zero the page's calls use,
 * so they can't be taken for a stored message's.
 */

/** As large as a message is let be when it's fetched whole (service.ts MAX_WHOLE). */
export const MOST_FILE = 64 * 1024 * 1024
/** Files open at once; the oldest goes past this, as windows of their own are bounded. */
const MOST_OPEN = 12

export interface Letter {
  token: string
  /** Below zero, so no stored message has it. */
  id: number
  source: Buffer
  mail: ParsedMail
  /** When it says it was sent, or the file's own time. */
  date: number
}

/** The files a launch names: paths ending .eml, and file: URLs, which is what a launcher's %U gives.
 *  A path is from where it was started. Switches, other URLs and the app's own arguments aren't. */
export function filesIn(argv: readonly string[], from: string): string[] {
  const found: string[] = []
  for (const arg of argv) {
    if (/^file:/i.test(arg)) {
      try {
        found.push(fileURLToPath(arg))
      } catch {
        // A file on another host, or not a file URL at all.
      }
    } else if (!arg.startsWith('-') && /\.eml$/i.test(arg) && !/^[a-z][a-z0-9+.-]*:/i.test(arg)) {
      found.push(isAbsolute(arg) ? arg : resolve(from, arg))
    }
  }
  return [...new Set(found)]
}

const ORDER: SenderWarning[] = ['forged', 'self', 'unverified', 'name-mismatch', 'hidden', 'lookalike', 'replies-elsewhere']
/** What a sender's own lines can say about them that no server had to check. */
const WRITTEN: SenderWarning[] = ['name-mismatch', 'hidden', 'lookalike']

/** A file's warnings: unverified always, since nothing here received it, with what's wrong in how its
 *  sender wrote themselves, and replies going elsewhere, which no line in it can excuse. */
export function fileWarnings(mail: ParsedMail): SenderWarning[] {
  const unchecked = senderWarnings({ from: mail.from, replyTo: mail.replyTo, bulk: mail.bulk, authentication: [] })
  const found = new Set<SenderWarning>(['unverified', ...mail.warnings.filter((w) => WRITTEN.includes(w)), ...unchecked])
  return ORDER.filter((warning) => found.has(warning))
}

/** The file as the reader shows a message, for [account] when there's one to answer from. */
export function letterView(letter: Letter, account: string): MessageView {
  const { mail } = letter
  return {
    id: letter.id,
    account,
    thread: `file:${letter.token}`,
    subject: mail.subject,
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    date: letter.date,
    text: mail.text,
    html: mail.html,
    snippet: mail.snippet,
    attachments: mail.attachments,
    truncated: mail.cut,
    labels: [],
    seen: true,
    flagged: false,
    unsubscribe: false,
    focused: true,
    facts: null,
    warnings: fileWarnings(mail),
    authenticated: false,
    replyTo: mail.replyTo,
    pinned: false
  }
}

/** As a stored message, for a reply or a forward to be made from. */
export function letterDetail(letter: Letter, account: string): MessageDetail {
  const { mail } = letter
  return {
    ...letterView(letter, account),
    box: '',
    uid: 0,
    messageId: mail.messageId,
    references: mail.references,
    replyTo: mail.replyTo,
    unsubscribeTo: null
  }
}

/** Its details, without what only a receiving server could vouch for: no checks, no envelope, no
 *  TLS, nor who it was delivered to. */
export function letterDetails(letter: Letter): MessageDetails {
  const { details } = letter.mail
  return { ...details, checks: null, mailedBy: '', signedBy: [], tls: '', deliveredTo: '', recorded: true, wroteTo: false }
}

export class Letters {
  private readonly open = new Map<string, Letter>()
  /** Files that couldn't be read, by the token their window was given, with why. */
  private readonly failed = new Map<string, string>()
  private next = -1

  constructor(private readonly parse: (source: Buffer) => Promise<ParsedMail>) {}

  /** Reads a file and parses it. Only a plain file is read, never a pipe or a device, and only one
   *  no bigger than a message can be. */
  async read(path: string): Promise<Letter> {
    const found = await stat(path)
    if (!found.isFile()) throw new Error("That isn't a mail file.")
    if (found.size > MOST_FILE) throw new Error('That file is too big to open here.')
    const source = await readFile(path)
    const mail = await this.parse(source)
    const letter: Letter = { token: randomUUID(), id: this.next--, source, mail, date: mail.details.sent ?? found.mtimeMs }
    this.open.set(letter.token, letter)
    while (this.open.size > MOST_OPEN) this.open.delete(this.open.keys().next().value as string)
    return letter
  }

  get(token: string): Letter | undefined {
    return this.open.get(token)
  }

  /** The letter a page's message number is, if it's one: stored messages are above zero. */
  byId(id: number): Letter | undefined {
    if (id >= 0) return undefined
    for (const letter of this.open.values()) if (letter.id === id) return letter
    return undefined
  }

  /** A token for a window that says why a file couldn't be opened. */
  failure(why: string): string {
    const token = randomUUID()
    this.failed.set(token, why)
    while (this.failed.size > MOST_OPEN) this.failed.delete(this.failed.keys().next().value as string)
    return token
  }

  /** Why the file a token names couldn't be opened, if it couldn't. */
  problem(token: string): string | undefined {
    return this.failed.get(token)
  }

  forget(token: string): void {
    this.open.delete(token)
    this.failed.delete(token)
  }
}
