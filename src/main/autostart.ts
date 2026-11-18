import { join } from 'node:path'

/**
 * The autostart entry that starts xrnmail at login, apart from Electron so it can be tested.
 *
 * An AppImage is started as the launcher `npm run app:install` writes starts it: with
 * --appimage-extract-and-run and NO_CLEANUP=1, so it runs from an extracted copy rather than the
 * AppImage's FUSE mount. The mount lasts only as long as the AppImage's runtime process; if that goes
 * while the app is still running, the app dies with SIGBUS the next time it reads its own code from
 * the mount (xrncal crashed that way on 2026-11-09). NO_CLEANUP keeps the extracted copy after the
 * runtime exits, so a second launch that only hands over to the running app doesn't delete its files.
 * TMPDIR puts that copy in xrnmail's folder in the cache, on disk: /tmp is memory here, and files in
 * it untouched for 10 days are cleaned away, from under an app that has been running that long.
 */

export const AUTOSTART_FLAG = '--hidden'

/** A desktop-entry Exec argument: quoted, with the characters the spec reserves escaped. */
export function execArg(value: string): string {
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`
}

/** Where the AppImage extracts itself to run, the same folder the launcher gives it. */
export function unpackFolder(env: Record<string, string | undefined>, home: string): string {
  return join(env['XDG_CACHE_HOME'] || join(home, '.cache'), 'xrnmail')
}

/** [target] is the AppImage when [appImage], else the program itself, as in a build run unpacked.
 *  An AppImage extracts itself into [unpackInto]. */
export function autostartEntry(target: string, appImage: boolean, unpackInto: string): string {
  const exec = appImage ? `env NO_CLEANUP=1 ${execArg(`TMPDIR=${unpackInto}`)} ${execArg(target)} --appimage-extract-and-run` : execArg(target)
  return ['[Desktop Entry]', 'Type=Application', 'Name=xrnmail', `Exec=${exec} ${AUTOSTART_FLAG}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n')
}
