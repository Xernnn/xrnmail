import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@main': resolve('src/main'), '@shared': resolve('src/shared') } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 }
})
