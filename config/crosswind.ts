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
    'card': 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl p-5',
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
  ],
}

export default config
