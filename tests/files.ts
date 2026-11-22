import { crc32, deflateSync } from 'node:zlib'

/** Small real files of each kind, made here so no test needs a fixture from anywhere else. */

interface ZipFile {
  name: string
  data: string | Buffer
  /** The local and central extra field, as the jar tool writes 0xCAFE into its first. */
  extra?: Buffer
}

/** A ZIP with its files stored as they are. */
export function zip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = Buffer.from(file.data)
    const extra = file.extra ?? Buffer.alloc(0)
    const sum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(10, 6)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, extra, data)
    centrals.push(central, name, extra)
    offset += 30 + name.length + extra.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A Java program, as the jar tool lays one out: `java -jar` runs it, whatever it's called. */
export const jar = (): Buffer => zip([
  { name: 'META-INF/', data: '', extra: Buffer.from([0xfe, 0xca, 0x00, 0x00]) },
  { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nMain-Class: Hello\r\n\r\n' },
  { name: 'Hello.class', data: Buffer.from('cafebabe0000003d', 'hex') }
])

export const pdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, sum])
}

/** One white pixel. */
export function png(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** A Word document with one line in it. */
export const docx = (extra: ZipFile[] = []): Buffer => zip([
  {
    name: '[Content_Types].xml',
    data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  },
  {
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  },
  { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD}"><w:body><w:p><w:r><w:t>Minutes</w:t></w:r></w:p></w:body></w:document>` },
  ...extra
])
