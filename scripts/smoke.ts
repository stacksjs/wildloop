#!/usr/bin/env bun
/**
 * Post-deploy smoke check: does the site the deploy just activated work?
 *
 * `buddy deploy` exiting 0 says a release was uploaded and the services were
 * asked to restart. It does not say the site answers, that the API behind its
 * same-origin proxy came back, or that the release carries the code that was
 * merged — a process can restart against the previous release's env and still
 * report success. This asks the running site instead, from outside, and fails
 * the deploy run when the answer is wrong.
 *
 * Run against production:   bun scripts/smoke.ts
 * Or anywhere else:         bun scripts/smoke.ts http://localhost:3000
 *
 * Checks are ordered cheapest-first and share a context, so the reviewer check
 * can ask about trail ids the catalog check actually returned rather than ids
 * that may not exist in whatever database is behind the URL.
 */
/* eslint-disable ts/no-top-level-await */
import process from 'node:process'

export interface SmokeResponse {
  status: number
  contentType: string
  body: string
}

export interface SmokeContext {
  /** Trail ids seen in the catalog, for the checks that need real ones. */
  trailIds: number[]
}

export interface SmokeCheck {
  name: string
  /** Built from the context, so a later check can follow an earlier answer. */
  path: (context: SmokeContext) => string
  /** Returns the reason it failed, or null when it passed. */
  verify: (response: SmokeResponse, context: SmokeContext) => string | null
}

/** JSON body, or null when it is not JSON at all. */
export function readJson(response: SmokeResponse): any | null {
  try {
    return JSON.parse(response.body)
  }
  catch {
    return null
  }
}

export function expectStatus(response: SmokeResponse, status = 200): string | null {
  return response.status === status ? null : `expected HTTP ${status}, got ${response.status}`
}

export function expectHtmlContaining(response: SmokeResponse, needles: string[]): string | null {
  const bad = expectStatus(response)
  if (bad)
    return bad
  if (!response.contentType.includes('text/html'))
    return `expected HTML, got ${response.contentType || 'no content type'}`

  const missing = needles.filter(needle => !response.body.includes(needle))
  return missing.length === 0 ? null : `page is missing ${missing.map(m => JSON.stringify(m)).join(', ')}`
}

/**
 * The shape `GET /api/trails/reviewers` promises.
 *
 * Checked rather than assumed because this is the endpoint most likely to be
 * missing from a release: it is a new route, and a route that did not register
 * answers the SPA shell with HTTP 200 rather than a 404 — which is exactly the
 * failure a status-only check would wave through.
 */
export function verifyReviewersPayload(response: SmokeResponse): string | null {
  const bad = expectStatus(response)
  if (bad)
    return bad
  if (!response.contentType.includes('application/json'))
    return `expected JSON, got ${response.contentType || 'no content type'} — the route may not be registered`

  const payload = readJson(response)
  if (!payload?.success)
    return `answered ${JSON.stringify(payload).slice(0, 120)}`
  if (typeof payload.trails !== 'object' || payload.trails === null)
    return 'no `trails` object in the payload'
  if (!(Number(payload.windowDays) > 0))
    return `windowDays is ${payload.windowDays}`

  // Every summary it does carry has to be usable: a count and a list. An empty
  // object is a legitimate answer (nobody reviewed anything this month).
  for (const [id, summary] of Object.entries(payload.trails as Record<string, any>)) {
    if (!Number.isFinite(Number(id)))
      return `keyed by ${id}, which is not a trail id`
    if (!Number.isFinite(Number(summary?.recentCount)))
      return `trail ${id} has no recentCount`
    if (!Array.isArray(summary?.reviewers))
      return `trail ${id} has no reviewers array`
  }

  return null
}

export const SMOKE_CHECKS: SmokeCheck[] = [
  {
    name: 'home page',
    path: () => '/',
    verify: response => expectHtmlContaining(response, ['>Wildloop<']),
  },
  {
    name: 'trail catalog API',
    path: () => '/api/trails?limit=3&sort=featured',
    verify: (response, context) => {
      const bad = expectStatus(response)
      if (bad)
        return bad
      const payload = readJson(response)
      if (!payload?.success)
        return `answered ${JSON.stringify(payload).slice(0, 120)}`
      if (!Array.isArray(payload.trails) || payload.trails.length === 0)
        return 'the catalog returned no trails'

      // Remembered for the checks below, so they ask about rows this database
      // actually holds.
      context.trailIds = payload.trails.map((trail: any) => Number(trail.id)).filter(Number.isFinite)
      return null
    },
  },
  {
    name: 'catalog coverage',
    path: () => '/api/trails/stats',
    verify: (response) => {
      const bad = expectStatus(response)
      if (bad)
        return bad
      const payload = readJson(response)
      if (!payload?.success)
        return `answered ${JSON.stringify(payload).slice(0, 120)}`
      return Number(payload.total) > 0 ? null : 'the catalog reports no trails at all'
    },
  },
  {
    name: 'recent reviewers API',
    path: context => `/api/trails/reviewers?ids=${context.trailIds.slice(0, 5).join(',')}`,
    verify: verifyReviewersPayload,
  },
  {
    // The filter bar is rendered by the page, so its absence means the release
    // is serving an older build of the views than the commit that deployed.
    name: 'trails page, with its filter bar',
    path: () => '/trails',
    verify: response => expectHtmlContaining(response, ['All filters', 'Elevation gain', 'Route type']),
  },
  {
    name: 'trail page shell',
    path: context => `/trail/${context.trailIds[0] ?? 1}`,
    verify: response => expectHtmlContaining(response, ['trail-map']),
  },
  {
    name: 'search suggestions',
    path: () => '/api/search/suggest?q=la',
    verify: (response) => {
      const bad = expectStatus(response)
      if (bad)
        return bad
      const payload = readJson(response)
      return payload?.success ? null : `answered ${JSON.stringify(payload).slice(0, 120)}`
    },
  },
]

/**
 * How long one request may take before it counts as a failure.
 *
 * Bounded because this runs in CI: a server that accepts the connection and
 * then never answers would otherwise hold the deploy job open until the
 * runner's own six-hour limit, with nothing in the log to say why. The trail
 * catalog is the slowest of these and answers in well under a second.
 */
const REQUEST_TIMEOUT_MS = 15_000

async function fetchOnce(url: string): Promise<SmokeResponse> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'wildloop-smoke/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  }
}

/** `TimeoutError` says nothing about what timed out. Say it. */
function describeRequestFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wait for the release to be the one answering.
 *
 * A deploy activates atomically but the service still has to come up, and rpx
 * needs a moment to follow it. Without this the first request after a deploy
 * can land on a restarting process and fail a site that is about to be fine.
 */
async function waitForSite(base: string, attempts = 10, delayMs = 6000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchOnce(`${base}/`)
      if (response.status < 500)
        return
      console.log(`  …${base} answered ${response.status}, retrying (${attempt}/${attempts})`)
    }
    catch (error) {
      console.log(`  …${base} unreachable (${describeRequestFailure(error)}), retrying (${attempt}/${attempts})`)
    }
    await Bun.sleep(delayMs)
  }
}

export async function runSmokeChecks(base: string): Promise<number> {
  const context: SmokeContext = { trailIds: [] }
  let failures = 0

  for (const check of SMOKE_CHECKS) {
    const url = `${base}${check.path(context)}`
    const started = Date.now()

    try {
      const response = await fetchOnce(url)
      const failure = check.verify(response, context)
      const ms = Date.now() - started

      if (failure) {
        failures++
        console.log(`❌ ${check.name} — ${failure}`)
        console.log(`   ${url} (${ms}ms)`)
      }
      else {
        console.log(`✅ ${check.name} (${ms}ms)`)
      }
    }
    catch (error) {
      failures++
      console.log(`❌ ${check.name} — request failed: ${describeRequestFailure(error)}`)
      console.log(`   ${url}`)
    }
  }

  return failures
}

if (import.meta.main) {
  const base = (process.argv[2] ?? process.env.SMOKE_URL ?? 'https://wildloop.org').replace(/\/$/, '')

  console.log(`Smoke checking ${base}`)
  await waitForSite(base)

  const failures = await runSmokeChecks(base)

  if (failures > 0) {
    console.log(`\n${failures} check${failures === 1 ? '' : 's'} failed against ${base}`)
    process.exit(1)
  }

  console.log(`\nAll ${SMOKE_CHECKS.length} checks passed against ${base}`)
}
