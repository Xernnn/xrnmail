import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { NETWORK_LOOK_MS, NETWORK_SETTLE_MS, watchNetwork } from '@main/network'

const address = (ip: string, internal = false): NetworkInterfaceInfo => ({
  address: ip, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${ip}/24`
})

const WIFI = { lo: [address('127.0.0.1', true)], wlan0: [address('192.168.1.20')] }
const VPN = { ...WIFI, tun0: [address('10.2.0.2')] }

let now: NodeJS.Dict<NetworkInterfaceInfo[]>
let changes: number
let stop: () => void

beforeEach(() => {
  vi.useFakeTimers()
  now = WIFI
  changes = 0
  stop = watchNetwork(() => changes++, () => now)
})

afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('the network changing while awake', () => {
  it('is noticed without sleep, once it has settled, and only once', () => {
    vi.advanceTimersByTime(NETWORK_LOOK_MS * 3)
    expect(changes).toBe(0)
    now = VPN // a VPN reconnects
    vi.advanceTimersByTime(NETWORK_LOOK_MS)
    expect(changes).toBe(0) // not until it's held a moment
    vi.advanceTimersByTime(NETWORK_SETTLE_MS)
    expect(changes).toBe(1)
    vi.advanceTimersByTime(NETWORK_LOOK_MS * 10)
    expect(changes).toBe(1)
    now = WIFI // and drops
    vi.advanceTimersByTime(NETWORK_LOOK_MS + NETWORK_SETTLE_MS)
    expect(changes).toBe(2)
  })

  it('waits for a network still changing to settle, and tells of it once', () => {
    now = { lo: WIFI.lo } // the Wi-Fi goes
    vi.advanceTimersByTime(NETWORK_LOOK_MS + NETWORK_SETTLE_MS / 2)
    now = { lo: WIFI.lo, wlan0: [address('192.168.7.30')] } // another one comes up
    vi.advanceTimersByTime(NETWORK_SETTLE_MS / 2)
    expect(changes).toBe(0)
    vi.advanceTimersByTime(NETWORK_SETTLE_MS)
    expect(changes).toBe(1)
    vi.advanceTimersByTime(NETWORK_LOOK_MS * 4)
    expect(changes).toBe(1)
  })

  it('takes no notice of the loopback, or of the same addresses listed in another order', () => {
    now = { wlan0: WIFI.wlan0, lo: [address('127.0.0.1', true), address('127.0.0.2', true)] }
    vi.advanceTimersByTime((NETWORK_LOOK_MS + NETWORK_SETTLE_MS) * 2)
    expect(changes).toBe(0)
  })

  it('carries on when the list can\'t be read for a moment, and takes the first it can read as where things stand', () => {
    stop()
    let failing = true
    stop = watchNetwork(() => changes++, () => {
      if (failing) throw new Error('uv_interface_addresses')
      return now
    })
    vi.advanceTimersByTime(NETWORK_LOOK_MS * 3)
    failing = false
    vi.advanceTimersByTime(NETWORK_LOOK_MS + NETWORK_SETTLE_MS)
    expect(changes).toBe(0)
    failing = true
    vi.advanceTimersByTime(NETWORK_LOOK_MS * 3)
    expect(changes).toBe(0)
    failing = false
    now = VPN
    vi.advanceTimersByTime(NETWORK_LOOK_MS + NETWORK_SETTLE_MS)
    expect(changes).toBe(1)
  })

  it('stops when told to', () => {
    stop()
    now = VPN
    vi.advanceTimersByTime((NETWORK_LOOK_MS + NETWORK_SETTLE_MS) * 2)
    expect(changes).toBe(0)
  })
})
