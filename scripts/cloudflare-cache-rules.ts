#!/usr/bin/env bun
/**
 * Let Cloudflare's edge answer wildloop.org's public pages and trail lists.
 *
 * The origin is in Falkenstein; most visitors are in the US. A trail list takes
 * 30 ms on the box and 600 ms from Los Angeles, and nearly all of it is the
 * round trip. Cloudflare only keeps what a Cache Rule makes eligible — without
 * one, every HTML page and every `/api` answer comes back `cf-cache-status:
 * DYNAMIC` whatever its headers say — and ts-cloud's zone config has no
 * setting for cache rules on a server deploy, so this script owns them.
 *
 *   bun scripts/cloudflare-cache-rules.ts            # dry run: prints the plan
 *   bun scripts/cloudflare-cache-rules.ts --apply    # writes the rules
 *
 * Needs CLOUDFLARE_API_TOKEN in the environment, with Zone Read and Cache
 * Rules Edit on the wildloop.org zone (CLOUDFLARE_ZONE_ID skips the lookup).
 * The token is sent to api.cloudflare.com and never printed.
 *
 * Idempotent: the rules it writes are recognised by their description prefix
 * and replaced in place on every run. Every other rule in the phase — ts-cloud's
 * `[ts-cloud]` rules, anything made in the dashboard — is left as it was.
 *
 * Three rules, in this order (a later cache rule overrides an earlier one):
 *
 *  1. The trail API paths are eligible, with the edge TTL taken from the
 *     origin's `Cache-Control` and **bypassed when there is none**. The origin
 *     decides per response (app/Support/edgeCache.ts): `public, s-maxage=…` for
 *     an anonymous answer that only the URL shaped, `private, no-store` for
 *     everything else. Nothing without that header is kept, so an error or an
 *     endpoint nobody marked can never be cached by accident.
 *  2. The public pages are eligible with a fixed five-minute edge TTL. The page
 *     server still attaches the CSRF cookie and `no-store` to a first visit
 *     (that lives in the framework, not this app), which a respect-origin rule
 *     would honour by never caching. An explicit TTL makes Cloudflare cache the
 *     page and drop the `Set-Cookie`; the sign-in form then fetches its token
 *     from `/api/csrf`. Safe because these pages render nothing about the
 *     person asking — see `EDGE_CACHEABLE_PAGES`. Only 200s are kept.
 *  3. Last, so it wins: never the cache for a request carrying an
 *     `Authorization` header or a credential cookie, nor for the router's
 *     `X-STX-Router` fragment requests, whose body is part of a page rather
 *     than the page and which Cloudflare would otherwise file under the same
 *     URL (it ignores `Vary`).
 */

import process from 'node:process'
import {
  CREDENTIAL_COOKIE_MARKERS,
  EDGE_CACHEABLE_API_PATHS,
  EDGE_CACHEABLE_PAGES,
} from '../app/Support/edgeCache'

export const DOMAIN = 'wildloop.org'
const PHASE = 'http_request_cache_settings'

/** How this script recognises its own rules among everybody else's. */
export const RULE_PREFIX = '[wildloop edge cache]'

/** Edge TTL for a page, in seconds. Short: a deploy changes every page at once. */
export const PAGE_EDGE_TTL = 300

export interface CacheRule {
  action: 'set_cache_settings'
  description: string
  expression: string
  enabled: boolean
  action_parameters: Record<string, unknown>
  [key: string]: unknown
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function set(values: readonly string[]): string {
  return `{${values.map(quote).join(' ')}}`
}

/** A request this cache must never answer: signed in, or a router fragment. */
export function bypassExpression(): string {
  const conditions = [
    'len(http.request.headers["authorization"]) > 0',
    'len(http.request.headers["x-stx-router"]) > 0',
    ...CREDENTIAL_COOKIE_MARKERS.map(marker => `http.cookie contains ${quote(marker)}`),
  ]
  return `(${conditions.join(' or ')})`
}

export function apiPathExpression(): string {
  return `(http.request.uri.path in ${set(EDGE_CACHEABLE_API_PATHS.exact)} or starts_with(http.request.uri.path, ${quote(EDGE_CACHEABLE_API_PATHS.trailDetailPrefix)}))`
}

export function pagePathExpression(): string {
  const prefixes = EDGE_CACHEABLE_PAGES.prefixes.map(prefix => `starts_with(http.request.uri.path, ${quote(prefix)})`)
  return `(http.request.uri.path in ${set(EDGE_CACHEABLE_PAGES.exact)} or ${prefixes.join(' or ')})`
}

/** The rules this script keeps in the zone, in order. */
export function buildEdgeCacheRules(host = DOMAIN): CacheRule[] {
  const onHost = `http.host eq ${quote(host)}`
  const safeRead = `http.request.method in {"GET" "HEAD"}`
  const bypass = bypassExpression()

  return [
    {
      action: 'set_cache_settings',
      description: `${RULE_PREFIX} trail API: the origin's Cache-Control decides`,
      expression: `(${onHost} and ${safeRead} and ${apiPathExpression()} and not ${bypass})`,
      enabled: true,
      action_parameters: {
        cache: true,
        // No Cache-Control, no caching: only what the origin marked is kept.
        edge_ttl: { mode: 'bypass_by_default' },
        browser_ttl: { mode: 'respect_origin' },
      },
    },
    {
      action: 'set_cache_settings',
      description: `${RULE_PREFIX} public pages: ${PAGE_EDGE_TTL / 60} minutes at the edge`,
      expression: `(${onHost} and ${safeRead} and ${pagePathExpression()} and not ${bypass})`,
      enabled: true,
      action_parameters: {
        cache: true,
        edge_ttl: {
          mode: 'override_origin',
          default: PAGE_EDGE_TTL,
          // A redirect (a folded trail's 301), a 404 and every error are
          // never kept: only a page that rendered.
          status_code_ttl: [{ status_code_range: { from: 300, to: 599 }, value: -1 }],
        },
        browser_ttl: { mode: 'respect_origin' },
      },
    },
    {
      action: 'set_cache_settings',
      description: `${RULE_PREFIX} never for credentials or router fragments`,
      // Only over the paths above: a static asset fetched by a signed-in
      // browser is the same file, and stays cached.
      expression: `(${onHost} and (${apiPathExpression()} or ${pagePathExpression()}) and ${bypass})`,
      enabled: true,
      action_parameters: { cache: false },
    },
  ]
}

/** Returned by the API on every rule, refused by it on a PUT. */
const READ_ONLY_RULE_FIELDS = new Set(['id', 'version', 'last_updated'])

/** Whether a rule in the zone is one this script wrote. */
export function isOwnRule(rule: { description?: string }): boolean {
  return (rule.description ?? '').startsWith(RULE_PREFIX)
}

/**
 * The phase's rules with ours replaced and everyone else's untouched.
 *
 * Ours go last so the bypass rule is the final word. Read-only fields the API
 * returns are dropped, because the entrypoint PUT rejects them.
 */
export function mergeRules(existing: Array<Record<string, unknown>>, ours: CacheRule[]): Array<Record<string, unknown>> {
  const others = existing
    .filter(rule => !isOwnRule(rule as { description?: string }))
    .map(rule => Object.fromEntries(Object.entries(rule).filter(([key]) => !READ_ONLY_RULE_FIELDS.has(key))))
  return [...others, ...ours]
}

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

async function cloudflare(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await res.json().catch(() => null) as any
  return { status: res.status, body }
}

function errorsOf(body: any): string {
  return (body?.errors ?? []).map((error: any) => error?.message).filter(Boolean).join('; ') || 'unknown error'
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const ours = buildEdgeCacheRules()

  console.log(`Cache rules for ${DOMAIN} (${PHASE}):\n`)
  for (const rule of ours)
    console.log(`  ${rule.description}\n    ${rule.expression}\n    ${JSON.stringify(rule.action_parameters)}\n`)

  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) {
    if (apply)
      fail('CLOUDFLARE_API_TOKEN is not set. It needs Zone Read and Cache Rules Edit on this zone.')
    console.log('Dry run without CLOUDFLARE_API_TOKEN — showing the rules only, nothing was read or written.')
    return
  }

  let zoneId = process.env.CLOUDFLARE_ZONE_ID
  if (!zoneId) {
    const zones = await cloudflare(token, `/zones?name=${DOMAIN}`)
    zoneId = zones.body?.result?.[0]?.id
    if (!zoneId)
      fail(`No Cloudflare zone for ${DOMAIN} visible to this token (${errorsOf(zones.body)}).`)
  }

  const current = await cloudflare(token, `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`)
  // 404: the zone has no cache rules yet, and the PUT below creates the phase.
  if (current.status !== 404 && !current.body?.success)
    fail(`Could not read the zone's cache rules: ${errorsOf(current.body)}`)
  const existing = (current.status === 404 ? [] : current.body?.result?.rules ?? []) as Array<Record<string, unknown>>

  const replaced = existing.filter(rule => isOwnRule(rule as { description?: string })).length
  const kept = existing.length - replaced
  console.log(`The zone has ${existing.length} cache rule(s): ${replaced} of ours to replace, ${kept} of others kept as they are.`)

  const rules = mergeRules(existing, ours)
  if (!apply) {
    console.log(`\nDry run — nothing was written. Re-run with --apply to write ${rules.length} rule(s).`)
    return
  }

  const written = await cloudflare(token, `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  })
  if (!written.body?.success)
    fail(`Cloudflare refused the rules: ${errorsOf(written.body)}`)

  console.log(`\nWritten: ${ours.length} rule(s) of ours, ${kept} other(s) unchanged.`)
  console.log(`Check: curl -sI https://${DOMAIN}/ | grep -i cf-cache-status   (MISS, then HIT)`)
}

if (import.meta.main)
  await main()
