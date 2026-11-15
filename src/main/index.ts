import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, nativeTheme, powerMonitor, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AccountConfig, AppCommand, AssistantSection, BatchSettings, DraftEdit, DraftStart, Identity, ListQuery, MailAction, NewAccount, ProfilePatch, QuickAction, Quote,
  Rsvp, SenderList, Server, SummarySettings, SwipeAction, Template, ThreadRef
} from '@shared/types'
import { cleanSidebar } from '@shared/sidebar'
import { DEFAULT_LATER, type LaterTimes } from '@shared/later'
import { cleanAllChanges, isKeySet } from '@shared/keys'
import { soloKey, soloQuery, type Solo } from '@shared/solo'
import { QUICK_SLOTS, SENDER_LISTS } from '@shared/types'
import { parseMailto } from './compose'
import { addContextMenu, appMenu, AppTray, notify, notifySummary, setStartAtLogin, setUpSpelling, startedHidden } from './desktop'
import { DraftFiles } from './draft-files'
import { passwordStoreSwitch } from './password-store'
import { Avatars, sniff, webSources, type Picture, type PictureSources } from './avatars'
import { allowImages, devServerUrl, handle, handleFrom, lockDownContents, lockDownNetwork } from './guard'
import { canOpenDirectly, isSafeExternalUrl, safeFileName } from './safe-url'
import { KeyringSecrets, MemorySecrets, type Secrets } from './secrets'
import { SmtpSender } from './sender'
import { background, MailService, type DomainRecords, type Login } from './service'
import { ImapSource, ImapWatcher, type ImapConfig } from './source'
import { Store } from './store'
import { ImapWriter } from './writer'

const SYNC_MS = 3 * 60_000 // what's missed while the inbox is being watched, and the rest of the account
const TICK_MS = 3_000 // also how late a message can leave after its Undo ends
/** Coming back to the window checks for mail, unless that happened just now. */
const FOCUS_SYNC_MS = 60_000
/** Closing shouldn't hang on a server that has stopped answering. */
const FINISH_WAIT_MS = 8_000
const WINDOW_KEY = 'window'

// The UI tests run the unpackaged build on a throwaway profile with a fake Gmail. An installed
// build ignores all of these, so nothing in the environment can redirect its mail or passwords.
const test = app.isPackaged ? {} : process.env
if (test['XRNMAIL_DATA']) app.setPath('userData', test['XRNMAIL_DATA'])

// A debugging port would let any program running as this user read the window.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk']
if (app.isPackaged && DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) app.exit(1)

// Save passwords to the system keyring on desktops Electron doesn't recognise (Hyprland and
// other Wayland compositors), where it would otherwise fall back to basic_text and refuse.
const passwordStore = passwordStoreSwitch(process.platform, process.env.XDG_CURRENT_DESKTOP, (s) => app.commandLine.hasSwitch(s))
if (passwordStore) app.commandLine.appendSwitch('password-store', passwordStore)

if (!app.requestSingleInstanceLock()) app.quit()

let window: BrowserWindow | null = null
let mail: MailService | null = null
let tray: AppTray | null = null
let changeTimer: NodeJS.Timeout | null = null
/** Set once the app is really going, as opposed to the window closing to the tray. */
let quitting = false
/** Set once the store is closed on the way out: nothing refreshes after that. */
let closed = false

/** Many changes in a burst make one refresh. */
function tellPage(): void {
  if (changeTimer || closed) return
  changeTimer = setTimeout(() => {
    changeTimer = null
    for (const shown of [window, ...solos.values()]) if (shown && !shown.isDestroyed()) shown.webContents.send('changed')
    const unread = (mail?.accounts() ?? []).reduce((sum, account) => sum + account.unread, 0)
    tray?.show(unread)
    app.setBadgeCount(unread)
  }, 150)
}

const tellCommand = (command: AppCommand): void => window?.webContents.send('command', command)

/** Where a connection goes. The tests point every account at their fakes, in the clear. */
function connection(server: Server, fake: string | undefined, account: AccountConfig, login: Login): ImapConfig {
  const [host = '', port = ''] = (fake ?? '').split(':')
  const target = fake ? { host, port: Number(port), security: 'none' as const } : server
  return { ...target, user: account.user, secret: login.secret, accessToken: login.accessToken }
}

const imapConfig = (account: AccountConfig, login: Login): ImapConfig => connection(account.imap, test['XRNMAIL_IMAP'], account, login)
const smtpConfig = (account: AccountConfig, login: Login): ImapConfig => connection(account.smtp, test['XRNMAIL_SMTP'], account, login)

const domainRecords: DomainRecords = {
  mx: async (domain) => (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((r) => r.exchange),
  srv: async (name) => {
    try {
      const best = (await dns.resolveSrv(name)).sort((a, b) => a.priority - b.priority)[0]
      return best && best.name !== '.' ? { name: best.name, port: best.port } : null
    } catch {
      return null
    }
  }
}

/** A domain's TXT records, each joined from its parts. A name with none answers none. */
async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''))
  } catch (e) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes((e as { code?: string }).code ?? '')) return []
    throw e
  }
}

/** The UI tests' faces, from the files XRNMAIL_PICTURES names, so no test reaches the network. Each
 *  lookup is noted where a test can read it. */
function testSources(spec: string): PictureSources {
  const files = JSON.parse(spec) as Record<string, string>
  const asked: string[] = []
  Object.assign(globalThis, { pictureLookups: asked, faceAsks: [] })
  const read = async (key: string): Promise<Picture | null> => {
    asked.push(key)
    const file = files[key]
    if (!file) return null
    const bytes = readFileSync(file)
    const type = sniff(bytes, true)
    return type ? { type, bytes } : null
  }
  return { photo: (address) => read(`photo:${address}`), logo: (domain) => read(`logo:${domain}`) }
}

/** PNG and JPEG are drawn again here, by Chromium's own decoder: smaller, and with nothing in them
 *  but pixels. One it can't read is no picture. The other kinds are left for the page's <img>. */
function redraw(picture: Picture, side = 128, square = false): Picture | null {
  if (picture.type !== 'image/png' && picture.type !== 'image/jpeg') return picture
  let image = nativeImage.createFromBuffer(picture.bytes)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (square && width !== height) {
    const edge = Math.min(width, height)
    image = image.crop({ x: Math.floor((width - edge) / 2), y: Math.floor((height - edge) / 2), width: edge, height: edge })
  }
  const size = image.getSize()
  if (size.width > side || size.height > side) image = image.resize(size.width >= size.height ? { width: side, quality: 'best' } : { height: side, quality: 'best' })
  return { type: 'image/png', bytes: image.toPNG() }
}

/** A chosen photo can be large, but not this large. */
const MOST_CHOSEN = 10 * 1024 * 1024

const tellFaces = (): void => {
  for (const shown of [window, ...solos.values()]) if (shown && !shown.isDestroyed()) shown.webContents.send('faces')
}

function bringForward(shown: BrowserWindow | null): void {
  if (shown?.isMinimized()) shown.restore()
  shown?.show()
  shown?.focus()
}

const showWindow = (): void => bringForward(window)

/** A file dialog belongs to the window that asked, which is the one in front. */
const dialogParent = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? window

/** A draft for a mail address, opened in the composer for the person to read. */
async function composeTo(url: string): Promise<void> {
  if (!mail) return
  window?.webContents.send('compose', await mail.startDraft(parseMailto(url)))
  showWindow()
}

const MAILTO = /^mailto:/i
const mailtoIn = (argv: string[]): string | undefined => argv.find((arg) => MAILTO.test(arg))

const MAX_BODY = 8 * 1024 * 1024
const MAX_DROP = 26 * 1024 * 1024

const text = (value: unknown, max = 8192): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Bad request')
  return value
}

const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Bad request')
  return value
}

const SCOPED = ['starred', 'pinned', 'snoozed', 'sent', 'all', 'archive', 'trash', 'spam', 'unread', 'attachments', 'today', 'recent', 'summary'] as const
const SECTIONS: AssistantSection[] = ['packages', 'travel', 'money', 'events']

function listQuery(value: unknown): ListQuery {
  const q = (value ?? {}) as Record<string, unknown>
  const scoped = SCOPED.find((kind) => kind === q['kind'])
  if (scoped === 'unread' && q['keep']) {
    const keep = q['keep'] as Record<string, unknown>
    const query: ListQuery = { kind: 'unread', keep: { account: text(keep['account'], 320), thread: text(keep['thread'], 64) } }
    return q['account'] ? { ...query, account: text(q['account']) } : query
  }
  if (scoped) return q['account'] ? { kind: scoped, account: text(q['account']) } : { kind: scoped }
  if (q['kind'] === 'inbox') {
    const focus = q['focus'] === 'focused' || q['focus'] === 'other' ? q['focus'] : undefined
    return { kind: 'inbox', ...(q['account'] ? { account: text(q['account']) } : {}), ...(focus ? { focus } : {}) }
  }
  if (q['kind'] === 'assistant') {
    const section = SECTIONS.find((s) => s === q['section'])
    if (section) return { kind: 'assistant', section }
  }
  if (q['kind'] === 'label') return { kind: 'label', account: text(q['account']), label: text(q['label']) }
  if (q['kind'] === 'search') return { kind: 'search', text: text(q['text'], 500) }
  if (q['kind'] === 'from') return { kind: 'from', account: text(q['account'], 320), address: text(q['address'], 320) }
  throw new Error('Bad request')
}

const texts = (value: unknown, max: number, each: number): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error('Bad request')
  return value.map((item) => text(item, each))
}

/** Only what's there: a change names what it changes, and the rest stays as saved. */
function batchSettings(value: unknown): Partial<BatchSettings> {
  const b = (value ?? {}) as Record<string, unknown>
  const patch: Partial<BatchSettings> = {}
  if (b['live'] !== undefined) patch.live = b['live'] === true
  if (b['times'] !== undefined) patch.times = texts(b['times'], 50, 8)
  if (b['vip'] !== undefined) patch.vip = texts(b['vip'], 500, 320)
  if (b['earlyPerDay'] !== undefined) patch.earlyPerDay = number(b['earlyPerDay'])
  return patch
}

/** The main process decides what's allowed: `saveSummary` cleans the rest. */
function summarySettings(value: unknown): Partial<SummarySettings> {
  const s = (value ?? {}) as Record<string, unknown>
  const patch: Partial<SummarySettings> = {}
  if (s['senders'] !== undefined) patch.senders = texts(s['senders'], 500, 320)
  if (s['every'] !== undefined) patch.every = s['every'] === 'weekly' ? 'weekly' : 'daily'
  if (s['time'] !== undefined) patch.time = text(s['time'], 8)
  if (s['day'] !== undefined) patch.day = number(s['day'])
  if (s['chosen'] !== undefined) patch.chosen = s['chosen'] === true
  return patch
}

function senderList(value: unknown): SenderList {
  const found = SENDER_LISTS.find((name) => name === value)
  if (!found) throw new Error('Bad request')
  return found
}

const SIMPLE_ACTIONS = ['archive', 'inbox', 'trash', 'spam', 'read', 'unread', 'star', 'unstar', 'forever'] as const

function mailAction(value: unknown): MailAction {
  const a = (value ?? {}) as Record<string, unknown>
  const simple = SIMPLE_ACTIONS.find((kind) => kind === a['kind'])
  if (simple) return { kind: simple }
  if (a['kind'] === 'label') return { kind: 'label', label: text(a['label'], 500), add: a['add'] === true }
  if (a['kind'] === 'move') return { kind: 'move', to: text(a['to'], 1000) }
  throw new Error('Bad request')
}

function targets(value: unknown): ThreadRef[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Bad request')
  return value.map((item) => {
    const t = (item ?? {}) as Record<string, unknown>
    return { account: text(t['account'], 320), thread: text(t['thread'], 64) }
  })
}

function quote(value: unknown): Quote | null {
  if (value === null) return null
  const q = (value ?? {}) as Record<string, unknown>
  if (q['kind'] !== 'reply' && q['kind'] !== 'forward') throw new Error('Bad request')
  return {
    kind: q['kind'],
    intro: text(q['intro'], 4000),
    html: q['html'] === null ? null : text(q['html'], MAX_BODY),
    text: text(q['text'], MAX_BODY),
    ...(q['asIs'] === true ? { asIs: true } : {})
  }
}

function draftEdit(value: unknown): DraftEdit {
  const d = (value ?? {}) as Record<string, unknown>
  return {
    account: text(d['account'], 320),
    from: text(d['from'] ?? '', 320),
    to: text(d['to'], 8000),
    cc: text(d['cc'], 8000),
    bcc: text(d['bcc'], 8000),
    subject: text(d['subject'], 2000),
    html: text(d['html'], MAX_BODY),
    text: text(d['text'], MAX_BODY),
    quote: quote(d['quote'])
  }
}

function draftStart(value: unknown): DraftStart {
  const d = (value ?? {}) as Record<string, unknown>
  if (d['kind'] === 'reply' || d['kind'] === 'replyAll' || d['kind'] === 'forward') return { kind: d['kind'], message: number(d['message']) }
  if (d['kind'] !== 'new') throw new Error('Bad request')
  const optional = (key: string): string | undefined => (d[key] === undefined ? undefined : text(d[key]))
  return { kind: 'new', account: optional('account'), to: optional('to'), subject: optional('subject'), text: optional('text') }
}

function server(value: unknown): Server | undefined {
  if (value === undefined) return undefined
  const s = (value ?? {}) as Record<string, unknown>
  // The main process decides what's allowed: `addAccount` refuses anything without TLS.
  return { host: text(s['host'], 253), port: number(s['port']), security: text(s['security'], 16) as Server['security'] }
}

function newAccount(value: unknown): NewAccount {
  const a = (value ?? {}) as Record<string, unknown>
  return {
    email: text(a['email'], 320),
    secret: text(a['secret'], 500),
    provider: text(a['provider'], 32),
    user: a['user'] === undefined ? undefined : text(a['user'], 320),
    imap: server(a['imap']),
    smtp: server(a['smtp'])
  }
}

const COLOR = /^#[0-9a-f]{6}$/i

function identity(who: Partial<Identity> | undefined): Identity {
  const color = text(who?.color ?? '', 7)
  return {
    name: text(who?.name, 200),
    signature: text(who?.signature, 8192),
    aliases: (Array.isArray(who?.aliases) ? who.aliases : []).slice(0, 20).map((a) => text(a, 320)),
    color: COLOR.test(color) ? color : '',
    notify: who?.notify !== false
  }
}

function profile(value: unknown): ProfilePatch {
  const p = (value ?? {}) as Record<string, unknown>
  const patch: ProfilePatch = {}
  if (p['identities'] !== undefined) {
    patch.identities = Object.fromEntries(
      Object.entries(p['identities'] as Record<string, Identity>).map(([email, who]) => [
        text(email, 320), identity(who)
      ])
    )
  }
  if (Array.isArray(p['templates'])) {
    patch.templates = (p['templates'] as Template[]).map((t) => ({ name: text(t?.name, 200), text: text(t?.text, 20_000) }))
  }
  if (Array.isArray(p['blocked'])) patch.blocked = p['blocked'].map((b) => text(b, 320))
  if (Array.isArray(p['muted'])) patch.muted = p['muted'].map((b) => text(b, 320))
  if (p['sidebar'] && typeof p['sidebar'] === 'object') patch.sidebar = cleanSidebar(p['sidebar'])
  if (p['undoSeconds'] !== undefined) patch.undoSeconds = number(p['undoSeconds'])
  if (p['defaultReply'] === 'reply' || p['defaultReply'] === 'replyAll') patch.defaultReply = p['defaultReply']
  if (p['theme'] === 'system' || p['theme'] === 'light' || p['theme'] === 'dark') patch.theme = p['theme']
  if (p['focused'] !== undefined) patch.focused = p['focused'] === true
  if (p['layout'] === 'panes' || p['layout'] === 'below' || p['layout'] === 'list') patch.layout = p['layout']
  if (p['afterRemove'] === 'next' || p['afterRemove'] === 'previous' || p['afterRemove'] === 'list') patch.afterRemove = p['afterRemove']
  if (p['previewLines'] !== undefined) patch.previewLines = number(p['previewLines'])
  for (const key of ['attachmentCards', 'sidebarIcons', 'clock24', 'quickOn', 'swipes', 'notifyFocusedOnly', 'darkMail'] as const) {
    if (p[key] !== undefined) patch[key] = p[key] === true
  }
  if (isKeySet(p['keys'])) patch.keys = p['keys']
  if (p['keyChanges'] && typeof p['keyChanges'] === 'object') patch.keyChanges = cleanAllChanges(p['keyChanges'])
  if (Array.isArray(p['quickActions'])) patch.quickActions = p['quickActions'].slice(0, QUICK_SLOTS).map((a) => text(a, 16) as QuickAction)
  for (const key of ['swipeLeft', 'swipeLeftLong', 'swipeRight', 'swipeRightLong'] as const) {
    if (p[key] !== undefined) patch[key] = text(p[key], 16) as SwipeAction
  }
  if (p['background'] !== undefined) patch.background = p['background'] === true
  if (p['startAtLogin'] !== undefined) patch.startAtLogin = p['startAtLogin'] === true
  if (p['images'] === 'ask' || p['images'] === 'always') patch.images = p['images']
  if (p['readAfter'] !== undefined) patch.readAfter = number(p['readAfter'])
  if (p['later'] && typeof p['later'] === 'object') {
    const later = p['later'] as Record<string, unknown>
    patch.later = Object.fromEntries(Object.entries(later).filter(([key]) => key in DEFAULT_LATER).map(([key, value]) => [key, number(value)])) as Partial<LaterTimes>
  }
  if (Array.isArray(p['imagesFrom'])) patch.imagesFrom = p['imagesFrom'].map((a) => text(a, 320))
  return patch
}

const RSVPS: Rsvp[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED']

function rsvp(value: unknown): Rsvp {
  const answer = RSVPS.find((r) => r === value)
  if (!answer) throw new Error('Bad request')
  return answer
}

let openedFiles: string | null = null

/** A private folder for attachments being looked at, gone when the app quits. */
function openedFolder(): string {
  openedFiles ??= join(app.getPath('temp'), `xrnmail-${randomUUID()}`)
  mkdirSync(openedFiles, { recursive: true, mode: 0o700 })
  return openedFiles
}

function register(service: MailService, avatars: Avatars): void {
  handle('accounts', () => service.accounts())
  handle('addAccount', (account: unknown) => service.addAccount(newAccount(account)))
  handle('startMicrosoft', async (email: unknown, clientId: unknown) => {
    const started = await service.startMicrosoft(text(email, 320), text(clientId, 64))
    if (isSafeExternalUrl(started.url)) await shell.openExternal(started.url)
    return started
  })
  handle('finishMicrosoft', () => service.finishMicrosoft())
  handle('detectProvider', (email: unknown) => service.detectProvider(text(email, 320)))
  handle('removeAccount', (email: unknown) => {
    const account = text(email, 320)
    service.removeAccount(account)
    avatars.forget(account)
  })
  handle('syncNow', () => background(service.syncAll()))
  handle('overview', () => service.overview())
  handle('list', (query: unknown, limit: unknown) => service.list(listQuery(query), limit === undefined ? undefined : number(limit)))
  handle('thread', (account: unknown, thread: unknown, bins: unknown, remember: unknown, read: unknown) =>
    service.thread(text(account, 320), text(thread, 64), bins === true, remember !== false, read !== false))
  handle('clearRecent', () => service.clearRecent())
  handle('searches', () => service.searches())
  handle('rememberSearch', (search: unknown) => service.rememberSearch(text(search, 500)))
  handle('forgetSearch', (search: unknown) => service.forgetSearch(search === null ? null : text(search, 500)))
  handle('settings', () => service.settings())
  handle('saveBatch', (batch: unknown) => service.saveBatch(batchSettings(batch)))
  handle('saveBackfill', (days: unknown) => service.saveBackfill(number(days)))
  handle('saveSummary', (summary: unknown) => service.saveSummary(summarySettings(summary)))
  handle('summarySenders', () => service.summarySenders())
  handle('editSenders', (name: unknown, addresses: unknown, on: unknown) => service.editSenders(senderList(name), texts(addresses, 500, 320), on === true))
  handle('connectHub', (url: unknown, user: unknown, secret: unknown) =>
    service.connectHub(text(url, 500), text(user, 200), text(secret, 500)))
  handle('disconnectHub', () => service.disconnectHub())
  handle('beginEarly', () => service.beginEarly())
  handle('finishEarly', () => service.finishEarly())
  handle('allowRemoteImages', (allow: unknown) => allowImages(allow === true))
  handle('act', (refs: unknown, action: unknown) => service.act(targets(refs), mailAction(action)))
  handle('undo', (token: unknown) => service.undo(number(token)))
  handle('snooze', (refs: unknown, until: unknown) => service.snooze(targets(refs), number(until)))
  handle('unsnooze', (refs: unknown) => service.unsnooze(targets(refs)))
  handle('pin', (refs: unknown, on: unknown) => service.pin(targets(refs), on === true))
  handle('block', (address: unknown) => service.block(text(address, 320)))
  handle('unsubscribe', async (message: unknown) => {
    const { url, ...result } = await service.unsubscribe(number(message))
    if (url && isSafeExternalUrl(url)) await shell.openExternal(url)
    return result
  })
  handle('subscriptions', () => service.subscriptions())
  handle('unsubscribed', () => service.unsubscribed())
  handle('sender', (account: unknown, address: unknown) => service.sender(text(account, 320), text(address, 320)))
  handle('clearSender', (account: unknown, address: unknown) => service.clearSender(text(account, 320), text(address, 320)))
  handle('setFocus', (address: unknown, focused: unknown) => service.setFocus(text(address, 320), focused === true))
  handle('rsvp', (message: unknown, answer: unknown) => service.rsvp(number(message), rsvp(answer)))
  handle('contacts', (query: unknown) => service.contacts(text(query, 200)))
  handle('saveAttachment', async (message: unknown, index: unknown) => {
    const found = await service.attachment(number(message), number(index))
    const parent = dialogParent()
    const options = { defaultPath: join(app.getPath('downloads'), safeFileName(found.name)) }
    const choice = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
    if (choice.canceled || !choice.filePath) return false
    writeFileSync(choice.filePath, found.content, { mode: 0o600 })
    return true
  })
  handle('openAttachment', async (message: unknown, index: unknown) => {
    const found = await service.attachment(number(message), number(index))
    const name = safeFileName(found.name)
    if (!canOpenDirectly(name)) throw new Error('Save this kind of file first, then open it yourself.')
    const path = join(openedFolder(), `${randomUUID().slice(0, 8)}-${name}`)
    writeFileSync(path, found.content, { mode: 0o600 })
    const failure = await shell.openPath(path)
    if (failure) throw new Error('Nothing on this laptop opens that kind of file.')
  })
  handle('details', (message: unknown) => service.details(number(message)))
  // An address and nothing else: a page gone wrong mustn't be able to put a command on the clipboard
  // for someone to paste into a terminal.
  handle('copyAddress', (address: unknown) => {
    const value = text(address, 320)
    if (!/^[^\s@<>"'`;|&$\\]+@[^\s@<>"'`;|&$\\]+$/.test(value)) throw new Error("That isn't an address.")
    clipboard.writeText(value)
  })
  handle('faces', (addresses: unknown, lookUp: unknown) => {
    if (!Array.isArray(addresses) || addresses.length > 500) throw new Error('Bad request')
    const asked = addresses.map((a) => text(a, 320))
    // The UI tests check which asks could look something up.
    if (test['XRNMAIL_PICTURES']) (globalThis as unknown as { faceAsks?: [string[], boolean][] }).faceAsks?.push([asked, lookUp === true])
    return avatars.faces(asked, lookUp === true)
  })
  handle('choosePhoto', async (account: unknown) => {
    const email = text(account, 320)
    if (!service.accounts().some((a) => a.email === email)) throw new Error('That account is gone.')
    const options = { properties: ['openFile'] as 'openFile'[], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg'] }] }
    const parent = dialogParent()
    const choice = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    const path = choice.canceled ? undefined : choice.filePaths[0]
    if (!path) return false
    if (statSync(path).size > MOST_CHOSEN) throw new Error('Pick a picture under 10 MB.')
    const bytes = readFileSync(path)
    const type = sniff(bytes)
    const drawn = type === 'image/png' || type === 'image/jpeg' ? redraw({ type, bytes }, 256, true) : null
    if (!drawn) throw new Error("That picture couldn't be read. Pick a PNG or JPEG.")
    avatars.choose(email, drawn)
    tellFaces()
    return true
  })
  handle('removePhoto', (account: unknown) => {
    avatars.forget(text(account, 320))
    tellFaces()
  })
  handle('photos', () => service.accounts().map((a) => a.email).filter((email) => avatars.chosen(email)))
  handle('drafts', () => service.drafts())
  handle('openThreadWindow', (account: unknown, thread: unknown, bins: unknown) =>
    showSolo({ kind: 'thread', account: text(account, 320), thread: text(thread, 64), bins: bins === true }))
  handle('openDraftWindow', (id: unknown) => showSolo({ kind: 'draft', id: number(id) }))
  handle('showDraftWindow', (id: unknown) => {
    const shown = solos.get(soloKey({ kind: 'draft', id: number(id) }))
    if (!shown || shown.isDestroyed()) return false
    bringForward(shown)
    return true
  })
  handle('createFolder', (account: unknown, name: unknown) => service.createFolder(text(account, 320), text(name, 500)))
  handle('startDraft', (start: unknown) => service.startDraft(draftStart(start)))
  handle('saveDraft', (id: unknown, edit: unknown) => service.saveDraft(number(id), draftEdit(edit)))
  // A page that goes, crashed or closed, lets go of the drafts its composers had open.
  const held = new Map<number, number[]>()
  handleFrom('holdDraft', (sender: Electron.WebContents, id: unknown, on: unknown) => {
    const draft = number(id)
    if (!held.has(sender.id)) {
      held.set(sender.id, [])
      sender.once('destroyed', () => {
        for (const each of held.get(sender.id) ?? []) service.holdDraft(each, false)
        held.delete(sender.id)
      })
    }
    const mine = held.get(sender.id) ?? []
    if (on === true) mine.push(draft)
    else if (mine.includes(draft)) mine.splice(mine.indexOf(draft), 1)
    else return
    service.holdDraft(draft, on === true)
  })
  handle('discardDraft', (id: unknown) => service.discardDraft(number(id)))
  handle('pickFiles', async (id: unknown) => {
    const options = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
    const parent = dialogParent()
    const choice = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    return service.addFilesFromDisk(number(id), choice.canceled ? [] : choice.filePaths)
  })
  handle('addFile', (id: unknown, name: unknown, type: unknown, bytes: unknown) => {
    const data = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null
    if (!data) throw new Error('Bad request')
    if (data.length > MAX_DROP) throw new Error('Mail services take about 18 MB of attachments at most.')
    return service.addFileBytes(number(id), safeFileName(text(name, 500)), text(type, 200), data)
  })
  handle('removeFile', (id: unknown, file: unknown) => service.removeFile(number(id), text(file, 64)))
  handle('send', (id: unknown, at: unknown) => service.send(number(id), at === undefined ? undefined : number(at)))
  handle('unsend', (id: unknown) => service.unsend(number(id)))
  handle('saveProfile', (patch: unknown) => {
    const clean = profile(patch)
    service.saveProfile(clean)
    if (clean.startAtLogin !== undefined) setStartAtLogin(clean.startAtLogin)
  })
  handle('version', () => app.getVersion())
  handle('openInGmail', (email: unknown, thread: unknown) => shell.openExternal(service.threadUrl(text(email, 320), text(thread, 64))))
  handle('openLink', async (url: unknown) => {
    const target = text(url)
    if (MAILTO.test(target)) await composeTo(target)
    else if (isSafeExternalUrl(target)) await shell.openExternal(target)
  })
}

interface WindowPlace {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function savedPlace(store: Store): WindowPlace {
  const fallback = { width: 1280, height: 840 }
  try {
    const saved = JSON.parse(store.meta(WINDOW_KEY) ?? 'null') as WindowPlace | null
    if (!saved) return fallback
    // A screen that's gone would leave the window somewhere it can't be reached.
    const onScreen = saved.x === undefined || saved.y === undefined || screen.getAllDisplays().some(({ workArea }) =>
      saved.x! < workArea.x + workArea.width && saved.y! < workArea.y + workArea.height && saved.x! + 100 > workArea.x && saved.y! + 100 > workArea.y)
    return onScreen ? saved : { ...saved, x: undefined, y: undefined }
  } catch {
    return fallback
  }
}

/** Every window is the same page behind the same walls: sandboxed, apart from the bridge's own
 *  world, and with nothing of Node in it. A window of its own differs only in what it's asked to show. */
const pagePreferences = (): Electron.WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true
})

function loadPage(shown: BrowserWindow, query: Record<string, string> = {}): void {
  const dev = devServerUrl()
  if (!dev) return void shown.loadFile(join(__dirname, '../renderer/index.html'), { query })
  const url = new URL(dev)
  url.search = new URLSearchParams(query).toString()
  void shown.loadURL(url.href)
}

/** Windows that hold one thread or one draft, by which. */
const solos = new Map<string, BrowserWindow>()
/** More than anyone reads at once, and a bound on what a page gone wrong could open. */
const MOST_SOLOS = 12
/** How long a window of its own gets to keep what's typed before it's closed regardless. */
const LEAVING_MS = 2000
const SOLO_SIZE = { thread: { width: 900, height: 780 }, draft: { width: 720, height: 680 } }

/** A thread, or a draft in the composer, in a window of its own: the page the main window has,
 *  told in its address what to show. Asking again for the same one brings its window forward. */
function showSolo(solo: Solo): void {
  const key = soloKey(solo)
  const open = solos.get(key)
  if (open && !open.isDestroyed()) return bringForward(open)
  if (solos.size >= MOST_SOLOS) throw new Error('Close one of the open windows first.')
  const shown = new BrowserWindow({
    ...SOLO_SIZE[solo.kind],
    minWidth: 480,
    minHeight: 360,
    show: false,
    autoHideMenuBar: true,
    title: 'xrnmail',
    icon: join(__dirname, '../../resources/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1c' : '#ffffff',
    webPreferences: pagePreferences()
  })
  solos.set(key, shown)
  lockDownContents(shown.webContents)
  addContextMenu(shown.webContents)
  shown.on('ready-to-show', () => shown.show())
  // What's typed in a composer lives in its page until it's saved, so the page is told first. It
  // saves and closes the window again, and that second time goes through. One that never answers
  // still closes. Quitting doesn't wait, as it doesn't for the main window's composer.
  let told = false
  shown.on('close', (event) => {
    if (told || quitting) return
    told = true
    event.preventDefault()
    shown.webContents.send('leaving')
    setTimeout(() => { if (!shown.isDestroyed()) shown.destroy() }, LEAVING_MS)
  })
  shown.on('closed', () => { if (solos.get(key) === shown) solos.delete(key) })
  loadPage(shown, soloQuery(solo))
}

function createWindow(store: Store, hidden: boolean): void {
  const place = savedPlace(store)
  const shown = new BrowserWindow({
    width: place.width,
    height: place.height,
    x: place.x,
    y: place.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'xrnmail',
    icon: join(__dirname, '../../resources/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1c' : '#ffffff',
    webPreferences: pagePreferences()
  })
  window = shown
  if (place.maximized) shown.maximize()
  lockDownContents(shown.webContents)
  addContextMenu(shown.webContents)
  shown.on('ready-to-show', () => { if (!hidden) shown.show() })
  const remember = (): void => {
    if (shown.isDestroyed()) return
    const place: WindowPlace = { ...shown.getNormalBounds(), maximized: shown.isMaximized() }
    store.setMeta(WINDOW_KEY, JSON.stringify(place))
  }
  shown.on('close', (event) => {
    if (!quitting) remember()
    // Mail still has to arrive and go out. A desktop without a tray keeps the old way, or the window
    // would vanish with nothing left to bring it back.
    if (quitting || !tray || !mail?.settings().background) return
    event.preventDefault()
    shown.hide()
  })
  shown.on('closed', () => {
    window = null
    // Without the main window there'd be no way back to the rest, so the others go with it.
    for (const solo of solos.values()) if (!solo.isDestroyed()) solo.close()
  })
  let lastSync = Date.now()
  shown.on('focus', () => {
    if (Date.now() - lastSync < FOCUS_SYNC_MS) return
    lastSync = Date.now()
    if (mail) background(mail.syncAll())
  })
  loadPage(shown)
}

app.on('second-instance', (_event, argv) => {
  showWindow()
  const url = mailtoIn(argv)
  if (url) background(composeTo(url))
})
app.on('window-all-closed', () => { if (quitting || !tray) app.quit() })

void app.whenReady().then(() => {
  lockDownNetwork()
  const store = new Store(join(app.getPath('userData'), 'mail.sqlite'))
  const secrets: Secrets = test['XRNMAIL_TEST_SECRETS'] ? new MemorySecrets() : new KeyringSecrets(store)
  // The UI tests look nothing up unless they hand over pictures of their own.
  const sources = test['XRNMAIL_PICTURES'] ? testSources(test['XRNMAIL_PICTURES']) : test['XRNMAIL_DATA'] ? null : webSources(fetch, txt)
  const avatars = new Avatars({
    dir: join(app.getPath('userData'), 'faces'),
    sources,
    now: () => Date.now(),
    found: tellFaces,
    redraw: (picture) => redraw(picture),
    ownerOf: (address) => mail?.ownerOf(address) ?? null
  })
  const service = new MailService({
    store,
    secrets,
    openSource: (account, login) => new ImapSource(imapConfig(account, login)),
    openWriter: (account, login) => new ImapWriter(imapConfig(account, login)),
    openSender: (account, login) => new SmtpSender(smtpConfig(account, login)),
    openWatcher: (account, login) => new ImapWatcher(imapConfig(account, login)),
    records: test['XRNMAIL_IMAP'] ? undefined : domainRecords,
    files: new DraftFiles(join(app.getPath('userData'), 'drafts')),
    // Read through Date each time, so the UI tests can move the main process's clock on.
    now: () => Date.now(),
    changed: tellPage,
    noticed: (addresses) => avatars.want(addresses),
    // A notice for one message opens it; one for several brings the window up.
    landed: test['XRNMAIL_DATA'] ? undefined : (count, preview) => notify(count, preview, () => {
      showWindow()
      if (preview) window?.webContents.send('open-thread', { account: preview.account, thread: preview.thread })
    }),
    summarized: test['XRNMAIL_DATA'] ? undefined : (count, senders) => notifySummary(count, senders, () => {
      showWindow()
      tellCommand('summary')
    }),
    earlyWaitSeconds: test['XRNMAIL_EARLY_WAIT'] ? Number(test['XRNMAIL_EARLY_WAIT']) : undefined
  })
  mail = service
  register(service, avatars)
  Menu.setApplicationMenu(appMenu({ command: tellCommand, sync: () => background(service.syncAll()) }))
  setUpSpelling()
  // Tests run many at once, and a tray icon per run would only get in the way.
  if (!test['XRNMAIL_DATA']) {
    try {
      tray = new AppTray({
        show: showWindow,
        command: tellCommand,
        sync: () => background(service.syncAll()),
        quit: () => app.quit()
      })
    } catch {
      tray = null // no tray on this desktop: closing the window quits, as it would have anyway
    }
  }
  createWindow(store, tray !== null && startedHidden(process.argv))
  const opening = mailtoIn(process.argv)
  if (opening) window?.webContents.once('did-finish-load', () => background(composeTo(opening)))
  background(service.syncAll())
  background(service.refreshSnippets(app.getVersion()))
  service.watchAll()
  const syncing = setInterval(() => background(service.syncAll()), SYNC_MS)
  const ticking = setInterval(() => background(service.tick()), TICK_MS)
  powerMonitor.on('resume', () => {
    service.stopWatching()
    service.watchAll()
    background(service.syncAll())
  })
  let finished = false
  app.on('before-quit', (event) => {
    quitting = true
    if (finished) {
      clearInterval(syncing)
      clearInterval(ticking)
      // A refresh still to come would read the closed store and set the destroyed tray's image.
      closed = true
      if (changeTimer) clearTimeout(changeTimer)
      tray?.destroy()
      tray = null
      store.close()
      if (openedFiles) rmSync(openedFiles, { recursive: true, force: true })
      return
    }
    // Mail waiting out Undo would otherwise sit here until the next launch.
    event.preventDefault()
    service.stopWatching()
    const giveUp = new Promise((resolve) => setTimeout(resolve, FINISH_WAIT_MS))
    void Promise.race([service.finishUp().catch(() => undefined), giveUp]).finally(() => {
      finished = true
      app.quit()
    })
  })
})
