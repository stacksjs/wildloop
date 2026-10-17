#!/usr/bin/env bun
import { buildApp } from '@stacksjs/stx'
import { generateMobileAssociations } from './scripts/generate-mobile-associations'

// Device builds opt out (run-ios-device.ts): signing with another team must
// not rewrite the tracked association file that wildloop.org serves.
if (process.env.SKIP_MOBILE_ASSOCIATIONS !== '1') {
  // eslint-disable-next-line ts/no-top-level-await
  await generateMobileAssociations()
}
// Web QA builds a fresh document instead of reusing an earlier static page.
// eslint-disable-next-line ts/no-top-level-await
await buildApp(process.env.MOBILE_E2E ? { ssg: { cache: false } } : {})
