/** The sizes a picture in the words can be, as Gmail offers them: small, as wide as the page it's
 *  read on at most, or as it was made. The size is said on the picture itself, in the style that goes
 *  out with the message, so every reader shows it so. */
export type PictureSize = 'small' | 'fit' | 'original'

export const PICTURE_SIZES: [PictureSize, string][] = [['small', 'Small'], ['fit', 'Best fit'], ['original', 'Original size']]

/** How wide a small picture is at most. */
export const SMALL_PX = 200

/** The style a picture of [size] carries, or none. */
export function styleFor(size: PictureSize): string | null {
  if (size === 'small') return `max-width:${SMALL_PX}px`
  return size === 'fit' ? 'max-width:100%' : null
}

/** The size a picture's style says it is. A picture with no width of its own is as it was made; one
 *  narrowed to so many pixels is small, and anything else keeps to the page. */
export function sizeOf(style: string | null): PictureSize {
  const most = /(?:^|;)\s*max-width\s*:\s*([^;]+)/i.exec(style ?? '')?.[1]?.trim().toLowerCase()
  if (!most || most === 'none') return 'original'
  return /^\d+(?:\.\d+)?px$/.test(most) ? 'small' : 'fit'
}
