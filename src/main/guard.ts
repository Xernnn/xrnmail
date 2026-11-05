import { app, ipcMain, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

let imagesAllowed = false

/** Set while the person has asked to see a message's pictures. */
export function allowImages(allow: boolean): void {
  imagesAllowed = allow
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
      callback({ cancel: !(imagesAllowed && details.resourceType === 'image') })
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
