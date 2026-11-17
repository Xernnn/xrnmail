import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeSnippet, parseMail } from '@main/parse'

/** A message as a phone's mail app sends a screenshot: HTML with the picture placed in it. */
function withPicture(html: string, picture: Buffer): Buffer {
  const lines = (picture.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
  return Buffer.from([
    'From: Ada <ada@example.com>',
    'To: me@example.com',
    'Subject: Screenshot',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--REL',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <shot@example.com>',
    'Content-Disposition: inline; filename="shot.png"',
    '',
    lines,
    '--REL--',
    ''
  ].join('\r\n'))
}

describe('a message with a picture placed in it', () => {
  it('keeps the words after a large picture, and the whole picture', async () => {
    const picture = randomBytes(1.7 * 1024 * 1024)
    const parsed = await parseMail(withPicture('<p>Look at this:</p><img src="cid:shot@example.com"><p>Text after the picture</p>', picture))
    // Asked as yes or no, so a failure doesn't print the picture.
    expect(parsed.html?.includes('Text after the picture')).toBe(true)
    expect(parsed.html?.includes(`src="data:image/png;base64,${picture.toString('base64')}"`)).toBe(true)
    expect(parsed.snippet).toContain('Text after the picture')
    expect(parsed.cut).toBe(false)
    expect(parsed.attachments).toEqual([])
  })

  it('cuts markup too long to keep where a tag starts, and says so', async () => {
    const paragraph = `<p>${'word '.repeat(200)}</p>`
    const parsed = await parseMail(withPicture(`<p>Start</p>${paragraph.repeat(Math.ceil((2.5 * 1024 * 1024) / paragraph.length))}`, randomBytes(1000)))
    expect(parsed.cut).toBe(true)
    expect(parsed.html?.length).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(parsed.html?.startsWith('<p>Start</p>')).toBe(true)
    expect(parsed.html?.endsWith('</p>')).toBe(true)
  })

  it('has its preview made again from the kept HTML past the picture', async () => {
    const parsed = await parseMail(withPicture('<img src="cid:shot@example.com"><p>Text after the picture</p>', randomBytes(2.5 * 1024 * 1024)))
    expect(parsed.html?.length).toBeGreaterThan(3 * 1024 * 1024)
    expect(makeSnippet('', parsed.html)).toBe('Text after the picture')
  })
})
