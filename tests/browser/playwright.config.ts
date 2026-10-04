import { defineConfig } from '@playwright/test'
import { QA_PORTS } from './qa-ports'

export default defineConfig({
  testMatch: '*.pw.ts',
  workers: 1,
  // One retry, so a test that fails and then passes is reported as flaky
  // rather than failing the run. Across five full runs a different test failed
  // each time and passed on its own afterwards, which hid two real bugs in the
  // noise; a flaky label names the one-offs while a repeatable failure still
  // fails. Traces are kept from the failed attempt, which is what there was to
  // diagnose from.
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { headless: true, trace: 'retain-on-failure', viewport: { width: 390, height: 844 } },
  webServer: [{
    command: 'bun scripts/test-recording-browser.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${QA_PORTS.recorder}`,
    reuseExistingServer: false,
  }, {
    command: 'bun scripts/start-recording-qa.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${QA_PORTS.api}/api/health`,
    reuseExistingServer: process.env.RECORDING_QA_REUSE === '1',
    timeout: 180_000,
  }, {
    command: 'bun scripts/test-recording-app.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${QA_PORTS.proxy}`,
    reuseExistingServer: process.env.RECORDING_QA_REUSE === '1',
    timeout: 180_000,
  }],
})
