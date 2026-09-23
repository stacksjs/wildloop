import { QRErrorCorrectLevel, toMatrix } from 'ts-qr-codes'

/**
 * Render a QR code as an inline SVG.
 *
 * `ts-qr-codes` gives us the module matrix; drawing it is left to us on
 * purpose. An SVG rather than a canvas means the code is resolution
 * independent — it stays crisp on a Retina laptop and in a print stylesheet —
 * needs no DOM to produce, so it survives a server render, and costs a few
 * kilobytes of markup instead of a rasterised image.
 *
 * Everything decorative here is constrained by one fact: a QR is read by a
 * camera, and every stylistic liberty costs some of the margin that makes it
 * readable. The rules that keep that margin are marked as such below — they
 * are not cosmetic preferences.
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H'

export interface QrOptions {
  /**
   * Modules of empty space around the code. The spec calls for 4 and scanners
   * genuinely need it: a QR flush against surrounding artwork often will not
   * acquire. Do not lower this without testing on a real phone.
   */
  quietZone?: number
  /** Error-correction level. M (~15% recoverable) is the usual default. */
  level?: QrLevel
}

export interface QrSvg {
  /** The `d` attribute for a single `<path>`, in module units. */
  path: string
  /** Width/height of the viewBox, in module units, including the quiet zone. */
  size: number
  /** Modules per side, excluding the quiet zone. */
  modules: number
}

const LEVELS = {
  L: QRErrorCorrectLevel.L,
  M: QRErrorCorrectLevel.M,
  Q: QRErrorCorrectLevel.Q,
  H: QRErrorCorrectLevel.H,
} as const

function matrixFor(text: string, level: QrLevel): boolean[][] | null {
  const value = text.trim()
  if (!value)
    return null

  try {
    const matrix = toMatrix(value, LEVELS[level])
    return matrix.length ? matrix : null
  }
  catch {
    return null
  }
}

/**
 * Build plain square-module SVG geometry for `text`.
 *
 * Returns null rather than throwing when the text cannot be encoded — a URL
 * too long for the largest version, or an empty string. A missing QR is a
 * missing decoration; a thrown error from a marketing page is an outage.
 */
export function qrSvg(text: string, options: QrOptions = {}): QrSvg | null {
  const matrix = matrixFor(text, options.level ?? 'M')
  if (!matrix)
    return null

  const quietZone = options.quietZone ?? 4
  const modules = matrix.length

  // `h1v1h-1z` closes a unit square from the move point, so each dark module
  // costs about 12 bytes and the renderer sees one path.
  let path = ''
  for (let row = 0; row < modules; row++) {
    const line = matrix[row]!
    for (let col = 0; col < modules; col++) {
      if (line[col])
        path += `M${col + quietZone} ${row + quietZone}h1v1h-1z`
    }
  }

  return { path, size: modules + quietZone * 2, modules }
}

/**
 * A complete `<svg>` string for `text`, ready to drop into a template.
 *
 * `shape-rendering="crispEdges"` matters: without it the renderer antialiases
 * every module edge, which softens the black/white boundary a scanner is
 * looking for.
 */
export function qrSvgMarkup(
  text: string,
  options: QrOptions & { title?: string, class?: string } = {},
): string {
  const code = qrSvg(text, options)
  if (!code)
    return ''

  const title = options.title ?? `QR code for ${text}`
  const className = options.class ? ` class="${escapeAttribute(options.class)}"` : ''

  return [
    `<svg viewBox="0 0 ${code.size} ${code.size}" xmlns="http://www.w3.org/2000/svg"`,
    ` role="img" aria-label="${escapeAttribute(title)}" shape-rendering="crispEdges"${className}>`,
    // The light modules are drawn, not left transparent: a QR over a coloured
    // or dark background needs its own white field to be readable at all.
    `<rect width="${code.size}" height="${code.size}" fill="#fff"/>`,
    `<path d="${code.path}" fill="#0b1b15"/>`,
    '</svg>',
  ].join('')
}

/* -------------------------------------------------------------------------
 * Branded rendering
 * ---------------------------------------------------------------------- */

export interface QrBrandOptions extends QrOptions {
  title?: string
  class?: string
  /** Colour of the data modules. Must stay dark against `background`. */
  color?: string
  /** Colour of the three finder patterns, so the mark reads as ours. */
  eyeColor?: string
  /** The field the code is printed on. Never transparent — see below. */
  background?: string
  /**
   * Place the Wildloop mark in the middle. This is what error correction H
   * buys us: the covered modules are reconstructed from the redundancy.
   */
  logo?: boolean
  /**
   * Corner radius of a data module, as a fraction of one module (0 = square).
   * Past roughly 0.35 the module's dark area shrinks enough to start costing
   * contrast at small print sizes.
   */
  radius?: number
}

/** Modules covered by the mark, as a fraction of the code's width. */
const LOGO_SPAN = 0.28

/**
 * A branded QR: rounded modules, Wildloop-green finder patterns, and the ring
 * mark in the middle.
 *
 * Three constraints hold this together, and all three are about whether a
 * phone can read it rather than how it looks:
 *
 *   1. Error correction is forced to H (~30% of the code recoverable). The
 *      centre mark destroys real modules; H is what reconstructs them. A
 *      branded code at the default M level scans until it doesn't — usually
 *      in poor light, which is exactly when someone is scanning a sign.
 *   2. The finder patterns keep their exact geometry — 7x7 ring, one module
 *      of white, 3x3 centre. They may be recoloured and their corners
 *      rounded, but not resized or restyled: this is the shape a scanner
 *      locates the code by, before it decodes anything.
 *   3. The quiet zone stays at four modules.
 */
export function qrBrandedMarkup(text: string, options: QrBrandOptions = {}): string {
  // Level is forced, not defaulted — a caller passing 'M' with a logo would
  // get a code that scans on a desk and fails on a trailhead sign.
  const matrix = matrixFor(text, 'H')
  if (!matrix)
    return ''

  const quietZone = options.quietZone ?? 4
  const color = options.color ?? '#0b1b15'
  const eyeColor = options.eyeColor ?? '#047857'
  const background = options.background ?? '#ffffff'
  const radius = Math.min(Math.max(options.radius ?? 0.22, 0), 0.35)
  const withLogo = options.logo ?? true

  const modules = matrix.length
  const size = modules + quietZone * 2

  // The knockout is centred and sized in whole modules, so the mark never
  // clips a module in half and leaves a sliver a scanner has to interpret.
  const logoSpan = withLogo ? Math.max(5, Math.round(modules * LOGO_SPAN) | 1) : 0
  const logoStart = Math.floor((modules - logoSpan) / 2)
  const logoEnd = logoStart + logoSpan

  const inLogo = (row: number, col: number): boolean =>
    withLogo && row >= logoStart && row < logoEnd && col >= logoStart && col < logoEnd

  // The 7x7 finder patterns, drawn separately so they can be styled as a unit.
  const eyeOrigins: Array<[number, number]> = [[0, 0], [0, modules - 7], [modules - 7, 0]]
  const inEye = (row: number, col: number): boolean =>
    eyeOrigins.some(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7)

  let data = ''
  for (let row = 0; row < modules; row++) {
    const line = matrix[row]!
    for (let col = 0; col < modules; col++) {
      if (!line[col] || inEye(row, col) || inLogo(row, col))
        continue
      data += roundedSquare(col + quietZone, row + quietZone, 1, radius)
    }
  }

  const eyes = eyeOrigins
    .map(([r, c]) => finderPattern(c + quietZone, r + quietZone, radius))
    .join('')

  const logo = withLogo
    ? brandMark(logoStart + quietZone, logoSpan, eyeColor, background)
    : ''

  const title = options.title ?? `QR code for ${text}`
  const className = options.class ? ` class="${escapeAttribute(options.class)}"` : ''

  return [
    `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"`,
    ` role="img" aria-label="${escapeAttribute(title)}"${className}>`,
    // Never transparent: a code that borrows a dark page background has no
    // light modules and cannot be read at all.
    `<rect width="${size}" height="${size}" fill="${background}" rx="${(size * 0.04).toFixed(2)}"/>`,
    `<path d="${data}" fill="${color}"/>`,
    `<path d="${eyes}" fill="${eyeColor}" fill-rule="evenodd"/>`,
    logo,
    '</svg>',
  ].join('')
}

/**
 * One square with rounded corners, or a plain one when the radius is 0.
 *
 * `radius` is in MODULE UNITS, not a fraction of the side — a fraction is the
 * obvious API and it is a trap: the same value applied to a 1-module data
 * square and a 7-module finder pattern yields a corner radius larger than half
 * the eye's side, and the resulting path is malformed. Clamped here so that is
 * unrepresentable.
 */
function roundedSquare(x: number, y: number, side: number, radius: number): string {
  const r = +Math.min(Math.max(radius, 0), side / 2).toFixed(4)
  if (r <= 0)
    return `M${x} ${y}h${side}v${side}h-${side}z`

  const straight = +(side - r * 2).toFixed(4)
  return (
    `M${+(x + r).toFixed(4)} ${y}`
    + `h${straight}a${r} ${r} 0 0 1 ${r} ${r}`
    + `v${straight}a${r} ${r} 0 0 1 -${r} ${r}`
    + `h-${straight}a${r} ${r} 0 0 1 -${r} -${r}`
    + `v-${straight}a${r} ${r} 0 0 1 ${r} -${r}z`
  )
}

/**
 * A finder pattern: 7x7 outer ring, one module of background, 3x3 centre.
 *
 * Drawn as outer-minus-inner with `fill-rule="evenodd"`, which cuts the ring
 * out cleanly regardless of what is painted behind it. The proportions are
 * fixed by the spec and a scanner locates the whole code by them — only the
 * corner radius is ours to choose.
 */
function finderPattern(x: number, y: number, radius: number): string {
  // Scaled to each ring's own size so the three stay visually concentric.
  return (
    roundedSquare(x, y, 7, radius * 7 * 0.42)
    + roundedSquare(x + 1, y + 1, 5, radius * 5 * 0.42)
    + roundedSquare(x + 2, y + 2, 3, radius * 3 * 0.42)
  )
}

/**
 * The Wildloop mark: a closed ring with the runner's position on it, the same
 * mark the navbar draws. It sits on its own background plate, so the modules
 * it covers read as deliberately absent rather than as damage.
 */
function brandMark(offset: number, span: number, color: string, background: string): string {
  const centre = +(offset + span / 2).toFixed(4)
  // The plate covers the full knockout so the mark sits in clean space rather
  // than among half-cropped modules.
  const plate = +(span * 0.54).toFixed(4)
  const ring = +(span * 0.3).toFixed(4)
  const stroke = +(span * 0.13).toFixed(4)
  const dot = +(span * 0.115).toFixed(4)

  return [
    `<circle cx="${centre}" cy="${centre}" r="${plate}" fill="${background}"/>`,
    `<circle cx="${centre}" cy="${centre}" r="${ring}" fill="none"`,
    ` stroke="${color}" stroke-width="${stroke}"/>`,
    // The runner's position on the loop, same as the navbar mark. Drawn over
    // the ring rather than beside it, so it reads at 24px.
    `<circle cx="${centre}" cy="${+(centre - ring).toFixed(4)}" r="${dot}" fill="${color}"`,
    ` stroke="${background}" stroke-width="${+(span * 0.035).toFixed(4)}"/>`,
  ].join('')
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
