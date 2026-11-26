import { isIP } from 'node:net'
import { plainName } from '@shared/names'

/** What may be handed to the operating system. A link in an email can say anything, and
 *  shell.openExternal launches whatever handles the scheme, including file: and smb:. */
const ALLOWED = new Set(['https:', 'http:', 'mailto:'])

export function isSafeExternalUrl(raw: string): boolean {
  try {
    return ALLOWED.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

/** Basic auth goes in the clear over plain http, so that's only for this machine. */
export function isSafeHubUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

/** For a request the app makes itself because a stranger's header said to: https to a public name
 *  only, so an email can't aim it at this laptop or the network it's on. */
export function isPublicHttps(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    if (host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.')) return false
    return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)
  } catch {
    return false
  }
}

/** An address on this machine or a network it's on, which no name a stranger gives should lead to:
 *  loopback, private, shared (carrier NAT, and Tailscale's), link-local, unspecified, multicast, and
 *  IPv6's unique-local, link-local and multicast, including IPv4 ones written as IPv6. */
export function isPrivateAddress(ip: string): boolean {
  // An IPv4 address written as IPv6 the way a URL writes it back, ::ffff:7f00:1 for 127.0.0.1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (mapped) {
    const [high, low] = [parseInt(mapped[1] ?? '0', 16), parseInt(mapped[2] ?? '0', 16)]
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i.exec(ip)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
  }
  const v6 = ip.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff')
}

/** Names that only ever lead to this laptop, the network it's on, or the tailnet. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa|ts\.net)$/

/** Whether a picture a message names may be fetched once its pictures are shown: never from this
 *  laptop, the network it's on or the tailnet, where a stranger's mail could reach a router's page
 *  or a service of the owner's own (the xrnrule daemon on 127.0.0.1, the home server). A name is
 *  looked up with [lookup] first, and every address it has must be on the internet; one that can't
 *  be looked up isn't fetched. As the phone does. */
export async function pictureMayBeFetched(raw: string, lookup: (host: string) => Promise<string[]>): Promise<boolean> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || LOCAL_NAME.test(host)) return false
  if (isIP(host)) return !isPrivateAddress(host)
  const addresses = await lookup(host).catch(() => [])
  return addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address))
}

export { canOpenDirectly } from '@shared/openable'

/** What a message's pictures, and anything else the window fetches, are asked for with: Chrome's
 *  own on Linux, as Chrome reduces it (the major version only). Electron's names the app and its
 *  version, and Electron's, which nobody else sends: every picture host could tell it was this one
 *  person who opened the mail. */
export const genericUserAgent = (chrome: string): string =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.split('.')[0] || '152'}.0.0.0 Safari/537.36`

/** Linux takes 255 bytes in a file name, and opening an attachment puts 9 more in front. */
const NAME_BYTES = 200

/** A name fit to suggest for saving: a stranger wrote it. A long one keeps its end, where its type
 *  is, cut by bytes on a character boundary. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  let kept = ''
  let bytes = 0
  for (const char of [...plainName(base).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')].reverse()) {
    bytes += Buffer.byteLength(char)
    if (bytes > NAME_BYTES) break
    kept = char + kept
  }
  const clean = kept.replace(/^\.+/, '').trim()
  return clean || 'attachment'
}

const TRACKING: Record<string, (number: string) => string> = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  DHL: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`
}

/** A carrier's own page for a parcel. The address is ours, never one from the message, so a fake
 *  shipping notice can't turn "Track" into a link of its choosing. */
export function trackingUrl(carrier: string, number: string): string | null {
  return /^[A-Za-z0-9-]+$/.test(number) ? (TRACKING[carrier]?.(number) ?? null) : null
}

/** Gmail's own page for a thread. IMAP gives the id in decimal; the web address wants hex. */
export function gmailThreadUrl(email: string, thread: string): string {
  const id = /^\d+$/.test(thread) ? BigInt(thread).toString(16) : ''
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${id}`
}
