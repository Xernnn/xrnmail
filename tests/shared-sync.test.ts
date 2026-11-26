import { describe, expect, it } from 'vitest'
import { sha256, type SharedCopy, type SharedPut, type SharedServer } from '@main/shared-server'
import type { JsonObject } from '@main/shared-state'
import { SharedSync, type SharedMeta, type SharedMetaStore, type SharedPlace } from '@main/shared-sync'

/** The sync's own steps, against a server kept in memory that can lose an answer or be put back
 *  from a backup, which the real one can't be made to do on cue. */

class MemoryServer implements SharedServer {
  version = 0
  tag = ''
  doc: JsonObject = {}
  body = ''
  follows = true
  writes = 0
  /** The next write lands, and its answer never comes back. */
  loseNextAnswer = false

  async current(): Promise<SharedCopy> {
    return { version: this.version, tag: this.tag, doc: this.doc, follows: this.follows }
  }

  async newerThan(version: number, tag: string): Promise<SharedCopy | null> {
    return version === this.version && tag === this.tag ? null : this.current()
  }

  async put(body: string, version: number, tag: string): Promise<SharedPut> {
    if (version !== this.version || (version !== 0 && tag !== this.tag)) return { kind: 'stale', version: this.version, tag: this.tag, hash: sha256(this.body) }
    this.writes++
    this.version++
    this.tag = `t${this.version}`
    this.doc = JSON.parse(body) as JsonObject
    this.body = body
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false
      throw new Error('the answer was lost')
    }
    return { kind: 'accepted', version: this.version, tag: this.tag }
  }

  abort(): void {}
}

class MemoryMeta implements SharedMetaStore {
  meta: SharedMeta | null = null
  load = (): SharedMeta | null => this.meta
  save = (meta: SharedMeta | null): void => void (this.meta = meta)
}

/** A device whose whole document is [doc]. */
class Place implements SharedPlace {
  constructor(public doc: JsonObject) {}
  document = (): JsonObject => this.doc
  chosen = (doc: JsonObject): JsonObject => doc
  take = (_was: JsonObject, merged: JsonObject): void => void (this.doc = merged)
}

describe('keeping the shared copy in step', () => {
  it('takes a write whose answer was lost as made, and makes it no second time', async () => {
    const server = new MemoryServer()
    const meta = new MemoryMeta()
    const place = new Place({ schema: 1, settings: { faces: false }, threads: {} })
    const sync = new SharedSync(server, place, meta)
    await sync.sync()
    place.doc = { schema: 1, settings: { faces: true }, threads: {} }
    server.loseNextAnswer = true
    await expect(sync.sync()).rejects.toThrow('lost')
    expect(await sync.sync()).toBe('up to date')
    expect(server.writes).toBe(2) // the lost one, not a third on top of it
    expect(meta.meta?.version).toBe(server.version)
  })

  it("merges a copy put back from a backup with no base, so nothing either side holds is lost", async () => {
    const server = new MemoryServer()
    const meta = new MemoryMeta()
    const place = new Place({ schema: 1, settings: { blocked: ['a@x.example'] }, threads: {} })
    const sync = new SharedSync(server, place, meta)
    await sync.sync()
    // Restored from an older backup, then written to by the phone: the version number goes on, the line doesn't.
    server.doc = { schema: 1, settings: { blocked: ['b@x.example'] }, threads: {} }
    server.version = 5
    server.tag = 'restored'
    server.follows = false
    await sync.sync()
    expect(server.doc['settings']).toEqual({ blocked: ['a@x.example', 'b@x.example'] })
  })
})
