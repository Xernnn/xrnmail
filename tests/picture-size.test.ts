import { describe, expect, it } from 'vitest'
import { PICTURE_SIZES, sizeOf, SMALL_PX, styleFor } from '../src/shared/picture-size'

describe('picture sizes', () => {
  it('says each size in the style that goes out with the message', () => {
    expect(styleFor('small')).toBe(`max-width:${SMALL_PX}px`)
    expect(styleFor('fit')).toBe('max-width:100%')
    expect(styleFor('original')).toBeNull()
  })

  it('reads each size back from its style, so a draft opened again shows the one chosen', () => {
    for (const [size] of PICTURE_SIZES) expect(sizeOf(styleFor(size))).toBe(size)
  })

  it('reads a picture as it came in from elsewhere: pasted ones fit, bare ones are as made', () => {
    expect(sizeOf('max-width:100%')).toBe('fit') // every picture put in before there were sizes
    expect(sizeOf('height: auto; max-width: 100%;')).toBe('fit')
    expect(sizeOf('MAX-WIDTH: 320PX')).toBe('small')
    expect(sizeOf(null)).toBe('original')
    expect(sizeOf('')).toBe('original')
    expect(sizeOf('max-width:none')).toBe('original')
    expect(sizeOf('min-width:10px')).toBe('original')
  })
})
