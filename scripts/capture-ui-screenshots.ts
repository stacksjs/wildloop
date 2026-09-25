#!/usr/bin/env bun
/**
 * Capture Wildloop UI screenshots via Bun.WebView for design review.
 * Usage: bun scripts/capture-ui-screenshots.ts [baseUrl]
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const base = (process.argv[2] ?? process.env.APP_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const outDir = join(import.meta.dir, '../storage/screenshots/ui-review')
const viewport = { width: 1440, height: 900 }

const routes = [
  { name: 'home', path: '/' },
  { name: 'trails', path: '/trails' },
  { name: 'feed', path: '/feed' },
  { name: 'record', path: '/record' },
  { name: 'territories', path: '/territories' },
  { name: 'leaderboard', path: '/leaderboard' },
]

if (typeof Bun.WebView === 'undefined') {
  console.error('Bun.WebView is not available in this Bun build. Upgrade Bun to >= 1.3.12.')
  process.exit(1)
}

await mkdir(outDir, { recursive: true })

async function waitForHydration(view: InstanceType<typeof Bun.WebView>, path: string) {
  await view.evaluate(`
    new Promise((resolve) => {
      const deadline = Date.now() + 10000;
      function check() {
        const mapReady = !document.querySelector('.ts-map-container')
          || !!document.querySelector('.tsmap-container');
        const trailsReady = ${path.includes('trails')}
          ? document.querySelectorAll('a[href*="/trail/"]').length > 0
          : true;
        if ((mapReady && trailsReady) || Date.now() > deadline) {
          setTimeout(resolve, 400);
        } else {
          requestAnimationFrame(check);
        }
      }
      if (document.readyState === 'complete') check();
      else window.addEventListener('load', check);
    })
  `)
}

for (const route of routes) {
  const url = `${base}${route.path}`
  console.log(`Capturing ${url}…`)
  await using view = new Bun.WebView({ ...viewport, headless: true })
  await view.navigate(url)
  await waitForHydration(view, route.path)
  if (route.scroll) {
    await view.evaluate(`window.scrollTo(0, ${route.scroll})`)
    await view.evaluate('new Promise(r => setTimeout(r, 500))')
  }
  const file = join(outDir, `${route.name}.png`)
  await Bun.write(file, await view.screenshot({ format: 'png', encoding: 'buffer' }))
  console.log(`  → ${file}`)
}

console.log(`Done. Screenshots in ${outDir}`)
