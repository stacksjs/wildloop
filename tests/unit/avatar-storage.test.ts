import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStorage } from '@stacksjs/storage'
import {
  avatarKeys,
  avatarPath,
  deleteAvatarFiles,
  isAvatarKey,
  isSeededAvatar,
  profileFields,
  publicAvatar,
  seededAvatarUuid,
  storedAvatar,
  writeAvatarFiles,
} from '../../app/Support/avatars'

const uuid = '3f2b8c1e-9a4d-4e7f-b1c2-5d6e7f8a9b0c'

describe('avatar keys', () => {
  it('names a display image and a thumbnail under the user', () => {
    expect(avatarKeys(5, uuid)).toEqual({
      display: `avatars/5/${uuid}.jpg`,
      thumb: `avatars/5/${uuid}-thumb.jpg`,
    })
  })

  it('refuses ids and names that could escape the user folder', () => {
    expect(() => avatarKeys(0, uuid)).toThrow()
    expect(() => avatarKeys(-1, uuid)).toThrow()
    expect(() => avatarKeys(5, '../../etc/passwd')).toThrow()
    expect(() => avatarKeys(5, uuid.toUpperCase())).toThrow()
  })

  it('recognizes only keys this app writes, so the file route serves nothing else', () => {
    expect(isAvatarKey(`avatars/5/${uuid}.jpg`)).toBe(true)
    expect(isAvatarKey(`avatars/5/${uuid}-thumb.jpg`)).toBe(true)
    expect(isAvatarKey(`avatars/5/../../${uuid}.jpg`)).toBe(false)
    expect(isAvatarKey(`avatars/05/${uuid}.jpg`)).toBe(false)
    expect(isAvatarKey(`/avatars/5/${uuid}.jpg`)).toBe(false)
    expect(isAvatarKey(`avatars/5/${uuid}.jpg.html`)).toBe(false)
    expect(isAvatarKey(`trails/5/${uuid}.jpg`)).toBe(false)
    expect(isAvatarKey('.env')).toBe(false)
  })
})

describe('avatar URLs', () => {
  it('stores the URL it is served from, and finds the files behind it', () => {
    const url = avatarPath(5, uuid)
    expect(url).toBe(`/api/avatars/5/${uuid}.jpg`)
    expect(avatarPath(5, uuid, 'thumb')).toBe(`/api/avatars/5/${uuid}-thumb.jpg`)
    expect(storedAvatar(url)).toEqual({ userId: 5, uuid, keys: avatarKeys(5, uuid) })
  })

  it('has no files behind an external, empty or malformed value', () => {
    expect(storedAvatar(null)).toBeNull()
    expect(storedAvatar('https://example.com/me.jpg')).toBeNull()
    expect(storedAvatar(`/api/avatars/5/${uuid}-thumb.jpg`)).toBeNull()
    expect(storedAvatar(`/api/avatars/5/../${uuid}.jpg`)).toBeNull()
  })

  it('hands out only its own paths and https URLs', () => {
    expect(publicAvatar(avatarPath(5, uuid))).toBe(`/api/avatars/5/${uuid}.jpg`)
    expect(publicAvatar(' https://cdn.example.com/a.jpg ')).toBe('https://cdn.example.com/a.jpg')
    expect(publicAvatar('http://example.com/a.jpg')).toBeNull()
    expect(publicAvatar('javascript:alert(1)')).toBeNull()
    expect(publicAvatar('/etc/passwd')).toBeNull()
    expect(publicAvatar('')).toBeNull()
    expect(publicAvatar(undefined)).toBeNull()
  })

  it('reads a profile off a user row', () => {
    expect(profileFields({ avatar: avatarPath(5, uuid), bio: '  Ultra runner  ', location: '', created_at: '2026-01-02T03:04:05Z' })).toEqual({
      avatar: `/api/avatars/5/${uuid}.jpg`,
      bio: 'Ultra runner',
      location: null,
      joinedAt: '2026-01-02T03:04:05Z',
    })
    expect(profileFields(null)).toEqual({ avatar: null, bio: null, location: null, joinedAt: null })
  })
})

describe('seeded avatar ids', () => {
  it('are stable for a source and different across sources', () => {
    expect(seededAvatarUuid('photo:chris-breuer:abc')).toBe(seededAvatarUuid('photo:chris-breuer:abc'))
    expect(seededAvatarUuid('photo:chris-breuer:abc')).not.toBe(seededAvatarUuid('photo:chris-breuer:abd'))
  })

  it('are version 5 UUIDs, which no upload ever gets', () => {
    const id = seededAvatarUuid('art:1:kim-gottwald:Kim Gottwald')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(isSeededAvatar(avatarPath(3, id))).toBe(true)
    expect(isSeededAvatar(avatarPath(3, crypto.randomUUID()))).toBe(false)
    expect(isSeededAvatar('https://example.com/a.jpg')).toBe(false)
    expect(isSeededAvatar(null)).toBe(false)
  })
})

describe('avatar files', () => {
  let root = ''
  afterEach(() => {
    if (root)
      rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('writes both sizes and removes them again', async () => {
    root = mkdtempSync(join(tmpdir(), 'wildloop-avatars-'))
    const store = createLocalStorage({ root })
    const url = await writeAvatarFiles(store, 7, uuid, { display: new Uint8Array([1, 2, 3]), thumb: new Uint8Array([4]) })
    expect(url).toBe(`/api/avatars/7/${uuid}.jpg`)
    expect(await store.readToUint8Array(`avatars/7/${uuid}.jpg`)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await store.readToUint8Array(`avatars/7/${uuid}-thumb.jpg`)).toEqual(new Uint8Array([4]))

    await deleteAvatarFiles(store, url)
    expect(await store.fileExists(`avatars/7/${uuid}.jpg`)).toBe(false)
    expect(await store.fileExists(`avatars/7/${uuid}-thumb.jpg`)).toBe(false)
  })

  it('never deletes anything for a value that is not one of its own', async () => {
    root = mkdtempSync(join(tmpdir(), 'wildloop-avatars-'))
    const store = createLocalStorage({ root })
    await store.write('keep.txt', 'x')
    await deleteAvatarFiles(store, '/api/avatars/7/../../keep.txt')
    await deleteAvatarFiles(store, 'https://example.com/keep.txt')
    expect(await store.fileExists('keep.txt')).toBe(true)
  })
})
