/**
 * Per-record page metadata, applied after the record loads.
 *
 * ## Why this is client-side
 *
 * The obvious place is a `<script server>` block, the way the static pages do
 * it. It does not work for a detail page. `app/ProductionServer.ts` runs the
 * views server with `renderCacheVary: 'source'`, which keys the render cache
 * by FILE PATH alone — one cached render of `trail/[id].stx` is served for
 * every trail. Per-record meta in that render would mean whichever trail
 * happened to be rendered first supplying the title for all ~600k of them,
 * which is worse than a generic title, not better. Varying by request instead
 * keys on the whole request context (cookies and IP included), so it caches
 * per visitor and stops being a cache.
 *
 * So the record's own metadata is written on the client once the data is in.
 * Googlebot renders JavaScript and indexes what it sees afterwards, which is
 * what the duplicate-title problem needs.
 *
 * ## What this cannot fix
 *
 * Social scrapers — Twitter, Slack, Facebook, iMessage — do NOT run JavaScript.
 * They read the served HTML, so `og:` tags stay whatever the shell carries and
 * every shared trail link previews identically. Fixing that needs the shell
 * rendered per record, which is a framework-level change to how the views
 * server caches. Worth doing; not something to fake from here.
 */

interface PageSeo {
  title: string
  description?: string
  /** Absolute or root-relative; stored absolute, which is what a crawler needs. */
  canonical?: string
}

const SITE = 'https://wildloop.org'

function upsertMeta(selector: string, create: () => HTMLMetaElement, content: string): void {
  if (typeof document === 'undefined')
    return

  const existing = document.head.querySelector<HTMLMetaElement>(selector)
  const element = existing ?? document.head.appendChild(create())
  element.content = content
}

/**
 * Apply a record's metadata to the document.
 *
 * Safe to call repeatedly — every tag is updated in place rather than
 * appended, so a page that re-renders does not accumulate duplicates, which is
 * the failure mode that makes a crawler pick an arbitrary one of them.
 */
export function setPageSeo(seo: PageSeo): void {
  if (typeof document === 'undefined')
    return

  document.title = seo.title

  if (seo.description) {
    upsertMeta('meta[name="description"]', () => {
      const meta = document.createElement('meta')
      meta.name = 'description'
      return meta
    }, seo.description)

    // og:/twitter: are updated too. A scraper will not see them, but an
    // in-page share sheet reading the live DOM will, and leaving them
    // contradicting the title is worse than leaving them alone.
    upsertMeta('meta[property="og:description"]', () => {
      const meta = document.createElement('meta')
      meta.setAttribute('property', 'og:description')
      return meta
    }, seo.description)
  }

  upsertMeta('meta[property="og:title"]', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('property', 'og:title')
    return meta
  }, seo.title)

  if (seo.canonical) {
    const href = seo.canonical.startsWith('http') ? seo.canonical : `${SITE}${seo.canonical}`
    const existing = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    const link = existing ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }))
    link.href = href

    upsertMeta('meta[property="og:url"]', () => {
      const meta = document.createElement('meta')
      meta.setAttribute('property', 'og:url')
      return meta
    }, href)
  }
}

/** `Gabrielino NRT — Angeles National Forest, CA | WildLoop` */
export function recordTitle(name: string, context?: string | null): string {
  return context ? `${name} — ${context} | WildLoop` : `${name} | WildLoop`
}
