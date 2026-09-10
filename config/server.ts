import type { ServerConfig } from '@stacksjs/types'

/**
 * How the views server behaves — the split views/API topology shared by
 * `buddy dev` and `buddy serve`.
 */
export default {
  /**
   * Sitemaps belong at the site root, where crawlers look for them.
   *
   * The handlers are registered in `routes/api.ts`, which carries an `/api`
   * prefix, so they live at `/api/sitemap.xml`. Google probes `/sitemap.xml`
   * directly and Search Console will not accept a submission it cannot fetch
   * there, so the root path answering 404 loses most of the value of having
   * built the sitemap. A rewrite answers where the request was made, rather
   * than redirecting and costing a round trip per chunk — and the catalog is
   * chunked into two dozen of them.
   *
   * The `*` rule covers every trail chunk, whose count follows the size of the
   * table and is not something to keep in step by hand here.
   */
  rewrites: {
    '/sitemap.xml': '/api/sitemap.xml',
    '/sitemap-pages.xml': '/api/sitemap-pages.xml',
    '/sitemap-trails-*': '/api/sitemap-trails-*',
  },

  /**
   * Every view here is a shell: the markup is derived from its source file,
   * and activity, trail, social and account data arrive afterwards from the
   * API. So one compiled render per source file serves every URL that view
   * answers, and the static routes are worth rendering before real traffic
   * rather than on somebody's first visit.
   *
   * `renderVary: 'source'` is what makes per-record `<script server>` metadata
   * impossible — one render of `trail/[id].stx` is served for all ~600k trails
   * — which is why `resources/composables/usePageSeo.ts` applies a trail's own
   * title on the client instead. That is a consequence of the shell
   * architecture, not of this setting: a view that rendered its record would
   * not be cacheable this way in the first place.
   *
   * The document header only lands on responses that set no cookie; the
   * framework enforces that, so a page that starts carrying a session is
   * dropped from shared caches automatically rather than silently shared.
   */
  cache: {
    renders: true,
    renderVary: 'source',
    prewarm: true,
    documents: { maxAge: 60, staleWhileRevalidate: 600 },
  },
} satisfies ServerConfig
