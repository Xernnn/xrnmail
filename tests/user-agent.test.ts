import { describe, expect, it } from 'vitest'
import { genericUserAgent } from '@main/safe-url'

// Electron's own user agent names the app and its version ("xrnmail/1.0.0 … Electron/44.11.5"), and
// a picture shown in a message went out with it: nobody else in the world sends that, so every
// picture host, trackers not on the list among them, could tell this one person had opened it.
describe("the user agent a message's pictures are fetched with", () => {
  it("is Chrome's own on Linux, naming neither the app nor Electron, nor more of the version than Chrome does", () => {
    const agent = genericUserAgent('152.0.7977.169')
    expect(agent).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')
    expect(agent).not.toMatch(/xrnmail|electron/i)
  })
})
