/**
 * Favicons and social cards, generated from the one source image.
 *
 * WildLoop shipped with no favicon at all — a browser tab showed the generic
 * page glyph — and one hand-made `og_image.jpeg` referenced by a relative
 * path, which no crawler resolves. Both are the kind of thing that is invisible
 * until the link is already in somebody's feed looking wrong.
 *
 * Everything here derives from `public/images/app/wildloop-app-icon.png` and
 * the marketing photography already in the repo, so there is one place to
 * change the brand and no set of icons that can drift out of agreement with
 * each other.
 *
 * Run: `bun scripts/build-brand-assets.ts`
 * Outputs are committed, because they are static and every request wants them.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { generateFavicons, generateSocialCard, loadFont } from 'ts-images'

const root = resolve(import.meta.dir, '..')
const SOURCE_ICON = resolve(root, 'public/images/app/wildloop-app-icon.png')
const FAVICON_DIR = resolve(root, 'public')
const SOCIAL_DIR = resolve(root, 'public/images/social')

/** The photograph the share card is composed over. */
const CARD_BACKGROUND = resolve(root, 'public/images/marketing/wildloop-ridge-runner.jpg')

/**
 * The card palette: emerald 400 on white over slate.
 *
 * `RGBA` is an object, not a tuple. A tuple type-checks against nothing here
 * and reads back as `{r: undefined…}` at draw time, which rasterises as black
 * — white copy laid over a dark photograph, in black. It looked like the text
 * had failed to draw at all.
 */
const ACCENT = { r: 52, g: 211, b: 153, a: 255 }
const INK = { r: 255, g: 255, b: 255, a: 255 }
const MUTED = { r: 226, g: 232, b: 240, a: 255 }

/**
 * The cards worth pre-rendering.
 *
 * One per surface a link actually gets pasted into, rather than one per page:
 * a card is a promise about what is behind the link, and four honest promises
 * beat forty generated ones. Per-entity cards (a single trail, a single
 * activity) are drawn on demand — see `renderSocialCard` in ts-images.
 */
const CARDS = [
  {
    file: 'og-default',
    eyebrow: 'WildLoop',
    title: 'Find your next adventure',
    subtitle: 'Half a million trails, live GPS tracking, and territory you can actually lose.',
  },
  {
    file: 'og-trails',
    eyebrow: 'Explore',
    title: 'Every trail we know',
    subtitle: 'Search the US, Germany, Austria and Switzerland by name, park, forest or Land.',
  },
  {
    file: 'og-territory',
    eyebrow: 'Territory',
    title: 'Close the loop, claim the ground',
    subtitle: 'Every closed loop you run takes turf — and somebody can always take it back.',
  },
  {
    file: 'og-clubs',
    eyebrow: 'Clubs',
    title: 'Train with a crew',
    subtitle: 'Find a club near you, or start the one you were looking for.',
  },
]

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * The faces the cards are set in.
 *
 * Bundled with the repo rather than fetched: a build that reaches the network
 * for a font is a build that fails on a plane, and the card would silently
 * come out in a face nobody chose.
 *
 * STATIC instances, not the variable file. ts-images draws a variable font's
 * default master and does not apply `gvar` deltas, so `Inter[wght].ttf` set to
 * 700 renders as Regular — the right glyphs at the wrong weight, with nothing
 * on screen to say so.
 */
async function loadFace(file: string) {
  const path = resolve(root, 'resources/assets/fonts', file)
  if (!existsSync(path))
    fail(`No font at ${path}. The social cards need one to draw their copy.`)

  return loadFont(new Uint8Array(await readFile(path)))
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_ICON))
    fail(`No source icon at ${SOURCE_ICON}.`)

  // Favicons. `manifest: false` because this project already ships a
  // hand-written `public/manifest.webmanifest` with its PWA start_url and
  // display mode in it; a second generated manifest would be a second answer
  // to the same question.
  const icons = await generateFavicons(SOURCE_ICON, FAVICON_DIR, {
    sizes: [16, 32, 48, 96, 180, 192, 512],
    manifest: false,
  })
  console.log(`✓ ${icons.length} favicon file(s) → public/`)

  await mkdir(SOCIAL_DIR, { recursive: true })
  const titleFont = await loadFace('InterDisplay-SemiBold.ttf')
  const bodyFont = await loadFace('Inter-Regular.ttf')

  for (const card of CARDS) {
    const output = resolve(SOCIAL_DIR, `${card.file}.jpg`)
    await mkdir(dirname(output), { recursive: true })

    await generateSocialCard(output, {
      background: existsSync(CARD_BACKGROUND) ? CARD_BACKGROUND : undefined,
      title: card.title,
      eyebrow: card.eyebrow,
      subtitle: card.subtitle,
      brand: 'wildloop.org',
      titleFont,
      bodyFont,
      width: 1200,
      height: 630,
      color: INK,
      accent: ACCENT,
      mutedColor: MUTED,
      format: 'jpeg',
      quality: 88,
    })

    console.log(`✓ ${card.file}.jpg`)
  }
}

await main()
