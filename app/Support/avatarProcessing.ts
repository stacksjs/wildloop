/**
 * Turn an uploaded profile photo into what Wildloop stores: a square display
 * image and a square thumbnail, both freshly encoded JPEGs.
 *
 * The same pipeline as trail photos (app/Support/trailPhotoProcessing.ts):
 * the bytes decide the type, the header is checked before decoding, the
 * image is decoded with its EXIF orientation applied and then encoded again,
 * which leaves the GPS position and every other tag behind. It also shares
 * that pipeline's queue, so an avatar and a trail photo never decode at once.
 *
 * What differs is the shape. A face is shown in a circle everywhere, so the
 * photo is cropped to its centre square once, here, rather than by every
 * `<img>` that shows it.
 */

import { crop, decode, encode, resize } from 'ts-images'
import { inspectUpload, PhotoRejectedError, queuePhotoWork } from './trailPhotoProcessing'

export const AVATAR_LIMITS = {
  /** Sharp on a 3x screen at the largest size a profile header shows it (~160px). */
  displayEdge: 512,
  /** Lists, cards and the nav show faces at 24-48px. */
  thumbEdge: 128,
  displayQuality: 85,
  thumbQuality: 80,
} as const

export interface ProcessedAvatar {
  display: Uint8Array
  thumb: Uint8Array
  /** The display image's edge, in pixels. It is square. */
  size: number
}

/** The largest centred square inside a width x height image. */
export function centerSquare(width: number, height: number): { left: number, top: number, size: number } {
  const size = Math.max(1, Math.min(width, height))
  return {
    left: Math.max(0, Math.floor((width - size) / 2)),
    top: Math.max(0, Math.floor((height - size) / 2)),
    size,
  }
}

async function processOne(bytes: Uint8Array): Promise<ProcessedAvatar> {
  await inspectUpload(bytes)

  let image
  try {
    image = await decode(bytes, { applyOrientation: true })
  }
  catch {
    throw new PhotoRejectedError('unreadable', 'The photo could not be read.')
  }

  const square = centerSquare(image.width, image.height)
  const cropped = square.size === image.width && square.size === image.height
    ? image
    : crop(image, { left: square.left, top: square.top, width: square.size, height: square.size })

  // Never scaled up: a small photo stays its own size rather than turning soft.
  const displayEdge = Math.min(square.size, AVATAR_LIMITS.displayEdge)
  const displayImage = displayEdge === square.size ? cropped : resize(cropped, { width: displayEdge, height: displayEdge })
  const display = await encode(displayImage, 'jpeg', { quality: AVATAR_LIMITS.displayQuality } as any)

  const thumbEdge = Math.min(square.size, AVATAR_LIMITS.thumbEdge)
  const thumbImage = thumbEdge === square.size ? cropped : resize(cropped, { width: thumbEdge, height: thumbEdge })
  const thumb = await encode(thumbImage, 'jpeg', { quality: AVATAR_LIMITS.thumbQuality } as any)

  return { display, thumb, size: displayEdge }
}

/** Process one profile photo. Throws PhotoRejectedError for a file it refuses. */
export function processAvatar(bytes: Uint8Array): Promise<ProcessedAvatar> {
  return queuePhotoWork(() => processOne(bytes))
}
