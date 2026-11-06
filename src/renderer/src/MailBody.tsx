import DOMPurify from 'dompurify'
import { Ellipsis, ImageOff, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { splitQuoted } from '@shared/quoted'

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

/** Mail services that report back when a message is opened. */
const TRACKER = /\b(list-manage\.com\/track|sendgrid\.net\/wf\/open|mandrillapp\.com\/track|mailtrack\.io|hubspotemail\.net|sparkpostmail\.com\/q|track\.customer\.io|mailgun\.org\/o|mixmax\.com\/api\/track|bananatag\.com|superhuman\.com\/[^"']{0,200}pixel|yesware\.com\/trk|cirrusinsight\.com\/[^"']{0,200}track)/i

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

/** A picture that hasn't been allowed shows as a plain block of its own size, not a broken icon. */
const UNLOADED = `html.no-images img[src^="http"],html.no-images img[src^="//"]{content:url("${BLANK}");background:#ece9e4;border-radius:4px}`

function frameDocument(clean: string, images: boolean, dark: boolean): string {
  const remote = images ? ' http: https:' : ''
  const policy = `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'; font-src data:`
  const blends = dark && !DESIGNED.test(clean)
  const look = blends ? 'html{color-scheme:dark}body{background:transparent;color:#e9e7e4}a{color:#d2a679}' : 'body{background:#fff;color:#1c1b1a}'
  return `<!doctype html><html class="${images ? '' : 'no-images'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{overflow-x:auto;overflow-y:hidden}body{margin:0;padding:${blends ? '0 2px' : '14px 16px'};font:14px/1.55 "Noto Sans","Segoe UI",Roboto,"Helvetica Neue",Arial,"Liberation Sans",sans-serif;word-break:break-word}img{max-width:100%;height:auto}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:2px solid #d8d5d0}${look}${UNLOADED}${HIDE_QUOTED}</style></head><body>${clean}</body></html>`
}

const isDark = (): boolean => {
  const theme = document.documentElement.dataset['theme']
  return theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
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
}

function HtmlBody({ html, onPeek, images: auto, sender, trust, keepQuoted }: BodyProps): ReactNode {
  const [images, setImages] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const watcher = useRef<ResizeObserver | null>(null)
  const { clean, removed } = useMemo(() => sanitizeCounting(html), [html])
  const hasRemote = useMemo(() => REMOTE.test(clean), [clean])
  const hasQuote = useMemo(() => !keepQuoted && QUOTED.test(clean), [clean, keepQuoted])
  const dark = useMemo(isDark, [clean])
  const showQuoted = quoteOpen || !hasQuote

  const show = async (): Promise<void> => {
    await window.mail.allowRemoteImages(true)
    setImages(true)
  }

  useEffect(() => () => watcher.current?.disconnect(), [])
  useEffect(() => {
    if (auto && hasRemote) void show()
  }, [auto, hasRemote])
  useEffect(() => {
    frame.current?.contentDocument?.documentElement.classList.toggle('hide-quoted', !showQuoted)
  }, [showQuoted])

  const loaded = (): void => {
    const el = frame.current
    const doc = el?.contentDocument
    if (!el || !doc) return
    doc.documentElement.classList.toggle('hide-quoted', !showQuoted)
    const fit = (): void => {
      const body = doc.body
      el.style.height = `${Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height))}px`
    }
    fit()
    watcher.current?.disconnect()
    watcher.current = new ResizeObserver(fit)
    watcher.current.observe(doc.body)
    const linkAt = (target: EventTarget | null): HTMLAnchorElement | null =>
      (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    doc.addEventListener('click', (event) => {
      const link = linkAt(event.target)
      event.preventDefault()
      if (link) void window.mail.openLink(link.href)
    })
    // A click inside moves the keyboard into the frame, and its keys still belong to the app.
    doc.addEventListener('keydown', (event) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey }))
    })
    doc.addEventListener('mouseover', (event) => onPeek(linkAt(event.target)?.href ?? null))
    doc.addEventListener('mouseleave', () => onPeek(null))
  }

  return (
    <>
      {(removed > 0 || (hasRemote && !images)) && (
        <div className="body-notes">
          {hasRemote && !images && (
            <>
              <ImageOff size={14} aria-hidden="true" />
              <button className="link" onClick={() => void show()}>Show images</button>
              {sender && trust && <button className="link" onClick={() => trust(sender)}>Always from this sender</button>}
            </>
          )}
          {removed > 0 && (
            <span className="muted trackers">
              <ShieldCheck size={14} aria-hidden="true" /> {removed === 1 ? '1 tracker removed' : `${removed} trackers removed`}
            </span>
          )}
        </div>
      )}
      <iframe
        ref={frame}
        title="Message"
        className="body-frame"
        sandbox="allow-same-origin"
        srcDoc={frameDocument(clean, images, dark)}
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
