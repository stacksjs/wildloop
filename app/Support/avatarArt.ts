/**
 * A face for an athlete who has no photo: their initials on a topographic
 * map drawn from their name.
 *
 * The seeded athletes are real people, and a stock photo of a stranger under
 * a real name is worse than no photo at all. This is unmistakably not a
 * photograph, and still distinct per person: the colours, the peak the
 * contour lines circle and the way they bend all come from a hash of the
 * seed, so the same person gets the same picture on every run and every
 * machine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Font, ImageData, RGBA } from 'ts-images'
import { createImageData, drawLine, drawText, encode, fillLinearGradient, fillRadialGradient, layoutText, loadFont } from 'ts-images'

/** Bump to redraw every generated avatar on the next seed. */
export const AVATAR_ART_VERSION = 1

/** Two-stop gradients, outdoors-coloured: forest, lake, dusk, canyon, alpine, heath. */
const PALETTES: Array<[string, string]> = [
  ['#065f46', '#34d399'],
  ['#0c4a6e', '#38bdf8'],
  ['#312e81', '#a78bfa'],
  ['#7c2d12', '#fb923c'],
  ['#134e4a', '#5eead4'],
  ['#4c1d95', '#f472b6'],
  ['#14532d', '#a3e635'],
  ['#1e3a8a', '#22d3ee'],
]

/** Up to two letters: the first and last word of the name. */
export function avatarInitials(name: string): string {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0)
    return '·'
  const first = [...words[0]][0] ?? ''
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : ''
  return `${first}${last}`.toUpperCase()
}

/** A small deterministic PRNG (mulberry32) seeded from a string hash. */
function randomFrom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let state = h >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hex(value: string, a = 1): RGBA {
  const n = Number.parseInt(value.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a }
}

const FONT = 'resources/assets/fonts/InterDisplay-SemiBold.ttf'
let cachedFont: Font | null = null

/** The site's display face, from the project root or relative to this file. */
function displayFont(): Font {
  if (cachedFont)
    return cachedFont
  const path = [join(process.cwd(), FONT), join(import.meta.dir, '..', '..', FONT)].find(candidate => existsSync(candidate))
  if (!path)
    throw new Error(`Avatar art needs ${FONT}.`)
  cachedFont = loadFont(new Uint8Array(readFileSync(path)))
  return cachedFont
}

/** Draw the avatar as pixels. Square, `size` on a side. */
export function drawAvatarArt(name: string, seed: string, size = 512): ImageData {
  const random = randomFrom(`${seed}:${AVATAR_ART_VERSION}`)
  const [from, to] = PALETTES[Math.floor(random() * PALETTES.length)]
  const image = createImageData(size, size, { fill: hex(from) })

  fillLinearGradient(image, { x: 0, y: 0, width: size, height: size }, [
    { offset: 0, color: hex(from) },
    { offset: 1, color: hex(to) },
  ], { angle: 20 + random() * 50 })

  // The summit the lines circle, somewhere off-centre so the initials sit on
  // a slope rather than a bullseye.
  const cx = size * (0.2 + random() * 0.6)
  const cy = size * (0.2 + random() * 0.6)
  fillRadialGradient(image, { cx, cy, radius: size * 0.55 }, [
    { offset: 0, color: { r: 255, g: 255, b: 255, a: 0.22 } },
    { offset: 1, color: { r: 255, g: 255, b: 255, a: 0 } },
  ])

  // Contour lines: rings around the summit, each bent by the same two
  // harmonics so they read as one landform, spaced like a real map.
  const phase1 = random() * Math.PI * 2
  const phase2 = random() * Math.PI * 2
  const bend1 = 0.12 + random() * 0.12
  const bend2 = 0.05 + random() * 0.08
  const spacing = size * (0.055 + random() * 0.02)
  const steps = 160
  const line = { r: 255, g: 255, b: 255, a: 0.2 }
  for (let ring = 1; ring * spacing < size * 1.4; ring++) {
    const radius = ring * spacing
    const wobble = 1 + ring * 0.015
    let previous: { x: number, y: number } | null = null
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2
      const r = radius * (1 + bend1 * Math.sin(2 * angle + phase1) * wobble + bend2 * Math.sin(3 * angle + phase2))
      const point = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
      if (previous)
        drawLine(image, { x1: previous.x, y1: previous.y, x2: point.x, y2: point.y, width: ring % 5 === 0 ? 3 : 1.6 }, line)
      previous = point
    }
  }

  const initials = avatarInitials(name)
  const font = displayFont()
  const fontSize = Math.round(size * (initials.length > 1 ? 0.38 : 0.46))
  const width = layoutText({ text: initials, font, size: fontSize }).width
  // `y` is the baseline. Inter's capitals stand 0.727em tall, so this puts
  // their middle on the middle of the square.
  const x = Math.round((size - width) / 2)
  const y = Math.round(size / 2 + fontSize * 0.727 / 2)
  drawText(image, { text: initials, font, size: fontSize, x: x + size * 0.006, y: y + size * 0.01, color: { r: 0, g: 0, b: 0, a: 0.18 } })
  drawText(image, { text: initials, font, size: fontSize, x, y, color: { r: 255, g: 255, b: 255, a: 1 } })

  return image
}

/** The avatar as a JPEG, ready for the avatar pipeline. */
export async function renderAvatarArt(name: string, seed: string, size = 512): Promise<Uint8Array> {
  return encode(drawAvatarArt(name, seed, size), 'jpeg', { quality: 92 } as any)
}
