import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentOf, openAttachment, SAVE_TO_OPEN, xdgFiletype, type Opener } from '@main/opening'
import { canOpenDirectly } from '@shared/openable'
import { docx, jar, pdf, png, zip } from './files'

/** The system as the tests have it: a folder, a type finder that answers [type], and an opener that
 *  only notes what it was given. Nothing here runs xdg-open or opens a file. */
function fakeSystem(folder: string, type: (path: string) => string | null): Opener & { opened: string[]; asked: string[] } {
  const opened: string[] = []
  const asked: string[] = []
  return {
    opened,
    asked,
    folder: () => folder,
    filetype: async (path) => {
      asked.push(path)
      return type(path)
    },
    openPath: async (path) => {
      opened.push(path)
      return ''
    }
  }
}

/** What xdg-mime says on Linux about each, by its bytes: a Java archive is one whatever its name. */
const XDG: Record<string, string> = {
  jar: 'application/java-archive',
  pdf: 'application/pdf',
  png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

let folder = ''
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'xrnmail-opening-')) })
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe('opening an attachment', () => {
  // A stranger's Java program called invoice.pdf was opened, since only the name was looked at, and
  // xdg-open types a file by its bytes: it ran `java -jar` on it.
  it('never opens a Java program, whatever it is called', async () => {
    for (const name of ['invoice.pdf', 'report.docx', 'photo.png', 'files.zip']) {
      const system = fakeSystem(folder, () => XDG['jar'] ?? null)
      expect(canOpenDirectly(name), name).toBe(true) // the name alone would have let it through
      await expect(openAttachment(name, jar(), system), name).rejects.toThrow(SAVE_TO_OPEN)
      expect(system.opened, name).toEqual([])
    }
    expect(readdirSync(folder)).toEqual([]) // nothing is left behind
  })

  it('opens a real PDF, picture and Word document', async () => {
    for (const [name, bytes, type] of [['report.pdf', pdf(), XDG['pdf']], ['photo.png', png(), XDG['png']], ['minutes.docx', docx(), XDG['docx']]] as const) {
      const system = fakeSystem(folder, () => type ?? null)
      await openAttachment(name, bytes, system)
      expect(system.opened, name).toHaveLength(1)
      const path = system.opened[0] ?? ''
      expect(path.endsWith(`-${name}`), name).toBe(true)
      expect(readFileSync(path).equals(bytes), name).toBe(true)
      expect(system.asked, name).toEqual([path])
    }
  })

  it('opens nothing the system would read as some other kind', async () => {
    const system = fakeSystem(folder, () => 'application/java-archive')
    await expect(openAttachment('report.pdf', pdf(), system)).rejects.toThrow(SAVE_TO_OPEN)
    const unknown = fakeSystem(folder, () => 'unknown')
    await expect(openAttachment('report.pdf', pdf(), unknown)).rejects.toThrow(SAVE_TO_OPEN)
    expect([...system.opened, ...unknown.opened]).toEqual([])
    expect(readdirSync(folder)).toEqual([])
  })

  it('opens nothing whose bytes are another kind than its name', async () => {
    const system = fakeSystem(folder, () => 'image/png')
    await expect(openAttachment('report.pdf', png(), system)).rejects.toThrow(SAVE_TO_OPEN)
    await expect(openAttachment('notes.txt', Buffer.from('#!/bin/sh\nrm -rf ~\n'), system)).rejects.toThrow(SAVE_TO_OPEN)
    expect(system.opened).toEqual([])
    expect(system.asked).toEqual([]) // refused before it's even written
  })

  it('goes by the bytes alone where xdg-mime is missing, and only where they are sure', async () => {
    const system = fakeSystem(folder, () => null)
    await openAttachment('report.pdf', pdf(), system)
    expect(system.opened).toHaveLength(1)
    // An old Office file's container is also a Windows installer's.
    const cfb = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(504)])
    await expect(openAttachment('old.doc', cfb, system)).rejects.toThrow(SAVE_TO_OPEN)
    expect(system.opened).toHaveLength(1)
  })
})

describe('what a file is by its bytes', () => {
  it('knows the kinds that may be opened', () => {
    expect(contentOf(pdf())?.family).toBe('pdf')
    expect(contentOf(png())?.family).toBe('image')
    expect(contentOf(docx())?.family).toBe('office')
    expect(contentOf(zip([{ name: 'a.txt', data: 'hello' }]))?.family).toBe('archive')
    expect(contentOf(Buffer.from('name,amount\nMai,12\n'))?.family).toBe('text')
    expect(contentOf(Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'))?.family).toBe('calendar')
    expect(contentOf(Buffer.from('BEGIN:VCARD\r\nEND:VCARD\r\n'))?.family).toBe('contact')
    expect(contentOf(Buffer.from('{\\rtf1 hello}'))?.family).toBe('rtf')
  })

  it('refuses whatever runs, renders as a page, or is not known', () => {
    const refused: Record<string, Buffer> = {
      jar: jar(),
      'jar by its extra field alone': zip([{ name: 'a/', data: '', extra: Buffer.from([0xfe, 0xca, 0, 0]) }, { name: 'a/b.txt', data: 'x' }]),
      'jar by its manifest alone': zip([{ name: 'META-INF/MANIFEST.MF', data: 'Main-Class: X\r\n' }]),
      'a manifest a different directory hides': Buffer.concat([zip([{ name: 'META-INF/MANIFEST.MF', data: 'Main-Class: X\r\n' }]), zip([{ name: 'a.txt', data: 'x' }])]),
      'a document with macros': docx([{ name: 'word/vbaProject.bin', data: 'macros' }]),
      elf: Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(60)]),
      exe: Buffer.from('MZ\x90\x00\x03\x00\x00\x00'),
      script: Buffer.from('#!/usr/bin/env python3\nprint(1)\n'),
      desktop: Buffer.from('# made by\n[Desktop Entry]\nExec=rm -rf ~\n'),
      html: Buffer.from('<!doctype html><script>alert(1)</script>'),
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      xml: Buffer.from('<?xml version="1.0"?><x/>'),
      postscript: Buffer.from('%!PS-Adobe-3.0\n'),
      binary: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      empty: Buffer.alloc(0)
    }
    for (const [what, bytes] of Object.entries(refused)) expect(contentOf(bytes), what).toBeNull()
  })
})

describe('asking xdg-mime', () => {
  const path = process.env['PATH']
  afterEach(() => { process.env['PATH'] = path })

  it('reads its answer, and takes no xdg-mime as no answer', async () => {
    const bin = join(folder, 'bin')
    mkdirSync(bin)
    const file = join(folder, 'a file; named $(oddly).pdf')
    writeFileSync(file, pdf())
    process.env['PATH'] = bin
    expect(await xdgFiletype(file)).toBeNull()
    // A stand-in that notes what it was asked, so the path is seen to arrive as one argument.
    const seen = join(folder, 'seen')
    writeFileSync(join(bin, 'xdg-mime'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\necho 'application/pdf; charset=binary'\n`)
    chmodSync(join(bin, 'xdg-mime'), 0o755)
    expect(await xdgFiletype(file)).toBe('application/pdf')
    expect(readFileSync(seen, 'utf8')).toBe(`query\nfiletype\n${file}\n`)
  })
})
