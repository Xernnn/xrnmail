import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { familyOfName, type FileFamily } from '@shared/openable'

/**
 * Opening an attachment hands a stranger's file to whatever this laptop runs for its type, and on
 * Linux that type comes from the file's bytes, not its name: xdg-open asks `xdg-mime query
 * filetype`, which looks inside. A Java archive called invoice.pdf is typed as a Java archive, and
 * its handler is `java -jar`. So a file opens only when its name, its own bytes, and the system's
 * reading of it all say the same harmless kind. Anything else can still be saved.
 */

/** What opening needs from the system, passed in so tests never open anything. */
export interface Opener {
  /** A private folder for files being looked at. */
  folder(): string
  /** What the system takes the file to be, as xdg-open will: null when it can't be asked. */
  filetype(path: string): Promise<string | null>
  /** Opens it with the system's handler. An empty answer means it opened. */
  openPath(path: string): Promise<string>
}

/** Said when a file isn't opened, so the page offers saving it. */
export const SAVE_TO_OPEN = 'Save it to open'

/** The system's types each kind may be, as xdg-mime and the file command name them. */
const TYPES: Record<FileFamily, string[]> = {
  pdf: ['application/pdf'],
  text: ['text/plain', 'text/csv', 'text/x-csv', 'application/csv', 'text/tab-separated-values', 'text/markdown', 'text/x-markdown', 'text/x-log'],
  rtf: ['text/rtf', 'application/rtf'],
  office: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
    'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'
  ],
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-bmp', 'image/x-ms-bmp', 'image/tiff', 'image/heic', 'image/heif', 'image/avif'],
  media: [
    'audio/mpeg', 'audio/x-wav', 'audio/wav', 'audio/vnd.wave', 'audio/ogg', 'audio/x-vorbis+ogg', 'audio/x-opus+ogg', 'audio/flac', 'audio/x-flac',
    'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/webm', 'audio/x-matroska',
    'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/ogg', 'video/x-msvideo', 'application/ogg'
  ],
  archive: [
    'application/zip', 'application/x-zip-compressed', 'application/x-tar', 'application/gzip', 'application/x-gzip', 'application/x-compressed-tar',
    'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar', 'application/x-rar-compressed'
  ],
  calendar: ['text/calendar'],
  contact: ['text/vcard', 'text/x-vcard', 'text/directory']
}

/** What bytes turned out to be. [sure] is false where the bytes alone can't rule out something that
 *  runs: an old Office file's container is also an installer's. */
export interface Content {
  family: FileFamily
  sure: boolean
}

const startsWith = (bytes: Buffer, text: string, at = 0): boolean => bytes.subarray(at, at + text.length).toString('latin1') === text

const HEX = (hex: string): Buffer => Buffer.from(hex.replace(/\s/g, ''), 'hex')
const CFB = HEX('d0cf11e0a1b11ae1')
const SEVEN_ZIP = HEX('377abcaf271c')
/** The extra field the jar tool writes, by which a ZIP is typed as a Java archive. */
const JAR_MAGIC = 0xcafe

/** Brands of the ISO media file that are pictures, not sound or film. */
const PICTURE_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis)$/

/** Programs and what runs one, by their first bytes, whatever their name. */
function runs(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4).toString('hex')
  return head === '7f454c46' || // ELF
    startsWith(bytes, 'MZ') || // Windows programs and installers
    startsWith(bytes, '#!') || // scripts
    ['cafebabe', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'].includes(head) || // Java classes, Mac programs
    startsWith(bytes, 'dex\n') || // Android
    startsWith(bytes, '%!') // PostScript, a programming language
}

interface ZipEntry {
  name: string
  extra: Buffer
}

/** The files a ZIP's central directory names, or null when it can't be read, which is no ZIP to
 *  open. The local header of the first file counts too: the file command reads that one. */
export function zipEntries(bytes: Buffer): ZipEntry[] | null {
  const from = Math.max(0, bytes.length - 22 - 0xffff)
  let end = -1
  for (let at = bytes.length - 22; at >= from; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) return null
  const count = bytes.readUInt16LE(end + 10)
  const size = bytes.readUInt32LE(end + 12)
  const offset = bytes.readUInt32LE(end + 16)
  if (offset + size > end || count > 65_000) return null
  const entries: ZipEntry[] = []
  if (bytes.length >= 30 && bytes.readUInt32LE(0) === 0x04034b50) {
    const nameLength = bytes.readUInt16LE(26)
    const extraLength = bytes.readUInt16LE(28)
    if (30 + nameLength + extraLength > bytes.length) return null
    entries.push({ name: bytes.subarray(30, 30 + nameLength).toString('latin1'), extra: bytes.subarray(30 + nameLength, 30 + nameLength + extraLength) })
  }
  let at = offset
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) return null
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > end) return null
    entries.push({ name: bytes.subarray(at + 46, at + 46 + nameLength).toString('latin1'), extra: bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength) })
    at = next
  }
  return entries
}

/** The ids in a ZIP entry's extra field. */
function extraIds(extra: Buffer): number[] {
  const ids: number[] = []
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) ids.push(extra.readUInt16LE(at))
  return ids
}

/** What a ZIP holds: an Office or OpenDocument file, a plain archive, or something that runs. */
function zipContent(bytes: Buffer): Content | null {
  const entries = zipEntries(bytes)
  if (!entries) return null
  const names = entries.map((entry) => entry.name.toLowerCase())
  // Names are stored as they are, so a manifest anywhere in the file is seen, even one a second
  // directory leaves out: java looks for the directory its own way.
  const java = entries.some((entry) => extraIds(entry.extra).includes(JAR_MAGIC)) || /META-INF\/MANIFEST\.MF/i.test(bytes.toString('latin1')) ||
    names.some((name) => name.endsWith('.class') || name.endsWith('.dex') || name.endsWith('.jar'))
  if (java) return null
  const ooxml = names.includes('[content_types].xml') && names.some((name) => /^(word|xl|ppt)\//.test(name))
  const odf = names[0] === 'mimetype' && bytes.subarray(30, 200).toString('latin1').includes('application/vnd.oasis.opendocument.')
  if (ooxml || odf) {
    // Macros: Office would ask before running them, but a stranger's file needn't get that far.
    if (names.some((name) => name.endsWith('vbaproject.bin') || name.startsWith('basic/') || name.startsWith('scripts/'))) return null
    return { family: 'office', sure: true }
  }
  return { family: 'archive', sure: true }
}

/** Plain text, by its bytes: no NULs or other control characters, and nothing a program reads as
 *  markup, a script or a launcher. */
function textContent(bytes: Buffer): Content | null {
  const sample = bytes.subarray(0, 64 * 1024)
  for (const byte of sample) if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b) || byte === 0x7f) return null
  const text = sample.toString('utf8').replace(/^﻿/, '').trimStart()
  if (text.startsWith('<') || text.startsWith('#!') || /^\s*\[Desktop Entry\]/im.test(text)) return null
  if (/^BEGIN:VCALENDAR\b/i.test(text)) return { family: 'calendar', sure: true }
  if (/^BEGIN:VCARD\b/i.test(text)) return { family: 'contact', sure: true }
  if (text.startsWith('{\\rtf')) return { family: 'rtf', sure: true }
  return { family: 'text', sure: true }
}

/** What a file is by its own bytes, the way the system's type finding reads them, or null when it's
 *  something that runs or nothing known. */
export function contentOf(bytes: Buffer): Content | null {
  if (bytes.length === 0 || runs(bytes)) return null
  const sure = (family: FileFamily): Content => ({ family, sure: true })
  if (startsWith(bytes, '%PDF-')) return sure('pdf')
  if (startsWith(bytes, '\x89PNG\r\n\x1a\n') || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a') || (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) ||
    startsWith(bytes, 'II*\0') || startsWith(bytes, 'MM\0*') || (startsWith(bytes, 'BM') && bytes.length > 14 && bytes.readUInt32LE(6) === 0)) return sure('image')
  if (startsWith(bytes, 'ftyp', 4)) return sure(PICTURE_BRANDS.test(bytes.subarray(8, 12).toString('latin1')) ? 'image' : 'media')
  if ((startsWith(bytes, 'RIFF') && (startsWith(bytes, 'WAVE', 8) || startsWith(bytes, 'AVI ', 8))) || startsWith(bytes, 'OggS') ||
    startsWith(bytes, 'fLaC') || startsWith(bytes, 'ID3') || bytes.subarray(0, 4).equals(HEX('1a45dfa3')) ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) || ['moov', 'mdat', 'wide', 'free'].some((atom) => startsWith(bytes, atom, 4))) return sure('media')
  if (startsWith(bytes, 'PK\x03\x04') || startsWith(bytes, 'PK\x05\x06')) return zipContent(bytes)
  if (bytes.subarray(0, 8).equals(CFB)) return { family: 'office', sure: false }
  if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || bytes.subarray(0, 6).equals(SEVEN_ZIP) || startsWith(bytes, 'Rar!\x1a\x07') ||
    startsWith(bytes, 'ustar', 257)) return sure('archive')
  return textContent(bytes)
}

/** Whether a file of this name and these bytes may be opened, before asking the system. */
export function mayOpen(name: string, bytes: Buffer): Content | null {
  const named = familyOfName(name)
  const content = contentOf(bytes)
  return named && content?.family === named ? content : null
}

/** Whether the system's word for a file is one its kind may be. No word at all (xdg-mime isn't
 *  there) leaves it to the bytes, where they're sure. */
export function systemAgrees(content: Content, type: string | null): boolean {
  if (type === null) return content.sure
  return TYPES[content.family].includes(type)
}

/** Opens an attachment if it's safe to, or says to save it. The file is written to the private
 *  folder only to be opened, and taken away again if it won't be. */
export async function openAttachment(name: string, bytes: Buffer, opener: Opener): Promise<void> {
  const content = mayOpen(name, bytes)
  if (!content) throw new Error(SAVE_TO_OPEN)
  const path = join(opener.folder(), `${randomUUID().slice(0, 8)}-${name}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  if (!systemAgrees(content, await opener.filetype(path))) {
    rmSync(path, { force: true })
    throw new Error(SAVE_TO_OPEN)
  }
  const failure = await opener.openPath(path)
  if (failure) throw new Error('Nothing on this laptop opens that kind of file.')
}

/** What xdg-mime says a file is, as xdg-open will see it: run without a shell, the path as one
 *  argument. Null when there's no xdg-mime to ask; anything it couldn't say is "unknown". */
export function xdgFiletype(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('xdg-mime', ['query', 'filetype', path], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(null)
      if (error) return resolve('unknown')
      resolve(String(stdout).split(';')[0]?.trim().toLowerCase() || 'unknown')
    })
  })
}
