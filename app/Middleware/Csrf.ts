/**
 * The framework's CSRF middleware, minus the cookie on shareable answers.
 *
 * Everything — the double-submit check, the token, the cookie's shape — is the
 * framework's own (storage/framework/defaults/app/Middleware/Csrf.ts). This
 * file exists for one rule: a response that told shared caches they may keep
 * it (`public`, `s-maxage`; see app/Support/edgeCache.ts) is sent without a
 * `Set-Cookie`.
 *
 * The router seeds the CSRF cookie on every JSON GET from a visitor who has
 * none. On a shareable answer that does two kinds of harm. Cloudflare will not
 * cache a response that sets a cookie, so the edge never hit and every trail
 * list still crossed the Atlantic. And a cache that did keep it would hand the
 * same token to everybody behind it.
 *
 * Nothing that needs the cookie loses it. A visitor who signs in, signs up or
 * asks for a reset without one asks `/api/csrf` first
 * (`ensureCsrfToken` in resources/assets/scripts/auth.ts), which is never
 * shareable and always seeds it.
 *
 * The router resolves `app/Middleware/Csrf.ts` before the vendored default, so
 * this is the module both the `csrf` middleware and the post-response seeding
 * load (`resolveDefaultsPath` in @stacksjs/router).
 */
import { declaresShared } from '../Support/edgeCache'
import { seedCsrfCookieIfMissing as seedFrameworkCsrfCookie } from '../../storage/framework/defaults/app/Middleware/Csrf'

export * from '../../storage/framework/defaults/app/Middleware/Csrf'
export { default } from '../../storage/framework/defaults/app/Middleware/Csrf'

export function seedCsrfCookieIfMissing(req: Request, response: Response, minted?: string, responseHasNoCookies = false): Response {
  if (declaresShared(response.headers))
    return response
  return seedFrameworkCsrfCookie(req, response, minted, responseHasNoCookies)
}
