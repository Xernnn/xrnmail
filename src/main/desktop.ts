import { app, clipboard, Menu, nativeImage, Notification, session, shell, Tray, type MenuItemConstructorOptions, type NativeImage, type WebContents } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppCommand } from '@shared/types'
import { isSafeExternalUrl } from './safe-url'

/** The parts of being a desktop app that have nothing to do with mail: tray, menus, spelling. */

const TRAY_SIZE = 22
const DOT = 7

const iconPath = (): string => join(__dirname, '../../resources/icon.png')

/** Paints a dot in the tray icon's corner: there's no count to be had there on every desktop. */
function withDot(icon: NativeImage): NativeImage {
  const { width, height } = icon.getSize()
  const pixels = Buffer.from(icon.toBitmap())
  const centre = { x: width - DOT / 2 - 0.5, y: height - DOT / 2 - 0.5 }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - centre.x, y - centre.y)
      if (distance > DOT / 2 + 1) continue
      const at = (y * width + x) * 4
      const ring = distance > DOT / 2 // a pale edge keeps the dot apart from the icon behind it
      pixels.set(ring ? [255, 255, 255, 255] : [0x2b, 0x5a, 0xd2, 255], at) // the bitmap is BGRA
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height })
}

export class AppTray {
  private tray: Tray
  private plain: NativeImage
  private marked: NativeImage
  private shown = -1

  constructor(private actions: { show(): void; command(command: AppCommand): void; sync(): void; quit(): void }) {
    this.plain = nativeImage.createFromPath(iconPath()).resize({ width: TRAY_SIZE, height: TRAY_SIZE, quality: 'best' })
    this.marked = withDot(this.plain)
    this.tray = new Tray(this.plain)
    this.tray.on('click', actions.show)
    this.show(0)
  }

  show(unread: number): void {
    if (unread === this.shown) return
    this.shown = unread
    const words = unread === 0 ? 'No unread mail' : unread === 1 ? '1 unread' : `${unread} unread`
    this.tray.setImage(unread > 0 ? this.marked : this.plain)
    this.tray.setToolTip(`xrnmail: ${words}`)
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: words, enabled: false },
      { type: 'separator' },
      { label: 'Open xrnmail', click: this.actions.show },
      { label: 'New Message', click: () => { this.actions.show(); this.actions.command('compose') } },
      { label: 'Check for Mail', click: this.actions.sync },
      { type: 'separator' },
      { label: 'Quit xrnmail', click: this.actions.quit }
    ]))
  }

  destroy(): void {
    this.tray.destroy()
  }
}

export function appMenu(actions: { command(command: AppCommand): void; sync(): void }): Menu {
  const say = (command: AppCommand) => () => actions.command(command)
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Message', accelerator: 'CmdOrCtrl+N', click: say('compose') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: say('settings') },
        { type: 'separator' },
        { label: 'Print', accelerator: 'CmdOrCtrl+P', click: say('print') },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: say('search') },
        { label: 'Check for Mail', accelerator: 'F5', click: actions.sync },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: say('help') },
        { label: 'About xrnmail', click: say('about') }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}

/** Spelling follows the system's language, with Vietnamese alongside. The dictionaries are the
 *  only thing fetched here, they come from Chromium's own address, and they carry no mail. */
export function setUpSpelling(): void {
  const web = session.defaultSession
  const wanted = [app.getLocale(), 'en-US', 'vi']
  const available = new Set(web.availableSpellCheckerLanguages)
  web.setSpellCheckerLanguages([...new Set(wanted.filter((language) => available.has(language)))].slice(0, 3))
}

/** The right-click menu. Links come from a stranger, so they go through the same check as a click. */
export function addContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: word, click: () => contents.replaceMisspelling(word) })
      }
      if (items.length === 0) items.push({ label: 'No suggestions', enabled: false })
      items.push(
        { label: `Add "${params.misspelledWord.slice(0, 40)}" to Dictionary`, click: () => session.defaultSession.addWordToSpellCheckerDictionary(params.misspelledWord) },
        { type: 'separator' }
      )
    }
    if (params.linkURL) {
      const link = params.linkURL
      if (isSafeExternalUrl(link)) items.push({ label: 'Open Link', click: () => void shell.openExternal(link) })
      items.push({ label: 'Copy Link', click: () => clipboard.writeText(link) }, { type: 'separator' })
    }
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste })
    } else if (params.selectionText) {
      items.push({ role: 'copy' })
    }
    if (params.isEditable || params.selectionText) items.push({ role: 'selectAll' })
    while (items.at(-1)?.type === 'separator') items.pop()
    if (items.length > 0) Menu.buildFromTemplate(items).popup()
  })
}

const MARKUP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/** A Linux notification server may read the body as markup (mako and Quickshell's do, links and all),
 *  and a subject is a stranger's words. The title is always plain text. */
const asText = (text: string): string => (process.platform === 'linux' ? text.replace(/[&<>]/g, (c) => MARKUP[c] ?? c) : text)

/** One notification, naming who and what when it's a single message. Clicking opens the app. */
export function notify(count: number, preview: { from: string; subject: string } | undefined, open: () => void): void {
  if (!Notification.isSupported()) return
  const words = count === 1 ? '1 new message' : `${count} new messages`
  const note = new Notification({
    title: preview?.from || 'xrnmail',
    body: asText(preview ? preview.subject || 'No subject' : words),
    icon: iconPath()
  })
  note.on('click', open)
  note.show()
}

const AUTOSTART_FLAG = '--hidden'

export const startedHidden = (argv: string[]): boolean => argv.includes(AUTOSTART_FLAG)

/** Linux has no system call for this: it's a file in the autostart folder. Only an installed build
 *  writes one, because a development build at login isn't something anyone asked for. */
export function setStartAtLogin(on: boolean): void {
  if (!app.isPackaged) return
  const folder = join(app.getPath('appData'), 'autostart')
  const file = join(folder, 'xrnmail.desktop')
  if (!on) return rmSync(file, { force: true })
  const target = process.env['APPIMAGE'] ?? process.execPath
  mkdirSync(folder, { recursive: true })
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=xrnmail\nExec="${target}" ${AUTOSTART_FLAG}\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o644 })
}
