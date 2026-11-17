import { expect, test } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { rawMail } from '../tests/fake-gmail'
import { launch, ME, signIn, syncAndSettle, type Running } from './app'
import { png } from './pictures'

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

// MiSans Latin's Bold, in every format it comes in, has an ampersand where its @ should be, so bold
// addresses (an unread sender with no name, the account in the sidebar) read "me&example.com".
test('an @ in bold is an @, not the ampersand the bold face has in its place', async () => {
  run = await launch()
  const { page } = run
  await page.getByLabel('Email address').waitFor()
  const drawn = await page.evaluate(async () => {
    for (const weight of [400, 600, 700]) await document.fonts.load(`${weight} 40px MiSans`, '@&')
    const canvas = document.createElement('canvas')
    canvas.width = 60
    canvas.height = 60
    const pen = canvas.getContext('2d') as CanvasRenderingContext2D
    const picture = (weight: number, text: string): string => {
      pen.clearRect(0, 0, 60, 60)
      pen.font = `${weight} 40px MiSans`
      pen.fillText(text, 5, 45)
      return Array.from(pen.getImageData(0, 0, 60, 60).data).join()
    }
    const width = (weight: number, text: string): number => {
      pen.font = `${weight} 40px MiSans`
      return pen.measureText(text).width
    }
    return {
      loaded: [400, 600, 700].map((weight) => document.fonts.check(`${weight} 40px MiSans`, '@')),
      boldSame: picture(700, '@') === picture(700, '&'),
      boldWidths: [width(700, '@'), width(700, '&')],
      regularSame: picture(400, '@') === picture(400, '&')
    }
  })
  expect(drawn.loaded).toEqual([true, true, true])
  expect(drawn.regularSame).toBe(false)
  expect(drawn.boldSame).toBe(false)
  expect(drawn.boldWidths[0]).not.toBe(drawn.boldWidths[1])
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

test('recent searches: offered under the empty search box, picked with the keys, removed one at a time or all, and kept', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Invoice 7', from: 'Shop <shop@example.com>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Lunch', from: 'Mai Tran <mai@example.com>' }), { arrived: earlier(2) })
  await signIn(run)
  const list = page.locator('.threads')
  const box = page.getByRole('combobox', { name: 'Search' }) // the list under it is named for searches too
  const recent = page.getByRole('listbox', { name: 'Recent searches' })
  await box.click()
  await expect(recent).toHaveCount(0) // nothing searched for yet
  await box.fill('invoice')
  await box.press('Enter') // a search finished with Enter is kept
  await expect(list.getByText('Invoice 7')).toBeVisible()
  await box.fill('from:mai')
  await list.getByText('Lunch').click() // and so is one a result was opened from
  await expect(page.locator('.thread-subject')).toHaveText('Lunch')
  await box.fill('')
  await expect(recent.getByRole('option')).toHaveText(['from:mai', 'invoice'])
  await box.press('ArrowDown')
  await box.press('ArrowDown')
  await expect(recent.getByRole('option', { selected: true })).toHaveText('invoice')
  await box.press('Enter')
  await expect(box).toHaveValue('invoice')
  await expect(list.getByText('Invoice 7')).toBeVisible()
  await expect(list.getByText('Lunch')).toHaveCount(0)
  await box.fill('')
  await expect(recent.getByRole('option')).toHaveText(['invoice', 'from:mai']) // used again, so first
  await recent.getByRole('button', { name: 'Remove from:mai' }).click()
  await expect(recent.getByRole('option')).toHaveText(['invoice'])
  await expect(box).toBeFocused()
  await box.press('Escape')
  await expect(recent).toHaveCount(0)

  await page.reload() // kept with the profile
  await box.click()
  await expect(recent.getByRole('option')).toHaveText(['invoice'])
  await recent.getByRole('option').click()
  await expect(box).toHaveValue('invoice')
  await box.fill('')
  await page.getByRole('button', { name: 'Clear recent searches' }).click()
  await expect(recent).toHaveCount(0)
  await page.reload()
  await box.click()
  await expect(recent).toHaveCount(0)
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

// While a frame's new page is being made it has no root yet, and showing the quoted text then threw,
// with nothing to catch it, so the whole window went white.
test('a message that can\'t be drawn leaves the window as it was, and says so in the reader alone', async () => {
  run = await launch()
  const { page, gmail } = run
  const reply = '<div>Thursday works.</div><div class="gmail_quote"><div>On Tue, Mai wrote:</div><blockquote class="gmail_quote">Can we meet?</blockquote></div>'
  gmail.add(rawMail({ subject: 'Meeting', from: 'Mai Tran <mai@example.com>', html: reply }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Lunch', from: 'Linh Pham <linh@example.com>', text: 'Noon?' }), { arrived: earlier(2) })
  await signIn(run)
  const list = page.locator('.threads')
  /** What a frame says its page is, from now on: [kind] none, one with no root, or a failure. */
  const framesAnswer = (kind: 'rootless' | 'failing' | 'real'): Promise<void> => page.evaluate((how) => {
    const proto = HTMLIFrameElement.prototype as unknown as { realDocument?: PropertyDescriptor }
    proto.realDocument ??= Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')
    const real = proto.realDocument as PropertyDescriptor
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', how === 'real' ? real : {
      configurable: true,
      get() {
        if (how === 'failing') throw new Error('made to fail')
        return { documentElement: null }
      }
    })
  }, kind)
  await list.getByText('Meeting').click()
  await page.frameLocator('iframe.body-frame').getByText('Thursday works.').waitFor()
  await framesAnswer('rootless')
  await page.getByRole('button', { name: 'Show quoted text' }).click()
  await expect(page.getByRole('button', { name: 'Hide quoted text' })).toBeVisible()
  await expect(page.locator('.thread-subject')).toHaveText('Meeting') // nothing to do, and still there

  await framesAnswer('failing')
  await page.getByRole('button', { name: 'Hide quoted text' }).click()
  await expect(page.getByText('Couldn\'t show this message')).toBeVisible()
  await expect(list.getByText('Lunch')).toBeVisible() // the rest of the window carries on
  await framesAnswer('real')
  await page.getByRole('button', { name: 'Back to the list' }).click()
  await expect(page.getByText('Couldn\'t show this message')).toHaveCount(0)
  await list.getByText('Lunch').click()
  await expect(page.locator('.body-text')).toHaveText('Noon?')
})

// Every picture HubSpot hosts for its senders is on hubspotemail.net, as its open pixel is, and the
// rule for the pixel took the lot: such mail had no pictures to show, and no Show images.
test('a mailing service\'s own pictures stay, and only its open pixel goes', async () => {
  run = await launch()
  const { page, gmail } = run
  const html = '<p>New in the shop this week.</p>' +
    '<img id="banner" src="https://hs-1234567.f.hubspotemail.net/hub/1234567/hubfs/spring/banner.png" alt="Spring" width="560" height="200">' +
    '<img id="pixel" src="https://t.hubspotemail.net/e2t/to/VWxyz123/abc" alt="">'
  gmail.add(rawMail({ subject: 'New this week', from: 'Mai Tran <mai@example.com>', html }), { arrived: earlier(3) })
  await signIn(run)
  await page.locator('.threads').getByText('New this week', { exact: true }).click()
  const frame = page.frameLocator('iframe.body-frame')
  await frame.getByText('New in the shop this week.').waitFor()
  await expect(frame.locator('#banner')).toHaveAttribute('src', /hubfs\/spring\/banner\.png$/)
  await expect(frame.locator('#pixel')).not.toHaveAttribute('src', /.+/)
  await expect(page.getByText('1 tracker removed')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show images' })).toBeVisible()
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

// Offline, Show images left broken-picture icons with their alt text spilling over what was round
// them, and nothing said why or offered to try again.
test('pictures that can\'t be fetched stay plain blocks, say so, and can be tried again', async () => {
  run = await launch()
  const { page, gmail } = run
  // Nothing listens on port 1, so each is refused at once, as with no connection at all.
  const html = '<p>Our new range.</p><img id="one" src="http://127.0.0.1:1/one.png" alt="A very long description of the first picture" width="200" height="80">' +
    '<img id="two" src="http://127.0.0.1:1/two.png" alt="Logo" width="40" height="40"><p>See you soon.</p>'
  gmail.add(rawMail({ subject: 'New range', from: 'Mai Tran <mai@example.com>', html }), { arrived: earlier(3) })
  await signIn(run)
  await page.locator('.threads').getByText('New range', { exact: true }).click()
  const frame = page.locator('iframe.body-frame')
  await page.frameLocator('iframe.body-frame').getByText('See you soon.').waitFor()
  const blocks = (): Promise<{ width: number; height: number; content: string }[]> => frame.evaluate((f: HTMLIFrameElement) =>
    Array.from((f.contentDocument as Document).images).map((img) => {
      const box = img.getBoundingClientRect()
      return { width: box.width, height: box.height, content: (f.contentWindow as Window).getComputedStyle(img).content }
    })).catch(() => [])
  const before = await blocks()
  await page.getByRole('button', { name: 'Show images' }).click()
  const note = page.getByText('2 pictures couldn\'t load')
  await expect(note).toBeVisible()
  const after = await blocks()
  expect(after.map((b) => [b.width, b.height])).toEqual(before.map((b) => [b.width, b.height])) // nothing moves
  expect(after.every((b) => b.content.startsWith('url('))).toBe(true) // a plain block, not a broken icon and its alt text
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(note).toBeVisible() // still offline: tried, and said again
})

// Pictures were one switch for the whole app: the main window moving on to another thread turned
// them off in a thread open in a window of its own, so its Try again was refused every time.
test('a thread in a window of its own keeps its pictures when the main window moves on', async () => {
  const hits: string[] = []
  const web: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    // The first time, as on a bad connection; after that, the picture.
    const first = hits.length === 1
    response.writeHead(first ? 500 : 200, { 'Content-Type': first ? 'text/plain' : 'image/png', 'Cache-Control': 'no-store' })
    response.end(first ? 'Try later' : Buffer.from(PIXEL.split(',')[1] ?? '', 'base64'))
  })
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const address = web.address()
  const picture = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/range.png`
  try {
    run = await launch()
    const { page, gmail, app } = run
    gmail.add(rawMail({ subject: 'New range', from: 'Mai Tran <mai@example.com>', html: `<p>Our new range.</p><img id="range" src="${picture}" width="200" height="80">` }), { arrived: earlier(3) })
    gmail.add(rawMail({ subject: 'Lunch', from: 'Linh Pham <linh@example.com>', text: 'Noon?' }), { arrived: earlier(4) })
    await signIn(run)
    await page.locator('.threads').getByText('New range', { exact: true }).click()
    const out = page.getByRole('toolbar', { name: 'Thread' }).getByRole('button', { name: 'Open in a window' })
    const [solo] = await Promise.all([app.waitForEvent('window'), out.click()])
    await solo.frameLocator('iframe.body-frame').getByText('Our new range.').waitFor()
    await solo.getByRole('button', { name: 'Show images' }).click()
    const note = solo.getByText('1 picture couldn\'t load')
    await expect(note).toBeVisible()

    await page.locator('.threads').getByText('Lunch').click()
    await expect(page.locator('.body-text')).toHaveText('Noon?')
    await solo.getByRole('button', { name: 'Try again' }).click()
    await expect(note).toHaveCount(0)
    await expect.poll(() => solo.locator('iframe.body-frame').evaluate((f: HTMLIFrameElement) =>
      ((f.contentDocument as Document).getElementById('range') as HTMLImageElement).naturalWidth)).toBe(1)
    expect(hits).toEqual(['/range.png', '/range.png'])
  } finally {
    web.close()
  }
})

// The frame was sized, darkened and wired for clicks on its load, which waits for every picture: one
// from a host that never answered left a dark window's designed mail unseen, and its links dead.
test('a picture that never comes leaves the message shown and working, and one that comes late fits it again', async () => {
  const waiting = new Map<string, ServerResponse>()
  const web: Server = createServer((request, response) => void waiting.set(request.url ?? '', response))
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const address = web.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  try {
    run = await launch({ colorScheme: 'dark' })
    const { page, gmail } = run
    const html = `<table width="100%" bgcolor="#ffffff"><tr><td style="color:#222222"><p>Spring sale.</p>` +
      `<img src="${base}/never.png" width="300" height="120" alt=""><img id="late" src="${base}/late.png" alt="">` +
      `<p><a id="shop" href="https://shop.example/sale">Shop now</a></p></td></tr></table>`
    gmail.add(rawMail({ subject: 'Spring sale', from: 'Mai Tran <mai@example.com>', html }), { arrived: earlier(3) })
    await signIn(run)
    await page.locator('.threads').getByText('Spring sale', { exact: true }).click()
    const frame = page.locator('iframe.body-frame')
    await page.frameLocator('iframe.body-frame').getByText('Shop now').waitFor()
    await page.getByRole('button', { name: 'Show images' }).click()
    await expect.poll(() => [...waiting.keys()].sort()).toEqual(['/late.png', '/never.png'])
    await expect(frame).not.toHaveClass(/painting/)
    await page.frameLocator('iframe.body-frame').locator('#shop').click()
    await expect.poll(run.opened).toEqual(['https://shop.example/sale'])

    const height = async (): Promise<number> => (await frame.boundingBox())?.height ?? 0
    const before = await height()
    waiting.get('/late.png')?.writeHead(200, { 'Content-Type': 'image/png' }).end(png(400, [40, 90, 160]))
    await expect.poll(height).toBeGreaterThan(before + 300)
  } finally {
    for (const response of waiting.values()) response.destroy()
    web.close()
  }
})

/** A receipt made for a white page, with a picture in it, and a newsletter that's dark already. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const LIGHT_RECEIPT = `<table id="card" width="100%" bgcolor="#ffffff" style="border:1px solid #dddddd"><tr><td style="color:#222222;font-family:Arial">
  <img id="logo" src="${PIXEL}" width="40" height="40" alt="Logo"><h2>Thanks for your order</h2>
  <p id="total">Total: <b>245,000 VND</b></p><a id="track" href="https://shop.example/t" style="color:#1a5fd0">Track it</a></td></tr></table>`
const DARK_LETTER = '<div id="night" style="background:#111111;color:#dddddd;padding:20px"><h1 style="color:#ffffff">Tonight</h1><p>Three stories.</p></div>'

test('in a dark window, mail made for a white page is darkened, pictures and dark mail are left, and either can be seen as sent', async () => {
  run = await launch({ colorScheme: 'dark' })
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Your order', from: 'Shop <orders@shop.example>', html: LIGHT_RECEIPT }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Night edition', from: 'Linh Pham <linh@example.com>', html: DARK_LETTER }), { arrived: earlier(2) })
  await signIn(run)
  const list = page.locator('.threads')
  const frame = page.locator('iframe.body-frame')
  const look = (selector: string): Promise<{ bg: string; color: string; border: string; style: string | null }> =>
    frame.evaluate((f: HTMLIFrameElement, s) => {
      const doc = f.contentDocument as Document
      const el = doc.querySelector(s) as Element
      const style = (doc.defaultView as Window).getComputedStyle(el)
      return { bg: style.backgroundColor, color: style.color, border: style.borderTopColor, style: el.getAttribute('style') }
    }, selector)
  /** 0 for black to 255 for white, near enough. */
  const light = (css: string): number => {
    const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number)
    return (r + g + b) / 3
  }
  const original = page.getByRole('button', { name: 'Show original colours' })

  await list.getByText('Your order').click()
  await expect(original).toBeVisible()
  const card = await look('#card')
  expect(light(card.bg)).toBeLessThan(40)
  expect(light(card.border)).toBeGreaterThan(light(card.bg))
  expect(light((await look('#total')).color)).toBeGreaterThan(180)
  const track = await look('#track')
  expect(light(track.color)).toBeGreaterThan(120)
  expect(Number(track.color.match(/[\d.]+/g)?.[2])).toBeGreaterThan(Number(track.color.match(/[\d.]+/g)?.[0])) // still a blue link
  expect((await look('#logo')).style).toBeNull() // the picture is as it was
  await expect(frame).toHaveCSS('opacity', '1')

  await original.click()
  await expect.poll(async () => (await look('#card')).bg).toBe('rgb(255, 255, 255)')
  expect((await look('#total')).color).toBe('rgb(34, 34, 34)')
  await page.getByRole('button', { name: 'Darken colours' }).click()
  await expect.poll(async () => light((await look('#card')).bg)).toBeLessThan(40)

  await list.getByText('Night edition').click()
  await expect(page.frameLocator('iframe.body-frame').getByText('Three stories.')).toBeVisible()
  await expect.poll(async () => (await look('#night')).bg).toBe('rgb(17, 17, 17)')
  expect(await look('#night')).toMatchObject({ color: 'rgb(221, 221, 221)', style: 'background:#111111;color:#dddddd;padding:20px' })
  await expect(original).toHaveCount(0) // dark already, it's left as it is

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByLabel('Darken mail made for a white page, when the look is dark').uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400) // the window hears of a changed setting a moment after it's saved
  await list.getByText('Your order').click()
  await expect(page.frameLocator('iframe.body-frame').getByText('Thanks for your order')).toBeVisible()
  await expect.poll(async () => (await look('#card')).bg).toBe('rgb(255, 255, 255)')
  await expect(original).toHaveCount(0)
})

/** A newsletter laid out 600 pixels wide, as most are, with a picture across it and a link. */
const NEWSLETTER = `<table id="letter" width="600" align="center" bgcolor="#ffffff" cellpadding="0" cellspacing="0" style="width:600px"><tr><td style="padding:24px;color:#222222;font:16px Arial">
  <h1>This week in the garden</h1><img id="banner" src="${PIXEL}" width="552" height="138" style="width:552px;height:138px" alt="Banner">
  <p>Strawberries are back, and the tomatoes want staking before the wind comes.</p><a id="more" href="https://garden.example/week">Read the rest</a></td></tr></table>`
/** A reply that flows to any width, with a table of figures in it wider than the pane. */
const FIGURES = `<p id="words">Here are the figures you asked for, laid out as the spreadsheet has them. Have a look before Friday and say what you make of the third quarter, which came in under what we planned for it.</p>
  <table id="figures" style="width:900px"><tr>${['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total', 'Change'].map((h) => `<td style="width:128px">${h}</td>`).join('')}</tr></table><p>Thanks, Linh</p>`

test('a newsletter made 600 pixels wide is drawn smaller to fit a narrow reading pane, and at its own size once there is room', async () => {
  run = await launch({ colorScheme: 'dark', size: [1280, 800] })
  const { app, page, gmail } = run
  gmail.add(rawMail({ subject: 'Garden weekly', from: 'Mai Tran <mai@garden.example>', html: NEWSLETTER }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Figures', from: 'Linh Pham <linh@example.com>', html: FIGURES }), { arrived: earlier(2) })
  await signIn(run)
  const list = page.locator('.threads')
  const frame = page.locator('iframe.body-frame')
  const resize = (width: number, height: number): Promise<void> =>
    app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setSize(w as number, h as number), [width, height])
  /** How far the message scrolls sideways in its frame, how wide the frame is, and where an element of it is drawn. */
  const measure = (selector: string): Promise<{ sideways: number; view: number; width: number; bottom: number; frame: number; bg: string; parentSideways: number }> =>
    frame.evaluate((f: HTMLIFrameElement, s) => {
      const doc = f.contentDocument as Document
      const el = doc.querySelector(s) as HTMLElement
      const box = el.getBoundingClientRect()
      const parent = el.parentElement as HTMLElement
      return {
        sideways: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
        view: doc.documentElement.clientWidth,
        width: box.width,
        bottom: box.bottom,
        frame: f.clientHeight,
        bg: (doc.defaultView as Window).getComputedStyle(el).backgroundColor,
        parentSideways: parent.scrollWidth - parent.clientWidth
      }
    }, selector)

  await list.getByText('Garden weekly').click()
  await page.frameLocator('iframe.body-frame').getByText('This week in the garden').waitFor()
  await expect(frame).toHaveCSS('opacity', '1')
  const narrow = await measure('#letter')
  expect(narrow.view).toBeLessThan(600) // a pane narrower than the letter, beside the list at an everyday width
  expect(narrow.sideways).toBe(0)
  expect(narrow.width).toBeLessThanOrEqual(narrow.view)
  expect(narrow.width).toBeGreaterThan(narrow.view * 0.85) // drawn to fit, and no smaller
  expect(narrow.frame).toBeLessThan(narrow.bottom + 40) // the frame is as tall as the letter is drawn, with no room left under it
  expect(narrow.frame).toBeGreaterThanOrEqual(Math.floor(narrow.bottom))
  expect((await measure('#banner')).width).toBeLessThan(552) // its picture shrinks with it
  expect(Number(narrow.bg.match(/\d+/)?.[0])).toBeLessThan(60) // still darkened for the dark window
  await page.frameLocator('iframe.body-frame').getByText('Read the rest').click()
  await expect.poll(() => run.opened()).toEqual(['https://garden.example/week'])

  await resize(1800, 900)
  await expect.poll(async () => (await measure('#letter')).width).toBe(600) // room enough: its own size, never larger
  expect((await measure('#letter')).sideways).toBe(0)
  expect((await measure('#banner')).width).toBe(552)

  // A reply that flows to the pane keeps its size, and its one wide table scrolls sideways by itself.
  await resize(1280, 800)
  await list.getByText('Figures', { exact: true }).click()
  await page.frameLocator('iframe.body-frame').getByText('Thanks, Linh').waitFor()
  await expect.poll(async () => (await measure('#figures')).parentSideways).toBeGreaterThan(0)
  const reply = await measure('#words')
  expect(reply.sideways).toBe(0)
  expect(reply.width).toBeGreaterThan(reply.view - 40) // the words fill the pane at their own size
  expect((await measure('#figures')).width).toBe(900)
})

// Mail that sets its body to the full width had the frame's margin added on, and so was always 36
// pixels too wide, however wide the pane.
test('mail that makes its page the full width fits a wide pane at its own size, the margin inside it', async () => {
  run = await launch({ size: [1920, 1000] })
  const { page, gmail } = run
  const html = '<style>body{width:100%}</style><table width="100%" bgcolor="#f4f4f4"><tr><td id="note">The order is on its way, and should be with you on Friday.</td></tr></table>'
  gmail.add(rawMail({ subject: 'On its way', from: 'Mai Tran <mai@example.com>', html }), { arrived: earlier(3) })
  await signIn(run)
  await page.locator('.threads').getByText('On its way', { exact: true }).click()
  await page.frameLocator('iframe.body-frame').getByText('should be with you on Friday').waitFor()
  const sits = await page.locator('iframe.body-frame').evaluate((f: HTMLIFrameElement) => {
    const doc = f.contentDocument as Document
    return {
      sideways: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
      view: doc.documentElement.clientWidth,
      width: (doc.getElementById('note') as Element).closest('table')?.getBoundingClientRect().width ?? 0
    }
  })
  expect(sits.sideways).toBe(0)
  expect(Math.abs(sits.width - (sits.view - 36))).toBeLessThan(1) // the frame's own margin either side, and not drawn smaller
})

/** A newsletter with a picture that isn't shown until asked for. */
const PICTURED = `<table id="card" width="100%" bgcolor="#ffffff"><tr><td style="color:#222222">
  <img id="hero" src="https://pictures.example/hero.png" width="300" height="120" alt=""><p>Spring sale, this week only.</p></td></tr></table>`

test('a picture not shown yet is a block that suits the page it sits on: dark on a darkened page, pale on a white one', async () => {
  run = await launch({ colorScheme: 'dark' })
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Spring sale', from: 'Mai Tran <mai@example.com>', html: PICTURED }), { arrived: earlier(3) })
  await signIn(run)
  const frame = page.locator('iframe.body-frame')
  /** 0 for black to 255 for white, near enough, of what's under the picture and of the page round it. */
  const shades = (): Promise<{ block: number; page: number }> => frame.evaluate((f: HTMLIFrameElement) => {
    const doc = f.contentDocument as Document
    const view = doc.defaultView as Window
    const light = (css: string): number => {
      const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number)
      return (r + g + b) / 3
    }
    return { block: light(view.getComputedStyle(doc.getElementById('hero') as Element).backgroundColor), page: light(view.getComputedStyle(doc.getElementById('card') as Element).backgroundColor) }
  })
  await page.locator('.threads').getByText('Spring sale', { exact: true }).click()
  await page.frameLocator('iframe.body-frame').getByText('Spring sale, this week only.').waitFor()
  await expect(page.getByRole('button', { name: 'Show original colours' })).toBeVisible()
  const darkened = await shades()
  expect(darkened.page).toBeLessThan(40)
  expect(darkened.block).toBeLessThan(80) // was the pale #e9ecf0, a white slab on the dark page
  expect(darkened.block).toBeGreaterThan(darkened.page) // still a block that can be seen

  await page.getByRole('button', { name: 'Show original colours' }).click()
  await expect.poll(async () => (await shades()).page).toBe(255)
  expect((await shades()).block).toBeGreaterThan(200) // on the white page it was made for, a pale one
})

// The open message worked out once whether the window was dark, so a theme switched meanwhile left a
// darkened message in a light window, or a white card in a dark one.
test('the open message follows the look as it changes, the system\'s and the one Settings choose', async () => {
  run = await launch({ colorScheme: 'dark' })
  const { page, gmail } = run
  gmail.add(rawMail({ subject: 'Your order', from: 'Shop <orders@shop.example>', html: LIGHT_RECEIPT }), { arrived: earlier(3) })
  await signIn(run)
  const frame = page.locator('iframe.body-frame')
  /** The receipt's background, or 'not yet' while its frame is being made again. */
  const card = (): Promise<string> => frame.evaluate((f: HTMLIFrameElement) => {
    const doc = f.contentDocument
    const el = doc?.getElementById('card')
    return el && doc?.defaultView ? doc.defaultView.getComputedStyle(el).backgroundColor : 'not yet'
  }).catch(() => 'not yet')
  const original = page.getByRole('button', { name: 'Show original colours' })
  await page.locator('.threads').getByText('Your order').click()
  await expect(original).toBeVisible()
  await expect.poll(card).toMatch(/^rgb\((\d|[1-5]\d), /) // darkened

  await page.emulateMedia({ colorScheme: 'light' }) // as the desktop's theme switching to a light one
  await expect.poll(card).toBe('rgb(255, 255, 255)')
  await expect(original).toHaveCount(0)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(original).toBeVisible()
  await expect.poll(card).toMatch(/^rgb\((\d|[1-5]\d), /)

  await page.evaluate(() => window.mail.saveProfile({ theme: 'light' }))
  await expect.poll(card).toBe('rgb(255, 255, 255)')
  await expect(original).toHaveCount(0)
  await page.evaluate(() => window.mail.saveProfile({ theme: 'dark' }))
  await expect(original).toBeVisible()
  await expect.poll(card).toMatch(/^rgb\((\d|[1-5]\d), /)
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
