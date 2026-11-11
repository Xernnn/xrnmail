import { afterEach, describe, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => [] as { title: string; body: string }[])

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    constructor(private options: { title: string; body: string }) {}
    on(): void {}
    show(): void {
      shown.push(this.options)
    }
  }
}))

const { notify } = await import('@main/desktop')

const platform = process.platform
const on = (name: string): void => void Object.defineProperty(process, 'platform', { value: name })

afterEach(() => {
  on(platform)
  shown.length = 0
})

describe('a notification', () => {
  const subject = '<b>You won</b> & <a href="https://claim.example/">claim it</a>'

  // A Linux notification server may read the body as markup, and some (mako, Quickshell's) do, links
  // and all, so a subject could style itself or turn into a link in the notice.
  it('shows the subject as the words it is, on Linux', () => {
    on('linux')
    notify(1, { from: 'Ada <ada@example.com>', subject }, () => undefined)
    expect(shown).toEqual([{ title: 'Ada <ada@example.com>', body: '&lt;b&gt;You won&lt;/b&gt; &amp; &lt;a href="https://claim.example/"&gt;claim it&lt;/a&gt;', icon: expect.any(String) }])
  })

  it('leaves it as it is where a body is never markup', () => {
    on('darwin')
    notify(1, { from: 'Ada', subject }, () => undefined)
    expect(shown[0]?.body).toBe(subject)
  })
})
