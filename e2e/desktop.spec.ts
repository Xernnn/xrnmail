import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rawMail } from '../tests/fake-gmail'
import { pdf } from '../tests/files'
import { launch, signIn, type Running } from './app'

const earlier = (hours: number): Date => new Date(Date.now() - hours * 3_600_000)

let run: Running

test.afterEach(async () => run?.stop())

/** How many matches each page has marked, the window's own and each message's frame, and which page
 *  has the current one. */
const marks = (page: Page): Promise<{ own: number; frames: number[]; now: string }> => page.evaluate(() => {
  const count = (win: Window | null): number => (win as (Window & typeof globalThis) | null)?.CSS.highlights.get('xrn-find')?.size ?? 0
  const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.body-frame')]
  const hasNow = (win: Window | null): boolean => (win as (Window & typeof globalThis) | null)?.CSS.highlights.has('xrn-find-now') ?? false
  const now = hasNow(window) ? 'own' : frames.findIndex((f) => hasNow(f.contentWindow)) >= 0 ? `frame ${frames.findIndex((f) => hasNow(f.contentWindow))}` : 'none'
  return { own: count(window), frames: frames.map((f) => count(f.contentWindow)), now }
})

/** Whether the current match is inside what the thread's pane shows. */
const currentInSight = (page: Page): Promise<boolean> => page.evaluate(() => {
  const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.body-frame')]
  const pane = document.querySelector('.messages')?.getBoundingClientRect()
  for (const [win, frame] of [[window, null] as const, ...frames.map((f) => [f.contentWindow, f] as const)]) {
    const now = (win as (Window & typeof globalThis) | null)?.CSS.highlights.get('xrn-find-now')
    if (!now || !pane) continue
    const [range] = [...now] as Range[]
    const rect = range!.getBoundingClientRect()
    const top = rect.top + (frame?.getBoundingClientRect().top ?? 0)
    return top >= pane.top && top + rect.height <= pane.bottom
  }
  return false
})

const filler = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the minutes.`).join('\n')

function addThread(run: Running): void {
  run.gmail.add(rawMail({ subject: 'Offsite', from: 'Mai Tran <mai@example.com>', text: 'The venue is the Harbour Room on level 2.' }), { arrived: earlier(6), thread: 71n, flags: ['\\Seen'] })
  run.gmail.add(rawMail({
    subject: 'Re: Offsite', from: 'Linh Pham <linh@example.com>',
    html: '<p>Bring your <b>badge</b> to the Harbour <i>Room</i>.</p><p>Lịch thi is posted.</p>'
  }), { arrived: earlier(5), thread: 71n })
  run.gmail.add(rawMail({ subject: 'Re: Offsite', from: 'Mai Tran <mai@example.com>', text: `${filler}\nSee you in the harbour room.` }), { arrived: earlier(4), thread: 71n })
}

test('finding words in the open thread: every message, HTML ones in their frames, one match after another', async () => {
  run = await launch({ size: [1300, 800] })
  const { page } = run
  addThread(run)
  await signIn(run)
  await page.locator('.threads').getByText('Offsite').first().click()
  await expect(page.locator('.message-head.closed')).toHaveCount(1) // the first message is folded shut
  await page.locator('iframe.body-frame').waitFor()

  await page.keyboard.press('Control+g') // Edison's set
  const bar = page.getByRole('group', { name: 'Find in message' })
  const box = bar.getByRole('textbox', { name: 'Find in message' })
  await expect(box).toBeFocused()
  await box.fill('harbour room')
  const count = bar.locator('.find-count')
  await expect(count).toHaveText('1/3')
  await expect(page.locator('.message-head.closed')).toHaveCount(0) // the shut one had it, so it opened
  await expect.poll(() => marks(page)).toEqual({ own: 2, frames: [1], now: 'own' })

  await box.press('Enter')
  await expect(count).toHaveText('2/3')
  await expect.poll(() => marks(page).then((m) => m.now)).toBe('frame 0') // "Harbour <i>Room</i>", across the tags
  await box.press('Enter')
  await expect(count).toHaveText('3/3')
  await expect.poll(() => currentInSight(page)).toBe(true) // far down the last message, scrolled to
  await box.press('Enter')
  await expect(count).toHaveText('1/3') // round to the first
  await box.press('Shift+Enter')
  await expect(count).toHaveText('3/3')
  await page.keyboard.press('F3')
  await expect(count).toHaveText('1/3')
  await page.keyboard.press('Shift+F3')
  await expect(count).toHaveText('3/3')
  await bar.getByRole('button', { name: 'Previous match' }).click()
  await expect(count).toHaveText('2/3')

  await box.fill('lich thi') // without its marks
  await expect(count).toHaveText('1/1')
  await expect.poll(() => marks(page)).toEqual({ own: 0, frames: [1], now: 'frame 0' })
  await box.fill('nowhere in it')
  await expect(count).toHaveText('0/0')
  await expect(bar.getByRole('button', { name: 'Next match' })).toBeDisabled()

  await box.fill('venue')
  await expect(count).toHaveText('1/1')
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  await expect.poll(() => marks(page)).toEqual({ own: 0, frames: [0], now: 'none' })
  await expect(page.getByRole('toolbar', { name: 'Thread' })).toBeVisible() // Esc closed the bar, not the thread
  await page.keyboard.press('Control+g')
  await expect(box).toHaveValue('venue') // kept, ready to be typed over
  await expect(count).toHaveText('1/1')
  await page.keyboard.press('Escape')

  // The thread's More menu has it too.
  await page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Find in message' }).click()
  await expect(box).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  expect(await run.opened()).toEqual([])
})

test('finding words in a thread in a window of its own, and with Gmail\'s keys', async () => {
  run = await launch()
  const { page, app } = run
  addThread(run)
  await page.evaluate(() => window.mail.saveProfile({ keys: 'gmail' }))
  await signIn(run)
  await page.locator('.threads').getByText('Offsite').first().click()
  await page.locator('iframe.body-frame').waitFor()
  // Gmail's set has Ctrl+Shift+F for it; there Ctrl+G only steps while the bar is open.
  await page.keyboard.press('Control+g')
  await expect(page.getByRole('group', { name: 'Find in message' })).toHaveCount(0)
  await page.keyboard.press('Control+Shift+F')
  await expect(page.getByRole('textbox', { name: 'Find in message' })).toBeFocused()
  await page.keyboard.press('Escape')
  const [solo] = await Promise.all([app.waitForEvent('window'), page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Open in a window' }).click()])
  await solo.getByRole('heading', { name: 'Offsite' }).waitFor() // read by now, so all but the newest are shut
  await solo.keyboard.press('Control+Shift+F')
  const bar = solo.getByRole('group', { name: 'Find in message' })
  await bar.getByRole('textbox').fill('badge')
  await expect(bar.locator('.find-count')).toHaveText('1/1')
  await expect.poll(() => marks(solo)).toEqual({ own: 0, frames: [1], now: 'frame 0' })
  await solo.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(solo.getByRole('toolbar', { name: 'Thread' })).toBeVisible()
})

test('Sound for new mail: a switch with the notices, off to start with', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  expect((await page.evaluate(() => window.mail.settings())).sound).toBe(false)
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Notifications' }).click()
  const sound = settings.getByRole('checkbox', { name: 'Sound', exact: true })
  await expect(sound).not.toBeChecked()
  await sound.check()
  await expect.poll(() => page.evaluate(async () => (await window.mail.settings()).sound)).toBe(true)
  await settings.getByLabel('Search settings').fill('sound')
  await expect(settings.getByRole('button', { name: 'Notifications' })).toBeVisible()
})

/** A message as a file, as a mail app saves one: a stranger's HTML, a picture to block, a file, and an
 *  Authentication-Results line that would vouch for it if anyone had checked. */
function messageFile(folder: string): string {
  const path = join(folder, 'Floor plan.eml')
  writeFileSync(path, rawMail({
    from: 'Mai Tran <mai@example.com>', to: 'me@example.com', subject: 'Floor plan',
    headers: ['Reply-To: plans@elsewhere.example', 'Authentication-Results: mx.google.com; dmarc=pass header.from=example.com'],
    html: '<p>The new <b>floor plan</b> is attached.</p><img src="https://images.example/plan.png" width="300" height="200">',
    attachment: { name: 'plan.pdf', type: 'application/pdf', body: pdf() }
  }))
  return path
}

const fileWindow = async (app: Running['app']): Promise<Page> => {
  await expect.poll(() => app.windows().filter((w) => w.url().includes('solo=file')).length).toBeGreaterThan(0)
  return app.windows().filter((w) => w.url().includes('solo=file')).at(-1) as Page
}

test('an .eml file opens read-only in a window of its own: unverified, pictures blocked, its file saved', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'xrnmail-eml-'))
  run = await launch({ args: [messageFile(folder)] })
  const { app } = run
  const letter = await fileWindow(app)
  await expect(letter.getByRole('heading', { name: 'Floor plan' })).toBeVisible()
  await expect(letter).toHaveTitle('Floor plan')
  await expect(letter.frameLocator('iframe.body-frame').getByText('is attached.')).toBeVisible()
  await expect(letter.getByRole('alert')).toContainText("Your mail service couldn't confirm who sent this.")
  await expect(letter.getByRole('alert')).toContainText('Replies to this go to a different address: plans@elsewhere.example.')
  await expect(letter.getByRole('button', { name: 'Show images' })).toBeVisible()
  await expect(letter.getByRole('button', { name: 'Always from this sender' })).toHaveCount(0)
  const tools = letter.getByRole('toolbar', { name: 'Thread' })
  for (const name of ['Archive', 'Delete', 'Flag', 'Snooze', 'Open in a window']) await expect(tools.getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(letter.locator('.reply-bar')).toHaveCount(0) // no account to answer from yet
  await letter.getByRole('button', { name: 'Save plan.pdf' }).click()
  await expect(letter.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(run.savedTo)).toEqual(pdf())
  await letter.keyboard.press('Control+g')
  await letter.getByRole('textbox', { name: 'Find in message' }).fill('floor plan')
  await expect(letter.locator('.find-count')).toHaveText('1/2') // the subject, and in the message
  expect(await run.opened()).toEqual([])
  rmSync(folder, { recursive: true, force: true })
})

test('a second launch with a file opens it beside the app, and Reply answers from the account it came to', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'xrnmail-eml-'))
  messageFile(folder)
  mkdirSync(join(folder, 'Folder.eml'))
  run = await launch()
  const { app, page } = run
  await signIn(run)
  const launchWith = (argv: string[]): Promise<void> => app.evaluate(({ app }, [argv, from]) => void app.emit('second-instance', {}, argv, from), [argv, folder] as const)
  await launchWith(['xrnmail', '--appimage-extract-and-run', 'Floor plan.eml']) // from where it was started
  const letter = await fileWindow(app)
  await expect(letter.getByRole('heading', { name: 'Floor plan' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Floor plan' })).toHaveCount(0) // it isn't mail of the account's
  const [draft] = await Promise.all([app.waitForEvent('window'), letter.locator('.reply-bar').getByRole('button', { name: 'Reply' }).click()])
  const box = draft.getByRole('region', { name: 'Compose' })
  await expect(box.getByLabel('Subject')).toHaveValue('Re: Floor plan')
  await expect(box).toContainText('plans@elsewhere.example')
  expect(draft.url()).toContain('solo=draft')
  const [forward] = await Promise.all([app.waitForEvent('window'), letter.locator('.reply-bar').getByRole('button', { name: 'Forward' }).click()])
  const forwarding = forward.getByRole('region', { name: 'Compose' })
  await expect(forwarding.getByLabel('Subject')).toHaveValue('Fwd: Floor plan')
  await expect(forwarding.getByText('plan.pdf')).toBeVisible() // its file goes with it

  await launchWith(['xrnmail', pathToFileURL(join(folder, 'Folder.eml')).href])
  await expect.poll(() => app.windows().filter((w) => w.url().includes('solo=file')).length).toBe(2)
  const failed = await fileWindow(app)
  await expect(failed.getByText("Couldn't open this file")).toBeVisible()
  await expect(failed.getByText("That isn't a mail file.")).toBeVisible()
  rmSync(folder, { recursive: true, force: true })
})

test('Use for mail links: xdg-mime is asked to make this the mail app, and then it says Default', async () => {
  run = await launch()
  const { page, app } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const use = settings.getByRole('button', { name: 'Use for mail links' })
  await use.click()
  await expect(settings.locator('.mail-links')).toContainText('Default')
  await expect(use).toHaveCount(0)
  // The tests' xdg-mime is a stand-in: the real one is never run.
  expect(await app.evaluate(() => (globalThis as unknown as { mimeAsked: string[][] }).mimeAsked)).toEqual([
    ['xdg-mime', 'query', 'default', 'x-scheme-handler/mailto'],
    ['xdg-mime', 'default', 'xrnmail.desktop', 'x-scheme-handler/mailto'],
    ['xdg-mime', 'query', 'default', 'x-scheme-handler/mailto']
  ])
})
