import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { BREAK, matchCount, matchesIn, step } from '@shared/find'
import { keyName } from '@shared/keys'

/**
 * Finding words in the open thread: its subject and senders, and each open message, the HTML ones
 * inside their frames. Electron's findInPage would search the whole window, the list and the
 * sidebar beside the thread and this bar's own box among them, so the thread's text is read here and
 * its matches are marked with the page's highlights, which change nothing in a message's page.
 */

const ALL = 'xrn-find'
const NOW = 'xrn-find-now'
const SETTLE_MS = 1500

/** What holds no words of the thread's: a closed message's row and the other buttons, the notes
 *  about a message's pictures, and anything floating over it. */
const SKIP = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'])
const SKIP_PARTS = '.body-notes, .popover, .context-menu, [role="dialog"], [aria-hidden="true"]'
/** Where a block starts and ends, so a match can't run from the end of one into the next. */
const BLOCK = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|CAPTION|CENTER|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/

interface Piece { node: Text; start: number }
/** The words of one page, the window's own or a message's frame, as one string. */
interface Chunk { doc: Document; frame: HTMLIFrameElement | null; text: string; pieces: Piece[] }

function chunksOf(root: Element): Chunk[] {
  const chunks: Chunk[] = []
  let chunk: Chunk = { doc: root.ownerDocument, frame: null, text: '', pieces: [] }
  const begin = (doc: Document, frame: HTMLIFrameElement | null): void => {
    if (chunk.pieces.length > 0) chunks.push(chunk)
    chunk = { doc, frame, text: '', pieces: [] }
  }
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = (node as Text).data
      if (!text) return
      chunk.pieces.push({ node: node as Text, start: chunk.text.length })
      chunk.text += text
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    const tag = element.tagName.toUpperCase()
    if (SKIP.has(tag) || element.matches(SKIP_PARTS)) return
    if (tag === 'IFRAME') {
      const frame = element as HTMLIFrameElement
      const body = frame.contentDocument?.body
      if (!body) return
      const outer = { doc: chunk.doc, frame: chunk.frame }
      begin(body.ownerDocument, frame)
      walk(body)
      begin(outer.doc, outer.frame)
      return
    }
    const block = BLOCK.test(tag)
    if (block) chunk.text += BREAK
    for (let child = element.firstChild; child; child = child.nextSibling) walk(child)
    if (block) chunk.text += BREAK
  }
  walk(root)
  if (chunk.pieces.length > 0) chunks.push(chunk)
  return chunks
}

/** The last piece that starts at or before [at]. */
function pieceAt(pieces: Piece[], at: number): Piece | undefined {
  let low = 0
  let high = pieces.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((pieces[middle]?.start ?? 0) <= at) low = middle
    else high = middle - 1
  }
  return pieces[low]
}

interface Match { range: Range; frame: HTMLIFrameElement | null }

/** Every match of [query] under [root] that's on show, in reading order. */
function matchesUnder(root: Element, query: string): Match[] {
  const found: Match[] = []
  for (const chunk of chunksOf(root)) {
    for (const [start, end] of matchesIn(chunk.text, query)) {
      const first = pieceAt(chunk.pieces, start)
      const last = pieceAt(chunk.pieces, end - 1)
      if (!first || !last) continue
      const range = chunk.doc.createRange()
      range.setStart(first.node, Math.min(start - first.start, first.node.data.length))
      range.setEnd(last.node, Math.min(end - last.start, last.node.data.length))
      // Quoted text folded away, or anything else not drawn, isn't there to be found.
      if (range.getClientRects().length > 0) found.push({ range, frame: chunk.frame })
    }
  }
  return found
}

const registry = (doc: Document): HighlightRegistry | undefined => (doc.defaultView as (Window & typeof globalThis) | null)?.CSS?.highlights

/** Marks [matches] in the pages they're in, [current] apart, and takes the marks away from pages
 *  that had them before. */
function paint(matches: Match[], current: number, marked: Set<Document>): void {
  for (const doc of marked) {
    registry(doc)?.delete(ALL)
    registry(doc)?.delete(NOW)
  }
  marked.clear()
  const byPage = new Map<Document, Range[]>()
  for (const { range } of matches) {
    const doc = range.startContainer.ownerDocument
    if (!doc) continue
    byPage.set(doc, [...(byPage.get(doc) ?? []), range])
  }
  for (const [doc, ranges] of byPage) {
    registry(doc)?.set(ALL, new Highlight(...ranges))
    marked.add(doc)
  }
  const now = matches[current]?.range
  const doc = now?.startContainer.ownerDocument
  if (now && doc) {
    const highlight = new Highlight(now)
    highlight.priority = 1
    registry(doc)?.set(NOW, highlight)
  }
}

/** Scrolls [scroller] so the match is in sight, and its frame sideways if the match is off its edge. */
function reveal(match: Match, scroller: Element): void {
  const rect = match.range.getBoundingClientRect()
  let top = rect.top
  let bottom = rect.bottom
  if (match.frame) {
    const box = match.frame.getBoundingClientRect()
    top += box.top + match.frame.clientTop
    bottom += box.top + match.frame.clientTop
    const page = match.frame.contentDocument?.scrollingElement
    const wide = match.frame.clientWidth
    if (page && (rect.left < 0 || rect.right > wide)) page.scrollLeft += rect.left - wide / 3
  }
  const view = scroller.getBoundingClientRect()
  const room = Math.min(60, view.height / 4)
  if (top < view.top + room || bottom > view.bottom - room) scroller.scrollTop += (top + bottom) / 2 - (view.top + view.bottom) / 2
}

/** The matches of [query] under [root], marked, with which is current. They're found again as the
 *  thread changes under them: a message opened or closed, a frame drawn again for Show images. */
export function useFind(root: RefObject<HTMLElement | null>, query: string): { count: number; current: number; move(by: 1 | -1): void } {
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(-1)
  const matches = useRef<Match[]>([])
  const now = useRef(-1)
  const marked = useRef(new Set<Document>())
  /** Until when the first match stays current and in sight: what's typed opens the messages it's in,
   *  and their frames are drawn a moment later, so the first match can move. Stepping ends it. */
  const settling = useRef(0)

  useEffect(() => {
    const scroller = root.current
    if (!scroller) return
    let next = 0
    const find = (): void => {
      matches.current = query.trim() ? matchesUnder(scroller, query) : []
      const total = matches.current.length
      const first = Date.now() < settling.current
      now.current = total === 0 ? -1 : first || now.current < 0 ? 0 : Math.min(now.current, total - 1)
      paint(matches.current, now.current, marked.current)
      setCount(total)
      setCurrent(now.current)
      const shown = matches.current[now.current]
      if (first && shown) reveal(shown, scroller)
    }
    const again = (): void => {
      cancelAnimationFrame(next)
      next = requestAnimationFrame(find)
    }
    settling.current = Date.now() + SETTLE_MS
    find()
    const watcher = new MutationObserver(again)
    watcher.observe(scroller, { childList: true, subtree: true, characterData: true })
    // A message's frame says when its page has been drawn, which isn't a change to this page.
    scroller.addEventListener('xrn-shown', again)
    return () => {
      cancelAnimationFrame(next)
      watcher.disconnect()
      scroller.removeEventListener('xrn-shown', again)
    }
  }, [root, query])

  useEffect(() => () => paint([], -1, marked.current), [])

  const move = (by: 1 | -1): void => {
    const total = matches.current.length
    if (total === 0 || !root.current) return
    settling.current = 0
    now.current = step(now.current, total, by)
    paint(matches.current, now.current, marked.current)
    setCurrent(now.current)
    const shown = matches.current[now.current]
    if (shown) reveal(shown, root.current)
  }
  return { count, current, move }
}

/** Whether a key pressed with [target] focused is the find bar's to answer: not one a dialog, a menu
 *  or the composer is open for. */
function ours(target: EventTarget | null): boolean {
  if (document.querySelector('dialog[open], .popover, .context-menu')) return false
  const element = target && 'closest' in target ? (target as Element) : null
  return !element?.closest('.composer')
}

/** The bar over a thread: what to find, which match of how many, the one before and after, and
 *  Close. Enter and Shift+Enter, F3 and Shift+F3, and Ctrl+G and Ctrl+Shift+G go to the next and the
 *  one before; Esc closes it. */
export function FindBar(props: {
  root: RefObject<HTMLElement | null>
  query: string
  setQuery(query: string): void
  /** Asked for again while open: the box takes the focus once more. */
  asked: number
  close(): void
}): ReactNode {
  const box = useRef<HTMLInputElement>(null)
  const { count, current, move } = useFind(props.root, props.query)

  useEffect(() => {
    box.current?.focus()
    box.current?.select()
  }, [props.asked])

  const latest = useRef({ move, close: props.close })
  latest.current = { move, close: props.close }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!ours(event.target)) return
      const name = keyName(event)
      const element = event.target && 'closest' in event.target ? (event.target as Element) : null
      if (name === 'F3' || name === 'Ctrl+G') latest.current.move(1)
      else if (name === 'Shift+F3' || name === 'Ctrl+Shift+G') latest.current.move(-1)
      // Esc in the thread or in this bar; elsewhere (the list, the search box) it's theirs.
      else if (name === 'Escape' && (!element || element === document.body || element.closest('.reader'))) latest.current.close()
      else return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="find-bar" role="group" aria-label="Find in message">
      <input ref={box} type="text" aria-label="Find in message" placeholder="Find" value={props.query} spellCheck={false}
        onChange={(e) => props.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          move(e.shiftKey ? -1 : 1)
        }} />
      {props.query.trim() && <span className="find-count muted" aria-live="polite">{matchCount(current, count)}</span>}
      <button type="button" className="icon small" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={count === 0} onClick={() => move(-1)}>
        <ChevronUp size={15} aria-hidden="true" />
      </button>
      <button type="button" className="icon small" aria-label="Next match" title="Next (Enter)" disabled={count === 0} onClick={() => move(1)}>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <button type="button" className="icon small" aria-label="Close find" title="Close (Esc)" onClick={props.close}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  )
}

/** How matches look in a message's frame, which can't read the window's colours: as style.css has
 *  them, from --star. */
export const FIND_STYLE = `::highlight(${ALL}){background:rgb(240 138 12 / 0.35)}::highlight(${NOW}){background:#f08a0c;color:#1c1f24}`
