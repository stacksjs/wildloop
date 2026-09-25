import { describe, expect, it } from 'bun:test'
import { decode, encode, getMetadata } from 'ts-images'
import { AVATAR_LIMITS, centerSquare, processAvatar } from '../../app/Support/avatarProcessing'
import { PhotoRejectedError } from '../../app/Support/trailPhotoProcessing'

type Paint = (x: number, y: number, width: number, height: number) => [number, number, number]

const flat: Paint = () => [30, 140, 90]

/** A test image, encoded for real. */
async function makeImage(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg', paint: Paint = flat): Promise<Uint8Array> {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = paint(x, y, width, height)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return encode({ data, width, height, colorSpace: 'srgb', hasAlpha: false, bitDepth: 8 } as any, format, { quality: 92 } as any)
}

/** An EXIF APP1 segment with a GPS position in it, spliced in after SOI. */
function withGpsExif(jpeg: Uint8Array): Uint8Array {
  const tiff: number[] = []
  const u16 = (v: number) => tiff.push(v & 0xFF, (v >> 8) & 0xFF)
  const u32 = (v: number) => tiff.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF)
  const ifd0 = 8
  const gps = ifd0 + 2 + 12 + 4
  tiff.push(0x49, 0x49, 0x2A, 0x00)
  u32(ifd0)
  u16(1)
  u16(0x8825), u16(4), u32(1), u32(gps) // GPS IFD pointer
  u32(0)
  u16(1)
  u16(0x0001), u16(2), u32(2), tiff.push(0x4E, 0, 0, 0) // GPSLatitudeRef N
  u32(0)
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const length = exif.length + 2
  return new Uint8Array([...jpeg.slice(0, 2), 0xFF, 0xE1, (length >> 8) & 0xFF, length & 0xFF, ...exif, ...jpeg.slice(2)])
}

function hasExif(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length - 6; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78)
      return true
  }
  return false
}

describe('centerSquare', () => {
  it('takes the middle of a landscape or portrait image', () => {
    expect(centerSquare(400, 300)).toEqual({ left: 50, top: 0, size: 300 })
    expect(centerSquare(300, 500)).toEqual({ left: 0, top: 100, size: 300 })
    expect(centerSquare(256, 256)).toEqual({ left: 0, top: 0, size: 256 })
  })
})

describe('processAvatar', () => {
  it('crops to a centred square at the display and thumbnail sizes', async () => {
    // Green bands on the outer sixths of a 1200x800 image: exactly what a
    // centre crop to 800x800 cuts away, and what a squash would keep.
    const banded: Paint = x => (x < 200 || x >= 1000 ? [20, 220, 20] : [220, 30, 20])
    const result = await processAvatar(await makeImage(1200, 800, 'jpeg', banded))
    const display = await getMetadata(result.display)
    const thumb = await getMetadata(result.thumb)
    expect(result.size).toBe(AVATAR_LIMITS.displayEdge)
    expect([display.width, display.height]).toEqual([AVATAR_LIMITS.displayEdge, AVATAR_LIMITS.displayEdge])
    expect([thumb.width, thumb.height]).toEqual([AVATAR_LIMITS.thumbEdge, AVATAR_LIMITS.thumbEdge])
    expect(display.format).toBe('jpeg')

    const pixels = await decode(result.display)
    for (const x of [4, 256, 507]) {
      const i = (256 * pixels.width + x) * 4
      expect(pixels.data[i]).toBeGreaterThan(150) // red
      expect(pixels.data[i + 1]).toBeLessThan(90) // not green
    }
  })

  it('drops EXIF, and with it the GPS position', async () => {
    const original = withGpsExif(await makeImage(300, 300))
    expect(hasExif(original)).toBe(true)
    const result = await processAvatar(original)
    expect(hasExif(result.display)).toBe(false)
    expect(hasExif(result.thumb)).toBe(false)
  })

  it('never scales a small photo up', async () => {
    const result = await processAvatar(await makeImage(90, 120, 'png'))
    expect(result.size).toBe(90)
    expect((await getMetadata(result.display)).width).toBe(90)
    expect((await getMetadata(result.thumb)).width).toBe(90)
  })

  it('refuses what is not a photo', async () => {
    const reason = await processAvatar(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
      .then(() => null, error => (error instanceof PhotoRejectedError ? error.reason : String(error)))
    expect(reason).toBe('unsupported-type')
  })
})
