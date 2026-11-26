import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeGmail } from '../tests/fake-gmail'
import { FakeSmtp } from '../tests/fake-smtp'
import { pictures as writePictures } from './pictures'

export const ME = 'me@example.com'

export interface Running {
  app: ElectronApplication
  page: Page
  gmail: FakeGmail
  smtp: FakeSmtp
  opened: () => Promise<string[]>
  openedFiles: () => Promise<string[]>
  /** Where a "Save" lands. */
  savedTo: string
  /** The profile, for starting the app on it again. */
  data: string
  stop(): Promise<void>
}

/** E2E_HEADLESS=1 keeps the windows off the desktop. A tiling window manager also makes them too
 *  narrow for three panes, which some tests need. */
const HEADLESS = process.env['E2E_HEADLESS'] ? ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080'] : []

/** The app on a throwaway profile, signed in to nothing, with links recorded and not opened. With
 *  [pictures] (`photo:<address>` or `logo:<domain>`), those are the faces it finds; without, it
 *  finds none. Either way nothing is looked up on the network. */
export async function launch(options: {
  colorScheme?: 'light' | 'dark'; gmail?: FakeGmail; size?: [number, number]; pictures?: Record<string, Buffer | string>
  /** A profile an earlier run left, instead of a new one. */
  data?: string
  /** More of the command line, after the app's own: a file to open, say. */
  args?: string[]
  /** False: pictures from this machine are refused, as an installed build refuses them. */
  localPictures?: boolean
} = {}): Promise<Running> {
  const gmail = options.gmail ?? new FakeGmail()
  const port = await gmail.listen()
  const smtp = new FakeSmtp(gmail.secret)
  const smtpPort = await smtp.listen()
  const data = options.data ?? mkdtempSync(join(tmpdir(), 'xrnmail-e2e-'))
  const faces: Record<string, string> = options.pictures ? { XRNMAIL_PICTURES: writePictures(mkdtempSync(join(data, 'faces-')), options.pictures) } : {}
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', ...HEADLESS, ...(options.args ?? [])],
    colorScheme: options.colorScheme ?? 'light',
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      XRNMAIL_DATA: data,
      XRNMAIL_IMAP: `127.0.0.1:${port}`,
      XRNMAIL_SMTP: `127.0.0.1:${smtpPort}`,
      XRNMAIL_TEST_SECRETS: '1',
      XRNMAIL_EARLY_WAIT: '1',
      // The tests' pictures are served from this machine, which a real message's never are.
      ...(options.localPictures === false ? {} : { XRNMAIL_LOCAL_PICTURES: '1' }),
      ...faces
    }
  })
  await app.evaluate(({ dialog, shell }, savedTo) => {
    const seen: string[] = []
    const files: string[] = []
    const saves: unknown[] = []
    Object.assign(globalThis, { openedLinks: seen, openedFiles: files, saveDialogs: saves })
    shell.openExternal = async (url: string) => void seen.push(url)
    shell.openPath = async (path: string) => {
      files.push(path)
      return ''
    }
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      saves.push(args.at(-1))
      return { canceled: false, filePath: savedTo }
    }) as typeof dialog.showSaveDialog
  }, join(data, 'saved-attachment'))
  const page = await app.firstWindow()
  if (options.size) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0]?.setSize(width as number, height as number)
    }, options.size)
  }
  return {
    app,
    page,
    gmail,
    smtp,
    opened: () => app.evaluate(() => (globalThis as unknown as { openedLinks: string[] }).openedLinks),
    openedFiles: () => app.evaluate(() => (globalThis as unknown as { openedFiles: string[] }).openedFiles),
    savedTo: join(data, 'saved-attachment'),
    data,
    stop: async () => {
      await app.close()
      await gmail.stop()
      await smtp.stop()
      rmSync(data, { recursive: true, force: true })
    }
  }
}

export async function signIn(run: Running): Promise<void> {
  await run.page.getByLabel('Email address').fill(ME)
  await run.page.getByRole('radio', { name: 'Gmail' }).click() // this address isn't one it would recognise
  await run.page.getByLabel('App password').fill(run.gmail.secret)
  await run.page.getByRole('button', { name: 'Add' }).click()
  await run.page.getByRole('search').or(run.page.getByLabel('Search')).waitFor()
}

/** Moves the main process's clock on, as a laptop left alone would find it. The page keeps its own. */
export async function later(run: Running, ms: number): Promise<void> {
  await run.app.evaluate((_electron, by) => {
    const clock = globalThis as unknown as { realNow?: () => number; ahead?: number }
    clock.realNow ??= Date.now.bind(Date)
    clock.ahead = (clock.ahead ?? 0) + by
    Date.now = () => (clock.realNow as () => number)() + (clock.ahead ?? 0)
  }, ms)
}

/** "HH:MM" for a moment, in this laptop's time. */
export const hhmm = (at: number): string => {
  const day = new Date(at)
  return `${String(day.getHours()).padStart(2, '0')}:${String(day.getMinutes()).padStart(2, '0')}`
}

export async function syncAndSettle(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Sync/ }).click()
  await page.getByRole('button', { name: 'Sync', exact: true }).waitFor()
}
