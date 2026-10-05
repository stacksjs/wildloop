import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  decideEdgeCache,
  declaresShared,
  EDGE_CACHEABLE_API_PATHS,
  EDGE_CACHEABLE_PAGES,
  PRIVATE_CACHE_CONTROL,
  requestIsAnonymous,
  withEdgeCache,
} from '../../app/Support/edgeCache'
import { buildEdgeCacheRules, isOwnRule, mergeRules, RULE_PREFIX } from '../../scripts/cloudflare-cache-rules'
import { milesFromOrigin, shareableCoordinate } from '../../resources/functions/shared-origin'
import { milesBetween } from '../../app/Support/trailRanking'

/**
 * What Cloudflare's edge may keep.
 *
 * The edge serves whatever it stored to whoever asks next, so the decision is
 * tested from the side that matters: a request that carries any credential
 * never gets an answer a shared cache may keep, and an answer a shared cache
 * may keep never sets a cookie.
 */

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1/api/trails?lat=34.05&lng=-118.25', { headers })
}

describe('who counts as anonymous', () => {
  it('is a request with no credentials at all', () => {
    expect(requestIsAnonymous(request())).toBe(true)
  })

  it('still is with only the CSRF cookie, which every visitor carries', () => {
    expect(requestIsAnonymous(request({ cookie: 'X-CSRF-Token=abc123' }))).toBe(true)
    expect(requestIsAnonymous(request({ cookie: 'X-CSRF-Token=abc; __cf_bm=xyz; _cfuvid=1' }))).toBe(true)
  })

  it('is not with any Authorization header', () => {
    expect(requestIsAnonymous(request({ authorization: 'Bearer 1|token' }))).toBe(false)
    expect(requestIsAnonymous(request({ authorization: 'Basic dTpw' }))).toBe(false)
  })

  it('is not with a sign-in hand-off or OAuth cookie', () => {
    for (const cookie of ['wl_google_handoff=t', 'wl_apple_handoff=t', 'garmin_oauth=s', 'X-CSRF-Token=a; wl_google_state=s'])
      expect(requestIsAnonymous(request({ cookie })), cookie).toBe(false)
  })

  it('fails towards private for a cookie nobody has named yet', () => {
    expect(requestIsAnonymous(request({ cookie: 'stacks_session=abc' }))).toBe(false)
    expect(requestIsAnonymous(request({ cookie: 'something_new=1' }))).toBe(false)
  })

  it('reads plain header objects too', () => {
    expect(requestIsAnonymous({ headers: { authorization: 'Bearer x' } })).toBe(false)
    expect(requestIsAnonymous({ headers: {} })).toBe(true)
    expect(requestIsAnonymous(null)).toBe(true)
  })
})

describe('the decision', () => {
  it('shares an anonymous 200, with an edge TTL longer than the browser one', () => {
    const decision = decideEdgeCache(request(), 200, 'list')
    expect(decision.shared).toBe(true)
    expect(decision.cacheControl).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600')
    expect(decideEdgeCache(request(), 200, 'detail').cacheControl).toContain('s-maxage=3600')
  })

  it('never shares a signed-in request, whatever the action says', () => {
    for (const headers of [{ authorization: 'Bearer 1|t' }, { cookie: 'wl_google_handoff=t' }]) {
      const decision = decideEdgeCache(request(headers), 200, 'list', true)
      expect(decision.shared).toBe(false)
      expect(decision.cacheControl).toBe(PRIVATE_CACHE_CONTROL)
      expect(decision.cacheControl).not.toContain('public')
    }
  })

  it('never shares an error or a miss', () => {
    for (const status of [201, 301, 404, 422, 500, 503])
      expect(decideEdgeCache(request(), status, 'detail').shared, String(status)).toBe(false)
  })

  it('never shares an answer the action says a header shaped', () => {
    expect(decideEdgeCache(request(), 200, 'list', false)).toEqual({ shared: false, cacheControl: PRIVATE_CACHE_CONTROL })
  })
})

describe('stamping a response', () => {
  it('marks a shared answer and varies it on Authorization for the browser', () => {
    const response = withEdgeCache(request(), Response.json({ ok: true }), 'list')
    expect(response.headers.get('cache-control')).toStartWith('public,')
    expect(response.headers.get('vary')).toBe('Authorization')
  })

  it('opens a shared answer to every origin, since the edge ignores Vary: Origin', () => {
    expect(withEdgeCache(request(), Response.json({ ok: true }), 'list').headers.get('access-control-allow-origin')).toBe('*')
    expect(withEdgeCache(request({ authorization: 'Bearer x' }), Response.json({ ok: true }), 'list').headers.get('access-control-allow-origin')).toBeNull()
  })

  it('keeps an existing Vary', () => {
    const response = withEdgeCache(request(), Response.json({ ok: true }, { headers: { Vary: 'Origin' } }), 'list')
    expect(response.headers.get('vary')).toBe('Origin, Authorization')
  })

  it('marks a signed-in answer private and no-store', () => {
    const response = withEdgeCache(request({ authorization: 'Bearer x' }), Response.json({ ok: true }), 'list')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('reading a declaration back', () => {
  it('knows public and s-maxage, and lets private or no-store overrule them', () => {
    const headers = (value: string) => new Headers({ 'cache-control': value })
    expect(declaresShared(headers('public, max-age=60'))).toBe(true)
    expect(declaresShared(headers('s-maxage=300'))).toBe(true)
    expect(declaresShared(headers('private, no-store'))).toBe(false)
    expect(declaresShared(headers('no-store'))).toBe(false)
    expect(declaresShared(headers('public, no-store'))).toBe(false)
    expect(declaresShared(headers('max-age=60'))).toBe(false)
    expect(declaresShared(new Headers())).toBe(false)
  })
})

describe('the CSRF cookie and a shared answer', () => {
  it('is never set on a response marked shareable', async () => {
    const { seedCsrfCookieIfMissing } = await import('../../app/Middleware/Csrf')
    const shared = withEdgeCache(request(), Response.json({ ok: true }), 'list')
    const seeded = seedCsrfCookieIfMissing(request(), shared)
    expect(seeded.headers.getSetCookie()).toEqual([])
  })

  it('is still planted on everything else, exactly as the framework did', async () => {
    const { seedCsrfCookieIfMissing } = await import('../../app/Middleware/Csrf')
    const signedIn = withEdgeCache(request({ authorization: 'Bearer x' }), Response.json({ ok: true }), 'list')
    expect(seedCsrfCookieIfMissing(request({ authorization: 'Bearer x' }), signedIn).headers.getSetCookie()[0]).toStartWith('X-CSRF-Token=')
    expect(seedCsrfCookieIfMissing(request(), Response.json({ ok: true })).headers.getSetCookie()[0]).toStartWith('X-CSRF-Token=')
  })

  it('keeps the rest of the framework middleware: the check and the export the router loads', async () => {
    const csrf = await import('../../app/Middleware/Csrf')
    const framework = await import('../../storage/framework/defaults/app/Middleware/Csrf')
    expect(csrf.default).toBe(framework.default)
    expect(csrf.validateCsrfRequest).toBe(framework.validateCsrfRequest)
    expect(csrf.generateCsrfToken).toBe(framework.generateCsrfToken)
    await expect(csrf.validateCsrfRequest(new Request('http://127.0.0.1/api/login', { method: 'POST' }))).rejects.toThrow()
  })

  // The router imports this file in place of the framework's and calls what it
  // finds there. Stacks 0.75 began calling `csrfCookieToken`, which this file
  // did not pass through, so every page request carrying the cookie threw.
  it('exports every name the framework module does', async () => {
    const csrf = await import('../../app/Middleware/Csrf')
    const framework = await import('../../storage/framework/defaults/app/Middleware/Csrf')
    const missing = Object.keys(framework).filter(name => !(name in csrf))
    expect(missing).toEqual([])
    expect(csrf.csrfCookieToken).toBe(framework.csrfCookieToken)
  })
})

/**
 * Which actions may answer `public` at all.
 *
 * Read from the source, because the failure this guards against is somebody
 * adding `withEdgeCache` to an action that reads the viewer — `/api/me`, a
 * private feed — and nothing else would notice until the edge served it.
 */
describe('the actions that may be shared', () => {
  const root = resolve(import.meta.dir, '../..')

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
    })
  }

  it('are exactly the public catalog reads', () => {
    const sharing = files(join(root, 'app/Actions'))
      .filter(path => readFileSync(path, 'utf8').includes('withEdgeCache('))
      .map(path => relative(root, path))
      .sort()
    expect(sharing).toEqual([
      'app/Actions/Search/SearchSuggestAction.ts',
      'app/Actions/Trail/TrailIndexAction.ts',
      'app/Actions/Trail/TrailShowAction.ts',
      'app/Actions/Trail/TrailStatsAction.ts',
    ])
  })

  it('never write public Cache-Control by hand on a signed-in route', () => {
    const offenders = files(join(root, 'app/Actions'))
      .filter(path => /app\/Actions\/(?:Auth|Admin|Privacy|Notification|Profile\/(?!AvatarFile))/.test(relative(root, path).replaceAll('\\', '/')))
      .filter(path => /['"]Cache-Control['"]\s*:\s*[`'"][^`'"]*public/i.test(readFileSync(path, 'utf8')))
      .map(path => relative(root, path))
    expect(offenders).toEqual([])
  })
})

describe('the Cloudflare rules', () => {
  const rules = buildEdgeCacheRules()

  it('are three, all ours, with the bypass last so it wins', () => {
    expect(rules).toHaveLength(3)
    expect(rules.every(isOwnRule)).toBe(true)
    expect(rules.at(-1)?.action_parameters).toEqual({ cache: false })
  })

  it('let the origin decide for the API, and keep nothing it did not mark', () => {
    const api = rules[0]!
    expect(api.action_parameters.edge_ttl).toEqual({ mode: 'bypass_by_default' })
    for (const path of EDGE_CACHEABLE_API_PATHS.exact)
      expect(api.expression).toContain(`"${path}"`)
  })

  it('keep only pages that rendered', () => {
    const pages = rules[1]!
    expect((pages.action_parameters.edge_ttl as any).status_code_ttl).toEqual([{ status_code_range: { from: 300, to: 599 }, value: -1 }])
    for (const path of EDGE_CACHEABLE_PAGES.exact)
      expect(pages.expression).toContain(`"${path}"`)
  })

  it('skip credentials and router fragments everywhere they make anything eligible', () => {
    for (const rule of rules.slice(0, 2)) {
      expect(rule.expression).toContain('not (len(http.request.headers["authorization"]) > 0')
      expect(rule.expression).toContain('http.request.headers["x-stx-router"]')
      expect(rule.expression).toContain('http.cookie contains "wl_"')
      expect(rule.expression).toContain('http.request.method in {"GET" "HEAD"}')
    }
  })

  it('never name a private path', () => {
    const eligible = rules.slice(0, 2).map(rule => rule.expression).join(' ')
    for (const path of ['/api/me', '/api/auth', '/api/admin', '/api/login', '/api/activities', '/api/csrf', '/settings', '/profile', '/admin'])
      expect(eligible, path).not.toContain(`"${path}`)
  })

  it('replace their own earlier copies and leave everybody else\'s alone', () => {
    const existing = [
      { id: 'a', version: '3', last_updated: 'x', description: '[ts-cloud] cache documents', expression: 'true', action: 'set_cache_settings' },
      { id: 'b', description: `${RULE_PREFIX} an old one`, expression: 'false', action: 'set_cache_settings' },
      { id: 'c', description: 'made in the dashboard', expression: 'true', action: 'set_cache_settings' },
    ]
    const merged = mergeRules(existing, rules)
    expect(merged.map(rule => rule.description)).toEqual([
      '[ts-cloud] cache documents',
      'made in the dashboard',
      ...rules.map(rule => rule.description),
    ])
    expect(merged.some(rule => 'id' in rule || 'version' in rule || 'last_updated' in rule)).toBe(false)
  })
})

describe('a near-me location rounded for the edge', () => {
  it('keeps two decimals, about a kilometre', () => {
    expect(shareableCoordinate(34.052235)).toBe(34.05)
    expect(shareableCoordinate(-118.243683)).toBe(-118.24)
    expect(shareableCoordinate(-0.001)).toBe(0)
    expect(Object.is(shareableCoordinate(-0.001), -0)).toBe(false)
  })

  it('puts neighbours on one URL', () => {
    const a = [34.0522, -118.2437].map(shareableCoordinate)
    const b = [34.0531, -118.2401].map(shareableCoordinate)
    expect(a).toEqual(b)
  })

  it('measures distance the way the server does', () => {
    const origin = { lat: 34.0522, lng: -118.2437 }
    for (const [lat, lng] of [[34.1, -118.3], [34.2, -118.1], [33.9, -118.5]] as const)
      expect(milesFromOrigin(origin, lat, lng)).toBe(Math.round(milesBetween(origin, lat, lng) * 10) / 10)
  })
})

describe('finding the framework CSRF middleware', () => {
  it('uses the vendored copy in a checkout and the package in a release', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { frameworkCsrfPath } = await import('../../app/Middleware/Csrf')

    const release = mkdtempSync(join(tmpdir(), 'wildloop-release-'))
    mkdirSync(join(release, 'node_modules/@stacksjs/defaults/app/Middleware'), { recursive: true })
    writeFileSync(join(release, 'node_modules/@stacksjs/defaults/app/Middleware/Csrf.ts'), '')
    // A release ships without storage/framework/defaults: the package's copy.
    expect(frameworkCsrfPath(release)).toBe(join(release, 'node_modules/@stacksjs/defaults/app/Middleware/Csrf.ts'))

    mkdirSync(join(release, 'storage/framework/defaults/app/Middleware'), { recursive: true })
    writeFileSync(join(release, 'storage/framework/defaults/app/Middleware/Csrf.ts'), '')
    expect(frameworkCsrfPath(release)).toBe(join(release, 'storage/framework/defaults/app/Middleware/Csrf.ts'))

    expect(() => frameworkCsrfPath(join(release, 'nowhere'))).toThrow('none of')
  })
})
