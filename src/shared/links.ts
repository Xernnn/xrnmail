import { organization } from './domains'

/** A link whose words name one place and whose address goes to another: what the words show, and
 *  where it really goes. */
export interface OddLink {
  host: string
  shown: string
}

/** Words that are nothing but an address or a domain, as "paypal.com" or "https://paypal.com/login". */
const ONLY_AN_ADDRESS = /^(?:https?:\/\/)?(?:[^\s/@]{1,200}@)?((?:[\p{L}\p{N}-]{1,63}\.){1,10}[\p{L}]{2,63})\.?(?::\d{1,5})?(?:[/?#]\S*)?$/iu

/** The host a domain is in an address, as a link's own would be written (punycode). */
function hostOf(domain: string): string {
  try {
    return new URL(`https://${domain}/`).hostname
  } catch {
    return ''
  }
}

/**
 * Whether a link in a message isn't going where it says: its words are an address or a domain at
 * another company than the one it goes to, or the address dresses itself up with a name before an @
 * (https://paypal.com@evil.example/ goes to evil.example). Companies are told apart by the part of
 * a domain that's bought, so "shop.example" going to links.shop.example is fine.
 */
export function oddLink(href: string, words: string): OddLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname
  if (url.username || url.password) return { host, shown: decodeURIComponent(url.username) || host }
  const said = ONLY_AN_ADDRESS.exec(words.trim().slice(0, 2048))?.[1]
  if (!said) return null
  const shown = hostOf(said)
  if (!shown || organization(shown) === organization(host)) return null
  return { host, shown: said.toLowerCase() }
}
