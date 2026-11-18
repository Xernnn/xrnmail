import type { HeaderDetails, MessageView, Settings } from './types'

/** Whether a message's pictures load without being asked for, apart from the page so it can be tested
 *  without one. */

const domainOf = (address: string): string => address.split('@').pop()?.toLowerCase() ?? ''

/** A signer speaks for the From line's domain when it is that domain, or one is under the other, as
 *  mail.shop.example and shop.example are. Never by sharing only an ending: co.uk is everyone's. */
const aligned = (signer: string, domain: string): boolean =>
  signer === domain || domain.endsWith(`.${signer}`) || signer.endsWith(`.${domain}`)

/**
 * The top Authentication-Results, which the account's own server added, says the message is from
 * the domain on its From line: DMARC passed, or a DKIM signature by that domain did. Anything less,
 * a missing line or one that passed for some other domain, is no proof of who wrote the From line.
 */
export function authenticated(details: Pick<HeaderDetails, 'checks' | 'signedBy'> | null, address: string): boolean {
  if (!details?.checks) return false
  if (details.checks.dmarc === 'pass') return true
  const domain = domainOf(address)
  return details.signedBy.some((signer) => aligned(signer, domain))
}

/** Pictures load by themselves when Settings say always, or the sender is one to load them from and
 *  the message is proved to be theirs: anyone can write a trusted sender's address on a From line. */
export function imagesLoad(
  message: Pick<MessageView, 'from' | 'warnings' | 'authenticated'>,
  settings: Pick<Settings, 'images' | 'imagesFrom'> | null | undefined,
  bins: boolean
): boolean {
  if (bins || message.warnings.length > 0) return false
  if (settings?.images === 'always') return true
  return message.authenticated && (settings?.imagesFrom ?? []).includes(message.from.address.toLowerCase())
}
