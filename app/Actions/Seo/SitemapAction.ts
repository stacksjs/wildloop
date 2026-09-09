/**
 * Sitemaps.
 *
 * The catalog is the reason to index this site at all: hundreds of thousands
 * of trail pages that nothing links to from the homepage, and which a crawler
 * would therefore never find on its own. A sitemap is the only way to say they
 * exist.
 *
 * That size is also why this is an INDEX rather than one file. The protocol
 * caps a single sitemap at 50,000 URLs; a dump of every trail would be
 * rejected whole, so nothing at all would get indexed. `/sitemap.xml`
 * therefore lists children — one for the static pages, one per chunk of
 * trails — and each is fetched separately.
 *
 * Served under `/api/sitemap…` (see routes/api.ts) because that prefix is what
 * the frontend proxies to this server. The framework already answers the bare
 * `/sitemap.xml` with a list derived from the route table — useful, but it
 * cannot know about trails, which are rows rather than routes. robots.txt
 * points at this one, and allows the path explicitly since `/api/` is
 * otherwise disallowed.
 *
 * Routes:
 *   /api/sitemap.xml               the index
 *   /api/sitemap-pages.xml         everything that is not a database row
 *   /api/sitemap-trails-{page}.xml one chunk of trail pages, 1-based
 */

const SITE_URL = 'https://wildloop.org'

/** Comfortably under the protocol's 50,000, with room for the file to grow. */
const TRAILS_PER_CHUNK = 25_000

interface StaticPage {
  path: string
  changefreq: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'
  priority: string
}

/**
 * The pages that exist regardless of what is in the database.
 *
 * `changefreq` and `priority` are hints a crawler is free to ignore, and most
 * do. They are here because getting them wrong — marking the terms page
 * `hourly` — actively wastes crawl budget on a site with this many URLs.
 */
const STATIC_PAGES: StaticPage[] = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/trails', changefreq: 'daily', priority: '0.9' },
  { path: '/territories', changefreq: 'daily', priority: '0.8' },
  { path: '/feed', changefreq: 'hourly', priority: '0.7' },
  { path: '/events', changefreq: 'daily', priority: '0.7' },
  { path: '/clubs', changefreq: 'daily', priority: '0.7' },
  { path: '/records', changefreq: 'weekly', priority: '0.7' },
  { path: '/leaderboard', changefreq: 'daily', priority: '0.6' },
  { path: '/athletes', changefreq: 'weekly', priority: '0.6' },
  { path: '/challenges', changefreq: 'weekly', priority: '0.5' },
  { path: '/routes', changefreq: 'weekly', priority: '0.5' },
  { path: '/register', changefreq: 'yearly', priority: '0.4' },
  { path: '/login', changefreq: 'yearly', priority: '0.3' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.2' },
  { path: '/terms', changefreq: 'yearly', priority: '0.2' },
]

/** `YYYY-MM-DD`, which is all `<lastmod>` needs and all we can honestly give. */
function isoDate(value?: unknown): string {
  const date = value ? new Date(value as string) : new Date()
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().slice(0, 10)
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Crawlers re-fetch a sitemap often, and the catalog changes on an
      // ingest rather than on a request.
      'Cache-Control': 'public, max-age=3600',
    },
  })
}

async function trailCount(): Promise<number> {
  const total = await Trail.query().count().catch(() => 0)
  return Number(total) || 0
}

/** How many trail chunks there are. Always at least one, even when empty. */
async function trailChunks(): Promise<number> {
  return Math.max(1, Math.ceil((await trailCount()) / TRAILS_PER_CHUNK))
}

/** `/sitemap.xml` */
export async function sitemapIndex(): Promise<Response> {
  const today = isoDate()
  const chunks = await trailChunks()

  // A sitemap index holds only <sitemap> entries — mixing <url> in makes the
  // document invalid, which is why the static pages get a child of their own
  // rather than being inlined here.
  const children = [
    `${SITE_URL}/api/sitemap-pages.xml`,
    ...Array.from({ length: chunks }, (_, i) => `${SITE_URL}/api/sitemap-trails-${i + 1}.xml`),
  ]

  const body = children
    .map(loc => `  <sitemap>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`)
    .join('\n')

  return xmlResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`,
  )
}

/** `/sitemap-pages.xml` */
export async function sitemapPages(): Promise<Response> {
  const today = isoDate()

  const body = STATIC_PAGES.map(page =>
    `  <url>\n`
    + `    <loc>${SITE_URL}${page.path}</loc>\n`
    + `    <lastmod>${today}</lastmod>\n`
    + `    <changefreq>${page.changefreq}</changefreq>\n`
    + `    <priority>${page.priority}</priority>\n`
    + `  </url>`).join('\n')

  return xmlResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
  )
}

/**
 * `/sitemap-trails-{page}.xml`
 *
 * A page beyond the last chunk answers with an empty but valid urlset rather
 * than a 404: a crawler that requested it read the number off our own index,
 * and an error there costs it trust in the whole set.
 */
export async function sitemapTrails(page: unknown): Promise<Response> {
  const requested = Number(page)
  const index = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1

  const rows = await Trail.query()
    .orderBy('id', 'asc')
    .limit(TRAILS_PER_CHUNK)
    .offset((index - 1) * TRAILS_PER_CHUNK)
    .get()
    .catch(() => [])

  const body = (rows as any[]).map((trail) => {
    return `  <url>\n`
      + `    <loc>${SITE_URL}/trail/${trail.id}</loc>\n`
      + `    <lastmod>${isoDate(trail.updated_at ?? trail.created_at)}</lastmod>\n`
      + `    <changefreq>monthly</changefreq>\n`
      // A National Scenic Trail is a destination somebody searches for by
      // name; a forest-service connector spur is not. Both belong here, but
      // not at the same weight.
      + `    <priority>${trail.national_trail ? '0.8' : '0.5'}</priority>\n`
      + `  </url>`
  }).join('\n')

  return xmlResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}${body ? '\n' : ''}</urlset>\n`,
  )
}
