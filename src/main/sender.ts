import { randomUUID } from 'node:crypto'
import { createTransport } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { OutgoingMail } from './compose'
import type { ImapConfig } from './source'

/** What left, for filing a copy where the server doesn't. */
export interface SentCopy {
  raw: Buffer
  messageId: string
}

export interface MailSender {
  /** Signs in and nothing else, to find out now that sending will work. */
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

export class SmtpSender implements MailSender {
  private transport

  constructor(config: SmtpConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      requireTLS: config.security === 'starttls',
      ignoreTLS: config.security === 'none',
      auth: config.accessToken
        ? { type: 'OAuth2', user: config.user, accessToken: config.accessToken }
        : { user: config.user, pass: config.secret },
      connectionTimeout: 20_000,
      socketTimeout: 60_000
    })
  }

  async check(): Promise<void> {
    await this.transport.verify()
  }

  /** Built once, so what's filed in Sent is what left, under the same Message-ID. */
  async send(mail: OutgoingMail): Promise<SentCopy> {
    await this.reachable()
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
      attachments: mail.files.map((file) => ({ filename: file.name, path: file.path, contentType: file.type })),
      icalEvent: mail.ical ? { method: 'REPLY', content: mail.ical } : undefined
    }
    const outgoing = new MailComposer(options).compile()
    let raw: Buffer
    try {
      raw = await outgoing.build()
    } catch {
      throw new Unmade('unmade')
    }
    await this.transport.sendMail({ envelope: outgoing.getEnvelope(), raw })
    const copy = new MailComposer(options).compile()
    copy.keepBcc = true // your own copy says who else got it
    return { raw: await copy.build(), messageId }
  }

  /** Connecting comes first, on its own, because it's the one failure that's certain. nodemailer
   *  reports a connection lost mid-message the same way as one that never opened, and by then the
   *  server may already have the message. */
  private async reachable(): Promise<void> {
    try {
      await this.transport.verify()
    } catch (e) {
      if ((e as { code?: string }).code === 'EAUTH') throw e
      throw new NeverLeft('no connection')
    }
  }

  close(): void {
    this.transport.close()
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
