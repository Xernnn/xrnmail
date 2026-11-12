import { createServer, type Server, type Socket } from 'node:net'

/**
 * A small IMAP server, so the real client library runs against something real over a real socket.
 * By default it speaks Gmail's dialect: everything in All Mail, with labels, and Trash and Spam apart.
 * With `plain` it's any other mail service: real folders, and none of Gmail's extensions. The options
 * below turn off what servers differ on. `commands` keeps everything it was sent, which is how the
 * tests prove xrnmail never asks for a change.
 */

export interface FakeOptions {
  /** Not Gmail: folders, no labels, no threads. */
  plain?: boolean
  /** Extra folders on a plain server. */
  folders?: string[]
  /** RFC 6851. Without it the client copies and deletes. */
  move?: boolean
  /** RFC 4315. Without it a move doesn't say what the new UIDs are. */
  uidplus?: boolean
  /** RFC 7162. Without it there's no asking what changed. */
  condstore?: boolean
  /** No Archive folder, so the first thing archived has to make one. */
  noArchiveFolder?: boolean
  /** Takes a token instead of a password. */
  token?: string
  /** Refuses a longer command line, as servers do. RFC 7162 asks clients to stay under 8192 octets. */
  maxLine?: number
}

export interface FakeBox {
  path: string
  flag: string
  uidValidity: number
  nextUid: number
  mails: FakeMail[]
}

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
  commands: string[] = []
  boxes: FakeBox[] = []
  modseq = 100
  secret = 'abcdabcdabcdabcd'
  allMail = '[Gmail]/All Mail'
  hasAllMail = true
  dropNextConnection = false
  /** Answer NO to anything that would change the mailbox. */
  refuseWrites = false
  /** Folders whose SEARCH is answered NO, as Gmail does when it's short of time. */
  refuseSearch = new Set<string>()
  /** What was moved out of All Mail, by the folder it went to. */
  moved: { uid: number; to: string }[] = []
  /** Gmail's documentation shows \\Inbox bare, and real sessions show it quoted. */
  bareLabels = false
  /** What the server thinks the time is, for mail it files itself. */
  now: () => Date = () => new Date()
  /** Gmail's own labels, which it lists as folders with nothing special about them. */
  labels: string[] = []
  options: FakeOptions
  private nextThread = 1n
  private server: Server | null = null
  private idlers = new Set<Socket>()
  private sockets = new Set<Socket>()

  constructor(options: FakeOptions = {}) {
    this.options = options
    const box = (path: string, flag = ''): FakeBox => ({ path, flag, uidValidity: 1, nextUid: 1, mails: [] })
    this.boxes = options.plain
      ? [
          box('INBOX'), box('Sent', '\\Sent'), box('Trash', '\\Trash'), box('Junk', '\\Junk'), box('Drafts', '\\Drafts'),
          ...(options.noArchiveFolder ? [] : [box('Archive', '\\Archive')]),
          ...(options.folders ?? []).map((path) => box(path))
        ]
      : [box('[Gmail]/All Mail', '\\All'), box('[Gmail]/Trash', '\\Trash'), box('[Gmail]/Spam', '\\Junk')]
  }

  private get home(): FakeBox {
    return this.boxes[0] as FakeBox
  }

  /** All Mail on Gmail, the inbox anywhere else. */
  get mails(): FakeMail[] {
    return this.home.mails
  }

  set mails(mails: FakeMail[]) {
    this.home.mails = mails
  }

  get uidValidity(): number {
    return this.home.uidValidity
  }

  set uidValidity(value: number) {
    this.home.uidValidity = value
  }

  box(path: string): FakeBox {
    const found = this.boxes.find((b) => b.path === path)
    if (!found) throw new Error(`no folder ${path}`)
    return found
  }

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

  add(raw: string | Buffer, options: Partial<Pick<FakeMail, 'arrived' | 'labels' | 'flags' | 'thread'>> & { box?: string } = {}): number {
    const box = options.box ? this.box(options.box) : this.home
    const uid = box.nextUid++
    this.modseq++
    box.mails.push({
      uid,
      raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n')),
      arrived: options.arrived ?? this.now(),
      labels: options.labels ?? (options.box ? [] : ['\\Inbox']),
      flags: options.flags ?? [],
      thread: options.thread ?? 7_000_000_000_000_000_000n + this.nextThread,
      gmailId: 6_000_000_000_000_000_000n + this.nextThread++,
      modseq: this.modseq
    })
    this.tellIdlers(box, `* ${box.mails.length} EXISTS`)
    return uid
  }

  /** As another device changing a message: whoever waits in IDLE on its folder hears the new flags. */
  change(uid: number, labels: string[], flags: string[] = [], path?: string): void {
    const box = path ? this.box(path) : this.home
    const index = box.mails.findIndex((m) => m.uid === uid)
    const mail = box.mails[index]
    if (!mail) throw new Error('no such mail')
    mail.labels = labels
    mail.flags = flags
    mail.modseq = ++this.modseq
    this.tellIdlers(box, `* ${index + 1} FETCH (UID ${mail.uid} FLAGS (${mail.flags.join(' ')}))`)
  }

  /** As another device archiving or deleting a message: whoever waits in IDLE on its folder hears it go. */
  remove(uid: number, path?: string): void {
    const box = path ? this.box(path) : this.home
    const index = box.mails.findIndex((m) => m.uid === uid)
    box.mails = box.mails.filter((m) => m.uid !== uid)
    this.modseq++
    if (index >= 0) this.tellIdlers(box, `* ${index + 1} EXPUNGE`)
  }

  /** What's said to connections waiting in IDLE on one folder. On Gmail the inbox is All Mail here. */
  private tellIdlers(box: FakeBox, line: string): void {
    for (const socket of this.idlers) if (this.selected(socket) === box) socket.write(`${line}\r\n`)
  }

  private selected(socket: Socket): FakeBox {
    return (socket as Socket & { selected?: FakeBox }).selected ?? this.home
  }

  private capabilities(): string {
    const { plain, move = true, uidplus = true, condstore = true, token } = this.options
    return [
      'IMAP4rev1', 'NAMESPACE', 'IDLE', 'SPECIAL-USE',
      ...(uidplus ? ['UIDPLUS'] : []), ...(condstore ? ['CONDSTORE'] : []), ...(move ? ['MOVE'] : []),
      ...(plain ? [] : ['X-GM-EXT-1']), ...(token ? ['AUTH=XOAUTH2', 'SASL-IR'] : [])
    ].join(' ')
  }

  /** Connections open now. */
  get connections(): number {
    return this.sockets.size
  }

  /** Connections waiting in IDLE now. */
  get idling(): number {
    return this.idlers.size
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
    let held = '' // a command so far, while its literal is on the way
    let literal = 0
    let body: string | null = null
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1')
      for (;;) {
        if (literal > 0) {
          if (pending.length < literal) return
          body = pending.slice(0, literal)
          pending = pending.slice(literal)
          literal = 0
        }
        const at = pending.indexOf('\r\n')
        if (at < 0) return
        const line = pending.slice(0, at)
        pending = pending.slice(at + 2)
        const wants = /\{(\d+)(\+?)\}$/.exec(line)
        if (wants) {
          held = line.slice(0, wants.index)
          literal = Number(wants[1])
          if (!wants[2]) socket.write('+ go ahead\r\n')
          continue
        }
        const whole = `${held}${line}`
        held = ''
        if (whole.length > (this.options.maxLine ?? Infinity)) {
          socket.write(`${whole.slice(0, whole.indexOf(' '))} BAD Command line too long\r\n`)
          continue
        }
        this.line(socket, whole, body)
        body = null
      }
    })
  }

  private line(socket: Socket, line: string, literal: string | null): void {
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
        socket.write(`* CAPABILITY ${this.capabilities()}\r\n`)
        return ok()
      case 'AUTHENTICATE': {
        const given = Buffer.from(words[2] ?? '', 'base64').toString()
        if (this.options.token && given.includes(`auth=Bearer ${this.options.token}`)) return ok('AUTHENTICATE completed')
        return void socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      }
      case 'ID':
        socket.write('* ID ("name" "GImap")\r\n')
        return ok()
      case 'LOGIN':
        if (!this.options.token && rest.includes(this.secret)) return ok('LOGIN completed')
        return void socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      case 'NAMESPACE':
        socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n')
        return ok()
      case 'ENABLE':
        return ok()
      case 'LIST':
      case 'LSUB':
        if (this.options.plain) {
          for (const box of this.boxes) socket.write(`* ${full} (${[box.flag, '\\HasNoChildren'].filter(Boolean).join(' ')}) "/" "${box.path}"\r\n`)
          return ok()
        }
        socket.write(`* ${full} (\\HasNoChildren) "/" "INBOX"\r\n`)
        if (this.hasAllMail) socket.write(`* ${full} (\\All \\HasNoChildren) "/" "${this.allMail}"\r\n`)
        socket.write(`* ${full} (\\Sent \\HasNoChildren) "/" "[Gmail]/Sent Mail"\r\n`)
        socket.write(`* ${full} (\\Trash \\HasNoChildren) "/" "[Gmail]/Trash"\r\n`)
        socket.write(`* ${full} (\\Junk \\HasNoChildren) "/" "[Gmail]/Spam"\r\n`)
        socket.write(`* ${full} (\\HasChildren \\Noselect) "/" "[Gmail]"\r\n`)
        socket.write(`* ${full} (\\Flagged \\HasNoChildren) "/" "[Gmail]/Starred"\r\n`)
        for (const label of this.labels) socket.write(`* ${full} (\\HasNoChildren) "/" ${quoted(label)}\r\n`)
        return ok()
      case 'STATUS':
        socket.write(`* STATUS "${this.home.path}" (MESSAGES ${this.mails.length} UIDNEXT ${this.home.nextUid})\r\n`)
        return ok()
      case 'EXAMINE':
      case 'SELECT': {
        const name = /"([^"]+)"|(\S+)$/.exec(rest.slice(full.length + 1).replace(/ \(.*\)$/, ''))
        const path = name?.[1] ?? name?.[2] ?? ''
        const box = path === this.allMail || (path === 'INBOX' && !this.options.plain) ? this.home : this.boxes.find((b) => b.path === path)
        if (!box) return void socket.write(`${tag} NO no such mailbox\r\n`)
        const session = socket as Socket & { readOnly?: boolean; selected?: FakeBox }
        session.readOnly = full === 'EXAMINE'
        session.selected = box
        socket.write('* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n')
        socket.write(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n`)
        socket.write(`* ${box.mails.length} EXISTS\r\n* 0 RECENT\r\n`)
        socket.write(`* OK [UIDNEXT ${box.nextUid}] next\r\n`)
        if (this.options.condstore !== false) socket.write(`* OK [HIGHESTMODSEQ ${this.modseq}] modseq\r\n`)
        return ok(full === 'EXAMINE' ? '[READ-ONLY] opened' : '[READ-WRITE] opened')
      }
      case 'CREATE': {
        const path = /"?([^"]+)"?$/.exec(rest.slice('CREATE '.length))?.[1] ?? ''
        if (!this.mayWrite(socket, tag)) return undefined
        if (this.boxes.some((b) => b.path === path) || this.labels.includes(path)) return void socket.write(`${tag} NO [ALREADYEXISTS] Duplicate folder name\r\n`)
        if (this.options.plain) this.boxes.push({ path, flag: path === 'Archive' ? '\\Archive' : '', uidValidity: 1, nextUid: 1, mails: [] })
        else this.labels.push(path)
        return ok('CREATE done')
      }
      case 'APPEND': {
        const path = /^APPEND "?([^"\s]+)"?/.exec(rest)?.[1] ?? ''
        if (!this.mayWrite(socket, tag)) return undefined
        const box = this.box(path)
        const uid = this.add(Buffer.from(literal ?? '', 'latin1'), { box: path, flags: /\\Seen/.test(rest) ? ['\\Seen'] : [] })
        return ok(`[APPENDUID ${box.uidValidity} ${uid}] APPEND done`)
      }
      case 'EXPUNGE':
      case 'UID EXPUNGE': {
        const box = this.selected(socket)
        for (let index = box.mails.length - 1; index >= 0; index--) {
          if (box.mails[index]?.flags.includes('\\Deleted')) {
            box.mails.splice(index, 1)
            socket.write(`* ${index + 1} EXPUNGE\r\n`)
          }
        }
        return ok('EXPUNGE done')
      }
      case 'SEARCH':
      case 'UID SEARCH':
        return this.search(socket, tag, rest)
      case 'FETCH':
      case 'UID FETCH':
        return this.fetch(socket, tag, rest, full === 'UID FETCH')
      case 'UID STORE':
        return this.store(socket, tag, rest)
      case 'UID MOVE':
      case 'UID COPY':
        return this.move(socket, tag, rest, full === 'UID COPY')
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

  /** As a real server: a mailbox opened read-only takes no writes. */
  private mayWrite(socket: Socket, tag: string): boolean {
    if ((socket as Socket & { readOnly?: boolean }).readOnly) {
      socket.write(`${tag} NO [READ-ONLY] mailbox is read-only\r\n`)
      return false
    }
    if (this.refuseWrites) {
      socket.write(`${tag} NO refused\r\n`)
      return false
    }
    return true
  }

  private store(socket: Socket, tag: string, rest: string): void {
    const parts = /^UID STORE (\S+) ([+-])(FLAGS(?:\.SILENT)?|X-GM-LABELS) \((.*)\)$/i.exec(rest)
    if (!parts) return void socket.write(`${tag} BAD store\r\n`)
    if (!this.mayWrite(socket, tag)) return undefined
    const [, range = '', sign, item = '', list = ''] = parts
    const values = list.split(' ').map((v) => v.replace(/^"|"$/g, '').replace(/\\\\/g, '\\')).filter(Boolean)
    const box = this.selected(socket)
    const top = box.mails.at(-1)?.uid ?? 0
    box.mails.forEach((mail, index) => {
      if (!inRange(mail.uid, range, top)) return
      const key = /LABELS/i.test(item) ? 'labels' : 'flags'
      mail[key] = sign === '+' ? [...new Set([...mail[key], ...values])] : mail[key].filter((v) => !values.includes(v))
      mail.modseq = ++this.modseq
      socket.write(`* ${index + 1} FETCH (UID ${mail.uid} FLAGS (${mail.flags.join(' ')}) MODSEQ (${mail.modseq}))\r\n`)
    })
    socket.write(`${tag} OK STORE done\r\n`)
  }

  /** As Gmail: moving to INBOX puts mail back in All Mail, under a new UID there, with its label. */
  private target(path: string): { box: FakeBox; labels: string[] } | null {
    if (!this.options.plain && path === 'INBOX') return { box: this.home, labels: ['\\Inbox'] }
    const box = this.boxes.find((b) => b.path === path)
    return box ? { box, labels: [] } : null
  }

  private move(socket: Socket, tag: string, rest: string, copy: boolean): void {
    const parts = /^UID (?:MOVE|COPY) (\S+) "?([^"]+)"?$/i.exec(rest)
    if (!parts) return void socket.write(`${tag} BAD move\r\n`)
    if (!this.mayWrite(socket, tag)) return undefined
    const [, range = '', to = ''] = parts
    const from = this.selected(socket)
    const destination = this.target(to)
    const top = from.mails.at(-1)?.uid ?? 0
    const pairs: [number, number][] = []
    for (let index = from.mails.length - 1; index >= 0; index--) {
      const mail = from.mails[index]
      if (!mail || !inRange(mail.uid, range, top)) continue
      if (destination) {
        const uid = destination.box.nextUid++
        destination.box.mails.push({ ...mail, uid, flags: [...mail.flags], labels: [...mail.labels.filter((l) => !destination.labels.includes(l)), ...destination.labels], modseq: ++this.modseq })
        pairs.push([mail.uid, uid])
      }
      if (copy) continue
      from.mails.splice(index, 1)
      this.moved.push({ uid: mail.uid, to })
      socket.write(`* ${index + 1} EXPUNGE\r\n`)
    }
    this.modseq++
    pairs.reverse()
    const code = this.options.uidplus !== false && destination && pairs.length > 0
      ? `[COPYUID ${destination.box.uidValidity} ${pairs.map((p) => p[0]).join(',')} ${pairs.map((p) => p[1]).join(',')}] `
      : ''
    socket.write(`${tag} OK ${code}done\r\n`)
  }

  private search(socket: Socket, tag: string, rest: string): void {
    if (this.refuseSearch.has(this.selected(socket).path)) return void socket.write(`${tag} NO [UNAVAILABLE] Temporary System Error\r\n`)
    const since = /SINCE (\S+)/i.exec(rest)
    const from = since?.[1] ? parseSearchDate(since[1].replace(/"/g, '')) : null
    const wanted = /HEADER "?MESSAGE-ID"? "?([^"]+)"?/i.exec(rest)?.[1]
    const hits = this.selected(socket).mails
      .filter((m) => !from || m.arrived >= from)
      .filter((m) => !wanted || m.raw.toString('latin1').includes(wanted))
      .map((m) => m.uid)
    socket.write(`* SEARCH ${hits.join(' ')}\r\n${tag} OK SEARCH done\r\n`)
  }

  private fetch(socket: Socket, tag: string, rest: string, byUid: boolean): void {
    const parts = /^(?:UID )?FETCH (\S+) \((.*?)\)(?: \(CHANGEDSINCE (\d+)\))?$/i.exec(rest)
    if (!parts) return void socket.write(`${tag} BAD fetch\r\n`)
    const [, range = '', items = '', changed] = parts
    const box = this.selected(socket)
    const top = box.mails.at(-1)?.uid ?? 0
    const peek = /BODY\.PEEK\[\](?:<(\d+)\.(\d+)>)?/i.exec(items)
    const silent = /\bBODY\[/i.test(items.replace(/BODY\.PEEK/gi, ''))
    if (silent) this.commands.push('TOUCHED-SEEN')
    const gmail = !this.options.plain
    box.mails.forEach((mail, index) => {
      const key = byUid ? mail.uid : index + 1
      if (!inRange(key, range, byUid ? top : box.mails.length)) return
      if (changed && mail.modseq <= Number(changed)) return
      const bits = [`UID ${mail.uid}`, `FLAGS (${mail.flags.join(' ')})`]
      if (this.options.condstore !== false) bits.push(`MODSEQ (${mail.modseq})`)
      if (/INTERNALDATE/i.test(items)) bits.push(`INTERNALDATE "${imapDate(mail.arrived)}"`)
      if (/RFC822\.SIZE/i.test(items)) bits.push(`RFC822.SIZE ${mail.raw.length}`)
      if (gmail && /X-GM-MSGID/i.test(items)) bits.push(`X-GM-MSGID ${mail.gmailId}`)
      if (gmail && /X-GM-THRID/i.test(items)) bits.push(`X-GM-THRID ${mail.thread}`)
      if (gmail && /X-GM-LABELS/i.test(items)) bits.push(`X-GM-LABELS (${mail.labels.map(this.bareLabels ? bare : quoted).join(' ')})`)
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
  /** More of them, after [attachment]. */
  attachments?: { name: string; type: string; body: string }[]
  headers?: string[]
}): string {
  const boundary = 'BOUNDARY-xrn'
  const lines = [
    `From: ${options.from ?? 'Ada Lovelace <ada@example.com>'}`,
    `To: ${options.to ?? 'me@example.com'}`,
    `Subject: ${options.subject ?? 'Hello'}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.com>`,
    ...(options.headers ?? []),
    'MIME-Version: 1.0'
  ]
  const parts: string[] = []
  if (options.text !== undefined || !options.html) {
    parts.push(`Content-Type: text/plain; charset=utf-8\n\n${options.text ?? 'Hi there'}`)
  }
  if (options.html) parts.push(`Content-Type: text/html; charset=utf-8\n\n${options.html}`)
  for (const { name, type, body } of [...(options.attachment ? [options.attachment] : []), ...(options.attachments ?? [])]) {
    parts.push(
      `Content-Type: ${type}; name="${name}"\nContent-Disposition: attachment; filename="${name}"\n` +
        `Content-Transfer-Encoding: base64\n\n${Buffer.from(body).toString('base64')}`
    )
  }
  if (parts.length === 1) return `${lines.join('\n')}\n${parts[0]}\n`
  const body = parts.map((p) => `--${boundary}\n${p}\n`).join('')
  return `${lines.join('\n')}\nContent-Type: multipart/mixed; boundary="${boundary}"\n\n${body}--${boundary}--\n`
}
