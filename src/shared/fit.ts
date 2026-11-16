/**
 * How a message wider than the reading pane is fitted to it. Mail made for a fixed width (a newsletter's
 * 600 pixels, say) is drawn smaller as a whole, never larger. Mail that flows to any width keeps its
 * size, and a part of it too wide for the pane, a table of figures say, scrolls sideways by itself:
 * shrinking every word to fit one table would leave the rest too small to read.
 */

/** Never drawn smaller than this. Past it, what's left over scrolls sideways: a message can be built
 *  endlessly wide, and would otherwise shrink to a line. */
export const SMALLEST = 0.3

/** Mail with at least this much of its words in the parts wider than the pane was made for a width. */
const MADE_FOR_A_WIDTH = 0.5

/** How a message is fitted: drawn at [scale], 1 for as sent; or, at its own size, with its wide parts
 *  scrolling sideways in boxes of their own. */
export interface Fit {
  scale: number
  boxWide: boolean
}

/** For a message [wide] pixels across as sent, in a pane [view] pixels across, with [share] of its words
 *  (from 0 to 1) in the parts wider than the pane. A message with no words at all is pictures laid out
 *  for a width. */
export function fitTo(view: number, wide: number, share: number): Fit {
  if (!(view > 0) || !(wide > view)) return { scale: 1, boxWide: false }
  if (share < MADE_FOR_A_WIDTH) return { scale: 1, boxWide: true }
  // Rounded down, so the last fraction of a pixel never brings the sideways scroll back.
  return { scale: Math.max(SMALLEST, Math.floor((view / wide) * 1000) / 1000), boxWide: false }
}
