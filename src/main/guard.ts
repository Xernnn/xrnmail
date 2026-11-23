import { app, ipcMain, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TRACKER } from '@shared/trackers'
import { isSafeExternalUrl } from './safe-url'

/**
 * Every email is written by a stranger, and the window holds a bridge to all of them. These walls
 * sit under the page's own sanitising, so one failing doesn't open everything.
 */

/** The dev server, in development only: honouring this in an installed build would let whoever
 *  sets the variable load any page next to the bridge. */
export const devServerUrl = (): string | undefined => (app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'])

export function isAppUrl(url: string): boolean {
  try {
    const dev = devServerUrl()
    if (dev) return new URL(url).origin === new URL(dev).origin
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.search = ''
    return parsed.href === pathToFileURL(join(__dirname, '../renderer/index.html')).href
  } catch {
    return false
  }
}

/** No new windows, no leaving the app, no frame going anywhere, no embedded pages. */
export function lockDownContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith('about:')) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** The pages, by id, whose person has asked to see a message's pictures, each with what lets go of
 *  it when the page goes. Each window is its own: one moving on to another thread doesn't take the
 *  pictures away from a thread open in another. */
const imagesAllowed = new Map<number, () => void>()

/** Set while the person has asked to see a message's pictures in [contents]. */
export function allowImages(contents: WebContents, allow: boolean): void {
  const { id } = contents
  const forget = imagesAllowed.get(id)
  if (!allow) {
    if (forget) contents.removeListener('destroyed', forget)
    imagesAllowed.delete(id)
  } else if (!forget) {
    const gone = (): void => void imagesAllowed.delete(id)
    imagesAllowed.set(id, gone)
    contents.once('destroyed', gone)
  }
}

/** A picture in an email is a tracker until someone says otherwise, and the page never needs the
 *  network, so everything it asks for is refused here. Mail itself is fetched by the main process,
 *  which doesn't pass through this. */
export function lockDownNetwork(): void {
  const web = session.defaultSession
  web.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const dev = devServerUrl()
      if (dev && details.url.startsWith(dev)) return callback({})
      const allowed = details.webContentsId !== undefined && imagesAllowed.has(details.webContentsId)
      // A known service's open-tracking address is refused even then, however the mail named it:
      // CSS has more ways to ask for a picture than the page can find and take out.
      callback({ cancel: !(allowed && details.resourceType === 'image') || TRACKER.test(details.url) })
    }
  )
  web.on('will-download', (event) => event.preventDefault())
  web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  web.setPermissionCheckHandler(() => false)
}

/** Every request must come from the app's own page, not a frame inside it. */
export function handle(channel: string, listener: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const url = event.senderFrame?.url ?? ''
    if (!isAppUrl(url)) throw new Error(`Refused ${channel}`)
    return (listener as (...values: unknown[]) => unknown)(...args)
  })
}

/** The same, for a request that has to know which page asked: what it holds is let go of when that
 *  page goes, however it goes. */
export function handleFrom(channel: string, listener: (sender: WebContents, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const url = event.senderFrame?.url ?? ''
    if (!isAppUrl(url)) throw new Error(`Refused ${channel}`)
    return (listener as (sender: WebContents, ...values: unknown[]) => unknown)(event.sender, ...args)
  })
}
