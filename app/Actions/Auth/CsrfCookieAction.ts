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
 * The router does the planting, as it does for any JSON GET from a visitor
 * without the cookie. This answer only has to be one the edge never keeps.
 */
export default new Action({
  name: 'CSRF Cookie',
  description: 'Set the CSRF double-submit cookie for a visitor who has none',
  method: 'GET',

  async handle() {
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': PRIVATE_CACHE_CONTROL,
      },
    })
  },
})
