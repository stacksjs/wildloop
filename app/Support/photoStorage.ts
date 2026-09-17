/**
 * Where trail photos are kept: local disk in development, S3 in production.
 *
 * Photos get their own settings rather than the framework's default disk, so
 * turning them on changes nothing else, and so production can use a key that
 * can only reach the photo bucket.
 *
 *   PHOTOS_DISK                   local (default) or s3
 *   PHOTOS_LOCAL_ROOT             local only; defaults to storage/app/photos
 *   PHOTOS_S3_BUCKET              s3 only, e.g. wildloop-trail-photos
 *   PHOTOS_S3_REGION              s3 only; defaults to us-east-1
 *   PHOTOS_S3_PREFIX              s3 only; defaults to "<APP_ENV>/", so
 *                                 environments sharing a bucket never mix
 *   PHOTOS_S3_ACCESS_KEY_ID       s3 only
 *   PHOTOS_S3_SECRET_ACCESS_KEY   s3 only
 *
 * The bucket is private. Photos are read through the app, never linked
 * straight to S3.
 */

import type { StorageAdapter } from '@stacksjs/storage'
import { createLocalStorage, createS3Storage } from '@stacksjs/storage'

type Env = Record<string, string | undefined>

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PHOTO_KEY = new RegExp(`^trails/[1-9][0-9]{0,9}/${UUID}(-thumb)?\\.jpg$`)

export class PhotoStorageNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Photo storage is set to s3 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`)
    this.name = 'PhotoStorageNotConfiguredError'
  }
}

/** The storage keys for one photo's display image and thumbnail. */
export function photoKeys(trailId: number, uuid: string): { display: string, thumb: string } {
  const base = `trails/${trailId}/${uuid}`
  if (!isPhotoKey(`${base}.jpg`))
    throw new Error('A photo key needs a positive trail id and a lowercase UUID.')
  return { display: `${base}.jpg`, thumb: `${base}-thumb.jpg` }
}

/**
 * Whether a string is a key this app could have written. The photo route
 * serves nothing else, so no path can reach other files on the disk.
 */
export function isPhotoKey(key: string): boolean {
  return PHOTO_KEY.test(key)
}

/** The S3 key prefix, always ending in exactly one slash. */
export function photoStoragePrefix(env: Env): string {
  const raw = (env.PHOTOS_S3_PREFIX ?? '').trim() || `${(env.APP_ENV ?? '').trim() || 'development'}/`
  return `${raw.replace(/^\/+|\/+$/g, '')}/`
}

/** Environments where local disk is not durable: every deploy replaces the release folder. */
const DEPLOYED_ENVIRONMENTS = new Set(['production', 'staging'])

export function createPhotoStorage(env: Env): StorageAdapter {
  const disk = (env.PHOTOS_DISK ?? 'local').trim().toLowerCase()
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase()

  // A deployed server keeps its local files inside the release folder, which
  // the next deploy replaces. Photos written there would vanish while their
  // rows remained, so refuse instead of losing them.
  if (disk !== 's3' && DEPLOYED_ENVIRONMENTS.has(appEnv))
    throw new PhotoStorageNotConfiguredError([`PHOTOS_DISK=s3 (local disk does not survive a deploy in ${appEnv})`])

  if (disk === 's3') {
    const required = ['PHOTOS_S3_BUCKET', 'PHOTOS_S3_ACCESS_KEY_ID', 'PHOTOS_S3_SECRET_ACCESS_KEY']
    const missing = required.filter(name => !(env[name] ?? '').trim())
    if (missing.length > 0)
      throw new PhotoStorageNotConfiguredError(missing)

    return createS3Storage(null, {
      bucket: env.PHOTOS_S3_BUCKET!.trim(),
      region: (env.PHOTOS_S3_REGION ?? '').trim() || 'us-east-1',
      prefix: photoStoragePrefix(env),
      credentials: {
        accessKeyId: env.PHOTOS_S3_ACCESS_KEY_ID!.trim(),
        secretAccessKey: env.PHOTOS_S3_SECRET_ACCESS_KEY!.trim(),
      },
    })
  }

  return createLocalStorage({ root: (env.PHOTOS_LOCAL_ROOT ?? '').trim() || 'storage/app/photos' })
}

let instance: StorageAdapter | null = null

/** The configured photo store, created on first use. */
export function photoStorage(): StorageAdapter {
  instance ??= createPhotoStorage(typeof Bun !== 'undefined' ? Bun.env : process.env)
  return instance
}

/** Swap in another store, for tests. Pass null to go back to the configured one. */
export function usePhotoStorage(adapter: StorageAdapter | null): void {
  instance = adapter
}
