import { tsAnalytics } from '@ts-analytics/tracking/stx'
import { env } from '@stacksjs/env'

/**
 * The canonical origin.
 *
 * Open Graph and Twitter cards resolve `og:image` and `og:url` against
 * nothing — a relative `/images/og_image.jpeg` is simply dropped by every
 * crawler that reads it, which is how a site ends up with share previews that
 * are a bare link. Absolute URLs are not optional here, so the origin is
 * declared once and every tag below is built from it.
 */
const SITE_URL = 'https://wildloop.org'

const TITLE = 'WildLoop — Trail discovery and GPS tracking for runners and hikers'
const DESCRIPTION = 'Find and track trails for running and hiking, with live GPS, pace, splits, elevation, segments and a social feed. Every closed loop also claims territory.'
const OG_IMAGE = `${SITE_URL}/images/social/og-default.jpg`

export default {
  root: '.',
  pagesDir: 'resources/views',
  componentsDir: 'resources/components',
  layoutsDir: 'resources/layouts',

  site: {
    url: 'https://wildloop.org',
  },

  partialsDir: 'resources/components',

  css: './crosswind.ts',

  app: {
    head: {
      title: TITLE,
      meta: [
        { name: 'description', content: DESCRIPTION },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#059669' },
        // Crawlers are welcome; the large-preview hints are what make a link
        // to a trail render as a card rather than as a line of blue text.
        { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' },

        // Open Graph
        { property: 'og:site_name', content: 'WildLoop' },
        { property: 'og:title', content: TITLE },
        { property: 'og:description', content: DESCRIPTION },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: SITE_URL },
        { property: 'og:locale', content: 'en_US' },
        { property: 'og:image', content: OG_IMAGE },
        { property: 'og:image:type', content: 'image/jpeg' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: 'A runner on a ridge line at dawn, above WildLoop\u2019s name and tagline.' },

        // Twitter / X
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: TITLE },
        { name: 'twitter:description', content: DESCRIPTION },
        { name: 'twitter:image', content: OG_IMAGE },
        { name: 'twitter:image:alt', content: 'A runner on a ridge line at dawn, above WildLoop\u2019s name and tagline.' },

        // iOS home-screen install
        { name: 'apple-mobile-web-app-title', content: 'WildLoop' },
      ],
      link: [
        // Favicons, generated from the app icon by scripts/build-brand-assets.ts.
        // The .ico is the multi-resolution one older browsers and some feed
        // readers still ask for by its well-known path.
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
        { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
        // No global canonical: every page sets its own from `<script server>`,
        // and a site-wide one here wins the dedupe and tells a crawler that
        // /clubs and /trails are both really the homepage.

        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Outfit:wght@700;800;900&display=swap' },
      ],
      // This STX release injects `analytics` once per rendered fragment. Head
      // scripts are composed once for the final document, which keeps the
      // tracker to one load and one initial page view in native WebViews.
      script: tsAnalytics({
        appId: env.ANALYTICSHQ_APP_ID,
        apiEndpoint: 'https://analyticshq.org',
      }),
      bodyClass: 'min-h-screen flex flex-col bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100',
    },
    router: {
      container: 'main',

      /*
       * Cross-fade between pages instead of swapping them.
       *
       * The client router replaces the contents of `container` in place, which
       * without a transition is an instant repaint: the old page vanishes and
       * the new one appears mid-scroll, with nothing to tell the eye the two
       * are related. That reads as a glitch rather than a navigation.
       *
       * The browser's own View Transitions API does the tweening, so there is
       * no animation library and no layout shift, and browsers without it get
       * exactly the previous behaviour.
       */
      viewTransitions: true,
      viewTransitionDuration: 180,
    },
  },
}
