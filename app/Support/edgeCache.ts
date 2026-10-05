/**
 * What Cloudflare's edge may keep, decided by the origin.
 *
 * The box is in Falkenstein and most of the people using Wildloop are in the
 * US. A trail list answers in 30 ms on the box and in 600 ms from Los Angeles,
 * and almost all of that is the trip across the Atlantic. An answer the edge
 * already holds skips the trip, so every response that is the same for every
 * signed-out visitor should say so — and every other response must say the
 * opposite, because a shared cache that stores one person's answer serves it to
 * the next person who asks.
 *
 * Three rules, in the order they are checked:
 *
 *  1. A request that carries a credential is never answered `public`. A bearer
 *     token is the only way this app signs a request in (app/Middleware/Auth.ts),
 *     but any `Authorization` header counts, and so does any cookie this file
 *     does not know to be harmless — failing towards private costs a cache
 *     miss, failing towards public costs somebody's data.
 *  2. Only a `200` is shared. A 404 for a trail that is being ingested right
 *     now, or a 500 while the database restarts, must not outlive the moment.
 *  3. The action has to say the answer is the same for everyone. An answer that
 *     reads a header the cache key does not include — the visitor's country,
 *     guessed from `CF-IPCountry` — is not, even signed out.
 *
 * A shared response must also never set a cookie. Cloudflare refuses to cache
 * one that does, so the edge would never hit; and a cache that stored it anyway
 * would hand one visitor's cookie to everybody. The CSRF cookie is the one the
 * framework attaches to every JSON and HTML answer, so `app/Middleware/Csrf.ts`
 * leaves it off any response this file marked shareable.
 *
 * The Cloudflare side — which paths are eligible at all, and the bypass for a
 * request with credentials — is `scripts/cloudflare-cache-rules.ts`, built from
 * the constants here so the two cannot drift.
 */

/** How long each kind of answer may be kept, in seconds. */
export interface EdgeCacheProfile {
  /** In the visitor's own browser. Short: it cannot be purged. */
  maxAge: number
  /** At the edge. Longer: it is shared, and an update is minutes away. */
  sMaxAge: number
  /** How long a stale copy may be served while a fresh one is fetched. */
  staleWhileRevalidate: number
}

export const EDGE_CACHE_PROFILES = {
  /**
   * Trail lists: near me, search, every sort. New trails and new reviews move
   * them, so five minutes at the edge, one in the browser.
   */
  list: { maxAge: 60, sMaxAge: 300, staleWhileRevalidate: 600 },
  /**
   * One trail. Its line and its numbers change with an ingest, its cover when
   * a photo is approved; an hour behind either is fine.
   */
  detail: { maxAge: 300, sMaxAge: 3600, staleWhileRevalidate: 3600 },
  /**
   * Catalog-wide reference answers: coverage counts, search suggestions.
   * They move with the catalog, which moves slowly.
   */
  reference: { maxAge: 300, sMaxAge: 600, staleWhileRevalidate: 3600 },
} as const satisfies Record<string, EdgeCacheProfile>

export type EdgeCacheProfileName = keyof typeof EDGE_CACHE_PROFILES

/** Everything that may not be shared, signed in or not. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store'

/**
 * Cookies that say nothing about who is asking.
 *
 * The CSRF double-submit cookie is planted on every visitor, signed in or not,
 * and browsers send it with every same-origin fetch: treating it as a
 * credential would make every second request private. The rest are
 * Cloudflare's own bot-management cookies, which it sets on whoever it likes
 * and which this app never reads.
 *
 * Anything else — the Google and Apple hand-off cookies that carry a session
 * token for a minute, Garmin's OAuth state, a framework session cookie, one
 * nobody has written yet — makes the request private.
 */
export const NON_CREDENTIAL_COOKIES: ReadonlySet<string> = new Set([
  'X-CSRF-Token',
  'csrf-token',
  '__cf_bm',
  '_cfuvid',
  'cf_clearance',
  '__cflb',
])

/**
 * Cookie names that mark a request as signed in, as Cloudflare sees it.
 *
 * The edge cannot run the allow-list above (its rule language on this plan has
 * no regular expressions), so it bypasses the cache on these substrings
 * instead. Every cookie this app sets that carries a credential matches one;
 * a cookie that slips past them still reaches an origin that answers it
 * `private`, so the cost of a miss here is one uncached answer, not a leak.
 */
export const CREDENTIAL_COOKIE_MARKERS = ['wl_', 'garmin_', 'session', 'auth', 'remember'] as const

interface HeaderSource {
  headers?: Headers | Record<string, unknown> | null
}

function header(request: HeaderSource | null | undefined, name: string): string {
  const headers = request?.headers
  if (!headers)
    return ''
  const raw = typeof (headers as Headers).get === 'function'
    ? (headers as Headers).get(name)
    : (headers as Record<string, unknown>)[name] ?? (headers as Record<string, unknown>)[name.toLowerCase()]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** The names in a `Cookie` header, in order. Values are never looked at. */
export function cookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(';')
    .map(part => part.split('=')[0]?.trim() ?? '')
    .filter(Boolean)
}

/**
 * Whether a request carries nothing that could identify the person sending it.
 *
 * An `Authorization` header of any kind, or any cookie outside
 * `NON_CREDENTIAL_COOKIES`, means no.
 */
export function requestIsAnonymous(request: HeaderSource | null | undefined): boolean {
  if (header(request, 'authorization'))
    return false
  return cookieNames(header(request, 'cookie')).every(name => NON_CREDENTIAL_COOKIES.has(name))
}

/** The `Cache-Control` value for a profile. */
export function sharedCacheControl(profile: EdgeCacheProfile): string {
  return [
    'public',
    `max-age=${profile.maxAge}`,
    `s-maxage=${profile.sMaxAge}`,
    `stale-while-revalidate=${profile.staleWhileRevalidate}`,
  ].join(', ')
}

export interface EdgeCacheDecision {
  /** Whether the response may be kept by a shared cache. */
  shared: boolean
  cacheControl: string
}

/**
 * Decide how one response may be cached.
 *
 * `sameForEveryone` is the action's own judgement that nothing but the URL
 * shaped the answer. It can only narrow: a credentialed request or a status
 * other than 200 is private whatever the action says.
 */
export function decideEdgeCache(
  request: HeaderSource | null | undefined,
  status: number,
  profile: EdgeCacheProfileName,
  sameForEveryone = true,
): EdgeCacheDecision {
  if (status !== 200 || !sameForEveryone || !requestIsAnonymous(request))
    return { shared: false, cacheControl: PRIVATE_CACHE_CONTROL }
  return { shared: true, cacheControl: sharedCacheControl(EDGE_CACHE_PROFILES[profile]) }
}

/**
 * Whether a response has declared itself fit for a shared cache.
 *
 * `public` or `s-maxage` is the declaration; `private` or `no-store` anywhere
 * in the value overrules it, as it would in any cache that read the header.
 */
export function declaresShared(headers: Headers | null | undefined): boolean {
  const value = (headers?.get('cache-control') ?? '').toLowerCase()
  if (!value || /\b(?:private|no-store)\b/.test(value))
    return false
  return /\bpublic\b/.test(value) || /\bs-maxage\s*=/.test(value)
}

/**
 * Stamp a response with the decision for it.
 *
 * Shared answers also carry `Vary: Authorization`. Cloudflare ignores it — the
 * edge bypasses its cache for a request with that header instead — but a
 * browser does not: without it, an answer cached while signed out would be
 * reused for the same URL a minute later, signed in.
 */
export function withEdgeCache(
  request: HeaderSource | null | undefined,
  response: Response,
  profile: EdgeCacheProfileName,
  sameForEveryone = true,
): Response {
  const decision = decideEdgeCache(request, response.status, profile, sameForEveryone)
  let target = response
  try {
    response.headers.set('Cache-Control', decision.cacheControl)
  }
  catch {
    // Immutable headers (a response built from a static asset): copy them.
    target = new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) })
    target.headers.set('Cache-Control', decision.cacheControl)
  }
  if (decision.shared) {
    const vary = target.headers.get('vary')
    if (!vary || !/\bauthorization\b/i.test(vary))
      target.headers.set('Vary', vary ? `${vary}, Authorization` : 'Authorization')
    // The API answers any origin with `*`, but only when the request names
    // one, and the edge ignores `Vary: Origin`. A copy stored from a
    // same-origin request would otherwise reach a cross-origin caller with no
    // CORS header at all. A shared answer is public by definition, so it says
    // so whoever asked first.
    if (!target.headers.has('access-control-allow-origin'))
      target.headers.set('Access-Control-Allow-Origin', '*')
  }
  return target
}

/**
 * The API paths the edge may cache, for the Cloudflare rule. Each is answered
 * through `withEdgeCache`, so the origin still decides per response; the rule
 * only says where asking is worthwhile.
 */
export const EDGE_CACHEABLE_API_PATHS = {
  exact: ['/api/trails', '/api/trails/stats', '/api/search/suggest'],
  /** `/api/trails/{id}` and nothing below it: reviews, photos and records stay out. */
  trailDetailPrefix: '/api/trails/',
} as const

/**
 * The pages the edge may cache.
 *
 * Each renders nothing about the person asking: the session is a bearer token
 * in the browser's storage, never a cookie the server reads, so a page is the
 * same for every visitor and at most differs by the record in its URL (a
 * trail's name in its title). Athlete, club and territory pages are left out on
 * purpose even though the same holds for them: they render a person's name or
 * a private club's, and a renamed, hidden or deleted account must not linger at
 * the edge for the length of a TTL.
 */
export const EDGE_CACHEABLE_PAGES = {
  exact: ['/', '/trails', '/support', '/privacy', '/terms'],
  prefixes: ['/trail/'],
} as const
