import { describe, expect, it } from 'vitest'
import { ADDRESS_ATTEMPT_MS, imapClient } from '@main/source'

// Through a VPN to a far exit, Gmail took 435 ms to answer, past the 250 ms Node gives each of a
// name's addresses, so every IPv4 try was dropped and the last address, an IPv6 one the VPN's kill
// switch swallowed, sat out the whole connect time: "Couldn't reach Gmail."
describe('a slow route to the server', () => {
  it('gives each of its addresses longer than a far VPN takes to answer', () => {
    expect(ADDRESS_ATTEMPT_MS).toBeGreaterThanOrEqual(2000)
    for (const security of ['tls', 'starttls'] as const) {
      const client = imapClient({ host: 'imap.example.com', port: 993, security, user: 'alex@example.com', secret: 'secret' })
      const socket = (client as unknown as { options: { tls?: { autoSelectFamilyAttemptTimeout?: number; rejectUnauthorized?: boolean } } }).options.tls
      expect(socket?.autoSelectFamilyAttemptTimeout).toBe(ADDRESS_ATTEMPT_MS)
      // Only the wait is changed: certificates are still checked.
      expect(socket?.rejectUnauthorized).not.toBe(false)
    }
  })
})
