import { expect, test, type Page } from '@playwright/test'
import { readFileSync, truncateSync, writeFileSync } from 'node:fs'
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

test('stars and labels reach Gmail', async () => {
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
  await page.getByRole('button', { name: 'Starred', exact: true }).click()
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
  await page.getByRole('button', { name: 'Writing' }).click()
  await page.getByLabel('Your name').fill('Sơn Nguyễn')
  await page.getByLabel('Signature').fill('Sent from xrnmail')
  await page.getByLabel('Your name').click()
  await page.getByRole('button', { name: 'Done' }).click()
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
  for (const subject of ['Menu me', 'Drag me', 'Swipe me']) gmail.add(rawMail({ subject }), { arrived: earlier(5) })
  await signIn(run)
  const threads = page.locator('.threads')
  await threads.getByText('Menu me').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(threads.getByText('Menu me')).toHaveCount(0)
  await threads.getByText('Drag me').dragTo(page.getByRole('button', { name: 'Trash', exact: true }))
  await expect(threads.getByText('Drag me')).toHaveCount(0)
  await threads.getByText('Swipe me').hover()
  await page.mouse.wheel(200, 0)
  await expect(threads.getByText('Swipe me')).toHaveCount(0)
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

test('settings can be searched', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Search settings').fill('swipe')
  await expect(page.getByLabel('Swipe left')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Batches' })).toHaveCount(0)
})
