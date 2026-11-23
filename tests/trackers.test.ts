import { describe, expect, it } from 'vitest'
import { cleanCss, tinyImage, TRACKER } from '@shared/trackers'

/** Nothing here is fetched: these are only the addresses a message could name. */

describe('pictures that report an open', () => {
  // Only width="1" counted: width="1px", max-width:1px and a hidden picture all loaded after Show
  // images, each saying when the message was read.
  it('knows a picture nobody can see, however its size is written', () => {
    for (const [width, height, style] of [
      ['1', null, null], ['1px', '1px', null], [' 0 ', null, null], ['1.0', null, null], [null, null, 'max-width:1px;max-height:1px'],
      [null, null, 'width: 2px !important'], [null, null, 'visibility:hidden;position:absolute'], [null, null, 'display:none'], [null, null, 'opacity:0']
    ] as const) expect(tinyImage(width, height, style), JSON.stringify([width, height, style])).toBe(true)
    for (const [width, height, style] of [
      ['560', '200', null], ['2%', null, null], ['100%', null, null], [null, null, 'width:120px;height:40px'], [null, null, 'max-width:100%'], [null, null, 'opacity:0.9']
    ] as const) expect(tinyImage(width, height, style), JSON.stringify([width, height, style])).toBe(false)
  })

  it('takes the known services out of CSS, and keeps real pictures', () => {
    const style = cleanCss('background-image:url(https://mandrillapp.com/track/open.php?u=1); color: red')
    expect(style).toEqual({ css: 'background-image:none; color: red', removed: 1 })
    const block = cleanCss('p{background:url("https://x.list-manage.com/track/open?u=1")} .hero{background:url(https://cdn.example/hero.jpg)}')
    expect(block.removed).toBe(1)
    expect(block.css).toContain('url(https://cdn.example/hero.jpg)')
    expect(block.css).not.toContain('list-manage')
  })

  it('takes out pictures a rule loads only once the pointer is over something, and @import', () => {
    const hover = cleanCss('a{color:blue} a:hover{background:url(https://beacon.example/hovered)} @media (max-width:700px){a:focus{background:url(https://beacon.example/x)} p{color:red}}')
    expect(hover.removed).toBe(2)
    expect(hover.css).not.toContain('beacon.example')
    expect(hover.css).toContain('a{color:blue}')
    expect(hover.css).toContain('p{color:red}')
    expect(cleanCss('@import url(https://styles.example/a.css); p{color:red}')).toEqual({ css: ' p{color:red}', removed: 1 })
  })

  it('reads a stranger\'s CSS in one pass, however it is written', () => {
    const started = Date.now()
    cleanCss('{'.repeat(200_000) + '}'.repeat(200_000))
    cleanCss('a'.repeat(400_000))
    cleanCss('a:hover{'.repeat(50_000))
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('knows the services by their open-tracking addresses alone', () => {
    expect(TRACKER.test('https://t.hubspotemail.net/e2t/to/VWxyz123/abc')).toBe(true)
    expect(TRACKER.test('https://hs-1234567.f.hubspotemail.net/hub/1234567/hubfs/spring/banner.png')).toBe(false)
  })
})
