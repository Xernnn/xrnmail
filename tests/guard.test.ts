import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

type Listener = (details: { url: string; resourceType: string; webContentsId?: number }, callback: (answer: { cancel?: boolean }) => void) => void
const requests = vi.hoisted(() => ({ listener: null as Listener | null }))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { handle: () => undefined },
  shell: { openExternal: async () => undefined },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: (_filter: unknown, listener: Listener) => void (requests.listener = listener) },
      on: () => undefined,
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined
    }
  }
}))

const { allowImages, lockDownNetwork } = await import('@main/guard')

/** A window's page, as far as the wall needs one. */
class Page extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}
const page = (id: number): Electron.WebContents => new Page(id) as unknown as Electron.WebContents

/** Names as the tests' own DNS has them: every one on the internet but these. */
const NAMES: Record<string, string[]> = { 'router.example': ['192.168.1.1'], 'split.example': ['203.0.113.9', '10.0.0.7'], 'nowhere.example': [] }
lockDownNetwork({ addresses: async (host) => NAMES[host] ?? ['203.0.113.7'] })

/** Whether a picture asked for by the page [from] gets through. */
async function let_through(from: number, resourceType = 'image', url = 'https://pictures.example/a.png'): Promise<boolean> {
  return new Promise((resolve) => requests.listener?.({ url, resourceType, webContentsId: from }, (answer) => resolve(answer.cancel === false)))
}

describe('pictures in mail', () => {
  // With one switch for the whole app, the main window moving on to another thread turned pictures
  // off in a thread open in a window of its own, and Try again there could never fetch them.
  it('are let through for the window whose person asked, and that window alone', async () => {
    const main = page(1)
    const own = page(2)
    allowImages(own, true)
    allowImages(main, true)
    allowImages(main, false)
    expect(await let_through(2)).toBe(true)
    expect(await let_through(1)).toBe(false)
    expect(await let_through(3)).toBe(false)
    expect(await let_through(2, 'xhr')).toBe(false)
    allowImages(own, false)
    expect(await let_through(2)).toBe(false)
  })

  it('stop once that window has gone', async () => {
    const own = page(4)
    allowImages(own, true)
    allowImages(own, true)
    expect(await let_through(4)).toBe(true)
    own.emit('destroyed')
    expect(await let_through(4)).toBe(false)
    expect(own.listenerCount('destroyed')).toBe(0)
  })

  // Shown, a stranger's picture could be fetched from this laptop (the xrnrule daemon on 127.0.0.1),
  // the router's page, or a service on the tailnet: whatever the address answered, the request had
  // been made, from inside the owner's own network.
  it('are never fetched from this laptop, the network it is on, or the tailnet', async () => {
    const own = page(6)
    allowImages(own, true)
    for (const url of [
      'http://127.0.0.1:47321/status.png', 'http://localhost/a.png', 'http://192.168.1.1/logo.png', 'http://10.1.2.3/a.png',
      'http://100.100.100.100/a.png', 'http://[::1]/a.png', 'http://[fd7a:115c:a1e0::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png',
      'https://printer.local/a.png', 'https://homeserver.tail0000.ts.net/a.png', 'https://router.example/a.png',
      'https://split.example/a.png', 'https://nowhere.example/a.png', 'http://0.0.0.0/a.png'
    ]) {
      expect(await let_through(6, 'image', url), url).toBe(false)
    }
    expect(await let_through(6, 'image', 'http://203.0.113.50/a.png')).toBe(true)
    allowImages(own, false)
  })

  // After Show images, a known service's open pixel loaded from CSS, a table cell's background or
  // anywhere else the page didn't find it.
  it('never let a known open-tracking service through, even when asked for', async () => {
    const own = page(5)
    allowImages(own, true)
    expect(await let_through(5)).toBe(true)
    for (const url of ['https://mandrillapp.com/track/open.php?u=1', 'https://x.list-manage.com/track/open.php?u=2', 'https://u1.sendgrid.net/wf/open?upn=3']) {
      expect(await let_through(5, 'image', url), url).toBe(false)
    }
    allowImages(own, false)
  })
})
