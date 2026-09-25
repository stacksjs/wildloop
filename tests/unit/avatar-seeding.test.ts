import { afterEach, describe, expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStorage } from '@stacksjs/storage'
import { avatarInitials } from '../../app/Support/avatarArt'
import { avatarPath, isSeededAvatar, seededAvatarUuid, storedAvatar } from '../../app/Support/avatars'
import { avatarSourceFor, planSeededAvatar, SEEDED_ATHLETES, seedAvatar } from '../../app/Support/avatarSeeding'

const seedersAvatars = join(import.meta.dir, '..', '..', 'database', 'seeders', 'avatars')

let root = ''
afterEach(() => {
  if (root)
    rmSync(root, { recursive: true, force: true })
  root = ''
})

function tempDir(): string {
  root = mkdtempSync(join(tmpdir(), 'wildloop-avatar-seed-'))
  return root
}

/** A user row the seeder writes to, with the same compare-and-set it uses. */
function fakeUser(avatar: string | null) {
  const row = { avatar }
  let writes = 0
  return {
    row,
    get writes() { return writes },
    save: async (next: string, previous: string | null) => {
      if (row.avatar !== previous)
        return false
      row.avatar = next
      writes++
      return true
    },
  }
}

describe('planSeededAvatar', () => {
  const target = avatarPath(3, seededAvatarUuid('photo:chris-breuer:new'))

  it('fills an empty avatar', () => {
    expect(planSeededAvatar(null, target)).toBe('set')
    expect(planSeededAvatar('', target)).toBe('set')
  })

  it('leaves the seeded avatar it would write alone', () => {
    expect(planSeededAvatar(target, target)).toBe('keep')
  })

  it('replaces an older seeded avatar', () => {
    expect(planSeededAvatar(avatarPath(3, seededAvatarUuid('art:1:chris-breuer:Chris Breuer')), target)).toBe('set')
  })

  it('never replaces one somebody uploaded or linked', () => {
    expect(planSeededAvatar(avatarPath(3, crypto.randomUUID()), target)).toBe('user-chosen')
    expect(planSeededAvatar('https://example.com/me.jpg', target)).toBe('user-chosen')
  })
})

describe('avatarSourceFor', () => {
  it('uses a committed photo when there is one, keyed by its content', () => {
    const source = avatarSourceFor('chris-breuer', 'Chris Breuer', seedersAvatars)
    expect(source.seed).toMatch(/^photo:chris-breuer:[0-9a-f]{64}$/)
  })

  it('draws art for everyone else, keyed by the name so a rename redraws it', () => {
    const source = avatarSourceFor('kim-gottwald', 'Kim Gottwald', seedersAvatars)
    expect(source.seed).toMatch(/^art:\d+:kim-gottwald:Kim Gottwald$/)
    expect(avatarSourceFor('kim-gottwald', 'Kim G', seedersAvatars).seed).not.toBe(source.seed)
  })

  it('covers every seeded athlete, and only Chris has a real photo', () => {
    expect(SEEDED_ATHLETES.map(athlete => athlete.email).sort()).toEqual([
      'admin@wildloop.test',
      'chris@wildloop.test',
      'harvey@wildloop.test',
      'kim@wildloop.test',
      'mark@wildloop.test',
      'paid@wildloop.test',
      'pawel@wildloop.test',
      'user@wildloop.test',
    ])
    const photos = SEEDED_ATHLETES.filter(athlete => avatarSourceFor(athlete.slug, 'Name', seedersAvatars).seed.startsWith('photo:'))
    expect(photos.map(athlete => athlete.slug)).toEqual(['chris-breuer'])
  })
})

describe('avatarInitials', () => {
  it('takes the first and last word', () => {
    expect(avatarInitials('Harvey Lewis')).toBe('HL')
    expect(avatarInitials('Wildloop Paid User')).toBe('WU')
    expect(avatarInitials('kim')).toBe('K')
    expect(avatarInitials('  ')).toBe('·')
  })
})

describe('seedAvatar', () => {
  it('writes a generated face once, then does nothing on every later run', async () => {
    const store = createLocalStorage({ root: tempDir() })
    const user = fakeUser(null)
    const source = avatarSourceFor('pawel-dregan', 'Pawel Dregan', seedersAvatars)
    let rendered = 0
    const counted = { ...source, bytes: () => { rendered++; return source.bytes() } }

    expect(await seedAvatar({ userId: 4, current: user.row.avatar, source: counted, store, save: user.save })).toBe('set')
    const stored = storedAvatar(user.row.avatar)!
    expect(isSeededAvatar(user.row.avatar)).toBe(true)
    expect(await store.fileExists(stored.keys.display)).toBe(true)
    expect(await store.fileExists(stored.keys.thumb)).toBe(true)

    expect(await seedAvatar({ userId: 4, current: user.row.avatar, source: counted, store, save: user.save })).toBe('keep')
    expect(rendered).toBe(1)
    expect(user.writes).toBe(1)
  })

  it('never touches an avatar the athlete uploaded', async () => {
    const store = createLocalStorage({ root: tempDir() })
    const uploaded = avatarPath(3, crypto.randomUUID())
    const user = fakeUser(uploaded)
    const source = avatarSourceFor('chris-breuer', 'Chris Breuer', seedersAvatars)

    expect(await seedAvatar({ userId: 3, current: uploaded, source, store, save: user.save })).toBe('user-chosen')
    expect(user.row.avatar).toBe(uploaded)
    expect(user.writes).toBe(0)
  })

  it('replaces the art with a real photo dropped in later, and deletes the art', async () => {
    const directory = tempDir()
    const store = createLocalStorage({ root: join(directory, 'store') })
    const user = fakeUser(null)

    await seedAvatar({ userId: 6, current: null, source: avatarSourceFor('mark-dowdle', 'Mark Dowdle', directory), store, save: user.save })
    const art = storedAvatar(user.row.avatar)!

    copyFileSync(join(seedersAvatars, 'chris-breuer.jpg'), join(directory, 'mark-dowdle.jpg'))
    const photo = avatarSourceFor('mark-dowdle', 'Mark Dowdle', directory)
    expect(photo.seed.startsWith('photo:')).toBe(true)
    expect(await seedAvatar({ userId: 6, current: user.row.avatar, source: photo, store, save: user.save })).toBe('set')

    expect(user.row.avatar).toBe(avatarPath(6, seededAvatarUuid(photo.seed)))
    expect(await store.fileExists(art.keys.display)).toBe(false)
    expect(await store.fileExists(art.keys.thumb)).toBe(false)
  })

  it('backs off, and cleans up, when an upload lands while it works', async () => {
    const store = createLocalStorage({ root: tempDir() })
    const source = avatarSourceFor('harvey-lewis', 'Harvey Lewis', seedersAvatars)
    // Read as empty, but by the time it saves somebody has uploaded a photo.
    const decision = await seedAvatar({ userId: 7, current: null, source, store, save: async () => false })
    expect(decision).toBe('user-chosen')
    const written = storedAvatar(avatarPath(7, seededAvatarUuid(source.seed)))!
    expect(await store.fileExists(written.keys.display)).toBe(false)
    expect(await store.fileExists(written.keys.thumb)).toBe(false)
  })
})
