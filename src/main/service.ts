import type {
  AccountConfig, AccountView, Address, BatchSettings, Detected, Draft, DraftEdit, DraftStart, HeaderDetails, Identity, ListQuery, MailAction, MessageDetails, MessageView, QuickAction,
  NewAccount, Overview, ProfilePatch, Rsvp, SenderList, Server, Settings, Subscription, SummarySettings, SwipeAction, ThreadRef, ThreadRow, UnsubscribeResult
} from '@shared/types'
import { QUICK_SLOTS } from '@shared/types'
import { editedSenders } from '@shared/keeper'
import { cleanSidebar } from '@shared/sidebar'
import { cleanSearches, withSearch } from '@shared/searches'
import { cleanLater, DEFAULT_LATER } from '@shared/later'
import { cleanAllChanges, isKeySet } from '@shared/keys'
import { configFor, provider, providerFor, type Provider } from '@shared/providers'
import { applied, binOf, endsSnooze, INBOX, labelsOf, reachesBins, takesAway, touched, type MailState } from './actions'
import { sortMail } from './assistant'
import { dayKey, holdOf, isTime, isVip, nextBatchAfter, nextSummaryAfter, type BatchRules } from './batches'
import { draftCopy, escapeHtml, forwardSubject, outgoing, parseMailto, quoteOf, replySubject, replyTargets } from './compose'
import { MAX_DRAFT_BYTES, type DraftFiles } from './draft-files'
import { replyIcs } from './invite'
import { pollDeviceCode, refreshTokens, SignInExpired, startDeviceCode, type DeviceCode, type Tokens } from './oauth'
import { NO_DETAILS } from './details'
import { attachmentsOf, detailsOf, makeSnippet, parseDraft, type WholeAttachment } from './parse'
import { changes, DRAFT_MOST_MS, DRAFT_QUIET_MS, draftMessageId, draftRaw, importedDraft, isBlank, MAX_DRAFT_SOURCE } from './remote-drafts'
import { gmailThreadUrl, isPublicHttps, isSafeHubUrl, safeFileName } from './safe-url'
import type { Secrets } from './secrets'
import { describeSendFailure, NeverLeft, Unmade, type MailSender } from './sender'
import { cleanSecret, type MailSource, type MailWatcher } from './source'
import type { DraftCopy, DraftLink, Located, MessageDetail, PendingAction, Store } from './store'
import { syncAccount } from './sync'
import { Refused, type MailWriter, type Moved } from './writer'

/** Everything the app does, with the clock and the outside world passed in. */

export const EARLY_WAIT_S = 30
/** How long a change that takes mail away waits past the Undo the page offers, before it sets off
 *  for the server. */
const UNDO_GRACE_MS = 1_000
/** How long that is in all, with Undo as long as Settings start out. */
export const UNDO_MS = 5_000 + UNDO_GRACE_MS
const RETRY_MS = 60_000
const REFUSALS_ALLOWED = 3
const NOT_SURE_SENT = 'The app stopped while sending this. Check Sent before trying again.'
const SECRET_GONE = 'Add this account again: its password is gone.'
/** The password is still kept, behind a keyring that wasn't open when the app first asked. The
 *  answer to that first question lasts as long as the app does, hence the restart. */
const KEYRING_SHUT = 'Unlock your system keyring, then restart xrnmail.'
const SIGN_IN_AGAIN = 'Sign in to this account again.'
/** Sends and receives the same 25 MB or so on every big service, once it's encoded. */
const TOO_BIG = 'Mail services take about 18 MB of attachments at most.'
const TOKEN_MARGIN_MS = 60_000
const DAY_MS = 86_400_000
/** A successful sync clears a sync error, and something like a change that was put back has to
 *  stay on screen longer than that to be read at all. */
const NOTE_MS = 10 * 60_000

const DEFAULT_SETTINGS: Settings = {
  batch: { live: false, times: ['09:00', '13:00', '17:00'], vip: [], earlyPerDay: 1 },
  summary: { senders: [], every: 'daily', time: '08:00', day: 1, chosen: false },
  backfillDays: 90,
  hub: { url: '', user: '', connected: false },
  identities: {},
  templates: [],
  blocked: [],
  muted: [],
  notifyFocusedOnly: false,
  undoSeconds: 10,
  undoActionSeconds: 5,
  defaultReply: 'reply',
  quoteReplies: true,
  theme: 'system',
  darkMail: true,
  focused: true,
  alwaysFocused: [],
  alwaysOther: [],
  unsubscribed: [],
  microsoftClientId: '',
  layout: 'panes',
  afterRemove: 'next',
  previewLines: 2,
  attachmentCards: true,
  sidebar: cleanSidebar(null),
  sidebarIcons: true,
  clock24: true,
  keys: 'edison',
  keyChanges: {},
  quickOn: true,
  quickActions: ['archive', 'flag', 'trash', 'read'],
  swipes: true,
  swipeLeft: 'archive',
  swipeLeftLong: 'star',
  swipeRight: 'read',
  swipeRightLong: 'trash',
  background: true,
  startAtLogin: false,
  images: 'ask',
  imagesFrom: [],
  readAfter: 0,
  later: DEFAULT_LATER
}

const SWIPES: readonly SwipeAction[] = ['archive', 'trash', 'read', 'star', 'snooze', 'none']
const swipe = (value: SwipeAction | undefined, fallback: SwipeAction): SwipeAction => (value && SWIPES.includes(value) ? value : fallback)

const QUICK: readonly QuickAction[] = ['archive', 'flag', 'trash', 'read', 'snooze', 'spam', 'none']
/** Always as many as a row has room for, with nothing where the page sent something else. */
const cleanQuick = (actions: QuickAction[]): QuickAction[] =>
  Array.from({ length: QUICK_SLOTS }, (_, i) => (QUICK.includes(actions[i] as QuickAction) ? actions[i] as QuickAction : 'none'))

const ACCOUNT_COLORS = ['#5e7f1b', '#2f6fb2', '#b4532a', '#7a4fb5', '#0f8a7e', '#b03a6a']

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const HUB_SECRET = 'hub'

/** What signs in: a password, or a token for services that have dropped passwords. */
export interface Login {
  secret: string
  accessToken?: string
}

/** A domain's public records, for working out who runs its mail. */
export interface DomainRecords {
  mx(domain: string): Promise<string[]>
  srv(name: string): Promise<{ name: string; port: number } | null>
}

/** One new message, as its notice tells of it. */
export interface Landed extends ThreadRef {
  from: string
  subject: string
}

export interface ServiceDeps {
  store: Store
  secrets: Secrets
  openSource(account: AccountConfig, login: Login): MailSource
  openWriter(account: AccountConfig, login: Login): MailWriter
  openSender(account: AccountConfig, login: Login): MailSender
  /** Not given, the inbox is only looked at on each sync. */
  openWatcher?(account: AccountConfig, login: Login): MailWatcher
  files: DraftFiles
  now(): number
  /** Something on screen may be out of date. */
  changed(): void
  /** New mail landed. [preview] says who and what, and which thread it's in, when it's one message
   *  found the moment it came. */
  landed?(count: number, preview?: Landed): void
  /** A Summary landed: how many messages it brought, and who from. */
  summarized?(count: number, senders: string[]): void
  /** New mail came from these senders, so their faces are worth looking up now, not when it's read. */
  noticed?(addresses: string[]): void
  post?: typeof fetch
  records?: DomainRecords
  earlyWaitSeconds?: number
}

/** Work nobody waits for. It can outlive the store when the app quits, and that's harmless: what
 *  was unfinished is still queued and carries on next time. */
export const background = (work: Promise<unknown>): void => void work.catch(() => undefined)

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, Math.round(Number.isFinite(value) ? value : low)))

const unique = (items: string[]): string[] => [...new Set(items)]

const cleanSenders = (senders: string[]): string[] =>
  unique(senders.map((v) => v.trim().toLowerCase()).filter((v) => v.includes('@'))).slice(0, 200)

/** Text set as a new draft's body, in the form the editor keeps. */
const escapeForEditor = (text: string): string => escapeHtml(text).replace(/\r?\n/g, '<br>')

export function cleanSummary(summary: Partial<SummarySettings>): SummarySettings {
  return {
    senders: cleanSenders(Array.isArray(summary.senders) ? summary.senders : []),
    every: summary.every === 'weekly' ? 'weekly' : 'daily',
    time: typeof summary.time === 'string' && isTime(summary.time) ? summary.time : '08:00',
    day: clamp(Number(summary.day), 0, 6),
    chosen: summary.chosen === true
  }
}

/** Batches need a time to land at, so without one mail is live. Live keeps its times, for
 *  switching back. */
export function cleanBatch(batch: BatchSettings): BatchSettings {
  const times = unique(batch.times.filter(isTime)).sort().slice(0, 12)
  return {
    live: batch.live === true || times.length === 0,
    times,
    vip: cleanSenders(batch.vip),
    earlyPerDay: clamp(batch.earlyPerDay, 0, 5)
  }
}

/** Fixed words: what a server says is never shown, and can't carry anything back to the page. */
export function describeFailure(error: unknown, service = 'the mail server'): string {
  const e = error as { authenticationFailed?: boolean; message?: string }
  if (error instanceof SignInExpired) return SIGN_IN_AGAIN
  if (e?.authenticationFailed) return `${service.charAt(0).toUpperCase()}${service.slice(1)} refused this password.`
  if (e?.message === SECRET_GONE || e?.message === KEYRING_SHUT) return String(e.message)
  if (e?.message?.includes('All Mail') || e?.message?.includes('no folders')) return String(e.message)
  if (e?.message?.includes('read-only')) return String(e.message)
  return `Couldn't reach ${service}.`
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

/** A server someone typed in. Plain connections aren't possible: only the two kinds of TLS pass. */
function checkServer(server: Server | undefined, what: string): Server {
  const fine = server && HOST.test(server.host) && Number.isInteger(server.port) && server.port > 0 && server.port < 65536 &&
    (server.security === 'tls' || server.security === 'starttls')
  if (!fine) throw new Error(`Check the ${what} server.`)
  return { host: server.host.toLowerCase(), port: server.port, security: server.security }
}

/** Who runs a domain's mail, by where its MX records point. */
const MX_OWNERS: [RegExp, string][] = [
  [/\.(google|googlemail)\.com\.?$/i, 'gmail'],
  [/\.(outlook|hotmail)\.com\.?$/i, 'outlook'],
  [/\.mail\.icloud\.com\.?$/i, 'icloud'],
  [/\.messagingengine\.com\.?$/i, 'fastmail'],
  [/\.zoho\.[a-z.]+$/i, 'zoho'],
  [/\.yahoodns\.net\.?$/i, 'yahoo']
]

const lower = (items: string[]): string[] => items.map((v) => v.trim().toLowerCase())

/** A name typed for a new folder or label, as the parts of its path. What a server keeps for itself,
 *  and what can't be a name anywhere, is turned down in words. */
export function folderParts(name: string, kind: 'folder' | 'label'): string[] {
  const parts = name.split('/').map((part) => part.trim())
  if (!name.trim()) throw new Error(`Give the ${kind} a name.`)
  if (parts.some((part) => !part)) throw new Error('Leave no part of the name empty, before or after a slash.')
  if (name.length > 200) throw new Error('That name is too long.')
  if (/[\u0000-\u001f\u007f*%"\\]/.test(name)) throw new Error('Leave out *, %, " and \\ from the name.')
  const first = parts[0]?.toLowerCase() ?? ''
  if (first === 'inbox' || first === '[gmail]' || first === '[google mail]') throw new Error(`${parts[0]} is the service's own.`)
  return parts
}

type AccountStatus = Pick<AccountView, 'syncedAt' | 'syncing' | 'error' | 'progress'>

/** How many messages have to be coming before it's worth saying so. */
const WORTH_SHOWING = 40
/** How long a lost watch on the inbox waits before trying again. Syncs carry on regardless. */
const WATCH_RETRY_MS = 60_000
/** How many previews are remade at a time, so the app stays quick while it happens. */
const SNIPPET_STEP = 50
/** How long a watch waits after the server's last word before syncing, so a burst of them (a
 *  phone marking thirty messages read) is one sync. */
export const WATCH_SETTLE_MS = 750

/** One account's watch on its inbox, from the moment it starts signing in. */
interface Watch {
  stopped: boolean
  watcher: MailWatcher | null
  /** A sync is due once the server has been quiet a moment. */
  settle: NodeJS.Timeout | null
}

export class MailService {
  private status = new Map<string, AccountStatus>()
  private lastTick: number
  private earlyStarted: number | null = null
  private lastHeld: number | null = null
  /** One thing at a time per account: a sync reading Gmail while a change is on its way could put
   *  back what was just archived. */
  private lanes = new Map<string, Promise<unknown>>()
  private flushQueued = new Set<string>()
  private sending = false
  private group: number
  /** Short-lived tokens, kept only in memory. What renews them is in the keyring. */
  private tokens = new Map<string, Tokens>()
  private signingIn: { email: string; clientId: string; code: DeviceCode } | null = null
  private notes = new Map<string, { text: string; until: number }>()
  /** In here before it has signed in, so a second can't start alongside it, and only a watch's own
   *  entry is taken out when it ends: a newer one may have it by then. */
  private watchers = new Map<string, Watch>()
  private watching = false
  private rewatch: NodeJS.Timeout | null = null
  /** Something arrived during a sync, too late for it to have seen. */
  private syncAgain = new Set<string>()
  /** How many times each account has been removed. A pass notes it as it starts, and stops when it
   *  changes, even if the account has been added back since. */
  private removals = new Map<string, number>()
  /** Messages whose files are being listed from the whole message right now. */
  private listing = new Set<number>()
  /** Drafts open in a composer, and how many composers have each. What the server says about one
   *  waits until it's let go. */
  private holds = new Map<number, number>()
  /** When each draft started changing since it last went up, so a long stretch of typing still goes. */
  private dirtySince = new Map<number, number>()
  private draftsQueued = new Set<string>()
  /** An account whose drafts couldn't reach the server waits this long before they try again. */
  private draftsRetryAt = new Map<string, number>()
  /** How often each copy that has to go has been refused. */
  private copyRefusals = new Map<number, number>()
  /** Drafts on the server too big to bring here, so they aren't fetched again each pass. */
  private tooBig = new Set<string>()

  constructor(private deps: ServiceDeps) {
    this.lastTick = deps.now()
    this.group = Math.max(deps.store.lastActionGroup(), deps.now())
    deps.store.failInterrupted(NOT_SURE_SENT)
  }

  private inLane<T>(email: string, work: () => Promise<T>): Promise<T> {
    const last = this.lanes.get(email) ?? Promise.resolve()
    const next = last.then(work, work)
    this.lanes.set(email, next.catch(() => undefined))
    return next
  }

  private get store(): Store {
    return this.deps.store
  }

  private emails(): string[] {
    try {
      return JSON.parse(this.store.meta('accounts') ?? '[]') as string[]
    } catch {
      return []
    }
  }

  private saveEmails(emails: string[]): void {
    this.store.setMeta('accounts', JSON.stringify(emails))
  }

  private statusOf(email: string): AccountStatus {
    let found = this.status.get(email)
    if (!found) {
      found = { syncedAt: null, syncing: false, error: null, progress: null }
      this.status.set(email, found)
    }
    return found
  }

  /** How to reach an account. One added before there were other services is Gmail. */
  private config(email: string): AccountConfig {
    try {
      const saved = JSON.parse(this.store.meta(`config:${email}`) ?? 'null') as AccountConfig | null
      if (saved) return saved
    } catch {
      // Falls through.
    }
    return configFor(email, provider('gmail'))
  }

  private serviceName(email: string): string {
    const name = provider(this.config(email).provider).name
    return name === 'Other' ? 'the mail server' : name
  }

  private folders(email: string): string[] {
    try {
      return JSON.parse(this.store.meta(`folders:${email}`) ?? '[]') as string[]
    } catch {
      return []
    }
  }

  /** What the server lists, each pass: a folder or label made or taken away elsewhere comes and goes. */
  private noteFolders(email: string, source: MailSource): void {
    this.store.setMeta(`folders:${email}`, JSON.stringify(source.folders()))
  }

  /** A folder, or a Gmail label, made from Edit Menu. It goes straight to the server in the account's
   *  lane, as nothing here could show one the server might refuse, and there's nothing to undo; the
   *  next pass lists it like any other. */
  async createFolder(email: string, name: string): Promise<string> {
    if (!this.emails().includes(email)) throw new Error('That account is gone.')
    const { gmail } = this.config(email)
    const kind = gmail ? 'label' : 'folder'
    const parts = folderParts(name, kind)
    const wanted = parts.join('/').toLowerCase()
    if (this.folders(email).some((path) => path.toLowerCase() === wanted)) throw new Error(`There's a ${kind} called that already.`)
    const service = this.serviceName(email)
    return this.inLane(email, async () => {
      let writer: MailWriter | null = null
      try {
        writer = this.deps.openWriter(this.config(email), await this.login(email))
        await writer.connect()
        const path = await writer.createFolder(parts)
        this.store.setMeta(`folders:${email}`, JSON.stringify(unique([...this.folders(email), path])))
        this.deps.changed()
        return path
      } catch (e) {
        if (e instanceof Refused || (e as { responseStatus?: string })?.responseStatus === 'NO') throw new Error(`${service.charAt(0).toUpperCase()}${service.slice(1)} wouldn't make that ${kind}.`)
        throw new Error(describeFailure(e, service))
      } finally {
        await writer?.close().catch(() => undefined)
      }
    })
  }

  accounts(): AccountView[] {
    const now = this.deps.now()
    return this.emails().map((email) => {
      const config = this.config(email)
      const status = this.statusOf(email)
      const note = this.notes.get(email)
      return {
        id: email,
        email,
        ...status,
        error: status.error ?? (note && note.until > now ? note.text : null),
        provider: config.provider,
        providerName: provider(config.provider).name,
        labels: config.gmail,
        folders: this.folders(email),
        unread: this.store.unreadThreads(now, 'm.account = ?', email),
        otherUnread: this.store.unreadThreads(now, 'm.account = ? AND m.focus = 0', email),
        color: this.identity(email).color
      }
    })
  }

  /** Signs in to read and to send, so a wrong password is said here and not found later. */
  private async verify(config: AccountConfig, login: Login): Promise<AccountConfig> {
    const name = provider(config.provider).name
    const service = name === 'Other' ? 'the mail server' : name
    const source = this.deps.openSource(config, login)
    let checked = config
    try {
      await source.connect()
      const [first] = source.mailboxes()
      if (first) await source.open(first)
      checked = { ...config, gmail: source.gmail, savesSent: config.savesSent || source.gmail }
    } catch (e) {
      throw new Error(describeFailure(e, service))
    } finally {
      await source.close().catch(() => undefined)
    }
    const sender = this.deps.openSender(checked, login)
    try {
      await sender.check()
    } catch {
      throw new Error(`Mail can be read, but ${service} wouldn't sign in to send.`)
    } finally {
      sender.close()
    }
    return checked
  }

  private keepAccount(email: string, config: AccountConfig, secret: string): void {
    this.deps.secrets.set(`account:${email}`, secret)
    this.store.setMeta(`config:${email}`, JSON.stringify(config))
    this.saveEmails([...this.emails(), email])
    this.deps.changed()
    background(this.syncOne(email))
    this.watch(email)
  }

  private cleanEmail(raw: string): string {
    const email = raw.trim().toLowerCase()
    if (!EMAIL.test(email)) throw new Error("That isn't an email address.")
    if (!this.deps.secrets.available()) throw new Error('Unlock your system keyring first.')
    if (this.emails().includes(email)) throw new Error('That account is already here.')
    return email
  }

  async addAccount(account: NewAccount): Promise<void> {
    const email = this.cleanEmail(account.email)
    const chosen: Provider = provider(account.provider)
    if (chosen.signIn === 'microsoft') throw new Error('Outlook signs in with Microsoft, not a password.')
    if (!account.secret.trim()) throw new Error('Enter the password.')
    const custom = chosen.id === 'other'
    const config = configFor(email, chosen, custom ? {
      imap: checkServer(account.imap, 'incoming'),
      smtp: checkServer(account.smtp, 'outgoing'),
      user: account.user?.trim() || email
    } : {})
    // A big service shows its app passwords in groups. On a server of someone's own, a space is a space.
    const secret = custom ? account.secret : cleanSecret(account.secret)
    this.keepAccount(email, await this.verify(config, { secret }), secret)
  }

  async startMicrosoft(rawEmail: string, rawClientId: string): Promise<{ code: string; url: string }> {
    const email = this.cleanEmail(rawEmail)
    const clientId = rawClientId.trim()
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('That application ID should look like 00000000-0000-0000-0000-000000000000.')
    let code: DeviceCode
    try {
      code = await startDeviceCode(this.post, clientId, this.deps.now())
    } catch (e) {
      throw new Error((e as Error).message.includes('application ID') ? (e as Error).message : "Couldn't reach Microsoft.")
    }
    this.signingIn = { email, clientId, code }
    return { code: code.userCode, url: code.url }
  }

  /** Waits for the person to finish on Microsoft's page. */
  async finishMicrosoft(): Promise<void> {
    const pending = this.signingIn
    if (!pending) throw new Error('Start signing in first.')
    const { email, clientId, code } = pending
    let tokens: Tokens | null = null
    while (!tokens) {
      if (this.signingIn !== pending || this.deps.now() > code.expiresAt) throw new Error('The sign-in code ran out. Try again.')
      tokens = await pollDeviceCode(this.post, clientId, code, this.deps.now())
      if (!tokens) await new Promise((resolve) => setTimeout(resolve, code.intervalMs))
    }
    this.signingIn = null
    const domain = email.split('@')[1] ?? ''
    const chosen = provider('outlook')
    // Personal addresses and company ones use different outgoing servers.
    const smtp = chosen.domains.includes(domain) ? chosen.smtp : { ...chosen.smtp, host: 'smtp.office365.com' }
    const config = await this.verify(configFor(email, chosen, { smtp, clientId }), { secret: '', accessToken: tokens.access })
    this.tokens.set(email, tokens)
    this.keepAccount(email, config, tokens.refresh)
  }

  /** Fills in the form for an address on a domain of its own, which is often a big service underneath.
   *  Only ever a guess to be checked by signing in, and only the domain is looked up. */
  async detectProvider(rawEmail: string): Promise<Detected> {
    const email = rawEmail.trim().toLowerCase()
    const known = providerFor(email)
    const domain = email.split('@')[1] ?? ''
    const records = this.deps.records
    if (known.id !== 'other' || !records || !HOST.test(domain)) return { provider: known.id }
    try {
      const hosts = await records.mx(domain)
      const owner = MX_OWNERS.find(([pattern]) => hosts.some((host) => pattern.test(host)))?.[1]
      if (owner) return { provider: owner }
      const imap = await records.srv(`_imaps._tcp.${domain}`)
      const smtp = await records.srv(`_submission._tcp.${domain}`)
      if (!imap || !smtp) return { provider: 'other' }
      return {
        provider: 'other',
        imap: { host: imap.name, port: imap.port, security: 'tls' },
        smtp: { host: smtp.name, port: smtp.port, security: smtp.port === 465 ? 'tls' : 'starttls' }
      }
    } catch {
      return { provider: 'other' }
    }
  }

  private get post(): typeof fetch {
    return this.deps.post ?? fetch
  }

  /** What to sign in with. A token is renewed here, ahead of it running out. */
  private async login(email: string): Promise<Login> {
    const key = `account:${email}`
    const secret = this.deps.secrets.get(key)
    if (!secret) throw new Error(this.deps.secrets.has(key) && !this.deps.secrets.available() ? KEYRING_SHUT : SECRET_GONE)
    const config = this.config(email)
    if (config.signIn !== 'microsoft') return { secret }
    const held = this.tokens.get(email)
    const now = this.deps.now()
    if (held && held.expiresAt > now + TOKEN_MARGIN_MS) return { secret: '', accessToken: held.access }
    // An account from before each kept its own ID used the one in settings, which nothing changes now.
    const tokens = await refreshTokens(this.post, config.clientId || this.settings().microsoftClientId, secret, now)
    this.tokens.set(email, tokens)
    if (tokens.refresh !== secret) this.deps.secrets.set(`account:${email}`, tokens.refresh)
    return { secret: '', accessToken: tokens.access }
  }

  removeAccount(email: string): void {
    this.saveEmails(this.emails().filter((e) => e !== email))
    this.removals.set(email, (this.removals.get(email) ?? 0) + 1)
    const watch = this.watchers.get(email)
    if (watch) this.endWatch(watch)
    this.watchers.delete(email)
    this.deps.secrets.remove(`account:${email}`)
    this.store.deleteMeta(`config:${email}`)
    this.store.deleteMeta(`folders:${email}`)
    this.tokens.delete(email)
    this.notes.delete(email)
    this.store.wipeAccount(email)
    for (const draft of this.store.forgetAccount(email)) {
      this.deps.files.clear(draft)
      this.dirtySince.delete(draft)
    }
    this.draftsRetryAt.delete(email)
    const { identities, ...rest } = this.settings()
    const { [email]: _gone, ...kept } = identities
    const { [email]: _arranged, ...labels } = rest.sidebar.labels ?? {}
    this.saveSettings({ ...rest, identities: kept, sidebar: { ...rest.sidebar, labels } })
    this.status.delete(email)
    this.deps.changed()
  }

  async syncAll(): Promise<void> {
    await Promise.all(this.emails().map((email) => this.syncOne(email)))
  }

  private async syncOne(email: string): Promise<void> {
    if (!this.emails().includes(email)) return
    const status = this.statusOf(email)
    if (status.syncing) return
    status.syncing = true
    this.deps.changed()
    await this.inLane(email, async () => {
      await this.flushNow(email)
      await this.pass(email)
      if (this.draftsDue(email)) await this.pushDraftsNow(email)
    })
    await this.reportHeld()
    if (this.syncAgain.delete(email)) await this.syncOne(email)
  }

  /** Mail shows up as it lands, instead of at the next sync. A sync does the actual reading, so
   *  there's one way into the store, and this only says when. */
  watchAll(): void {
    this.watching = true
    this.emails().forEach((email) => this.watch(email))
  }

  stopWatching(): void {
    this.watching = false
    if (this.rewatch) clearTimeout(this.rewatch)
    this.rewatch = null
    for (const watch of this.watchers.values()) this.endWatch(watch)
    this.watchers.clear()
  }

  private endWatch(watch: Watch): void {
    watch.stopped = true
    if (watch.settle) clearTimeout(watch.settle)
    watch.settle = null
    if (watch.watcher) background(watch.watcher.close())
  }

  private watch(email: string): void {
    const open = this.deps.openWatcher
    if (!open || !this.watching || this.watchers.has(email)) return
    const mine: Watch = { stopped: false, watcher: null, settle: null }
    this.watchers.set(email, mine)
    // Mail landing, leaving the inbox, or read or flagged elsewhere: each is a reason to look, and
    // what's said in one burst is one look.
    const changed = (): void => {
      if (mine.stopped || mine.settle) return
      mine.settle = setTimeout(() => {
        mine.settle = null
        if (mine.stopped) return
        if (this.statusOf(email).syncing) this.syncAgain.add(email)
        else background(this.syncOne(email))
      }, WATCH_SETTLE_MS)
      mine.settle.unref?.()
    }
    const run = async (): Promise<void> => {
      const login = await this.login(email)
      if (mine.stopped || !this.emails().includes(email)) return
      mine.watcher = open(this.config(email), login)
      await mine.watcher.watch(changed)
    }
    const lost = (): void => {
      // A watch that failed partway, signed in but unable to open the inbox say, still holds its
      // connection: left open, one more was added at every try, a minute apart, until the service
      // turned the account away for having too many.
      if (mine.watcher) background(mine.watcher.close())
      if (this.watchers.get(email) !== mine) return // stopped, or a newer watch has taken over
      this.watchers.delete(email)
      if (!this.watching || !this.emails().includes(email) || this.rewatch) return
      this.rewatch = setTimeout(() => {
        this.rewatch = null
        this.emails().forEach((each) => this.watch(each))
      }, WATCH_RETRY_MS)
      this.rewatch.unref?.()
    }
    void run().catch(() => undefined).finally(lost)
  }

  private async pass(email: string): Promise<void> {
    if (!this.emails().includes(email)) return // removed while this waited its turn
    const removals = this.removals.get(email) ?? 0
    const removed = (): boolean => (this.removals.get(email) ?? 0) !== removals
    const status = this.statusOf(email)
    const settings = this.settings()
    const config = this.config(email)
    const focusRules = new Map([...settings.alwaysOther.map((a) => [a, false] as const), ...settings.alwaysFocused.map((a) => [a, true] as const)])
    const known = new Map<string, boolean>()
    const knows = (address: string): boolean => {
      const who = address.toLowerCase()
      let answer = known.get(who)
      if (answer === undefined) {
        answer = isVip(who, settings.batch.vip) || this.store.wroteTo(email, who)
        known.set(who, answer)
      }
      return answer
    }
    const own = this.ownAddresses(email)
    let fresh = 0
    let preview: Landed = { from: '', subject: '', account: email, thread: '' }
    /** Who sent what a Summary has already brought, found by this pass. */
    const summed: string[] = []
    /** Who sent new mail, held or not. */
    const senders: string[] = []
    const blocked: number[] = []
    let source: MailSource | null = null
    try {
      source = this.deps.openSource(config, await this.login(email))
      await source.connect()
      this.noteFolders(email, source)
      await syncAccount(source, this.store, {
        account: email,
        email,
        backfillDays: settings.backfillDays,
        // Read for each message as it's stored: a pass can take a while to sign in and fetch, and
        // mail it stores after a sender went into the Summary, or after going live, must follow that.
        rules: () => this.rules(),
        now: this.deps.now(),
        progress: (done, total) => {
          status.progress = total >= WORTH_SHOWING && done < total ? { done, total } : null
          this.deps.changed()
        },
        busy: (box) => this.store.busyUids(email, box),
        stopped: removed,
        sort: (mail) => sortMail(mail, own, focusRules.get(mail.from.address.toLowerCase()) ?? null, knows(mail.from.address)),
        added: (mail, id, holdFrom) => {
          if (mail.arrived <= holdFrom || binOf(mail.labels) > 0) return
          const current = this.settings() // a sender blocked or muted meanwhile counts
          if (isVip(mail.from.address, current.blocked)) return void blocked.push(id)
          if (mail.from.address) senders.push(mail.from.address)
          if (!isVip(mail.from.address, current.muted) && this.worthTelling(mail.labels, mail.from.address, mail.seen, email, mail.focused) && mail.releaseAt <= this.lastTick) {
            if (mail.summary) summed.push(mail.from.name || mail.from.address)
            else {
              fresh++
              preview = { from: mail.from.name || mail.from.address, subject: mail.subject, account: email, thread: mail.thread }
            }
          }
        }
      })
      await this.readDrafts(email, source, this.deps.now() - settings.backfillDays * DAY_MS, removed)
      status.syncedAt = this.deps.now()
      status.error = null
    } catch (e) {
      status.error = describeFailure(e, this.serviceName(email))
    } finally {
      await source?.close().catch(() => undefined)
      status.syncing = false
      status.progress = null
      this.deps.changed()
    }
    if (removed()) {
      // It stopped at its next step. Anything it kept before that goes the way of the account.
      this.store.wipeAccount(email)
      this.store.deleteMeta(`folders:${email}`)
      return
    }
    const unwanted = this.store.locate(blocked).map((row) => this.store.visibleState(row.id)).filter((s) => s !== null)
    if (unwanted.length > 0) this.change(email, unwanted, { kind: 'trash' }, this.nextGroup(), 0)
    if (senders.length > 0) this.deps.noticed?.(unique(senders.map((a) => a.toLowerCase())))
    if (fresh > 0) this.deps.landed?.(fresh, fresh === 1 ? preview : undefined)
    if (summed.length > 0) this.deps.summarized?.(summed.length, unique(summed))
  }

  /** What decides when mail lands: the batches, who comes straight through, and the Summary. Live,
   *  there are no batch times to wait for, and the Summary keeps its own. */
  private rules(settings = this.settings()): BatchRules {
    const { batch, summary } = settings
    return { times: batch.live ? [] : batch.times, vip: batch.vip, summary }
  }

  /** Mail a sync finds that's already due never passes through a tick's window, which only sees
   *  mail landing from now on, so a sync has to tell about it itself. */
  private worthTelling(labels: string[], from: string, seen: boolean, email: string, focused: boolean): boolean {
    return !seen && labels.includes(INBOX) && !this.ownAddresses(email).includes(from.toLowerCase()) && this.identity(email).notify && (focused || !this.quietOther())
  }

  /** Mail sorted into Other arrives unannounced, when the inbox is split and Settings say so. */
  private quietOther(settings = this.settings()): boolean {
    return settings.focused && settings.notifyFocusedOnly
  }

  /** Who someone is on an account, with anything not yet set filled in. */
  private identity(email: string): Identity {
    const at = this.emails().indexOf(email)
    const spare = ACCOUNT_COLORS[Math.max(0, at) % ACCOUNT_COLORS.length] ?? ''
    const saved: Partial<Identity> = this.settings().identities[email] ?? {}
    return { name: '', signature: '', aliases: [], notify: true, ...saved, color: saved.color || spare }
  }

  private ownAddresses(email: string): string[] {
    return lower([email, ...this.identity(email).aliases])
  }

  /** The account an address is yours on, if it is one of yours. */
  ownerOf(address: string): string | null {
    const who = address.trim().toLowerCase()
    return this.emails().find((email) => this.ownAddresses(email).includes(who)) ?? null
  }

  /** Runs on a timer. Time passing is what delivers a batch and sends what's due, so nothing else
   *  would notice. */
  async tick(): Promise<void> {
    const now = this.deps.now()
    const landed = this.store.landedFrom(this.lastTick, now)
    const senders = landed.filter((mail) => !mail.summary)
    const summed = landed.filter((mail) => mail.summary)
    const batch = senders.length
    const woken = this.store.wokenBetween(this.lastTick, now)
    this.lastTick = now
    if (landed.length + woken > 0) {
      // A muted sender's mail lands like any other, and only goes unannounced.
      const muted = this.settings().muted
      const quiet = this.quietOther()
      const loud = senders.filter((mail) => !isVip(mail.from, muted) && (mail.focused || !quiet)).length + woken
      if (loud > 0) this.deps.landed?.(loud)
      // A Summary is announced as one, apart from the batch.
      const told = summed.filter((mail) => !isVip(mail.from, muted))
      if (told.length > 0) this.deps.summarized?.(told.length, unique(told.map((mail) => mail.name || mail.from)))
      this.deps.changed()
    }
    if (batch > 0) await this.report('batch', batch)
    await Promise.all(this.emails().map((email) => this.flush(email)))
    await this.sendDue()
    await Promise.all(this.emails().map((email) => this.pushDrafts(email)))
  }

  private nextGroup(): number {
    this.group += 1
    return this.group
  }

  private change(email: string, states: MailState[], action: MailAction, group: number, wait: number): void {
    if (states.length === 0) return
    this.store.setMailStates(states.map((state) => applied(state, action)))
    this.store.enqueue({ group, account: email, action, ids: states.map((state) => state.id), before: states, due: this.deps.now() + wait })
    this.deps.changed()
    if (wait === 0) background(this.flush(email))
  }

  /** Done here at once, then sent to the server: straight away, or after Undo's had its chance for
   *  the ones that take mail out of sight. It survives a restart, and waits out being offline. */
  act(targets: ThreadRef[], action: MailAction): number {
    const now = this.deps.now()
    const group = this.nextGroup()
    const wait = takesAway(action) ? this.settings().undoActionSeconds * 1000 + UNDO_GRACE_MS : 0
    for (const email of new Set(targets.map((t) => t.account))) {
      const mine = targets.filter((t) => t.account === email)
      const { gmail } = this.config(email)
      if (action.kind === 'label' && !gmail) throw new Error('Only Gmail has labels. Use Move instead.')
      if (action.kind === 'move' && !this.folders(email).includes(action.to)) throw new Error("That folder isn't there any more.")
      const states = mine.flatMap((ref) => touched(action, this.store.visibleMail(ref, now, reachesBins(action)), gmail))
      this.change(email, states, action, group, wait)
      if (endsSnooze(action)) mine.forEach((ref) => this.store.unsnooze(ref))
    }
    return group
  }

  undo(token: number): void {
    for (const item of this.store.actionsInGroup(token)) {
      this.store.restoreMail(item.before)
      this.store.finishAction(item.id)
    }
    this.deps.changed()
  }

  /** At most one waits behind the one running, so a change made as a flush finishes isn't left for
   *  the next tick, and a stalled connection doesn't pile them up. */
  private async flush(email: string): Promise<void> {
    if (this.flushQueued.has(email) || this.store.dueActions(email, this.deps.now()).length === 0) return
    this.flushQueued.add(email)
    await this.inLane(email, () => {
      this.flushQueued.delete(email)
      return this.flushNow(email)
    })
  }

  private async flushNow(email: string): Promise<void> {
    const due = this.store.dueActions(email, this.deps.now())
    if (due.length === 0) return
    let writer: MailWriter | null = null
    try {
      writer = this.deps.openWriter(this.config(email), await this.login(email))
      await writer.connect()
      for (const item of due) await this.perform(writer, email, item)
    } catch (e) {
      // Not reached, so nothing is lost: it all goes again later, in the same order.
      this.statusOf(email).error = describeFailure(e, this.serviceName(email))
      const later = this.deps.now() + RETRY_MS
      for (const item of this.store.dueActions(email, this.deps.now())) this.store.retryAction(item.id, later, item.attempts)
    } finally {
      await writer?.close().catch(() => undefined)
      this.deps.changed()
    }
  }

  /** Each folder is its own command, and a message's folder and UID are looked up now, not when it
   *  was queued: an earlier move in the queue may have changed both. */
  private async perform(writer: MailWriter, email: string, item: PendingAction): Promise<void> {
    const byBox = new Map<string, Located[]>()
    for (const row of this.store.locate(item.ids)) byBox.set(row.box, [...(byBox.get(row.box) ?? []), row])
    try {
      for (const [box, rows] of byBox) {
        const moved = await writer.apply(box, rows.map((row) => row.uid), item.action)
        this.settle(email, item.action, rows, moved)
      }
    } catch (e) {
      if (!(e instanceof Refused)) throw e
      if (item.attempts + 1 < REFUSALS_ALLOWED) return this.store.retryAction(item.id, this.deps.now() + RETRY_MS, item.attempts + 1)
      this.store.restoreMail(item.before)
      this.store.finishAction(item.id)
      this.note(email, `${this.serviceName(email)} wouldn't make a change, so it's been put back.`)
      return
    }
    this.store.finishAction(item.id)
  }

  private note(email: string, text: string): void {
    this.notes.set(email, { text, until: this.deps.now() + NOTE_MS })
    this.deps.changed()
  }

  /** Brings rows in line with where the server put the mail. Without a new UID to go on, the row goes
   *  and the next sync finds the message where it landed. */
  private settle(email: string, action: MailAction, rows: Located[], moved: Moved | null): void {
    if (action.kind === 'forever') return this.store.dropIds(rows.map((row) => row.id))
    if (!moved) return
    const { to, map } = moved
    if (!to || !map) return this.store.dropIds(rows.map((row) => row.id))
    const { gmail } = this.config(email)
    for (const row of rows) {
      const uid = map.get(row.uid)
      if (uid === undefined) this.store.dropIds([row.id])
      else this.store.rehome(row.id, to.id, uid, gmail ? null : labelsOf(to, [], false))
    }
  }

  snooze(targets: ThreadRef[], until: number): void {
    const now = this.deps.now()
    if (until <= now) throw new Error('Pick a time in the future.')
    targets.forEach((ref) => this.store.snooze(ref, now, until))
    this.deps.changed()
  }

  unsnooze(targets: ThreadRef[]): void {
    targets.forEach((ref) => this.store.unsnooze(ref))
    this.deps.changed()
  }

  /** Only this laptop ever knew what was opened, so this is all there is to forget. */
  clearRecent(): void {
    this.store.forgetSeen()
    this.deps.changed()
  }

  /** The searches made lately, newest first, for the empty search box to offer. */
  searches(): string[] {
    try {
      return cleanSearches(JSON.parse(this.store.meta('searches') ?? '[]'))
    } catch {
      return []
    }
  }

  /** A search was used: it goes first. */
  rememberSearch(text: string): string[] {
    return this.keepSearches(withSearch(this.searches(), text))
  }

  /** One search let go of, or with none named, all of them. */
  forgetSearch(text: string | null): string[] {
    return this.keepSearches(text === null ? [] : this.searches().filter((kept) => kept !== text))
  }

  private keepSearches(list: string[]): string[] {
    this.store.setMeta('searches', JSON.stringify(list))
    return list
  }

  /** Nothing goes to the server: a pin is this laptop's own note about a thread. */
  pin(targets: ThreadRef[], on: boolean): void {
    const now = this.deps.now()
    targets.forEach((ref) => (on ? this.store.pin(ref, now) : this.store.unpin(ref)))
    this.deps.changed()
  }

  overview(): Overview {
    const now = this.deps.now()
    const { summary } = this.settings()
    return {
      held: this.store.heldCount(now),
      nextBatch: this.nextBatch(now),
      earlyLeft: this.earlyLeft(),
      labels: this.store.labelCounts(now),
      otherUnread: this.store.unreadThreads(now, 'm.focus = 0'),
      today: this.store.unreadThreads(now, 'm.arrived >= ?', new Date(now).setHours(0, 0, 0, 0)),
      spam: this.store.spamCount(now),
      assistant: this.store.assistantCounts(now),
      summary: {
        next: summary.senders.length > 0 ? nextSummaryAfter(now, summary) : null,
        held: this.store.summaryHeld(now),
        unread: this.store.summaryUnread(now),
        latest: this.store.latestSummary(now)
      }
    }
  }

  private nextBatch(now: number): number | null {
    const { batch } = this.settings()
    if (batch.live) return null
    return this.store.nextRelease(now) ?? nextBatchAfter(now, batch.times)
  }

  list(query: ListQuery, limit?: number): ThreadRow[] {
    return this.store.list(query, this.deps.now(), limit)
  }

  /** Opening a thread reads it, here and on the server, unless [read] is false (Settings can ask for a
   *  wait first, or for nothing until it's marked read). Only what could be seen counts. It goes to the
   *  top of Recently Seen too, unless it was opened from there: that list keeps still while it's read. */
  thread(account: string, thread: string, bins = false, remember = true, read = true): MessageView[] {
    const now = this.deps.now()
    const messages = this.store.thread(account, thread, now, bins)
    if (remember && messages.length > 0) this.store.saw({ account, thread }, now)
    if (read) this.change(account, this.store.unreadMail({ account, thread }, now, bins), { kind: 'read' }, this.nextGroup(), 0)
    for (const id of this.store.filesCut(messages.map((m) => m.id))) background(this.listFiles(id))
    return messages
  }

  /** A message cut short when it was stored lists only the files in the part that was kept. Once
   *  it's opened, the list is made again from the whole message, so each file can be opened, saved
   *  and forwarded. Failing says nothing: the next look tries again. */
  private async listFiles(id: number): Promise<void> {
    if (this.listing.has(id)) return
    this.listing.add(id)
    try {
      await this.wholeAttachments(id)
      this.deps.changed()
    } finally {
      this.listing.delete(id)
    }
  }

  /** What a message's details panel shows beyond the message. Mail kept before its headers were
   *  read has them read now, from the server and read-only, and kept, so it's asked once. Not being
   *  able to reach the server leaves them unknown, and they're tried again next time. */
  async details(id: number): Promise<MessageDetails> {
    const message = this.store.message(id, this.deps.now())
    if (!message) throw new Error("That message isn't here any more.")
    let found: HeaderDetails | null = this.store.details(id)
    if (!found) {
      let source: MailSource | null = null
      try {
        source = this.deps.openSource(this.config(message.account), await this.login(message.account))
        await source.connect()
        const box = source.mailboxes().find((b) => b.id === message.box)
        if (box) {
          await source.open(box)
          const header = await source.header(message.uid)
          if (header) {
            found = await detailsOf(header)
            this.store.saveDetails(id, found)
          }
        }
      } catch {
        // Unknown for now: the panel says so, and the next look tries again.
      } finally {
        await source?.close().catch(() => undefined)
      }
    }
    return { ...(found ?? NO_DETAILS), recorded: found !== null, wroteTo: this.store.wroteTo(message.account, message.from.address) }
  }

  contacts(text: string): Address[] {
    return text.trim() ? this.store.contacts(text, this.deps.now()) : []
  }

  async attachment(id: number, index: number): Promise<WholeAttachment> {
    const found = (await this.wholeAttachments(id))[index]
    if (!found) throw new Error("That attachment isn't in the message any more.")
    return found
  }

  /** Fetched whole on demand: attachments aren't kept here. Their list is, and if it was made from a
   *  cut copy, it's made again from this. */
  private async wholeAttachments(id: number): Promise<WholeAttachment[]> {
    const { whole } = await this.wholeMessage(id)
    if (!whole) throw new Error("That attachment isn't in the message any more.")
    const found = await attachmentsOf(whole)
    this.store.wholeFiles(id, found.map(({ name, type, content }) => ({ name, type, size: content.length })))
    return found
  }

  /** A message as the server has it, every byte, for View original and Save as .eml. Only what's
   *  read from it is kept here, so it's fetched each time it's asked for. */
  async original(id: number): Promise<{ name: string; bytes: Buffer }> {
    const { message, whole } = await this.wholeMessage(id)
    if (!whole) throw new Error("That message isn't on the server any more.")
    return { name: `${message.subject.trim() || 'Message'}.eml`, bytes: whole }
  }

  private async wholeMessage(id: number): Promise<{ message: MessageDetail; whole: Buffer | null }> {
    const message = this.store.message(id, this.deps.now())
    if (!message) throw new Error("That message isn't here any more.")
    let source: MailSource | null = null
    let whole: Buffer | null = null
    try {
      source = this.deps.openSource(this.config(message.account), await this.login(message.account))
      await source.connect()
      const box = source.mailboxes().find((b) => b.id === message.box)
      if (box) {
        await source.open(box)
        whole = await source.whole(message.uid)
      }
    } catch (e) {
      throw new Error(describeFailure(e, this.serviceName(message.account)))
    } finally {
      await source?.close().catch(() => undefined)
    }
    return { message, whole }
  }

  /** A stranger's header picks the address, so the app only ever sends the fixed request the
   *  standard defines, without credentials, and only because the person pressed the button. */
  async unsubscribe(id: number): Promise<UnsubscribeResult & { url?: string }> {
    const message = this.store.message(id, this.deps.now())
    const to = message?.unsubscribeTo
    if (!message || !to) throw new Error('This sender gives no way to unsubscribe.')
    if (to.oneClick && to.web && isPublicHttps(to.web)) {
      try {
        const response = await this.post(to.web, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000)
        })
        if (response.ok) {
          this.leftBehind(message.from.address)
          return { kind: 'done' }
        }
      } catch {
        // Falls through to the sender's page, if there is one.
      }
    }
    if (to.web) return { kind: 'opened', url: to.web }
    const start = parseMailto(to.mail ?? '')
    const draft = await this.startDraft({ ...start, account: message.account, subject: start.subject || 'Unsubscribe' })
    return { kind: 'draft', draft }
  }

  private leftBehind(address: string): void {
    const settings = this.settings()
    this.saveSettings({ ...settings, unsubscribed: lower([...new Set([...settings.unsubscribed, address])]) })
    this.deps.changed()
  }

  /** Senders mailing in bulk, other than the ones left behind and the ones in the Summary, which
   *  have sides of their own. */
  subscriptions(): Subscription[] {
    const { unsubscribed, summary } = this.settings()
    const left = new Set(unsubscribed)
    return this.store.subscriptions(this.deps.now()).filter((s) => !left.has(s.address) && !isVip(s.address, summary.senders))
  }

  /** The Summary's senders, with what's here from each, most first; then the ones with nothing here. */
  summarySenders(): Subscription[] {
    const { senders } = this.settings().summary
    const here = this.store.sendersOf(senders.filter((s) => !s.startsWith('@')), this.deps.now())
    const gone = senders.filter((address) => !here.some((s) => s.address === address)).sort()
    return [...here, ...gone.map((address) => ({ account: '', name: '', address, count: 0, latest: 0, message: 0, read: 0, week: 0 }))]
  }

  sender(account: string, address: string): Subscription | null {
    return this.store.sender(account, address, this.deps.now())
  }

  /** Senders left behind: first those with mail still here, biggest first, then the ones whose mail has gone. */
  unsubscribed(): Subscription[] {
    const left = this.settings().unsubscribed
    const here = this.store.subscriptions(this.deps.now()).filter((s) => left.includes(s.address))
    const gone = left.filter((address) => !here.some((s) => s.address === address)).sort()
    return [...here, ...gone.map((address) => ({ account: '', name: '', address, count: 0, latest: 0, message: 0, read: 0, week: 0 }))]
  }

  clearSender(account: string, address: string): number {
    return this.act(this.store.threadsFrom(account, address, this.deps.now()), { kind: 'trash' })
  }

  /** A person's say about a sender beats any guess, for what they've sent and what comes next. */
  setFocus(address: string, focused: boolean): void {
    const who = address.trim().toLowerCase()
    const settings = this.settings()
    const without = (list: string[]): string[] => list.filter((a) => a !== who)
    this.saveSettings({
      ...settings,
      alwaysFocused: focused ? [...without(settings.alwaysFocused), who] : without(settings.alwaysFocused),
      alwaysOther: focused ? without(settings.alwaysOther) : [...without(settings.alwaysOther), who]
    })
    this.store.setFocus(who, focused)
    this.deps.changed()
  }

  /** The answer is a draft like any other, so it waits out Undo and goes through the same door. The
   *  organizer's address comes from a stranger, which is why it takes a press of a button. */
  rsvp(id: number, answer: Rsvp): { id: number; when: number } {
    const message = this.store.message(id, this.deps.now())
    const facts = message?.facts
    const invite = facts?.type === 'event' ? facts.invite : null
    if (!message || !invite) throw new Error('This invitation has nothing to answer.')
    const words: Record<Rsvp, string> = { ACCEPTED: 'Accepted', TENTATIVE: 'Maybe', DECLINED: 'Declined' }
    const draft = this.store.addDraft({
      account: message.account, from: invite.attendee, to: invite.organizer, cc: '', bcc: '',
      subject: `${words[answer]}: ${invite.summary || message.subject}`,
      html: '', text: `${words[answer]}: ${invite.summary || message.subject}`,
      quote: null, inReplyTo: message.messageId, references: `${message.references} ${message.messageId}`.trim(),
      files: [], ical: replyIcs(invite, invite.attendee, answer, this.deps.now()), updated: this.deps.now()
    })
    return { id: draft, when: this.send(draft) }
  }

  drafts(): Draft[] {
    return this.store.drafts()
  }

  async startDraft(start: DraftStart): Promise<Draft> {
    const base = {
      from: '', to: '', cc: '', bcc: '', subject: '', html: '', text: '', quote: null, inReplyTo: '', references: '',
      files: [], updated: this.deps.now()
    }
    if (start.kind === 'new') {
      const account = start.account ?? this.emails()[0]
      if (!account) throw new Error('Add an account first.')
      const text = start.text ?? ''
      const html = text ? escapeForEditor(text) : ''
      return this.draftOrThrow(this.store.addDraft({
        ...base, account, to: start.to ?? '', cc: start.cc ?? '', bcc: start.bcc ?? '', subject: start.subject ?? '', text, html
      }))
    }
    const message = this.store.message(start.message, this.deps.now())
    if (!message) throw new Error("That message isn't here any more.")
    if (start.kind === 'forward') {
      const id = this.store.addDraft({
        ...base, account: message.account, subject: forwardSubject(message.subject), quote: quoteOf(message, 'forward')
      })
      // A cut message may have files its stored list doesn't know about.
      if (message.attachments.length > 0 || message.truncated) await this.carryAttachments(id, message.id)
      return this.draftOrThrow(id)
    }
    const own = this.ownAddresses(message.account)
    return this.draftOrThrow(this.store.addDraft({
      ...base,
      account: message.account,
      // Answered from whichever of your addresses it came to.
      from: [...message.to, ...message.cc].map((a) => a.address.toLowerCase()).find((a) => own.includes(a)) ?? '',
      ...replyTargets(message, own, start.kind === 'replyAll'),
      subject: replySubject(message.subject),
      // Settings can start a reply with nothing quoted. It still answers the message, threaded with it.
      quote: this.settings().quoteReplies ? quoteOf(message, 'reply') : null,
      inReplyTo: message.messageId,
      references: `${message.references} ${message.messageId}`.trim()
    }))
  }

  private draftOrThrow(id: number): Draft {
    const draft = this.store.draft(id)
    if (!draft) throw new Error("That draft isn't here any more.")
    return draft
  }

  /** A forward takes every attachment the whole message has, not only those in the list kept here.
   *  Being offline loses them and says so. */
  private async carryAttachments(id: number, message: number): Promise<void> {
    const draft = this.draftOrThrow(id)
    try {
      for (const found of await this.wholeAttachments(message)) {
        draft.files.push(this.deps.files.fromBytes(id, found.name, found.type, found.content))
      }
      this.store.saveDraft(draft)
    } catch {
      this.store.saveDraft({ ...draft, error: "The attachments couldn't be fetched, so they're not on this forward." })
    }
  }

  /** Kept here at once, and in the account's Drafts once it has been left alone a moment. Saving
   *  what's there already changes nothing, so a composer closed untouched sends nothing up. */
  saveDraft(id: number, edit: DraftEdit): void {
    const draft = this.draftOrThrow(id)
    if (draft.state === 'queued' || draft.state === 'sending') throw new Error('This is already on its way.')
    if (!this.emails().includes(edit.account)) throw new Error('That account is gone.')
    if (draft.state === 'draft' && draft.error === null && !changes(draft, edit)) return
    // Moved to another account, its copy leaves the first one's Drafts.
    if (edit.account !== draft.account) this.letCopyGo(id)
    const now = this.deps.now()
    this.store.saveDraft({ ...draft, ...edit, state: 'draft', error: null, updated: now })
    this.touched(id, now)
    this.deps.changed()
  }

  private touched(id: number, now: number): void {
    if (!this.dirtySince.has(id)) this.dirtySince.set(id, now)
  }

  /** A composer has the draft open, or has let it go. */
  holdDraft(id: number, on: boolean): void {
    const holding = (this.holds.get(id) ?? 0) + (on ? 1 : -1)
    if (holding > 0) this.holds.set(id, holding)
    else this.holds.delete(id)
  }

  discardDraft(id: number): void {
    const draft = this.store.draft(id)
    if (draft?.state === 'sending') throw new Error('This is already on its way.')
    this.letCopyGo(id)
    this.store.deleteDraft(id)
    this.deps.files.clear(id)
    this.dirtySince.delete(id)
    this.deps.changed()
  }

  /** The draft's copy on the server is to go, now or as soon as the server can be reached, and the
   *  draft goes up afresh if it's a draft again later. */
  private letCopyGo(id: number): void {
    const link = this.store.draftLink(id)
    if (!link?.copy) return
    this.store.queueDraftCopy(link.account, link.copy)
    this.store.linkDraft(id, null, 0)
    background(this.pushDrafts(link.account))
  }

  /** The drafts of an account that are due to go up: changed since they last did, and left alone
   *  for a moment or changing for a while. All of them when the app is closing. */
  private dueDrafts(email: string, all = false): DraftLink[] {
    const now = this.deps.now()
    return this.store.draftLinks(email).filter((d) => d.state === 'draft' && d.updated > d.pushed &&
      (all || now - d.updated >= DRAFT_QUIET_MS || now - (this.dirtySince.get(d.id) ?? d.updated) >= DRAFT_MOST_MS))
  }

  private draftsDue(email: string, all = false): boolean {
    if (!all && (this.draftsRetryAt.get(email) ?? 0) > this.deps.now()) return false
    return this.store.draftCopies(email).length > 0 || this.dueDrafts(email, all).length > 0
  }

  /** At most one waits behind the one running, as with changes to mail. */
  private async pushDrafts(email: string, all = false): Promise<void> {
    if (this.draftsQueued.has(email) || !this.draftsDue(email, all)) return
    this.draftsQueued.add(email)
    await this.inLane(email, () => {
      this.draftsQueued.delete(email)
      return this.pushDraftsNow(email, all)
    })
  }

  /** Copies that have to go go first, then drafts that changed go up. Not reaching the server loses
   *  nothing: it's all still here, and goes in a minute or with the next sync. */
  private async pushDraftsNow(email: string, all = false): Promise<void> {
    // Asked for before the last try failed, it waits for the time that try set.
    if (!this.emails().includes(email) || !this.draftsDue(email, all)) return
    const copies = this.store.draftCopies(email)
    const due = this.dueDrafts(email, all)
    if (copies.length === 0 && due.length === 0) return
    let writer: MailWriter | null = null
    try {
      writer = this.deps.openWriter(this.config(email), await this.login(email))
      await writer.connect()
      for (const copy of copies) await this.deleteCopy(writer, email, copy)
      for (const { id } of due) await this.pushDraft(writer, email, id)
      this.draftsRetryAt.delete(email)
    } catch {
      this.draftsRetryAt.set(email, this.deps.now() + RETRY_MS)
    } finally {
      await writer?.close().catch(() => undefined)
    }
  }

  /** A copy the server keeps refusing to delete is let go of in the end, and said, rather than
   *  holding up every draft behind it. */
  private async deleteCopy(writer: MailWriter, email: string, copy: DraftCopy & { id: number }): Promise<void> {
    try {
      await writer.deleteDraft(copy)
    } catch (e) {
      if (!(e instanceof Refused)) throw e
      const refused = (this.copyRefusals.get(copy.id) ?? 0) + 1
      this.copyRefusals.set(copy.id, refused)
      if (refused < REFUSALS_ALLOWED) return
      this.note(email, `${this.serviceName(email)} wouldn't delete an old copy of a draft. It may still be in Drafts there.`)
    }
    this.copyRefusals.delete(copy.id)
    this.store.dropDraftCopy(copy.id)
  }

  /** The draft as it is now goes up, and then the copy it replaces goes. It's built from a reading
   *  taken here: what's typed meanwhile leaves it due again, and a draft sent, thrown away or moved
   *  to another account meanwhile takes the new copy straight back off. */
  private async pushDraft(writer: MailWriter, email: string, id: number): Promise<void> {
    const draft = this.store.draft(id)
    const link = this.store.draftLink(id)
    if (!draft || !link || draft.state !== 'draft' || draft.account !== email) return
    const old = link.copy
    if (isBlank(draft)) {
      if (old) await writer.deleteDraft(old)
      this.store.linkDraft(id, null, draft.updated)
      return
    }
    const from = (draft.from || draft.account).toLowerCase()
    const sender = this.ownAddresses(email).includes(from) ? from : email
    const messageId = draftMessageId(sender)
    let raw: Buffer
    try {
      raw = await draftRaw(draftCopy(draft, sender, this.identity(email), (file) => this.deps.files.path(id, file), this.deps.now()), messageId)
    } catch {
      // Something of it can't be read here, a file gone from the profile say: trying again won't
      // help, and it mustn't hold up the drafts after it.
      this.store.linkDraft(id, old, draft.updated)
      return
    }
    let copy: DraftCopy
    try {
      copy = await writer.saveDraft(raw, messageId)
    } catch (e) {
      if (!(e instanceof Refused)) throw e
      // Asking again won't help this version. It stays here, and the next change tries again.
      this.store.linkDraft(id, old, draft.updated)
      this.note(email, `${this.serviceName(email)} wouldn't keep a draft in its Drafts. It's still here.`)
      return
    }
    const now = this.store.draft(id)
    if (!now || now.state !== 'draft' || now.account !== email) {
      await writer.deleteDraft(copy).catch(() => this.store.queueDraftCopy(email, copy))
      return
    }
    this.store.linkDraft(id, copy, draft.updated)
    if (now.updated === draft.updated) this.dirtySince.delete(id)
    if (old && !(old.uid === copy.uid && old.validity === copy.validity)) {
      await writer.deleteDraft(old).catch(() => this.store.queueDraftCopy(email, old))
    }
  }

  /** Drafts from the account's Drafts folder, read-only like the rest of a sync. A draft here whose
   *  copy has gone was sent or thrown away on another device, or replaced there by a newer version,
   *  which comes in as a draft of its own: so a draft changed in one place takes the other's place,
   *  and one changed in both is kept twice, since no one's typing is ever thrown away. A draft open
   *  in a composer, or changed here since it last went up, stays. Drafts saved before the keeping
   *  window began are left on the server. */
  private async readDrafts(email: string, source: MailSource, keepFrom: number, removed: () => boolean): Promise<void> {
    const box = source.drafts()
    if (!box) return
    try {
      const info = await source.open(box)
      const all = new Set(await source.uidsSince(new Date(0)))
      const recent = await source.uidsSince(new Date(keepFrom))
      const known = new Set<number>()
      let changed = false
      for (const link of this.store.draftLinks(email)) {
        const copy = link.copy
        if (!copy) continue
        if (copy.validity !== info.uidValidity) {
          this.store.loseDraftUid(link.id) // found again below by its Message-ID
          continue
        }
        known.add(copy.uid)
        if (all.has(copy.uid) || this.holds.has(link.id) || link.state !== 'draft') continue
        if (link.updated > link.pushed) {
          this.store.linkDraft(link.id, null, 0) // changed here as well: it goes up as a draft of its own
          continue
        }
        this.store.deleteDraft(link.id)
        this.deps.files.clear(link.id)
        this.dirtySince.delete(link.id)
        changed = true
      }
      const going = this.store.draftCopies(email)
      for (const copy of going) if (copy.validity === info.uidValidity) known.add(copy.uid)
      const goingIds = new Set(going.map((copy) => copy.messageId).filter(Boolean))
      const lost = new Map(this.store.draftLinks(email).filter((d) => !d.copy && d.messageId).map((d) => [d.messageId, d]))
      const unknown = recent.filter((uid) => !known.has(uid) && !this.tooBig.has(`${email}:${info.uidValidity}:${uid}`))
      const own = this.ownAddresses(email)
      const { signature } = this.identity(email)
      for await (const remote of source.fetch(unknown, MAX_DRAFT_SOURCE)) {
        if (removed()) return
        const cut = remote.size > MAX_DRAFT_SOURCE
        const parsed = await parseDraft(remote.source, cut)
        // Bigger than can be sent from here, it stays where it is: brought in without its files and
        // changed here, it would go back up without them.
        if (cut || parsed.files.reduce((sum, file) => sum + file.content.length, 0) > MAX_DRAFT_BYTES) {
          this.tooBig.add(`${email}:${info.uidValidity}:${remote.uid}`)
          continue
        }
        const copy = { uid: remote.uid, validity: info.uidValidity, messageId: parsed.messageId }
        const again = lost.get(parsed.messageId)
        if (again) {
          this.store.linkDraft(again.id, copy, again.pushed)
          continue
        }
        if (goingIds.has(parsed.messageId)) continue
        this.keepImported(email, parsed, copy, remote.arrived, own, signature)
        changed = true
      }
      if (changed) this.deps.changed()
    } catch {
      // A Drafts folder that won't open or be searched is read again next time; the rest of the sync stands.
    } finally {
      source.done()
    }
  }

  private keepImported(email: string, parsed: Awaited<ReturnType<typeof parseDraft>>, copy: DraftCopy, saved: number,
    own: string[], signature: string): void {
    const id = this.store.addDraft({ account: email, ...importedDraft(parsed, email, own, signature), files: [], updated: saved }, copy)
    const files = parsed.files.map((file) => this.deps.files.fromBytes(id, safeFileName(file.name), file.type, file.content))
    if (files.length > 0) this.store.saveDraft({ ...this.draftOrThrow(id), files })
  }

  /** [size] is what the file is expected to add, so one that's too big is refused before it's copied. */
  private withFile(id: number, add: (draft: Draft) => Draft['files'][number], size = 0): Draft {
    const draft = this.draftOrThrow(id)
    const used = draft.files.reduce((sum, f) => sum + f.size, 0)
    if (used + size > MAX_DRAFT_BYTES) throw new Error(TOO_BIG)
    const file = add(draft)
    const files = [...draft.files, file]
    if (used + file.size > MAX_DRAFT_BYTES) {
      this.deps.files.remove(id, file)
      throw new Error(TOO_BIG)
    }
    this.store.saveDraft({ ...draft, files })
    this.deps.changed()
    return this.draftOrThrow(id)
  }

  /** Paths come from the system's file picker in the main process, never from the page. Each is
   *  measured first: copying a big one whole, on this process, only to refuse it, held everything up. */
  addFilesFromDisk(id: number, paths: string[]): Draft {
    paths.forEach((path) => this.withFile(id, () => this.deps.files.fromDisk(id, path), this.deps.files.sizeOf(path)))
    return this.draftOrThrow(id)
  }

  addFileBytes(id: number, name: string, type: string, bytes: Buffer): Draft {
    return this.withFile(id, () => this.deps.files.fromBytes(id, name, type, bytes))
  }

  removeFile(id: number, file: string): Draft {
    const draft = this.draftOrThrow(id)
    const found = draft.files.find((f) => f.id === file)
    if (found) this.deps.files.remove(id, found)
    this.store.saveDraft({ ...draft, files: draft.files.filter((f) => f.id !== file) })
    return this.draftOrThrow(id)
  }

  /** A draft goes out only from an address that's yours, whatever the page sent. */
  private outgoingFrom(draft: Draft): ReturnType<typeof outgoing> {
    const from = (draft.from || draft.account).toLowerCase()
    if (!this.ownAddresses(draft.account).includes(from)) throw new Error('That address isn\'t on this account.')
    return outgoing(draft, from, this.identity(draft.account), (file) => this.deps.files.path(draft.id, file), this.deps.now())
  }

  /** Nothing leaves here: it waits in the queue so Undo has something to call back. */
  send(id: number, at?: number): number {
    const draft = this.draftOrThrow(id)
    if (draft.state === 'sending') throw new Error('This is already on its way.')
    this.outgoingFrom(draft) // says what's wrong with it now, not later
    const now = this.deps.now()
    if (at !== undefined && at <= now) throw new Error('Pick a time in the future.')
    const sendAt = at ?? now + this.settings().undoSeconds * 1000
    this.store.saveDraft({ ...draft, state: 'queued', sendAt, error: null, updated: now })
    // A message on its way isn't a draft: left in Drafts, another device could send it as well.
    this.letCopyGo(id)
    this.dirtySince.delete(id)
    this.deps.changed()
    return sendAt
  }

  /** Back to being a draft, it goes up again as one. */
  unsend(id: number): void {
    const draft = this.draftOrThrow(id)
    if (draft.state !== 'queued') throw new Error('Too late: this one has gone.')
    const now = this.deps.now()
    this.store.saveDraft({ ...draft, state: 'draft', sendAt: null, updated: now })
    this.touched(id, now)
    this.deps.changed()
  }

  /** The app is closing for good. Mail that's only waiting out Undo goes now, and so do changes, or
   *  both would sit here until the next launch. Mail set for later is left to wait for its time. */
  async finishUp(): Promise<void> {
    const now = this.deps.now()
    for (const draft of this.store.dueDrafts(now + this.settings().undoSeconds * 1000)) {
      this.store.saveDraft({ ...draft, sendAt: now })
    }
    this.store.hurryActions(now)
    await Promise.all(this.emails().map((email) => this.flush(email)))
    await this.sendDue()
    await Promise.all(this.emails().map((email) => this.pushDrafts(email, true)))
  }

  /** Remakes the previews of mail stored by an older version, in small steps. The tag means it
   *  happens once, and the steps mean a large mailbox doesn't hold everything else up. */
  async refreshSnippets(tag: string): Promise<void> {
    if (this.store.meta('snippets') === tag) return
    let after = 0
    for (;;) {
      const rows = this.store.staleSnippets(after, SNIPPET_STEP)
      if (rows.length === 0) break
      for (const row of rows) this.store.setSnippet(row.id, makeSnippet(row.html ? '' : row.text, row.html))
      after = rows.at(-1)?.id ?? after
      await new Promise((resolve) => setImmediate(resolve))
    }
    this.store.setMeta('snippets', tag)
    this.deps.changed()
  }

  private async sendDue(): Promise<void> {
    if (this.sending) return
    this.sending = true
    const sent = new Set<string>()
    try {
      // Only which ones: sending those before it can take a while, so each is read again at its turn.
      for (const { id } of this.store.dueDrafts(this.deps.now())) {
        const from = await this.sendOne(id)
        if (from) sent.add(from)
      }
    } finally {
      this.sending = false
    }
    await Promise.all([...sent].map((email) => this.syncOne(email))) // brings it into Sent
  }

  /** The account it went from, if it went. Until it's marked as sending, the person can call it
   *  back, change it or throw it away, so it's read again after every wait, and sent as it is then. */
  private async sendOne(id: number): Promise<string | null> {
    const due = (): Draft | null => {
      const draft = this.store.draft(id)
      return draft?.state === 'queued' && draft.sendAt !== null && draft.sendAt <= this.deps.now() ? draft : null
    }
    const account = due()?.account
    if (!account) return null
    let login: Login
    try {
      login = await this.login(account)
    } catch (e) {
      const draft = due()
      if (!draft) return null
      // Nothing has left. A lost connection or a keyring not open yet can wait; a sign-in that's gone
      // needs the person.
      const gone = (e as Error).message === SECRET_GONE || e instanceof SignInExpired
      const waiting = (e as Error).message === KEYRING_SHUT ? 'Waiting for the system keyring.' : 'Waiting for a connection.'
      this.store.saveDraft(gone
        ? { ...draft, state: 'failed', sendAt: null, error: describeFailure(e) }
        : { ...draft, state: 'queued', sendAt: this.deps.now() + RETRY_MS, error: waiting })
      this.deps.changed()
      return null
    }
    // Written down first: if the app dies here, this comes back as "check Sent", not sent twice. Moved
    // to another account meanwhile, it waits for the next turn and a sign-in of its own.
    const draft = this.store.claimDraft(id, account, this.deps.now())
    if (!draft) return null
    this.deps.changed()
    const config = this.config(draft.account)
    const sender = this.deps.openSender(config, login)
    try {
      const copy = await sender.send(this.outgoingFrom(draft))
      this.store.deleteDraft(draft.id)
      this.deps.files.clear(draft.id)
      if (!config.savesSent) await this.fileCopy(draft.account, copy.raw, copy.messageId)
      return draft.account
    } catch (e) {
      if (e instanceof NeverLeft) {
        this.store.saveDraft({ ...draft, state: 'queued', sendAt: this.deps.now() + RETRY_MS, error: 'Waiting for a connection.' })
      } else if (e instanceof Unmade) {
        // Nothing was handed over, so it's said plainly, not as "check Sent".
        this.store.saveDraft({ ...draft, state: 'failed', sendAt: null, error: "One of its attachments can't be read on this laptop any more, so nothing was sent. Remove it and send again." })
      } else {
        this.store.saveDraft({ ...draft, state: 'failed', sendAt: null, error: describeSendFailure(e) })
      }
      return null
    } finally {
      sender.close()
      this.deps.changed()
    }
  }

  /** The message has gone by now, so a failure here can only cost the copy, never send it again. */
  private async fileCopy(email: string, raw: Buffer, messageId: string): Promise<void> {
    await this.inLane(email, async () => {
      let writer: MailWriter | null = null
      try {
        writer = this.deps.openWriter(this.config(email), await this.login(email))
        await writer.connect()
        await writer.fileSent(raw, messageId)
      } catch {
        this.note(email, 'Sent, but no copy could be kept in Sent.')
      } finally {
        await writer?.close().catch(() => undefined)
      }
    })
  }

  threadUrl(email: string, thread: string): string {
    return gmailThreadUrl(email, thread)
  }

  settings(): Settings {
    try {
      const saved = JSON.parse(this.store.meta('settings') ?? '{}') as Partial<Settings>
      // "Compact" rows, from before the list counted lines, were rows with one line of the message.
      const lines = saved.previewLines ?? ((saved as { density?: string }).density === 'compact' ? 1 : DEFAULT_SETTINGS.previewLines)
      const batch = { ...DEFAULT_SETTINGS.batch, ...saved.batch }
      // Saved before there was a switch: no times meant mail came as it arrived, and still does.
      batch.live = saved.batch?.live === true || batch.times.length === 0
      const merged = { ...DEFAULT_SETTINGS, ...saved, batch, previewLines: lines, summary: cleanSummary({ ...DEFAULT_SETTINGS.summary, ...saved.summary }) }
      const filledIn = ([email, who]: [string, Partial<Identity>]): [string, Identity] =>
        [email, { name: '', signature: '', aliases: [], color: '', notify: true, ...who }]
      // A choice of sidebar entries saved before one of them existed gets it now, in its usual place.
      return {
        ...merged, sidebar: cleanSidebar(merged.sidebar), keys: isKeySet(merged.keys) ? merged.keys : 'edison', keyChanges: cleanAllChanges(merged.keyChanges),
        identities: Object.fromEntries(Object.entries(merged.identities).map(filledIn))
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  private saveSettings(settings: Settings): void {
    this.store.setMeta('settings', JSON.stringify(settings))
  }

  /** Waiting mail moves to the next slot of the new timetable. Measuring from now, not from when it
   *  arrived, means changing the times can't deliver anything early by accident. Only what [patch]
   *  names changes: a page that's behind can't put back what it hasn't heard of yet. */
  saveBatch(patch: Partial<BatchSettings>): void {
    const settings = this.settings()
    const clean = cleanBatch({ ...settings.batch, ...patch })
    // Coming straight through and waiting for the Summary pull opposite ways, so a sender newly let
    // through leaves the Summary.
    const added = clean.vip.filter((v) => !settings.batch.vip.includes(v))
    const summary = { ...settings.summary, senders: settings.summary.senders.filter((s) => !added.includes(s)) }
    const next = { ...settings, batch: clean, summary }
    this.saveSettings(next)
    // Going live releases what was waiting; going back to batches holds only what comes next.
    this.retime(this.rules(next))
    background(this.reportHeld())
  }

  /** A sender added to the Summary waits for it from now on, and what it's sent that's waiting for a
   *  batch moves to the Summary. One taken out goes back to the batches. Moving the time moves what's
   *  waiting with it. Only what [patch] names changes, as with the batches. */
  saveSummary(patch: Partial<SummarySettings>): void {
    const settings = this.settings()
    const clean = cleanSummary({ ...settings.summary, ...patch })
    const added = clean.senders.filter((s) => !settings.summary.senders.includes(s))
    const batch = { ...settings.batch, vip: settings.batch.vip.filter((v) => !added.includes(v)) }
    const next = { ...settings, batch, summary: clean }
    this.saveSettings(next)
    this.retime(this.rules(next))
  }

  /** Waiting mail moves to its next moment under [rules], measured from now, not from when it
   *  arrived, so a change can't deliver anything early by accident. */
  private retime(rules: BatchRules): void {
    const now = this.deps.now()
    this.store.retime((mail) => holdOf({ ...mail, arrived: now }, mail.account, this.store.holdFrom(mail.account) ?? 0, rules), now)
    this.deps.changed()
  }

  /** Each account's identity in [patch] replaces that account's alone, and only for an account that's
   *  here: a page still showing one that was removed can't bring it back. */
  saveProfile(patch: ProfilePatch): void {
    const settings = this.settings()
    const accounts = this.emails()
    const identities = patch.identities
      ? Object.fromEntries(Object.entries({ ...settings.identities, ...patch.identities }).filter(([email]) => accounts.includes(email)))
      : settings.identities
    this.saveSettings({
      ...settings,
      identities,
      templates: (patch.templates ?? settings.templates).slice(0, 50),
      blocked: patch.blocked ? cleanSenders(patch.blocked) : settings.blocked,
      muted: patch.muted ? cleanSenders(patch.muted) : settings.muted,
      notifyFocusedOnly: patch.notifyFocusedOnly ?? settings.notifyFocusedOnly,
      undoSeconds: patch.undoSeconds === undefined ? settings.undoSeconds : clamp(patch.undoSeconds, 0, 30),
      undoActionSeconds: patch.undoActionSeconds === undefined ? settings.undoActionSeconds : clamp(patch.undoActionSeconds, 1, 30),
      defaultReply: patch.defaultReply ?? settings.defaultReply,
      quoteReplies: patch.quoteReplies ?? settings.quoteReplies,
      theme: patch.theme ?? settings.theme,
      darkMail: patch.darkMail ?? settings.darkMail,
      focused: patch.focused ?? settings.focused,
      layout: patch.layout ?? settings.layout,
      afterRemove: patch.afterRemove ?? settings.afterRemove,
      previewLines: patch.previewLines === undefined ? settings.previewLines : clamp(Math.round(patch.previewLines) || 0, 0, 4),
      attachmentCards: patch.attachmentCards ?? settings.attachmentCards,
      sidebar: patch.sidebar ? cleanSidebar(patch.sidebar) : settings.sidebar,
      sidebarIcons: patch.sidebarIcons ?? settings.sidebarIcons,
      clock24: patch.clock24 ?? settings.clock24,
      keys: isKeySet(patch.keys) ? patch.keys : settings.keys,
      keyChanges: patch.keyChanges ? cleanAllChanges(patch.keyChanges) : settings.keyChanges,
      quickOn: patch.quickOn ?? settings.quickOn,
      quickActions: Array.isArray(patch.quickActions) ? cleanQuick(patch.quickActions) : settings.quickActions,
      swipes: patch.swipes ?? settings.swipes,
      swipeLeft: swipe(patch.swipeLeft, settings.swipeLeft),
      swipeLeftLong: swipe(patch.swipeLeftLong, settings.swipeLeftLong),
      swipeRight: swipe(patch.swipeRight, settings.swipeRight),
      swipeRightLong: swipe(patch.swipeRightLong, settings.swipeRightLong),
      background: patch.background ?? settings.background,
      startAtLogin: patch.startAtLogin ?? settings.startAtLogin,
      images: patch.images ?? settings.images,
      imagesFrom: patch.imagesFrom ? cleanSenders(patch.imagesFrom) : settings.imagesFrom,
      readAfter: patch.readAfter === undefined ? settings.readAfter : patch.readAfter < 0 ? -1 : clamp(Math.round(patch.readAfter), 0, 60),
      // Only the times named change, so two set one after the other both stay.
      later: patch.later ? cleanLater({ ...settings.later, ...patch.later }) : settings.later
    })
    this.deps.changed()
  }

  /** New mail from them goes to Trash from now on. */
  block(address: string): void {
    this.editSenders('blocked', [address], true)
  }

  /** Senders into one of the lists of them, or out of it, with the rest of that list as it is now.
   *  Built here, where nothing else changes the settings meanwhile: the page building the whole list
   *  from what it last read lost one of two senders added in quick succession. */
  editSenders(list: SenderList, addresses: string[], on: boolean): void {
    if (!addresses.some((a) => a.trim())) return
    const settings = this.settings()
    const edited = (from: string[]): string[] => editedSenders(from, addresses, on)
    if (list === 'vip') return this.saveBatch({ vip: edited(settings.batch.vip) })
    if (list === 'summary') return this.saveSummary({ senders: edited(settings.summary.senders) })
    this.saveSettings({ ...settings, [list]: cleanSenders(edited(settings[list])) })
    this.deps.changed()
  }

  saveBackfill(days: number): void {
    this.saveSettings({ ...this.settings(), backfillDays: clamp(days, 7, 3650) })
    background(this.syncAll())
  }

  private earlyUsed(): number {
    try {
      const saved = JSON.parse(this.store.meta('early') ?? '{}') as { day?: string; used?: number }
      return saved.day === dayKey(this.deps.now()) ? (saved.used ?? 0) : 0
    } catch {
      return 0
    }
  }

  private earlyLeft(): number {
    return Math.max(0, this.settings().batch.earlyPerDay - this.earlyUsed())
  }

  /** Early delivery has a door: ask, wait, and only then does it open. */
  beginEarly(): number {
    if (this.earlyLeft() === 0) throw new Error('None left today.')
    this.earlyStarted = this.deps.now()
    return this.deps.earlyWaitSeconds ?? EARLY_WAIT_S
  }

  async finishEarly(): Promise<number> {
    const wait = (this.deps.earlyWaitSeconds ?? EARLY_WAIT_S) * 1000
    const now = this.deps.now()
    if (this.earlyStarted === null || now - this.earlyStarted < wait) throw new Error('Not yet.')
    if (this.earlyLeft() === 0) throw new Error('None left today.')
    this.earlyStarted = null
    const released = this.store.releaseAll(now)
    if (released > 0) {
      this.store.setMeta('early', JSON.stringify({ day: dayKey(now), used: this.earlyUsed() + 1 }))
    }
    this.lastTick = now
    this.deps.changed()
    await this.report('early', released)
    return released
  }

  async connectHub(rawUrl: string, user: string, secret: string): Promise<void> {
    const url = rawUrl.trim().replace(/\/+$/, '')
    if (!isSafeHubUrl(url)) throw new Error('Use an https address.')
    if (!user.trim() || !secret) throw new Error('Fill in the name and password.')
    const ok = await this.postToHub(url, user.trim(), secret, 'state.connected', 0)
    if (!ok) throw new Error("xrnhub didn't accept that.")
    this.deps.secrets.set(HUB_SECRET, secret)
    this.saveSettings({ ...this.settings(), hub: { url, user: user.trim(), connected: true } })
    this.deps.changed()
  }

  disconnectHub(): void {
    this.deps.secrets.remove(HUB_SECRET)
    this.saveSettings({ ...this.settings(), hub: { url: '', user: '', connected: false } })
    this.deps.changed()
  }

  /** The hub's card shows how many are waiting, so it hears when that number changes. `state.`
   *  marks it as a standing report and not something that happened. */
  private async reportHeld(): Promise<void> {
    const held = this.store.heldCount(this.deps.now())
    if (held === this.lastHeld) return
    this.lastHeld = held
    await this.report('state.held', held)
  }

  private async report(kind: string, value: number): Promise<void> {
    const { hub } = this.settings()
    const secret = hub.connected ? this.deps.secrets.get(HUB_SECRET) : null
    if (!secret) return
    this.lastHeld = this.store.heldCount(this.deps.now())
    await this.postToHub(hub.url, hub.user, secret, kind, value)
  }

  /** Counts and times only. Who wrote and what about stay on this laptop. */
  private async postToHub(url: string, user: string, secret: string, kind: string, value: number): Promise<boolean> {
    const now = this.deps.now()
    const event = {
      app: 'xrnmail', kind, at: now, value,
      detail: { held: this.store.heldCount(now), nextBatch: this.nextBatch(now) }
    }
    try {
      const response = await this.post(`${url}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
        },
        body: JSON.stringify({ events: [event] }),
        redirect: 'error', // a redirect would carry the password somewhere else
        signal: AbortSignal.timeout(10_000)
      })
      return response.ok
    } catch {
      return false
    }
  }
}
