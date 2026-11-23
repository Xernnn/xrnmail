import { randomUUID } from 'node:crypto'
import MailComposer from 'nodemailer/lib/mail-composer'
import SMTPConnection, { type SMTPConnectionAuth } from 'nodemailer/lib/smtp-connection'
import { partsOf, type OutgoingMail } from './compose'
import type { ImapConfig } from './source'
import { noteAttempts } from './sync-log'

/** What left, for filing a copy where the server doesn't. */
export interface SentCopy {
  raw: Buffer
  messageId: string
}

export interface MailSender {
  /** Connects and signs in, and nothing else, to find out now that sending will work. The
   *  connection is kept for [send]. */
  check(): Promise<void>
  send(mail: OutgoingMail): Promise<SentCopy>
  close(): void
}

export type SmtpConfig = ImapConfig

/** It failed before anything was handed over, so trying again can't send it twice. */
export class NeverLeft extends Error {}

/** The message couldn't be put together here, an attachment gone from the profile say, so nothing
 *  was handed over and nothing will be until it's changed. */
export class Unmade extends Error {}

/** One connection for signing in and sending. Signing in first, on its own, is the one failure that's
 *  certain: nodemailer reports a connection lost mid-message the same way as one that never opened,
 *  and by then the server may already have the message. A transport opened a connection to check
 *  and another to send, so the network going between the two failed a message that never left as
 *  "check Sent". */
export class SmtpSender implements MailSender {
  private readonly connection: SMTPConnection
  private signedIn: Promise<void> | null = null
  /** Ends the step under way, when the connection fails during it. */
  private failing: ((e: unknown) => void) | null = null

  constructor(private readonly config: SmtpConfig) {
    this.connection = new SMTPConnection({
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      requireTLS: config.security === 'starttls',
      ignoreTLS: config.security === 'none',
      connectionTimeout: 20_000,
      socketTimeout: 60_000
    })
    // Always listened for: unheard, a connection failing between steps would end the app.
    this.connection.on('error', (e: unknown) => this.failing?.(e))
    this.connection.on('end', () => this.failing?.(Object.assign(new Error('Connection closed'), { code: 'ECONNECTION' })))
  }

  /** A connection that never opened, or a server too busy to sign in just now (a 4xx, SMTP's "not
   *  now"), is NeverLeft. A refused password isn't, and is said as one. */
  check(): Promise<void> {
    this.signedIn ??= noteAttempts(() => this.signIn()).catch((e: unknown) => {
      const { code, responseCode = 0 } = e as { code?: string; responseCode?: number }
      if (code === 'EAUTH' && !(responseCode >= 400 && responseCode < 500)) throw e
      throw new NeverLeft('no connection', { cause: e })
    })
    return this.signedIn
  }

  /** Built once, so what's filed in Sent is what left, under the same Message-ID. */
  async send(mail: OutgoingMail): Promise<SentCopy> {
    await this.check()
    const messageId = `<${randomUUID()}@${mail.from.address.split('@')[1] ?? 'localhost'}>`
    const options = {
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
      attachments: partsOf(mail),
      icalEvent: mail.ical ? { method: 'REPLY', content: mail.ical } : undefined
    }
    const outgoing = new MailComposer(options).compile()
    let raw: Buffer
    try {
      raw = await outgoing.build()
    } catch {
      throw new Unmade('unmade')
    }
    await this.step((done) => this.connection.send(outgoing.getEnvelope(), raw, (e) => done(e)))
    const copy = new MailComposer(options).compile()
    copy.keepBcc = true // your own copy says who else got it
    return { raw: await copy.build(), messageId }
  }

  close(): void {
    this.failing = null
    this.connection.close()
  }

  private async signIn(): Promise<void> {
    await this.step((done) => this.connection.connect((e) => done(e)))
    // As nodemailer's own transport does: a server that offers no sign-in is sent to without one.
    if (this.connection.allowsAuth) await this.step((done) => this.connection.login(this.auth(), (e) => done(e)))
  }

  /** A password, or a token for XOAUTH2, which the service renews before it runs out. */
  private auth(): SMTPConnectionAuth {
    const { user, secret, accessToken } = this.config
    if (!accessToken) return { user, pass: secret }
    const oauth2 = {
      getToken: (_renew: boolean, done: (e: Error | null, token?: string) => void): void => done(null, accessToken),
      buildXOAuth2Token: (token: string): string => Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`).toString('base64')
    }
    return { user, method: 'XOAUTH2', oauth2: oauth2 as unknown as SMTPConnectionAuth['oauth2'] }
  }

  /** One thing on the connection, ended by its own answer or by the connection failing first. */
  private step(run: (done: (e?: unknown) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (e?: unknown): void => {
        if (settled) return
        settled = true
        this.failing = null
        if (e) reject(e)
        else resolve()
      }
      this.failing = done
      run(done)
    })
  }
}

/** Fixed words, as with reading mail: what a server says doesn't reach the page. */
export function describeSendFailure(error: unknown): string {
  const e = error as { code?: string; responseCode?: number }
  if (e?.code === 'EAUTH') return 'The mail server refused this password.'
  if (e?.code === 'EENVELOPE') return "The mail server wouldn't take one of these addresses."
  if (e?.responseCode === 552) return 'The mail server says this message is too big.'
  return 'This may not have been sent. Check Sent before trying again.'
}
