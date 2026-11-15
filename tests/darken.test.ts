import { describe, expect, it } from 'vitest'
import { colourCss, darkBackground, darkBorder, lightPage, lightText, luminance, parseColour, type Rgba } from '@shared/darken'

const rgb = (css: string): Rgba => {
  const colour = parseColour(css)
  if (!colour) throw new Error(`not a colour: ${css}`)
  return colour
}

describe('colours for a dark window', () => {
  it('reads colours as the page computes them, and nothing else', () => {
    expect(parseColour('rgb(255, 255, 255)')).toEqual([255, 255, 255, 1])
    expect(parseColour('rgba(28, 78, 128, 0.5)')).toEqual([28, 78, 128, 0.5])
    expect(parseColour('rgb(1 2 3 / 40%)')).toEqual([1, 2, 3, 0.4])
    expect(parseColour('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0])
    expect(parseColour('transparent')).toBeNull()
    expect(parseColour('url(x)')).toBeNull()
    expect(colourCss([10.4, 20.6, 30, 1])).toBe('rgb(10, 21, 30)')
    expect(colourCss([10, 20, 30, 0.5])).toBe('rgba(10, 20, 30, 0.5)')
  })

  it('takes a white page to the reader\'s dark grey, and a pale colour to a deep one of its hue', () => {
    const white = darkBackground(rgb('rgb(255, 255, 255)'))
    expect(luminance(white)).toBeLessThan(0.02)
    const pale = darkBackground(rgb('rgb(244, 244, 244)'))
    expect(luminance(pale)).toBeLessThan(0.03)
    const blue = darkBackground(rgb('rgb(220, 235, 255)'))
    expect(blue[2]).toBeGreaterThan(blue[0]) // still blue
    expect(luminance(blue)).toBeLessThan(0.05)
    expect(darkBackground([255, 255, 255, 0.5])[3]).toBe(0.5)
  })

  it('leaves a background that is dark already as it is', () => {
    for (const css of ['rgb(18, 18, 18)', 'rgb(28, 78, 128)', 'rgb(0, 0, 0)']) expect(darkBackground(rgb(css))).toEqual(rgb(css))
  })

  it('takes dark text to light text of its hue, and leaves light text', () => {
    const black = lightText(rgb('rgb(34, 34, 34)'))
    expect(luminance(black)).toBeGreaterThan(0.6)
    const link = lightText(rgb('rgb(26, 95, 208)'))
    expect(link[2]).toBeGreaterThan(link[0])
    expect(luminance(link)).toBeGreaterThan(0.3)
    for (const css of ['rgb(255, 255, 255)', 'rgb(230, 231, 234)']) expect(lightText(rgb(css))).toEqual(rgb(css))
  })

  it('keeps pale rules visible on the dark page, and dark ones as they are', () => {
    const rule = darkBorder(rgb('rgb(221, 221, 221)'))
    expect(luminance(rule)).toBeGreaterThan(luminance(darkBackground(rgb('rgb(255, 255, 255)'))))
    expect(luminance(rule)).toBeLessThan(0.2)
    expect(darkBorder(rgb('rgb(51, 51, 51)'))).toEqual(rgb('rgb(51, 51, 51)'))
  })

  it('calls a page light when most of it is, and white when nothing says otherwise', () => {
    const white = rgb('rgb(255, 255, 255)')
    const night = rgb('rgb(17, 17, 17)')
    expect(lightPage([])).toBe(true)
    expect(lightPage([white, white, night])).toBe(true)
    expect(lightPage([night, night, white])).toBe(false)
  })
})
