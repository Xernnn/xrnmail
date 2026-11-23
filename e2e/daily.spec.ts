import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rawMail } from '../tests/fake-gmail'
import { jar, pdf, png } from '../tests/files'
import { later, launch, ME, signIn, type Running } from './app'

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

// With Undo send off, the toast said "Sent" as soon as the message was queued, and a send that then
// failed said nothing: the only sign was a count by Drafts.
test('a message is "Sent" only once it has gone, and a send that fails says so and stays in Drafts', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await undoOff(page)
  const toast = page.getByRole('status')
  const write = async (subject: string): Promise<void> => {
    await page.keyboard.press('c')
    const box = composer(page)
    await box.getByLabel('To').fill('ada@example.com')
    await box.getByLabel('Subject').fill(subject)
    await box.getByLabel('Message').click()
    await page.keyboard.type('Plain words')
    await page.keyboard.press('Control+Enter')
    await expect(box).toHaveCount(0)
  }
  smtp.dropAfterData = true
  await write('Cut off')
  await expect(toast).toHaveText('Sending')
  await expect(toast).toHaveText('Sending failed', LONG)
  await expect(page.locator('.sidebar').getByRole('alert')).toHaveText('Sending failed. See Drafts.')
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await expect(page.locator('.thread.problem')).toContainText('This may not have been sent')

  smtp.dropAfterData = false
  await write('Goes through')
  await expect(toast).toHaveText('Sent', LONG)
  expect(smtp.sent.map((m) => m.raw.includes('Subject: Goes through'))).toEqual([true])
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
  expect(await fields()).toEqual(['To', 'Cc', 'Bcc', 'Reply-To', 'From', 'Subject'])
  const tools = await box.getByRole('toolbar', { name: 'Formatting' }).getByRole('button').evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')))
  expect(tools).toEqual(['Bold', 'Italic', 'Underline', 'Strikethrough', 'Clear formatting', 'Add link', 'Quote', 'Numbered list', 'List'])
  const send = box.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)') // words and a paper plane, not a filled button
  const [sendBox, barBox] = [await send.boundingBox(), await box.getByRole('toolbar', { name: 'Formatting' }).boundingBox()]
  expect(sendBox?.y ?? 0).toBeGreaterThan((barBox?.y ?? 0) + (barBox?.height ?? 0) - 1)
  await box.getByLabel('To', { exact: true }).fill('ada@example.com')
  await box.getByLabel('Reply-To').fill('team@example.org')
  await box.getByLabel('Subject').fill('Formatted')
  await box.getByLabel('Message').click()
  await page.keyboard.type('struck')
  await page.keyboard.press('Control+A')
  await box.getByRole('button', { name: 'Strikethrough' }).click()
  await send.click()
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toMatch(/<(s|strike)>struck<\/(s|strike)>/)
  expect(smtp.sent[0]?.raw).toContain('Reply-To: team@example.org')
})

test('a template brings its words, and its subject to a message that has none yet', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Templates' }).click()
  await page.getByLabel('Name').fill('Thanks')
  await page.getByLabel('Subject').fill('Thank you')
  await page.getByLabel('Text').fill('Thanks so much!')
  await page.getByRole('button', { name: 'Add template' }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('c')
  const box = composer(page)
  await box.getByRole('button', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Thanks', exact: true }).click()
  await expect(box.getByLabel('Subject')).toHaveValue('Thank you')
  await expect(box.getByLabel('Message')).toHaveText('Thanks so much!')
  await box.getByLabel('Subject').fill('Already one')
  await box.getByRole('button', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Thanks', exact: true }).click()
  await expect(box.getByLabel('Subject')).toHaveValue('Already one')
})

test('Send & Archive: the thread leaves the inbox as the reply goes, and Undo brings both back', async () => {
  run = await launch()
  const { page, gmail, smtp } = run
  gmail.add(rawMail({ subject: 'Lunch plans', from: 'Ada <ada@example.com>' }), { arrived: earlier(5) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ keyChanges: { edison: { sendArchive: 'Ctrl+Shift+E' } } }))
  const threads = page.locator('.threads')
  await threads.getByText('Lunch plans').click()
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click()
  let box = composer(page)
  await box.getByLabel('Message').fill('Yes please')
  await expect(box.getByRole('button', { name: 'Send & Archive' })).toHaveAttribute('title', 'Send & Archive (Ctrl+Shift+E)')
  await box.getByRole('button', { name: 'Send & Archive' }).click()
  await expect(box).toHaveCount(0)
  await expect(threads.getByText('Lunch plans')).toHaveCount(0)
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  box = composer(page)
  await expect(box.getByLabel('Message')).toHaveText('Yes please')
  await expect(threads.getByText('Lunch plans')).toBeVisible()
  await box.getByLabel('Message').click()
  await page.keyboard.press('Control+Shift+E')
  await expect(box).toHaveCount(0)
  await expect(threads.getByText('Lunch plans')).toHaveCount(0)
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toContain('Yes please')
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(threads.getByText('Lunch plans')).toBeVisible()
  // A new message answers no thread, so there's nothing to archive.
  await page.keyboard.press('c')
  await expect(composer(page).getByRole('button', { name: 'Send & Archive' })).toHaveCount(0)
})

test('remind if no reply: a sent thread waits under Reminders, and comes back to the inbox unread and marked', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Any news?', from: `Me <${ME}>`, to: 'ada@example.com' }), { arrived: earlier(5), labels: ['\\Sent'], flags: ['\\Seen'] })
  await signIn(run)
  const threads = page.locator('.threads')
  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await threads.getByText('Any news?').click()
  await page.getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('button', { name: 'Remind if no reply' }).click()
  await page.getByRole('button', { name: /^Tomorrow/ }).click()
  await expect(page.getByRole('status')).toContainText('Reminder')
  await expect(page.locator('.thread-head .remind-tag')).toBeVisible()
  await page.getByRole('button', { name: 'Reminders', exact: true }).click()
  await expect(threads.locator('.thread')).toHaveCount(1)
  await expect(threads.locator('time.back')).toBeVisible()
  await page.getByRole('button', { name: /^Inbox/ }).first().click()
  await expect(threads.getByText('Any news?')).toHaveCount(0)
  await later(run, 2 * 86_400_000)
  await expect(threads.getByText('Any news?')).toBeVisible(LONG)
  const row = threads.locator('.thread', { hasText: 'Any news?' })
  await expect(row).toHaveClass(/unread/)
  await expect(row.getByLabel('No reply')).toBeVisible()
  await row.getByText('Any news?').click()
  await expect(row).not.toHaveClass(/unread/)
  await expect(page.locator('.thread-head .remind-tag')).toContainText('No reply')
  await page.getByRole('button', { name: 'Cancel reminder' }).click()
  await expect(page.locator('.thread-head .remind-tag')).toHaveCount(0)
  await expect(threads.getByText('Any news?')).toHaveCount(0)
})

test('remind if no reply, chosen as a message is written, is kept with the draft', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.keyboard.press('c')
  let box = composer(page)
  await box.getByLabel('Subject').fill('Quote please')
  const bell = box.getByRole('button', { name: 'Remind if no reply' })
  await bell.click()
  await page.getByRole('button', { name: /^Next week/ }).click()
  await expect(bell).toHaveClass(/\bon\b/)
  await box.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await page.getByText('Quote please').click()
  box = composer(page)
  await expect(box.getByRole('button', { name: 'Remind if no reply' })).toHaveClass(/\bon\b/)
  await box.getByRole('button', { name: 'Remind if no reply' }).click()
  await page.getByRole('button', { name: 'No reminder' }).click()
  await expect(box.getByRole('button', { name: 'Remind if no reply' })).not.toHaveClass(/\bon\b/)
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

// Discard draft, in the composer and on a row in Drafts, took the draft and its copy in Gmail's
// Drafts away at once, with no Undo and not a word.
test('a draft thrown away can be had back with Undo, from the composer and from Drafts', async () => {
  run = await launch()
  const { page, gmail } = run
  await signIn(run)
  const toast = page.getByRole('status')
  await page.keyboard.press('c')
  const box = composer(page)
  await box.getByLabel('Subject').fill('Half finished')
  await box.getByLabel('Message').fill('Some words')
  await box.getByRole('button', { name: 'Discard draft' }).click()
  await expect(box).toHaveCount(0)
  await expect(toast).toContainText('Draft discarded')
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Half finished')
  await expect(composer(page).getByLabel('Message')).toHaveText('Some words')
  await composer(page).getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => gmail.drafts().length, LONG).toBe(1) // up in Gmail's Drafts

  await page.getByRole('button', { name: /^Drafts/ }).click()
  const list = page.locator('.threads')
  await list.locator('.thread', { hasText: 'Half finished' }).hover()
  await page.getByRole('button', { name: 'Discard Half finished' }).click()
  await expect(list.getByText('Half finished')).toHaveCount(0)
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(list.getByText('Half finished')).toBeVisible()
  await expect(composer(page)).toHaveCount(0)

  await list.locator('.thread', { hasText: 'Half finished' }).hover()
  await page.getByRole('button', { name: 'Discard Half finished' }).click()
  await expect(list.getByText('Half finished')).toHaveCount(0)
  await page.waitForTimeout(3000)
  expect(gmail.drafts()).toHaveLength(1) // Undo still has it
  await expect.poll(() => gmail.drafts().length, LONG).toBe(0)
  await page.reload()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await expect(page.getByText('Nothing here')).toBeVisible()
})

test('drafts are kept in Gmail\'s Drafts: one written here goes up, one written on the phone comes in, and either goes when it is sent', async () => {
  run = await launch()
  const { page, gmail, smtp } = run
  await signIn(run)
  await undoOff(page)
  const subjects = (): string[] => gmail.drafts().map((raw) => /^Subject: (.*)$/m.exec(raw)?.[1]?.trim() ?? '')
  await page.keyboard.press('c')
  const box = composer(page)
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Subject').fill('Half finished')
  await box.getByLabel('Message').fill('Some words')
  await box.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText('Saved to Drafts')).toBeVisible()
  await expect.poll(subjects, LONG).toEqual(['Half finished'])
  expect(gmail.drafts()[0]).toContain('Some words')

  // Written on the phone: it's in Drafts here after the next sync, and goes from here.
  gmail.draft(rawMail({ from: ME, to: 'Bo <bo@example.com>', subject: 'From the phone', text: 'Count me in.\n\nOn Mon, Bo wrote:\n> Friday?' }), { arrived: earlier(1) })
  await page.getByRole('button', { name: /^Sync/ }).click()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await page.getByText('From the phone').click()
  await expect(composer(page).getByLabel('Message')).toHaveText('Count me in.')
  await expect(composer(page).getByRole('button', { name: 'Remove bo@example.com' })).toBeVisible()
  await composer(page).getByLabel('Message').pressSequentially(' See you.')
  await composer(page).getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toContain('Count me in. See you.')
  expect(smtp.sent[0]?.raw).toContain('> Friday?')
  await expect.poll(subjects, LONG).toEqual(['Half finished'])

  // Thrown away here, it's gone from there too.
  await page.getByText('Half finished').click()
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()
  await expect.poll(subjects, LONG).toEqual([])
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

// A reply or a forward starts with a subject, someone to send to and what it quotes, so closing one
// untouched counted as closing something written, and every Reply pressed by mistake left a draft.
test('a reply or forward closed untouched leaves nothing behind, and a draft opened again stays', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plans', from: 'Mai Tran <mai@example.com>', text: 'Friday?' }), { arrived: earlier(2) })
  await signIn(run)
  await page.locator('.threads').getByText('Plans').click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Re: Plans')
  await page.waitForTimeout(900) // past the composer's own save
  await composer(page).getByRole('button', { name: 'Close' }).click()
  await expect(composer(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Fwd: Plans')
  await page.keyboard.press('Escape')
  await expect(composer(page)).toHaveCount(0)
  await expect(page.getByText('Saved to Drafts')).toHaveCount(0)
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await expect(page.getByText('Nothing here')).toBeVisible()

  // Written in, it's kept; and opened again from Drafts and closed as it was, it stays.
  await page.getByRole('button', { name: /^Inbox/ }).first().click()
  await page.locator('.threads').getByText('Plans').click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await composer(page).getByLabel('Message').fill('Friday works.')
  await composer(page).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText('Saved to Drafts')).toBeVisible()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await page.locator('.threads').getByText('Re: Plans').click()
  await expect(composer(page).getByLabel('Message')).toHaveText('Friday works.')
  await composer(page).getByRole('button', { name: 'Close' }).click()
  await expect(composer(page)).toHaveCount(0)
  await expect(page.locator('.threads').getByText('Re: Plans')).toBeVisible()
})

// A second Reply put its composer in place of the first without closing it, so a reply nobody had
// written in stayed in Drafts as "Re: Trip to Da Lat", and nothing said so.
test('a second reply closes the first as Close would: kept if written in, gone if not', async () => {
  run = await launch({ size: [1600, 1000] }) // room for the thread beside the composer
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Files for you', from: 'Bao Le <bao@example.com>' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Trip to Da Lat', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(4) })
  await signIn(run)
  const list = page.locator('.threads')
  const reply = async (subject: string): Promise<void> => {
    await list.getByText(subject).click()
    await expect(page.locator('.thread-subject')).toHaveText(subject)
    // The one at the top of the message, which the docked composer doesn't cover.
    await page.locator('.message.open').getByRole('button', { name: 'Reply to this' }).click()
    await expect(composer(page).getByLabel('Subject')).toHaveValue(`Re: ${subject}`)
  }
  await reply('Trip to Da Lat')
  await page.waitForTimeout(900) // past the composer's own save
  await reply('Files for you')
  await expect(composer(page)).toHaveCount(1)
  await expect(page.getByText('Saved to Drafts')).toHaveCount(0)
  await composer(page).getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await expect(page.getByText('Nothing here')).toBeVisible()

  await page.getByRole('button', { name: /^Inbox/ }).first().click()
  await reply('Trip to Da Lat')
  await composer(page).getByLabel('Message').fill('See you there.')
  await reply('Files for you')
  await expect(page.getByText('Saved to Drafts')).toBeVisible()
  await composer(page).getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Re: Trip to Da Lat'])
  await list.getByText('Re: Trip to Da Lat').click()
  await expect(composer(page).getByLabel('Message')).toHaveText('See you there.')
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
  await expect(page.getByRole('status')).toHaveText(/^Archived/)
  await page.keyboard.press('z')
  await expect(list.getByText('Newest')).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 1000 }) // undone, the toast and its Undo go at once
  await page.keyboard.press('#')
  await expect(list.getByText('Middle')).toHaveCount(0)
  await expect.poll(() => gmail.moved.length, LONG).toBe(1)
  expect(gmail.mails.find((m) => m.raw.toString().includes('Newest'))?.labels).toContain('\\Inbox')
})

test('Settings choose what opens once a thread is archived or deleted: the next, the one before, or the list', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['First', 'Second', 'Third', 'Fourth', 'Fifth'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(9 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const reading = page.locator('.thread-subject')
  await page.getByRole('button', { name: 'Settings' }).click()
  const choice = page.getByLabel('When a thread is archived or deleted')
  await expect(choice).toHaveValue('next') // Edison's own choice, and what xrnmail always did
  await choice.selectOption('previous')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  await list.getByText('Third').click()
  await expect(reading).toHaveText('Third')
  await page.keyboard.press('e')
  await expect(list.getByText('Third')).toHaveCount(0)
  await expect(reading).toHaveText('Fourth') // the one above it, newer
  await page.evaluate(() => window.mail.saveProfile({ afterRemove: 'list' }))
  await page.waitForTimeout(400)
  await page.keyboard.press('#')
  await expect(list.getByText('Fourth')).toHaveCount(0)
  await expect(reading).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByLabel('When a thread is archived or deleted')).toHaveValue('list')
})

test('Settings choose how long Undo stays after archiving or deleting, and the change waits as long for it', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Keep me' }), { arrived: earlier(3) })
  await signIn(run)
  const list = page.locator('.threads')
  const inInbox = (subject: string): boolean | undefined => gmail.mails.find((m) => m.raw.toString().includes(subject))?.labels.includes('\\Inbox')
  await page.getByRole('button', { name: 'Settings' }).click()
  const choice = page.getByLabel('Undo archive and delete for')
  await expect(choice).toHaveValue('5') // as Edison's pictures have it, and as it always was here
  await choice.selectOption('10')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  await list.getByText('Keep me').click()
  await page.keyboard.press('e')
  const undo = page.getByRole('status').getByRole('button', { name: 'Undo' })
  await expect(undo).toBeVisible()
  await page.waitForTimeout(7000) // past the five seconds it had, and the one more the server waited
  await expect(undo).toBeVisible()
  expect(inInbox('Keep me')).toBe(true)
  await undo.click()
  await expect(list.getByText('Keep me')).toBeVisible()
  await page.waitForTimeout(4000)
  expect(inInbox('Keep me')).toBe(true)
  expect(gmail.writes().filter((c) => /X-GM-LABELS|MOVE/.test(c))).toEqual([])
})

// Marking the open thread unread used to move the reader on to the next one, as archiving does, and
// opening that one read it: one thread marked unread, another read without being looked at.
test('marking the open thread unread closes it, and reads nothing else', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Oldest', 'Middle', 'Newest'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const dot = (subject: string): ReturnType<Page['locator']> => list.locator('.thread', { hasText: subject }).locator('.unread-dot')
  await list.getByText('Middle').click()
  await expect(page.locator('.thread-subject')).toHaveText('Middle')
  await expect(dot('Middle')).toHaveCount(0)
  await page.keyboard.press('U')
  await expect(dot('Middle')).toBeVisible()
  await expect(page.locator('.thread-subject')).toHaveCount(0)
  await page.waitForTimeout(600) // what the reader would have read meanwhile
  await expect(dot('Oldest')).toBeVisible()
  await expect(dot('Newest')).toBeVisible()
  // And from the button over the thread.
  await list.getByText('Newest').click()
  await expect(dot('Newest')).toHaveCount(0)
  await page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Mark unread' }).click()
  await expect(dot('Newest')).toBeVisible()
  await expect(page.locator('.thread-subject')).toHaveCount(0)
  await page.waitForTimeout(600)
  await expect(dot('Middle')).toBeVisible()
  await expect.poll(() => gmail.mails.filter((m) => m.flags.includes('\\Seen')).length, LONG).toBe(0)
})

// The tooltips over a thread and on Compose named Edison's letters whatever the set: "Archive (e)"
// with Apple Mail's keys, where e does nothing, and after the key had been changed.
test('tooltips name the keys of the set in use, as changed in Settings', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plans' }), { arrived: earlier(5) })
  await signIn(run)
  await page.locator('.threads').getByText('Plans').click()
  const tools = page.getByRole('toolbar', { name: 'Thread', exact: true })
  const title = (name: string): Promise<string | null> => tools.getByRole('button', { name, exact: true }).getAttribute('title')
  const reply = page.locator('.reply-bar').getByRole('button', { name: 'Reply' })
  const compose = page.locator('.sidebar').getByRole('button', { name: 'Compose' })
  expect([await title('Archive'), await title('Snooze'), await reply.getAttribute('title'), await compose.getAttribute('title')])
    .toEqual(['Archive (e)', 'Snooze (b)', 'Reply (r)', 'New message (c)'])
  await page.evaluate(() => window.mail.saveProfile({ keys: 'apple' }))
  await expect.poll(() => title('Archive')).toBe('Archive (Ctrl+Alt+A)')
  expect([await title('Delete'), await title('Snooze'), await reply.getAttribute('title'), await compose.getAttribute('title')])
    .toEqual(['Delete (Backspace)', 'Snooze', 'Reply (Ctrl+R)', 'New message (Ctrl+N)'])
  await page.evaluate(() => window.mail.saveProfile({ keyChanges: { apple: { archive: 'y' } } }))
  await expect.poll(() => title('Archive')).toBe('Archive (y)')
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
  await expect(page.getByRole('group', { name: 'Remove from view' }).getByText('None')).toBeVisible()
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

test('keys of your own choosing: changed in Settings, taken over from another action, reset, and the Apple Mail, Outlook and Inbox sets', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['First', 'Second', 'Third', 'Fourth', 'Fifth'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(8 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const row = (subject: string): ReturnType<Page['locator']> => list.locator('.thread', { hasText: subject })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const shortcut = (what: string): ReturnType<Page['locator']> => settings.getByRole('group', { name: what, exact: true })
  const openShortcuts = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('button', { name: 'Shortcuts' }).click()
  }
  // The window hears of a changed setting a moment after it's saved. Its own list of keys says when.
  const knows = async (what: string, keys: string): Promise<void> => {
    await page.keyboard.press('?')
    await expect(page.locator('.keys > div').filter({ has: page.getByText(what, { exact: true }) }).locator('kbd')).toHaveText(keys)
    await page.getByRole('button', { name: 'Done' }).click()
  }
  await openShortcuts()
  await settings.getByLabel('Shortcut set').selectOption('apple')
  await expect(shortcut('Archive').locator('kbd')).toHaveText(['Ctrl+Alt+A'])
  await expect(shortcut('Mark read or unread').locator('kbd')).toHaveText(['Ctrl+Shift+U'])
  await expect(shortcut('New message').getByText('None')).toBeVisible() // Command-N is the menu's, listed at the foot
  await settings.getByRole('button', { name: 'Done' }).click()
  await knows('Mark read or unread', 'Ctrl+Shift+U')
  await list.getByText('Fifth').click()
  await page.keyboard.press('e') // Apple Mail has no letters of its own
  await page.keyboard.press('Control+Alt+a')
  await expect(page.getByText('Archived')).toBeVisible()
  await expect(row('Fifth')).toHaveCount(0)
  await expect(row('Fourth')).toBeVisible() // e archived nothing, or the reader would have moved on to Fourth for this

  await openShortcuts()
  await shortcut('Archive').getByRole('button', { name: 'Change the key for Archive' }).click()
  await expect(shortcut('Archive')).toContainText('Press the new key')
  await page.keyboard.press('g')
  await expect(shortcut('Archive').locator('kbd')).toHaveText(['g'])
  await shortcut('Flag').getByRole('button', { name: 'Change the key for Flag' }).click()
  await page.keyboard.press('Control+r')
  await expect(shortcut('Flag')).toContainText("Ctrl+R is Reply's.")
  await shortcut('Flag').getByRole('button', { name: 'Use it here' }).click()
  await expect(shortcut('Flag').locator('kbd')).toHaveText(['Ctrl+R'])
  await expect(shortcut('Reply').getByText('None')).toBeVisible()
  await shortcut('Delete').getByRole('button', { name: 'Change the key for Delete' }).click()
  await page.keyboard.press('Control+n')
  await expect(shortcut('Delete')).toContainText('Ctrl+N is for New Message in the menu.')
  await page.keyboard.press('Escape') // calls off the choosing, and leaves Settings open
  await expect(shortcut('Delete').locator('kbd')).toHaveText(['Backspace', 'Del'])
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Done' }).click()
  await knows('Flag', 'Ctrl+R')
  await list.getByText('Fourth').click()
  await page.keyboard.press('Control+r')
  await expect(row('Fourth').getByLabel('Flagged')).toBeVisible()
  await page.keyboard.press('g')
  await expect(row('Fourth')).toHaveCount(0)
  expect((await page.evaluate(() => window.mail.settings())).keyChanges).toEqual({ apple: { archive: 'g', flag: 'Ctrl+R' } })

  await openShortcuts()
  await shortcut('Archive').getByRole('button', { name: 'Reset Archive to the Apple Mail set' }).click()
  await expect(shortcut('Archive').locator('kbd')).toHaveText(['Ctrl+Alt+A'])
  await settings.getByRole('button', { name: 'Reset all to the Apple Mail set' }).click()
  await expect(shortcut('Reply').locator('kbd')).toHaveText(['Ctrl+R'])
  await settings.getByLabel('Shortcut set').selectOption('outlook')
  await expect(shortcut('Forward').locator('kbd')).toHaveText(['Ctrl+J'])
  await settings.getByRole('button', { name: 'Done' }).click()
  await knows('Forward', 'Ctrl+J')
  await list.getByText('Third').click()
  await page.keyboard.press('Control+e')
  await expect(row('Third')).toHaveCount(0)
  await openShortcuts()
  await settings.getByLabel('Shortcut set').selectOption('inbox')
  await expect(shortcut('Archive').locator('kbd')).toHaveText(['e', 'y', '[', ']'])
  await settings.getByRole('button', { name: 'Done' }).click()
  await knows('Pin', 'Shift+P')
  await list.getByText('Second').click()
  await page.keyboard.press('y') // Done
  await expect(row('Second')).toHaveCount(0)
  await list.getByText('First').click()
  await page.keyboard.press('Shift+P')
  await expect(row('First').getByLabel('Pinned')).toBeVisible()
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

test('the reading pane can sit under the list, as tall as it is dragged to, and stays so', async () => {
  run = await launch({ size: [1280, 840] })
  const { page, gmail } = run
  for (const [i, subject] of ['Alpha', 'Bravo', 'Charlie'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  const box = async (selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
    const found = await page.locator(selector).first().boundingBox()
    if (!found) throw new Error(`${selector} isn't on screen`)
    return found
  }
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Layout').selectOption('below')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.threads').getByText('Bravo').click()
  await expect(page.locator('.thread-subject')).toHaveText('Bravo')
  await expect.poll(async () => Math.round((await box('.reader')).x)).toBe(Math.round((await box('section.list')).x))
  const [list, handle, reader] = [await box('section.list'), await box('.resize'), await box('.reader')]
  expect(Math.round(list.x)).toBe(Math.round(reader.x)) // one over the other, as wide
  expect(Math.round(list.width)).toBe(Math.round(reader.width))
  expect(handle.y).toBeGreaterThanOrEqual(list.y + list.height - 1)
  expect(reader.y).toBeGreaterThanOrEqual(handle.y + handle.height - 1)
  expect(handle.width).toBeGreaterThan(handle.height)
  // Dragged down, the list grows by as much.
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100, { steps: 5 })
  await page.mouse.up()
  const taller = await box('section.list')
  expect(Math.round(taller.height - list.height)).toBe(100)
  await page.reload()
  await page.locator('.threads').getByText('Bravo').click()
  await expect(page.locator('.thread-subject')).toHaveText('Bravo')
  expect(Math.round((await box('section.list')).height)).toBe(Math.round(taller.height))
  expect(Math.round((await box('.reader')).x)).toBe(Math.round(list.x))
  // And back beside it, at the width it had.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Layout').selectOption('panes')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(async () => (await box('.reader')).x).toBeGreaterThan(list.x + 300)
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
  expect(await names(2)).toEqual(['Today', 'Unread', 'Flagged', 'Pinned', 'Summary', 'Snoozed', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Sent', 'Recently Seen'])
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

// A message folded shut showed its raw text: links in brackets, headings in capitals, what it quoted.
test('a message folded shut in a thread previews what it says, as the list does', async () => {
  run = await launch()
  const { page, gmail } = run
  const first = 'WEEKLY PLAN\n\nSee the plan [https://plans.example/q3] before Friday.\n\nOn Mon, Linh Pham wrote:\n> Can you send the plan?'
  gmail.add(rawMail({ subject: 'Plan', from: 'Mai Tran <mai@example.com>', text: first }), { arrived: earlier(5), thread: 66n, flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Re: Plan', from: 'Linh Pham <linh@example.com>', text: 'Looks good.' }), { arrived: earlier(4), thread: 66n })
  await signIn(run)
  await page.locator('.threads').getByText(/Plan$/).first().click()
  const shut = page.locator('.message-head.closed')
  await expect(shut).toHaveCount(1)
  await expect(shut).toContainText('See the plan before Friday.')
  await expect(shut).not.toContainText('https://')
  await expect(shut).not.toContainText('Can you send the plan?')
})

// A message from a past year said "Fri, Jan 31, 07:39" over it, while the list said "Jan 31, 2025".
test('the date over a message says its year when it is not this one', async () => {
  run = await launch()
  const { page, gmail } = run
  const lastYear = new Date().getFullYear() - 1
  const old = new Date(lastYear, 11, 30, 7, 39)
  gmail.add(rawMail({ subject: 'Year end', from: 'Mai Tran <mai@example.com>', date: old }), { arrived: old })
  gmail.add(rawMail({ subject: 'This week', from: 'Linh Pham <linh@example.com>' }), { arrived: earlier(2) })
  await page.evaluate(() => window.mail.saveBackfill(1095)) // kept for three years, so last year's is here
  await signIn(run)
  const list = page.locator('.threads')
  await list.getByText('Year end').click()
  await expect(page.locator('.message.open .when')).toContainText(String(lastYear))
  await list.getByText('This week').click()
  await expect(page.locator('.message.open .when')).not.toContainText(String(lastYear + 1))
})

test('an invitation that is over offers no answer, and a bounce offers no Block', async () => {
  run = await launch()
  const { page, gmail } = run
  const stamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const ics = (start: number, uid: string): string => [
    'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${uid}@cal.example`, 'SEQUENCE:0', `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3_600_000)}`,
    `SUMMARY:${uid}`, 'ORGANIZER;CN=Mai Tran:mailto:mai@example.com', `ATTENDEE;RSVP=TRUE:mailto:${ME}`, 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n')
  const invite = (subject: string, start: number, arrived: number): void =>
    void gmail.add(rawMail({ subject, from: 'Mai Tran <mai@example.com>', attachment: { name: 'invite.ics', type: 'text/calendar', body: ics(start, subject.split(' ')[0] ?? 'x') } }), { arrived: earlier(arrived) })
  invite('Retro last week', Date.now() - 6 * 86_400_000, 200)
  invite('Planning next week', Date.now() + 6 * 86_400_000, 2)
  gmail.add(rawMail({ subject: 'Undelivered Mail Returned to Sender', from: 'Mail Delivery System <MAILER-DAEMON@mail.example.com>', text: 'Your message could not be delivered.' }), { arrived: earlier(1) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: false })) // a bounce would be under Other
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  const list = page.locator('.threads')
  const message = page.locator('.message.open')
  await list.getByText('Planning next week').click()
  await expect(message.getByRole('button', { name: 'Accept' })).toBeVisible()
  await list.getByText('Retro last week').click()
  await expect(page.locator('.thread-subject')).toHaveText('Retro last week')
  await expect(message.locator('.fact')).toBeVisible() // still shown for what it is
  await expect(message.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  await expect(message.getByRole('button', { name: 'Decline' })).toHaveCount(0)
  await list.getByText('Undelivered Mail Returned to Sender').click()
  await expect(page.locator('.thread-subject')).toHaveText('Undelivered Mail Returned to Sender')
  await expect(message.getByText('Your message could not be delivered.')).toBeVisible()
  await expect(message.getByRole('button', { name: 'Block' })).toHaveCount(0)
  await page.getByRole('toolbar', { name: 'Thread', exact: true }).getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.locator('.popover').getByRole('button', { name: 'Print' })).toBeVisible()
  await expect(page.locator('.popover').getByRole('button', { name: 'Block sender' })).toHaveCount(0)
})

// A blue Block pill sat beside Reply on every personal thread, the most prominent button on a
// friend's mail; Block sender is under More with the other things to do about a sender.
test('the reader: actions over the thread, Unsubscribe by a list\'s sender, Block under More, and Reply and Forward at the foot', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plain', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'To several', from: 'Mai Tran <mai@example.com>', to: `${ME}, Linh Pham <linh@example.com>` }), { arrived: earlier(4) })
  gmail.add(rawMail({ subject: 'Offers', from: 'Shop <hi@shop.example>', headers: ['List-Unsubscribe: <mailto:leave@shop.example>'] }), { arrived: earlier(3) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: true }))
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
  await expect(page.locator('.thread-subject')).toHaveText('Plain')
  await expect(message.getByRole('button', { name: 'Reply to this' })).toBeVisible()
  await expect(message.getByRole('button', { name: 'Block' })).toHaveCount(0) // not beside Reply
  await tools.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Block sender' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click()
  await expect(page.getByText('Blocked mai@example.com')).toBeVisible()
  await expect(page.locator('.threads').getByText('Plain')).toHaveCount(0)
})

// Mail in Spam offered Unsubscribe, over the message and in its details: one click told a spammer
// the address is read, by their one-click address or their page.
test('nothing in Spam or Trash offers Unsubscribe', async () => {
  run = await launch()
  const { page, gmail } = run
  const list = 'List-Unsubscribe: <https://shop.example/leave>'
  gmail.add(rawMail({ subject: 'Offers', from: 'Shop <hi@shop.example>', headers: [list, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'You won', from: 'Prize <win@prize.example>', headers: [list, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] }), { box: '[Gmail]/Spam', arrived: earlier(3) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: false }))
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  const message = page.locator('.message.open')
  await page.locator('.threads').getByText('Offers').click()
  await expect(message.getByRole('button', { name: 'Unsubscribe' })).toBeVisible() // as ever, outside the bins
  await page.getByRole('button', { name: /^Spam/ }).click()
  await page.locator('.threads').getByText('You won').click()
  await expect(page.locator('.thread-subject')).toHaveText('You won')
  await expect(message.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0)
  await message.locator('.who-to').click()
  const details = page.getByRole('dialog', { name: 'Message details' })
  await expect(details).toContainText('Mailing list')
  await expect(details.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0)
  expect(await run.opened()).toEqual([])
})

// Over a thread, only the account's own address was left out of who could be blocked or let
// straight through, so mail sent from one of its aliases offered both.
test('mail from one of your own addresses offers no Block sender and no Let straight through', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Note to self', from: `Me <me+shop@example.com>`, to: ME }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'From Mai', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(4) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ identities: { 'me@example.com': { name: 'Me', signature: '', aliases: ['me+shop@example.com'], color: '', notify: true } } }))
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  const tools = page.getByRole('toolbar', { name: 'Thread', exact: true })
  const more = page.locator('.popover')
  await page.locator('.threads').getByText('From Mai').click()
  await tools.getByRole('button', { name: 'More', exact: true }).click()
  await expect(more.getByRole('button', { name: 'Block sender' })).toBeVisible() // someone else's mail, as ever
  await expect(more.getByRole('button', { name: 'Let this sender straight through' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.threads').getByText('Note to self').click()
  await expect(page.locator('.thread-subject')).toHaveText('Note to self')
  await tools.getByRole('button', { name: 'More', exact: true }).click()
  await expect(more.getByRole('button', { name: 'Print' })).toBeVisible()
  await expect(more.getByRole('button', { name: 'Block sender' })).toHaveCount(0)
  await expect(more.getByRole('button', { name: 'Let this sender straight through' })).toHaveCount(0)
})

// Block sender sent what was ticked in the list to Trash, whoever it was from, and left the open
// thread from the sender just blocked where it was.
test('blocking the sender of the open thread sends that thread to Trash, not the ones ticked', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Files for you', from: 'Bao Le <bao@example.com>' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Trip to Da Lat', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(4) })
  await signIn(run)
  const list = page.locator('.threads')
  await page.getByLabel('Select Files for you').check({ force: true })
  await list.getByText('Trip to Da Lat').click()
  await expect(page.locator('.thread-subject')).toHaveText('Trip to Da Lat')
  await page.getByRole('toolbar', { name: 'Thread', exact: true }).getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Block sender' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click()
  await expect(page.getByText('Blocked mai@example.com')).toBeVisible()
  await expect(list.getByText('Trip to Da Lat')).toHaveCount(0)
  await expect(list.getByText('Files for you')).toBeVisible()
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Trip to Da Lat'])
})

test('Settings choose what the reply button on a message does: reply, or reply to everyone on it', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plain', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'To several', from: 'Mai Tran <mai@example.com>', to: `${ME}, Linh Pham <linh@example.com>` }), { arrived: earlier(4) })
  await signIn(run)
  const message = page.locator('.message.open')
  await page.locator('.threads').getByText('To several').click()
  await message.getByRole('button', { name: 'Reply to this' }).click()
  await expect(composer(page).getByRole('button', { name: 'Remove mai@example.com' })).toBeVisible()
  await expect(composer(page).getByRole('button', { name: 'Remove linh@example.com' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Settings' }).click()
  const choice = page.getByLabel('Default reply')
  await expect(choice).toHaveValue('reply')
  await choice.selectOption('replyAll')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  await message.getByRole('button', { name: 'Reply all to this' }).click()
  await expect(composer(page).getByRole('button', { name: 'Remove mai@example.com' })).toBeVisible()
  await expect(composer(page).getByRole('button', { name: 'Remove linh@example.com' })).toBeVisible()
  await page.keyboard.press('Escape')
  // With no one else on it, there's only the sender to answer.
  await page.locator('.threads').getByText('Plain').click()
  await expect(message.getByRole('button', { name: 'Reply to this' })).toBeVisible()
  await expect(page.locator('.reply-bar').getByRole('button')).toHaveText(['Reply', 'Forward']) // the foot keeps both, as it was
})

test('Settings choose whether a reply quotes the message it answers; a forward always carries it', async () => {
  run = await launch()
  const { page, gmail, smtp } = run
  gmail.add(rawMail({ subject: 'Lunch', from: 'Mai Tran <mai@example.com>', to: `${ME}, Linh Pham <linh@example.com>`, text: 'Pho or bun cha?' }), { arrived: earlier(4) })
  await signIn(run)
  await undoOff(page)
  const bar = page.locator('.reply-bar')
  await page.locator('.threads').getByText('Lunch').click()
  await bar.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(composer(page).getByRole('button', { name: 'Quoted message' })).toBeVisible() // as it always was
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()

  await page.getByRole('button', { name: 'Settings' }).click()
  const quoting = page.getByLabel('Quote the original message in a reply')
  await expect(quoting).toBeChecked()
  await quoting.uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  await bar.getByRole('button', { name: 'Reply All' }).click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Re: Lunch')
  await expect(composer(page).getByRole('button', { name: 'Quoted message' })).toHaveCount(0)
  await composer(page).getByLabel('Message').fill('Bun cha, at noon.')
  await composer(page).getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  expect(smtp.sent[0]?.raw).toContain('Bun cha, at noon.')
  expect(smtp.sent[0]?.raw).not.toContain('Pho or bun cha?')
  await bar.getByRole('button', { name: 'Forward' }).click()
  await expect(composer(page).getByRole('button', { name: 'Forwarded message' })).toBeVisible()
})

test('nothing to type into under a thread: replying starts at the buttons at its foot', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Mai Tran <mai@example.com>', text: 'Are you free at noon?' }), { arrived: earlier(2) })
  await signIn(run)
  await page.locator('.threads').getByText('Lunch?').click()
  await page.locator('.messages').getByText('Are you free at noon?').waitFor()
  const reader = page.locator('.reader')
  await expect(reader.getByRole('textbox')).toHaveCount(0)
  await expect(reader.getByPlaceholder(/^Reply to/)).toHaveCount(0)
  await expect(reader.getByRole('button', { name: 'Thanks!' })).toHaveCount(0)
  await expect(reader.getByRole('button', { name: 'Expand reply' })).toHaveCount(0)
  await expect(page.locator('.reply-bar').getByRole('button')).toHaveText(['Reply', 'Forward'])
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply' }).click()
  await expect(composer(page).getByLabel('Subject')).toHaveValue('Re: Lunch?')
})

test('the details under "To: me": who, when, where, what the receiving server found, and what to do with each address', async () => {
  run = await launch()
  const { page, gmail, app } = run
  const top = [
    'Delivered-To: me@example.com',
    'Received: from mail.shop.example (mail.shop.example [192.0.2.1]) by mx.google.com with ESMTPS id 1 (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384)',
    'Authentication-Results: mx.google.com; dkim=pass header.i=@shop.example; spf=pass smtp.mailfrom=bounce@mail.shop.example; dmarc=pass header.from=shop.example'
  ].join('\n')
  const headers = ['Cc: Linh Pham <linh@example.com>', 'Reply-To: Help <help@shop.example>', 'List-Id: "Shop News" <news.shop.example>', 'List-Unsubscribe: <mailto:leave@shop.example>']
  gmail.add(`${top}\n${rawMail({ subject: 'Spring sale', from: 'Shop <news@shop.example>', date: earlier(2), headers })}`, { arrived: earlier(2) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: false }))
  await page.locator('.threads').getByText('Spring sale').click()
  const toggle = page.locator('.message.open').getByRole('button', { name: /^To:/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const panel = page.getByRole('dialog', { name: 'Message details' })
  await expect(panel).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await panel.locator('dt').allTextContents()).toEqual([
    'From', 'Reply to', 'To', 'Cc', 'Date', 'Mailbox', 'Mailed by', 'Signed by', 'Security', 'Checks', 'Mailing list', 'Written to'
  ])
  for (const words of [
    'Shop <news@shop.example>', 'Help <help@shop.example>', 'me@example.com (you)', 'Linh Pham <linh@example.com>', 'me@example.com · Inbox',
    'mail.shop.example', 'Reached your mail service over TLS 1.3', 'SPF pass', 'DKIM pass', 'DMARC pass', 'by mx.google.com',
    'Shop News news.shop.example', "You haven't written to this sender"
  ]) await expect(panel).toContainText(words)
  await expect(panel.getByRole('button', { name: 'Unsubscribe' })).toBeVisible()
  // All of it shows: nothing around it cuts it off.
  const [shown, reader] = [await panel.boundingBox(), await page.locator('.reader').boundingBox()]
  expect(shown?.width ?? 0).toBeGreaterThan(400)
  expect(await panel.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, box.bottom - 8)?.closest('.details-panel') === el
  })).toBe(true)
  expect((shown?.x ?? 0) + (shown?.width ?? 0)).toBeLessThanOrEqual((reader?.x ?? 0) + (reader?.width ?? 0))

  // Escape closes it and gives the button the focus back; the keyboard opens it again.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await expect(page.locator('.thread-subject')).toHaveText('Spring sale') // the thread stays open
  await page.keyboard.press('Enter')
  await expect(panel).toBeVisible()

  // Each address has its actions. Escape closes an address's menu before the panel.
  await panel.getByRole('button', { name: 'Actions for linh@example.com' }).click()
  const menu = panel.getByRole('menu', { name: 'Actions for linh@example.com' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Copy address', 'New message', 'Find mail from them', 'Mute notifications', 'Let straight through'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Actions for linh@example.com' }).click()
  await menu.getByRole('menuitem', { name: 'Copy address' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('linh@example.com')
  await expect(page.getByText('Copied linh@example.com')).toBeVisible()
  await panel.getByRole('button', { name: 'Actions for news@shop.example' }).click()
  await expect(panel.getByRole('menuitem', { name: 'Block sender' })).toBeVisible()

  // A click elsewhere closes it.
  await page.locator('.thread-subject').click()
  await expect(panel).toHaveCount(0)
  await toggle.click()
  await panel.getByRole('button', { name: 'Actions for help@shop.example' }).click()
  await panel.getByRole('menuitem', { name: 'New message' }).click()
  await expect(composer(page).getByRole('button', { name: 'Remove help@shop.example' })).toBeVisible()
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()
  await toggle.click()
  await panel.getByRole('button', { name: 'Actions for news@shop.example' }).click()
  await panel.getByRole('menuitem', { name: 'Find mail from them' }).click()
  await expect(page.getByLabel('Search')).toHaveValue('from:news@shop.example')
  await expect(page.locator('.threads').getByText('Spring sale')).toBeVisible()
  // Opening the thread read it; nothing else was asked of the server that would change anything.
  expect(gmail.writes().filter((c) => !c.startsWith('SELECT') && !/\\Seen/.test(c))).toEqual([])
})

test('the details stay inside the reader on a short window, scrolling inside themselves', async () => {
  run = await launch({ size: [1180, 480] })
  const { page, gmail } = run
  const headers = ['Cc: Linh Pham <linh@example.com>', 'Reply-To: Help <help@shop.example>', 'List-Id: "Shop News" <news.shop.example>', 'List-Unsubscribe: <mailto:leave@shop.example>']
  // Everything the panel can say, so it's taller than what a short window shows of the thread.
  const top = [
    'Delivered-To: me+shop@example.com',
    'Received: from mail.shop.example (mail.shop.example [192.0.2.1]) by mx.google.com with ESMTPS id 1 (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384)',
    'Authentication-Results: mx.google.com; dkim=pass header.i=@shop.example; spf=pass smtp.mailfrom=bounce@mail.shop.example; dmarc=pass header.from=shop.example'
  ].join('\n')
  const thread = 7_100_000_000_000_000_000n
  for (let i = 1; i <= 6; i++) {
    const from = 'Shop support@bank.example <news@shop.example>'
    gmail.add(`${top}\n${rawMail({ subject: 'Plans', from, text: `Message ${i}`, date: earlier(30 - i), headers })}`, { arrived: earlier(10 - i), thread, flags: ['\\Seen'] })
  }
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: false }))
  await page.locator('.threads').getByText('Plans').click()
  const open = page.locator('.message.open').last()
  await expect(open).toContainText('Message 6')
  await open.getByRole('button', { name: /^To:/ }).click()
  const panel = page.getByRole('dialog', { name: 'Message details' })
  await expect(panel).toContainText('Written to')
  const inside = async (): Promise<{ top: number; bottom: number; visibleTop: number; visibleBottom: number; scrolls: boolean }> =>
    panel.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const seen = (el.closest('.messages') as HTMLElement).getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, visibleTop: seen.top, visibleBottom: Math.min(seen.bottom, window.innerHeight), scrolls: el.scrollHeight > el.clientHeight }
    })
  await expect.poll(async () => { const at = await inside(); return at.bottom <= at.visibleBottom }).toBe(true)
  const at = await inside()
  expect(at.top).toBeGreaterThanOrEqual(at.visibleTop)
  if (at.scrolls) {
    // What doesn't fit is in reach by scrolling the panel, not the window.
    await panel.evaluate((el) => { el.scrollTop = el.scrollHeight })
    const last = await panel.locator('dd').last().boundingBox()
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(at.bottom + 1)
  }
})

test('a stranger\'s very long name and address wrap, in the warning and the details, and never push the thread sideways', async () => {
  run = await launch({ size: [1180, 760] })
  const { page, gmail } = run
  const name = 'Bartholomew-Maximilian Wolfeschlegelsteinhausenbergerdorff the Extraordinarily Long-Named'
  const address = `${'x'.repeat(70)}.long@${'sub.'.repeat(12)}example.com`
  const replies = `${'r'.repeat(90)}@example.org`
  gmail.add(rawMail({ subject: 'Long', from: `"${name}" <${address}>`, headers: [`Reply-To: ${replies}`] }), { arrived: earlier(1) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: false }))
  await page.locator('.threads .subject', { hasText: 'Long' }).click()
  await expect(page.getByRole('alert').filter({ hasText: replies })).toBeVisible()
  const sideways = (): Promise<number> => page.locator('.messages').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(await sideways()).toBe(0) // the warning naming the Reply-To used to run off to the right
  await page.locator('.message.open').getByRole('button', { name: /^To:/ }).click()
  const panel = page.getByRole('dialog', { name: 'Message details' })
  await expect(panel).toContainText(replies)
  expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
  expect(await sideways()).toBe(0)
})

test('Settings choose when an open thread is marked read: at once, after a while, or only when asked', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const subject of ['Alpha', 'Bravo', 'Charlie']) gmail.add(rawMail({ subject }), { arrived: earlier(5) })
  await signIn(run)
  const list = page.locator('.threads')
  const dot = (subject: string): ReturnType<Page['locator']> => list.locator('.thread', { hasText: subject }).locator('.unread-dot')
  await page.getByRole('button', { name: 'Settings' }).click()
  const choice = page.getByLabel('Mark a thread read')
  await expect(choice).toHaveValue('0') // at once, as before
  await choice.selectOption('2')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  // Passed through on the way to another, a thread stays unread.
  await list.getByText('Alpha').click()
  await expect(page.locator('.thread-subject')).toHaveText('Alpha')
  await page.waitForTimeout(500)
  await list.getByText('Bravo').click()
  await expect(page.locator('.thread-subject')).toHaveText('Bravo')
  await expect(dot('Bravo')).toBeVisible()
  await expect(dot('Bravo')).toHaveCount(0, LONG) // read once it has been open two seconds
  await expect(dot('Alpha')).toBeVisible()

  await page.evaluate(() => window.mail.saveProfile({ readAfter: -1 }))
  await page.waitForTimeout(400)
  await list.getByText('Charlie').click()
  await expect(page.locator('.thread-subject')).toHaveText('Charlie')
  await page.waitForTimeout(2500)
  await expect(dot('Charlie')).toBeVisible()
  await page.keyboard.press('Shift+I') // read when asked
  await expect(dot('Charlie')).toHaveCount(0)
  expect(gmail.mails.filter((m) => m.flags.includes('\\Seen')).length).toBeLessThanOrEqual(2)
  await expect.poll(() => gmail.mails.filter((m) => m.raw.toString().includes('Alpha') && m.flags.includes('\\Seen')).length, LONG).toBe(0)

  // And by the button over the thread, which says Mark read while it's unread. It only said Mark
  // unread, which on a thread not yet read closed it and did nothing else.
  const tools = page.getByRole('toolbar', { name: 'Thread', exact: true })
  await list.getByText('Alpha').click()
  await expect(page.locator('.thread-subject')).toHaveText('Alpha')
  await expect(tools.getByRole('button', { name: 'Mark unread' })).toHaveCount(0)
  await tools.getByRole('button', { name: 'Mark read' }).click()
  await expect(dot('Alpha')).toHaveCount(0)
  await expect(page.locator('.thread-subject')).toHaveText('Alpha')
  await expect(tools.getByRole('button', { name: 'Mark unread' })).toBeVisible()
})

test('Settings can show a thread newest first: the newest on top and open, what is folded under it, and Reply still answers the newest', async () => {
  run = await launch()
  const { page, gmail } = run
  const people = ['Mai Tran <mai@example.com>', 'Linh Pham <linh@example.com>', 'Bao Le <bao@example.com>']
  const said = ['Can we meet Monday?', 'Monday is full for me.', 'Tuesday then?', 'Tuesday works.', 'Ten or eleven?', 'Eleven, see you there.']
  for (const [i, text] of said.entries()) {
    gmail.add(rawMail({ subject: i === 0 ? 'Meeting' : 'Re: Meeting', from: people[i % 3], text }), { arrived: earlier(10 - i), thread: 55n, flags: i < 4 ? ['\\Seen'] : [] })
  }
  // A thread taller than the reader, to be scrolled down before the other is opened.
  gmail.add(rawMail({ subject: 'Long notes', from: people[0], text: Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the notes.`).join('\n') }), { arrived: earlier(12) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ readAfter: -1 })) // what's unread stays so, however often it's opened
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  const list = page.locator('.threads')
  const messages = page.locator('.messages')
  /** The messages from the top down, each by which of [said] it is, and where the fold is. */
  const order = (): Promise<string[]> => page.locator('.messages .message-slot').evaluateAll((slots, words) => slots.flatMap((slot) => {
    const text = slot.querySelector('.message')?.textContent ?? ''
    return [...(slot.querySelector('.fold') ? ['fold'] : []), String(words.findIndex((w) => text.includes(w)))]
  }), said)
  await list.getByText(/^(Re: )?Meeting$/).click()
  await expect.poll(order).toEqual(['0', 'fold', '4', '5']) // oldest first, as it always was
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Settings' }).click()
  const choice = page.getByLabel('Messages in a thread')
  await expect(choice).toHaveValue('oldest')
  await choice.selectOption('newest')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved

  await list.getByText('Long notes').click()
  await expect(page.locator('.body-text')).toContainText('Line 120')
  await messages.evaluate((box) => { box.scrollTop = box.scrollHeight })
  expect(await messages.evaluate((box) => box.scrollTop)).toBeGreaterThan(0)
  await list.getByText(/^(Re: )?Meeting$/).click()
  await expect.poll(order).toEqual(['5', '4', 'fold', '0'])
  // What's unread is open, the newest at the top where the reading starts.
  await expect(page.locator('.message.open')).toHaveCount(2)
  await expect(page.locator('.message.open').first()).toContainText(said[5] as string)
  expect(await messages.evaluate((box) => box.scrollTop)).toBe(0)
  await page.locator('.fold').click()
  await expect.poll(order).toEqual(['5', '4', '3', '2', '1', '0'])
  // Reply, at the foot and by its key, answers the newest, wherever it's shown.
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(composer(page).getByRole('button', { name: 'Remove bao@example.com' })).toBeVisible()
  await composer(page).getByRole('button', { name: 'Discard draft' }).click()
  await expect(composer(page)).toHaveCount(0)
  await page.keyboard.press('r')
  await expect(composer(page).getByRole('button', { name: 'Remove bao@example.com' })).toBeVisible()
})

// Opening a thread reads it, so in Unread it left the list the moment it opened: nothing in the list
// was marked as open, and j, which goes on from the open thread, started again at the top.
test('in Unread the open thread keeps its place while it is read, and j goes on to the one below', async () => {
  run = await launch()
  const { page, gmail } = run
  for (let i = 0; i < 5; i++) gmail.add(rawMail({ subject: `Note ${i}` }), { arrived: earlier(10 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const rows = list.locator('.thread .subject')
  await page.getByRole('button', { name: 'Unread', exact: true }).click()
  await expect(rows).toHaveText(['Note 4', 'Note 3', 'Note 2', 'Note 1', 'Note 0'])
  await list.getByText('Note 2').click()
  await expect(page.locator('.thread-subject')).toHaveText('Note 2')
  await page.waitForTimeout(600) // the list is read again once the thread has been
  await expect(rows).toHaveText(['Note 4', 'Note 3', 'Note 2', 'Note 1', 'Note 0'])
  await expect(list.locator('.thread.on')).toContainText('Note 2')
  await expect(list.locator('.thread', { hasText: 'Note 2' }).locator('.unread-dot')).toHaveCount(0)
  await page.keyboard.press('j')
  await expect(page.locator('.thread-subject')).toHaveText('Note 1')
  await page.waitForTimeout(600)
  await expect(rows).toHaveText(['Note 4', 'Note 3', 'Note 1', 'Note 0']) // read and let go of, it has gone
  await page.keyboard.press('j')
  await expect(page.locator('.thread-subject')).toHaveText('Note 0')
})

test('Today in the sidebar counts what came today and is unread', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Days ago' }), { arrived: earlier(72) })
  gmail.add(rawMail({ subject: 'Just now' }), { arrived: new Date() })
  gmail.add(rawMail({ subject: 'Also now' }), { arrived: new Date() })
  await signIn(run)
  const today = page.locator('.sidebar').getByRole('button', { name: /^Today/ })
  await expect(today.locator('.nav-count')).toHaveText('2')
  await page.locator('.threads').getByText('Just now').click()
  await expect(today.locator('.nav-count')).toHaveText('1')
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

// The main process took at most 1000 threads in one go, and Mark all as read and Empty Trash send a
// whole list: with more than that, each was refused with "Bad request" and nothing happened.
test('Mark all as read and Empty Trash work on more than a thousand threads', async () => {
  test.setTimeout(180_000)
  run = await launch()
  const { page, gmail } = run
  for (let i = 0; i < 1001; i++) gmail.add(rawMail({ subject: `Notice ${i}` }), { arrived: earlier(30) })
  for (let i = 0; i < 1001; i++) gmail.add(rawMail({ subject: `Old ${i}` }), { box: '[Gmail]/Trash', arrived: earlier(30) })
  await signIn(run)
  const syncing = page.locator('.sync-progress')
  await expect(page.locator('.threads .thread').first()).toBeVisible({ timeout: 60_000 })
  await expect(syncing).toHaveCount(0, { timeout: 60_000 })
  await page.locator('.sidebar').getByRole('button', { name: /^Inbox/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click()
  await expect(page.getByText('Marked as read: 1001 threads')).toBeVisible()
  await expect(page.locator('.threads .unread-dot')).toHaveCount(0)
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByRole('button', { name: 'Empty Trash now' }).click()
  await expect(page.getByRole('dialog')).toContainText('1001 threads')
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash' }).click()
  await expect(page.getByText('Trash emptied: 1001 threads')).toBeVisible()
  await expect(page.getByText('Nothing here')).toBeVisible()
  await expect.poll(() => gmail.mails.filter((m) => m.flags.includes('\\Seen')).length, { timeout: 30_000 }).toBe(1001)
  await expect.poll(() => gmail.box('[Gmail]/Trash').mails.length, { timeout: 30_000 }).toBe(0)
})

// These toasts offered Undo for changes that had gone to Gmail at once, so pressing it a moment
// later did nothing: the toast went, and the mail stayed read, labelled or in the inbox.
test('Undo calls back Mark all as read, a label and Move to Inbox, as it does archiving', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Old invoice' }), { box: '[Gmail]/Trash', arrived: earlier(6) })
  gmail.add(rawMail({ subject: 'Alpha' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Beta' }), { arrived: earlier(4), labels: ['\\Inbox', 'Receipts'] })
  await signIn(run)
  const list = page.locator('.threads')
  const toast = page.getByRole('status').filter({ hasText: 'Undo' })
  const mail = (subject: string): ReturnType<typeof gmail.mails.find> =>
    [...gmail.mails, ...gmail.box('[Gmail]/Trash').mails].find((m) => m.raw.toString().includes(subject))
  await expect(list.locator('.unread-dot')).toHaveCount(2)
  await page.locator('.sidebar').getByRole('button', { name: /^Inbox/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click()
  await expect(toast).toContainText('Marked as read: 2 threads')
  await expect(list.locator('.unread-dot')).toHaveCount(0)
  await page.waitForTimeout(2000)
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(list.locator('.unread-dot')).toHaveCount(2)

  await page.getByLabel('Select Alpha').check({ force: true })
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await bar.getByRole('button', { name: /^Labels/ }).click()
  await bar.getByRole('button', { name: 'Receipts', exact: true }).click()
  await expect(toast).toContainText('Labelled Receipts')
  await page.waitForTimeout(2000)
  await toast.getByRole('button', { name: 'Undo' }).click()

  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await list.locator('.thread', { hasText: 'Old invoice' }).hover()
  await list.locator('.thread', { hasText: 'Old invoice' }).getByRole('button', { name: 'Move to Inbox' }).click()
  await expect(toast).toContainText('Moved to Inbox')
  await expect(list.getByText('Old invoice')).toHaveCount(0)
  await page.waitForTimeout(2000)
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(list.getByText('Old invoice')).toBeVisible()

  await page.waitForTimeout(6000) // past Undo's five seconds and the one more the server waits
  expect(mail('Old invoice')?.labels).not.toContain('\\Inbox')
  expect(gmail.box('[Gmail]/Trash').mails).toHaveLength(1)
  expect(mail('Alpha')?.labels).not.toContain('Receipts')
  expect(gmail.mails.filter((m) => m.flags.includes('\\Seen'))).toEqual([])
  expect(gmail.writes().filter((c) => /STORE|MOVE/.test(c))).toEqual([])
})

// A thread ticked before a search stayed ticked once the search had left it out, and the bar still
// said "1 selected". With none of the ticked ones in the list, the bar's buttons fell back to the
// open thread: Delete selected deleted the thread being read, and the ticked one stayed.
test('a selection holds only threads in the list: a search that leaves one out lets go of it', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Files for you', from: 'Bao Le <bao@example.com>' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Trip to Da Lat', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(4) })
  gmail.add(rawMail({ subject: 'Da Lat photos', from: 'Linh Pham <linh@example.com>' }), { arrived: earlier(3) })
  await signIn(run)
  const list = page.locator('.threads')
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  await page.getByLabel('Select Files for you').check({ force: true })
  await page.getByLabel('Select Da Lat photos').check({ force: true })
  await expect(bar.getByText('2 selected')).toBeVisible()
  await page.getByLabel('Search').fill('Da Lat')
  await expect(list.locator('.thread .subject')).toHaveText(['Da Lat photos', 'Trip to Da Lat'])
  await expect(bar.getByText('1 selected')).toBeVisible() // the one still found
  await list.getByText('Trip to Da Lat').click()
  await expect(page.locator('.thread-subject')).toHaveText('Trip to Da Lat')
  await bar.getByRole('button', { name: 'Delete selected' }).click()
  await expect(page.getByText('Moved to Trash')).toBeVisible()
  await expect(list.locator('.thread .subject')).toHaveText(['Trip to Da Lat'])
  await page.getByLabel('Select Trip to Da Lat').check({ force: true })
  await page.getByLabel('Search').fill('Files')
  await expect(list.locator('.thread .subject')).toHaveText(['Files for you'])
  await expect(bar).toHaveCount(0)
  await page.getByLabel('Search').fill('')
  await expect(list.locator('.thread .subject')).toHaveText(['Trip to Da Lat', 'Files for you'])
  await expect(bar).toHaveCount(0)
})

// Select All picked only the 200 rows read in so far, and said "Select All (200)" of a list of 250.
test('Select All picks every thread in the list, not only the ones read in so far', async () => {
  run = await launch()
  const { page, gmail } = run
  for (let i = 0; i < 250; i++) gmail.add(rawMail({ subject: `Notice ${i}` }), { arrived: earlier(30) })
  await signIn(run)
  await expect(page.locator('.sync-progress')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.threads .thread')).toHaveCount(200)
  await page.getByLabel('Select Notice 0', { exact: true }).check({ force: true })
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  await bar.getByRole('button', { name: 'Select All (200+)' }).click()
  await expect(bar.getByText('250 selected')).toBeVisible()
  await bar.getByRole('button', { name: 'Archive selected' }).click()
  await expect(page.getByText('Archived: 250 threads')).toBeVisible()
  await expect(page.getByText('Nothing here')).toBeVisible()
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

// The bar's Flag only ever flagged, so a selection of flagged threads couldn't be unflagged there.
test('the bar under a selection takes the flags off when every thread picked is flagged, and flags them all otherwise', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Alpha' }), { arrived: earlier(5), flags: ['\\Flagged'] })
  gmail.add(rawMail({ subject: 'Beta' }), { arrived: earlier(4), flags: ['\\Flagged'] })
  gmail.add(rawMail({ subject: 'Gamma' }), { arrived: earlier(3) })
  await signIn(run)
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  const flags = page.locator('.threads .mark.flag')
  await expect(flags).toHaveCount(2)
  await page.getByLabel('Select Alpha').check({ force: true })
  await page.getByLabel('Select Beta').check({ force: true })
  await bar.getByRole('button', { name: 'Remove flag from selected' }).click()
  await expect(flags).toHaveCount(0)
  await page.getByLabel('Select Alpha').check({ force: true })
  await page.getByLabel('Select Gamma').check({ force: true })
  await bar.getByRole('button', { name: 'Flag selected' }).click()
  await expect(flags).toHaveCount(2)
  await expect.poll(() => gmail.mails.filter((m) => m.flags.includes('\\Flagged')).length, LONG).toBe(2)
  expect(gmail.mails.find((m) => m.raw.toString().includes('Beta'))?.flags).not.toContain('\\Flagged')
})

test('the ⋮ on the bar under a selection labels, pins and moves to Other every thread picked', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Alpha', from: 'Ann <ann@example.com>' }), { arrived: earlier(5), labels: ['\\Inbox', 'Receipts'] })
  gmail.add(rawMail({ subject: 'Beta', from: 'Bob <bob@example.com>' }), { arrived: earlier(4) })
  gmail.add(rawMail({ subject: 'Gamma', from: 'Cy <cy@example.com>' }), { arrived: earlier(3) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: true }))
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  const list = page.locator('.threads')
  const pickTwo = async (): Promise<void> => {
    await page.getByLabel('Select Beta').check({ force: true })
    await page.getByLabel('Select Gamma').check({ force: true })
    await expect(page.getByText('2 selected')).toBeVisible()
  }
  await pickTwo()
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await bar.getByRole('button', { name: /^Labels/ }).click()
  // Over the whole bar: it covered the count, Select All and Cancel.
  const [menuBox, barBox] = [await bar.locator('.popover').boundingBox(), await bar.boundingBox()]
  expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(barBox?.y ?? 0)
  await bar.getByRole('button', { name: 'Receipts', exact: true }).click()
  await expect(page.getByText('Labelled Receipts: 2 threads')).toBeVisible()
  await expect.poll(() => gmail.mails.filter((m) => m.labels.includes('Receipts')).length, LONG).toBe(3)
  await expect(bar).toHaveCount(0) // done with, the selection goes

  await pickTwo()
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await bar.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(page.getByText('Pinned: 2 threads')).toBeVisible()
  await page.getByRole('button', { name: 'Pinned', exact: true }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Gamma', 'Beta'])
  await page.getByRole('button', { name: /^Inbox/ }).first().click()

  await pickTwo()
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await bar.getByRole('button', { name: 'Move to Other', exact: true }).click()
  await expect(page.getByText('2 senders stay in Other')).toBeVisible()
  await expect(list.locator('.thread .subject')).toHaveText(['Alpha'])
  await page.getByRole('button', { name: /^Other/ }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Gamma', 'Beta'])
  await page.getByLabel('Select Beta').check({ force: true })
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await bar.getByRole('button', { name: 'Move to Focused', exact: true }).click()
  await expect(page.getByText('bob@example.com stays in Focused')).toBeVisible()
  await expect(list.locator('.thread .subject')).toHaveText(['Gamma'])
})

test('Gmail\'s importance: a quiet mark in the list, set from the bar under a selection and over a thread, and Appearance can hide it', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Rent is due', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(4), labels: ['\\Inbox', '\\Important'] })
  gmail.add(rawMail({ subject: 'Lunch on Friday', from: 'Linh Pham <linh@example.com>' }), { arrived: earlier(3) })
  await signIn(run)
  const list = page.locator('.threads')
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  const mark = (subject: string): ReturnType<Page['locator']> => list.locator('.thread', { hasText: subject }).getByRole('img', { name: 'Important', exact: true })
  const labelsOf = (subject: string): string[] => gmail.mails.find((m) => m.raw.toString().includes(subject))?.labels ?? []
  await expect(mark('Rent is due')).toBeVisible()
  await expect(mark('Lunch on Friday')).toHaveCount(0)
  // Quiet: no bigger than the flag and paperclip beside it, in the list's muted grey.
  expect((await mark('Rent is due').boundingBox())?.height).toBeLessThanOrEqual(13)
  expect(await mark('Rent is due').evaluate((el) => getComputedStyle(el).color)).toBe(await list.locator('.snippet').first().evaluate((el) => getComputedStyle(el).color))

  await page.getByLabel('Select Lunch on Friday').check({ force: true })
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await expect(bar.getByRole('button', { name: 'Mark as not important' })).toHaveCount(0)
  await bar.getByRole('button', { name: 'Mark as important' }).click()
  await expect(mark('Lunch on Friday')).toBeVisible()
  await expect(bar).toHaveCount(0) // done with, the selection goes
  await expect.poll(() => labelsOf('Lunch on Friday'), LONG).toContain('\\Important')

  await list.getByText('Rent is due').click()
  await page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Mark as not important' }).click()
  await expect(mark('Rent is due')).toHaveCount(0)
  await expect.poll(() => labelsOf('Rent is due'), LONG).toEqual(['\\Inbox'])
  await expect(page.locator('.thread-head .tag')).toHaveCount(0) // Gmail's own, so not one of the thread's labels
  await page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Mark as important' }).click()
  await expect(mark('Rent is due')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  const showing = page.getByLabel('Show Gmail\'s importance markers in the list')
  await expect(showing).toBeChecked()
  await showing.uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  await expect(list.getByRole('img', { name: 'Important', exact: true })).toHaveCount(0)
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

// The window's keys went on acting behind the Summary's "When your Summary arrives" and New Label,
// which hold the focus as Settings and the other dialogs do.
test('keys wait while the Summary asks when, and while a label is being made', async () => {
  run = await launch()
  const { page, gmail } = run
  const headers = ['List-Unsubscribe: <https://list.example/u>']
  gmail.add(rawMail({ subject: 'Deals', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(3) })
  await signIn(run)
  await page.getByRole('button', { name: 'Subscriptions' }).click()
  await page.getByRole('button', { name: 'Add hi@shop.example to Summary' }).click()
  const when = page.getByRole('dialog', { name: 'When your Summary arrives' })
  await when.getByRole('button', { name: 'Schedule' }).focus()
  await page.keyboard.press('c')
  await page.waitForTimeout(500)
  await expect(composer(page)).toHaveCount(0)
  await when.getByRole('button', { name: 'Cancel' }).click()

  await page.locator('.sidebar .sidebar-foot .status').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await page.locator('.sidebar').getByRole('button', { name: `New Label on ${ME}` }).click()
  const making = page.getByRole('dialog', { name: 'New Label' })
  await making.getByRole('button', { name: 'Cancel' }).focus()
  await page.keyboard.press('c')
  await page.waitForTimeout(500)
  await expect(composer(page)).toHaveCount(0)
})

// Every key went dead while a composer was open, though it sits docked in a corner and the list and
// the thread are there beside it to go on reading.
test('keys work beside an open composer, and none of them act from inside it', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Oldest', 'Middle', 'Newest'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  const list = page.locator('.threads')
  const reading = page.locator('.thread-subject')
  await list.getByText('Newest').click()
  await page.keyboard.press('c')
  const box = composer(page)
  await expect(box.getByLabel('To')).toBeFocused()
  await box.getByRole('button', { name: 'Bold' }).focus()
  await page.keyboard.press('j')
  await page.keyboard.press('e')
  await expect(reading).toHaveText('Newest')
  await expect(list.getByText('Newest')).toBeVisible()
  await list.getByText('Newest').click()
  await page.keyboard.press('j')
  await expect(reading).toHaveText('Middle')
  await page.keyboard.press('e')
  await expect(list.getByText('Middle')).toHaveCount(0)
  await expect(page.getByText('Archived')).toBeVisible()
  await expect(box).toBeVisible()
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

// Snooze from a row ticked the row and opened its times on the bar at the foot of the list, far
// from the row it was asked from.
test('snoozing from a row asks when beside that row, and ticks nothing', async () => {
  run = await launch()
  const { page, gmail } = run
  for (const [i, subject] of ['Alpha', 'Beta', 'Gamma'].entries()) gmail.add(rawMail({ subject }), { arrived: earlier(5 - i) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ quickActions: ['snooze', 'archive', 'trash', 'read'] }))
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  const list = page.locator('.threads')
  const times = page.locator('.popover', { hasText: 'Snooze until' })
  const near = async (subject: string): Promise<number> => {
    const [row, menu] = [await list.locator('.thread', { hasText: subject }).boundingBox(), await times.boundingBox()]
    return Math.min(Math.abs((menu?.y ?? 0) - ((row?.y ?? 0) + (row?.height ?? 0))), Math.abs((menu?.y ?? 0) + (menu?.height ?? 0) - (row?.y ?? 0)))
  }
  await list.locator('.thread', { hasText: 'Beta' }).hover()
  await list.locator('.thread', { hasText: 'Beta' }).getByRole('button', { name: 'Snooze' }).click()
  await expect(times).toBeVisible()
  expect(await near('Beta')).toBeLessThan(20)
  await expect(page.getByRole('toolbar', { name: 'Selected threads' })).toHaveCount(0)
  await times.getByRole('button', { name: /^Tomorrow/ }).click()
  await expect(page.getByRole('status')).toHaveText(/^Snoozed until/)
  await expect(list.getByText('Beta')).toHaveCount(0)

  await list.getByText('Gamma').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Snooze' }).click()
  await expect(times).toBeVisible()
  expect(await near('Gamma')).toBeLessThan(20)
  await page.keyboard.press('Escape')
  await expect(times).toHaveCount(0)
  await expect(list.getByText('Gamma')).toBeVisible()
})

// Snoozed showed each thread's own date, not when it comes back, and only the snooze toast's Undo
// could bring one back early.
test('Snoozed says when each thread comes back, and Unsnooze brings one back now', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Later please' }), { arrived: earlier(30) })
  gmail.add(rawMail({ subject: 'Also later' }), { arrived: earlier(29) })
  await signIn(run)
  const list = page.locator('.threads')
  for (const subject of ['Later please', 'Also later']) {
    await list.getByText(subject).click()
    await page.keyboard.press('b')
    await page.getByRole('button', { name: /^Tomorrow/ }).click()
    await expect(list.getByText(subject)).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Snoozed', exact: true }).click()
  const row = list.locator('.thread', { hasText: 'Later please' })
  await expect(row.locator('time')).toContainText('09:00') // Tomorrow, as Settings have it
  await row.getByText('Later please').click()
  const tools = page.getByRole('toolbar', { name: 'Thread', exact: true })
  await tools.getByRole('button', { name: 'Unsnooze' }).click()
  await expect(page.getByRole('status')).toHaveText(/^Unsnoozed/)
  await expect(list.getByText('Later please')).toHaveCount(0)
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect(list.getByText('Later please')).toBeVisible()

  await list.getByText('Also later').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unsnooze' }).click()
  await expect(list.getByText('Also later')).toHaveCount(0)
  await page.getByRole('button', { name: 'Inbox', exact: true }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Also later'])
  await list.getByText('Also later').click()
  await expect(tools.getByRole('button', { name: 'Snooze' })).toBeVisible()
  await expect(tools.getByRole('button', { name: 'Unsnooze' })).toHaveCount(0)
})

// A menu's own button, pressed again, closed the menu as a click outside it, and the click then
// opened it again: Snooze, More and Send later could only be closed by clicking somewhere else.
test('a menu\'s button pressed again closes it', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plans' }), { arrived: earlier(5) })
  await signIn(run)
  await page.locator('.threads').getByText('Plans').click()
  const tools = page.getByRole('toolbar', { name: 'Thread', exact: true })
  const menu = page.locator('.popover')
  for (const name of ['Snooze', 'More', 'Labels']) {
    await tools.getByRole('button', { name, exact: true }).click()
    await expect(menu).toHaveCount(1)
    await tools.getByRole('button', { name, exact: true }).click()
    await expect(menu).toHaveCount(0)
  }
  await page.keyboard.press('c')
  const later = composer(page).getByRole('button', { name: 'Send later' })
  await later.click()
  await expect(menu).toHaveCount(1)
  await later.click()
  await expect(menu).toHaveCount(0)
})

test('Settings say what Tomorrow, the weekend and Next week mean, for snoozing and for sending later', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Later please' }), { arrived: earlier(5) })
  await signIn(run)
  const day = (offset: number, hour: number): Date => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour)
  }
  const toTuesday = (2 - new Date().getDay() + 7) % 7 || 7
  const dayName = (at: Date): string => at.toLocaleDateString([], { weekday: 'short' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByLabel('Tomorrow, time')).toHaveValue('9')
  await page.getByLabel('Tomorrow, time').selectOption('7')
  await page.getByLabel('Next week, day').selectOption('2')
  await page.getByLabel('Next week, time').selectOption('8')
  await page.getByLabel('Later today').selectOption('1')
  await expect.poll(() => page.evaluate(async () => (await window.mail.settings()).later))
    .toMatchObject({ tomorrow: 7, weekDay: 2, week: 8, laterHours: 1, evening: 18, weekendDay: 6, weekend: 9 })
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved

  await page.getByText('Later please').click()
  await page.keyboard.press('b')
  const tomorrow = page.getByRole('button', { name: /^Tomorrow/ })
  await expect(tomorrow).toContainText(`${dayName(day(1, 7))}`)
  await expect(tomorrow).toContainText('07:00')
  const nextWeek = page.getByRole('button', { name: /^Next week(?!end)/ }) // on a Saturday or a Sunday, Next weekend is there too
  await expect(nextWeek).toContainText(`${dayName(day(toTuesday, 8))}`)
  await expect(nextWeek).toContainText('08:00')
  await tomorrow.click()
  await page.getByRole('button', { name: 'Snoozed', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.mail.list({ kind: 'snoozed' }))[0]?.snoozedUntil)).toBe(day(1, 7).getTime())

  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: 'Send later' }).click()
  await expect(page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: /^Tomorrow/ })).toContainText('07:00')
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
  gmail.add(rawMail({ subject: 'Files', attachment: { name: 'report.pdf', type: 'application/pdf', body: pdf() } }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Trap', attachment: { name: 'totally-a-photo.desktop', type: 'application/x-desktop', body: '[Desktop Entry]\nExec=rm -rf ~' } }), { arrived: earlier(4) })
  // A Java program named as a PDF: xdg-open goes by the bytes, and would run it with java -jar.
  gmail.add(rawMail({ subject: 'Bill', attachment: { name: 'invoice.pdf', type: 'application/pdf', body: jar() } }), { arrived: earlier(3) })
  await signIn(run)
  await page.locator('.threads').getByText('Files').click()
  await page.getByRole('button', { name: 'Save report.pdf' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(run.savedTo).equals(pdf())).toBe(true)
  await page.getByRole('button', { name: /^report\.pdf/ }).click()
  await expect.poll(run.openedFiles).toHaveLength(1)
  await page.locator('.threads').getByText('Bill', { exact: true }).click()
  await page.getByRole('button', { name: /^invoice\.pdf/ }).click()
  await expect(page.getByText('Save it to open')).toBeVisible()
  expect(await run.openedFiles()).toHaveLength(1)
  // What can't be opened by its name isn't offered as Open: the file is saved instead.
  await page.locator('.threads').getByText('Trap').click()
  const trap = page.getByRole('button', { name: /^totally-a-photo/ })
  await expect(trap).toHaveAttribute('title', 'Save')
  await trap.click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect.poll(() => readFileSync(run.savedTo, 'utf8')).toBe('[Desktop Entry]\nExec=rm -rf ~')
  expect(await run.openedFiles()).toHaveLength(1)
  // The name is a stranger's, in Downloads: a file already there of that name isn't written over
  // unasked, as GTK's dialog does without being told to ask.
  const dialogs = await run.app.evaluate(() => (globalThis as unknown as { saveDialogs: { properties?: string[] }[] }).saveDialogs)
  expect(dialogs).toHaveLength(2)
  for (const options of dialogs) expect(options.properties).toContain('showOverwriteConfirmation')
})

// Opened files waited in the temporary folder until a clean quit, and a crash left them for good.
test('an attachment opened isn\'t left on disk by a crash: the next start takes it away', async () => {
  run = await launch()
  const { page, gmail, smtp } = run
  gmail.add(rawMail({ subject: 'Files', attachment: { name: 'report.pdf', type: 'application/pdf', body: pdf() } }), { arrived: earlier(5) })
  await signIn(run)
  await page.locator('.threads').getByText('Files').click()
  await page.getByRole('button', { name: /^report\.pdf/ }).click()
  await expect.poll(run.openedFiles).toHaveLength(1)
  const [opened = ''] = await run.openedFiles()
  expect(readFileSync(opened).equals(pdf())).toBe(true)
  // Ended the way a crash ends it, with nothing let to tidy up.
  const ended = new Promise((resolve) => run.app.process().once('exit', resolve))
  run.app.process().kill('SIGKILL')
  await ended
  await gmail.stop()
  await smtp.stop()
  expect(existsSync(opened)).toBe(true)
  run = await launch({ data: run.data })
  await run.page.waitForLoadState()
  expect(existsSync(dirname(opened))).toBe(false)
})

test('View original shows a message as the server has it, as text, and saves it as .eml', async () => {
  run = await launch()
  const { page, gmail } = run
  const html = '<p>Hello <b id="planted">there</b></p><img src=x onerror="document.title=\'pwned\'">'
  gmail.add(rawMail({ subject: 'Plans: Friday', from: 'Mai Tran <mai@example.com>', html, headers: ['X-Mailer: Made Up 1.0'], attachment: { name: 'plan.txt', type: 'text/plain', body: 'step one' } }), { arrived: earlier(2) })
  await signIn(run)
  await page.locator('.threads').getByText('Plans: Friday').click()
  await page.locator('.message.open').getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('button', { name: 'View original' }).click()
  const sheet = page.getByRole('dialog', { name: 'Original: Plans: Friday' })
  const source = sheet.locator('pre')
  await expect(source).toContainText('X-Mailer: Made Up 1.0')
  await expect(source).toContainText('Subject: Plans: Friday')
  await expect(source).toContainText('<b id="planted">there</b>') // its HTML as text, never as a page
  await expect(source).toContainText(Buffer.from('step one').toString('base64'))
  expect(await sheet.locator('#planted, img').count()).toBe(0)
  await page.keyboard.press('e') // the app's keys wait while it's open
  await expect(page.locator('.threads').getByText('Plans: Friday')).toBeVisible()
  await sheet.getByRole('button', { name: 'Save as .eml' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const [dialog] = await run.app.evaluate(() => (globalThis as unknown as { saveDialogs: { properties?: string[] }[] }).saveDialogs)
  expect(dialog?.properties).toContain('showOverwriteConfirmation')
  const saved = readFileSync(run.savedTo, 'utf8')
  expect(saved).toContain('X-Mailer: Made Up 1.0')
  expect(saved.replace(/\r\n/g, '\n')).toBe(gmail.mails[0]?.raw.toString().replace(/\r\n/g, '\n'))
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(await page.title()).toBe('xrnmail')
  expect(await run.opened()).toEqual([])
  expect(await run.openedFiles()).toEqual([])
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

// The menu answered in the main window whichever window it was used in: F1 in a thread's own
// window showed the keys in the main window, and Ctrl+P printed that.
test('the menu in a thread\'s own window shows the keys there, and leaves writing to the main window', async () => {
  run = await launch()
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Lease', text: 'Signed copy inside.' }), { arrived: earlier(5) })
  await signIn(run)
  await page.locator('.threads').getByText('Lease').click()
  const out = page.getByRole('toolbar', { name: 'Thread', exact: true }).getByRole('button', { name: 'Open in a window' })
  const [solo] = await Promise.all([app.waitForEvent('window'), out.click()])
  await expect(solo.getByRole('heading', { name: 'Lease' })).toBeVisible()
  // As the menu does when it's used in that window: the window comes with the click.
  const choose = (label: string): Promise<void> => app.evaluate(({ BrowserWindow, Menu }, wanted) => {
    const from = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('solo=thread'))
    const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []) ?? []
    items.find((item) => item.label === wanted)?.click(undefined, from)
  }, label)
  await choose('Keyboard Shortcuts')
  await expect(solo.getByRole('heading', { name: 'Keys' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Keys' })).toHaveCount(0)
  await solo.getByRole('button', { name: 'Done' }).click()
  await choose('New Message')
  await expect(page.getByRole('region', { name: 'Compose' })).toBeVisible()
  await expect(solo.getByRole('region', { name: 'Compose' })).toHaveCount(0)
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
  // Closed with words in it: kept in Drafts, and the window goes. By its Close button: Escape needs
  // the composer to have the keyboard, which a busy test machine hadn't always given it yet, and the
  // window can go before the key is let go of, which Playwright takes for a failure.
  const gone = solo.waitForEvent('close')
  await there.getByRole('button', { name: 'Close' }).click({ noWaitAfter: true }).catch(() => undefined)
  await gone
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

  await side.getByRole('button', { name: /^Today/ }).click({ button: 'right' }) // with what came today counted beside it
  await expect(page.getByRole('menuitem', { name: 'Mark all as read' })).toBeVisible() // a place keeps its own entry
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await expect(side.getByRole('button', { name: 'Compose' })).toHaveCount(0)
  await expect(folders.getByRole('listitem')).toHaveText(['Today', 'Unread', 'Flagged', 'Pinned', 'Summary', 'Snoozed', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Sent', 'Recently Seen'])
  await expect(folders.getByRole('button', { name: 'Move Today up' })).toBeDisabled()
  await expect(folders.getByRole('button', { name: 'Move Recently Seen down' })).toBeDisabled()
  await folders.getByLabel('Show Snoozed').uncheck()
  await folders.getByRole('button', { name: 'Move Pinned up' }).click()
  await folders.getByRole('button', { name: 'Move Today down' }).click()
  await folders.getByRole('listitem').filter({ hasText: 'Sent' }).dragTo(folders.getByRole('listitem').filter({ hasText: 'Unread' }))
  await expect(folders.getByRole('listitem')).toHaveText(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Snoozed', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  await assistant.getByLabel('Show Events').uncheck()
  await assistant.getByRole('listitem').filter({ hasText: 'Packages' }).dragTo(folders.getByRole('listitem').filter({ hasText: 'Trash' })) // not into the other list
  await expect(assistant.getByRole('listitem')).toHaveText(['Subscriptions', 'Travel', 'Packages', 'Bills & Receipts', 'Events'])
  await side.getByRole('button', { name: 'Done' }).click()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
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
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  await side.getByRole('button', { name: 'Drafts', exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem')).toHaveText(['Edit Menu'])
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await folders.getByLabel('Show Unread').uncheck()
  await page.keyboard.press('Escape')
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])

  // Settings leads to the same place, and what was hidden comes back where it was put.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Edit Menu' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await folders.getByLabel('Show Snoozed').check()
  await side.getByRole('button', { name: 'Done' }).click()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Snoozed', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  const saved = await page.evaluate(async () => (await window.mail.settings()).sidebar)
  expect(saved.hidden).toEqual(['events'])
  expect(saved.order.slice(0, 5)).toEqual(['sent', 'unread', 'today', 'pinned', 'starred'])
  await page.reload()
  await expect(side.getByRole('button', { name: 'Sent', exact: true })).toBeVisible()
  expect(await names(2)).toEqual(['Sent', 'Unread', 'Today', 'Pinned', 'Flagged', 'Summary', 'Snoozed', 'Reminders', 'Attachments', 'Drafts', 'Spam', 'Trash', 'Archive', 'Recently Seen'])
  expect(await names(3)).toEqual(['Subscriptions', 'Travel', 'Packages', 'Bills & Receipts'])
})

test('Edit Menu: every entry\'s whole name fits beside its switch and arrows, in both themes', async () => {
  // A window short enough for the list to scroll, as most are once an account has labels: the
  // scrollbar takes its width from the names.
  run = await launch({ size: [1280, 640] })
  const { page, gmail } = run
  gmail.labels = ['Receipts', 'Travel plans', 'Work', 'Family', 'School']
  gmail.add(rawMail({ subject: 'One' }), { arrived: earlier(5) })
  await signIn(run)
  const side = page.locator('.sidebar')
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((chosen) => window.mail.saveProfile({ theme: chosen }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await side.locator('.sidebar-foot .status').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
    await expect(side.getByRole('button', { name: 'Done' })).toBeVisible()
    expect((await side.boundingBox())?.width).toBe(250) // the width it starts at
    expect(await side.locator('.sidebar-scroll').evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true)
    // A name that's cut is wider than the room it has: "Recently Seen" came out as "Recently S…".
    const cut = await side.locator('.nav-edit > label .grow').evaluateAll((names) =>
      names.filter((name) => name.scrollWidth > name.clientWidth).map((name) => name.textContent))
    expect(cut).toEqual([])
    await expect(side.getByRole('button', { name: 'Move Recently Seen up' })).toBeVisible()
    await side.getByRole('button', { name: 'Cancel' }).click()
  }
})

test('Edit Menu: an account\'s own labels are hidden and moved there, and New Label makes one on the server', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.labels = ['Travel', 'Receipts', 'Work', 'Work/Plans']
  gmail.add(rawMail({ subject: 'Paid' }), { arrived: earlier(5), labels: ['\\Inbox', 'Receipts'] })
  await signIn(run)
  const side = page.locator('.sidebar')
  const shown = async (): Promise<string[]> => (await side.locator('.nav-folders .nav-item .grow').allInnerTexts()).map((name) => name.trim())
  await expect.poll(shown).toEqual(['All Mail', 'Receipts', 'Travel', 'Work', 'Plans']) // empty ones too, each inside its own
  await side.locator('.sidebar-foot .status').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  const labels = side.getByRole('list', { name: `Labels on ${ME}` })
  await expect(labels.getByRole('listitem')).toHaveText(['Receipts', 'Travel', 'Work', 'Plans'])
  await labels.getByLabel('Show Travel').uncheck()
  await labels.getByRole('button', { name: 'Move Work up' }).click()
  await labels.getByRole('button', { name: 'Move Work up' }).click()
  await expect(labels.getByRole('listitem')).toHaveText(['Work', 'Plans', 'Receipts', 'Travel']) // Plans goes with Work
  await expect(labels.getByRole('button', { name: 'Move Work/Plans up' })).toBeDisabled() // alone inside Work
  await labels.getByRole('listitem').filter({ hasText: 'Receipts' }).dragTo(labels.getByRole('listitem').filter({ hasText: 'Work' }).first())
  await expect(labels.getByRole('listitem')).toHaveText(['Receipts', 'Work', 'Plans', 'Travel'])

  await side.getByRole('button', { name: `New Label on ${ME}` }).click()
  const making = page.getByRole('dialog', { name: 'New Label' })
  await making.getByLabel('Name').fill('INBOX/Mine')
  await making.getByRole('button', { name: 'Create New' }).click()
  await expect(making.getByRole('alert')).toHaveText("INBOX is the service's own.")
  await making.getByLabel('Name').fill('Ideas')
  await making.getByRole('button', { name: 'Create New' }).click()
  await expect(page.getByText('Made the label Ideas')).toBeVisible()
  await expect(making).toHaveCount(0)
  expect(gmail.labels).toContain('Ideas')
  await expect(labels.getByRole('listitem')).toHaveText(['Receipts', 'Work', 'Plans', 'Travel', 'Ideas']) // still editing, with the new one
  await side.getByRole('button', { name: 'Done' }).click()
  await expect.poll(shown).toEqual(['All Mail', 'Receipts', 'Work', 'Plans', 'Ideas'])

  // An empty label can be given to mail at once, and the choice lasts.
  await page.locator('.threads').getByText('Paid').click()
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.locator('.popover').getByLabel('Ideas').click()
  await expect.poll(() => gmail.mails[0]?.labels ?? [], LONG).toContain('Ideas')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect.poll(shown).toEqual(['All Mail', 'Receipts', 'Work', 'Plans', 'Ideas'])
  expect((await page.evaluate(() => window.mail.settings())).sidebar.labels).toEqual({ [ME]: { order: ['Receipts', 'Work', 'Travel', 'Work/Plans'], hidden: ['Travel'] } })
})

test('muting a sender from the reader, and the muted senders in Settings', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Chatter', from: 'Ada Lovelace <ada@example.com>' }), { arrived: earlier(5) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: true }))
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
  await expect(settings.getByText('None', { exact: true })).toBeVisible()
  // Mail sorted into Other can arrive unannounced, while there's an Other.
  await settings.getByLabel('Only mail in Focused').check()
  await expect.poll(() => page.evaluate(async () => (await window.mail.settings()).notifyFocusedOnly)).toBe(true)
  await settings.getByPlaceholder('Search settings').fill('')
  await settings.getByRole('button', { name: 'General' }).click()
  await settings.getByLabel('Split the inbox into Focused and Other').uncheck()
  await settings.getByRole('button', { name: 'Notifications' }).click()
  await expect(settings.getByLabel('Only mail in Focused')).toHaveCount(0)
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

test('a picture pasted or dropped goes into the words, stays there in Drafts, and is sent as a part the words name', async () => {
  run = await launch()
  const { page, app, smtp } = run
  await signIn(run)
  await undoOff(page)
  await page.getByRole('button', { name: 'Compose' }).click()
  let box = composer(page)
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Subject').fill('Pictures')
  const editor = box.getByLabel('Message')
  await editor.click()
  await page.keyboard.type('Look ')
  await page.evaluate((picture) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(picture), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }))
    document.querySelector('.composer .editor')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, png().toString('base64'))
  await expect(editor.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  // Dropped on the words, it goes in them too; only what isn't a picture is attached.
  const place = await editor.boundingBox()
  const cdp = await app.context().newCDPSession(page)
  const [dropped, notes] = [join(run.savedTo, '..', 'dropped.png'), join(run.savedTo, '..', 'notes.txt')]
  writeFileSync(dropped, png([200, 40, 40]))
  writeFileSync(notes, 'notes')
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, x: (place?.x ?? 0) + 20, y: (place?.y ?? 0) + 8, data: { items: [], files: [dropped, notes], dragOperationsMask: 1 } })
  }
  await expect(editor.locator('img')).toHaveCount(2)
  await expect(box.locator('.file-name')).toHaveText(['notes.txt'])
  await box.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await page.getByText('Pictures').click()
  box = composer(page)
  await expect(box.getByLabel('Message').locator('img').first()).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(box.getByLabel('Message').locator('img')).toHaveCount(2)
  await box.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  const raw = (smtp.sent[0]?.raw ?? '').replace(/=\r?\n/g, '').replace(/=3D/g, '=') // as quoted-printable reads
  expect(raw).toContain('multipart/related')
  const cids = [...raw.matchAll(/Content-ID: <([^>]+)>/g)].map((m) => m[1])
  expect(cids).toHaveLength(2)
  for (const cid of cids) expect(raw).toContain(`<img src="cid:${cid}"`)
  expect(raw).toContain('style="max-width:100%"') // as wide as the page it's read on, at most
  expect(raw).toContain('filename=notes.txt')
  expect(raw).not.toContain('data:image')
})

// The editor is in the app's own page: whatever a draft says, nothing in it is fetched from anywhere.
test('the composer shows only a draft\'s own pictures, never one from elsewhere', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.evaluate(async () => {
    const draft = await window.mail.startDraft({ kind: 'new', to: 'ada@example.com', subject: 'Odd draft' })
    await window.mail.saveDraft(draft.id, {
      account: draft.account, from: '', to: draft.to, cc: '', bcc: '', subject: draft.subject, quote: null, text: 'Hi',
      html: 'Hi<img src="https://pictures.example/open.gif"><img src="cid:not-mine@example.com">'
    })
  })
  await page.getByRole('button', { name: /^Drafts/ }).click()
  await page.getByText('Odd draft').click()
  await expect(composer(page).getByLabel('Message')).toHaveText('Hi')
  await expect(composer(page).getByLabel('Message').locator('img')).toHaveCount(0)
})

test('unsubscribing with one click opens nothing', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Weekly deals', headers: ['List-Unsubscribe: <https://list.example.com/u/1>'] }), { arrived: earlier(5) })
  await signIn(run)
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

// Clicking the notice for a new message only brought the window up, wherever it was, and the message
// it named had to be looked for. The main process sends its thread on the click (desktop notices are
// off in the tests, so this sends what the click does).
test('the notice for a new message opens that message, in the inbox', async () => {
  run = await launch()
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Older' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Just in', from: 'Mai Tran <mai@example.com>', text: 'Are you free?' }), { arrived: earlier(0.1), thread: 77n })
  await signIn(run)
  await page.getByRole('button', { name: /^Sent/ }).click()
  await expect(page.locator('.view-title')).toHaveText('Sent')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('open-thread', { account: 'me@example.com', thread: '77' }))
  await expect(page.locator('.thread-subject')).toHaveText('Just in')
  await expect(page.locator('.messages')).toContainText('Are you free?')
  await expect(page.locator('.view-title')).toHaveText('Inbox')
  await expect(page.locator('.threads .thread.on')).toContainText('Just in')
})

// Going to the place already shown emptied the list for its skeleton, and nothing asked for it again,
// so the grey rows stayed until the next sync happened to change something.
test('the place already shown, clicked again or reached from a notice, lists its mail again at once', async () => {
  run = await launch()
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Hello there' }), { arrived: earlier(5) })
  gmail.add(rawMail({ subject: 'Just in', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(0.1), thread: 77n })
  await signIn(run)
  const list = page.locator('.threads')
  const soon = { timeout: 3000 }
  await expect(list.getByText('Hello there')).toBeVisible()
  await page.waitForTimeout(1500) // settled, so nothing else lists it again by the way
  await page.getByRole('button', { name: /^Inbox/ }).first().click()
  await expect(list.getByText('Hello there')).toBeVisible(soon)
  await expect(page.locator('.skeleton-row')).toHaveCount(0)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('open-thread', { account: 'me@example.com', thread: '77' }))
  await expect(page.locator('.thread-subject')).toHaveText('Just in')
  await expect(list.getByText('Hello there')).toBeVisible(soon)

  await page.getByRole('button', { name: 'Summary', exact: true }).click()
  await expect(page.getByText('No Summary here')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('command', 'summary'))
  await expect(page.getByText('No Summary here')).toBeVisible(soon)
  await expect(page.locator('.skeleton-row')).toHaveCount(0)
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
  await page.getByRole('button', { name: 'Add signature' }).click()
  await page.getByRole('textbox', { name: 'Signature', exact: true }).click()
  await page.keyboard.type('Sent from xrnmail')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => page.evaluate((me) => window.mail.settings().then((s) => s.identities[me]?.name), ME)).toBe('Sơn Nguyễn')
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

test('several signatures, written with the toolbar: each address has its own, and the composer can pick another', async () => {
  run = await launch()
  const { page, smtp } = run
  await signIn(run)
  await undoOff(page)
  await page.evaluate((me) => window.mail.saveProfile({ identities: { [me]: { name: 'Mai', signature: '', aliases: ['shop@example.com'], color: '', notify: true } } }), ME)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Signatures' }).click()
  await page.getByRole('button', { name: 'Add signature' }).click()
  const first = page.getByRole('textbox', { name: 'Signature', exact: true })
  await first.click()
  await page.keyboard.type('Mai ')
  await page.locator('.signature-card').first().getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('Nguyen')
  await page.getByRole('button', { name: 'Add signature' }).click()
  await page.getByLabel('Signature name').nth(1).fill('Shop')
  await page.getByRole('textbox', { name: 'Shop' }).click()
  await page.keyboard.type('The Shop team')
  await page.getByLabel('shop@example.com').selectOption({ label: 'Shop' })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => page.evaluate(() => window.mail.settings().then((s) => s.signatures.map((x) => [x.name, x.text]))))
    .toEqual([['Signature', 'Mai Nguyen'], ['Shop', 'The Shop team']])

  await page.keyboard.press('c')
  const box = composer(page)
  const signature = box.locator('.signature')
  await expect(signature).toContainText('Mai Nguyen')
  await box.getByLabel('From').selectOption(JSON.stringify([ME, 'shop@example.com']))
  await expect(signature).toContainText('The Shop team')
  await box.getByRole('button', { name: 'Signature', exact: true }).click()
  await page.getByRole('button', { name: 'None' }).click()
  await expect(signature).toHaveCount(0)
  await box.getByRole('button', { name: 'Signature', exact: true }).click()
  await page.getByRole('button', { name: 'Signature', exact: true }).last().click()
  await expect(signature).toContainText('Mai Nguyen')
  await box.getByLabel('To').fill('ada@example.com')
  await box.getByLabel('Message').fill('Hello')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => smtp.sent.length, LONG).toBe(1)
  const raw = (smtp.sent[0]?.raw ?? '').replace(/=\r?\n/g, '').replace(/=3D/g, '=')
  expect(raw).toMatch(/Mai <(b|strong)>Nguyen<\/(b|strong)>/)
  expect(raw).not.toContain('The Shop team')
  expect(smtp.sent[0]?.from).toBe('shop@example.com')
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

// Esc with the suggestions under To showing closed the whole composer, not the suggestions.
test('Esc over the address suggestions closes them, and the next Esc the composer', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plans', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(5) })
  await signIn(run)
  await page.keyboard.press('c')
  const box = composer(page)
  await box.getByLabel('To').fill('mai')
  await expect(box.getByRole('listbox')).toContainText('Mai Tran')
  await page.keyboard.press('Escape')
  await expect(box.getByRole('listbox')).toHaveCount(0)
  await expect(box).toBeVisible()
  await expect(box.getByLabel('To')).toHaveValue('mai')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
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
  await expect(page.getByText('None', { exact: true })).toBeVisible()
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

test('two settings changed one straight after the other both stick, and so do two senders put into the Summary', async () => {
  run = await launch()
  const { page, gmail } = run
  const headers = ['List-Unsubscribe: <https://list.example/u>']
  gmail.add(rawMail({ subject: 'Deals', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Letter', from: 'Post <news@post.example>', headers }), { arrived: earlier(2) })
  await signIn(run)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: 'Customize Actions' }).click()
  await expect(settings.getByLabel('Action 4')).toHaveValue('read')
  // Both in the same moment, before the first could be saved and read back. Each used to be built
  // from the settings as they were read before either, so the second put the first one back.
  await page.evaluate(() => {
    const choose = (label: string, value: string): void => {
      const select = [...document.querySelectorAll<HTMLSelectElement>('.settings-page select')].find((s) => s.labels[0]?.textContent?.startsWith(label))
      if (!select) throw new Error(`no ${label}`)
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    choose('Action 1', 'snooze')
    choose('Action 4', 'none')
  })
  await expect(settings.getByLabel('Action 1')).toHaveValue('snooze')
  await expect(settings.getByLabel('Action 4')).toHaveValue('none')
  await expect.poll(async () => (await page.evaluate(() => window.mail.settings())).quickActions).toEqual(['snooze', 'flag', 'trash', 'none'])
  await settings.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: 'Customize Actions' }).click()
  await expect(settings.getByLabel('Action 1')).toHaveValue('snooze')
  await expect(settings.getByLabel('Action 4')).toHaveValue('none')
  await settings.getByRole('button', { name: 'Done' }).click()

  await page.evaluate(() => window.mail.saveSummary({ chosen: true }))
  await page.getByRole('button', { name: 'Subscriptions' }).click()
  await expect(page.getByRole('button', { name: 'Add news@post.example to Summary' })).toBeVisible()
  await page.evaluate(() => {
    for (const who of ['hi@shop.example', 'news@post.example']) document.querySelector<HTMLButtonElement>(`button[aria-label="Add ${who} to Summary"]`)?.click()
  })
  await expect(page.getByText('No subscriptions')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.mail.settings())).summary.senders.slice().sort()).toEqual(['hi@shop.example', 'news@post.example'])
})

// Settings and adding an account carried sentences: "Their new mail goes straight to Trash",
// "Ready-made text for the composer", "Under what you write", "Counts for your day's page", and a
// paragraph on registering an app with Microsoft. The owner wants figures and short labels only.
test('Settings and adding an account have short labels and figures, and no sentences', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.evaluate(() => window.mail.saveSummary({ senders: ['news@shop.example'], chosen: true }))
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length
  const pages = await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button').allInnerTexts()
  expect(pages).toHaveLength(13)
  let seen = ''
  for (const name of pages) {
    await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: name.trim(), exact: true }).click()
    const main = settings.locator('.settings-page')
    seen += await main.innerText()
    for (const heading of await main.locator('h3').allInnerTexts()) expect.soft(words(heading), `${name}: ${heading}`).toBeLessThanOrEqual(4)
    for (const line of await main.locator('p:not(.error)').allInnerTexts()) expect.soft(words(line), `${name}: ${line}`).toBeLessThanOrEqual(3)
    for (const field of await main.locator('[placeholder]').evaluateAll((all) => all.map((f) => f.getAttribute('placeholder') ?? ''))) {
      expect.soft(words(field), `${name}: ${field}`).toBeLessThanOrEqual(3)
    }
  }
  for (const sentence of ['Under what you write', 'Who you write as']) expect(seen.toLowerCase()).not.toContain(sentence.toLowerCase())
  await settings.getByRole('button', { name: 'Accounts', exact: true }).click()
  await settings.getByRole('button', { name: 'Add account' }).click()
  for (const service of ['Outlook', 'Other']) {
    await settings.getByRole('radio', { name: service }).click()
    for (const line of await settings.locator('.add-account p:not(.error)').allInnerTexts()) expect.soft(words(line), `${service}: ${line}`).toBeLessThanOrEqual(3)
    for (const label of await settings.locator('.add-account label').evaluateAll((all) => all.map((l) => l.firstChild?.textContent ?? ''))) {
      expect.soft(words(label), `${service}: ${label}`).toBeLessThanOrEqual(3)
    }
  }
  await settings.getByRole('button', { name: 'Summary', exact: true }).click()
  await settings.getByRole('button', { name: 'Turn off Summary' }).click()
  const asking = page.locator('dialog.confirm')
  await expect(asking.getByRole('heading')).toHaveText('Turn off Summary?')
  await expect(asking.getByRole('button', { name: 'Turn off' })).toBeVisible()
  await expect(asking.locator('p')).toHaveCount(0)
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

test('an Undo toast stays clear of Reply and Forward', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch on Friday', text: 'Shall we?' }), { arrived: earlier(2) })
  gmail.add(rawMail({ subject: 'Your receipt', text: 'Thanks.' }), { arrived: earlier(1) })
  await signIn(run)
  await page.locator('.threads').getByText('Lunch on Friday').click()
  const reply = page.getByRole('button', { name: 'Reply', exact: true })
  const forward = page.getByRole('button', { name: 'Forward', exact: true })
  await expect(reply).toBeVisible()
  await page.locator('.threads').getByText('Your receipt').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  const toast = page.locator('.toast')
  await expect(toast).toContainText('Undo')
  const box = await toast.boundingBox()
  for (const button of [reply, forward]) {
    const under = await button.boundingBox()
    if (!box || !under) throw new Error('no box to compare')
    const apart = box.x + box.width <= under.x || under.x + under.width <= box.x || box.y + box.height <= under.y || under.y + under.height <= box.y
    expect(apart, `the toast ${JSON.stringify(box)} covers ${JSON.stringify(under)}`).toBe(true)
  }
})
