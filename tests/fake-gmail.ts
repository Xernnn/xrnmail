import { createServer, type Server, type Socket } from 'node:net'

/**
 * A small IMAP server speaking Gmail's dialect, so the real client library runs against something
 * real over a real socket. `commands` keeps everything it was sent, which is how the tests prove
 * xrnmail never asks for a change.
 */

export interface FakeMail {
  uid: number
  raw: Buffer
  arrived: Date
  labels: string[]
  flags: string[]
  thread: bigint
  gmailId: bigint
  modseq: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const WRITE_COMMANDS = /^(SELECT|STORE|UID STORE|APPEND|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|DELETE|RENAME|CREATE|SUBSCRIBE|UNSUBSCRIBE)\b/

function imapDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${zone}`
}

function parseSearchDate(text: string): Date {
  const [day, month, year] = text.split('-')
  return new Date(Number(year), MONTHS.indexOf(month ?? ''), Number(day))
}

function inRange(uid: number, range: string, top: number): boolean {
  return range.split(',').some((part) => {
    const [lo, hi] = part.split(':')
    const start = lo === '*' ? top : Number(lo)
    if (hi === undefined) return uid === start
    const end = hi === '*' ? top : Number(hi)
    return uid >= Math.min(start, end) && uid <= Math.max(start, end)
  })
}

const quoted = (label: string): string => `"${label.replace(/\\/g, '\\\\')}"`
const bare = (label: string): string => (label.startsWith('\\') ? label : quoted(label))

export class FakeGmail {
  mails: FakeMail[] = []
  commands: string[] = []
  uidValidity = 1
  modseq = 100
  secret = 'abcdabcdabcdabcd'
  allMail = '[Gmail]/All Mail'
  hasAllMail = true
  dropNextConnection = false
  /** Gmail's documentation shows \\Inbox bare, and real sessions show it quoted. */
  bareLabels = false
  private nextUid = 1
  private server: Server | null = null
  private idlers = new Set<Socket>()
  private sockets = new Set<Socket>()

  async listen(): Promise<number> {
    this.server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (typeof address === 'string' || !address) throw new Error('no port')
    return address.port
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  add(raw: string | Buffer, options: Partial<Pick<FakeMail, 'arrived' | 'labels' | 'flags' | 'thread'>> = {}): number {
    const uid = this.nextUid++
    this.modseq++
    this.mails.push({
      uid,
      raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n')),
      arrived: options.arrived ?? new Date(),
      labels: options.labels ?? ['\\Inbox'],
      flags: options.flags ?? [],
      thread: options.thread ?? 7_000_000_000_000_000_000n + BigInt(uid),
      gmailId: 6_000_000_000_000_000_000n + BigInt(uid),
      modseq: this.modseq
    })
    for (const socket of this.idlers) socket.write(`* ${this.mails.length} EXISTS\r\n`)
    return uid
  }

  change(uid: number, labels: string[], flags: string[] = []): void {
    const mail = this.mails.find((m) => m.uid === uid)
    if (!mail) throw new Error('no such mail')
    mail.labels = labels
    mail.flags = flags
    mail.modseq = ++this.modseq
  }

  remove(uid: number): void {
    this.mails = this.mails.filter((m) => m.uid !== uid)
    this.modseq++
  }

  /** What was asked of the mailbox that would have changed it. */
  writes(): string[] {
    return this.commands.filter((c) => WRITE_COMMANDS.test(c))
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.idlers.delete(socket)
    })
    if (this.dropNextConnection) {
      this.dropNextConnection = false
      socket.destroy()
      return
    }
    socket.write('* OK Gimap ready\r\n')
    let pending = ''
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1')
      let at: number
      while ((at = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 2)
        this.line(socket, line)
      }
    })
  }

  private line(socket: Socket, line: string): void {
    if (this.idlers.has(socket)) {
      if (line.trim().toUpperCase() === 'DONE') {
        this.idlers.delete(socket)
        socket.write(`${(socket as Socket & { idleTag?: string }).idleTag} OK IDLE terminated\r\n`)
      }
      return
    }
    const space = line.indexOf(' ')
    const tag = line.slice(0, space)
    const rest = line.slice(space + 1)
    const words = rest.split(' ')
    const verb = (words[0] ?? '').toUpperCase()
    const full = verb === 'UID' ? `UID ${(words[1] ?? '').toUpperCase()}` : verb
    this.commands.push(verb === 'LOGIN' ? 'LOGIN' : `${full} ${rest.slice(full.length + 1)}`.trim())
    const ok = (text = 'OK'): void => void socket.write(`${tag} OK ${text}\r\n`)
    switch (full) {
      case 'CAPABILITY':
        socket.write('* CAPABILITY IMAP4rev1 UIDPLUS CONDSTORE IDLE X-GM-EXT-1 SPECIAL-USE\r\n')
        return ok()
      case 'ID':
        socket.write('* ID ("name" "GImap")\r\n')
        return ok()
      case 'LOGIN':
        if (rest.includes(this.secret)) return ok('LOGIN completed')
        return void socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      case 'NAMESPACE':
        socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n')
        return ok()
      case 'ENABLE':
        return ok()
      case 'LIST':
      case 'LSUB':
        socket.write(`* ${full} (\\HasNoChildren) "/" "INBOX"\r\n`)
        if (this.hasAllMail) socket.write(`* ${full} (\\All \\HasNoChildren) "/" "${this.allMail}"\r\n`)
        socket.write(`* ${full} (\\Sent \\HasNoChildren) "/" "[Gmail]/Sent Mail"\r\n`)
        return ok()
      case 'STATUS':
        socket.write(`* STATUS "${this.allMail}" (MESSAGES ${this.mails.length} UIDNEXT ${this.nextUid})\r\n`)
        return ok()
      case 'EXAMINE':
      case 'SELECT':
        socket.write('* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n')
        socket.write(`* OK [UIDVALIDITY ${this.uidValidity}] UIDs valid\r\n`)
        socket.write(`* ${this.mails.length} EXISTS\r\n* 0 RECENT\r\n`)
        socket.write(`* OK [UIDNEXT ${this.nextUid}] next\r\n* OK [HIGHESTMODSEQ ${this.modseq}] modseq\r\n`)
        return ok(full === 'EXAMINE' ? '[READ-ONLY] opened' : '[READ-WRITE] opened')
      case 'SEARCH':
      case 'UID SEARCH':
        return this.search(socket, tag, rest)
      case 'FETCH':
      case 'UID FETCH':
        return this.fetch(socket, tag, rest, full === 'UID FETCH')
      case 'NOOP':
        return ok()
      case 'IDLE':
        ;(socket as Socket & { idleTag?: string }).idleTag = tag
        this.idlers.add(socket)
        socket.write('+ idling\r\n')
        return undefined
      case 'LOGOUT':
        socket.write('* BYE\r\n')
        ok()
        return void socket.end()
      default:
        return void socket.write(`${tag} NO not here\r\n`)
    }
  }

  private search(socket: Socket, tag: string, rest: string): void {
    const since = /SINCE (\S+)/i.exec(rest)
    const from = since?.[1] ? parseSearchDate(since[1].replace(/"/g, '')) : null
    const hits = this.mails.filter((m) => !from || m.arrived >= from).map((m) => m.uid)
    socket.write(`* SEARCH ${hits.join(' ')}\r\n${tag} OK SEARCH done\r\n`)
  }

  private fetch(socket: Socket, tag: string, rest: string, byUid: boolean): void {
    const parts = /^(?:UID )?FETCH (\S+) \((.*?)\)(?: \(CHANGEDSINCE (\d+)\))?$/i.exec(rest)
    if (!parts) return void socket.write(`${tag} BAD fetch\r\n`)
    const [, range = '', items = '', changed] = parts
    const top = this.mails.at(-1)?.uid ?? 0
    const peek = /BODY\.PEEK\[\](?:<(\d+)\.(\d+)>)?/i.exec(items)
    const silent = /\bBODY\[/i.test(items.replace(/BODY\.PEEK/gi, ''))
    if (silent) this.commands.push('TOUCHED-SEEN')
    this.mails.forEach((mail, index) => {
      const key = byUid ? mail.uid : index + 1
      if (!inRange(key, range, byUid ? top : this.mails.length)) return
      if (changed && mail.modseq <= Number(changed)) return
      const bits = [`UID ${mail.uid}`, `FLAGS (${mail.flags.join(' ')})`, `MODSEQ (${mail.modseq})`]
      if (/INTERNALDATE/i.test(items)) bits.push(`INTERNALDATE "${imapDate(mail.arrived)}"`)
      if (/RFC822\.SIZE/i.test(items)) bits.push(`RFC822.SIZE ${mail.raw.length}`)
      if (/X-GM-MSGID/i.test(items)) bits.push(`X-GM-MSGID ${mail.gmailId}`)
      if (/X-GM-THRID/i.test(items)) bits.push(`X-GM-THRID ${mail.thread}`)
      if (/X-GM-LABELS/i.test(items)) bits.push(`X-GM-LABELS (${mail.labels.map(this.bareLabels ? bare : quoted).join(' ')})`)
      const head = `* ${index + 1} FETCH (${bits.join(' ')}`
      if (peek) {
        const start = Number(peek[1] ?? 0)
        const body = mail.raw.subarray(start, peek[2] ? start + Number(peek[2]) : undefined)
        socket.write(`${head} BODY[]<${start}> {${body.length}}\r\n`)
        socket.write(body)
        socket.write(')\r\n')
      } else {
        socket.write(`${head})\r\n`)
      }
    })
    socket.write(`${tag} OK FETCH done\r\n`)
  }
}

/** A plain email as it would arrive. */
export function rawMail(options: {
  from?: string
  to?: string
  subject?: string
  text?: string
  html?: string
  date?: Date
  attachment?: { name: string; type: string; body: string }
}): string {
  const boundary = 'BOUNDARY-xrn'
  const lines = [
    `From: ${options.from ?? 'Ada Lovelace <ada@example.com>'}`,
    `To: ${options.to ?? 'me@example.com'}`,
    `Subject: ${options.subject ?? 'Hello'}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.com>`,
    'MIME-Version: 1.0'
  ]
  const parts: string[] = []
  if (options.text !== undefined || !options.html) {
    parts.push(`Content-Type: text/plain; charset=utf-8\n\n${options.text ?? 'Hi there'}`)
  }
  if (options.html) parts.push(`Content-Type: text/html; charset=utf-8\n\n${options.html}`)
  if (options.attachment) {
    const { name, type, body } = options.attachment
    parts.push(
      `Content-Type: ${type}; name="${name}"\nContent-Disposition: attachment; filename="${name}"\n` +
        `Content-Transfer-Encoding: base64\n\n${Buffer.from(body).toString('base64')}`
    )
  }
  if (parts.length === 1) return `${lines.join('\n')}\n${parts[0]}\n`
  const body = parts.map((p) => `--${boundary}\n${p}\n`).join('')
  return `${lines.join('\n')}\nContent-Type: multipart/mixed; boundary="${boundary}"\n\n${body}--${boundary}--\n`
}
