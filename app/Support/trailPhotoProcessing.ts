/**
 * Turn an uploaded photo into what Wildloop stores: a display image and a
 * thumbnail, both freshly encoded JPEGs.
 *
 * Re-encoding is the point. A phone photo carries EXIF, often including the
 * GPS position it was taken at, which for a photo taken at home is the
 * person's address. Decoding to pixels and encoding again writes a new file
 * with none of that. `decode` applies the EXIF orientation first, so the
 * stored image is upright even though the tag that said how to rotate it is
 * gone.
 *
 * Clients shrink a photo before sending it (the long edge to 2048px), which is
 * what keeps this affordable: re-encoding a 2048px JPEG took about 0.5s and
 * 250MB, a 12MP original about 2.4s and 600MB. Originals are still accepted,
 * within the limits below, for clients that cannot shrink.
 *
 * One photo is processed at a time per process, so several uploads arriving
 * together queue instead of multiplying that memory.
 */

import { detectMimeFromMagicBytes } from '@stacksjs/storage'
import { decode, encode, getMetadata, resize } from 'ts-images'

export const PHOTO_LIMITS = {
  /** A 12MP phone JPEG is about 3-5MB, so this leaves room for originals. */
  maxUploadBytes: 15 * 1024 * 1024,
  /** Checked from the header, before decoding, so a tiny file claiming huge dimensions is refused cheaply. */
  maxInputPixels: 50_000_000,
  displayEdge: 2048,
  thumbEdge: 640,
  displayQuality: 82,
  thumbQuality: 78,
} as const

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type PhotoRejection = 'empty' | 'too-large' | 'unsupported-type' | 'heic' | 'too-many-pixels' | 'unreadable'

export class PhotoRejectedError extends Error {
  constructor(readonly reason: PhotoRejection, message: string) {
    super(message)
    this.name = 'PhotoRejectedError'
  }
}

export interface ProcessedPhoto {
  display: Uint8Array
  thumb: Uint8Array
  width: number
  height: number
}

/** Scale to fit a long edge, never up. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number, height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Validate what can be checked without decoding. Throws PhotoRejectedError. */
export async function inspectUpload(bytes: Uint8Array): Promise<void> {
  if (!bytes || bytes.length === 0)
    throw new PhotoRejectedError('empty', 'The photo is empty.')
  if (bytes.length > PHOTO_LIMITS.maxUploadBytes)
    throw new PhotoRejectedError('too-large', 'The photo is larger than 15MB.')

  // The bytes decide the type, never the file name or the declared content type.
  const type = detectMimeFromMagicBytes(bytes)
  if (type === 'image/heic' || type === 'image/heif')
    throw new PhotoRejectedError('heic', 'HEIC photos are not supported. Please upload a JPEG.')
  if (!type || !ACCEPTED_TYPES.has(type))
    throw new PhotoRejectedError('unsupported-type', 'Photos must be JPEG, PNG or WebP.')

  let meta: { width: number, height: number }
  try {
    meta = await getMetadata(bytes)
  }
  catch {
    throw new PhotoRejectedError('unreadable', 'The photo could not be read.')
  }
  if (!(meta.width > 0 && meta.height > 0))
    throw new PhotoRejectedError('unreadable', 'The photo could not be read.')
  if (meta.width * meta.height > PHOTO_LIMITS.maxInputPixels)
    throw new PhotoRejectedError('too-many-pixels', 'The photo has too many pixels.')
}

let active = 0
let peak = 0

/** The most uploads ever processed at once in this process. Should stay 1. */
export function photoProcessingPeak(): number {
  return peak
}

async function tracked<T>(work: () => Promise<T>): Promise<T> {
  active++
  peak = Math.max(peak, active)
  try {
    return await work()
  }
  finally {
    active--
  }
}

async function processOne(bytes: Uint8Array): Promise<ProcessedPhoto> {
  await inspectUpload(bytes)

  let image
  try {
    image = await decode(bytes, { applyOrientation: true })
  }
  catch {
    throw new PhotoRejectedError('unreadable', 'The photo could not be read.')
  }

  const displaySize = fitWithin(image.width, image.height, PHOTO_LIMITS.displayEdge)
  const displayImage = displaySize.width === image.width && displaySize.height === image.height
    ? image
    : resize(image, displaySize as any)
  const display = await encode(displayImage, 'jpeg', { quality: PHOTO_LIMITS.displayQuality } as any)

  const thumbSize = fitWithin(image.width, image.height, PHOTO_LIMITS.thumbEdge)
  const thumb = await encode(resize(image, thumbSize as any), 'jpeg', { quality: PHOTO_LIMITS.thumbQuality } as any)

  return { display, thumb, width: displaySize.width, height: displaySize.height }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Run one piece of image work after whatever is already running. Shared by
 * every kind of upload (trail photos, avatars), so the one-at-a-time memory
 * ceiling holds across all of them.
 */
export function queuePhotoWork<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(() => tracked(work))
  queue = run.catch(() => undefined)
  return run
}

/** Process one upload. Calls made together run one after another. */
export function processTrailPhoto(bytes: Uint8Array): Promise<ProcessedPhoto> {
  return queuePhotoWork(() => processOne(bytes))
}
