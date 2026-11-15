import { colourCss, darkBackground, darkBorder, lightPage, lightText, parseColour, type Rgba } from '@shared/darken'

/**
 * A message's frame, darkened for a dark window once it has loaded. This page reaches into the frame
 * (it's same-origin for sizing it), reads each element's colours as computed, and writes the dark
 * ones over them. Nothing in the frame runs, and pictures are left as they are.
 */

const SIDES = ['top', 'right', 'bottom', 'left'] as const

const WHITE: Rgba = [255, 255, 255, 1]

/** The background showing at a point: the first under it that isn't see-through, or the frame's white
 *  page. A picture, or a part drawn on one, says nothing about the page's colours. */
function backgroundAt(doc: Document, view: Window, x: number, y: number): Rgba | 'picture' {
  for (let el = doc.elementFromPoint(x, y); el && el !== doc.body; el = el.parentElement) {
    if (el.tagName === 'IMG') return 'picture'
    const style = view.getComputedStyle(el)
    if (style.backgroundImage !== 'none') return 'picture'
    const colour = parseColour(style.backgroundColor)
    if (colour && colour[3] >= 0.5) return colour
  }
  return WHITE
}

/** Whether the message was made for a white page, from its backgrounds at points spread over it.
 *  Where it has none of its own, it's on the frame's white page. */
function looksLight(doc: Document, view: Window): boolean {
  const width = doc.documentElement.clientWidth
  const height = doc.documentElement.clientHeight
  const found: Rgba[] = []
  for (let across = 1; across <= 5; across++) {
    for (let down = 1; down <= 6; down++) {
      const colour = backgroundAt(doc, view, (width * across) / 6, (height * down) / 7)
      if (colour !== 'picture') found.push(colour)
    }
  }
  return lightPage(found)
}

/** How many elements are recoloured at most: a stranger's message can be built to be endless. */
const MOST = 20_000

/** Each element's colours, parents before children. A picture is left as it is; and a part with a
 *  picture for its background keeps its colours, and so does what's inside it, since they were chosen
 *  to sit on that picture. */
function recolour(top: Element[], view: Window): void {
  const waiting = [...top].reverse()
  for (let done = 0; waiting.length > 0 && done < MOST; done++) {
    const el = waiting.pop() as Element
    if (el.tagName === 'IMG') continue
    const style = view.getComputedStyle(el)
    if (style.backgroundImage !== 'none') continue
    const inline = (el as HTMLElement).style
    const background = parseColour(style.backgroundColor)
    if (background && background[3] > 0) inline.setProperty('background-color', colourCss(darkBackground(background)), 'important')
    const text = parseColour(style.color)
    if (text) inline.setProperty('color', colourCss(lightText(text)), 'important')
    for (const side of SIDES) {
      if (!(parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0)) continue
      const edge = parseColour(style.getPropertyValue(`border-${side}-color`))
      if (edge) inline.setProperty(`border-${side}-color`, colourCss(darkBorder(edge)), 'important')
    }
    for (let child = el.lastElementChild; child; child = child.previousElementSibling) waiting.push(child)
  }
}

/** Darkens the message if it was made for a white page, and says whether it did. Either way the
 *  frame's own white page goes, so the message sits on the reader's. A frame whose colour scheme
 *  isn't its window's is given a white backdrop by Chromium, so the frame is told it's dark too. */
export function darkenDocument(doc: Document): boolean {
  const view = doc.defaultView
  if (!view || !doc.body) return false
  const light = looksLight(doc, view)
  if (light) recolour(Array.from(doc.body.children), view)
  doc.documentElement.style.setProperty('color-scheme', 'dark')
  doc.body.style.setProperty('background-color', 'transparent', 'important')
  if (light) doc.body.style.setProperty('color', colourCss(lightText(parseColour(view.getComputedStyle(doc.body).color) ?? WHITE)), 'important')
  return light
}
