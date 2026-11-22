import { useEffect, useSyncExternalStore } from 'react'
import type { Face } from '@shared/types'

/**
 * Faces the main process has for addresses, kept for the life of the page. Asking is batched: every
 * avatar drawn in one go becomes one request. Lists ask with `lookUp`, which lets the main process
 * look a sender up; the reader only asks what's already known, so opening a message never makes a
 * request anyone else could see.
 */

/** Undefined: not asked yet. Null: none known. */
const known = new Map<string, Face | null>()
const listeners = new Set<() => void>()
const wanted = { look: new Set<string>(), peek: new Set<string>() }
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

const tell = (): void => listeners.forEach((listener) => listener())

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!started && typeof window !== 'undefined' && window.mail?.onFaces) {
    started = true
    // Something new was found: what had none is asked about again. Faces turned off or on: all is.
    window.mail.onFaces((again) => {
      for (const [address, face] of known) if (again || face === null) known.delete(address)
      tell()
    })
  }
  return () => listeners.delete(listener)
}

/** The main process takes so many at a time. */
const AT_ONCE = 200

async function ask(addresses: string[], lookUp: boolean): Promise<void> {
  for (let i = 0; i < addresses.length; i += AT_ONCE) {
    const some = addresses.slice(i, i + AT_ONCE)
    try {
      const found = await window.mail.faces(some, lookUp)
      for (const address of some) known.set(address, found[address] ?? null)
    } catch {
      for (const address of some) known.set(address, null)
    }
    tell()
  }
}

function request(address: string, lookUp: boolean): void {
  if (lookUp) {
    wanted.look.add(address)
    wanted.peek.delete(address)
  } else if (!wanted.look.has(address)) wanted.peek.add(address)
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const look = [...wanted.look]
    const peek = [...wanted.peek]
    wanted.look.clear()
    wanted.peek.clear()
    void ask(look, true)
    void ask(peek, false)
  }, 30)
}

/** Looks these up if they aren't known yet, for faces about to be wanted: a list names everyone in a
 *  thread, so the reader can show their faces when it's opened without asking anything then. */
export function wantFaces(addresses: string[]): void {
  for (const raw of addresses) {
    const key = raw.trim().toLowerCase()
    if (key && !known.has(key)) request(key, true)
  }
}

/** Everything is asked about again: an account's own photo was chosen or taken away. */
export function forgetFaces(): void {
  known.clear()
  tell()
}

/** The face for an address, once the main process has said. An empty address has none. */
export function useFace(address: string, lookUp: boolean): Face | null {
  const key = address.trim().toLowerCase()
  const face = useSyncExternalStore(subscribe, () => (key ? known.get(key) : null))
  useEffect(() => {
    if (key && face === undefined) request(key, lookUp)
  }, [key, lookUp, face])
  return face ?? null
}
