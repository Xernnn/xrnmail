import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeGmail, rawMail } from '../tests/fake-gmail'
import { hhmm, launch, later, ME, signIn, syncAndSettle, type Running } from './app'
import { png, svgLogo } from './pictures'

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
  // Several at once, from the ⋮ on the bar under a selection.
  plain.add(rawMail({ subject: 'Me too' }), { arrived: earlier(2) })
  await syncAndSettle(page)
  await page.getByLabel('Select Move me').check({ force: true })
  await page.getByLabel('Select Me too').check({ force: true })
  const bar = page.getByRole('toolbar', { name: 'Selected threads' })
  await bar.getByRole('button', { name: 'More for the selected' }).click()
  await bar.getByRole('button', { name: 'Move to…', exact: true }).click()
  await bar.getByRole('button', { name: 'Work', exact: true }).click()
  await expect(page.getByText('Moved to Work: 2 threads')).toBeVisible()
  await expect.poll(() => plain.box('Work').mails.length, { timeout: 20_000 }).toBe(2)
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
  await page.evaluate(() => window.mail.saveProfile({ focused: true }))
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

test('a new profile has the inbox in one piece: all its mail is there and nothing speaks of Other', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Bo <bo@example.com>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Weekly deals', from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: earlier(3) })
  await signIn(run)
  await page.getByRole('button', { name: /^Inbox/ }).click()
  const list = page.locator('.threads')
  await expect(list.getByText('Lunch?')).toBeVisible()
  await expect(list.getByText('Weekly deals')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Focused and Other' })).toHaveCount(0)
  await list.getByText('Weekly deals').click()
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Mark as important' })).toBeVisible() // the menu is open
  await expect(page.getByRole('button', { name: /^Keep this sender in (Focused|Other)$/ })).toHaveCount(0)
})

test('All Inboxes is every inbox, whole: Focused and Other are each account\'s own', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Bo <bo@example.com>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Weekly deals', from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: earlier(2) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: true }))
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

test('the account a thread is in shows as a broad bar of its colour, in every list and over the thread', async () => {
  run = await launch({ colorScheme: 'dark' })
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Lunch?', from: 'Bo <bo@example.com>' }), { arrived: earlier(3) })
  await signIn(run)
  await page.evaluate((secret) => window.mail.addAccount({ email: 'second@example.com', secret, provider: 'gmail' }), gmail.secret)
  await page.evaluate(() => window.mail.saveProfile({ identities: {
    'me@example.com': { name: '', signature: '', aliases: [], color: '#b4532a', notify: true },
    'second@example.com': { name: '', signature: '', aliases: [], color: '#2f6fb2', notify: true }
  } }))
  const side = page.locator('.sidebar')
  const marks = page.locator('.threads .account-mark')
  const looks = async (): Promise<{ width: number; height: number; color: string }[]> => marks.evaluateAll((all) => all.map((el) => {
    const box = el.getBoundingClientRect()
    return { width: box.width, height: box.height, color: getComputedStyle(el).backgroundColor }
  }))
  await side.getByRole('button', { name: /^All Inboxes/ }).click()
  await expect(marks).toHaveCount(2, { timeout: 15_000 })
  for (const look of await looks()) {
    expect(look.width).toBeGreaterThanOrEqual(6)
    expect(look.height).toBeGreaterThan(40)
  }
  expect((await looks()).map((look) => look.color).sort()).toEqual(['rgb(180, 83, 42)', 'rgb(47, 111, 178)'])

  await page.locator('.threads .thread', { has: page.locator('.account-mark[title="second@example.com"]') }).getByText('Lunch?').click()
  const bar = page.locator('.thread-head .account-bar')
  await expect(bar).toHaveCSS('background-color', 'rgb(47, 111, 178)')
  expect((await bar.boundingBox())?.width).toBeGreaterThanOrEqual(6)
  await expect(page.locator('.reader-account')).toContainText('second@example.com')

  // The same bar wherever several accounts share a list.
  await side.getByRole('button', { name: 'Recently Seen', exact: true }).click()
  await expect(marks).toHaveCount(1)
  await page.getByLabel('Search').fill('Lunch')
  await expect(marks).toHaveCount(2)
  await page.getByLabel('Search').fill('')
  await side.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('region', { name: 'Compose' }).getByLabel('Subject').fill('Plans')
  await page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: 'Close' }).click()
  await side.getByRole('button', { name: /^All Drafts/ }).click()
  await expect(page.locator('.threads .account-mark')).toHaveCount(1)
})

test('faces: a person\'s photo, a company\'s logo, initials otherwise, your own photo, and never a lookup for opening a message', async () => {
  run = await launch({
    pictures: {
      'logo:offers.example': svgLogo('#0f766e', 'O'),
      'photo:mai@example.com': png(96, [40, 90, 160]),
      'photo:linh@example.com': png(96, [160, 90, 40]),
      [`photo:${ME}`]: png(96, [150, 60, 40]),
      'photo:x@bank-login.example': png(96, [20, 120, 60]),
      'logo:shop.example': svgLogo('#c2410c', 'S'),
      'logo:bank-login.example': svgLogo('#1d4ed8', 'B')
    }
  })
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Trip', from: 'Linh Pham <linh@example.com>', text: 'Bus at seven?' }), { arrived: earlier(5), thread: 61n })
  gmail.add(rawMail({ subject: 'Re: Trip', from: 'Mai Tran <mai@example.com>', text: 'Yes!' }), { arrived: earlier(4), thread: 61n })
  gmail.add(rawMail({
    subject: 'Deals', from: 'Shop <news@e.shop.example>',
    headers: ['Authentication-Results: mx.google.com; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=b@shop.example; dmarc=pass header.from=e.shop.example']
  }), { arrived: earlier(3) })
  // A company's logo is there for this domain too, but nothing proves the mail is the company's.
  gmail.add(rawMail({ subject: 'Offers', from: 'Offers <hi@offers.example>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Plain', from: 'Bo <bo@example.com>' }), { arrived: earlier(2) })
  gmail.add(rawMail({ subject: 'Locked', from: 'Bank <x@bank-login.example>', headers: ['Authentication-Results: mx.example; dmarc=fail'] }), { arrived: earlier(1) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveProfile({ focused: false }))
  const face = (subject: string): ReturnType<typeof page.locator> => page.locator('.threads .thread', { hasText: subject }).locator('.avatar')
  await expect(face('Re: Trip').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 15_000 })
  await expect(face('Re: Trip')).not.toHaveClass(/logo/)
  await expect(face('Deals').locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  await expect(face('Deals')).toHaveClass(/logo/)
  await expect(face('Offers')).toHaveText('O')
  await expect(face('Offers').locator('img')).toHaveCount(0)
  await expect(face('Plain')).toHaveText('B') // nobody has a picture for Bo
  await expect(face('Plain').locator('img')).toHaveCount(0)
  // A sender with a warning shows initials, whatever pictures there are for their address.
  await expect(face('Locked')).toHaveText('B')
  await expect(face('Locked').locator('img')).toHaveCount(0)
  // Your own account, in the sidebar.
  await expect(page.locator('.sidebar .account-face img')).toHaveAttribute('src', /^data:image\/png/)

  // Everyone a row names is looked up while it's in the list, so opening the thread shows their faces
  // and asks for nothing that could be looked up: when it's read is nobody's business.
  const lookups = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { pictureLookups: string[] }).pictureLookups.slice())
  const asks = (): Promise<[string[], boolean][]> => app.evaluate(() => (globalThis as unknown as { faceAsks: [string[], boolean][] }).faceAsks.slice())
  await expect.poll(lookups).toContain('photo:linh@example.com')
  await page.waitForTimeout(500)
  const [before, askedBefore] = [await lookups(), (await asks()).length]
  await page.locator('.threads').getByText('Re: Trip').click()
  await page.locator('.messages').getByText('Bus at seven?').waitFor()
  await expect(page.locator('.message.open .avatar img')).toHaveCount(2)
  await page.waitForTimeout(600)
  expect(await lookups()).toEqual(before)
  expect((await asks()).slice(askedBefore).filter(([, lookUp]) => lookUp)).toEqual([])
  expect(before).not.toContain('logo:offers.example')

  // Mail that has arrived but waits for its batch isn't in any list, and its sender is asked about
  // by nobody: a lookup as it arrived told them it had.
  gmail.add(rawMail({ subject: 'Waiting', from: 'Kim <kim@example.com>' }), { arrived: new Date() })
  await syncAndSettle(page)
  await page.waitForTimeout(600)
  expect(await lookups()).toEqual(before)

  // A photo of your own, chosen from a file, kept here.
  const chosen = join(run.savedTo, '..', 'me.png')
  writeFileSync(chosen, png(400, [200, 160, 20]))
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, chosen)
  const was = await page.locator('.sidebar .account-face img').getAttribute('src')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Accounts' }).click()
  await page.getByRole('button', { name: `Choose a photo for ${ME}` }).click()
  await expect(page.getByRole('button', { name: `Remove the photo of ${ME}` })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => page.locator('.sidebar .account-face img').getAttribute('src')).not.toBe(was)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Accounts' }).click()
  await page.getByRole('button', { name: `Remove the photo of ${ME}` }).click()
  await expect(page.getByRole('button', { name: `Choose a photo for ${ME}` })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => page.locator('.sidebar .account-face img').getAttribute('src')).toBe(was)

  // Faces off: initials for everyone, your own Gravatar too, and nothing looked up.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'General' }).click()
  await page.getByLabel('Show faces').uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(face('Re: Trip').locator('img')).toHaveCount(0)
  await expect(face('Deals').locator('img')).toHaveCount(0)
  await expect(page.locator('.sidebar .account-face img')).toHaveCount(0)
  const off = await lookups()
  gmail.add(rawMail({ subject: 'New face', from: 'Lan <lan@example.com>' }), { arrived: earlier(1) })
  await syncAndSettle(page)
  await expect(page.locator('.threads').getByText('New face')).toBeVisible()
  await page.waitForTimeout(600)
  expect(await lookups()).toEqual(off)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'General' }).click()
  await page.getByLabel('Show faces').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(face('Re: Trip').locator('img')).toHaveAttribute('src', /^data:image\/png/)
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

// Subscriptions were squeezed into the list's column, with an empty reader beside them that nothing
// there could ever open.
test('Subscriptions take the whole width beside the sidebar, and a sender\'s page brings the reader back', async () => {
  run = await launch({ size: [1280, 840] })
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Deals', from: 'Shop <hi@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: earlier(3) })
  await signIn(run)
  const list = page.locator('section.list')
  const reader = page.locator('.reader')
  await expect(reader).toBeVisible()
  await page.getByRole('button', { name: 'Subscriptions' }).click()
  await expect(page.getByText('1 message', { exact: false }).first()).toBeVisible()
  await expect(reader).toBeHidden()
  const [panes, column] = [await page.locator('.panes').boundingBox(), await list.boundingBox()]
  expect(column?.width).toBe(panes?.width)
  await page.getByRole('button', { name: 'Open Shop' }).click()
  await expect(page.locator('.view-title')).toHaveText('Shop')
  await expect(reader).toBeVisible()
  expect((await list.boundingBox())?.width).toBeLessThan(600)
})

test('subscriptions: how much of each sender is read, several put into the Summary at once, and a page for each sender', async () => {
  run = await launch()
  const { page, gmail } = run
  const headers = ['List-Unsubscribe: <https://list.example/u>']
  gmail.add(rawMail({ subject: 'Deals one', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(24 * 9), flags: ['\\Seen'] }) // more than a week ago
  gmail.add(rawMail({ subject: 'Deals two', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(20) })
  gmail.add(rawMail({ subject: 'Deals three', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(10) })
  gmail.add(rawMail({ subject: 'Letter', from: 'Post <news@post.example>', headers }), { arrived: earlier(5), flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Tips', from: 'Tips <tips@daily.example>', headers }), { arrived: earlier(4) })
  await signIn(run)
  await page.getByRole('button', { name: 'Subscriptions' }).click()
  const shop = page.locator('.subscription', { hasText: 'hi@shop.example' })
  await expect(shop.locator('.open-rate')).toHaveText('33%') // one of three read
  await expect(page.locator('.subscription', { hasText: 'news@post.example' }).locator('.open-rate')).toHaveText('100%')
  const names = page.locator('.subscription strong')
  await expect(names).toHaveText(['Shop', 'Tips', 'Post']) // the most mail first
  await page.getByLabel('Sort by').selectOption('read')
  await expect(names).toHaveText(['Post', 'Shop', 'Tips'])
  await page.getByLabel('Sort by').selectOption('name')
  await expect(names).toHaveText(['Post', 'Shop', 'Tips'])
  await page.getByLabel('Sort by').selectOption('most')

  // Two picked by their tick boxes, and put into the Summary from the bar at the foot.
  await shop.hover()
  await page.getByLabel('Select hi@shop.example').check()
  await page.getByLabel('Select tips@daily.example').check()
  const bar = page.getByRole('toolbar', { name: 'Selected senders' })
  await expect(bar).toContainText('2 selected')
  await bar.getByRole('button', { name: 'Add to Summary' }).click()
  await page.getByRole('dialog', { name: 'When your Summary arrives' }).getByRole('button', { name: 'Schedule' }).click()
  await expect(page.getByText('2 senders go into your Summary')).toBeVisible()
  await expect(bar).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.mail.settings())).summary.senders.slice().sort()).toEqual(['hi@shop.example', 'tips@daily.example'])
  await expect(page.locator('.subscription')).toHaveCount(1) // only the one left out stays on this side
  await page.getByRole('group', { name: 'Sides of Subscriptions' }).getByRole('button', { name: 'Summary' }).click()
  await expect(page.locator('.subscription')).toHaveCount(2)

  // A sender's page: how much they send, how much is read, what to do, and their threads.
  await page.getByRole('button', { name: 'Open Shop' }).click()
  await expect(page.locator('.view-title')).toHaveText('Shop')
  const card = page.locator('.sender-card')
  await expect(card.getByRole('definition')).toHaveText(['emails here', 'in the last week', 'read'])
  await expect(card.getByRole('term')).toHaveText(['3', '2', '33%'])
  await expect(card.getByRole('button', { name: 'Remove from Summary' })).toBeVisible()
  await expect(page.locator('.threads .thread .subject')).toHaveText(['Deals three', 'Deals two', 'Deals one'])
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Subscriptions' })).toHaveAttribute('aria-current', 'page')
  await page.locator('.threads').getByText('Deals two').click()
  await expect(page.locator('.thread-subject')).toHaveText('Deals two')
  await expect(card.getByRole('term')).toHaveText(['3', '2', '67%']) // opening it read it
  await card.getByRole('button', { name: '‹ Subscriptions' }).click()
  await expect(page.getByRole('group', { name: 'Sides of Subscriptions' }).getByRole('button', { name: 'Summary' })).toHaveAttribute('aria-pressed', 'true')
})

test('the Summary: a sender goes in from Subscriptions, its mail waits for the time chosen, and lands together apart from the inbox', async () => {
  run = await launch()
  const { page, gmail } = run
  const headers = ['List-Unsubscribe: <https://list.example/u>']
  gmail.add(rawMail({ subject: 'One', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Two', from: 'Shop <hi@shop.example>', headers }), { arrived: earlier(2) })
  await signIn(run)
  await page.evaluate(() => window.mail.saveBatch({ live: true, times: [], vip: [], earlyPerDay: 1 })) // nothing else waits
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
  await expect(page.getByRole('button', { name: /Latest Summary/ })).toContainText('None yet')
  await expect(page.locator('.subscription')).toContainText('2 messages')
  await expect(page.getByRole('button', { name: 'Remove hi@shop.example from Summary' })).toBeVisible()
  expect((await page.evaluate(() => window.mail.settings())).summary).toMatchObject({ senders: ['hi@shop.example'], every: 'daily', time: at, chosen: true })

  // What came before stays where it was. What comes now waits for the Summary, whatever the batches say.
  await side.getByRole('button', { name: /^Inbox/ }).click()
  await expect(list.locator('.thread .subject')).toHaveText(['Two', 'One'])
  // Servers date mail to the second, and mail dated within the second the account was first read
  // counts as from before it, which never waits. All of the above can take less than that.
  await new Promise((resolve) => setTimeout(resolve, 1200))
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
  await expect(settings.getByText('No senders', { exact: true })).toBeVisible()
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

  // U+202E in a name showed it backwards, as "security@paypal.com", and nothing warned.
  gmail.add(rawMail({ subject: 'Security check', from: '=?UTF-8?Q?=E2=80=AEmoc=2Elapyap=40ytiruces?= <attacker@evil.example>' }), { arrived: earlier(1) })
  await syncAndSettle(page)
  await page.locator('.threads').getByText('Security check').click()
  await expect(page.getByRole('alert')).toContainText('hides characters')
  const name = page.locator('.message.open .who-name strong bdi')
  await expect(name).toHaveText('moc.lapyap@ytiruces')
  expect(await name.evaluate((element) => element.textContent?.includes('\u202E'))).toBe(false)
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
