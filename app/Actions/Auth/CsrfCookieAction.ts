import { createCsrfCookie } from '../../Middleware/Csrf'
import { PRIVATE_CACHE_CONTROL } from '../../Support/edgeCache'

/**
 * GET /api/csrf — plant the CSRF cookie, and nothing else.
 *
 * The cookie used to arrive with every page and every JSON answer, so a form
 * always found one. Pages and trail lists can now come from Cloudflare's edge,
 * and a shared answer never sets a cookie (app/Middleware/Csrf.ts), so a
 * visitor can reach the sign-in form holding none. The form asks here first
 * (`ensureCsrfToken` in resources/assets/scripts/auth.ts).
 *
 * Issue a fresh framework cookie even when native networking already holds
 * one: native clients must be able to read the returned token and echo it.
 * Shared caches must never keep this response.
 */
export default new Action({
  name: 'CSRF Cookie',
  description: 'Set the CSRF double-submit cookie for a visitor who has none',
  method: 'GET',

  async handle(request: RequestInstance) {
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': PRIVATE_CACHE_CONTROL,
        // Preserve the router's enriched request and trusted-transport hint,
        // as the framework auth actions do when calling Request-based helpers.
        'Set-Cookie': createCsrfCookie(request as unknown as Request),
      },
    })
  },
})
