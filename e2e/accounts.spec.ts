import { expect, test } from '@playwright/test'
import { FakeGmail, rawMail } from '../tests/fake-gmail'
import { launch, signIn, type Running } from './app'

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
  await page.getByRole('button', { name: 'Delete all from hi@shop.example' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete all' }).click()
  await expect(page.getByText('Moved 2 messages to Trash')).toBeVisible()
  await expect(page.getByText('No subscriptions')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('2 messages')).toBeVisible()
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
  await page.getByLabel('Look').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
