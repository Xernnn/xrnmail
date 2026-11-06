/** How to reach a mail service. Plain connections aren't on offer: a password never travels bare. */

export type Security = 'tls' | 'starttls'

export interface Server {
  host: string
  port: number
  security: Security
}

export type SignIn = 'password' | 'microsoft'

export interface Provider {
  id: string
  name: string
  domains: string[]
  imap: Server
  smtp: Server
  signIn: SignIn
  /** Where to make an app password, for services that won't take the real one. */
  help?: string
  /** The server files sent mail by itself, so a copy from here would be a duplicate. */
  savesSent: boolean
}

const tls = (host: string, port = 993): Server => ({ host, port, security: 'tls' })
const starttls = (host: string, port = 587): Server => ({ host, port, security: 'starttls' })

export const PROVIDERS: Provider[] = [
  {
    id: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
    imap: tls('imap.gmail.com'), smtp: tls('smtp.gmail.com', 465), signIn: 'password', savesSent: true,
    help: 'https://myaccount.google.com/apppasswords'
  },
  {
    id: 'outlook', name: 'Outlook', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: tls('outlook.office365.com'), smtp: starttls('smtp-mail.outlook.com'), signIn: 'microsoft', savesSent: true
  },
  {
    id: 'yahoo', name: 'Yahoo', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    imap: tls('imap.mail.yahoo.com'), smtp: tls('smtp.mail.yahoo.com', 465), signIn: 'password', savesSent: false,
    help: 'https://login.yahoo.com/account/security'
  },
  {
    id: 'icloud', name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: tls('imap.mail.me.com'), smtp: starttls('smtp.mail.me.com'), signIn: 'password', savesSent: false,
    help: 'https://account.apple.com/account/manage'
  },
  {
    id: 'aol', name: 'AOL', domains: ['aol.com'],
    imap: tls('imap.aol.com'), smtp: tls('smtp.aol.com', 465), signIn: 'password', savesSent: false,
    help: 'https://login.aol.com/account/security'
  },
  {
    id: 'fastmail', name: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'],
    imap: tls('imap.fastmail.com'), smtp: tls('smtp.fastmail.com', 465), signIn: 'password', savesSent: false,
    help: 'https://app.fastmail.com/settings/security/devicekeys'
  },
  {
    id: 'zoho', name: 'Zoho', domains: ['zoho.com', 'zohomail.com'],
    imap: tls('imap.zoho.com'), smtp: tls('smtp.zoho.com', 465), signIn: 'password', savesSent: false,
    help: 'https://accounts.zoho.com/home#security/app_password'
  },
  {
    id: 'other', name: 'Other', domains: [],
    imap: tls(''), smtp: tls('', 465), signIn: 'password', savesSent: false
  }
]

export const provider = (id: string): Provider => PROVIDERS.find((p) => p.id === id) ?? (PROVIDERS.at(-1) as Provider)

/** A guess from the address, for filling in the form. Google Workspace and the like land on Other. */
export function providerFor(email: string): Provider {
  const domain = email.trim().toLowerCase().split('@')[1] ?? ''
  return PROVIDERS.find((p) => p.domains.includes(domain)) ?? provider('other')
}

export interface AccountConfig {
  email: string
  /** What signs in. Usually the email, but not always on a company server. */
  user: string
  provider: string
  imap: Server
  smtp: Server
  signIn: SignIn
  savesSent: boolean
  /** Has Gmail's labels and threads, which only the server can say for sure. */
  gmail: boolean
}

export function configFor(email: string, chosen: Provider, over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    email,
    user: email,
    provider: chosen.id,
    imap: chosen.imap,
    smtp: chosen.smtp,
    signIn: chosen.signIn,
    savesSent: chosen.savesSent,
    gmail: chosen.id === 'gmail',
    ...over
  }
}
