import { app, BrowserWindow, nativeTheme, Notification, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import type { BatchSettings, ListQuery } from '@shared/types'
import { allowImages, devServerUrl, handle, lockDownContents, lockDownNetwork } from './guard'
import { isSafeExternalUrl } from './safe-url'
import { KeyringSecrets, MemorySecrets, type Secrets } from './secrets'
import { MailService } from './service'
import { gmailConfig, ImapSource, type ImapConfig } from './source'
import { Store } from './store'

const SYNC_MS = 3 * 60_000 // batching means nothing is in a hurry; this is how long a VIP can wait
const TICK_MS = 15_000

// The UI tests run the unpackaged build on a throwaway profile with a fake Gmail. An installed
// build ignores all of these, so nothing in the environment can redirect its mail or passwords.
const test = app.isPackaged ? {} : process.env
if (test['XRNMAIL_DATA']) app.setPath('userData', test['XRNMAIL_DATA'])

// A debugging port would let any program running as this user read the window.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk']
if (app.isPackaged && DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) app.exit(1)

if (!app.requestSingleInstanceLock()) app.quit()

let window: BrowserWindow | null = null
let changeTimer: NodeJS.Timeout | null = null

/** Many changes in a burst make one refresh. */
function tellPage(): void {
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    changeTimer = null
    window?.webContents.send('changed')
  }, 150)
}

function imapConfig(email: string, secret: string): ImapConfig {
  const fake = test['XRNMAIL_IMAP']
  if (!fake) return gmailConfig(email, secret)
  const [host = '', port = ''] = fake.split(':')
  return { host, port: Number(port), secure: false, user: email, secret }
}

function showWindow(): void {
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
}

function notifyLanded(count: number): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: 'xrnmail', body: count === 1 ? '1 new message' : `${count} new messages` })
  note.on('click', showWindow)
  note.show()
}

const text = (value: unknown, max = 8192): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Bad request')
  return value
}

const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Bad request')
  return value
}

function listQuery(value: unknown): ListQuery {
  const q = (value ?? {}) as Record<string, unknown>
  if (q['kind'] === 'inbox') return q['account'] ? { kind: 'inbox', account: text(q['account']) } : { kind: 'inbox' }
  if (q['kind'] === 'label') return { kind: 'label', account: text(q['account']), label: text(q['label']) }
  if (q['kind'] === 'search') return { kind: 'search', text: text(q['text'], 500) }
  throw new Error('Bad request')
}

function batchSettings(value: unknown): BatchSettings {
  const b = (value ?? {}) as Record<string, unknown>
  if (!Array.isArray(b['times']) || !Array.isArray(b['vip'])) throw new Error('Bad request')
  return {
    times: b['times'].map((t) => text(t, 8)),
    vip: b['vip'].map((v) => text(v, 320)),
    earlyPerDay: number(b['earlyPerDay'])
  }
}

function register(service: MailService): void {
  handle('accounts', () => service.accounts())
  handle('addAccount', (email: unknown, secret: unknown) => service.addAccount(text(email, 320), text(secret, 200)))
  handle('removeAccount', (email: unknown) => service.removeAccount(text(email, 320)))
  handle('syncNow', () => void service.syncAll())
  handle('overview', () => service.overview())
  handle('list', (query: unknown) => service.list(listQuery(query)))
  handle('thread', (account: unknown, thread: unknown) => service.thread(text(account, 320), text(thread, 64)))
  handle('settings', () => service.settings())
  handle('saveBatch', (batch: unknown) => service.saveBatch(batchSettings(batch)))
  handle('saveBackfill', (days: unknown) => service.saveBackfill(number(days)))
  handle('connectHub', (url: unknown, user: unknown, secret: unknown) =>
    service.connectHub(text(url, 500), text(user, 200), text(secret, 500)))
  handle('disconnectHub', () => service.disconnectHub())
  handle('beginEarly', () => service.beginEarly())
  handle('finishEarly', () => service.finishEarly())
  handle('allowRemoteImages', (allow: unknown) => allowImages(allow === true))
  handle('openInGmail', (email: unknown, thread: unknown) => shell.openExternal(service.threadUrl(text(email, 320), text(thread, 64))))
  handle('openLink', async (url: unknown) => {
    const target = text(url)
    if (isSafeExternalUrl(target)) await shell.openExternal(target)
  })
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'xrnmail',
    icon: join(__dirname, '../../resources/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f23' : '#f2f2f4',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  lockDownContents(window.webContents)
  window.on('ready-to-show', () => window?.show())
  window.on('closed', () => (window = null))
  const dev = devServerUrl()
  if (dev) void window.loadURL(dev)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('second-instance', showWindow)
app.on('window-all-closed', () => app.quit())

void app.whenReady().then(() => {
  lockDownNetwork()
  const store = new Store(join(app.getPath('userData'), 'mail.sqlite'))
  const secrets: Secrets = test['XRNMAIL_TEST_SECRETS'] ? new MemorySecrets() : new KeyringSecrets(store)
  const service = new MailService({
    store,
    secrets,
    openSource: (email, secret) => new ImapSource(imapConfig(email, secret)),
    now: Date.now,
    changed: tellPage,
    landed: test['XRNMAIL_DATA'] ? undefined : notifyLanded,
    earlyWaitSeconds: test['XRNMAIL_EARLY_WAIT'] ? Number(test['XRNMAIL_EARLY_WAIT']) : undefined
  })
  register(service)
  createWindow()
  void service.syncAll()
  setInterval(() => void service.syncAll(), SYNC_MS)
  setInterval(() => void service.tick(), TICK_MS)
  powerMonitor.on('resume', () => void service.syncAll())
  app.on('before-quit', () => store.close())
})
