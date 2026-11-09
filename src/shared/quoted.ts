/**
 * Where the new part of a plain-text reply ends and the copy of what it answers begins. A stranger
 * wrote the text, and sorting and previews run in the main process, so this walks lines and only ever
 * tests short pieces of them.
 */

const LINE_LIMIT = 300
const INTRO = /^(on|vào|le|am|el|il|em|op)\s.{0,260}(wrote|viết|écrit|schrieb|escribió|ha scritto|escreveu|schreef)\s{0,2}:\s{0,2}$/i
const DIVIDER = /^(-{2,}\s?(original message|forwarded message|thư gốc|tin nhắn gốc)\s?-{2,}|_{10,})$/i
const HEADERS = /^(from|sent|to|subject|từ|gửi|đến|chủ đề):\s/i

const quotedLine = (line: string): boolean => line.trimStart().startsWith('>')

/** The line a quote starts on, or the line count if nothing in it is a quote. */
export function quoteStart(lines: string[]): number {
  // The last line that's neither quoted nor blank, found once from the end: asking again at every
  // quoted line whether all the rest is quoted takes minutes over a long enough quote.
  let answered = lines.length - 1
  while (answered >= 0 && (quotedLine(lines[answered] ?? '') || (lines[answered] ?? '').trim() === '')) answered--
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').slice(0, LINE_LIMIT).trim()
    if (quotedLine(line)) {
      // One quoted line in the middle of an answer is a reply between the lines: leave those whole.
      if (i > answered) return i
      continue
    }
    const next = (lines[i + 1] ?? '').slice(0, LINE_LIMIT).trim()
    if (INTRO.test(line)) return i
    if (next && line.length < LINE_LIMIT / 2 && INTRO.test(`${line} ${next}`)) return i // the app before wrapped it
    if (DIVIDER.test(line)) return i
    if (HEADERS.test(line) && HEADERS.test(next) && i > 0 && (lines[i - 1] ?? '').trim() === '') return i
  }
  return lines.length
}

export interface SplitText {
  fresh: string
  quoted: string
}

export function splitQuoted(text: string): SplitText {
  const lines = text.split(/\r?\n/)
  const at = quoteStart(lines)
  if (at === 0 || at >= lines.length) return { fresh: text, quoted: '' }
  return { fresh: lines.slice(0, at).join('\n').trimEnd(), quoted: lines.slice(at).join('\n') }
}
