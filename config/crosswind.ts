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
  ],
}

export default config
