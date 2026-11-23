import { expect, test, type Page } from '@playwright/test'
import { rawMail } from '../tests/fake-gmail'
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
