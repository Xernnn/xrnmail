import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The real xrnmail-sync (server/xrnmail-sync.py) on a port of its own, with a throwaway users file
 *  and device logins, for the laptop's share to be tried against. Needs python3 with bcrypt, as the
 *  server's own tests do. */

export const USER = 'alex'
export const PASSWORD = 'correct horse battery staple'

/** A device login for this service, and one made for another service only. */
export const TOKEN = `xrndev_1a2b3c4d_${'A'.repeat(43)}`
export const OTHER_TOKEN = `xrndev_5e6f7a8b_${'B'.repeat(43)}`

export interface SyncServer {
  url: string
  /** Gives [USER] a new password, as changing it on the server does. */
  setPassword(password: string): void
  stop(): Promise<void>
}

const SERVER = resolve(__dirname, '../server/xrnmail-sync.py')

function bcryptHash(password: string): string {
  return execFileSync('python3', ['-c', 'import bcrypt, sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(4)).decode())', password]).toString().trim()
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise((done) => server.close(done))
  return port
}

export async function startSyncServer(): Promise<SyncServer> {
  const dir = mkdtempSync(join(tmpdir(), 'xrnmail-sync-test-'))
  const users = join(dir, 'users')
  const setPassword = (password: string): void => writeFileSync(users, `${USER}:${bcryptHash(password)}\n`, { mode: 0o600 })
  setPassword(PASSWORD)
  const secretOf = (token: string): string => token.split('_')[2] ?? ''
  const entry = (token: string, services: string[], device: string): Record<string, unknown> => ({
    id: token.split('_')[1], user: USER, device, services, sha256: createHash('sha256').update(secretOf(token)).digest('hex'), created: 1764115200
  })
  writeFileSync(join(dir, 'device-tokens.json'), JSON.stringify({ tokens: [entry(TOKEN, ['xrnmail'], 'laptop'), entry(OTHER_TOKEN, ['xrnloops'], 'phone')] }), { mode: 0o600 })
  const port = await freePort()
  const child = spawn('python3', [SERVER, '--port', String(port), '--data', join(dir, 'data'), '--users', users], { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  child.stderr.on('data', (chunk: Buffer) => void (log += chunk.toString()))
  const url = `http://127.0.0.1:${port}/xrnmail`
  const end = Date.now() + 15_000
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() > end || child.exitCode !== null) throw new Error(`xrnmail-sync didn't start: ${log}`)
    await new Promise((done) => setTimeout(done, 50))
  }
  return {
    url,
    setPassword,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise((done) => child.once('exit', done))
        child.kill()
        await gone
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
