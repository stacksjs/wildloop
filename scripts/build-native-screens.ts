#!/usr/bin/env bun
import { join } from 'node:path'
import { runNativeCompile } from '@stacksjs/stx/native'

const resources = join(import.meta.dir, '..', 'resources')
const output = '../storage/framework/native/native-screen.js'
const result = await runNativeCompile(undefined, {
  cwd: resources,
  format: 'bundle',
  output,
  minify: !process.argv.includes('--debug'),
})

for (const diagnostic of result.diagnostics)
  console.warn(`[native] ${diagnostic.message}`)

console.log(`Native screens: ${result.written}`)
