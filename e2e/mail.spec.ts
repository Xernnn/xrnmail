import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { rawMail } from '../tests/fake-gmail'
import { launch, ME, signIn, syncAndSettle, type Running } from './app'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let run: Running

test.afterEach(async () => run?.stop())

const earlier = (hours: number): Date => new Date(Date.now() - hours * 3_600_000)

test('wrong password says so, right one lists the mail', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Welcome aboard', text: 'First words', from: 'Ada Lovelace <ada@example.com>' }), { arrived: earlier(2) })
  await page.getByLabel('Email address').fill(ME)
  await page.getByRole('radio', { name: 'Gmail' }).click()
  await page.getByLabel('App password').fill('wrong')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Gmail refused this password.')).toBeVisible()
  await signIn(run)
  await expect(page.getByText('Welcome aboard')).toBeVisible()
  await page.getByText('Welcome aboard').click()
  await expect(page.locator('.body-text')).toHaveText('First words')
  await expect.poll(() => gmail.mails[0]?.flags).toContain('\\Seen')
  expect(gmail.writes().filter((c) => !c.startsWith('SELECT'))).toEqual([expect.stringMatching(/^UID STORE \d+ \+FLAGS.*\\Seen/)])
})

test('new mail waits, and delivering early makes you wait first', async () => {
  run = await launch()
  const { page, gmail } = run
  await signIn(run)
  await expect(page.getByText('Nothing here')).toBeVisible()
  await pause(1200)
  gmail.add(rawMail({ subject: 'Held back', text: 'wordinside' }))
  await syncAndSettle(page)
  await expect(page.getByText('1 waiting')).toBeVisible()
  await expect(page.getByText('Held back')).toHaveCount(0)
  await page.getByLabel('Search').fill('wordinside')
  await expect(page.getByText('Nothing found')).toBeVisible()
  await page.getByLabel('Search').fill('')
  await page.getByRole('button', { name: 'Deliver now' }).click()
  await page.getByRole('button', { name: 'Deliver 1' }).click()
  await expect(page.getByText('Held back')).toBeVisible()
  await expect(page.getByText('1 waiting')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Deliver now' })).toHaveCount(0)
})

test('mail as it arrives: one switch, waiting mail comes in, the times are kept, and changes made elsewhere show by themselves', async () => {
  run = await launch()
  const { page, gmail } = run
  await signIn(run)
  await pause(1200)
  const list = page.locator('.threads')
  gmail.add(rawMail({ subject: 'Held back' }))
  await expect(page.getByText('1 waiting')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Search settings').fill('as it arrives')
  await expect(page.getByRole('heading', { name: 'Batches' })).toBeVisible()
  const modes = page.getByRole('radiogroup', { name: 'How new mail arrives' })
  await expect(modes.getByRole('radio', { name: /In batches/ })).toBeChecked()
  await modes.getByRole('radio', { name: /As it arrives/ }).check()
  await expect(modes.getByRole('radio', { name: /As it arrives/ })).toBeChecked()
  await expect(page.getByLabel('Remove 13:00')).toHaveCount(0)
  await expect(page.getByText('Your times (09:00, 13:00, 17:00) are kept for switching back.')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(list.getByText('Held back')).toBeVisible()
  await expect(page.locator('.batch')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Deliver now' })).toHaveCount(0)

  // New mail, and what's done to it on another device, show here without anything being pressed.
  const uid = gmail.add(rawMail({ subject: 'Right away' }))
  await expect(list.getByText('Right away')).toBeVisible({ timeout: 15_000 })
  await expect(list.locator('.thread.unread', { hasText: 'Right away' })).toHaveCount(1)
  gmail.change(uid, ['\\Inbox'], ['\\Seen'])
  await expect(list.locator('.thread.unread', { hasText: 'Right away' })).toHaveCount(0, { timeout: 15_000 })
  gmail.remove(uid)
  await expect(list.getByText('Right away')).toHaveCount(0, { timeout: 15_000 })

  // Back to batches: the times it had, and new mail waits again.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Batches' }).click()
  await page.getByRole('radio', { name: /In batches/ }).check()
  await expect(page.getByLabel('Remove 13:00')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  gmail.add(rawMail({ subject: 'Waits again' }))
  await expect(page.getByText('1 waiting')).toBeVisible({ timeout: 15_000 })
  await expect(list.getByText('Waits again')).toHaveCount(0)
})

test('search finds Vietnamese without its marks', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: '=?UTF-8?B?' + Buffer.from('Đề thi cuối kỳ').toString('base64') + '?=' }), { arrived: earlier(2) })
  gmail.add(rawMail({ subject: 'Something else' }), { arrived: earlier(3) })
  await signIn(run)
  await expect(page.getByText('Something else')).toBeVisible()
  await page.keyboard.press('/')
  await page.keyboard.type('de thi')
  await expect(page.getByText('Đề thi cuối kỳ')).toBeVisible()
  await expect(page.getByText('Something else')).toHaveCount(0)
})

test('settings change the timetable and stick', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Batches' }).click()
  await page.getByLabel('Remove 13:00').click()
  await page.getByLabel('New time').fill('20:15')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await expect(page.getByLabel('Remove 20:15')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Batches' }).click()
  await expect(page.getByLabel('Remove 20:15')).toBeVisible()
  await expect(page.getByLabel('Remove 13:00')).toHaveCount(0)
})

test('a hostile email can do nothing', async () => {
  const hits: string[] = []
  const web: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.end()
  })
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const address = web.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  run = await launch()
  const { page, gmail } = run
  gmail.add(
    rawMail({
      subject: 'Open me',
      html: `<html><head>
        <meta http-equiv="refresh" content="0;url=${base}/refresh">
        <style>p.marked { color: rgb(1, 2, 3); }</style>
        <base href="${base}/base/"></head><body>
        <script>parent.document.title = 'pwned'</script>
        <img src="x" onerror="parent.document.title = 'pwned'">
        <p class="marked" onclick="parent.document.title = 'pwned'">Styled text</p>
        <img src="${base}/pixel.png">
        <a id="good" href="https://example.com/good">good</a>
        <a id="file" href="file:///etc/passwd">file</a>
        <a id="js" href="javascript:parent.document.title = 'pwned'">js</a>
        <form action="${base}/form"><input name="q"><button>go</button></form>
        <iframe src="${base}/frame"></iframe>
        <object data="${base}/object"></object>
        <svg onload="parent.document.title = 'pwned'"></svg>
      </body></html>`
    }),
    { arrived: earlier(2) }
  )
  await signIn(run)
  await page.getByText('Open me').click()
  const frame = page.frameLocator('iframe.body-frame')
  await expect(frame.getByText('Styled text')).toBeVisible()

  await pause(500)
  expect(await page.title()).toBe('xrnmail')
  expect(hits).toEqual([])
  expect(await page.locator('iframe.body-frame').getAttribute('sandbox')).toBe('allow-same-origin')
  await expect(frame.locator('script, form, iframe, object, svg, base, meta[http-equiv=refresh]')).toHaveCount(0)
  await expect(frame.locator('[onerror], [onclick]')).toHaveCount(0)
  await expect(frame.locator('p.marked')).toHaveCSS('color', 'rgb(1, 2, 3)') // its own styles still work

  await frame.locator('#good').click()
  await frame.locator('#file').click()
  await frame.locator('#js').click()
  await expect.poll(run.opened).toEqual(['https://example.com/good'])
  expect(page.url()).toContain('index.html')
  await expect(frame.getByText('Styled text')).toBeVisible()

  await frame.locator('#good').hover()
  await expect(page.locator('.peek')).toHaveText('https://example.com/good')

  // The top page's own policy allows images, so this one only meets the main process's wall.
  await page.evaluate((url) => void (new Image().src = url), `${base}/past-the-policy.png`)
  await pause(300)
  expect(hits).toEqual([])

  await page.getByRole('button', { name: 'Show images' }).click()
  await expect.poll(() => hits).toContain('/pixel.png')
  expect(hits.filter((h) => h !== '/pixel.png')).toEqual([])
  expect(await page.title()).toBe('xrnmail')
  web.close()
})

test('images stay blocked on the next message', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'First', html: '<p>one</p><img src="https://example.invalid/a.png">' }), { arrived: earlier(2) })
  gmail.add(rawMail({ subject: 'Second', html: '<p>two</p><img src="https://example.invalid/b.png">' }), { arrived: earlier(3) })
  await signIn(run)
  await page.getByText('First').click()
  await page.getByRole('button', { name: 'Show images' }).click()
  await expect(page.getByRole('button', { name: 'Show images' })).toHaveCount(0)
  await page.getByText('Second').click()
  await expect(page.frameLocator('iframe.body-frame').getByText('two')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show images' })).toBeVisible()
})

test('the page has only the bridge, and a page reached by accident gets nothing', async () => {
  run = await launch()
  const { page, gmail, app } = run
  gmail.add(rawMail({ subject: 'Plan', text: 'Early idea' }), { arrived: earlier(3) })
  // A thread and a draft in windows of their own are the same page behind the same walls.
  await signIn(run)
  await page.getByText('Plan').click()
  const [thread] = await Promise.all([app.waitForEvent('window'), page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Open in a window' }).click()])
  await expect(thread.getByRole('heading', { name: 'Plan' })).toBeVisible()
  await page.getByRole('button', { name: 'Compose' }).click()
  const [draft] = await Promise.all([app.waitForEvent('window'), page.getByRole('region', { name: 'Compose' }).getByRole('button', { name: 'Open in a window' }).click()])
  await expect(draft.getByLabel('Subject')).toBeVisible()
  expect(thread.url()).toContain('solo=thread')
  expect(draft.url()).toContain('solo=draft')
  const all = [page, thread, draft]

  for (const shown of all) {
    const globals = await shown.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      mail: typeof window.mail
    }))
    expect(globals).toEqual({ node: 'undefined', process: 'undefined', mail: 'object' })
    // The bridge is the page's alone: a frame put inside one doesn't get it.
    const framed = await shown.evaluate(async () => {
      const frame = document.createElement('iframe')
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
      frame.srcdoc = '<p>inside</p>'
      document.body.append(frame)
      await loaded
      const inside = typeof (frame.contentWindow as unknown as { mail?: unknown }).mail
      frame.remove()
      return inside
    })
    expect(framed).toBe('undefined')
  }
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((shown) => {
    const contents = shown.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }
    const { sandbox, contextIsolation, nodeIntegration, webSecurity, webviewTag } = contents.getLastWebPreferences() ?? {}
    return { sandbox, contextIsolation, nodeIntegration, webSecurity, webviewTag: webviewTag === true }
  }))
  expect(preferences).toHaveLength(3)
  for (const one of preferences) {
    expect(one).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false })
  }

  // None can open a window itself: only the app's own request does that.
  for (const shown of all) {
    expect(await shown.evaluate(() => window.open('https://example.org/') === null)).toBe(true)
    expect(await shown.evaluate(() => window.open(window.location.href) === null)).toBe(true)
  }
  await pause(300)
  expect(app.windows()).toHaveLength(3)
  expect(await run.opened()).toEqual(['https://example.org/', 'https://example.org/', 'https://example.org/'])

  // And none can be sent anywhere else: it stays, and the address goes to the browser.
  for (const [i, shown] of all.entries()) {
    const before = shown.url()
    await shown.evaluate((url) => void (window.location.href = url), `https://example.com/${i}`)
    await pause(400)
    expect(shown.url()).toBe(before)
    expect(before).toContain('index.html')
  }
  await expect.poll(run.opened).toEqual(['https://example.org/', 'https://example.org/', 'https://example.org/', 'https://example.com/0', 'https://example.com/1', 'https://example.com/2'])
})

test('following a thread: it opens in Gmail, and reads back from the saved mail', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Plan', text: 'Early idea' }), { flags: ['\\Seen'], thread: 255n, arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Re: Plan', text: 'Better idea', attachment: { name: 'notes.pdf', type: 'application/pdf', body: 'pdf' } }), { thread: 255n, arrived: earlier(2) })
  await signIn(run)
  await page.getByText('Re: Plan').click()
  const thread = page.locator('.messages')
  await expect(thread.getByText('Better idea')).toBeVisible()
  await expect(thread.getByText('notes.pdf')).toBeVisible()
  await expect(thread.locator('.message.open').getByText('Early idea')).toHaveCount(0) // older ones start folded
  await page.locator('.message-head').first().click()
  await expect(thread.locator('.message.open').getByText('Early idea')).toBeVisible()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Open in Gmail' }).click()
  await expect.poll(run.opened).toEqual([`https://mail.google.com/mail/?authuser=${encodeURIComponent(ME)}#all/ff`])
})
