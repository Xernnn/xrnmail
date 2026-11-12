import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Face } from '@shared/types'
import { isPublicHttps } from './safe-url'

/**
 * Faces for senders and for your own accounts: a person's photo from Gravatar, a company's logo from
 * its BIMI record or, failing that, DuckDuckGo's icon for its domain, and initials when there's none.
 *
 * Every lookup tells someone something, so it's done here in the main process, only over https, for
 * a sender when their mail arrives or when they're first shown in a list, never because a message
 * was opened. What's found, and what isn't, is kept on disk for weeks, so each one is asked rarely.
 * A picture is decoration: anyone can publish one for their own address or domain, so it proves
 * nothing about who sent a message, and the page shows initials for mail with a sender warning.
 */

export type PictureType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon' | 'image/svg+xml'

export interface Picture {
  /** What the bytes turned out to be, whatever the server said they were. */
  type: PictureType
  bytes: Buffer
}


/** Where pictures come from. Each answers a picture, or null for "has none", and throws when it
 *  couldn't find out, which is tried again sooner. */
export interface PictureSources {
  photo(address: string): Promise<Picture | null>
  logo(domain: string): Promise<Picture | null>
}

const DAY_MS = 86_400_000
/** How long a picture is kept before it's looked up again. It's shown meanwhile. */
const FOUND_MS = 30 * DAY_MS
/** How long "none" is believed. */
const NONE_MS = 7 * DAY_MS
/** How long a lookup that failed waits before it's tried again. */
const FAILED_MS = 6 * 3_600_000
const TIMEOUT_MS = 8_000
/** Raster pictures: a Gravatar at the size asked for is a few kilobytes. */
export const MAX_RASTER = 200 * 1024
/** BIMI asks for SVG Tiny PS logos of 32 KB at most. */
export const MAX_SVG = 64 * 1024
/** How many lookups run at once. */
const PARALLEL = 3
/** Faces ready to hand to the page, kept in memory. The rest are read from disk again when asked. */
const MOST_KEPT_URLS = 400
/** Pictures are drawn at 44 pixels, twice that on a sharp screen. */
const PHOTO_SIZE = 96

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Gravatar's key for an address: the SHA-256 of it trimmed and lower-cased. */
export const gravatarHash = (address: string): string => sha256(address.trim().toLowerCase())

/** Free mail services: every address on them would otherwise get the service's own logo. */
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|passport|yahoo|ymail|rocketmail|icloud|me|mac|aol|aim|proton|protonmail|pm|gmx|web|mail|email|inbox|mail2world|yandex|ya|zoho|zohomail|fastmail|hey|qq|163|126|yeah|sina|naver|daum|hanmail|tutanota|tuta|tutamail|seznam|wp|o2|libero|virgilio|laposte|orange|free|t-online|freenet|rambler|bk|list|ukr|rediffmail|lycos|mailfence|posteo|runbox|disroot|riseup|duck|simplelogin|anonaddy|addy)\.[a-z.]+$/i

export const isFreeMail = (domain: string): boolean => FREE_MAIL.test(domain)

/** Second levels that are bought under, as in example.co.uk or example.edu.vn. */
const SHARED_SECOND = /^(co|com|net|org|edu|gov|ac|or|ne|go|gob|mil|nic|ltd|plc|sch|info|biz|id)$/

/** The part of a domain that's bought: mail.example.com and example.com are the same company. */
export function organization(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const second = parts.at(-2) ?? ''
  const keep = SHARED_SECOND.test(second) && (parts.at(-1)?.length ?? 0) === 2 ? 3 : 2
  return parts.slice(-keep).join('.')
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

const domainOf = (address: string): string => {
  const domain = address.trim().toLowerCase().split('@')[1] ?? ''
  return HOST.test(domain) ? domain : ''
}

/** What a picture's bytes are, by their first few: a server's word for it isn't taken. SVG only
 *  where it's allowed, and only an SVG document, not markup that merely contains one. */
export function sniff(bytes: Buffer, svg = false): PictureType | null {
  if (bytes.length < 8) return null
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const head = bytes.subarray(0, 12).toString('latin1')
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp'
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  if (svg) {
    const text = bytes.subarray(0, 2048).toString('utf8').replace(/^﻿/, '')
    if (/^\s*(<\?xml[^>]{0,200}\?>\s*)?(<!--[\s\S]{0,1000}?-->\s*)*(<!DOCTYPE svg[^>]{0,300}>\s*)?(<!--[\s\S]{0,1000}?-->\s*)*<svg[\s>]/i.test(text)) return 'image/svg+xml'
  }
  return null
}

/** The body, if it's no bigger than [max]. A server can say anything about its length, or nothing,
 *  so it's counted as it comes and the rest refused. */
export async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  const said = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(said) && said > max) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** A domain's public TXT records, each joined from its parts. Not there at all answers []. */
export type TxtLookup = (name: string) => Promise<string[]>

/** The logo a domain's BIMI record names: https only, and none for a record that declines. */
export function bimiLogo(records: string[]): string | null {
  const record = records.map((r) => r.trim()).find((r) => /^v\s*=\s*BIMI1\s*(;|$)/i.test(r))
  if (!record) return null
  for (const part of record.split(';')) {
    const [tag, ...rest] = part.split('=')
    if (tag?.trim().toLowerCase() !== 'l') continue
    const url = rest.join('=').trim()
    return url && isPublicHttps(url) ? url : null
  }
  return null
}

/**
 * The real sources, with the network and DNS passed in. Every request is a plain GET to https on a
 * public name, with no redirects (each of these answers in place, and a redirect could go anywhere),
 * no cookies, a time limit and a size limit, and what comes back has to be a picture by its bytes.
 */
export function webSources(fetcher: typeof fetch, txt: TxtLookup): PictureSources {
  const get = async (url: string, max: number, svg: boolean): Promise<Picture | null> => {
    if (!isPublicHttps(url)) return null
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: svg ? 'image/svg+xml' : 'image/png,image/jpeg,image/gif,image/webp,image/x-icon;q=0.9' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Answered ${response.status}`)
    }
    const bytes = await readCapped(response, max)
    if (!bytes) return null
    const type = sniff(bytes, svg)
    // BIMI is SVG and nothing else; the others are pictures of any common kind, never SVG.
    if (!type || (svg && type !== 'image/svg+xml')) return null
    return { type, bytes }
  }
  const bimi = async (domain: string): Promise<Picture | null> => {
    const url = bimiLogo(await txt(`default._bimi.${domain}`))
    return url ? get(url, MAX_SVG, true) : null
  }
  return {
    photo: (address) => get(`https://gravatar.com/avatar/${gravatarHash(address)}?s=${PHOTO_SIZE}&d=404&r=g`, MAX_RASTER, false),
    logo: async (domain) => {
      // BIMI is looked for where the mail says it's from, then at the company it belongs to.
      const base = organization(domain)
      const found = (await bimi(domain)) ?? (base !== domain ? await bimi(base) : null)
      return found ?? get(`https://icons.duckduckgo.com/ip3/${base}.ico`, MAX_RASTER, false)
    }
  }
}

interface Entry {
  /** When it was looked up. */
  at: number
  /** When to look again. Chosen photos never are. */
  until: number
  /** Under the cache folder, or null for none. */
  file: string | null
  type: PictureType | null
}

const EXTENSIONS: Record<PictureType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/x-icon': 'ico', 'image/svg+xml': 'svg'
}

export interface AvatarOptions {
  /** Where pictures are kept. Null keeps them in memory only. */
  dir: string | null
  /** Null looks nothing up: what's kept, and chosen photos, are all there is. */
  sources: PictureSources | null
  now(): number
  /** Something new was found, so the page should ask again. */
  found?(): void
  /** Draws a raster picture again, smaller and with nothing in it but pixels. Null when it can't be
   *  read, which is taken as no picture at all. */
  redraw?(picture: Picture): Picture | null
  /** Which account an address is yours on, if it is: your accounts show your own photo, and never
   *  a company's logo. */
  ownerOf?(address: string): string | null
}

const INDEX = 'index.json'
/** The only names this cache gives its pictures. An index that names anything else, written by
 *  something else or damaged, would have a face read from, or deleted at, a path of its choosing. */
const PICTURE_FILE = new RegExp(`^[0-9a-f]{32}\\.(${Object.values(EXTENSIONS).join('|')})$`)
const sound = (entry: Entry | undefined): entry is Entry =>
  Boolean(entry) && typeof entry?.at === 'number' && typeof entry.until === 'number' &&
  (entry.file === null || (typeof entry.file === 'string' && PICTURE_FILE.test(entry.file) && typeof entry.type === 'string' && entry.type in EXTENSIONS))

export class Avatars {
  private entries = new Map<string, Entry>()
  private memory = new Map<string, Buffer>()
  private urls = new Map<string, string>()
  private queue: string[] = []
  private queued = new Set<string>()
  /** Companies being asked about now. */
  private asking = new Set<string>()
  private running = 0
  private foundTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private options: AvatarOptions) {
    if (!options.dir) return
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 })
      const saved = JSON.parse(readFileSync(join(options.dir, INDEX), 'utf8')) as Record<string, Entry>
      const stale = options.now() - FOUND_MS
      for (const [key, entry] of Object.entries(saved)) {
        if (!sound(entry)) continue
        // A "none" long past its time says nothing any more, and the list shouldn't grow for ever.
        if (!entry.file && entry.until < stale) continue
        this.entries.set(key, entry)
      }
    } catch {
      // Nothing kept yet, or something unreadable: it's only a cache.
    }
  }

  /** The faces known now. With [lookUp], what isn't known, or is due again, is looked up behind the
   *  scenes, and `found` says when there's more. */
  faces(addresses: string[], lookUp: boolean): Record<string, Face | null> {
    const answer: Record<string, Face | null> = {}
    for (const raw of addresses.slice(0, 500)) {
      const address = raw.trim().toLowerCase()
      if (!address || address in answer) continue
      answer[address] = this.faceOf(address)
      if (lookUp) this.want([address])
    }
    return answer
  }

  /** Looks these up if they're not known or are due again, without waiting. */
  want(addresses: string[]): void {
    if (!this.options.sources) return
    const now = this.options.now()
    for (const raw of addresses) {
      const address = raw.trim().toLowerCase()
      if (!domainOf(address) || this.queued.has(address)) continue
      const person = this.entries.get(`p:${address}`)
      const domain = this.logoDomain(address)
      const company = domain ? this.entries.get(`d:${domain}`) : undefined
      const personDue = !person || person.until <= now
      // A person with a photo needs nothing more; without one, their company's logo is wanted.
      const companyDue = domain !== null && !person?.file && (!company || company.until <= now)
      if (!personDue && !companyDue) continue
      this.queued.add(address)
      this.queue.push(address)
    }
    this.pump()
  }

  /** An account's own photo, chosen from a file: kept until it's taken away. */
  choose(account: string, picture: Picture): void {
    this.keep(`own:${account.toLowerCase()}`, picture, Number.MAX_SAFE_INTEGER)
    this.writeIndex()
  }

  forget(account: string): void {
    this.drop(`own:${account.toLowerCase()}`)
    this.writeIndex()
  }

  chosen(account: string): boolean {
    return Boolean(this.entries.get(`own:${account.toLowerCase()}`)?.file)
  }

  /** Lets everything running finish, and writes down what was found. */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    this.writeIndex()
  }

  private logoDomain(address: string): string | null {
    if (this.options.ownerOf?.(address)) return null
    const domain = domainOf(address)
    if (!domain || isFreeMail(domain) || isFreeMail(organization(domain))) return null
    return organization(domain)
  }

  private faceOf(address: string): Face | null {
    const owner = this.options.ownerOf?.(address)
    if (owner) {
      const mine = this.urlOf(`own:${owner.toLowerCase()}`)
      if (mine) return { url: mine, logo: false }
    }
    const photo = this.urlOf(`p:${address}`)
    if (photo) return { url: photo, logo: false }
    const domain = this.logoDomain(address)
    const logo = domain ? this.urlOf(`d:${domain}`) : null
    return logo ? { url: logo, logo: true } : null
  }

  private urlOf(key: string): string | null {
    const entry = this.entries.get(key)
    if (!entry?.file || !entry.type) return null
    const cached = this.urls.get(entry.file)
    if (cached) return cached
    const bytes = this.read(entry.file)
    if (!bytes) {
      // The picture has gone from the folder: what's known of it is forgotten, so it's looked up
      // again the next time it's wanted instead of showing initials until its month is out.
      this.entries.delete(key)
      this.saveIndex()
      return null
    }
    const url = `data:${entry.type};base64,${bytes.toString('base64')}`
    if (this.urls.size >= MOST_KEPT_URLS) this.urls.clear()
    this.urls.set(entry.file, url)
    return url
  }

  private read(file: string): Buffer | null {
    const kept = this.memory.get(file)
    if (kept) return kept
    if (!this.options.dir) return null
    try {
      return readFileSync(join(this.options.dir, file))
    } catch {
      return null
    }
  }

  private pump(): void {
    while (this.running < PARALLEL && this.queue.length > 0) {
      const address = this.queue.shift() as string
      this.running++
      void this.lookUp(address).catch(() => undefined).finally(() => {
        this.running--
        this.queued.delete(address)
        this.pump()
      })
    }
  }

  private async lookUp(address: string): Promise<void> {
    const sources = this.options.sources
    if (!sources) return
    const now = this.options.now()
    const personKey = `p:${address}`
    const person = this.entries.get(personKey)
    let photo = Boolean(person?.file)
    if (!person || person.until <= now) photo = await this.ask(personKey, () => sources.photo(address))
    if (photo) return
    const domain = this.logoDomain(address)
    if (!domain) return
    const company = this.entries.get(`d:${domain}`)
    if (company && company.until > this.options.now()) return
    // Several senders at one company share the lookup: the first to get here asks.
    if (this.asking.has(domain)) return
    this.asking.add(domain)
    try {
      await this.ask(`d:${domain}`, () => sources.logo(domain))
    } finally {
      this.asking.delete(domain)
    }
  }

  /** Asks, keeps the answer, and says whether there's a picture now. */
  private async ask(key: string, source: () => Promise<Picture | null>): Promise<boolean> {
    const now = this.options.now()
    let found: Picture | null
    try {
      found = await source()
    } catch {
      // Not known either way: what's kept stays, and it's asked again before long.
      const old = this.entries.get(key)
      this.entries.set(key, old ? { ...old, until: now + FAILED_MS } : { at: now, until: now + FAILED_MS, file: null, type: null })
      this.saveIndex()
      return Boolean(old?.file)
    }
    const drawn = found && found.type !== 'image/svg+xml' && this.options.redraw ? this.options.redraw(found) : found
    if (drawn) this.keep(key, drawn, now + FOUND_MS)
    else {
      this.drop(key)
      this.entries.set(key, { at: now, until: now + NONE_MS, file: null, type: null })
    }
    this.saveIndex()
    if (drawn) this.announce()
    return drawn !== null
  }

  private keep(key: string, picture: Picture, until: number): void {
    this.drop(key)
    const file = `${sha256(`${key}:${this.options.now()}`).slice(0, 32)}.${EXTENSIONS[picture.type]}`
    if (this.options.dir) {
      try {
        writeFileSync(join(this.options.dir, file), picture.bytes, { mode: 0o600 })
      } catch {
        this.memory.set(file, picture.bytes)
      }
    } else this.memory.set(file, picture.bytes)
    this.entries.set(key, { at: this.options.now(), until, file, type: picture.type })
  }

  private drop(key: string): void {
    const old = this.entries.get(key)
    this.entries.delete(key)
    if (!old?.file) return
    this.urls.delete(old.file)
    this.memory.delete(old.file)
    if (this.options.dir) rmSync(join(this.options.dir, old.file), { force: true })
  }

  /** A burst of lookups writes the index once. */
  private saveIndex(): void {
    if (!this.options.dir || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.writeIndex(), 2000)
    this.saveTimer.unref?.()
  }

  private writeIndex(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.options.dir) return
    const path = join(this.options.dir, INDEX)
    try {
      writeFileSync(`${path}.new`, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 })
      renameSync(`${path}.new`, path)
    } catch {
      // Only a cache: the next save tries again.
    }
  }

  /** Many found in a burst make one message to the page. */
  private announce(): void {
    if (this.foundTimer || !this.options.found) return
    this.foundTimer = setTimeout(() => {
      this.foundTimer = null
      this.options.found?.()
    }, 400)
    this.foundTimer.unref?.()
  }
}
