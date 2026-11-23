// Writes resources/new-mail.wav, the sound new mail can make (Settings, Notifications, Sound): two
// soft bell notes a fourth apart, G5 then C6, made here from sine waves so no one else's recording
// is in the app. Run it again only to change the sound: node scripts/make-chime.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 22_050
const LENGTH = 0.8 // seconds
const PEAK = 0.4 // of full scale, so it's heard without startling

/** [start, hertz, seconds]: the second note comes in while the first fades. */
const NOTES = [[0, 783.99, 0.5], [0.14, 1046.5, 0.66]]

const samples = new Float64Array(Math.round(RATE * LENGTH))
for (const [start, hertz, seconds] of NOTES) {
  const from = Math.round(start * RATE)
  for (let i = 0; i < Math.round(seconds * RATE) && from + i < samples.length; i++) {
    const t = i / RATE
    const attack = Math.min(1, t / 0.006)
    const decay = Math.exp(-t / 0.17)
    const tone = Math.sin(2 * Math.PI * hertz * t) + 0.22 * Math.sin(4 * Math.PI * hertz * t) + 0.06 * Math.sin(6 * Math.PI * hertz * t)
    samples[from + i] += attack * decay * tone
  }
}
const fade = Math.round(0.04 * RATE)
for (let i = 0; i < fade; i++) samples[samples.length - 1 - i] *= i / fade
const loudest = samples.reduce((most, value) => Math.max(most, Math.abs(value)), 0)

const data = Buffer.alloc(samples.length * 2)
samples.forEach((value, i) => data.writeInt16LE(Math.round((value / loudest) * PEAK * 32_767), i * 2))
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16) // the size of this part
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // one channel
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28) // bytes a second
header.writeUInt16LE(2, 32) // bytes a sample
header.writeUInt16LE(16, 34) // bits a sample
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'new-mail.wav')
writeFileSync(out, Buffer.concat([header, data]))
console.log(`Wrote ${out}`)
