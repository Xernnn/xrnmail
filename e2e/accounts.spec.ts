import { expect, test } from '@playwright/test'
import { FakeGmail, rawMail } from '../tests/fake-gmail'
import { hhmm, launch, later, signIn, syncAndSettle, type Running } from './app'

/** The real app, with an account on a plain folder server beside a Gmail one where a test needs it. */

const earlier = (hours: number): Date => new Date(Date.now() - hours * 3_600_000)
const ONE_PIXEL = '<img src="https://track.example/o.gif" width="1" height="1"><p>Hello there</p>'

let run: Running

test.afterEach(async () => run?.stop())

test('a plain server: choosing the service, entering its details, and reading folders', async () => {
  const plain = new FakeGmail({ plain: true, folders: ['Work'] })
  plain.add(rawMail({ subject: 'In the inbox' }), { arrived: earlier(3) })
  plain.add(rawMail({ subject: 'Filed under work' }), { box: 'Work', arrived: earlier(3) })
  run = await launch({ gmail: plain })
  const { page } = run
  await page.getByLabel('Email address').fill('me@mail.example')
  await page.getByRole('radio', { name: 'Other' }).click()
  await page.getByLabel('Password').fill(plain.secret)
  await page.getByLabel('Incoming server').fill('imap.mail.example')
  await page.getByLabel('Outgoing server').fill('smtp.mail.example')
  await page.getByLabel('Outgoing port').fill('587')
  await page.getByLabel('Outgoing security').selectOption('starttls')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('In the inbox')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await expect(page.getByText('Filed under work')).toBeVisible()
  // A folder of its own, made from Edit Menu, is a folder on the server, read from then on.
  await page.locator('.sidebar-foot .status').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
  await page.getByRole('button', { name: 'New Folder on me@mail.example' }).click()
  const making = page.getByRole('dialog', { name: 'New Folder' })
  await making.getByLabel('Name').fill('Receipts')
  await making.getByRole('button', { name: 'Create New' }).click()
  await expect(page.getByText('Made the folder Receipts')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Mailboxes on me@mail.example' }).getByRole('listitem')).toHaveText(['Receipts', 'Work'])
  await page.locator('.sidebar').getByRole('button', { name: 'Done' }).click()
  expect(plain.box('Receipts').mails).toEqual([])
  plain.add(rawMail({ subject: 'Filed under receipts' }), { box: 'Receipts' })
  await page.getByRole('button', { name: /^Sync/ }).click()
  await page.getByRole('button', { name: 'Receipts', exact: true }).click()
  await expect(page.getByText('Filed under receipts')).toBeVisible()
})

test('moving, deleting and restoring on a folder server', async () => {
  const plain = new FakeGmail({ plain: true, folders: ['Work'] })
  plain.add(rawMail({ subject: 'Move me' }), { arrived: earlier(3) })
  run = await launch({ gmail: plain })
  const { page } = run
  await page.evaluate((secret) => window.mail.addAccount({
    email: 'me@mail.example', secret, provider: 'other',
    imap: { host: 'imap.mail.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.example', port: 465, security: 'tls' }
  }), plain.secret)
  await page.getByText('Move me').first().click()
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in Gmail' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Move to', exact: true }).click()
  await page.getByRole('button', { name: 'Work', exact: true }).last().click()
  await expect.poll(() => plain.box('Work').mails.length, { timeout: 20_000 }).toBe(1)
  await page.getByRole('button', { name: 'Work', exact: true }).first().click()
  await page.getByText('Move me').first().click()
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click()
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(page.getByText('Move me').first()).toBeVisible()
  await page.getByText('Move me').first().click()
  await page.getByRole('button', { name: 'Move to Inbox' }).first().click()
  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click()
  await expect(page.getByText('Move me').first()).toBeVisible()
})

test('Spam and Trash can be read, and deleting from them is forever only when confirmed', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Actually fine' }), { box: '[Gmail]/Spam', arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Gone for good' }), { box: '[Gmail]/Trash', arrived: earlier(3) })
  await signIn(run)
  await page.getByRole('button', { name: /^Spam( \d+)?$/ }).click()
  await page.getByText('Actually fine').click()
  await expect(page.locator('.main').getByRole('button', { name: 'Archive' })).toHaveCount(0) // the sidebar has an Archive of its own
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByText('Gone for good').click()
  await page.getByRole('button', { name: 'Delete forever' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { name: 'Gone for good' })).toBeVisible()
  await page.getByRole('button', { name: 'Delete forever' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete forever' }).click()
  await expect.poll(() => gmail.box('[Gmail]/Trash').mails.length, { timeout: 20_000 }).toBe(0)
})

test('Focused and Other, and keeping a sender on one side', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Bo <bo@example.com>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Weekly deals', from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: earlier(3) })
  await signIn(run)
  await expect(page.getByText('Lunch?')).toBeVisible()
  await expect(page.getByText('Weekly deals')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Other/ })).toContainText('1')
  await page.getByRole('button', { name: /^Other/ }).click()
  await page.getByText('Weekly deals').first().click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Keep this sender in Focused' }).click()
  await page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.getByText('Weekly deals').first()).toBeVisible()
})

test('All Inboxes is every inbox, whole: Focused and Other are each account\'s own', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Bo <bo@example.com>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Weekly deals', from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: earlier(2) })
  await signIn(run)
  await page.evaluate((secret) => window.mail.addAccount({ email: 'second@example.com', secret, provider: 'gmail' }), gmail.secret)
  const side = page.locator('.sidebar')
  const list = page.locator('.threads')
  const tabs = page.getByRole('group', { name: 'Focused and Other' })
  await side.getByRole('button', { name: /^All Inboxes/ }).click()
  // Both accounts read the same fake server, so each message is there once for each.
  await expect(list.getByText('Weekly deals')).toHaveCount(2, { timeout: 15_000 })
  await expect(list.getByText('Lunch?')).toHaveCount(2)
  await expect(tabs).toHaveCount(0)
  await expect(page.locator('.view-title')).toHaveText('All Inboxes')
  await expect(side.getByRole('button', { name: /^All Inboxes/ }).locator('.nav-count')).toHaveText('4')

  // An account's own inbox still splits, and counts only its own Other.
  await side.getByRole('button', { name: /^second@example\.com/ }).click()
  await expect(tabs).toBeVisible()
  await expect(list.getByText('Lunch?')).toHaveCount(1)
  await expect(list.getByText('Weekly deals')).toHaveCount(0)
  await expect(tabs.getByRole('button', { name: /^Other/ })).toHaveText('Other (1)')
  await tabs.getByRole('button', { name: /^Other/ }).click()
  await expect(list.getByText('Weekly deals')).toHaveCount(1)
  await page.locator('.threads').getByText('Weekly deals').click()
  await page.getByRole('button', { name: 'Mark unread' }).waitFor()
  await side.getByRole('button', { name: /^me@example\.com/ }).click()
  await expect(tabs.getByRole('button', { name: /^Other/ })).toHaveText('Other (1)')
  await side.getByRole('button', { name: /^second@example\.com/ }).click()
  await expect(tabs.getByRole('button', { name: /^Other/ })).toHaveText('Other')

  // One account: its inbox is the only one, and keeps the split.
  await page.evaluate(() => window.mail.removeAccount('second@example.com'))
  await side.getByRole('button', { name: /^Inbox/ }).click()
  await expect(tabs).toBeVisible()
})

test('the Assistant: parcels, and a Track link that was never in the message', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({
    subject: 'Your order has shipped',
    html: '<a href="https://evil.example/track">Track it</a><p>Number 1Z999AA10123456784</p>'
  }), { arrived: earlier(3) })
  await signIn(run)
  await page.getByRole('button', { name: 'Packages' }).click()
  await page.getByText('Your order has shipped').first().click()
  await page.getByRole('button', { name: 'Track' }).click()
  await expect.poll(run.opened).toHaveLength(1)
  expect((await run.opened())[0]).toMatch(/^https:\/\/www\.ups\.com\//)
})

test('subscriptions list who mails in bulk, and a sender can be cleared with Undo', async () => {
  run = await launch()
  const { page, gmail } = run
  const headers = ['List-Unsubscribe: <https://list.example/u>']
  gmail.add(rawMail({ subject: 'One', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Two', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(2) })
  await signIn(run)
  await page.getByRole('button', { name: 'Subscriptions' }).click()
  await expect(page.getByText('2 messages')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unsubscribe from hi@shop.example' })).toBeVisible()
  await page.getByRole('button', { name: 'Unsubscribed', exact: true }).click() // the other side: who was left already
  await expect(page.getByText('Nobody yet')).toBeVisible()
  await expect(page.locator('.band h1')).toHaveText('Subscriptions')
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Subscriptions' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Subscribed', exact: true }).click()
  await expect(page.getByText('2 messages')).toBeVisible()
  await page.getByRole('button', { name: 'Delete all from hi@shop.example' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete all' }).click()
  await expect(page.getByText('Moved 2 messages to Trash')).toBeVisible()
  await expect(page.getByText('No subscriptions')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('2 messages')).toBeVisible()
})

test('the Summary: a sender goes in from Subscriptions, its mail waits for the time chosen, and lands together apart from the inbox', async () => {
  run = await launch()
  const { page, gmail } = run
  const headers = ['List-Unsubscribe: <https://list.example/u>']
  gmail.add(rawMail({ subject: 'One', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Two', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(2) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveBatch({ times: [], vip: [], earlyPerDay: 1 })) // nothing else waits
  await page.evaluate(() => window.mail.saveProfile({ focused: false })) // one inbox, bulk mail and all
  const side = page.locator('.sidebar')
  const list = page.locator('.threads')
  await side.getByRole('button', { name: 'Subscriptions' }).click()
  await page.getByRole('button', { name: 'Add hi@shop.example to Summary' }).click()
  // The first sender in asks when the Summary should land.
  const asking = page.getByRole('dialog', { name: 'When your Summary arrives' })
  await expect(asking.getByRole('radio', { name: /Morning/ })).toBeChecked()
  await asking.getByRole('button', { name: 'Weekly' }).click()
  await expect(asking.getByLabel('Summary day')).toHaveValue('1')
  await asking.getByRole('button', { name: 'Daily' }).click()
  const at = hhmm(Date.now() + 120_000)
  await asking.getByRole('radio', { name: 'Pick a time' }).check()
  await asking.getByLabel('Summary time').fill(at)
  await asking.getByRole('button', { name: 'Schedule' }).click()
  await expect(page.getByText('hi@shop.example goes into your Summary')).toBeVisible()
  await expect(page.getByText('No subscriptions')).toBeVisible() // it has a side of its own now
  await page.getByRole('group', { name: 'Sides of Subscriptions' }).getByRole('button', { name: 'Summary' }).click()
  await expect(page.locator('.summary-bar')).toContainText(`Delivered daily at ${at}`)
  await expect(page.getByRole('button', { name: /Latest Summary/ })).toContainText('Nothing has landed yet')
  await expect(page.locator('.subscription')).toContainText('2 messages')
  await expect(page.getByRole('button', { name: 'Remove hi@shop.example from Summary' })).toBeVisible()
  expect((await page.evaluate(() => window.mail.settings())).summary).toMatchObject({ senders: ['hi@shop.example'], every: 'daily', time: at, chosen: true })

  // What came before stays where it was. What comes now waits for the Summary, whatever the batches say.
  await side.getByRole('button', { name: /^Inbox/ }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Two', 'One'])
  gmail.add(rawMail({ subject: 'Three', from: 'Shop <hi@shop.example>', headers }))
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Ada <ada@example.com>' }))
  await syncAndSettle(page)
  await expect(list.getByText('Lunch?')).toBeVisible()
  await expect(list.getByText('Three')).toHaveCount(0)
  await side.getByRole('button', { name: 'Summary', exact: true }).click()
  await expect(page.locator('.view-title')).toHaveText('Summary')
  await expect(page.locator('.summary-bar')).toContainText(`1 waiting for Today, ${at}`)
  await expect(page.getByText('No Summary here')).toBeVisible()

  // Its time comes: it lands as one, out of the inbox, with a notice at the top of it.
  await later(run, 180_000)
  await side.getByRole('button', { name: /^Inbox/ }).click()
  const notice = page.getByRole('button', { name: /Your Summary/ })
  await expect(notice).toContainText('1 thread from Shop', { timeout: 15_000 })
  await expect(list.getByText('Three')).toHaveCount(0)
  await expect(side.getByRole('button', { name: /^Summary/ }).locator('.nav-count')).toHaveText('1')
  await notice.click()
  await expect(page.locator('.view-title')).toHaveText('Summary')
  await expect(page.locator('.summary-head')).toContainText(`Today, ${at} · 1 thread`)
  await list.getByText('Three').click()
  await expect(page.locator('.thread-subject')).toHaveText('Three')
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Remove sender from Summary' })).toBeVisible()
  await page.keyboard.press('Escape')
  await side.getByRole('button', { name: /^Inbox/ }).click()
  await expect(notice).toHaveCount(0) // read, so there's nothing left to tell
  await side.getByRole('button', { name: 'Summary', exact: true }).click()
  await page.locator('.summary-head').getByRole('button', { name: 'Delete all' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete all' }).click()
  await expect(page.getByText('Moved to Trash')).toBeVisible()
  await expect(page.getByText('No Summary here')).toBeVisible()

  // Turned off in Settings, its sender goes back to Subscribed.
  await page.locator('.summary-bar').getByRole('button', { name: 'Change' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'Summary' })).toBeVisible()
  await expect(settings.getByRole('radio', { name: 'Pick a time' })).toBeChecked()
  await settings.getByRole('button', { name: 'Turn off Summary' }).click()
  await page.locator('dialog.confirm').getByRole('button', { name: 'Turn off' }).click()
  await expect(settings.getByText('Nobody is in it yet')).toBeVisible()
  await settings.getByRole('button', { name: 'Done' }).click()
  await side.getByRole('button', { name: 'Subscriptions' }).click()
  await expect(page.getByRole('button', { name: 'Add hi@shop.example to Summary' })).toBeVisible()
})

test('warnings, and a tracker that never gets to load', async () => {
  const hits: string[] = []
  run = await launch()
  const { page, gmail, app } = run
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://track.example/*'] }, (details, callback) => {
      (globalThis as unknown as { tracked: string[] }).tracked = [details.url]
      callback({ cancel: true })
    })
  })
  gmail.add(rawMail({
    subject: 'Account notice', from: 'Bank <x@evil.example>', html: `${ONE_PIXEL}<img src="https://cdn.example/logo.png" width="200">`,
    headers: ['Authentication-Results: mx; dmarc=fail']
  }), { arrived: earlier(3) })
  await signIn(run)
  await page.getByText('Account notice').first().click()
  await expect(page.getByRole('alert')).toContainText('failed the checks')
  await expect(page.getByText('1 tracker removed')).toBeVisible()
  await page.getByRole('button', { name: 'Show images' }).click()
  const frame = page.frameLocator('iframe')
  await expect(frame.getByText('Hello there')).toBeVisible()
  expect(await frame.locator('img[src*="track.example"]').count()).toBe(0)
  hits.push(...await app.evaluate(() => (globalThis as unknown as { tracked?: string[] }).tracked ?? []))
  expect(hits).toEqual([])
})

test('the look can be set, and sticks', async () => {
  run = await launch({ colorScheme: 'light' })
  const { page } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByLabel('Theme').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
