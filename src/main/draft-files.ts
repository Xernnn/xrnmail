import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DraftFile } from '@shared/types'

/** Gmail's limit is on the encoded message, and encoding adds about a third. */
export const MAX_DRAFT_BYTES = Math.floor((25 * 1024 * 1024 * 3) / 4)

/**
 * Attachments of drafts, copied in when chosen, so a message scheduled for later doesn't depend on
 * where the file was. The page names them only by id: it never hands over a path.
 */
export class DraftFiles {
  constructor(private root: string) {}

  private folder(draft: number): string {
    return join(this.root, String(draft))
  }

  path(draft: number, file: Pick<DraftFile, 'id'>): string {
    return join(this.folder(draft), file.id)
  }

  private place(draft: number): { id: string; to: string } {
    mkdirSync(this.folder(draft), { recursive: true, mode: 0o700 })
    const id = randomUUID()
    return { id, to: this.path(draft, { id }) }
  }

  /** How big a file is, before any of it is copied. */
  sizeOf(path: string): number {
    return statSync(path).size
  }

  fromDisk(draft: number, path: string, type = 'application/octet-stream'): DraftFile {
    const { id, to } = this.place(draft)
    copyFileSync(path, to)
    return { id, name: basename(path), size: statSync(to).size, type }
  }

  fromBytes(draft: number, name: string, type: string, bytes: Buffer): DraftFile {
    const { id, to } = this.place(draft)
    writeFileSync(to, bytes, { mode: 0o600 })
    return { id, name, size: bytes.length, type }
  }

  read(draft: number, file: Pick<DraftFile, 'id'>): Buffer {
    return readFileSync(this.path(draft, file))
  }

  remove(draft: number, file: Pick<DraftFile, 'id'>): void {
    rmSync(this.path(draft, file), { force: true })
  }

  clear(draft: number): void {
    rmSync(this.folder(draft), { recursive: true, force: true })
  }
}
