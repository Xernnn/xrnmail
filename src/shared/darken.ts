/**
 * The colours of a message made for a white page, moved for a dark window: light backgrounds go dark,
 * dark text goes light, each keeping its hue. What's already dark as a background, or light as text,
 * stays as it is, so mail that's dark already comes through unchanged. Pictures aren't colours here
 * and are never touched.
 */

/** Red, green and blue from 0 to 255, and how opaque, from 0 to 1. */
export type Rgba = [number, number, number, number]

/** A colour as getComputedStyle gives it: `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, or the same with
 *  spaces and a slash. Anything else (a keyword, `transparent`) isn't one to change. */
export function parseColour(css: string): Rgba | null {
  const found = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(css.trim())
  if (!found) return null
  const [, r, g, b, alpha, percent] = found
  const a = alpha === undefined ? 1 : Number(alpha) / (percent ? 100 : 1)
  return [Number(r), Number(g), Number(b), Math.max(0, Math.min(1, a))]
}

export const colourCss = ([r, g, b, a]: Rgba): string =>
  a >= 1 ? `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`

/** How light a colour looks, from 0 (black) to 1 (white): WCAG's relative luminance. */
export function luminance([r, g, b]: Rgba): number {
  const linear = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

type Hsl = [number, number, number]

function toHsl([r, g, b]: Rgba): Hsl {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const high = Math.max(R, G, B)
  const low = Math.min(R, G, B)
  const l = (high + low) / 2
  if (high === low) return [0, 0, l]
  const d = high - low
  const s = l > 0.5 ? d / (2 - high - low) : d / (high + low)
  const h = high === R ? (G - B) / d + (G < B ? 6 : 0) : high === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h / 6, s, l]
}

function fromHsl([h, s, l]: Hsl, a: number): Rgba {
  if (s === 0) return [l * 255, l * 255, l * 255, a]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (u < 1 / 6) return p + (q - p) * 6 * u
    if (u < 1 / 2) return q
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6
    return p
  }
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255, a]
}

/** Lightness at or under this is a dark background already; a white page becomes [DARKEST]. */
const DARK_ENOUGH = 0.35
const DARKEST = 0.11
/** Lightness at or over this is light text already; black text becomes [LIGHTEST]. */
const LIGHT_ENOUGH = 0.6
const LIGHTEST = 0.9

/** A background for a dark window: white to the reader's own dark grey, a pale colour to a deep one
 *  of the same hue. A dark one stays. */
export function darkBackground(colour: Rgba): Rgba {
  const [h, s, l] = toHsl(colour)
  if (l <= DARK_ENOUGH) return colour
  const dark = DARK_ENOUGH - ((l - DARK_ENOUGH) * (DARK_ENOUGH - DARKEST)) / (1 - DARK_ENOUGH)
  return fromHsl([h, Math.min(s, 0.6), dark], colour[3])
}

/** Text for a dark window: black to near white, a dark colour to a light one of the same hue. Light
 *  text stays. */
export function lightText(colour: Rgba): Rgba {
  const [h, s, l] = toHsl(colour)
  if (l >= LIGHT_ENOUGH) return colour
  return fromHsl([h, s, LIGHT_ENOUGH + ((LIGHT_ENOUGH - l) * (LIGHTEST - LIGHT_ENOUGH)) / LIGHT_ENOUGH], colour[3])
}

/** A rule or a box's edge: a pale one goes to a grey that still shows on the dark page. */
export function darkBorder(colour: Rgba): Rgba {
  const [h, s, l] = toHsl(colour)
  if (l <= 0.5) return colour
  return fromHsl([h, Math.min(s, 0.5), 0.35 - (l - 0.5) * 0.2], colour[3])
}

/** Whether a page is light, from the backgrounds found at points over it. With nothing found, it's the
 *  white page mail is made for. */
export function lightPage(backgrounds: Rgba[]): boolean {
  if (backgrounds.length === 0) return true
  const light = backgrounds.filter((colour) => luminance(colour) > 0.35).length
  return light * 2 >= backgrounds.length
}
