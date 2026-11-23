import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMailto } from '@main/compose'
import { filesIn } from '@main/letters'

/** The launcher scripts/install-linux-app.sh writes, as it would write it for a made-up home. */
function entry(): string {
  const script = readFileSync(new URL('../scripts/install-linux-app.sh', import.meta.url), 'utf8')
  const body = /<<DESKTOP\n([\s\S]*?)\nDESKTOP\n/.exec(script)?.[1] ?? ''
  const values: Record<string, string> = {
    UNPACK_DIR: '/home/alex/.cache/xrnmail', TARGET: '/home/alex/Applications/xrnmail.AppImage', ICON_DIR: '/home/alex/.local/share/icons', APP_ID: 'xrnmail'
  }
  return body.replace(/\$\{(\w+)\}/g, (_whole, name: string) => values[name] ?? '')
}

const group = (text: string, name: string): Record<string, string> => {
  const at = text.indexOf(`[${name}]`)
  const lines = text.slice(at).split('\n').slice(1)
  const end = lines.findIndex((line) => line.startsWith('['))
  return Object.fromEntries((end < 0 ? lines : lines.slice(0, end)).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}

describe('the launcher the install writes', () => {
  it('is found as a mail app, takes mail links and mail files, and has New Message', () => {
    const main = group(entry(), 'Desktop Entry')
    expect(main).toMatchObject({
      GenericName: 'Mail', Keywords: 'mail;email;inbox;', MimeType: 'x-scheme-handler/mailto;message/rfc822;', 'X-GNOME-UsesNotifications': 'true',
      Actions: 'NewMessage;', Categories: 'Network;Email;', StartupWMClass: 'xrnmail'
    })
    // Run from an unpacked copy in the cache, never the FUSE mount (see the script).
    expect(main['Exec']).toBe('env NO_CLEANUP=1 "TMPDIR=/home/alex/.cache/xrnmail" "/home/alex/Applications/xrnmail.AppImage" --appimage-extract-and-run %U')
    const action = group(entry(), 'Desktop Action NewMessage')
    expect(action).toEqual({ Name: 'New Message', Exec: main['Exec']?.replace('%U', 'mailto:') })
  })

  it('opens New Message as an empty mail link, which is an empty draft, and no file', () => {
    expect(parseMailto('mailto:')).toEqual({ kind: 'new', to: '', cc: '', bcc: '', subject: '', text: '' })
    expect(filesIn(['mailto:'], '/home/alex')).toEqual([])
  })

  it('passes desktop-file-validate, where it is installed', () => {
    const validate = '/usr/bin/desktop-file-validate'
    if (!existsSync(validate)) return
    const folder = mkdtempSync(join(tmpdir(), 'xrnmail-entry-'))
    try {
      const file = join(folder, 'xrnmail.desktop')
      writeFileSync(file, `${entry()}\n`)
      expect(execFileSync(validate, [file], { encoding: 'utf8' }).trim()).toBe('')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
