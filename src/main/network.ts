import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/** How often the network is looked at, in ms. Reading it is cheap: one system call. */
export const NETWORK_LOOK_MS = 5_000
/** How long a change has to hold before it's told of, so a VPN coming up in steps is one change. */
export const NETWORK_SETTLE_MS = 2_000

type Interfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>

/** What the laptop is connected through, as one string: each interface and its addresses, leaving
 *  out the loopback. A VPN connecting, or its kill switch coming up, adds an interface; another
 *  Wi-Fi changes an address. Nothing when it can't be read just now. */
function fingerprint(interfaces: Interfaces): string | null {
  try {
    return Object.entries(interfaces())
      .flatMap(([name, found]) => (found ?? []).filter((each) => !each.internal).map((each) => `${name} ${each.cidr ?? each.address}`))
      .sort()
      .join('\n')
  } catch {
    return null
  }
}

/** Tells [changed] when the network has changed and held that way a moment, without waiting for
 *  the laptop to sleep and wake: a VPN reconnecting, its kill switch, another Wi-Fi, a cable. Every
 *  connection open then may be dead or on the wrong route. Returns what stops it. */
export function watchNetwork(changed: () => void, interfaces: Interfaces = networkInterfaces): () => void {
  let known = fingerprint(interfaces)
  let settling: NodeJS.Timeout | null = null
  const settle = (): void => {
    if (settling) clearTimeout(settling)
    settling = setTimeout(() => {
      settling = null
      const now = fingerprint(interfaces)
      if (now !== null && now !== known) {
        known = now // still changing: wait for it to hold
        return settle()
      }
      changed()
    }, NETWORK_SETTLE_MS)
    settling.unref?.()
  }
  const look = setInterval(() => {
    const now = fingerprint(interfaces)
    if (now === null || now === known) return
    // The first reading that works, after none could be made, is where things stand, not a change.
    const first = known === null
    known = now
    if (!first) settle()
  }, NETWORK_LOOK_MS)
  look.unref?.()
  return () => {
    clearInterval(look)
    if (settling) clearTimeout(settling)
  }
}
