import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

/**
 * Made-up faces for the UI tests: the app is told where to find them (XRNMAIL_PICTURES), so it shows
 * photos and logos without anything reaching the network.
 */

/** A square PNG of one colour, with a lighter disc in the middle, so a photo is told from initials. */
export function png(size: number, [r, g, b]: [number, number, number]): Buffer {
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2.4) ** 2 < (size / 4.2) ** 2
      const body = (x - size / 2) ** 2 + (y - size * 1.05) ** 2 < (size / 2.3) ** 2
      const light = inside || body ? 70 : 0
      row[1 + x * 3] = Math.min(255, r + light)
      row[2 + x * 3] = Math.min(255, g + light)
      row[3 + x * 3] = Math.min(255, b + light)
    }
    rows.push(row)
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bits a channel
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** A logo as BIMI asks for it: SVG Tiny PS, a mark on a square. */
export const svgLogo = (colour: string, letter: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64">` +
  `<title>${letter}</title><rect width="64" height="64" fill="${colour}"/>` +
  `<circle cx="32" cy="32" r="18" fill="none" stroke="#ffffff" stroke-width="6"/></svg>`

/** Writes the pictures into [folder], and says where each is, as the app reads it: `photo:<address>`
 *  for a person, `logo:<domain>` for a company. */
export function pictures(folder: string, faces: Record<string, Buffer | string>): string {
  const map: Record<string, string> = {}
  Object.entries(faces).forEach(([key, bytes], i) => {
    const file = join(folder, `face-${i}.${typeof bytes === 'string' ? 'svg' : 'png'}`)
    writeFileSync(file, bytes)
    map[key] = file
  })
  return JSON.stringify(map)
}
