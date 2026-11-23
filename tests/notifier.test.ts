import { describe, expect, it, vi } from 'vitest'
import { hasActions, noticeArgs, Notices, type NoticeDeps, type Runner } from '../src/main/notifier'

const CAPABILITIES = "(['actions', 'body', 'body-markup', 'icon-static', 'persistence'],)\n"
const ref = { account: 'me@example.com', thread: 't1' }
const preview = { ...ref, from: 'Mai Tran', subject: 'Venue moved to the Harbour Room' }

/** A runner that runs nothing: it notes what would have been run, and answers as told. Never the
 *  real gdbus or notify-send, which would show a notice on the desktop running the tests. */
function fakeRunner(answer: (file: string, args: string[]) => Promise<string> = async () => CAPABILITIES) {
  const ran: [string, string[]][] = []
  const started: { file: string; args: string[]; say(output: string): void; fail(): void; stopped: boolean }[] = []
  const runner: Runner = {
    run: (file, args) => {
      ran.push([file, args])
      return answer(file, args)
    },
    start: (file, args) => {
      let say: (output: string) => void = () => undefined
      let fail: () => void = () => undefined
      const ended = new Promise<string>((resolve, reject) => {
        say = resolve
        fail = () => reject(new Error('spawn notify-send ENOENT'))
      })
      const one = { file, args, say: (output: string) => say(output), fail: () => fail(), stopped: false }
      started.push(one)
      return { ended, stop: () => { one.stopped = true; fail() } }
    }
  }
  return { runner, ran, started }
}

function notices(runner: Runner, extra: Partial<NoticeDeps> = {}) {
  const deps = {
    runner,
    platform: 'linux',
    icon: '/opt/xrnmail/resources/app.asar.unpacked/resources/icon.png',
    chime: '/opt/xrnmail/resources/app.asar.unpacked/resources/new-mail.wav',
    sound: () => false,
    plain: vi.fn<NoticeDeps['plain']>(),
    plainSummary: vi.fn<NoticeDeps['plainSummary']>(),
    act: vi.fn<NoticeDeps['act']>(),
    open: vi.fn<NoticeDeps['open']>(),
    openSummary: vi.fn<NoticeDeps['openSummary']>()
  }
  return { deps, notices: new Notices({ ...deps, ...extra }) }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a notice for one new message, on Linux', () => {
  it('asks the server whether it shows actions, then shows Open, Archive and Mark read through notify-send', async () => {
    const { runner, ran, started } = fakeRunner()
    const { deps, notices: shown } = notices(runner)
    shown.landed(1, preview)
    await settle()
    expect(ran).toEqual([['gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.GetCapabilities']]])
    expect(started.map((s) => [s.file, s.args])).toEqual([['notify-send', [
      '--app-name=xrnmail', `--icon=${deps.icon}`, '--category=email.arrived', '--hint=string:desktop-entry:xrnmail',
      '--action=default=Open', '--action=archive=Archive', '--action=read=Mark read', '--', 'Mai Tran', 'Venue moved to the Harbour Room'
    ]]])
    expect(deps.plain).not.toHaveBeenCalled()
  })

  it('archives, marks read or opens the thread, as the button pressed says, and does nothing when dismissed', async () => {
    const { runner, started } = fakeRunner()
    const { deps, notices: shown } = notices(runner)
    for (let i = 0; i < 4; i++) shown.landed(1, { ...preview, thread: `t${i}` })
    await settle()
    started[0]?.say('archive\n')
    started[1]?.say('read\n')
    started[2]?.say('default\n')
    started[3]?.say('') // closed, or gone by itself
    await settle()
    expect(deps.act.mock.calls).toEqual([[{ account: ref.account, thread: 't0' }, 'archive'], [{ account: ref.account, thread: 't1' }, 'read']])
    expect(deps.open.mock.calls).toEqual([[{ account: ref.account, thread: 't2' }]])
  })

  // A subject is a stranger's words: a notification server may read markup in the body, and a word
  // starting with a dash would otherwise be taken for one of notify-send's own switches.
  it('passes the subject as words, never as markup or a switch', () => {
    const args = noticeArgs({ ...preview, from: '--action=x=Pwn', subject: '<a href="https://claim.example/">-u critical & win</a>' }, '/icon.png')
    expect(args.slice(-3)).toEqual(['--', '--action=x=Pwn', '&lt;a href="https://claim.example/"&gt;-u critical &amp; win&lt;/a&gt;'])
    expect(noticeArgs({ ...preview, from: '', subject: '' }, '/icon.png').slice(-2)).toEqual(['xrnmail', 'No subject'])
  })

  it("keeps Electron's plain notice where the server shows no actions, or can't be asked", async () => {
    for (const answer of [async () => "(['body', 'body-markup'],)", async () => { throw new Error('spawn gdbus ENOENT') }]) {
      const { runner, started } = fakeRunner(answer)
      const { deps, notices: shown } = notices(runner)
      shown.landed(1, preview)
      await settle()
      expect(started).toEqual([])
      expect(deps.plain).toHaveBeenCalledTimes(1)
      deps.plain.mock.calls[0]?.[2]() // its click still opens the thread
      expect(deps.open).toHaveBeenCalledWith(ref)
    }
  })

  it('falls back to the plain notice when notify-send fails at once, and asks the server again next time', async () => {
    const { runner, ran, started } = fakeRunner()
    const { deps, notices: shown } = notices(runner)
    shown.landed(1, preview)
    await settle()
    started[0]?.fail()
    await settle()
    expect(deps.plain).toHaveBeenCalledTimes(1)
    shown.landed(1, preview)
    await settle()
    expect(ran).toHaveLength(2)
  })

  it('asks the server once in ten minutes', async () => {
    let now = 1_000_000
    const { runner, ran } = fakeRunner()
    const { notices: shown } = notices(runner, { now: () => now })
    shown.landed(1, preview)
    await settle()
    now += 9 * 60_000
    shown.landed(1, preview)
    await settle()
    expect(ran).toHaveLength(1)
    now += 2 * 60_000
    shown.landed(1, preview)
    await settle()
    expect(ran).toHaveLength(2)
  })

  // A server that keeps notices until they're dismissed would keep one waiting notify-send for each.
  it('keeps six at most waiting on a button, and none once the app quits', async () => {
    const { runner, started } = fakeRunner()
    const { deps, notices: shown } = notices(runner)
    for (let i = 0; i < 8; i++) shown.landed(1, preview)
    await settle()
    expect(started.map((s) => s.stopped)).toEqual([true, true, false, false, false, false, false, false])
    shown.stop()
    expect(started.every((s) => s.stopped)).toBe(true)
    await settle()
    expect(deps.plain).not.toHaveBeenCalled() // stopping isn't failing
  })
})

describe('notices with no buttons', () => {
  it('are plain for several messages at once, a Summary, and anywhere but Linux', async () => {
    const { runner, ran, started } = fakeRunner()
    const { deps, notices: shown } = notices(runner)
    shown.landed(3)
    shown.summarized(4, ['Weekly Digest'])
    await settle()
    expect([ran, started]).toEqual([[], []])
    expect(deps.plain.mock.calls[0]?.slice(0, 2)).toEqual([3, undefined])
    deps.plainSummary.mock.calls[0]?.[2]()
    expect(deps.openSummary).toHaveBeenCalled()
    const elsewhere = notices(fakeRunner().runner, { platform: 'darwin' })
    elsewhere.notices.landed(1, preview)
    expect(elsewhere.deps.plain).toHaveBeenCalledTimes(1)
  })

  it('reads the server\'s capabilities as gdbus prints them', () => {
    expect(hasActions(CAPABILITIES)).toBe(true)
    expect(hasActions("(['body', 'body-hyperlinks'],)")).toBe(false)
    expect(hasActions("(['action-icons'],)")).toBe(false)
  })
})

describe('the sound', () => {
  const players = (ran: [string, string[]][]): [string, string[]][] => ran.filter(([file]) => file !== 'gdbus')

  it('is off unless Settings turn it on', async () => {
    const { runner, ran } = fakeRunner()
    const { notices: shown } = notices(runner)
    shown.landed(1, preview)
    shown.landed(5)
    shown.summarized(2, ['Weekly Digest'])
    await settle()
    expect(players(ran)).toEqual([])
  })

  it('plays once for each notice, through PipeWire, or PulseAudio where that fails', async () => {
    const { runner, ran } = fakeRunner(async (file) => {
      if (file === 'pw-play') throw new Error('spawn pw-play ENOENT')
      return CAPABILITIES
    })
    const { deps, notices: shown } = notices(runner, { sound: () => true })
    shown.landed(1, preview)
    shown.landed(5)
    shown.summarized(2, ['Weekly Digest'])
    await settle()
    const chime = [deps.icon.replace('icon.png', 'new-mail.wav')]
    expect(players(ran)).toEqual([['pw-play', chime], ['pw-play', chime], ['pw-play', chime], ['paplay', chime], ['paplay', chime], ['paplay', chime]])
  })

  it('is new-mail.wav: a short mono WAV made here', async () => {
    const { readFileSync } = await import('node:fs')
    const wav = readFileSync(new URL('../resources/new-mail.wav', import.meta.url))
    expect([wav.toString('ascii', 0, 4), wav.toString('ascii', 8, 12), wav.readUInt16LE(20), wav.readUInt16LE(22)]).toEqual(['RIFF', 'WAVE', 1, 1])
    const seconds = wav.readUInt32LE(40) / wav.readUInt32LE(28)
    expect(seconds).toBeLessThan(1)
    expect(wav.length).toBeLessThan(64 * 1024)
  })
})
