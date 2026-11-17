import DOMPurify from 'dompurify'
import { Ellipsis, ImageOff, Palette, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { splitQuoted } from '@shared/quoted'
import { darkenDocument, UNLOADED_DARK } from './darken'
import { fitDocument } from './fit'

/**
 * Shows a stranger's HTML. It's sanitised here, then shown in a frame that may not run scripts,
 * under a policy with no network, and the main process refuses the network as well. allow-same-origin
 * is only there so this page can size the frame and catch its clicks: with no allow-scripts,
 * nothing inside can use it.
 */
const SANITIZE = {
  FORCE_BODY: true, // keeps <style> from the head, which most mail depends on
  FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'svg', 'math', 'audio', 'video', 'source', 'template'],
  FORBID_ATTR: ['ping', 'srcset', 'target'],
  ALLOW_DATA_ATTR: false
}

/** Mail services that report back when a message is opened. HubSpot hosts its senders' pictures on
 *  the same hubspotemail.net, so only its open-tracking paths count. */
const TRACKER = /\b(list-manage\.com\/track|sendgrid\.net\/wf\/open|mandrillapp\.com\/track|mailtrack\.io|(?:hubspotemail\.net|hubspotlinks\.com|sidekickopen\d{0,3}\.com)\/(?:e[12]t\/t?o\/|Cto\/)|track\.hubspot\.com\/__ptq|sparkpostmail\.com\/q|track\.customer\.io|mailgun\.org\/o|mixmax\.com\/api\/track|bananatag\.com|superhuman\.com\/[^"']{0,200}pixel|yesware\.com\/trk|cirrusinsight\.com\/[^"']{0,200}track)/i

const tiny = (image: Element): boolean => {
  const small = (name: string): boolean => {
    const value = image.getAttribute(name)?.trim()
    return Boolean(value) && Number(value) <= 2
  }
  const style = image.getAttribute('style') ?? ''
  return small('width') || small('height') || /(?:^|;|\s)(?:width|height)\s*:\s*[012]px/i.test(style) || /display\s*:\s*none/i.test(style)
}

let trackers = 0

// An image nobody can see, or from a service that exists to report opens, says when you read the
// message and from where. Stripped here so "Show images" can't set one off, and so a reply doesn't
// carry it on to someone else. It runs inside DOMPurify, on the tree it has cleaned, because taking
// clean HTML apart and putting it back together is how sanitised markup gets turned hostile again.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'IMG') return
  const image = node as Element
  const src = image.getAttribute('src') ?? ''
  if (!/^(?:https?:)?\/\//i.test(src) || !(tiny(image) || TRACKER.test(src))) return
  image.removeAttribute('src')
  trackers++
})

export const sanitize = (html: string): string => DOMPurify.sanitize(html, SANITIZE)

function sanitizeCounting(html: string): { clean: string; removed: number } {
  trackers = 0
  const clean = sanitize(html)
  return { clean, removed: trackers }
}

const REMOTE = /(?:src|background)\s{0,20}=\s{0,20}["']?\s{0,20}(?:https?:)?\/\/|url\(\s{0,20}["']?\s{0,20}(?:https?:)?\/\//i

/** The markers mail apps leave around what they quote. Everything here is on clean, bounded markup. */
const QUOTED = /class=["'][^"']{0,200}(?:gmail_quote|yahoo_quoted|moz-cite-prefix)|type=["']cite|id=["'](?:divRplyFwdMsg|appendonsend)/i
const HIDE_QUOTED = `html.hide-quoted .gmail_quote,html.hide-quoted .gmail_extra,html.hide-quoted .yahoo_quoted,html.hide-quoted blockquote[type=cite],html.hide-quoted .moz-cite-prefix,html.hide-quoted #divRplyFwdMsg,html.hide-quoted #divRplyFwdMsg~*,html.hide-quoted #appendonsend,html.hide-quoted #appendonsend~*{display:none!important}`

/** Mail nobody designed: a reply typed into another app. It has no colours of its own to clash with,
 *  so it can take on the window's, and a dark window isn't interrupted by a white block. */
const DESIGNED = /<(?:table|img|font|center)\b|\b(?:background|bgcolor)\b|\bcolor\s{0,20}[:=]/i

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

/** Marks a picture asked for that couldn't be fetched (offline, say), shown as one not asked for is. */
const FAILED = 'xrn-failed'

/** A picture that hasn't been allowed shows as a plain block of its own size, not a broken icon: pale
 *  on the white page mail is made for, dark on a dark one (darken.ts sets that once it has darkened). */
const UNLOADED = `html.no-images img[src^="http"],html.no-images img[src^="//"],img.${FAILED}{content:url("${BLANK}");background:var(--xrn-unloaded,#e9ecf0);border-radius:4px}`

/** Installed fonts only: the frame may load nothing, so the app's own copy of MiSans can't reach it. */
const FRAME_FONTS = `"MiSans Latin","MiSans","Noto Sans","Segoe UI",Roboto,"Helvetica Neue",Arial,"Liberation Sans",sans-serif`

/** The frame's own margin is inside its page, so mail that makes its page the full width (most of what
 *  comes from mailing services does) isn't that margin wider than the pane. */
function frameDocument(clean: string, images: boolean, dark: boolean, designed: boolean): string {
  const remote = images ? ' http: https:' : ''
  const policy = `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'; font-src data:`
  // Plain mail takes on the card it sits in; designed mail keeps the white page it was made for,
  // unless a dark window darkens it once it's loaded.
  const blends = !designed
  const look = !blends ? 'body{background:#fff;color:#1c1b1a}'
    : dark ? `html{color-scheme:dark;--xrn-unloaded:${UNLOADED_DARK}}body{background:transparent;color:#e6e7ea}a{color:#8ab4ff}blockquote{border-left-color:#3b3e45}`
    : 'body{background:transparent;color:#1d2025}a{color:#1a5fd0}'
  return `<!doctype html><html class="${images ? '' : 'no-images'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{overflow-x:auto;overflow-y:hidden}body{box-sizing:border-box;margin:0;padding:${blends ? '0 2px' : '16px 18px'};font:14px/1.6 ${FRAME_FONTS};word-break:break-word}img{max-width:100%;height:auto}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:2px solid #d5d9e0}${look}${UNLOADED}${HIDE_QUOTED}</style></head><body>${clean}</body></html>`
}

const SYSTEM_DARK = '(prefers-color-scheme: dark)'

const isDark = (): boolean => {
  const theme = document.documentElement.dataset['theme']
  return theme === 'dark' || (theme !== 'light' && window.matchMedia(SYSTEM_DARK).matches)
}

/** Whether the window is dark, now and each time that changes: the desktop switching its theme, with
 *  Settings on Same as the system, or Settings choosing another look. */
function useDark(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const check = (): void => setDark(isDark())
    const system = window.matchMedia(SYSTEM_DARK)
    system.addEventListener('change', check)
    const chosen = new MutationObserver(check)
    chosen.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    check()
    return () => {
      system.removeEventListener('change', check)
      chosen.disconnect()
    }
  }, [])
  return dark
}

/** Three dots that bring back what a reply quoted. */
function QuoteToggle(props: { open: boolean; toggle(): void }): ReactNode {
  return (
    <button className="quote-toggle" aria-label={props.open ? 'Hide quoted text' : 'Show quoted text'} title={props.open ? 'Hide quoted text' : 'Show quoted text'}
      aria-expanded={props.open} onClick={props.toggle}>
      <Ellipsis size={16} aria-hidden="true" />
    </button>
  )
}

interface BodyProps {
  html: string
  onPeek(url: string | null): void
  /** Load pictures without being asked. Trackers are gone either way. */
  images?: boolean
  /** Who to trust for good, offered next to "Show images". */
  sender?: string
  trust?(sender: string): void
  /** Whole quotes stay put in a forward, where they're what was sent. */
  keepQuoted?: boolean
  /** In a dark window, mail made for a white page is darkened, unless Settings say not to. */
  darken?: boolean
}

function HtmlBody({ html, onPeek, images: auto, sender, trust, keepQuoted, darken = true }: BodyProps): ReactNode {
  const [images, setImages] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  /** This message shown in its own colours after all, and whether darkening it changed anything. */
  const [original, setOriginal] = useState(false)
  const [darkened, setDarkened] = useState(false)
  /** Pictures asked for that couldn't be fetched, and how often they've been asked for again. */
  const [failed, setFailed] = useState(0)
  const [tries, setTries] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const watcher = useRef<ResizeObserver | null>(null)
  const { clean, removed } = useMemo(() => sanitizeCounting(html), [html])
  const hasRemote = useMemo(() => REMOTE.test(clean), [clean])
  const hasQuote = useMemo(() => !keepQuoted && QUOTED.test(clean), [clean, keepQuoted])
  const dark = useDark()
  const designed = useMemo(() => DESIGNED.test(clean), [clean])
  const showQuoted = quoteOpen || !hasQuote
  const darkening = dark && designed && darken && !original
  const source = frameDocument(clean, images, dark, designed)
  // While it's being darkened the frame stays out of sight, so its white page never flashes up: it's
  // shown once this very page, in these colours, has loaded.
  // Designed mail's page is the same in either look, and darkening changes it once it has loaded, so a
  // look that changes makes the frame again, as Show original colours does.
  const look = `${original}:${dark}:${tries}:${source}`
  const [shown, setShown] = useState('')
  const painted = !darkening || shown === look

  const show = async (): Promise<void> => {
    await window.mail.allowRemoteImages(true)
    setImages(true)
  }
  /** Asked for again, still allowed: the window's allowance is asked for again first. */
  const tryAgain = async (): Promise<void> => {
    await window.mail.allowRemoteImages(true)
    setFailed(0)
    setTries((n) => n + 1)
  }

  useEffect(() => () => watcher.current?.disconnect(), [])
  useEffect(() => {
    if (auto && hasRemote) void show()
  }, [auto, hasRemote])
  useEffect(() => {
    // While the frame's new page is being made it has no root yet; it's given this once it loads.
    frame.current?.contentDocument?.documentElement?.classList.toggle('hide-quoted', !showQuoted)
  }, [showQuoted])

  const loaded = (): void => {
    const el = frame.current
    const doc = el?.contentDocument
    if (!el || !doc) return
    doc.documentElement.classList.toggle('hide-quoted', !showQuoted)
    const fit = (): void => {
      const body = doc.body
      if (!body) return
      let scale = 1
      try {
        scale = fitDocument(doc)
      } catch {
        // Left at its own size: it scrolls sideways, as it did.
      }
      // scrollHeight is as laid out, before the zoom draws it smaller.
      el.style.height = `${Math.ceil(Math.max(body.scrollHeight * scale, body.getBoundingClientRect().height))}px`
    }
    // A picture that couldn't be fetched is a plain block of its size, as before it was asked for,
    // not a broken icon with its alt text spilling over what's round it. It's counted, and said.
    let broken = 0
    if (images) {
      for (const img of Array.from(doc.images)) {
        if (!/^(?:https?:)?\/\//i.test(img.getAttribute('src') ?? '')) continue
        const fail = (): void => {
          img.classList.add(FAILED)
          fit()
        }
        if (img.complete && img.naturalWidth === 0) {
          fail()
          broken++
        } else {
          img.addEventListener('error', () => { fail(); setFailed((n) => n + 1) }, { once: true })
        }
      }
    }
    setFailed(broken)
    fit()
    try {
      if (darkening) setDarkened(darkenDocument(doc))
    } catch {
      // Left in its own colours: it's still shown.
    }
    setShown(look)
    watcher.current?.disconnect()
    // The frame narrowing or widening fits the message again, and so does its own height changing.
    watcher.current = new ResizeObserver(fit)
    watcher.current.observe(doc.body)
    watcher.current.observe(el)
    const linkAt = (target: EventTarget | null): HTMLAnchorElement | null =>
      (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    doc.addEventListener('click', (event) => {
      const link = linkAt(event.target)
      event.preventDefault()
      if (link) void window.mail.openLink(link.href)
    })
    // A click inside moves the keyboard into the frame, and its keys still belong to the app.
    doc.addEventListener('keydown', (event) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey }))
    })
    doc.addEventListener('mouseover', (event) => onPeek(linkAt(event.target)?.href ?? null))
    doc.addEventListener('mouseleave', () => onPeek(null))
  }

  const recolouring = dark && designed && darken && (original || darkened)
  return (
    <>
      {(removed > 0 || (hasRemote && !images) || failed > 0 || recolouring) && (
        <div className="body-notes">
          {hasRemote && !images && (
            <>
              <ImageOff size={14} aria-hidden="true" />
              <button className="link" onClick={() => void show()}>Show images</button>
              {sender && trust && <button className="link" onClick={() => trust(sender)}>Always from this sender</button>}
            </>
          )}
          {failed > 0 && (
            <>
              <ImageOff size={14} aria-hidden="true" />
              <span className="muted">{failed === 1 ? "1 picture couldn't load" : `${failed} pictures couldn't load`}</span>
              <button className="link" onClick={() => void tryAgain()}>Try again</button>
            </>
          )}
          {removed > 0 && (
            <span className="muted trackers">
              <ShieldCheck size={14} aria-hidden="true" /> {removed === 1 ? '1 tracker removed' : `${removed} trackers removed`}
            </span>
          )}
          {recolouring && (
            <span className="recolour">
              <Palette size={14} aria-hidden="true" />
              <button className="link" onClick={() => setOriginal(!original)}>{original ? 'Darken colours' : 'Show original colours'}</button>
            </span>
          )}
        </div>
      )}
      <iframe
        key={`${original ? 'original' : 'own'}-${dark ? 'dark' : 'light'}-${tries}`}
        ref={frame}
        title="Message"
        className={painted ? 'body-frame' : 'body-frame painting'}
        sandbox="allow-same-origin"
        srcDoc={source}
        onLoad={loaded}
      />
      {hasQuote && <QuoteToggle open={quoteOpen} toggle={() => setQuoteOpen(!quoteOpen)} />}
    </>
  )
}

const LINK = /(https?:\/\/[^\s<>"']+)/g

function Linked({ text }: { text: string }): ReactNode {
  const parts = text.split(LINK)
  return parts.map((part, i) => {
    if (i % 2 === 0) return part
    let end = part.length
    while (end > 0 && '.,;:!?)]'.includes(part[end - 1] ?? '')) end--
    const url = part.slice(0, end)
    return [
      <a key={i} href={url} onClick={(e) => { e.preventDefault(); void window.mail.openLink(url) }}>
        {url}
      </a>,
      part.slice(url.length)
    ]
  })
}

function TextBody({ text, keepQuoted }: { text: string; keepQuoted?: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const { fresh, quoted } = useMemo(() => (keepQuoted ? { fresh: text, quoted: '' } : splitQuoted(text)), [text, keepQuoted])
  return (
    <>
      <div className="body-text"><Linked text={fresh} /></div>
      {quoted && <QuoteToggle open={open} toggle={() => setOpen(!open)} />}
      {quoted && open && <div className="body-text quoted"><Linked text={quoted} /></div>}
    </>
  )
}

export function MailBody(props: Omit<BodyProps, 'html'> & { text: string; html: string | null }): ReactNode {
  const { text, html, ...rest } = props
  if (html) return <HtmlBody html={html} {...rest} />
  return <TextBody text={text} keepQuoted={props.keepQuoted} />
}
