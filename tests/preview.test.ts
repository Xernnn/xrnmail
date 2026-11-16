import { describe, expect, it } from 'vitest'
import { makeSnippet } from '@main/parse'
import { quoteStart, splitQuoted } from '@shared/quoted'
import { chipLabel, readRecipient, splitRecipients } from '@shared/recipients'

const FAST_MS = 200

const quick = (work: () => unknown): void => {
  const started = performance.now()
  work()
  expect(performance.now() - started).toBeLessThan(FAST_MS)
}

describe('finding what a reply quotes', () => {
  it('stops at the line that introduces the quote', () => {
    const { fresh, quoted } = splitQuoted('Works for me.\n\nOn Tue, 3 Nov 2026 at 10:00, Mai <mai@example.com> wrote:\n> Thursday?')
    expect(fresh).toBe('Works for me.')
    expect(quoted).toContain('> Thursday?')
  })

  it('knows the line when it wraps, and in other languages', () => {
    expect(splitQuoted('Yes.\n\nOn Tue, 3 Nov 2026, Mai Tran\n<mai@example.com> wrote:\n> Hi').fresh).toBe('Yes.')
    expect(splitQuoted('Được.\n\nVào 10:00 Thứ Ba, Mai đã viết:\n> Hi').fresh).toBe('Được.')
  })

  it('stops at the blocks Outlook writes', () => {
    expect(splitQuoted('Sure.\n\nFrom: Mai\nSent: Tuesday\nTo: Me\nSubject: Hi\n\nOlder').fresh).toBe('Sure.')
    expect(splitQuoted('Sure.\n\n-----Original Message-----\nOlder').fresh).toBe('Sure.')
  })

  it('leaves answers written between the quoted lines alone', () => {
    const text = '> First question\nFirst answer\n> Second question\nSecond answer'
    expect(splitQuoted(text)).toEqual({ fresh: text, quoted: '' })
  })

  it('finds nothing in a message that quotes nothing', () => {
    expect(quoteStart(['Hello', 'there'])).toBe(2)
    expect(splitQuoted('Hello\nthere')).toEqual({ fresh: 'Hello\nthere', quoted: '' })
  })

  it('a quote is only what nothing new follows, however long', () => {
    const answered = `${'> question\n'.repeat(3)}answer`
    expect(splitQuoted(answered)).toEqual({ fresh: answered, quoted: '' })
    expect(splitQuoted(`Fresh.\n\n${'> old\n\n'.repeat(3)}`)).toEqual({ fresh: 'Fresh.', quoted: `${'> old\n\n'.repeat(3)}` })
  })

  it('is quick over what a stranger made to be slow', () => {
    quick(() => splitQuoted('On '.repeat(200_000)))
    quick(() => splitQuoted(`${'On a\n'.repeat(50_000)}wrote`))
    quick(() => splitQuoted(`${'> a\n'.repeat(130_000)}fresh`)) // 512 KB of it was minutes, during sync
    quick(() => makeSnippet(`${'>\n'.repeat(250_000)}fresh`))
    quick(() => splitQuoted('>'.repeat(500_000)))
  })
})

describe('previews', () => {
  it('shows the new words of a reply, not the quote', () => {
    expect(makeSnippet('Works for me.\n\nOn Tue, Mai <mai@example.com> wrote:\n> Thursday?')).toBe('Works for me.')
  })

  it('falls back on the quote when that is all there is', () => {
    expect(makeSnippet('> Only this')).toBe('> Only this')
  })

  it('reads HTML-only mail in its own case, without its link addresses', () => {
    const preview = makeSnippet('', '<h1>Your weekly round-up</h1><p>Read <a href="https://track.example/abcdef">this</a></p><img src="x.png" alt="logo">')
    expect(preview).toBe('Your weekly round-up Read this')
  })

  it('drops the line asking to view it in a browser', () => {
    expect(makeSnippet('View this email in your browser\nHello there')).toBe('Hello there')
  })

  it('is quick over mail made to be slow', () => {
    quick(() => makeSnippet(`${'On '.repeat(100_000)}wrote:`))
    quick(() => makeSnippet('', `<div>${'<b>x'.repeat(5_000)}</div>`))
    quick(() => makeSnippet(`<p>${'&#39;'.repeat(100_000)}`))
    quick(() => makeSnippet(`${'[image: '.repeat(50_000)}`))
    quick(() => makeSnippet(`${'${'.repeat(100_000)}`))
  })

  // A plain part that's really the HTML source, as some senders' software writes it, showed its tags.
  it('reads a plain part that is really HTML as HTML, or the HTML part when there is one', () => {
    expect(makeSnippet('<!doctype html><html><body><p>Your code is 4821.<br />It works for ten minutes.</p><!-- footer --></body></html>'))
      .toBe('Your code is 4821. It works for ten minutes.')
    expect(makeSnippet('<div>Hello</div>', '<p>Hello from the HTML part</p>')).toBe('Hello from the HTML part')
    expect(makeSnippet('Use <b> for bold, and a < b when it is.')).toBe('Use <b> for bold, and a < b when it is.') // text about tags is text
  })

  it('decodes what is written as entities, and drops what stands in for pictures', () => {
    expect(makeSnippet('We&#39;ve got your order &amp; it ships &quot;today&quot;&nbsp;&mdash; thanks.')).toBe('We\'ve got your order & it ships "today" — thanks.')
    expect(makeSnippet('[image: Shop logo]\nYour receipt [cid:logo@shop]is ready.')).toBe('Your receipt is ready.')
  })

  it('leaves no empty brackets where links were, and no template a sender forgot to fill in', () => {
    expect(makeSnippet('Hi ${first_name}, read more ( https://shop.example/a ) or < https://shop.example/b > now.')).toBe('Hi, read more or now.')
  })
})

describe('recipients', () => {
  it('splits on commas and semicolons, outside names and brackets', () => {
    expect(splitRecipients('a@b.example, "Tran, Mai" <mai@b.example>; c@b.example,')).toEqual(['a@b.example', '"Tran, Mai" <mai@b.example>', 'c@b.example'])
    expect(splitRecipients('"a\\" , b" <x@b.example>')).toEqual(['"a\\" , b" <x@b.example>'])
    expect(splitRecipients('   ')).toEqual([])
  })

  it('reads a name and an address', () => {
    expect(readRecipient('"Tran, Mai" <mai@b.example>')).toMatchObject({ name: 'Tran, Mai', address: 'mai@b.example', valid: true })
    expect(readRecipient('mai@b.example')).toMatchObject({ name: '', address: 'mai@b.example', valid: true })
  })

  it('says when something is not an address', () => {
    for (const text of ['mai', '@b.example', 'mai@', 'a@b@c', 'a b@c']) expect(readRecipient(text).valid).toBe(false)
  })

  it('a name dressed as an address never hides the real one', () => {
    expect(chipLabel(readRecipient('"boss@work.example" <x@evil.example>'))).toBe('x@evil.example')
    expect(chipLabel(readRecipient('Mai Tran <mai@b.example>'))).toBe('Mai Tran')
  })

  it('is quick over a header made to be slow', () => {
    quick(() => splitRecipients('"<'.repeat(500_000)))
    quick(() => readRecipient('<'.repeat(500_000)))
  })
})
