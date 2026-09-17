import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPhotoStorage,
  isPhotoKey,
  photoKeys,
  PhotoStorageNotConfiguredError,
  photoStoragePrefix,
} from '../../app/Support/photoStorage'

const uuid = '3f2b8c1e-9a4d-4e7f-b1c2-5d6e7f8a9b0c'

describe('photo keys', () => {
  it('names a display image and a thumbnail under the trail', () => {
    expect(photoKeys(12, uuid)).toEqual({
      display: `trails/12/${uuid}.jpg`,
      thumb: `trails/12/${uuid}-thumb.jpg`,
    })
  })

  it('refuses ids that could escape the trail folder', () => {
    expect(() => photoKeys(0, uuid)).toThrow()
    expect(() => photoKeys(-1, uuid)).toThrow()
    expect(() => photoKeys(12, '../../etc/passwd')).toThrow()
    expect(() => photoKeys(12, uuid.toUpperCase())).toThrow()
  })

  it('recognizes only keys this app writes, so the photo route serves nothing else', () => {
    expect(isPhotoKey(`trails/12/${uuid}.jpg`)).toBe(true)
    expect(isPhotoKey(`trails/12/${uuid}-thumb.jpg`)).toBe(true)
    expect(isPhotoKey(`trails/12/../../${uuid}.jpg`)).toBe(false)
    expect(isPhotoKey(`/trails/12/${uuid}.jpg`)).toBe(false)
    expect(isPhotoKey(`trails/12/${uuid}.jpg.html`)).toBe(false)
    expect(isPhotoKey(`trails/12/${uuid}.png`)).toBe(false)
    expect(isPhotoKey('.env')).toBe(false)
  })
})

describe('photoStoragePrefix', () => {
  it('keeps each environment in its own folder of a shared bucket', () => {
    expect(photoStoragePrefix({ APP_ENV: 'production' })).toBe('production/')
    expect(photoStoragePrefix({})).toBe('development/')
  })

  it('uses an explicit prefix, normalized to one trailing slash', () => {
    expect(photoStoragePrefix({ APP_ENV: 'production', PHOTOS_S3_PREFIX: '/staging//' })).toBe('staging/')
  })
})

describe('createPhotoStorage', () => {
  let root: string | null = null

  afterEach(() => {
    if (root)
      rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('writes to local disk by default', async () => {
    root = mkdtempSync(join(tmpdir(), 'wildloop-photos-'))
    const store = createPhotoStorage({ PHOTOS_LOCAL_ROOT: root })
    const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 1, 2, 3])
    const key = photoKeys(12, uuid).display

    await store.write(key, bytes)
    expect(Array.from(await store.readToUint8Array(key))).toEqual(Array.from(bytes))
    await store.deleteFile(key)
    expect(await store.fileExists(key)).toBe(false)
  })

  it('says exactly which S3 settings are missing instead of failing on first upload', () => {
    let error: unknown = null
    try {
      createPhotoStorage({ PHOTOS_DISK: 's3', PHOTOS_S3_BUCKET: 'wildloop-trail-photos' })
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PhotoStorageNotConfiguredError)
    expect(String((error as Error).message)).toContain('PHOTOS_S3_ACCESS_KEY_ID')
    expect(String((error as Error).message)).toContain('PHOTOS_S3_SECRET_ACCESS_KEY')
  })

  it('builds an S3 store when fully configured, without contacting S3', () => {
    const store = createPhotoStorage({
      PHOTOS_DISK: 's3',
      PHOTOS_S3_BUCKET: 'wildloop-trail-photos',
      PHOTOS_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      PHOTOS_S3_SECRET_ACCESS_KEY: 'example-secret',
      APP_ENV: 'production',
    })
    expect(store.constructor.name).toBe('S3StorageAdapter')
  })
})
