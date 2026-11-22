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

lockDownNetwork()

/** Whether a picture asked for by the page [from] gets through. */
function let_through(from: number, resourceType = 'image', url = 'https://pictures.example/a.png'): boolean {
  let cancel: boolean | undefined
  requests.listener?.({ url, resourceType, webContentsId: from }, (answer) => void (cancel = answer.cancel))
  return cancel === false
}

describe('pictures in mail', () => {
  // With one switch for the whole app, the main window moving on to another thread turned pictures
  // off in a thread open in a window of its own, and Try again there could never fetch them.
  it('are let through for the window whose person asked, and that window alone', () => {
    const main = page(1)
    const own = page(2)
    allowImages(own, true)
    allowImages(main, true)
    allowImages(main, false)
    expect(let_through(2)).toBe(true)
    expect(let_through(1)).toBe(false)
    expect(let_through(3)).toBe(false)
    expect(let_through(2, 'xhr')).toBe(false)
    allowImages(own, false)
    expect(let_through(2)).toBe(false)
  })

  it('stop once that window has gone', () => {
    const own = page(4)
    allowImages(own, true)
    allowImages(own, true)
    expect(let_through(4)).toBe(true)
    own.emit('destroyed')
    expect(let_through(4)).toBe(false)
    expect(own.listenerCount('destroyed')).toBe(0)
  })

  // After Show images, a known service's open pixel loaded from CSS, a table cell's background or
  // anywhere else the page didn't find it.
  it('never let a known open-tracking service through, even when asked for', () => {
    const own = page(5)
    allowImages(own, true)
    expect(let_through(5)).toBe(true)
    for (const url of ['https://mandrillapp.com/track/open.php?u=1', 'https://x.list-manage.com/track/open.php?u=2', 'https://u1.sendgrid.net/wf/open?upn=3']) {
      expect(let_through(5, 'image', url), url).toBe(false)
    }
    allowImages(own, false)
  })
})
