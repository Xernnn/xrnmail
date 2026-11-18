import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  Avatars, bimiLogo, gravatarHash, isFreeMail, MAX_RASTER, MAX_SVG, organization, sniff, webSources, type Picture, type PictureSources
} from '@main/avatars'

/** Nothing here reaches the network: every source and every answer is made up. */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]), Buffer.alloc(40, 2)])
const SVG = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps"><title>Shop</title></svg>')

const answer = (body: Buffer | string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers })

type Call = { url: string; init: RequestInit }

function fakeWeb(routes: Record<string, () => Response>): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const route = routes[url]
    return route ? route() : answer('', 404)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const noTxt = async (): Promise<string[]> => []

describe('what a picture is', () => {
  it('goes by its bytes, not what the server called it', () => {
    expect(sniff(PNG)).toBe('image/png')
    expect(sniff(ICO)).toBe('image/x-icon')
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(sniff(Buffer.from('<html><body>Not found</body></html>'))).toBeNull()
  })

  it('takes SVG only where it is allowed, and only a whole SVG document', () => {
    expect(sniff(SVG)).toBeNull()
    expect(sniff(SVG, true)).toBe('image/svg+xml')
    expect(sniff(Buffer.from('<!-- logo --><svg viewBox="0 0 1 1"></svg>'), true)).toBe('image/svg+xml')
    expect(sniff(Buffer.from('<html><svg></svg><script>alert(1)</script></html>'), true)).toBeNull()
  })

  it('hashes an address the way Gravatar does: SHA-256 of it trimmed and lower-cased', () => {
    const expected = createHash('sha256').update('mai@example.com').digest('hex')
    expect(gravatarHash('  Mai@Example.COM ')).toBe(expected)
  })

  it('knows a company from its mail domain, and free mail from a company', () => {
    expect(organization('e4.rover.com')).toBe('rover.com')
    expect(organization('mail.uni.edu.vn')).toBe('uni.edu.vn')
    expect(organization('news.shop.co.uk')).toBe('shop.co.uk')
    expect(organization('example.com')).toBe('example.com')
    expect(isFreeMail('gmail.com')).toBe(true)
    expect(isFreeMail('yahoo.co.uk')).toBe(true)
    expect(isFreeMail('outlook.com.vn')).toBe(true)
    expect(isFreeMail('rover.com')).toBe(false)
  })

  it('reads a BIMI record: its logo over https, and nothing when it declines', () => {
    expect(bimiLogo(['v=BIMI1; l=https://bimi.shop.example/logo.svg; a=https://bimi.shop.example/vmc.pem'])).toBe('https://bimi.shop.example/logo.svg')
    expect(bimiLogo(['v=BIMI1;l=https://bimi.shop.example/logo.svg'])).toBe('https://bimi.shop.example/logo.svg')
    expect(bimiLogo(['v=BIMI1; l=; a=;'])).toBeNull()
    expect(bimiLogo(['v=BIMI1; l=http://bimi.shop.example/logo.svg'])).toBeNull()
    expect(bimiLogo(['v=BIMI1; l=https://127.0.0.1/logo.svg'])).toBeNull()
    expect(bimiLogo(['v=spf1 include:_spf.example -all'])).toBeNull()
  })
})

describe('the sources', () => {
  const hash = gravatarHash('mai@example.com')
  const gravatar = `https://gravatar.com/avatar/${hash}?s=96&d=404&r=g`

  it('asks Gravatar for a photo by the hash alone, with no redirects or cookies, and takes 404 as none', async () => {
    const { fetcher, calls } = fakeWeb({ [gravatar]: () => answer(PNG, 200, { 'content-type': 'image/png' }) })
    const sources = webSources(fetcher, noTxt)
    expect(await sources.photo('Mai@Example.com')).toEqual({ type: 'image/png', bytes: PNG })
    expect(calls[0]?.url).toBe(gravatar)
    expect(calls[0]?.url).not.toContain('mai')
    expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(await sources.photo('nobody@example.com')).toBeNull()
  })

  it('turns down what is too big, whatever it says its length is, and what is not a picture', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_RASTER)])
    const streamed = (): Response => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(big.subarray(i * (big.length / 4), (i + 1) * (big.length / 4))))
        controller.close()
      }
    }), { status: 200 })
    let route: () => Response = () => answer(big, 200, { 'content-length': String(big.length) })
    const sources = webSources(fakeWeb({ [gravatar]: () => route() }).fetcher, noTxt)
    expect(await sources.photo('mai@example.com')).toBeNull()
    route = streamed
    expect(await sources.photo('mai@example.com')).toBeNull()
    route = () => answer('<html>a picture, honestly</html>', 200, { 'content-type': 'image/png' })
    expect(await sources.photo('mai@example.com')).toBeNull()
    route = () => answer(SVG, 200, { 'content-type': 'image/svg+xml' }) // a Gravatar is never SVG
    expect(await sources.photo('mai@example.com')).toBeNull()
  })

  it('says it could not find out when the service is down, so it is asked again sooner', async () => {
    const sources = webSources(fakeWeb({ [gravatar]: () => answer('busy', 503) }).fetcher, noTxt)
    await expect(sources.photo('mai@example.com')).rejects.toThrow('503')
  })

  it('takes a company logo from BIMI where the mail comes from, then from the company, as SVG only', async () => {
    const asked: string[] = []
    const txt = async (name: string): Promise<string[]> => {
      asked.push(name)
      return name === 'default._bimi.shop.example' ? ['v=BIMI1; l=https://bimi.shop.example/logo.svg'] : []
    }
    const { fetcher, calls } = fakeWeb({ 'https://bimi.shop.example/logo.svg': () => answer(SVG, 200, { 'content-type': 'image/svg+xml' }) })
    const logo = await webSources(fetcher, txt).logo('news.shop.example')
    expect(logo?.type).toBe('image/svg+xml')
    expect(asked).toEqual(['default._bimi.news.shop.example', 'default._bimi.shop.example'])
    expect(calls.map((c) => c.url)).toEqual(['https://bimi.shop.example/logo.svg'])
  })

  it('falls back to DuckDuckGo\'s icon for the company when BIMI has nothing usable', async () => {
    const txt = async (): Promise<string[]> => ['v=BIMI1; l=https://bimi.shop.example/logo.svg']
    const { fetcher, calls } = fakeWeb({
      'https://bimi.shop.example/logo.svg': () => answer('<html><script>alert(1)</script></html>', 200, { 'content-type': 'image/svg+xml' }),
      'https://icons.duckduckgo.com/ip3/shop.example.ico': () => answer(ICO, 200, { 'content-type': 'image/x-icon' })
    })
    expect(await webSources(fetcher, txt).logo('shop.example')).toEqual({ type: 'image/x-icon', bytes: ICO })
    expect(calls.map((c) => c.url)).toEqual(['https://bimi.shop.example/logo.svg', 'https://icons.duckduckgo.com/ip3/shop.example.ico'])
  })

  // The name was all that was checked, so a sender could point their BIMI record at a public name of
  // theirs that resolves to an address on this laptop or its network, and have it asked for there.
  it('asks nothing of a name that resolves to this laptop or its network', async () => {
    const txt = async (): Promise<string[]> => ['v=BIMI1; l=https://logo.shop.example/logo.svg']
    const where: Record<string, string[]> = {
      'logo.shop.example': ['192.168.1.1'],
      'icons.duckduckgo.com': ['203.0.113.7']
    }
    const { fetcher, calls } = fakeWeb({ 'https://icons.duckduckgo.com/ip3/shop.example.ico': () => answer(ICO, 200, { 'content-type': 'image/x-icon' }) })
    const sources = webSources(fetcher, txt, async (host) => where[host] ?? [])
    expect(await sources.logo('shop.example')).toEqual({ type: 'image/x-icon', bytes: ICO })
    expect(calls.map((c) => c.url)).toEqual(['https://icons.duckduckgo.com/ip3/shop.example.ico'])
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '169.254.1.1', '100.100.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.2']) {
      where['logo.shop.example'] = ['203.0.113.9', address]
      calls.length = 0
      await sources.logo('shop.example')
      expect(calls.map((c) => c.url)).not.toContain('https://logo.shop.example/logo.svg')
    }
  })

  it('keeps a BIMI logo to its size limit', async () => {
    const huge = Buffer.concat([SVG, Buffer.alloc(MAX_SVG, 32)])
    const txt = async (): Promise<string[]> => ['v=BIMI1; l=https://bimi.shop.example/logo.svg']
    const { fetcher } = fakeWeb({ 'https://bimi.shop.example/logo.svg': () => answer(huge) })
    expect(await webSources(fetcher, txt).logo('shop.example')).toBeNull()
  })
})

/** Sources that answer from a list, and count what they were asked. */
function made(photos: Record<string, Picture | 'fail'>, logos: Record<string, Picture | 'fail'> = {}): PictureSources & { asked: string[] } {
  const asked: string[] = []
  const pick = async (key: string, from: Record<string, Picture | 'fail'>): Promise<Picture | null> => {
    asked.push(key)
    const found = from[key.slice(key.indexOf(':') + 1)]
    if (found === 'fail') throw new Error('offline')
    return found ?? null
  }
  return { asked, photo: (address) => pick(`photo:${address}`, photos), logo: (domain) => pick(`logo:${domain}`, logos) }
}

const png: Picture = { type: 'image/png', bytes: PNG }
const svg: Picture = { type: 'image/svg+xml', bytes: SVG }
const DAY = 86_400_000

describe('keeping faces', () => {
  it('asks once, and answers from what it kept', async () => {
    const sources = made({ 'mai@example.com': png })
    const avatars = new Avatars({ dir: null, sources, now: () => 0 })
    expect(avatars.faces(['mai@example.com'], true)).toEqual({ 'mai@example.com': null })
    await avatars.idle()
    const face = avatars.faces(['Mai@example.com'], true)['mai@example.com']
    expect(face).toEqual({ url: `data:image/png;base64,${PNG.toString('base64')}`, logo: false })
    await avatars.idle()
    expect(sources.asked).toEqual(['photo:mai@example.com'])
  })

  it('never looks anything up when only asked what it knows', async () => {
    const sources = made({ 'mai@example.com': png })
    const avatars = new Avatars({ dir: null, sources, now: () => 0 })
    avatars.faces(['mai@example.com'], false)
    await avatars.idle()
    expect(sources.asked).toEqual([])
  })

  it('gives a person without a photo their company\'s logo, asking once for a whole company', async () => {
    const sources = made({}, { 'shop.example': svg })
    const avatars = new Avatars({ dir: null, sources, now: () => 0 })
    avatars.want(['orders@shop.example', 'news@e.shop.example', 'help@shop.example'])
    await avatars.idle()
    expect(sources.asked.filter((a) => a.startsWith('logo:'))).toEqual(['logo:shop.example'])
    expect(avatars.faces(['news@e.shop.example'], false)['news@e.shop.example']).toMatchObject({ logo: true })
  })

  it('looks for no logo on free mail, and none for your own addresses', async () => {
    const sources = made({}, { 'gmail.com': svg, 'work.example': svg })
    const avatars = new Avatars({ dir: null, sources, now: () => 0, ownerOf: (a) => (a === 'me@work.example' ? 'me@work.example' : null) })
    avatars.want(['friend@gmail.com', 'me@work.example'])
    await avatars.idle()
    expect(sources.asked.sort()).toEqual(['photo:friend@gmail.com', 'photo:me@work.example'])
  })

  it('believes "none" for a week, a picture for a month, and a failure for hours', async () => {
    let now = 0
    const photos: Record<string, Picture | 'fail'> = { 'down@example.com': 'fail', 'mai@example.com': png }
    const sources = made(photos)
    const avatars = new Avatars({ dir: null, sources, now: () => now })
    avatars.want(['nobody@example.org', 'down@example.com', 'mai@example.com'])
    await avatars.idle()
    const asked = (): string[] => sources.asked.filter((a) => a.startsWith('photo:'))
    expect(asked()).toHaveLength(3)
    now = 7 * 3_600_000
    avatars.want(['nobody@example.org', 'down@example.com', 'mai@example.com'])
    await avatars.idle()
    expect(asked().slice(3)).toEqual(['photo:down@example.com'])
    now = 8 * DAY
    avatars.want(['nobody@example.org', 'mai@example.com'])
    await avatars.idle()
    expect(asked().slice(4)).toEqual(['photo:nobody@example.org'])
    now = 31 * DAY
    avatars.want(['mai@example.com'])
    await avatars.idle()
    expect(asked().slice(5)).toEqual(['photo:mai@example.com'])
  })

  it('keeps showing a picture while it is being looked up again, and through a failed lookup', async () => {
    let now = 0
    const photos: Record<string, Picture | 'fail'> = { 'mai@example.com': png }
    const avatars = new Avatars({ dir: null, sources: made(photos), now: () => now })
    avatars.want(['mai@example.com'])
    await avatars.idle()
    now = 40 * DAY
    photos['mai@example.com'] = 'fail'
    avatars.want(['mai@example.com'])
    expect(avatars.faces(['mai@example.com'], false)['mai@example.com']).not.toBeNull()
    await avatars.idle()
    expect(avatars.faces(['mai@example.com'], false)['mai@example.com']).not.toBeNull()
  })

  it('takes a picture it cannot draw again for none', async () => {
    const avatars = new Avatars({ dir: null, sources: made({ 'mai@example.com': png }), now: () => 0, redraw: () => null })
    avatars.want(['mai@example.com'])
    await avatars.idle()
    expect(avatars.faces(['mai@example.com'], false)['mai@example.com']).toBeNull()
  })

  it('keeps what it found on disk, readable only by you, for the next start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-avatars-'))
    try {
      const first = new Avatars({ dir, sources: made({ 'mai@example.com': png }), now: () => 0 })
      first.want(['mai@example.com', 'nobody@example.org'])
      await first.idle()
      expect(readdirSync(dir).sort()).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.png$/), 'index.json'])
      const sources = made({})
      const second = new Avatars({ dir, sources, now: () => DAY })
      expect(second.faces(['mai@example.com', 'nobody@example.org'], true)['mai@example.com']).toMatchObject({ logo: false })
      await second.idle()
      expect(sources.asked).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads and deletes only pictures it named itself, whatever its index on disk says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-avatars-'))
    const outside = mkdtempSync(join(tmpdir(), 'xrnmail-outside-'))
    try {
      writeFileSync(join(outside, 'secret.png'), PNG)
      const damaged = {
        'p:mai@example.com': { at: 0, until: 10 * DAY, file: `../${basename(outside)}/secret.png`, type: 'image/png' },
        'p:bo@example.com': { at: 0, until: 10 * DAY, file: '0123456789abcdef0123456789abcdef.png', type: 'text/html' }
      }
      writeFileSync(join(dir, 'index.json'), JSON.stringify(damaged))
      const sources = made({ 'mai@example.com': png })
      const avatars = new Avatars({ dir, sources, now: () => DAY })
      expect(avatars.faces(['mai@example.com', 'bo@example.com'], false)).toEqual({ 'mai@example.com': null, 'bo@example.com': null })
      avatars.want(['mai@example.com']) // what replaces it would have deleted the old file
      await avatars.idle()
      expect(readFileSync(join(outside, 'secret.png'))).toEqual(PNG)
      expect(sources.asked).toEqual(['photo:mai@example.com']) // and it was looked up as unknown
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('looks a face up again when its picture has gone from the folder, instead of waiting out its month', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-avatars-'))
    try {
      const first = new Avatars({ dir, sources: made({ 'mai@example.com': png }), now: () => 0 })
      first.want(['mai@example.com'])
      await first.idle()
      for (const file of readdirSync(dir)) if (file.endsWith('.png')) rmSync(join(dir, file))
      const sources = made({ 'mai@example.com': png })
      const second = new Avatars({ dir, sources, now: () => DAY })
      expect(second.faces(['mai@example.com'], true)['mai@example.com']).toBeNull()
      await second.idle()
      expect(sources.asked).toEqual(['photo:mai@example.com'])
      expect(second.faces(['mai@example.com'], false)['mai@example.com']).toMatchObject({ logo: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forgets a "none" long past its time, so the list it keeps does not grow for ever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-avatars-'))
    try {
      const first = new Avatars({ dir, sources: made({ 'mai@example.com': png }), now: () => 0 })
      first.want(['mai@example.com', 'nobody@example.org'])
      await first.idle()
      const later = new Avatars({ dir, sources: null, now: () => 60 * DAY })
      await later.idle()
      const kept = Object.keys(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as object)
      expect(kept).toEqual(['p:mai@example.com'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shows an account\'s chosen photo on every address of it, until it is taken away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-avatars-'))
    try {
      const ownerOf = (a: string): string | null => (['me@example.com', 'alias@example.net'].includes(a) ? 'me@example.com' : null)
      const avatars = new Avatars({ dir, sources: null, now: () => 0, ownerOf })
      avatars.choose('me@example.com', png)
      expect(avatars.chosen('me@example.com')).toBe(true)
      expect(avatars.faces(['alias@example.net'], false)['alias@example.net']).toMatchObject({ logo: false })
      avatars.forget('me@example.com')
      expect(avatars.faces(['alias@example.net'], false)['alias@example.net']).toBeNull()
      expect(readdirSync(dir)).toEqual(['index.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says when there is something new, once for a burst', async () => {
    const found = vi.fn()
    const avatars = new Avatars({ dir: null, sources: made({ 'a@example.com': png, 'b@example.com': png }), now: () => 0, found })
    avatars.want(['a@example.com', 'b@example.com'])
    await avatars.idle()
    await vi.waitFor(() => expect(found).toHaveBeenCalledTimes(1))
  })
})
