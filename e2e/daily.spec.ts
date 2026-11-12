import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rawMail } from '../tests/fake-gmail'
import { launch, ME, signIn, type Running } from './app'

const LONG = { timeout: 15_000 }
const earlier = (hours: number): Date => new Date(Date.now() - hours * 3_600_000)

let run: Running

test.afterEach(async () => run?.stop())

/** No wait after Send, so a test isn't mostly waiting. */
async function undoOff(page: Page): Promise<void> {
  await page.evaluate(() => window.mail.saveProfile({ undoSeconds: 0 }))
}

const composer = (page: Page): ReturnType<Page['locator']> => page.getByRole('region', { name: 'Compose' })

test('writing a new message: it leaves, and lands in Sent', async () => {
  run = await launch()
  const { page, smtp, gmail } = run
  smtp.delivered = (raw) => void gmail.add(raw, { labels: ['\\Sent'], flags: ['\\Seen'] })
  await signIn(run)
  await undoOff(page)
  await page.keyboard.press('c')
  const box = composer(page)
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Subject').fill('Hello from xrnmail')
  await box.getByLabel('Message').click()
  await page.keyboard.type('Plain words')
  await page.keyboard.press('Control+Enter')
  await expect(box).toHaveCount(0)
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.to).toEqual(['ada@example.com'])
  expect(smtp.sent[0]?.raw).toContain('Plain words')
  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await expect(page.getByText('Hello from xrnmail')).toBeVisible(LONG)
})

test('the composer: From under the recipients, formatting in a bar of its own, and Send in words at the foot', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await undoOff(page)
  await page.keyboard.press('c')
  const box = composer(page)
  const fields = (): Promise<string[]> => box.locator('.field > span:first-child').allTextContents()
  expect(await fields()).toEqual(['To', 'From', 'Subject'])
  await expect(box.getByLabel('From')).toBeDisabled() // one address to send from, shown all the same
  await expect(box.getByLabel('From')).toHaveValue(JSON.stringify([ME, ME]))
  await box.getByRole('button', { name: 'Cc Bcc' }).click()
  expect(await fields()).toEqual(['To', 'Cc', 'Bcc', 'From', 'Subject'])
  const tools = await box.getByRole('toolbar', { name: 'Formatting' }).getByRole('button').evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')))
  expect(tools).toEqual(['Bold', 'Italic', 'Underline', 'Strikethrough', 'Clear formatting', 'Add link', 'Quote', 'Numbered list', 'List'])
  const send = box.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)') // words and a paper plane, not a filled button
  const [sendBox, barBox] = [await send.boundingBox(), await box.getByRole('toolbar', { name: 'Formatting' }).boundingBox()]
  expect(sendBox?.y ?? 0).toBeGreaterThan((barBox?.y ?? 0) + (barBox?.height ?? 0) - 1)
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Subject').fill('Formatted')
  await box.getByLabel('Message').click()
  await page.keyboard.type('struck')
  await page.keyboard.press('Control+A')
  await box.getByRole('button', { name: 'Strikethrough' }).click()
  await send.click()
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toMatch(/<(s|strike)>struck<\/(s|strike)>/)
})

test('undoing a send calls it back with everything intact', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Compose' }).click()
  const box = composer(page)
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Subject').fill('Oops')
  await box.getByLabel('Message').fill('Not yet')
  await box.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Oops')
  await expect(composer(page).getByLabel('Message')).toHaveText('Not yet')
  await new Promise((resolve) => setTimeout(resolve, 11_000))
  expect(smtp.received).toBe(0)
})

test('a draft survives closing, and a restart of the page', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.keyboard.press('c')
  const box = composer(page)
  await box.getByLabel('Subject').fill('Half finished')
  await box.getByLabel('Message').fill('Some words')
  await box.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText('Saved to Drafts')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await page.getByText('Half finished').click()
  await expect(composer(page).getByLabel('Message')).toHaveText('Some words')
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()
  await expect(page.getByText('Half finished')).toHaveCount(0)
})

test('an empty new message leaves nothing behind', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.keyboard.press('c')
  await page.keyboard.press('Escape')
  await expect(composer(page)).toHaveCount(0)
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await expect(page.getByText('Nothing here')).toBeVisible()
})

test('replying to a hostile email: its HTML stays out of the page and out of what is sent', async () => {
  run = await launch()
  const { page, gmail, smtp } = run
  const hostile = `<div id="planted">Please read</div><img src=x onerror="document.title='pwned'"><script>document.title='pwned'</script>`
  gmail.add(rawMail({ subject: 'Invoice', from: 'Mallory <mallory@example.com>', html: hostile }), { arrived: earlier(2) })
  await signIn(run)
  await undoOff(page)
  await page.getByText('Invoice').click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  const box = composer(page)
  await expect(box.getByRole('button', { name: 'Remove mallory@example.com' })).toBeVisible()
  await expect(box.getByLabel('Subject')).toHaveValue('Re: Invoice')
  await box.getByRole('button', { name: 'Quoted message' }).click()
  await expect(box.locator('iframe.body-frame')).toHaveAttribute('sandbox', 'allow-same-origin')
  await expect(page.frameLocator('.composer iframe').getByText('Please read')).toBeVisible()
  expect(await page.locator('#planted').count()).toBe(0) // only inside the frame
  await box.getByLabel('Message').fill('Paid.')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  const sent = smtp.sent[0]?.raw ?? ''
  expect(sent).toContain('Paid.')
  expect(sent).toContain('Please read')
  expect(sent).not.toContain('onerror')
  expect(sent).not.toContain('<script')
  expect(await page.title()).toBe('xrnmail')
})

test('triage by keyboard: archive, move on, undo, delete', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Oldest' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Middle' }), { arrived: earlier(4) })
  gmail.add(rawMail({ subject: 'Newest' }), { arrived: earlier(3) })
  await signIn(run)
  const list = page.locator('.threads')
  await list.getByText('Newest').click()
  await expect(page.locator('.thread-subject')).toHaveText('Newest')
  await page.keyboard.press('e')
  await expect(list.getByText('Newest')).toHaveCount(0)
  await expect(page.locator('.thread-subject')).toHaveText('Middle') // the next one, not an empty pane
  await page.keyboard.press('z')
  await expect(list.getByText('Newest')).toBeVisible()
  await page.keyboard.press('#')
  await expect(list.getByText('Middle')).toHaveCount(0)
  await expect.poll(() => gmail.moved.length, LONG).toBe(1)
  expect(gmail.mails.find((m) => m.raw.toString().includes('Newest'))?.labels).toContain('\\Inbox')
})

// The refresh that follows a change waits 150 ms, and quitting can close the store and destroy the
// tray before it comes. When the app took longer than that to go, the refresh still ran, and with
// unread mail shown it set the image of the destroyed tray, which throws in the main process.
test('Edison\'s keys work beside the old ones, and the Gmail set can be chosen instead', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['First', 'Second', 'Third', 'Fourth'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(8 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const row = (subject: string): ReturnType<Page['locator']> => list.locator('.thread', { hasText: subject })
  await list.getByText('Fourth').click()
  await page.keyboard.press('Backspace') // out of view: archived
  await expect(page.getByText('Archived')).toBeVisible()
  await expect(row('Fourth')).toHaveCount(0)
  await expect(page.locator('.thread-subject')).toHaveText('Third')
  await page.keyboard.press('Shift+Backspace')
  await expect(page.getByText('Moved to Trash')).toBeVisible()
  await expect(row('Third')).toHaveCount(0)
  await expect(page.locator('.thread-subject')).toHaveText('Second')
  await page.keyboard.press('Control+s')
  await expect(row('Second').getByLabel('Flagged')).toBeVisible()
  await page.keyboard.press('Control+r')
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Re: Second')
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()
  await expect(composer(page)).toHaveCount(0) // keys are the composer's own until it has gone
  await page.keyboard.press('Control+Shift+U')
  await expect(row('Second').locator('.unread-dot')).toBeVisible()
  await page.keyboard.press('d')
  await expect(composer(page).getByLabel('To')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer(page)).toHaveCount(0)
  await page.keyboard.press('?')
  await expect(page.getByText('Remove from view')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Shortcuts' }).click()
  await page.getByLabel('Shortcut set').selectOption('gmail')
  await expect(page.getByText('Remove from view')).toHaveCount(0)
  await page.getByRole('button', { name: 'Done' }).click()
  // The window hears of a changed setting a moment after it's saved. Its own list of keys says when.
  await page.keyboard.press('?')
  await expect(page.getByRole('heading', { name: 'Keys' })).toBeVisible()
  await expect(page.locator('.keys')).not.toContainText('Remove from view')
  await page.getByRole('button', { name: 'Done' }).click()
  await list.getByText('Second').click()
  await page.keyboard.press('Backspace') // not a key of this set
  await page.keyboard.press('d')
  await expect(composer(page)).toHaveCount(0)
  await expect(page.locator('.thread-subject')).toHaveText('Second')
  await page.keyboard.press('Delete')
  await expect(row('Second')).toHaveCount(0)
})

test('nothing refreshes once quitting has closed the store', async () => {
  run = await launch()
  const { page, app } = run
  await page.getByLabel('Email address').waitFor() // no account, so closing has nothing to wait for
  const folder = mkdtempSync(join(tmpdir(), 'xrnmail-quit-'))
  const log = join(folder, 'log.txt')
  await app.evaluate(({ app: electron, BrowserWindow }, path) => {
    const { appendFileSync } = process.getBuiltinModule('node:fs')
    const shown = BrowserWindow.getAllWindows()[0]!
    const send = shown.webContents.send.bind(shown.webContents)
    shown.webContents.send = (channel: string, ...args: unknown[]) => {
      appendFileSync(path, `${channel}\n`)
      send(channel, ...args)
    }
    // The second is the one that closes the store; this listener runs after the app's own.
    let quits = 0
    electron.on('before-quit', () => { if (++quits === 2) appendFileSync(path, 'closed\n') })
    // A window slow to close, as a busy one can be, keeps the app going past the 150 ms.
    shown.on('close', () => { const until = Date.now() + 300; while (Date.now() < until); })
  }, log)
  await page.evaluate(() => window.mail.unsnooze([])) // a change, so a refresh is on its way
  await run.stop()
  const events = readFileSync(log, 'utf8').trim().split('\n')
  expect(events.slice(events.indexOf('closed'))).toEqual(['closed'])
  rmSync(folder, { recursive: true, force: true })
})

test('the window: a title and search over list and reader, and the sidebar in its order', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Filed' }), { arrived: earlier(2) })
  await signIn(run)
  const title = page.locator('.band').getByRole('heading', { level: 1 })
  await expect(title).toHaveText('Inbox')
  const box = async (selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
    const found = await page.locator(selector).boundingBox()
    if (!found) throw new Error(`${selector} isn't on screen`)
    return found
  }
  const [band, list, reader, search] = [await box('.band'), await box('section.list'), await box('.reader'), await box('.band .search')]
  expect(Math.round(band.x)).toBe(Math.round(list.x))
  expect(Math.round(band.x + band.width)).toBe(Math.round(reader.x + reader.width))
  expect(list.y).toBeGreaterThanOrEqual(band.y + band.height - 1)
  expect(search.x).toBeGreaterThan(reader.x) // at the right, over the reader
  const side = page.locator('.sidebar')
  const names = async (group: number): Promise<string[]> =>
    (await side.locator('.nav-group').nth(group).locator('.nav-item .grow').allInnerTexts()).map((name) => name.trim())
  expect(await names(0)).toEqual(['Inbox'])
  expect(await names(1)).toEqual([ME, 'All Mail'])
  expect(await names(2)).toEqual(['Today', 'Unread', 'Flagged', 'Pinned', 'Summary', 'Snoozed', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Sent', 'Recently Seen'])
  expect(await names(3)).toEqual(['Subscriptions', 'Travel', 'Packages', 'Bills & Receipts', 'Events'])
  await side.getByRole('button', { name: `Folders of ${ME}` }).click()
  await expect(side.getByRole('button', { name: 'All Mail' })).toHaveCount(0)
  await side.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(title).toHaveText('Archive')
  await expect(page.getByText('Nothing here')).toBeVisible()
  await side.getByRole('button', { name: /^Inbox/ }).click()
  await page.getByText('Filed').click()
  await page.keyboard.press('e')
  await side.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('.threads').getByText('Filed')).toBeVisible()
})

test('a row under the pointer offers archive, flag, delete and read, and shows two lines of the message', async () => {
  run = await launch()
  const { page, gmail } = run
  const long = 'First words of a message that goes on for a good while, long enough that one line of the list could never hold all of it.'
  gmail.add(rawMail({ subject: 'Lines', text: long }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Other one' }), { arrived: earlier(4), flags: ['\\Seen'] })
  await signIn(run)
  const row = page.locator('.threads .thread', { hasText: 'Lines' })
  await expect(page.locator('.threads h2')).toHaveCount(0) // no headings by day
  const lineHeight = await row.locator('.snippet').evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  expect((await row.locator('.snippet').boundingBox())?.height).toBe(lineHeight * 2)
  await expect(row.locator('.unread-dot')).toBeVisible()
  await expect(row.locator('.sender')).toHaveCSS('font-weight', '700')
  await expect(page.locator('.threads .thread', { hasText: 'Other one' }).locator('.sender')).toHaveCSS('font-weight', '400')
  await row.hover()
  const labels = await row.locator('.row-actions button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
  expect(labels).toEqual(['Archive', 'Flag', 'Delete', 'Mark read'])
  await expect(row.locator('time')).toBeHidden() // the buttons take the date's place
  await row.getByRole('button', { name: 'Flag', exact: true }).click()
  await expect(row.getByLabel('Flagged')).toBeVisible()
  await row.getByRole('button', { name: 'Mark read' }).click()
  await expect(row.locator('.unread-dot')).toHaveCount(0)
  await page.getByText('Lines').click()
  await expect(row).toHaveClass(/\bon\b/)
  const tint = await row.locator('.thread-card').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(tint).toBe('rgb(226, 236, 249)') // a tint the words stay dark on, not a block of blue
  await row.hover()
  await row.getByRole('button', { name: 'Archive' }).click()
  await expect(row).toHaveCount(0)
})

test('the bar under a selection takes every row, lets go of them, and Trash can be emptied', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Alpha', 'Beta', 'Gamma'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  await expect(page.locator('.threads .thread')).toHaveCount(3)
  await page.getByLabel('Select Beta').check({ force: true })
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  await expect(bar.getByText('1 selected')).toBeVisible()
  const [barBox, listBox] = [await bar.boundingBox(), await page.locator('section.list').boundingBox()]
  expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeGreaterThan((listBox?.y ?? 0) + (listBox?.height ?? 0) - 40) // it floats at the foot
  await bar.getByRole('button', { name: 'Select All (3)' }).click()
  await expect(bar.getByText('3 selected')).toBeVisible()
  await bar.getByRole('button', { name: 'Cancel' }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.locator('.threads .thread')).toHaveCount(3)
  await page.getByLabel('Select Alpha').check({ force: true })
  await page.getByLabel('Select Beta').check({ force: true })
  await bar.getByRole('button', { name: 'Delete selected' }).click()
  await expect(page.getByText('Moved to Trash: 2 threads')).toBeVisible()
  await expect.poll(() => gmail.box('[Gmail]/Trash').mails.length, { timeout: 20_000 }).toBe(2) // once Undo has had its chance
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(page.getByText('2 threads in Trash')).toBeVisible(LONG)
  await page.getByRole('button', { name: 'Empty Trash now' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash' }).click()
  await expect(page.getByText('Nothing here')).toBeVisible()
  await expect.poll(() => gmail.box('[Gmail]/Trash').mails.length, { timeout: 20_000 }).toBe(0)
  expect(gmail.mails.filter((m) => m.labels.includes('\\Inbox')).length).toBe(1)
})

test('the reader: actions over the thread, a pill by the sender, and Reply and Forward at the foot', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plain', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'To several', from: 'Mai Tran <mai@example.com>', to: `${ME}, Linh Pham <linh@example.com>` }), { arrived: earlier(4) })
  gmail.add(rawMail({ subject: 'Offers', from: 'Shop <hi@shop.example>', headers: ['List-Unsubscribe: <mailto:leave@shop.example>'] }), { arrived: earlier(3) })
  await signIn(run)
  await page.locator('.threads').getByText('Plain').click()
  const tools = page.getByRole('toolbar', { name: 'Thread' })
  const labels = await tools.getByRole('button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
  expect(labels).toEqual(['Archive', 'Delete', 'Flag', 'Mark unread', 'Labels', 'Snooze', 'More', 'Open in a window'])
  const message = page.locator('.message.open')
  await expect(message).toHaveCSS('border-top-width', '0px') // no card around a message
  await expect(message.getByText('To: me')).toBeVisible()
  const bar = page.locator('.reply-bar')
  await expect(bar.getByRole('button')).toHaveText(['Reply', 'Forward'])
  const [barBox, readerBox] = [await bar.boundingBox(), await page.locator('.reader').boundingBox()]
  expect(Math.round((barBox?.y ?? 0) + (barBox?.height ?? 0))).toBe(Math.round((readerBox?.y ?? 0) + (readerBox?.height ?? 0)))

  await page.locator('.threads').getByText('To several').click()
  await expect(bar.getByRole('button')).toHaveText(['Reply', 'Reply All', 'Forward'])
  await bar.getByRole('button', { name: 'Reply All' }).click()
  await expect(composer(page).getByRole('button', { name: 'Remove mai@example.com' })).toBeVisible()
  await expect(composer(page).getByRole('button', { name: 'Remove linh@example.com' })).toBeVisible()
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()
  await message.getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('button', { name: 'Forward' }).first().click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Fwd: To several')
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()

  await page.getByRole('button', { name: /^Other/ }).click() // where mail from a list goes
  await page.locator('.threads').getByText('Offers').click()
  await expect(message.getByRole('button', { name: 'Unsubscribe' })).toBeVisible()
  await expect(message.getByRole('button', { name: 'Block' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Focused' }).click()
  await page.locator('.threads').getByText('Plain').click()
  await message.getByRole('button', { name: 'Block' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click()
  await expect(page.getByText('Blocked mai@example.com')).toBeVisible()
  await expect(page.locator('.threads').getByText('Plain')).toHaveCount(0)
})

test('a place in the sidebar can be right-clicked to mark all of it read', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['One', 'Two', 'Three'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  await expect(page.locator('.threads .unread-dot')).toHaveCount(3)
  await page.locator('.sidebar').getByRole('button', { name: 'Unread', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click()
  await expect(page.getByText('Marked as read: 3 threads')).toBeVisible()
  await expect(page.locator('.threads .unread-dot')).toHaveCount(0)
  await expect.poll(() => gmail.mails.filter((m) => m.flags.includes('\\Seen')).length, LONG).toBe(3)
  await page.locator('.sidebar').getByRole('button', { name: /^Inbox/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click()
  await expect(page.getByText('Nothing unread there')).toBeVisible()
})

test('selecting several and acting on them together', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Alpha', 'Beta', 'Gamma'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  await page.getByLabel('Select Alpha').check({ force: true })
  await page.getByLabel('Select Gamma').click({ force: true, modifiers: ['Shift'] })
  await expect(page.getByText('3 selected')).toBeVisible()
  await page.getByRole('button', { name: 'Archive selected' }).click()
  await expect(page.getByText('Archived: 3 threads')).toBeVisible()
  await expect(page.getByText('Nothing here')).toBeVisible()
  await expect.poll(() => gmail.mails.filter((m) => m.labels.includes('\\Inbox')).length, LONG).toBe(0)
})

test('keys keep working after ticking a checkbox, and act on the selection', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Alpha', 'Beta', 'Gamma'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  await page.getByLabel('Select Alpha').check({ force: true })
  await page.getByLabel('Select Beta').check({ force: true })
  await page.keyboard.press('e')
  await expect(page.getByText('Archived: 2 threads')).toBeVisible()
  await expect(page.locator('.threads').getByText('Gamma')).toBeVisible()
  await expect(page.locator('.threads').getByText('Alpha')).toHaveCount(0)
})

test('keys work after clicking inside a message', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Styled', html: '<p>Click in here</p>' }), { arrived: earlier(5) })
  await signIn(run)
  await page.getByText('Styled').first().click()
  await page.frameLocator('iframe.body-frame').getByText('Click in here').click()
  await page.keyboard.press('e')
  await expect(page.locator('.threads').getByText('Styled')).toHaveCount(0)
})

test('snoozing takes a thread away until its time, and it can be found meanwhile', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Later please' }), { arrived: earlier(5) })
  await signIn(run)
  await page.getByText('Later please').click()
  await page.keyboard.press('b')
  await page.getByRole('button', { name: /^Tomorrow/ }).click()
  await expect(page.locator('.threads').getByText('Later please')).toHaveCount(0)
  await page.getByRole('button', { name: 'Snoozed', exact: true }).click()
  await expect(page.locator('.threads').getByText('Later please')).toBeVisible()
  await page.getByRole('button', { name: 'Inbox', exact: true }).click()
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect(page.locator('.threads').getByText('Later please')).toBeVisible()
})

test('flags and labels reach Gmail', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Keep this' }), { arrived: earlier(5) })
  await signIn(run)
  await page.getByText('Keep this').click()
  await page.keyboard.press('s')
  await expect.poll(() => gmail.mails[0]?.flags).toContain('\\Flagged')
  await page.keyboard.press('l')
  await page.getByLabel('New label').fill('Taxes')
  await page.getByLabel('New label').press('Enter')
  await expect.poll(() => gmail.mails[0]?.labels).toContain('Taxes')
  await expect(page.locator('.tag')).toHaveText('Taxes')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Flagged', exact: true }).click()
  await expect(page.locator('.threads').getByText('Keep this')).toBeVisible()
})

test('attachments: saved exactly, opened only when safe', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Files', attachment: { name: 'report.pdf', type: 'application/pdf', body: 'the real bytes' } }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Trap', attachment: { name: 'totally-a-photo.desktop', type: 'application/x-desktop', body: '[Desktop Entry]\nExec=rm -rf ~' } }), { arrived: earlier(4) })
  await signIn(run)
  await page.locator('.threads').getByText('Files').click()
  await page.getByRole('button', { name: 'Save report.pdf' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(run.savedTo, 'utf8')).toBe('the real bytes')
  await page.getByRole('button', { name: /^report\.pdf/ }).click()
  await expect.poll(run.openedFiles).toHaveLength(1)
  await page.locator('.threads').getByText('Trap').click()
  await page.getByRole('button', { name: /^totally-a-photo/ }).click()
  await expect(page.getByText('Save this kind of file first')).toBeVisible()
  expect(await run.openedFiles()).toHaveLength(1)
})

// U+202E shows the rest of a name backwards, so a program could pass for a picture.
test('a thread in a window of its own: it follows the thread, and the main window keeps up', async () => {
  run = await launch()
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Lease', text: 'Signed copy inside.' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Lunch', text: 'Noon?' }), { arrived: earlier(4) })
  await signIn(run)
  const threads = page.locator('.threads')
  const out = page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Open in a window' })
  await threads.getByText('Lease').click()
  const [solo] = await Promise.all([app.waitForEvent('window'), out.click()])
  await expect(solo.getByRole('heading', { name: 'Lease' })).toBeVisible()
  await expect(solo.getByText('Signed copy inside.')).toBeVisible()
  await expect(solo).toHaveTitle('Lease')
  await expect(solo.locator('.sidebar, .list, .band')).toHaveCount(0) // the thread and nothing else
  await expect(solo.getByRole('button', { name: 'Open in a window' })).toHaveCount(0)
  await expect(solo.getByRole('button', { name: 'Back' })).toBeHidden()
  await expect(page.getByRole('toolbar', { name: 'Thread' })).toHaveCount(0) // it's read there now, not here as well
  await threads.getByText('Lease').click()
  await out.click() // asked for again, the window it has comes forward
  await expect(page.getByRole('toolbar', { name: 'Thread' })).toHaveCount(0)
  expect(app.windows()).toHaveLength(2)

  const bar = solo.getByRole('toolbar', { name: 'Thread' })
  await bar.getByRole('button', { name: 'Archive' }).click()
  await expect(solo.getByText('Archived')).toBeVisible()
  await expect(threads.getByText('Lease')).toHaveCount(0) // the main window hears of it
  await expect(solo.getByRole('heading', { name: 'Lease' })).toBeVisible() // and this one still shows it
  await expect(bar.getByRole('button', { name: 'Move to Inbox' })).toBeVisible()
  await solo.getByRole('button', { name: 'Undo' }).click()
  await expect(threads.getByText('Lease')).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Archive' })).toBeVisible()

  await bar.getByRole('button', { name: 'Delete', exact: true }).click() // into Trash, and the window goes with it
  await expect(bar.getByRole('button', { name: 'Delete forever' })).toBeVisible()
  await expect(solo.getByRole('heading', { name: 'Lease' })).toBeVisible()
  await expect(threads.getByText('Lease')).toHaveCount(0)
  await solo.getByRole('button', { name: 'Undo' }).click()
  await expect(bar.getByRole('button', { name: 'Archive' })).toBeVisible()
  await expect(threads.getByText('Lease')).toBeVisible()

  const row = threads.locator('.thread', { hasText: 'Lease' })
  await expect(row.locator('.unread-dot')).toHaveCount(0)
  const closed = solo.waitForEvent('close')
  await bar.getByRole('button', { name: 'Mark unread' }).click() // nothing left to read here, so it closes
  await closed
  await expect(row.locator('.unread-dot')).toHaveCount(1)
  expect(app.windows()).toHaveLength(1)
})

test('a thread deleted for good closes its window, once Undo has had its time', async () => {
  run = await launch()
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Old invoice', text: 'Paid long ago.' }), { arrived: earlier(5), box: '[Gmail]/Trash' })
  await signIn(run)
  await page.locator('.sidebar').getByRole('button', { name: 'Trash', exact: true }).click()
  await page.locator('.threads').getByText('Old invoice').click()
  const [solo] = await Promise.all([app.waitForEvent('window'), page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Open in a window' }).click()])
  const bar = solo.getByRole('toolbar', { name: 'Thread' })
  await expect(solo.getByText('Paid long ago.')).toBeVisible()
  await bar.getByRole('button', { name: 'Delete forever' }).click()
  await solo.getByRole('button', { name: 'Delete forever' }).last().click() // the question's own button
  await expect(solo.getByText('Paid long ago.')).toHaveCount(0)
  await solo.getByRole('button', { name: 'Undo' }).click() // gone from everywhere, and still not too late
  await expect(solo.getByText('Paid long ago.')).toBeVisible()
  expect(app.windows()).toHaveLength(2)
  await bar.getByRole('button', { name: 'Delete forever' }).click()
  const closed = solo.waitForEvent('close')
  await solo.getByRole('button', { name: 'Delete forever' }).last().click()
  await expect(solo.getByRole('button', { name: 'Undo' })).toBeVisible() // it waits while it can still be undone
  expect(app.windows()).toHaveLength(2)
  await closed
  expect(app.windows()).toHaveLength(1)
})

test('the composer in a window of its own: the draft goes over, what is typed is kept, and it sends', async () => {
  run = await launch()
  const { page, smtp, app } = run
  await signIn(run)
  await undoOff(page)
  await page.keyboard.press('c')
  const here = composer(page)
  await here.getByLabel('To').fill('ada@example.com')
  await here.getByLabel('Subject').fill('Plans')
  await here.getByLabel('Message').click()
  await page.keyboard.type('First words.')
  const [solo] = await Promise.all([app.waitForEvent('window'), here.getByRole('button', { name: 'Open in a window' }).click()])
  await expect(here).toHaveCount(0)
  await expect(page.getByText('Saved to Drafts')).toHaveCount(0) // it wasn't put away: it moved
  const there = composer(solo)
  await expect(there.getByLabel('Subject')).toHaveValue('Plans')
  await expect(there.getByLabel('Message')).toHaveText('First words.')
  await expect(there.getByRole('button', { name: 'Open in a window' })).toHaveCount(0)
  await expect(solo.locator('.sidebar, .list, .band, .reader')).toHaveCount(0)
  const [wide, tall] = await solo.evaluate(() => [window.innerWidth, window.innerHeight])
  const box = await there.boundingBox()
  expect([box?.x, box?.y, box?.width, box?.height]).toEqual([0, 0, wide, tall]) // it fills its window

  // Opened from Drafts while it's being written there, the same window comes forward: one editor.
  await page.locator('.sidebar').getByRole('button', { name: /^Drafts/ }).click()
  await page.locator('.threads').getByText('Plans').click()
  await expect(here).toHaveCount(0)
  expect(app.windows()).toHaveLength(2)

  // The window closed around it keeps what was typed a moment before.
  await there.getByLabel('Message').click()
  await solo.keyboard.type(' Second words.')
  const closed = solo.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((shown) => shown.webContents.getURL().includes('solo=draft'))?.close())
  await closed
  await expect(page.locator('.threads').getByText('First words. Second words.')).toBeVisible()

  // And from Drafts it opens here again, goes out again, and sends from there.
  await page.locator('.threads').getByText('Plans').click()
  await expect(here.getByLabel('Message')).toHaveText('First words. Second words.')
  const [again] = await Promise.all([app.waitForEvent('window'), here.getByRole('button', { name: 'Open in a window' }).click()])
  const sent = again.waitForEvent('close')
  await composer(again).getByRole('button', { name: 'Send', exact: true }).click()
  await sent // with nothing left to undo, it closes
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toContain('First words. Second words.')
  expect(app.windows()).toHaveLength(1)
})

test('a composer of its own closed with nothing in it leaves no draft, and Undo of a send brings it back there', async () => {
  run = await launch()
  const { page, smtp, app } = run
  await signIn(run)
  await page.keyboard.press('c')
  const [empty] = await Promise.all([app.waitForEvent('window'), composer(page).getByRole('button', { name: 'Open in a window' }).click()])
  await expect(composer(empty).getByLabel('Subject')).toBeVisible()
  const closed = empty.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((shown) => shown.webContents.getURL().includes('solo=draft'))?.close())
  await closed
  await expect.poll(() => page.evaluate(async () => (await window.mail.drafts()).length)).toBe(0)

  await page.keyboard.press('c')
  const [solo] = await Promise.all([app.waitForEvent('window'), composer(page).getByRole('button', { name: 'Open in a window' }).click()])
  const there = composer(solo)
  await there.getByLabel('To').fill('ada@example.com')
  await there.getByLabel('Subject').fill('Too soon')
  await there.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(there).toHaveCount(0)
  await solo.getByRole('button', { name: 'Undo' }).click() // the window waited for this
  await expect(there.getByLabel('Subject')).toHaveValue('Too soon')
  expect(smtp.sent).toHaveLength(0)
  await solo.keyboard.press('Escape') // closed with words in it: kept in Drafts, and the window goes
  await expect.poll(() => app.windows().length).toBe(1)
  await expect.poll(() => page.evaluate(async () => (await window.mail.drafts()).map((d) => [d.subject, d.state]))).toEqual([['Too soon', 'draft']])
})

test('Edit Menu: the sidebar\'s entries are hidden, moved by button and by dragging, and it lasts', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'One' }), { arrived: earlier(5) })
  await signIn(run)
  const side = page.locator('.sidebar')
  const names = async (group: number): Promise<string[]> =>
    (await side.locator('.nav-group').nth(group).locator('.nav-item .grow').allInnerTexts()).map((name) => name.trim())
  const folders = side.getByRole('list', { name: 'Folders' })
  const assistant = side.getByRole('list', { name: 'Assistant' })

  await side.getByRole('button', { name: 'Today', exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Mark all as read' })).toBeVisible() // a place keeps its own entry
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await expect(side.getByRole('button', { name: 'Compose' })).toHaveCount(0)
  await expect(folders.getByRole('listitem')).toHaveText(['Today', 'Unread', 'Flagged', 'Pinned', 'Summary', 'Snoozed', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Sent', 'Recently Seen'])
  await expect(folders.getByRole('button', { name: 'Move Today up' })).toBeDisabled()
  await expect(folders.getByRole('button', { name: 'Move Recently Seen down' })).toBeDisabled()
  await folders.getByLabel('Show Snoozed').uncheck()
  await folders.getByRole('button', { name: 'Move Pinned up' }).click()
  await folders.getByRole('button', { name: 'Move Today down' }).click()
  await folders.getByRole('listitem').filter({ hasText: 'Sent' }).dragTo(folders.getByRole('listitem').filter({ hasText: 'Unread' }))
  await expect(folders.getByRole('listitem')).toHaveText(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Snoozed', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  await assistant.getByLabel('Show Events').uncheck()
  await assistant.getByRole('listitem').filter({ hasText: 'Packages' }).dragTo(folders.getByRole('listitem').filter({ hasText: 'Trash' })) // not into the other list
  await expect(assistant.getByRole('listitem')).toHaveText(['Subscriptions', 'Travel', 'Packages', 'Bills & Receipts', 'Events'])
  await side.getByRole('button', { name: 'Done' }).click()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  expect(await names(3)).toEqual(['Subscriptions', 'Travel', 'Packages', 'Bills & Receipts'])
  await side.getByRole('button', { name: 'Pinned', exact: true }).click() // and they still go where they went
  await expect(page.locator('.view-title')).toHaveText('Pinned')

  // Called off, by the button or by Esc, nothing changes. Away from any entry the menu has the one thing.
  await side.locator('.sidebar-foot .status').click({ button: 'right' })
  await expect(page.getByRole('menuitem')).toHaveText(['Edit Menu'])
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await expect(folders.getByLabel('Show Snoozed')).not.toBeChecked()
  await folders.getByLabel('Show Unread').uncheck()
  await side.getByRole('button', { name: 'Cancel' }).click()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  await side.getByRole('button', { name: 'Drafts', exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem')).toHaveText(['Edit Menu'])
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await folders.getByLabel('Show Unread').uncheck()
  await page.keyboard.press('Escape')
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])

  // Settings leads to the same place, and what was hidden comes back where it was put.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Edit Menu' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await folders.getByLabel('Show Snoozed').check()
  await side.getByRole('button', { name: 'Done' }).click()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Snoozed', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  const saved = await page.evaluate(async () => (await window.mail.settings()).sidebar)
  expect(saved.hidden).toEqual(['events'])
  expect(saved.order.slice(0, 5)).toEqual(['sent', 'unread', 'today', 'pinned', 'starred'])
  await page.reload()
  await expect(side.getByRole('button', { name: 'Sent', exact: true })).toBeVisible()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Snoozed', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  expect(await names(3)).toEqual(['Subscriptions', 'Travel', 'Packages', 'Bills & Receipts'])
})

test('muting a sender from the reader, and the muted senders in Settings', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Chatter', from: 'Ada Lovelace <ada@example.com>' }), { arrived: earlier(5) })
  await signIn(run)
  await page.locator('.threads').getByText('Chatter').click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Mute notifications', exact: true }).click()
  await expect(page.getByText('Mail from ada@example.com won\'t be announced')).toBeVisible()
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Unmute notifications' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByPlaceholder('Search settings').fill('mute')
  await expect(settings.getByRole('navigation').getByRole('button')).toHaveText(['Notifications'])
  await settings.getByRole('button', { name: 'Notifications' }).click()
  await expect(settings.getByRole('button', { name: 'Unmute ada@example.com' })).toBeVisible()
  await settings.getByLabel('Sender to mute').fill('@Shop.example')
  await settings.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Unmute @shop.example' })).toBeVisible()
  await settings.getByRole('button', { name: 'Unmute ada@example.com' }).click()
  await expect(settings.getByRole('button', { name: 'Unmute ada@example.com' })).toHaveCount(0)
  await settings.getByRole('button', { name: 'Unmute @shop.example' }).click()
  await expect(settings.getByText('Nobody is muted.')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Mute notifications', exact: true })).toBeVisible()
})

test('pinning a thread from the reader, a row\'s menu and by dragging, and Pinned in the sidebar', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Lease', 'Lunch', 'Ledger'].entries()) gmail.add(rawMail({ subject, text: "Details inside." }), { arrived: earlier(5 - i) })
  await signIn(run)
  const threads = page.locator('.threads')
  const row = (subject: string): ReturnType<typeof threads.locator> => threads.locator('.thread', { hasText: subject })
  const side = (name: string | RegExp): ReturnType<typeof page.getByRole> => page.locator('.sidebar').getByRole('button', { name, exact: true })
  await threads.getByText('Lease').click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Pin thread' }).click()
  await expect(row('Lease').getByLabel('Pinned')).toBeVisible() // marked where it is: it doesn't move
  await expect(threads.locator('.subject')).toHaveText(['Ledger', 'Lunch', 'Lease'])
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Unpin thread' })).toBeVisible()
  await page.keyboard.press('Escape')
  await threads.getByText('Lunch').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await threads.getByText('Ledger').dragTo(side('Pinned'))
  await expect(threads.getByLabel('Pinned')).toHaveCount(3)
  await side('Pinned').click()
  await expect(page.locator('.view-title')).toHaveText('Pinned')
  await expect(threads.locator('.subject')).toHaveText(['Ledger', 'Lunch', 'Lease'])
  await threads.getByText('Lunch').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unpin' }).click()
  await expect(threads.locator('.subject')).toHaveText(['Ledger', 'Lease'])
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(threads.locator('.subject')).toHaveText(['Ledger', 'Lunch', 'Lease'])
  await threads.getByText('Lease').click()
  await page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Archive' }).click() // archived mail stays pinned
  await expect(threads.locator('.subject')).toHaveText(['Ledger', 'Lunch', 'Lease'])
  await threads.getByText('Lease').click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Unpin thread' }).click()
  await expect(threads.locator('.subject')).toHaveText(['Ledger', 'Lunch'])
  await side(/^Inbox/).click()
  await expect(row('Ledger').getByLabel('Pinned')).toBeVisible()
  await expect(threads.getByText('Lease')).toHaveCount(0)
  expect(gmail.mails.some((m) => m.flags.includes('\\Flagged'))).toBe(false) // a pin is not a flag
})

test('Recently Seen lists the threads opened, the last first, keeps still while read, and its menu clears it', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Alpha', 'Bravo', 'Charlie'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const side = page.locator('.sidebar')
  const reading = page.locator('.thread-subject')
  const rows = list.locator('.thread .subject')
  for (const subject of ['Alpha', 'Charlie', 'Bravo']) {
    await list.getByText(subject).click()
    await expect(reading).toHaveText(subject)
  }
  await page.keyboard.press('e') // archived, and the reader moves on to Alpha, which is seen again
  await expect(page.getByText('Archived')).toBeVisible()
  await expect(reading).toHaveText('Alpha')
  await side.getByRole('button', { name: 'Recently Seen', exact: true }).click()
  await expect(page.locator('.view-title')).toHaveText('Recently Seen')
  await expect(rows).toHaveText(['Alpha', 'Bravo', 'Charlie']) // Bravo is archived, and still here
  // Read from here, a thread keeps its place, so j goes on down the list.
  await list.getByText('Bravo').click()
  await expect(reading).toHaveText('Bravo')
  await page.keyboard.press('j')
  await expect(reading).toHaveText('Charlie')
  await expect(rows).toHaveText(['Alpha', 'Bravo', 'Charlie'])
  await page.keyboard.press('U')
  await expect(list.locator('.thread', { hasText: 'Charlie' }).locator('.unread-dot')).toBeVisible()
  await page.reload()
  await side.getByRole('button', { name: 'Recently Seen', exact: true }).click()
  await expect(rows).toHaveText(['Alpha', 'Bravo', 'Charlie'])

  await side.getByRole('button', { name: 'Recently Seen', exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem')).toHaveText(['Mark all as read', 'Clear Recently Seen', 'Edit Menu'])
  await page.getByRole('menuitem', { name: 'Clear Recently Seen' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByText('Nothing seen yet')).toBeVisible()
  await expect(rows).toHaveCount(0)
  await side.getByRole('button', { name: /^Inbox/ }).click()
  await list.getByText('Charlie').click()
  await expect(reading).toHaveText('Charlie')
  await side.getByRole('button', { name: 'Recently Seen', exact: true }).click()
  await expect(rows).toHaveText(['Charlie'])
})

test('a thread\'s files show as cards under its row, and Appearance can take them away', async () => {
  run = await launch()
  const { page, gmail } = run
  const file = (name: string): { name: string; type: string; body: string } => ({ name, type: 'application/octet-stream', body: 'x' })
  gmail.add(rawMail({ subject: 'Papers', attachment: file('report.pdf'), attachments: [file('sums.xlsx'), file('photo.png'), file('notes.txt')] }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Bare' }), { arrived: earlier(4) })
  await signIn(run)
  const row = page.locator('.threads .thread', { hasText: 'Papers' })
  await expect(row.locator('.card')).toHaveText(['report.pdf', 'sums.xlsx', 'photo.png', '+1'])
  await expect(page.locator('.threads .thread', { hasText: 'Bare' }).locator('.cards')).toHaveCount(0)
  const [cards, words] = [await row.locator('.cards').boundingBox(), await row.locator('.snippet').boundingBox()]
  expect(cards?.y ?? 0).toBeGreaterThanOrEqual((words?.y ?? 0) + (words?.height ?? 0)) // under the preview
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByLabel('Show a thread\'s files as cards under its row').uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(row.locator('.cards')).toHaveCount(0)
  await expect(row.getByLabel('Has attachment: report.pdf and 3 more')).toBeVisible()
})

test('an attachment name cannot turn itself around to show a false type', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Holiday', attachment: { name: 'photo\u202Egpj.exe', type: 'application/octet-stream', body: 'MZ' } }), { arrived: earlier(5) })
  await signIn(run)
  const row = page.locator('.threads .thread', { hasText: 'Holiday' })
  await expect(row.getByLabel('Has attachment: photogpj.exe')).toBeVisible()
  await expect(row.locator('.card-name')).toHaveText(['photogpj.exe']) // the card under the row tells the same truth
  await row.click()
  await expect(page.getByRole('list', { name: 'Attachments' }).locator('.file-name')).toHaveText(['photogpj.exe'])
  await expect(page.getByRole('button', { name: 'Save photogpj.exe' })).toBeVisible()
  await page.keyboard.press('f') // forwarding takes the file into a draft
  await expect(composer(page).locator('.file-name')).toHaveText(['photogpj.exe'], LONG)
})

test('a file only enters a draft as bytes: the page cannot name a path', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await undoOff(page)
  const sent = await page.evaluate(async () => {
    const draft = await window.mail.startDraft({ kind: 'new', to: 'ada@example.com', subject: 'With a file' })
    const added = await window.mail.addFile(draft.id, '../../../etc/passwd', 'text/plain', new TextEncoder().encode('dropped').buffer)
    await window.mail.send(draft.id)
    return added.files[0]?.name
  })
  expect(sent).toBe('passwd')
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toContain(Buffer.from('dropped').toString('base64'))
})

// The first went onto the draft and the composer only listed files after a success, so it would
// have gone out without being seen.
test('picking files: one too many is refused, and what did go on is listed', async () => {
  run = await launch()
  const { page, app } = run
  await signIn(run)
  const folder = join(run.savedTo, '..')
  const small = join(folder, 'notes.txt')
  const big = join(folder, 'disk.iso')
  writeFileSync(small, 'notes')
  writeFileSync(big, '')
  truncateSync(big, 20 * 1024 * 1024)
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog
  }, [small, big])
  await page.getByRole('button', { name: 'Compose' }).click()
  const box = composer(page)
  await box.getByRole('button', { name: 'Attach files' }).click()
  await expect(box.getByText('18 MB')).toBeVisible()
  await expect(box.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible()
  await expect(box.locator('.file-name')).toHaveText(['notes.txt'])
})

// A selection dragged out of a web page or a message carries its HTML, and the editor took it as it
// was, though it holds only what is typed here and a paste comes in as text.
test('what is dropped into the message comes in as plain text', async () => {
  run = await launch()
  const { page, app } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Compose' }).click()
  const editor = composer(page).getByLabel('Message')
  const place = await editor.boundingBox()
  const cdp = await app.context().newCDPSession(page)
  const data = {
    items: [{ mimeType: 'text/html', data: '<b>Bold</b> <a href="https://tracker.example/">words</a>' }, { mimeType: 'text/plain', data: 'Bold words' }],
    dragOperationsMask: 1
  }
  const drag = async (dragged: typeof data | { items: never[]; files: string[]; dragOperationsMask: number }): Promise<void> => {
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x: (place?.x ?? 0) + 20, y: (place?.y ?? 0) + 8, data: dragged })
    }
  }
  await drag(data)
  await expect(editor).toHaveText('Bold words')
  expect(await editor.innerHTML()).not.toMatch(/<b|<a/)
  const file = join(run.savedTo, '..', 'plan.txt')
  writeFileSync(file, 'plan')
  await drag({ items: [], files: [file], dragOperationsMask: 1 }) // files dropped there are still attached
  await expect(composer(page).locator('.file-name')).toHaveText(['plan.txt'])
  await expect(editor).toHaveText('Bold words')
})

test('unsubscribing with one click opens nothing', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Weekly deals', headers: ['List-Unsubscribe: <https://list.example.com/u/1>'] }), { arrived: earlier(5) })
  await signIn(run)
  await page.getByRole('button', { name: /^Other/ }).click()
  await page.getByText('Weekly deals').click()
  await page.getByRole('button', { name: 'Unsubscribe' }).click()
  await expect.poll(run.opened).toEqual(['https://list.example.com/u/1'])
})

test('a mail link opens here for reading, sends nothing, and shows what it asked for', async () => {
  run = await launch()
  const { page, gmail, smtp } = run
  gmail.add(rawMail({ subject: 'Linked', html: '<a id="m" href="mailto:help@example.com?subject=Hi&bcc=watcher@example.com&body=Say%20this">write</a>' }), { arrived: earlier(5) })
  await signIn(run)
  await page.getByText('Linked').first().click()
  await page.frameLocator('iframe.body-frame').locator('#m').click()
  const box = composer(page)
  await expect(box.getByRole('button', { name: 'Remove help@example.com' })).toBeVisible()
  await expect(box.getByRole('button', { name: 'Remove watcher@example.com' })).toBeVisible() // never hidden away
  await expect(box.getByLabel('Message')).toHaveText('Say this')
  expect(await run.opened()).toEqual([])
  expect(smtp.received).toBe(0)
})

test('a message Gmail still has as a draft stays out of the thread', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Talk', text: 'Their words' }), { arrived: earlier(5), thread: 44n })
  gmail.add(rawMail({ subject: 'Re: Talk', text: 'Half written', from: `Me <${ME}>` }), { arrived: earlier(4), thread: 44n, labels: ['\\Draft'] })
  await signIn(run)
  await page.getByText('Talk').first().click()
  await expect(page.locator('.messages').getByText('Their words')).toBeVisible()
  await expect(page.locator('.message')).toHaveCount(1)
})

test('held mail stays out of the composer too', async () => {
  run = await launch()
  const { page, gmail } = run
  await signIn(run)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  gmail.add(rawMail({ subject: 'Secret', from: 'Quinn Hidden <quinn@example.com>' }))
  await page.getByRole('button', { name: /^Sync/ }).click()
  await expect(page.getByText('1 waiting')).toBeVisible(LONG)
  expect(await page.evaluate(() => window.mail.contacts('quinn'))).toEqual([])
})

test('settings keep who you are, and it signs what you send', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await undoOff(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Accounts' }).click()
  await page.getByLabel('Your name').fill('Sơn Nguyễn')
  await page.getByRole('button', { name: 'Signatures' }).click() // straight on, while the name is still being saved
  await page.getByLabel('Signature').fill('Sent from xrnmail')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => page.evaluate((me) => window.mail.settings().then((s) => s.identities[me]), ME))
    .toMatchObject({ name: 'Sơn Nguyễn', signature: 'Sent from xrnmail' })
  await page.keyboard.press('c')
  const box = composer(page)
  await expect(box.getByText('Sent from xrnmail')).toBeVisible()
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Message').fill('Hello')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toContain('Sent from xrnmail')
  expect(smtp.sent[0]?.from).toBe(ME)
})

test('a thread can be right-clicked, dragged to the sidebar and swiped away', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const subject of ['Menu me', 'Drag me', 'Swipe me', 'Swipe further']) gmail.add(rawMail({ subject }), { arrived: earlier(5) })
  await signIn(run)
  const threads = page.locator('.threads')
  await threads.getByText('Menu me').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(threads.getByText('Menu me')).toHaveCount(0)
  await threads.getByText('Drag me').dragTo(page.getByRole('button', { name: 'Trash', exact: true }))
  await expect(threads.getByText('Drag me')).toHaveCount(0)
  await threads.getByText('Swipe me').hover()
  await page.mouse.wheel(100, 0) // a short way to the left
  await expect(threads.getByText('Swipe me')).toHaveCount(0)
  await expect(page.getByText('Archived')).toBeVisible()
  await threads.getByText('Swipe further').hover()
  await page.mouse.wheel(-200, 0) // a long way to the right
  await expect(threads.getByText('Swipe further')).toHaveCount(0)
  await expect(page.getByText('Moved to Trash')).toBeVisible()
})

test('addresses become chips, and one still being typed goes too', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await undoOff(page)
  await page.keyboard.press('c')
  const box = composer(page)
  const to = box.getByLabel('To')
  await to.pressSequentially('ada@example.com,')
  await expect(box.getByRole('button', { name: 'Remove ada@example.com' })).toBeVisible()
  await expect(to).toHaveValue('')
  await to.fill('"Tran, Mai" <mai@example.com>')
  await to.press('Enter')
  await expect(box.getByText('Tran, Mai')).toBeVisible()
  await to.pressSequentially('nobody')
  await to.press('Enter')
  await box.getByRole('button', { name: 'Remove nobody' }).click()
  await to.pressSequentially('zed@example.com')
  await box.getByLabel('Subject').click()
  await box.getByLabel('Subject').fill('Chips')
  await box.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => smtp.sent[0]?.to.slice().sort()).toEqual(['ada@example.com', 'mai@example.com', 'zed@example.com'])
})

test('settings come in Edison\'s sections, and what they choose for the list takes hold', async () => {
  run = await launch()
  const { page, gmail } = run
  const long = 'First words of a message that goes on for a good while, long enough that one line of the list could never hold all of it.'
  gmail.add(rawMail({ subject: 'Row', text: long }), { arrived: earlier(2) })
  await signIn(run)
  const settings = page.getByRole('button', { name: 'Settings' })
  await settings.click()
  await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('button')).toHaveText([
    'General', 'Notifications', 'Accounts', 'Appearance', 'Customize Actions', 'Shortcuts', 'Signatures', 'Templates', 'Summary',
    'Blocked Senders', 'Batches', 'xrnhub', 'About'
  ])
  await page.getByRole('button', { name: 'Appearance' }).click()
  await expect(page.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible()
  await page.getByLabel('Preview lines').selectOption('1')
  await page.getByLabel('Show icons in the sidebar').uncheck()
  await page.getByLabel('Use the 24-hour clock').uncheck()
  await page.getByRole('button', { name: 'Customize Actions' }).click()
  await page.getByLabel('Action 1').selectOption('snooze')
  await page.getByLabel('Action 4').selectOption('none')
  await page.getByRole('button', { name: 'Blocked Senders' }).click()
  await page.getByLabel('Sender to block').fill('Pest@Example.com')
  await page.getByRole('button', { name: 'Block', exact: true }).click()
  await page.getByRole('button', { name: 'Unblock pest@example.com' }).click()
  await expect(page.getByText('Nobody is blocked.')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()

  const row = page.locator('.threads .thread', { hasText: 'Row' })
  const lineHeight = await row.locator('.snippet').evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  expect((await row.locator('.snippet').boundingBox())?.height).toBe(lineHeight)
  await expect(page.locator('.sidebar .nav-icon').first()).toBeHidden()
  await row.hover()
  const labels = (): Promise<(string | null)[]> => row.locator('.row-actions button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
  expect(await labels()).toEqual(['Snooze', 'Flag', 'Delete'])
  await page.getByText('Row').click()
  await expect(page.locator('.message.open .when')).toHaveText(/\d (AM|PM)$/)

  await settings.click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByLabel('Preview lines').selectOption('0')
  await page.getByRole('button', { name: 'Customize Actions' }).click()
  await page.getByLabel('Show quick actions when the pointer is over a thread in the list').uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(row.locator('.snippet')).toBeHidden()
  await row.hover()
  await expect(row.locator('.row-actions')).toHaveCount(0)
  await expect(row.locator('time')).toBeVisible()
})

test('settings can be searched', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Search settings').fill('swipe')
  await expect(page.getByRole('heading', { name: 'Customize Actions' })).toBeVisible()
  await expect(page.getByLabel('Swipe left, short')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Batches' })).toHaveCount(0)
})
