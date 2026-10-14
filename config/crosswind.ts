import type { CrosswindOptions } from '@cwcss/crosswind'

/**
 * The typed config the CSS engine reads. `@cwcss/crosswind` is the package
 * that actually generates the stylesheet, so its own option type is the one
 * that can be trusted to match what the generator supports.
 */
const config: CrosswindOptions = {
  theme: {
    fontFamily: {
      sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      display: ['Outfit', 'system-ui', 'sans-serif'],
    },
  },

  shortcuts: {
    // No padding here: a shortcut is emitted after the utilities, so its
    // `p-5` beat any `p-0` on the same element and framed every map in a card.
    // The default padding lives in styles.stx at zero specificity instead.
    'card': 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl',
    'metric-label': 'text-xs uppercase tracking-wide font-medium text-gray-500 dark:text-slate-400',
    'nav-active': 'text-emerald-600 font-semibold',
    'gradient-bg': 'bg-gradient-to-r from-emerald-600 to-teal-600',
    'trail-map-panel': 'w-full h-[22rem] sm:h-[28rem] z-[1]',
    'trail-map-panel-lg': 'w-full h-[min(55vh,520px)] z-[1]',
    'ts-map-container': 'w-full min-h-[280px]',
    'route-preview': 'h-40 w-full rounded-xl overflow-hidden bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-slate-700 dark:to-slate-800 bg-cover bg-center',

    // Difficulty reads over a photograph, so these are solid chips rather than
    // the tinted pastels a chip on a white card can afford. Hue carries the
    // meaning; the white text is what makes it legible on a bright ridge line
    // or a black night sky alike.
    // Avatar tints, one per account rather than one per person's mood: see
    // resources/functions/avatars.ts, which picks by hashing the account id.
    // Each pair holds its contrast in both themes so the initial stays legible.
    'avatar-tint-0': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-100',
    'avatar-tint-1': 'bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-100',
    'avatar-tint-2': 'bg-amber-100 text-amber-900 dark:bg-amber-500/25 dark:text-amber-100',
    'avatar-tint-3': 'bg-rose-100 text-rose-800 dark:bg-rose-500/25 dark:text-rose-100',
    'avatar-tint-4': 'bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100',
    'avatar-tint-5': 'bg-teal-100 text-teal-800 dark:bg-teal-500/25 dark:text-teal-100',

    'difficulty-easy': 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950',
    'difficulty-moderate': 'bg-amber-500 text-amber-950 dark:bg-amber-400 dark:text-amber-950',
    'difficulty-hard': 'bg-rose-600 text-white dark:bg-rose-500 dark:text-white',
  },

  /**
   * Classes assembled at runtime.
   *
   * The scanner only sees literal class strings in the source. `difficulty-`
   * is built by concatenation (`'difficulty-' + trail.difficulty`), so none of
   * the three names ever appears whole in a template and the generator emitted
   * no rule for any of them — which is why every difficulty badge rendered as
   * bare text on the photo instead of a chip. Naming them here is what makes a
   * dynamically composed class real.
   */
  safelist: [
    'difficulty-easy',
    'difficulty-moderate',
    'difficulty-hard',
    // Picked by hash at runtime, so none of these ever appears whole in a
    // template either.
    'avatar-tint-0',
    'avatar-tint-1',
    'avatar-tint-2',
    'avatar-tint-3',
    'avatar-tint-4',
    'avatar-tint-5',
    // Icons named in code rather than markup, so the scanner never sees them:
    // a trail's features, notices and condition reports
    // (resources/functions/trail-features.ts, trail-conditions.ts)…
    'i-lucide-accessibility',
    'i-lucide-baby',
    'i-lucide-ban',
    'i-lucide-bike',
    'i-lucide-bird',
    'i-lucide-cloud-sun',
    'i-lucide-construction',
    'i-lucide-dog',
    'i-lucide-droplets',
    'i-lucide-fish',
    'i-lucide-flame',
    'i-lucide-flower-2',
    'i-lucide-footprints',
    'i-lucide-landmark',
    'i-lucide-mountain',
    'i-lucide-mountain-snow',
    'i-lucide-move-horizontal',
    'i-lucide-move-right',
    'i-lucide-rabbit',
    'i-lucide-rotate-cw',
    'i-lucide-route',
    'i-lucide-route-off',
    'i-lucide-sailboat',
    'i-lucide-share-2',
    'i-lucide-snowflake',
    'i-lucide-sparkles',
    'i-lucide-sun',
    'i-lucide-tent',
    'i-lucide-thermometer-sun',
    'i-lucide-thumbs-down',
    'i-lucide-thumbs-up',
    'i-lucide-tree-pine',
    'i-lucide-trees',
    'i-lucide-trending-up',
    'i-lucide-triangle',
    'i-lucide-waves',
    // …and the forecast's weather, which arrives from the API
    // (app/Support/trailForecast.ts).
    'i-lucide-cloud',
    'i-lucide-cloud-fog',
    'i-lucide-cloud-hail',
    'i-lucide-cloud-lightning',
    'i-lucide-cloud-rain',
    'i-lucide-cloud-rain-wind',
    'i-lucide-cloud-snow',
  ],

  /*
   * Route lines and contour grounds.
   *
   * Seven views carried byte-identical copies of these — every page that draws
   * a route preview, or a card standing in for a photo it does not have. A
   * route line that is emerald here and something else there is not a design
   * system.
   *
   * A preflight rather than a shortcut: `stroke`, `stroke-width` and `fill` on
   * an SVG child have no utility to shortcut to. And a preflight rather than
   * `styles.stx`, which is inlined into every page — putting 1.8KB there to
   * save it on seven views cost 3.1KB on every other page, measured. This
   * lands in the generated stylesheet, which is linked and cached once.
   */
  preflights: [
    {
      getCSS: () => `
/* Contour-tinted ground for a card with no photo. Four layouts, picked by
   id, so a grid of them reads as different places rather than one tile. */
.wl-topo {
  --topo-x: 78%;
  --topo-y: 28%;

  background-color: #eef3ef;
  background-image:
    radial-gradient(90% 120% at 12% 115%, rgb(16 185 129 / 0.12), transparent 60%),
    repeating-radial-gradient(ellipse 150% 110% at var(--topo-x) var(--topo-y), transparent 0 15px, rgb(15 70 45 / 0.08) 15px 16px),
    repeating-radial-gradient(ellipse 80% 60% at calc(100% - var(--topo-x)) calc(100% - var(--topo-y)), transparent 0 23px, rgb(15 70 45 / 0.045) 23px 24px);
}

.wl-topo-1 { --topo-x: 22%; --topo-y: 30%; }
.wl-topo-2 { --topo-x: 60%; --topo-y: 85%; }
.wl-topo-3 { --topo-x: 95%; --topo-y: 65%; }

.dark .wl-topo {
  background-color: #0f1a16;
  background-image:
    radial-gradient(90% 120% at 12% 115%, rgb(16 185 129 / 0.14), transparent 60%),
    repeating-radial-gradient(ellipse 150% 110% at var(--topo-x) var(--topo-y), transparent 0 15px, rgb(167 243 208 / 0.065) 15px 16px),
    repeating-radial-gradient(ellipse 80% 60% at calc(100% - var(--topo-x)) calc(100% - var(--topo-y)), transparent 0 23px, rgb(167 243 208 / 0.035) 23px 24px);
}

.wl-route-casing,
.wl-route-line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.wl-route-casing { stroke: #fff; stroke-width: 6; }
.wl-route-line { stroke: #059669; stroke-width: 3; }
.wl-route-start { fill: #10b981; stroke: #fff; stroke-width: 2; }
.wl-route-end { fill: #0f172a; stroke: #fff; stroke-width: 2; }

.dark .wl-route-casing { stroke: #0b1411; }
.dark .wl-route-line { stroke: #34d399; }
.dark .wl-route-start { stroke: #0b1411; }
.dark .wl-route-end { fill: #e2e8f0; stroke: #0b1411; }
`,
    },
  ],
}

export default config
