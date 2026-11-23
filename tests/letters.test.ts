import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { filesIn, letterDetail, letterDetails, Letters, letterView, MOST_FILE } from '@main/letters'
import { parseMail } from '@main/parse'
import { soloFrom, soloKey, soloQuery } from '@shared/solo'

const ME = 'me@example.com'
let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-letters-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const eml = (lines: string[]): string => lines.join('\r\n')

describe('the files a launch names', () => {
  it('are .eml paths, from where it was started, and file: URLs, which a launcher gives', () => {
    const url = pathToFileURL('/home/alex/Mail/Old receipts/order 7.eml').href
    expect(url).toContain('%20')
    expect(filesIn(['receipt.eml', '/tmp/Invoice.EML', url, 'file://localhost/srv/a.eml'], '/home/alex/Downloads'))
      .toEqual(['/home/alex/Downloads/receipt.eml', '/tmp/Invoice.EML', '/home/alex/Mail/Old receipts/order 7.eml', '/srv/a.eml'])
  })

  it('leave out the app\'s own arguments, switches, mail links, web addresses and other files', () => {
    expect(filesIn(['.', '--appimage-extract-and-run', '--start-hidden', '-x.eml', 'mailto:ada@example.com?subject=a.eml',
      'https://mail.example/a.eml', 'notes.txt', 'file://files.example/share/a.eml'], '/home/alex')).toEqual([])
  })
})

describe('a message opened from a file', () => {
  const read = async (lines: string[]): Promise<ReturnType<Letters['get']>> => {
    const path = join(folder, 'message.eml')
    writeFileSync(path, eml(lines))
    const letters = new Letters(parseMail)
    return letters.get((await letters.read(path)).token)
  }

  // Anyone can write an Authentication-Results line into a file: it's no server's word.
  it('is unverified whatever its lines claim, and never "from you"', async () => {
    const letter = await read([
      'Authentication-Results: mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com',
      `From: Me <${ME}>`, `To: ${ME}`, 'Subject: Your account', 'Date: Mon, 2 Nov 2026 09:00:00 +0000', 'Message-ID: <a1@example.com>', '', 'Sign in again here.'
    ])
    const view = letterView(letter!, ME)
    expect(view.warnings).toEqual(['unverified'])
    expect(view.authenticated).toBe(false)
    expect(view.id).toBeLessThan(0)
    expect(letterDetails(letter!)).toMatchObject({ checks: null, mailedBy: '', signedBy: [], tls: '', deliveredTo: '', recorded: true, wroteTo: false })
  })

  it('keeps the warnings its sender\'s own lines earn, and replies going elsewhere, which no line can excuse', async () => {
    const letter = await read([
      'Authentication-Results: mx.example.net; dmarc=pass header.from=bank.example',
      'From: "security@bank.example" <alerts@bank-login.example>', 'Reply-To: help@elsewhere.example', 'List-Id: <news.bank.example>',
      'To: alex@example.com', 'Subject: Check this', '', 'Hi'
    ])
    expect(letterView(letter!, '').warnings).toEqual(['unverified', 'name-mismatch', 'replies-elsewhere'])
  })

  it('is read as mail is, with its date, its files listed, and what a reply needs to thread with it', async () => {
    const letter = await read([
      'From: Mai Tran <mai@example.com>', `To: ${ME}`, 'Subject: Floor plan', 'Date: Tue, 3 Nov 2026 10:30:00 +0000', 'Message-ID: <plan@example.com>',
      'References: <start@example.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/html; charset=utf-8', '', '<p>See <b>attached</b>.</p><img src="https://track.example/o.gif" width="1" height="1">',
      '--b', 'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: attachment; filename="plan.pdf"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('%PDF-1.4 plan').toString('base64'), '--b--', ''
    ])
    const view = letterView(letter!, ME)
    expect(view).toMatchObject({ subject: 'Floor plan', date: Date.UTC(2026, 10, 3, 10, 30), account: ME, labels: [], unsubscribe: false, facts: null })
    expect(view.attachments).toEqual([{ name: 'plan.pdf', type: 'application/pdf', size: 13 }])
    expect(view.html).toContain('<b>attached</b>') // as it came: the page cleans it, as it does mail
    expect(letterDetail(letter!, ME)).toMatchObject({ messageId: '<plan@example.com>', references: '<start@example.com>' })
  })

  it('is only ever a plain file no bigger than a message can be', async () => {
    const letters = new Letters(parseMail)
    mkdirSync(join(folder, 'folder.eml'))
    await expect(letters.read(join(folder, 'folder.eml'))).rejects.toThrow("That isn't a mail file.")
    const big = join(folder, 'big.eml')
    writeFileSync(big, '')
    truncateSync(big, MOST_FILE + 1)
    await expect(letters.read(big)).rejects.toThrow('That file is too big to open here.')
    await expect(letters.read(join(folder, 'gone.eml'))).rejects.toThrow()
  })

  it('is found by its token or its number below zero, until its window lets it go', async () => {
    const path = join(folder, 'a.eml')
    writeFileSync(path, eml(['From: mai@example.com', 'Subject: One', '', 'Hi']))
    const letters = new Letters(parseMail)
    const one = await letters.read(path)
    const two = await letters.read(path)
    expect([one.id, two.id]).toEqual([-1, -2])
    expect(letters.byId(-2)).toBe(two)
    expect(letters.byId(1)).toBeUndefined()
    letters.forget(one.token)
    expect(letters.get(one.token)).toBeUndefined()
    const failed = letters.failure("That isn't a mail file.")
    expect(letters.problem(failed)).toBe("That isn't a mail file.")
  })

  it('has a window of its own, named by its token', () => {
    const file = '0b8f83d4-1c2e-4a5b-9c7d-3e2f1a0b9c8d'
    expect(soloFrom(`?${new URLSearchParams(soloQuery({ kind: 'file', file }))}`)).toEqual({ kind: 'file', file })
    expect(soloFrom('?solo=file&file=../../etc/passwd')).toBeNull()
    expect(soloKey({ kind: 'file', file })).not.toBe(soloKey({ kind: 'draft', id: 1 }))
  })
})
