import { createServer, type Server, type Socket } from 'node:net'

/** A small SMTP server, for checking what would have left and for failing in the ways that matter. */
export class FakeSmtp {
  port = 0
  /** Accepted messages. */
  sent: { from: string; to: string[]; raw: string }[] = []
  /** How many messages reached the end of DATA, kept or not: a retry would show here. */
  received = 0
  /** Takes the message, then hangs up instead of confirming: the sender can't tell if it went. */
  dropAfterData = false
  /** Waits for this before confirming a message, as a slow server does. */
  hold: Promise<void> | null = null
  delivered: (raw: string) => void = () => undefined
  /** Takes this token and no password. */
  token: string | null = null
  private server: Server | null = null
  private sockets = new Set<Socket>()

  constructor(public secret: string) {}

  async listen(port = 0): Promise<number> {
    this.server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
    const address = this.server.address()
    if (typeof address === 'string' || !address) throw new Error('no port')
    this.port = address.port
    return this.port
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => this.sockets.delete(socket))
    socket.write('220 fake ESMTP\r\n')
    let from = ''
    let to: string[] = []
    let pending = ''
    let body: string[] | null = null
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1')
      let at: number
      while ((at = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 2)
        if (body) {
          if (line !== '.') {
            body.push(line.startsWith('..') ? line.slice(1) : line)
            continue
          }
          const raw = body.join('\r\n')
          body = null
          this.received++
          if (this.dropAfterData) return void socket.destroy()
          const message = { from, to, raw }
          const accept = (): void => {
            this.sent.push(message)
            this.delivered(raw)
            socket.write('250 2.0.0 accepted\r\n')
          }
          if (this.hold) void this.hold.then(accept)
          else accept()
          continue
        }
        const verb = line.split(/[ :]/)[0]?.toUpperCase()
        if (verb === 'EHLO' || verb === 'HELO') socket.write(`250-fake\r\n250-AUTH PLAIN LOGIN${this.token ? ' XOAUTH2' : ''}\r\n250 8BITMIME\r\n`)
        else if (verb === 'AUTH') {
          const given = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString()
          const fine = this.token ? given.includes(`auth=Bearer ${this.token}`) : given.endsWith(`\0${this.secret}`)
          socket.write(fine ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n')
        } else if (verb === 'MAIL') {
          from = /<(.*?)>/.exec(line)?.[1] ?? ''
          to = []
          socket.write('250 ok\r\n')
        } else if (verb === 'RCPT') {
          to.push(/<(.*?)>/.exec(line)?.[1] ?? '')
          socket.write('250 ok\r\n')
        } else if (verb === 'DATA') {
          body = []
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else socket.write('250 ok\r\n')
      }
    })
  }
}
