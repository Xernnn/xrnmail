/**
 * What in a message exists to report that it was opened, and when, and from where. The page takes it
 * out while it cleans a message (MailBody.tsx), so "Show images" can't set it off and a reply doesn't
 * carry it on; the main process refuses the known services' addresses whatever asks for them
 * (guard.ts), since CSS can name a picture in more ways than can be read here.
 */

/** Mail services that report back when a message is opened. HubSpot hosts its senders' pictures on
 *  the same hubspotemail.net, so only its open-tracking paths count. */
export const TRACKER = /\b(list-manage\.com\/track|sendgrid\.net\/wf\/open|mandrillapp\.com\/track|mailtrack\.io|(?:hubspotemail\.net|hubspotlinks\.com|sidekickopen\d{0,3}\.com)\/(?:e[12]t\/t?o\/|Cto\/)|track\.hubspot\.com\/__ptq|sparkpostmail\.com\/q|track\.customer\.io|mailgun\.org\/o|mixmax\.com\/api\/track|bananatag\.com|superhuman\.com\/[^"']{0,200}pixel|yesware\.com\/trk|cirrusinsight\.com\/[^"']{0,200}track)/i

/** A length of two pixels or less, as an attribute writes one: "1", "1px", " 0 ", "1.0". */
const SMALL = /^\s{0,20}(?:[0-2](?:\.\d{1,6})?|\.\d{1,6})\s{0,20}(?:px)?\s{0,20}$/i
/** The same in CSS, a picture's width or height or the most either may be, and ways to hide one. */
const SMALL_IN_STYLE = /(?:^|[;\s{])(?:max-)?(?:width|height)\s{0,20}:\s{0,20}(?:[0-2](?:\.\d{1,6})?|\.\d{1,6})(?:px|pt)?\s{0,20}(?:!important\s{0,20})?(?:;|$)/i
const HIDDEN_IN_STYLE = /(?:^|[;\s])(?:display\s{0,20}:\s{0,20}none|visibility\s{0,20}:\s{0,20}hidden|opacity\s{0,20}:\s{0,20}0(?:\.0{1,6})?\s{0,20}(?:;|$))/i

/** A picture nobody can see: two pixels or less across or down, or hidden. */
export function tinyImage(width: string | null, height: string | null, style: string | null): boolean {
  const small = (value: string | null): boolean => value !== null && SMALL.test(value)
  const css = (style ?? '').slice(0, 4096)
  return small(width) || small(height) || SMALL_IN_STYLE.test(css) || HIDDEN_IN_STYLE.test(css)
}

const URL_IN_CSS = /url\(\s{0,20}(["']?)([^"')]{0,4096})\1\s{0,20}\)/gi
const IMPORT = /@import\b[^;]{0,4096};?/gi
/** Rules that load a picture only when something happens: the pointer over a link, a click. */
const ON_EVENT = /:(?:hover|active|focus)/i

/** CSS from a style attribute or a <style>, without what reports an open: pictures from the known
 *  services, any picture a rule loads only once the pointer is over something, and @import. */
export function cleanCss(css: string): { css: string; removed: number } {
  let removed = 0
  const known = (text: string): string => text.replace(URL_IN_CSS, (whole, _quote: string, target: string) => {
    if (!TRACKER.test(target)) return whole
    removed++
    return 'none'
  })
  const imports = css.replace(IMPORT, () => {
    removed++
    return ''
  })
  const out: string[] = []
  let from = 0
  let selector = 0
  let nextOpen = -1
  let nextClose = -1
  for (let i = imports.indexOf('{'); i !== -1 && i < imports.length; i = imports.indexOf('{', i + 1)) {
    if (nextClose < i) nextClose = imports.indexOf('}', i)
    if (nextClose === -1) break
    if (nextOpen <= i) nextOpen = imports.indexOf('{', i + 1)
    // A block that holds rules of its own, as @media does: its rules are looked at one by one.
    if (nextOpen !== -1 && nextOpen < nextClose) {
      selector = i + 1
      continue
    }
    if (ON_EVENT.test(imports.slice(Math.max(selector, i - 2000), i))) {
      out.push(imports.slice(from, i))
      out.push(imports.slice(i, nextClose).replace(URL_IN_CSS, () => {
        removed++
        return 'none'
      }))
      from = nextClose
    }
    selector = nextClose + 1
    i = nextClose
  }
  out.push(imports.slice(from))
  return { css: known(out.join('')), removed }
}
