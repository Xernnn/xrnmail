import { test } from '@playwright/test'
import { rawMail } from '../tests/fake-gmail'
import { hhmm, launch, later, signIn, syncAndSettle } from './app'
import { png, svgLogo } from './pictures'
import type { FakeGmail } from '../tests/fake-gmail'

/** Pictures of the app with made-up mail, for looking at it: SHOTS=<folder> npx playwright test shots */
const folder = process.env['SHOTS']
test.skip(!folder, 'only when SHOTS is set')

const ago = (hours: number): Date => new Date(Date.now() - hours * 3_600_000)

const NEWSLETTER = `<html><head><style>
  .wrap { max-width: 560px; margin: 0 auto; font-family: Georgia, serif; }
  h1 { color: #1c4e80; } .cta { display: inline-block; padding: 10px 18px; background: #1c4e80; color: #fff; border-radius: 6px; text-decoration: none; }
  </style></head><body><div class="wrap">
  <h1>The week in small tools</h1>
  <p>Three things worth reading this week, and one worth building.</p>
  <img src="https://example.invalid/banner.png" alt="Banner" width="560" height="120">
  <p><a class="cta" href="https://example.com/read">Read it</a></p>
  </div></body></html>`

const RECEIPT = `<html><body style="margin:0;background:#f4f4f4"><table width="100%" bgcolor="#f4f4f4"><tr><td align="center">
  <table width="520" bgcolor="#ffffff" cellpadding="24"><tr><td style="font-family:Arial,sans-serif;color:#222">
  <h2 style="margin:0 0 8px">Thanks for your order</h2><p>Order 48213 is confirmed and on its way.</p>
  <table width="100%" cellpadding="6" style="border-top:1px solid #ddd"><tr><td>Cold brew, 2 bottles</td><td align="right">180,000 VND</td></tr><tr><td>Delivery</td><td align="right">65,000 VND</td></tr><tr><td><b>Total</b></td><td align="right"><b>245,000 VND</b></td></tr></table>
  </td></tr></table></td></tr></table></body></html>`

/** A shop's offer: a pale page, a coloured band, a button, and grey small print. */
const PROMO = `<div style="background:#f3f4f1;padding:24px 0"><table width="560" align="center" bgcolor="#ffffff" cellpadding="0" style="border:1px solid #e3e5df;border-radius:10px;font-family:Helvetica,Arial,sans-serif">
  <tr><td bgcolor="#ffd84d" style="padding:22px 28px;color:#3a2f00"><b style="font-size:20px">Fresh this weekend</b><br>Strawberries are back, and so is the Sunday market.</td></tr>
  <tr><td style="padding:22px 28px;color:#2b2d2a"><p>Order by Friday noon and we'll bring it on Saturday morning. Members get 10% off everything green.</p>
  <p><a href="https://greenmarket.example/shop" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#2f7d32;color:#ffffff;text-decoration:none">Shop the market</a></p>
  <hr style="border:0;border-top:1px solid #e3e5df"><p style="color:#8a8f86;font-size:12px">You're getting this because you joined Green Market. <a href="https://greenmarket.example/u" style="color:#8a8f86">Unsubscribe</a></p></td></tr></table></div>`

/** A newsletter that's dark already. */
const DIGEST = `<div style="background:#14161c;color:#c9ccd3;padding:28px;font-family:Georgia,serif"><h1 style="color:#ffffff;margin-top:0">The night digest</h1>
  <p>Four long reads for a slow evening, and a photograph of the moon.</p><p><a href="https://nightowl.example/read" style="color:#f5b942">Start reading</a></p></div>`

const REPLY_HTML = `<div dir="ltr">Works for me. Let's keep it to thirty minutes, and I'll send the notes after.</div>
  <br><div class="gmail_quote"><div class="gmail_attr">On Tue, Mai Tran wrote:</div>
  <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><div>Can we move the review to Thursday?</div></blockquote></div>`

/** What a receiving server writes on top of a message, for its details. */
const DELIVERED = [
  'Delivered-To: me@example.com',
  'Received: from mail.coffee.example (mail.coffee.example [192.0.2.10]) by mx.google.com with ESMTPS id 7 (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384)',
  'Authentication-Results: mx.google.com; dkim=pass header.i=@coffee.example; spf=pass smtp.mailfrom=bounces@mail.coffee.example; dmarc=pass header.from=coffee.example'
].join('\n')

function fill(gmail: FakeGmail): void {
  gmail.add(rawMail({ subject: 'Design review', from: 'Mai Tran <mai@example.com>', text: 'Can we move the review to Thursday?' }), { arrived: ago(14), thread: 88n, flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Re: Design review', from: 'Linh Pham <linh@example.com>', text: 'Thursday morning is better for me.' }), { arrived: ago(13), thread: 88n, flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Re: Design review', from: 'Bao Le <bao@example.com>', text: 'Fine by me, either time.' }), { arrived: ago(12), thread: 88n, flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Re: Design review', from: 'Mai Tran <mai@example.com>', text: 'Thursday at ten then.' }), { arrived: ago(11), thread: 88n, flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Re: Design review', from: 'Linh Pham <linh@example.com>', text: 'Booked the room.' }), { arrived: ago(10.5), thread: 88n, flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Re: Design review', from: 'Bao Le <bao@example.com>', html: REPLY_HTML }), { arrived: ago(10), thread: 88n })
  gmail.add(`${DELIVERED}\n${rawMail({ subject: 'Order 48213 confirmed', from: 'Coffee House <orders@coffee.example>', html: RECEIPT, date: ago(2), headers: ['Cc: Mai Tran <mai@example.com>', 'Reply-To: Coffee House Help <help@coffee.example>'] })}`, { arrived: ago(2) })
  gmail.add(rawMail({ subject: 'Lịch thi cuối kỳ HK1', from: 'Phòng Đào Tạo <daotao@uni.example>', text: 'Các bạn xem lịch thi đính kèm.\n\nChi tiết: https://uni.example/lich-thi', attachment: { name: 'lich-thi.pdf', type: 'application/pdf', body: 'x'.repeat(240000) } }), { arrived: ago(1) })
  gmail.add(rawMail({ subject: 'The week in small tools', from: 'Small Tools <hello@smalltools.example>', html: NEWSLETTER }), { arrived: ago(3), labels: ['\\Inbox', 'Newsletters'] })
  gmail.add(rawMail({ subject: 'Trip to Da Lat', text: 'Are you still on for Friday?', from: 'Mai Tran <mai@example.com>' }), { arrived: ago(5), thread: 77n })
  gmail.add(rawMail({ subject: 'Re: Trip to Da Lat', text: 'Yes! Bus leaves at 7.\n\nI booked two seats.', from: 'Linh Pham <linh@example.com>' }), { arrived: ago(4), thread: 77n })
  gmail.add(rawMail({ subject: 'Your receipt', text: 'Thanks for your order of 245,000 VND.', from: 'Coffee House <no-reply@coffee.example>' }), { arrived: ago(30), flags: ['\\Seen'], labels: ['\\Inbox', 'Receipts'] })
  gmail.add(rawMail({ subject: 'A very long subject line that keeps going well past what fits on one row of the list', text: 'Long.', from: 'Someone With A Rather Long Display Name <long@example.com>' }), { arrived: ago(80), flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'Sent by me', text: 'Sent.', from: 'Me <me@example.com>' }), { arrived: ago(6), flags: ['\\Seen'], labels: ['\\Sent'] })
  gmail.add(rawMail({ subject: 'Your order has shipped', text: 'Number 1Z999AA10123456784', from: 'Shop <orders@shop.example>' }), { arrived: ago(7) })
  gmail.add(rawMail({ subject: 'Your account is locked', from: '"support@bigbank.example" <x@bank-login.example>', text: 'Sign in now.', headers: ['Authentication-Results: mx; dmarc=fail'] }), { arrived: ago(8) })
  for (const hours of [9, 33, 57]) gmail.add(rawMail({ subject: 'Deals this week', from: 'Deals <deals@shop.example>', text: 'Save now.', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: ago(hours) })
  gmail.add(rawMail({ subject: 'Old invoice', text: 'Thrown out.', from: 'Mai Tran <mai@example.com>' }), { box: '[Gmail]/Trash', arrived: ago(40) })
  gmail.add(rawMail({ subject: 'Fresh this weekend', from: 'Green Market <hello@greenmarket.example>', html: PROMO }), { arrived: ago(20), flags: ['\\Seen'] })
  gmail.add(rawMail({ subject: 'The night digest', from: 'Night Owl <owl@nightowl.example>', html: DIGEST }), { arrived: ago(21), flags: ['\\Seen'] })
}

/** Made-up faces: photos for some people, logos for some companies, nothing for the rest. */
const FACES = {
  'photo:mai@example.com': png(96, [196, 92, 120]),
  'photo:linh@example.com': png(96, [52, 120, 170]),
  'photo:me@example.com': png(96, [70, 140, 90]),
  'logo:coffee.example': svgLogo('#7c3f1d', 'C'),
  'logo:smalltools.example': png(48, [30, 30, 30]),
  'logo:shop.example': svgLogo('#d9480f', 'S')
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`pictures ${colorScheme}`, async () => {
    const run = await launch({ colorScheme, size: [1280, 840], pictures: FACES })
    const { page, gmail } = run
    await page.getByLabel('Email address').waitFor() // drawn, before there's a picture to take
    await page.screenshot({ path: `${folder}/${colorScheme}-welcome.png` })
    fill(gmail)
    await signIn(run)
    await page.getByText('Lịch thi cuối kỳ HK1').first().waitFor()
    await page.locator('.threads').getByText('Order 48213 confirmed').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    gmail.add(rawMail({ subject: 'Held', text: 'Held.' }))
    gmail.add(rawMail({ subject: 'Held too', text: 'Held.' }))
    await page.getByRole('button', { name: /^Sync/ }).click()
    await page.getByText('2 waiting').waitFor()
    await page.getByText('Trip to Da Lat').first().click()
    await page.locator('.messages').getByText('Bus leaves').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 900)) // faces looked up for the list arrive
    await page.screenshot({ path: `${folder}/${colorScheme}-thread.png` })
    await page.getByLabel('Select Your receipt').check({ force: true })
    await page.getByLabel('Select The week in small tools').check({ force: true })
    await page.keyboard.press('b')
    await page.getByRole('button', { name: /^Tomorrow/ }).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-snooze.png` })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.mail.saveProfile({ identities: { 'me@example.com': { name: 'Me', signature: 'Me\nSomewhere', aliases: [], color: '', notify: true } }, templates: [{ name: 'Thanks', text: 'Thanks!' }] }))
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.getByRole('region', { name: 'Compose' }).getByLabel('Message').fill('Count me in. I will bring snacks.')
    await page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: 'Quoted message' }).click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-compose.png` })
    await page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: /^Drafts/ }).click()
    await page.screenshot({ path: `${folder}/${colorScheme}-drafts.png` })
    await page.getByRole('button', { name: /^Inbox/ }).click()
    await page.getByText('The week in small tools').first().click()
    await page.frameLocator('iframe.body-frame').getByText('Three things').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-html.png` })
    await page.getByText('Lịch thi cuối kỳ HK1').first().click()
    await page.locator('.messages').getByText('lich-thi.pdf').waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-attachment.png` })
    await page.getByText('Order 48213 confirmed').first().click()
    await page.frameLocator('iframe.body-frame').getByText('Thanks for your order').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-receipt.png` })
    if (colorScheme === 'dark') {
      await page.getByRole('button', { name: 'Show original colours' }).click()
      await page.getByRole('button', { name: 'Darken colours' }).waitFor()
      await new Promise((resolve) => setTimeout(resolve, 300))
      await page.screenshot({ path: `${folder}/dark-receipt-original.png` })
      await page.getByRole('button', { name: 'Darken colours' }).click()
    }
    await page.getByText('Fresh this weekend').first().click()
    await page.frameLocator('iframe.body-frame').getByText('Strawberries are back').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-promo.png` })
    await page.getByText('The night digest').first().click()
    await page.frameLocator('iframe.body-frame').getByText('Four long reads').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-digest.png` })
    await page.getByText('Order 48213 confirmed').first().click()
    await page.frameLocator('iframe.body-frame').getByText('Thanks for your order').waitFor()
    await page.locator('.message.open').getByRole('button', { name: /^To:/ }).click()
    await page.getByRole('dialog', { name: 'Message details' }).getByText('Written to', { exact: true }).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-details.png` })
    await page.getByRole('dialog', { name: 'Message details' }).getByRole('button', { name: 'Actions for orders@coffee.example' }).click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-details-menu.png` })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.locator('.threads').getByText('Design review').first().click()
    await page.getByRole('button', { name: /more email/ }).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-long-thread.png` })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('heading', { name: 'General' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings.png` })
    await page.getByRole('button', { name: 'Notifications' }).click()
    await page.getByLabel('Sender to mute').fill('deals@shop.example')
    await page.getByRole('button', { name: 'Mute', exact: true }).click()
    await page.getByRole('button', { name: 'Unmute deals@shop.example' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings-notifications.png` })
    await page.getByRole('button', { name: 'General' }).click()
    await page.getByLabel('Layout').selectOption('list')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-wide-list.png` })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByLabel('Layout').selectOption('below')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.locator('.threads').getByText('Trip to Da Lat').first().click()
    await page.locator('.messages').getByText('Bus leaves').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.screenshot({ path: `${folder}/${colorScheme}-below.png` })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByLabel('Layout').selectOption('panes')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByLabel('Search').fill('zzzz')
    await page.getByText('Nothing found').waitFor()
    await page.getByLabel('Search').fill('')
    await page.getByRole('button', { name: /^Other/ }).click()
    await page.screenshot({ path: `${folder}/${colorScheme}-other.png` })
    await page.getByRole('button', { name: 'Subscriptions' }).click()
    await page.getByText('Nothing here').or(page.locator('.subscription').first()).or(page.getByText('No subscriptions')).first().waitFor()
    await new Promise((resolve) => setTimeout(resolve, 600))
    await page.screenshot({ path: `${folder}/${colorScheme}-subscriptions.png` })
    await page.locator('.subscription').first().hover()
    await page.locator('.subscription .pick').first().check()
    await page.getByRole('toolbar', { name: 'Selected senders' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-subscriptions-picked.png` })
    await page.getByRole('toolbar', { name: 'Selected senders' }).getByRole('button', { name: 'Cancel' }).click()
    await page.locator('.subscription-open').first().click()
    await page.locator('.sender-card').waitFor()
    await page.locator('.threads .thread').first().waitFor()
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.screenshot({ path: `${folder}/${colorScheme}-sender.png` })
    await page.locator('.sender-card').getByRole('button', { name: '‹ Subscriptions' }).click()
    await page.getByRole('button', { name: 'Add deals@shop.example to Summary' }).click()
    const asking = page.getByRole('dialog', { name: 'When your Summary arrives' })
    await asking.getByRole('radio', { name: /Morning/ }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-summary-schedule.png` })
    const at = hhmm(Date.now() + 120_000)
    await asking.getByRole('radio', { name: 'Pick a time' }).check()
    await asking.getByLabel('Summary time').fill(at)
    await asking.getByRole('button', { name: 'Schedule' }).click()
    await page.evaluate(() => window.mail.editSenders('summary', ['hello@smalltools.example', 'digest@letters.example'], true))
    await page.getByRole('group', { name: 'Sides of Subscriptions' }).getByRole('button', { name: 'Summary' }).click()
    await page.locator('.subscription').nth(2).waitFor()
    await page.locator('.summary-bar').getByText('Delivered daily').waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-subscriptions-summary.png` })
    gmail.add(rawMail({ subject: 'Last chance: deals end tonight', from: 'Deals <deals@shop.example>', text: 'Everything half off.', headers: ['List-Unsubscribe: <https://list.example/u>'] }))
    gmail.add(rawMail({ subject: 'Five tools for a tidy desk', from: 'Small Tools <hello@smalltools.example>', text: 'A short list, and why each one is on it.' }))
    gmail.add(rawMail({ subject: 'This week in letters', from: 'The Letter <digest@letters.example>', text: 'Three essays worth your Sunday.' }))
    await syncAndSettle(page)
    await later(run, 180_000)
    await page.getByRole('button', { name: /^Inbox/ }).first().click()
    await page.getByRole('button', { name: 'Focused', exact: true }).click()
    await page.getByRole('button', { name: /Your Summary/ }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: `${folder}/${colorScheme}-inbox-summary.png` })
    await page.getByRole('button', { name: /Your Summary/ }).click()
    await page.locator('.summary-head').first().waitFor()
    await page.locator('.threads').getByText('Five tools for a tidy desk').click()
    await page.getByRole('heading', { name: 'Five tools for a tidy desk' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-summary.png` })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Summary', exact: true }).click()
    await page.getByRole('button', { name: 'Turn off Summary' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings-summary.png` })
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Batches' }).click()
    await page.getByRole('radiogroup', { name: 'How new mail arrives' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings-batches.png` })
    await page.getByRole('radio', { name: /As it arrives/ }).check()
    await page.getByText('are kept for switching back').waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings-live.png` })
    await page.getByRole('radio', { name: /In batches/ }).check()
    await page.getByLabel('Remove 13:00').waitFor()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Shortcuts' }).click()
    await page.getByRole('button', { name: 'Change the key for Flag' }).click()
    await page.keyboard.press('Control+r')
    await page.getByRole('button', { name: 'Use it here' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings-shortcuts.png` })
    await page.getByRole('group', { name: 'Flag', exact: true }).getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Recently Seen', exact: true }).click()
    await page.locator('.threads .thread').first().waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-recent.png` })
    await page.getByRole('button', { name: 'Packages' }).click()
    await page.getByText('Your order has shipped').first().click()
    await page.getByRole('heading', { name: 'Your order has shipped' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-assistant.png` })
    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    await page.getByText('Old invoice').first().click()
    await page.getByRole('heading', { name: 'Old invoice' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-trash.png` })
    await page.getByRole('button', { name: /^Inbox/ }).first().click()
    await page.getByText('Your account is locked').first().waitFor()
    await page.getByText('Your account is locked').first().click()
    await page.getByRole('alert').first().waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-warning.png` })
    await page.locator('.message.open').getByRole('button', { name: /^To:/ }).click()
    await page.getByRole('dialog', { name: 'Message details' }).getByText('Warnings', { exact: true }).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-details-warning.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Accounts' }).click()
    await page.getByRole('button', { name: 'Choose a photo for me@example.com' }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-settings-accounts.png` })
    await page.getByRole('button', { name: 'Add account' }).click()
    await page.getByRole('radio', { name: 'Other' }).click()
    await page.screenshot({ path: `${folder}/${colorScheme}-add-other.png` })
    await page.getByRole('radio', { name: 'Outlook' }).click()
    await page.screenshot({ path: `${folder}/${colorScheme}-add-outlook.png` })
    await page.getByRole('button', { name: 'Done' }).click()
    await page.evaluate((secret) => window.mail.addAccount({ email: 'second@example.com', secret, provider: 'gmail' }), gmail.secret)
    await page.getByRole('button', { name: /^second@example\.com/ }).waitFor()
    await page.getByText('Lịch thi cuối kỳ HK1').first().waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-two-accounts.png` })
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 700))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.getByRole('button', { name: 'Back', exact: true }).waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-narrow-reader.png` })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.locator('.thread').first().waitFor()
    await page.screenshot({ path: `${folder}/${colorScheme}-narrow-list.png` })
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 840))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.locator('.sidebar-foot .status').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
    await page.getByLabel('Show Snoozed').uncheck()
    await page.getByRole('button', { name: 'Move Pinned up' }).click()
    await page.screenshot({ path: `${folder}/${colorScheme}-edit-menu.png` })
    await page.getByRole('button', { name: 'New Label on me@example.com' }).click()
    await page.getByRole('dialog', { name: 'New Label' }).getByLabel('Name').fill('Work/Plans')
    await page.screenshot({ path: `${folder}/${colorScheme}-new-label.png` })
    await page.getByRole('dialog', { name: 'New Label' }).getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    // A short window: Edit Menu scrolls, and the details keep inside the reader.
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 520))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.locator('.sidebar-foot .status').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Menu' }).click()
    await page.locator('.sidebar-scroll').evaluate((list) => { list.scrollTop = list.scrollHeight })
    await page.screenshot({ path: `${folder}/${colorScheme}-short-edit-menu.png` })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.locator('.threads').getByText('Trip to Da Lat').first().click()
    await page.locator('.message.open').last().getByRole('button', { name: /^To:/ }).click()
    await page.getByRole('dialog', { name: 'Message details' }).getByText('Mailbox', { exact: true }).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot({ path: `${folder}/${colorScheme}-short-details.png` })
    await page.keyboard.press('Escape')
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 840))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.locator('.threads').getByText('Trip to Da Lat').first().click()
    const [thread] = await Promise.all([run.app.waitForEvent('window'), page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Open in a window' }).click()])
    await thread.locator('.messages').getByText('Bus leaves').waitFor()
    await thread.screenshot({ path: `${folder}/${colorScheme}-thread-window.png` })
    await page.getByRole('button', { name: 'Compose' }).click()
    const [writing] = await Promise.all([run.app.waitForEvent('window'), page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: 'Open in a window' }).click()])
    await writing.getByLabel('To').fill('mai@example.com')
    await writing.getByLabel('Subject').fill('Friday')
    await writing.getByLabel('Message').click()
    await writing.keyboard.type('Still on. I will bring the tickets.')
    await writing.screenshot({ path: `${folder}/${colorScheme}-composer-window.png` })
    await run.stop()
  })
}
