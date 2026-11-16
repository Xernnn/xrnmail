import { describe, expect, it } from 'vitest'
import { fitTo, SMALLEST } from '@shared/fit'

describe('fitting a message to the reading pane', () => {
  it('draws mail made for a width smaller, just enough to fit, and never larger', () => {
    const fit = fitTo(541, 618, 1)
    expect(fit.boxWide).toBe(false)
    expect(fit.scale).toBeLessThan(1)
    expect(618 * fit.scale).toBeLessThanOrEqual(541)
    expect(618 * fit.scale).toBeGreaterThan(540)
    expect(fitTo(800, 618, 1)).toEqual({ scale: 1, boxWide: false })
    expect(fitTo(618, 618, 1)).toEqual({ scale: 1, boxWide: false })
  })

  it('counts pictures with no words as made for a width', () => {
    expect(fitTo(400, 600, 1).scale).toBeLessThan(1)
  })

  it('leaves mail that flows at its size, with its wide parts scrolling by themselves', () => {
    expect(fitTo(541, 940, 0.1)).toEqual({ scale: 1, boxWide: true })
    expect(fitTo(541, 940, 0.49)).toEqual({ scale: 1, boxWide: true })
    expect(fitTo(541, 940, 0.5).scale).toBeLessThan(1)
  })

  it('stops shrinking at a point, so a message built endlessly wide stays readable', () => {
    expect(fitTo(500, 100_000, 1)).toEqual({ scale: SMALLEST, boxWide: false })
  })

  it('does nothing with a frame that has no width yet', () => {
    expect(fitTo(0, 600, 1)).toEqual({ scale: 1, boxWide: false })
  })
})
