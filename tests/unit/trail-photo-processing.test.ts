import { describe, expect, it } from 'bun:test'
import { decode, encode, getMetadata } from 'ts-images'
import {
  fitWithin,
  inspectUpload,
  PHOTO_LIMITS,
  photoProcessingPeak,
  PhotoRejectedError,
  processTrailPhoto,
} from '../../app/Support/trailPhotoProcessing'

/** A solid-color test image, encoded for real. */
async function makeImage(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg'): Promise<Uint8Array> {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 30
    data[i + 1] = 140
    data[i + 2] = 90
    data[i + 3] = 255
  }
  return encode({ data, width, height, colorSpace: 'srgb', hasAlpha: false, bitDepth: 8 } as any, format, { quality: 90 } as any)
}

/**
 * Insert an EXIF APP1 segment carrying an orientation and a GPS position, the
 * way a phone camera writes them.
 */
function withExif(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff: number[] = []
  const u16 = (v: number) => tiff.push(v & 0xFF, (v >> 8) & 0xFF)
  const u32 = (v: number) => tiff.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF)
  const ifd0 = 8
  const gps = ifd0 + 2 + 2 * 12 + 4
  const values = gps + 2 + 4 * 12 + 4
  tiff.push(0x49, 0x49, 0x2A, 0x00)
  u32(ifd0)
  u16(2)
  u16(0x0112), u16(3), u32(1), u16(orientation), u16(0) // Orientation
  u16(0x8825), u16(4), u32(1), u32(gps) // GPS IFD pointer
  u32(0)
  u16(4)
  u16(0x0001), u16(2), u32(2), tiff.push(0x4E, 0, 0, 0) // GPSLatitudeRef N
  u16(0x0002), u16(5), u32(3), u32(values) // GPSLatitude
  u16(0x0003), u16(2), u32(2), tiff.push(0x57, 0, 0, 0) // GPSLongitudeRef W
  u16(0x0004), u16(5), u32(3), u32(values + 24) // GPSLongitude
  u32(0)
  for (const [n, d] of [[37, 1], [46, 1], [2964, 100], [122, 1], [25, 1], [984, 100]]) {
    u32(n)
    u32(d)
  }
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const length = exif.length + 2
  const segment = [0xFF, 0xE1, (length >> 8) & 0xFF, length & 0xFF, ...exif]
  return new Uint8Array([...jpeg.slice(0, 2), ...segment, ...jpeg.slice(2)])
}

function hasExif(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length - 6; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78)
      return true
  }
  return false
}

async function rejection(bytes: Uint8Array): Promise<string | null> {
  try {
    await inspectUpload(bytes)
    return null
  }
  catch (error) {
    return error instanceof PhotoRejectedError ? error.reason : `unexpected: ${error}`
  }
}

describe('fitWithin', () => {
  it('scales the long edge down to the limit and keeps the proportions', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(3024, 4032, 640)).toEqual({ width: 480, height: 640 })
  })

  it('never scales a small image up', () => {
    expect(fitWithin(300, 200, 2048)).toEqual({ width: 300, height: 200 })
  })
})

describe('inspectUpload', () => {
  it('accepts JPEG and PNG', async () => {
    expect(await rejection(await makeImage(20, 10))).toBeNull()
    expect(await rejection(await makeImage(20, 10, 'png'))).toBeNull()
  })

  it('refuses an empty or oversized file before looking inside it', async () => {
    expect(await rejection(new Uint8Array(0))).toBe('empty')
    const huge = new Uint8Array(PHOTO_LIMITS.maxUploadBytes + 1)
    huge.set([0xFF, 0xD8, 0xFF])
    expect(await rejection(huge)).toBe('too-large')
  })

  it('decides the type from the bytes, and names HEIC so the client can say why', async () => {
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6D, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63])
    expect(await rejection(heic)).toBe('heic')
    expect(await rejection(new TextEncoder().encode('%PDF-1.7 not a photo'))).toBe('unsupported-type')
    expect(await rejection(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBe('unsupported-type')
  })

  it('refuses a file that claims enormous dimensions, without decoding it', async () => {
    // A 33-byte PNG header whose IHDR claims 50000 x 50000.
    const bomb = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0xC3, 0x50, 0, 0, 0xC3, 0x50, 8, 6, 0, 0, 0, 0, 0, 0, 0])
    expect(await rejection(bomb)).toBe('too-many-pixels')
  })
})

describe('processTrailPhoto', () => {
  it('stores the photo upright and without its EXIF, GPS position included', async () => {
    // 40 wide by 20 tall, tagged to be displayed rotated 90 degrees.
    const upload = withExif(await makeImage(40, 20), 6)
    expect(hasExif(upload)).toBe(true)

    const result = await processTrailPhoto(upload)

    expect({ width: result.width, height: result.height }).toEqual({ width: 20, height: 40 })
    expect(hasExif(result.display)).toBe(false)
    expect(hasExif(result.thumb)).toBe(false)
    expect(await getMetadata(result.display)).toMatchObject({ format: 'jpeg', width: 20, height: 40 })
  })

  it('shrinks a large photo to the display and thumbnail sizes', async () => {
    const result = await processTrailPhoto(await makeImage(3000, 1000))

    expect({ width: result.width, height: result.height }).toEqual({ width: 2048, height: 683 })
    const thumb = await decode(result.thumb)
    expect({ width: thumb.width, height: thumb.height }).toEqual({ width: 640, height: 213 })
  })

  it('converts a PNG to JPEG', async () => {
    const result = await processTrailPhoto(await makeImage(30, 30, 'png'))
    expect(await getMetadata(result.display)).toMatchObject({ format: 'jpeg' })
  })

  it('never holds more than one upload in memory at once', async () => {
    // Completion order cannot show this: the codecs run synchronously, so a
    // small photo never overtakes a large one either way. What the queue
    // prevents is two decoded images being alive together, which happens
    // whenever a second upload starts while the first is between steps.
    const uploads = await Promise.all([makeImage(1200, 800), makeImage(600, 400), makeImage(20, 20)])
    await Promise.all(uploads.map(upload => processTrailPhoto(upload)))
    expect(photoProcessingPeak()).toBe(1)
  })

  it('keeps working after a rejected upload', async () => {
    await expect(processTrailPhoto(new Uint8Array(0))).rejects.toBeInstanceOf(PhotoRejectedError)
    const result = await processTrailPhoto(await makeImage(10, 10))
    expect(result.width).toBe(10)
  })
})
