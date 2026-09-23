import { defineConfig } from '@playwright/test'

export default defineConfig({
  testMatch: '*.pw.ts',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { headless: true, trace: 'retain-on-failure', viewport: { width: 390, height: 844 } },
  webServer: [{
    command: 'bun scripts/test-recording-browser.ts',
    cwd: '../..',
    url: 'http://127.0.0.1:4319',
    reuseExistingServer: false,
  }, {
    command: 'bun scripts/start-recording-qa.ts',
    cwd: '../..',
    url: 'http://127.0.0.1:4321/api/health',
    reuseExistingServer: process.env.RECORDING_QA_REUSE === '1',
    timeout: 180_000,
  }, {
    command: 'bun scripts/test-recording-app.ts',
    cwd: '../..',
    url: 'http://127.0.0.1:4322',
    reuseExistingServer: process.env.RECORDING_QA_REUSE === '1',
    timeout: 180_000,
  }],
})
