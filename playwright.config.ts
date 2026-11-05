import { defineConfig } from '@playwright/test'

/** Drives the built app against a fake Gmail (`npm run test:e2e` builds first). */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']]
})
