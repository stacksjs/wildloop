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
 *
 * The framework's module is found the way the router finds it: the vendored
 * copy under storage/framework/defaults when there is one (a checkout), else
 * the @stacksjs/defaults package (a release, which ships without the vendored
 * tree). A static import of the vendored path took the API down on the first
 * production deploy: the file is not in a release, and every route failed to
 * register.
 */
import type FrameworkCsrf from '../../storage/framework/defaults/app/Middleware/Csrf'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { declaresShared } from '../Support/edgeCache'

type FrameworkModule = typeof import('../../storage/framework/defaults/app/Middleware/Csrf')

/** Where the framework's CSRF middleware is, in a checkout and in a release. */
export function frameworkCsrfPath(root: string = join(import.meta.dir, '..', '..')): string {
  const candidates = [
    join(root, 'storage/framework/defaults/app/Middleware/Csrf.ts'),
    join(root, 'node_modules/@stacksjs/defaults/app/Middleware/Csrf.ts'),
  ]
  const found = candidates.find(path => existsSync(path))
  if (!found)
    throw new Error(`The framework CSRF middleware is in none of: ${candidates.join(', ')}`)
  return found
}

const framework = await import(frameworkCsrfPath()) as FrameworkModule

// Every export of the framework module is passed through, because the router
// calls them on this file: since Stacks 0.75 it reads an existing cookie's
// token with `csrfCookieToken` before rendering a page.
export const CSRF_COOKIE_NAME = framework.CSRF_COOKIE_NAME
export const csrfCookieToken = framework.csrfCookieToken
export const responseDeclaresShared = framework.responseDeclaresShared
export const generateCsrfToken = framework.generateCsrfToken
export const createCsrfCookie = framework.createCsrfCookie
export const responseMayUseCsrfToken = framework.responseMayUseCsrfToken
export const validateCsrfRequest = framework.validateCsrfRequest

const csrf: typeof FrameworkCsrf = framework.default
export default csrf

export function seedCsrfCookieIfMissing(req: Request, response: Response, minted?: string, responseHasNoCookies = false): Response {
  if (declaresShared(response.headers))
    return response
  return framework.seedCsrfCookieIfMissing(req, response, minted, responseHasNoCookies)
}
