import { describe, expect, it } from 'vitest'
import { autostartEntry, execArg } from '@main/autostart'

describe('starting at login', () => {
  it('starts an AppImage from an extracted copy, as its launcher does, so losing the mount cannot crash it', () => {
    const entry = autostartEntry('/home/me/Applications/xrnmail.AppImage', true)
    expect(entry).toContain('Exec=env NO_CLEANUP=1 "/home/me/Applications/xrnmail.AppImage" --appimage-extract-and-run --hidden\n')
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
  })

  it('starts a program that is not an AppImage as it is', () => {
    expect(autostartEntry('/opt/xrnmail/xrnmail', false)).toContain('Exec="/opt/xrnmail/xrnmail" --hidden\n')
  })

  it('quotes a path the way a desktop entry needs, whatever is in it', () => {
    expect(execArg('/home/me/My "Apps"/$x`y\\z.AppImage')).toBe('"/home/me/My \\"Apps\\"/\\$x\\`y\\\\z.AppImage"')
    expect(autostartEntry('/home/me/my apps/xrnmail.AppImage', true)).toContain('"/home/me/my apps/xrnmail.AppImage" --appimage-extract-and-run')
  })
})
