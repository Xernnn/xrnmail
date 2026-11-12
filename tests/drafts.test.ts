import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { draftCopy, outgoing } from '@main/compose'
import { parseDraft } from '@main/parse'
import { changes, draftRaw, importedDraft, isBlank } from '@main/remote-drafts'
import { MIGRATIONS, Store } from '@main/store'
import type { Draft } from '@shared/types'

const ME = 'me@example.com'

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 1, account: ME, from: '', to: '', cc: '', bcc: '', subject: '', html: '', text: '', quote: null, inReplyTo: '', references: '',
  files: [], state: 'draft', sendAt: null, error: null, updated: 0, ...over
})

const identity = { name: 'Me', signature: 'Regards,\nMe', aliases: ['work@me.example'], color: '', notify: true }

describe('a draft\'s copy on the server', () => {
  it('is the whole message as it would go, with nobody on it yet if that is how it is', async () => {
    const half = draft({ to: 'Ada <ada@example.com>, bo', subject: 'Plans', text: 'Hello', html: 'Hello', bcc: 'zed@example.com' })
    expect(() => outgoing(draft({ subject: 'x' }), ME, identity, () => '', 0)).toThrow('Add someone')
    const mail = draftCopy(half, ME, identity, () => '', 0)
    expect(mail.to).toEqual([{ name: 'Ada', address: 'ada@example.com' }]) // "bo" isn't an address yet
    expect(draftCopy(draft({ subject: 'Nobody yet' }), ME, identity, () => '', 0).to).toEqual([])
    const raw = (await draftRaw(mail, '<draft-1@example.com>')).toString()
    expect(raw).toContain('Message-ID: <draft-1@example.com>')
    expect(raw).toContain('Bcc: zed@example.com') // kept on your own copy, as on what's sent
    expect(raw).toContain('Regards,')
  })

  it('comes back as the words that were typed, without the signature this laptop adds, and what it quotes kept apart', async () => {
    const reply = draft({
      to: 'ada@example.com', subject: 'Re: Friday', text: 'Count me in.', html: 'Count me in.', inReplyTo: '<friday@example.com>',
      quote: { kind: 'reply', intro: 'On Mon, Ada wrote:', html: null, text: 'Coming on Friday?' }
    })
    const raw = await draftRaw(draftCopy(reply, ME, identity, () => '', 0), '<draft-2@example.com>')
    const back = importedDraft(await parseDraft(raw), ME, [ME, 'work@me.example'], identity.signature)
    expect(back).toMatchObject({ text: 'Count me in.', html: 'Count me in.', to: 'ada@example.com', subject: 'Re: Friday', inReplyTo: '<friday@example.com>' })
    expect(back.quote).toMatchObject({ kind: 'reply', asIs: true, text: 'On Mon, Ada wrote:\n> Coming on Friday?' })
    // Sent from here, the quote goes as it was, quoted once.
    const again = outgoing(draft({ ...back, to: back.to, quote: back.quote }), ME, identity, () => '', 0)
    expect(again.text).toBe('Count me in.\n\n-- \nRegards,\nMe\n\nOn Mon, Ada wrote:\n> Coming on Friday?')
  })

  it('keeps the words as text, so none of the HTML it came with reaches the composer', async () => {
    const raw = Buffer.from([
      `From: ${ME}`, 'To: ada@example.com', 'Subject: Pretty', 'Message-ID: <p@example.com>', 'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8', '', '<p>Hi <b>there</b> &lt;img src=x onerror=alert(1)&gt;</p><img src="https://track.example/p.gif">'
    ].join('\r\n'))
    const back = importedDraft(await parseDraft(raw), ME, [ME], '')
    expect(back.html).not.toMatch(/<(p|b|img)\b/)
    expect(back.text).toContain('Hi there')
    expect(back.html).toContain('&lt;img')
  })

  it('goes out from an alias it was written from, and from the account otherwise', async () => {
    const parsed = await parseDraft(Buffer.from(`From: work@me.example\r\nSubject: x\r\n\r\nHi`))
    expect(importedDraft(parsed, ME, [ME, 'work@me.example'], '').from).toBe('work@me.example')
    expect(importedDraft({ ...parsed, from: { name: '', address: ME } }, ME, [ME], '').from).toBe('')
    expect(importedDraft({ ...parsed, from: { name: '', address: 'ceo@bank.example' } }, ME, [ME], '').from).toBe('')
  })

  it('is only made of a draft with something in it, and again only once it has changed', () => {
    expect(isBlank(draft())).toBe(true)
    expect(isBlank(draft({ quote: { kind: 'reply', intro: '', html: null, text: 'x' } }))).toBe(false)
    expect(isBlank(draft({ files: [{ id: 'f', name: 'a', size: 1, type: 'text/plain' }] }))).toBe(false)
    const one = draft({ to: 'ada@example.com', text: 'Hi', html: 'Hi' })
    const edit = { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: '', html: 'Hi', text: 'Hi', quote: null }
    expect(changes(one, edit)).toBe(false)
    expect(changes(one, { ...edit, text: 'Hi!' })).toBe(true)
  })
})

describe('drafts kept before they went to the server', () => {
  it('are kept, go up as they are, and no draft\'s id is ever given out again', () => {
    const folder = mkdtempSync(join(tmpdir(), 'xrnmail-drafts-'))
    const path = join(folder, 'mail.sqlite')
    try {
      const old = new DatabaseSync(path)
      MIGRATIONS.slice(0, -1).forEach((sql) => old.exec(sql))
      old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`)
      old.prepare('INSERT INTO drafts(id, account, data, updated) VALUES(?,?,?,?)').run(7, ME, JSON.stringify({ subject: 'Old one', to: '', cc: '', bcc: '', html: '', text: 'x', quote: null, inReplyTo: '', references: '', files: [] }), 100)
      old.close()
      const store = new Store(path)
      expect(store.drafts().map((d) => [d.id, d.subject])).toEqual([[7, 'Old one']])
      expect(store.draftLink(7)).toMatchObject({ copy: null, pushed: 0, updated: 100 }) // so it goes up
      store.deleteDraft(7)
      const next = store.addDraft({ ...draft(), account: ME, updated: 200 })
      expect(next).toBeGreaterThan(7)
      store.close()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
