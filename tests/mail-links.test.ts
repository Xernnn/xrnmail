import { describe, expect, it } from 'vitest'
import { installed, launcherFolders, LAUNCHER, mailLinks, useForMailLinks, type Run } from '@main/mail-links'

/** xdg-mime as the system would answer, never run: what's asked is noted, and setting the default
 *  changes only this. The real one would change the person's mimeapps.list. */
function fakeMime(start: string, fails = false): { run: Run; asked: string[][] } {
  let handler = start
  const asked: string[][] = []
  const run: Run = async (file, args) => {
    asked.push([file, ...args])
    if (fails) throw new Error('spawn xdg-mime ENOENT')
    if (args[0] === 'default') handler = args[1] ?? ''
    return args[0] === 'query' ? `${handler}\n` : ''
  }
  return { run, asked }
}

describe('mail links', () => {
  it('say Default when xdg-mime names this launcher', async () => {
    expect(await mailLinks(fakeMime('xrnmail.desktop').run, true)).toBe('default')
    expect(await mailLinks(fakeMime('thunderbird.desktop').run, true)).toBe('other')
    expect(await mailLinks(fakeMime('').run, true)).toBe('other')
  })

  it('are made to open here by xdg-mime default, with fixed words and no shell', async () => {
    const { run, asked } = fakeMime('thunderbird.desktop')
    expect(await useForMailLinks(run, true)).toBe('default')
    expect(asked).toEqual([['xdg-mime', 'default', 'xrnmail.desktop', 'x-scheme-handler/mailto'], ['xdg-mime', 'query', 'default', 'x-scheme-handler/mailto']])
  })

  // A build run from the source has no launcher, and making mail links open one that isn't there
  // would leave them opening nothing.
  it('offer nothing without the launcher the install writes, or without xdg-mime', async () => {
    const { run, asked } = fakeMime('thunderbird.desktop')
    expect(await mailLinks(run, false)).toBe('none')
    expect(await useForMailLinks(run, false)).toBe('none')
    expect(asked).toEqual([])
    expect(await mailLinks(fakeMime('', true).run, true)).toBe('none')
  })

  it('look for the launcher where the desktop does', () => {
    expect(launcherFolders({}, '/home/alex')).toEqual(['/home/alex/.local/share/applications', '/usr/local/share/applications', '/usr/share/applications'])
    expect(launcherFolders({ XDG_DATA_HOME: '/data/alex', XDG_DATA_DIRS: '/opt/share:' }, '/home/alex')).toEqual(['/data/alex/applications', '/opt/share/applications'])
    const there = new Set([`/home/alex/.local/share/applications/${LAUNCHER}`])
    expect(installed(launcherFolders({}, '/home/alex'), (path) => there.has(path))).toBe(true)
    expect(installed(launcherFolders({}, '/home/sam'), (path) => there.has(path))).toBe(false)
  })
})
