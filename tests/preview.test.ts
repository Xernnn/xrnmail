import { describe, expect, it } from 'vitest'
import { makeSnippet } from '@main/parse'
import { quoteStart, splitQuoted } from '@shared/quoted'
import { chipLabel, readRecipient, splitRecipients } from '@shared/recipients'

/** How long [work] takes over [input], at its least of a few tries, so a moment the laptop is busy
 *  elsewhere doesn't count. */
const least = (work: (input: string) => unknown, input: string): number => {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    work(input)
    best = Math.min(best, performance.now() - started)
  }
  return best
}

/**
 * Whether [work] stays in step with the length of what a stranger made [make] it: four times the
 * length takes about four times as long, where time that grows with the length squared (minutes, at
 * 512 KB) takes sixteen. Each is timed against the same work over a quarter of it, not a clock, so a
 * busy laptop slows both and fails neither. Work too quick to time well passes on its own.
 */
const quick = (make: (n: number) => string, work: (input: string) => unknown, n: number): void => {
  const quarter = least(work, make(Math.round(n / 4)))
  const whole = least(work, make(n))
  expect(whole).toBeLessThan(Math.max(quarter * 10, 25))
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
    quick((n) => 'On '.repeat(n), splitQuoted, 200_000)
    quick((n) => `${'On a\n'.repeat(n)}wrote`, splitQuoted, 50_000)
    quick((n) => `${'> a\n'.repeat(n)}fresh`, splitQuoted, 130_000) // 512 KB of it was minutes, during sync
    quick((n) => `${'>\n'.repeat(n)}fresh`, makeSnippet, 250_000)
    quick((n) => '>'.repeat(n), splitQuoted, 500_000)
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
    quick((n) => `${'On '.repeat(n)}wrote:`, makeSnippet, 100_000)
    quick((n) => `<div>${'<b>x'.repeat(n)}</div>`, (html) => makeSnippet('', html), 5_000)
    quick((n) => `<p>${'&#39;'.repeat(n)}`, makeSnippet, 100_000)
    quick((n) => '[image: '.repeat(n), makeSnippet, 50_000)
    quick((n) => '${'.repeat(n), makeSnippet, 100_000)
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
    quick((n) => '"<'.repeat(n), splitRecipients, 500_000)
    quick((n) => '<'.repeat(n), readRecipient, 500_000)
  })
})
