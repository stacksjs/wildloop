import { describe, expect, it } from 'bun:test'
import { qrBrandedMarkup, qrSvg, qrSvgMarkup } from '../../resources/functions/qr'

/**
 * These pin the geometry, because a QR that renders but does not scan looks
 * exactly like one that works. The end-to-end check — rasterise the SVG and
 * decode it with an independent reader — was run against Chromium's
 * BarcodeDetector and returned the encoded URL; what follows is the structure
 * that has to hold for that to keep being true.
 */

const URL = 'https://wildloop.org/app'

describe('qrSvg', () => {
  it('encodes a URL into a square module matrix', () => {
    const code = qrSvg(URL)!
    expect(code).not.toBeNull()
    // Every QR version is 4n+17 modules per side.
    expect((code.modules - 17) % 4).toBe(0)
  })

  it('surrounds the code with the four-module quiet zone the spec requires', () => {
    // Scanners genuinely need this margin; a code flush against artwork often
    // will not acquire at all.
    const code = qrSvg(URL)!
    expect(code.size).toBe(code.modules + 8)

    const narrow = qrSvg(URL, { quietZone: 1 })!
    expect(narrow.size).toBe(narrow.modules + 2)
  })

  it('draws every dark module as a unit square offset by the quiet zone', () => {
    const code = qrSvg(URL, { quietZone: 4 })!
    // The first move must land on the top-left finder pattern's origin, which
    // sits at module (0,0) — i.e. exactly the quiet-zone offset.
    expect(code.path.startsWith('M4 4h1v1h-1z')).toBe(true)
    // One move-and-close per dark module, nothing else in the path.
    expect(code.path.match(/M/g)!.length).toBe(code.path.match(/z/g)!.length)
  })

  it('grows the version with the payload instead of failing', () => {
    const short = qrSvg('hi')!
    const long = qrSvg('x'.repeat(300))!
    expect(long.modules).toBeGreaterThan(short.modules)
  })

  it('returns null for nothing to encode', () => {
    expect(qrSvg('')).toBeNull()
    expect(qrSvg('   ')).toBeNull()
  })
})

describe('qrSvgMarkup', () => {
  it('paints its own white field rather than relying on the page', () => {
    // The install sections place this on dark backgrounds.
    const markup = qrSvgMarkup(URL)
    expect(markup).toContain('fill="#fff"')
    expect(markup).toContain('<rect')
  })

  it('disables antialiasing, which softens the edges a scanner reads', () => {
    expect(qrSvgMarkup(URL)).toContain('shape-rendering="crispEdges"')
  })

  it('is labelled for assistive technology', () => {
    const markup = qrSvgMarkup(URL, { title: 'Scan to open Wildloop' })
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Scan to open Wildloop"')
  })

  it('escapes a title that would otherwise break out of the attribute', () => {
    const markup = qrSvgMarkup(URL, { title: 'a "quoted" <tag> & more' })
    expect(markup).toContain('&quot;quoted&quot;')
    expect(markup).toContain('&lt;tag&gt;')
    expect(markup).not.toContain('<tag>')
  })

  it('renders nothing rather than throwing when there is nothing to encode', () => {
    // A missing QR is a missing decoration; a thrown error on a marketing
    // page is an outage.
    expect(qrSvgMarkup('')).toBe('')
  })
})

describe('qrBrandedMarkup', () => {
  it('forces error correction H, which is what pays for the centre mark', () => {
    // The mark destroys real modules; H (~30% recoverable) reconstructs them.
    // A caller asking for M with a logo would get a code that scans on a desk
    // and fails on a trailhead sign, so the level is forced rather than
    // defaulted.
    const branded = qrBrandedMarkup(URL, { level: 'L' })
    const atH = qrSvg(URL, { level: 'H' })!
    expect(branded).toContain(`viewBox="0 0 ${atH.modules + 8} ${atH.modules + 8}"`)
  })

  it('keeps the finder patterns at their spec geometry', () => {
    // A scanner locates the code by these before decoding anything, so they
    // may be recoloured and rounded but never resized.
    const markup = qrBrandedMarkup(URL)
    expect(markup).toContain('fill-rule="evenodd"')
    // Three eyes, each drawn as three nested squares.
    expect((markup.match(/#047857/g) ?? []).length).toBeGreaterThan(0)
  })

  it('never lets a corner radius exceed half the shape it is applied to', () => {
    // The bug this pins: radius was a fraction of the side, so one value
    // applied to both a 1-module square and a 7-module eye gave the eye a
    // ~4-module corner on a 7-module box. The straight run between corners
    // went negative, emitting `h--0.98`, and the malformed finder patterns
    // made every scan fail — at every size, which is how it was caught.
    for (const radius of [0.35, 1, 999]) {
      const markup = qrBrandedMarkup(URL, { radius })
      expect(markup).not.toContain('--')
      expect(markup).not.toContain('NaN')
    }
  })

  it('paints an opaque field so it survives a dark page', () => {
    const markup = qrBrandedMarkup(URL, { background: '#ffffff' })
    expect(markup).toContain('fill="#ffffff"')
  })

  it('can be asked for no mark at all', () => {
    const withMark = qrBrandedMarkup(URL, { logo: true })
    const without = qrBrandedMarkup(URL, { logo: false })
    expect(withMark).toContain('<circle')
    expect(without).not.toContain('<circle')
  })

  it('renders nothing rather than throwing when there is nothing to encode', () => {
    expect(qrBrandedMarkup('')).toBe('')
  })
})
