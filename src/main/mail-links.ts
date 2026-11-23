import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether mail links (mailto:) open here, and making them, as Settings, General offers. Linux keeps
 * that in mimeapps.list, which `xdg-mime` reads and writes for whatever desktop is running; it's run
 * without a shell, with fixed words. Only the launcher the install writes can be made the one, so
 * nothing is offered where there's no such launcher, as in a build run from the source.
 */

export const LAUNCHER = 'xrnmail.desktop'
const MAILTO = 'x-scheme-handler/mailto'

/** Runs a program without a shell, to its end: what it wrote. */
export type Run = (file: string, args: string[]) => Promise<string>

/** Mail links open here; they open elsewhere and could be made to; or there's no launcher to make it. */
export type MailLinks = 'default' | 'other' | 'none'

/** Where launchers are looked for: the user's own, then the system's (XDG Base Directory). */
export function launcherFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const own = env['XDG_DATA_HOME'] || join(home, '.local/share')
  const system = (env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [own, ...system].map((folder) => join(folder, 'applications'))
}

export const installed = (folders: string[], exists: (path: string) => boolean = existsSync): boolean =>
  folders.some((folder) => exists(join(folder, LAUNCHER)))

export async function mailLinks(run: Run, launcher: boolean): Promise<MailLinks> {
  if (!launcher) return 'none'
  try {
    return (await run('xdg-mime', ['query', 'default', MAILTO])).trim() === LAUNCHER ? 'default' : 'other'
  } catch {
    return 'none' // no xdg-mime: nothing to set it with
  }
}

/** Makes mail links open here, and says what xdg-mime says after. */
export async function useForMailLinks(run: Run, launcher: boolean): Promise<MailLinks> {
  if (!launcher) return 'none'
  await run('xdg-mime', ['default', LAUNCHER, MAILTO])
  return mailLinks(run, launcher)
}
