import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

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

export const sanitize = (html: string): string => DOMPurify.sanitize(html, SANITIZE)

const REMOTE = /(?:src|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i

function frameDocument(clean: string, images: boolean): string {
  const remote = images ? ' http: https:' : ''
  const policy = `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'; font-src data:`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{overflow-x:auto;overflow-y:hidden}body{margin:0;padding:14px 16px;background:#fff;color:#1b1b1e;font:14px/1.5 system-ui,sans-serif;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${clean}</body></html>`
}

function HtmlBody({ html, onPeek }: { html: string; onPeek(url: string | null): void }): ReactNode {
  const [images, setImages] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const watcher = useRef<ResizeObserver | null>(null)
  const clean = useMemo(() => sanitize(html), [html])
  const hasRemote = useMemo(() => REMOTE.test(clean), [clean])

  useEffect(() => () => watcher.current?.disconnect(), [])

  const loaded = (): void => {
    const el = frame.current
    const doc = el?.contentDocument
    if (!el || !doc) return
    const fit = (): void => {
      el.style.height = `${doc.documentElement.scrollHeight}px`
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
    doc.addEventListener('mouseover', (event) => onPeek(linkAt(event.target)?.href ?? null))
    doc.addEventListener('mouseleave', () => onPeek(null))
  }

  const show = async (): Promise<void> => {
    await window.mail.allowRemoteImages(true)
    setImages(true)
  }

  return (
    <>
      {hasRemote && !images && (
        <button className="quiet images" onClick={() => void show()}>
          Show images
        </button>
      )}
      <iframe
        ref={frame}
        title="Message"
        className="body-frame"
        sandbox="allow-same-origin"
        srcDoc={frameDocument(clean, images)}
        onLoad={loaded}
      />
    </>
  )
}

const LINK = /(https?:\/\/[^\s<>"']+)/g

function TextBody({ text }: { text: string }): ReactNode {
  const parts = text.split(LINK)
  return (
    <div className="body-text">
      {parts.map((part, i) => {
        if (i % 2 === 0) return part
        const url = part.replace(/[.,;:!?)\]]+$/, '')
        return [
          <a key={i} href={url} onClick={(e) => { e.preventDefault(); void window.mail.openLink(url) }}>
            {url}
          </a>,
          part.slice(url.length)
        ]
      })}
    </div>
  )
}

export function MailBody(props: { text: string; html: string | null; onPeek(url: string | null): void }): ReactNode {
  if (props.html) return <HtmlBody html={props.html} onPeek={props.onPeek} />
  return <TextBody text={props.text} />
}
