/**
 * The one HTTP client every trail source goes through.
 *
 * Built on `ts-web-scraper`'s primitives rather than raw `fetch`, because a
 * national ingest hammers three third-party endpoints for hours at a time and
 * each of them punishes a naive client differently:
 *
 * - Overpass returns 429/504 under load and expects a genuine pause, not a
 *   tight retry loop.
 * - The Forest Service and Park Service ArcGIS servers are slow and
 *   occasionally 502 mid-page.
 *
 * `RateLimiter` (token bucket) keeps us politely under each host's budget,
 * `withRetry` does exponential backoff with jitter on exactly the status codes
 * worth retrying, and `ScraperCache` persists responses to disk so re-running
 * a partially-failed ingest does not re-fetch what already succeeded.
 */

import type { RateLimiterOptions, RetryOptions } from 'ts-web-scraper'
import process from 'node:process'
import { createHTTPError, RateLimiter, ScraperCache, withRetry } from 'ts-web-scraper'

/**
 * Response caching is OFF unless `TRAIL_INGEST_CACHE=1`.
 *
 * The checkpoint table is the real cache: a completed shard is never fetched
 * again, so on a full national run the disk cache earns nothing and costs a
 * great deal. A single dense Overpass tile answers with tens of megabytes and
 * there are ~1,400 of them; caching the lot filled a development machine's
 * disk before the run was a tenth done.
 *
 * It stays available because it genuinely helps while developing a source,
 * where the same shard is fetched over and over.
 */
const CACHE_ENABLED = process.env.TRAIL_INGEST_CACHE === '1'

/** Identifies us to every upstream, with a contact URL as courtesy demands. */
export const USER_AGENT = 'Wildloop/1.0 (+https://wildloop.org; trail data ingest)'

export interface TrailHttpClientOptions {
  /** Human label used in log lines, e.g. `overpass`. */
  name: string
  rateLimit: RateLimiterOptions
  retry?: RetryOptions
  /**
   * Seconds to keep responses on disk, when caching is enabled at all (see
   * `TRAIL_INGEST_CACHE`). 0 disables it for this client regardless.
   */
  cacheTtl?: number
  /** Per-request timeout. Overpass legitimately takes minutes on a dense tile. */
  timeout?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /**
   * Cache key override. Needed for POST, where the URL alone does not identify
   * the response — every Overpass query hits the same `/api/interpreter`.
   */
  cacheKey?: string
  /** Skip the cache for this request even when the client has one. */
  noCache?: boolean
}

export class TrailHttpClient {
  private readonly limiter: RateLimiter
  private readonly cache?: ScraperCache
  private readonly retry: RetryOptions
  private readonly timeout: number

  constructor(private readonly options: TrailHttpClientOptions) {
    this.limiter = new RateLimiter(options.rateLimit)
    this.timeout = options.timeout ?? 180_000

    this.retry = options.retry ?? {
      maxRetries: 4,
      initialDelay: 5_000,
      maxDelay: 120_000,
      backoffMultiplier: 2,
      jitter: true,
    }

    if (CACHE_ENABLED && options.cacheTtl && options.cacheTtl > 0) {
      this.cache = new ScraperCache({
        enabled: true,
        ttl: options.cacheTtl * 1000,
        storage: 'disk',
        cacheDir: `storage/framework/cache/scraper/${options.name}`,
        maxSize: 5_000,
      })
    }
  }

  /**
   * Fetch and parse JSON, going through rate limiting, retries and the cache.
   *
   * Non-2xx responses become a `ScraperError` carrying the status code, which
   * is what lets `withRetry` distinguish "back off and try again" (429, 5xx)
   * from "this will never work" (400, 404) instead of burning four attempts on
   * a malformed query.
   */
  async json<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const key = options.cacheKey ?? url

    if (this.cache && !options.noCache) {
      const hit = await this.cache.get<string>(key)
      if (hit)
        return JSON.parse(hit.data) as T
    }

    const text = await withRetry(async () => {
      await this.limiter.throttle()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)

      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
            ...options.headers,
          },
          body: options.body,
          signal: controller.signal,
        })

        if (!response.ok)
          throw createHTTPError(response.status, url, response.statusText)

        return await response.text()
      }
      finally {
        clearTimeout(timer)
      }
    }, this.retry)

    // ArcGIS answers a bad query with HTTP 200 and an `error` object, so a
    // successful parse is not yet a successful request — the callers check.
    const parsed = JSON.parse(text) as T

    if (this.cache && !options.noCache)
      await this.cache.set(key, text)

    return parsed
  }
}
