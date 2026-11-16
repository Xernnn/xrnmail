import { fitTo } from '@shared/fit'

/**
 * A message's frame fitted to the reading pane's width, each time that changes. Mail made for a fixed
 * width that's wider than the pane is drawn smaller with CSS zoom, which lays it out again at that size:
 * its words stay sharp, its links and its darkening work as before, and its pictures shrink with it.
 * Mail that flows to any width is left at its size, and a part of it too wide for the pane is put in a
 * box that scrolls sideways. (shared/fit.ts decides which; this measures, and does it.)
 */

/** How many elements are looked at at most: a stranger's message can be built to be endless. */
const MOST = 20_000

const WIDE_BOX = 'xrn-wide'

/** The outermost parts of the message reaching past the pane's right edge. */
function sticking(body: HTMLElement, view: number): HTMLElement[] {
  const found: HTMLElement[] = []
  const waiting = [...body.children].reverse()
  for (let done = 0; waiting.length > 0 && done < MOST; done++) {
    const el = waiting.pop() as HTMLElement
    const box = el.getBoundingClientRect()
    if (box.width > 0 && box.right > view + 1) {
      found.push(el)
      continue
    }
    for (let child = el.lastElementChild; child; child = child.previousElementSibling) waiting.push(child)
  }
  return found
}

/** Words, as shown: what's hidden, and a <style>'s rules, aren't. */
const words = (el: HTMLElement): number => el.innerText.replace(/\s+/g, '').length

/** A wide part of mail that otherwise flows, in a box of the pane's width that scrolls sideways. Only a
 *  block in the flow: a box round anything else would move it. */
function boxIn(part: HTMLElement, view: Window): void {
  const parent = part.parentElement
  const style = view.getComputedStyle(part)
  if (!parent || parent.classList.contains(WIDE_BOX) || style.display.startsWith('inline') || style.display.startsWith('table-')) return
  if (style.position !== 'static' && style.position !== 'relative') return
  const box = part.ownerDocument.createElement('div')
  box.className = WIDE_BOX
  box.style.setProperty('overflow-x', 'auto')
  box.style.setProperty('overflow-y', 'hidden')
  parent.insertBefore(box, part)
  box.appendChild(part)
}

/** Fits the message to its frame's width as it is now, and says how large it's drawn: 1 for as sent. */
export function fitDocument(doc: Document): number {
  const view = doc.defaultView
  const body = doc.body
  if (!view || !body) return 1
  // Measured as sent, at the pane's width now.
  body.style.removeProperty('zoom')
  const page = doc.documentElement
  const across = page.clientWidth
  if (page.scrollWidth <= across) return 1
  const parts = sticking(body, across)
  const all = words(body)
  const share = all === 0 ? 1 : parts.reduce((sum, part) => sum + words(part), 0) / all
  // The page's margin on the right counts as part of it, as the one on the left already does.
  const wide = page.scrollWidth + (parseFloat(view.getComputedStyle(body).paddingRight) || 0)
  const fit = fitTo(across, wide, share)
  if (fit.boxWide) for (const part of parts) boxIn(part, view)
  if (fit.scale < 1) body.style.setProperty('zoom', String(fit.scale))
  return fit.scale
}
