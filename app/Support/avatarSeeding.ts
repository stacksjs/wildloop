/**
 * Faces for the seeded athletes.
 *
 * A real photo is used where the team has one: drop it in
 * `database/seeders/avatars/<slug>.jpg` and the next seed puts it in place.
 * Everyone else gets generated art (app/Support/avatarArt.ts) rather than a
 * stock photo, because these are real people's names and a stranger's face
 * under one would be a lie.
 *
 * The rules that make this safe to run on every deploy:
 *
 *   - An avatar somebody chose is never touched. Seeded avatars carry a
 *     version 5 UUID and uploads a version 4 one (app/Support/avatars.ts), so
 *     "chose" is readable straight off the column.
 *   - The same source gives the same URL, so a re-run finds it in place and
 *     does no image work at all: one query per athlete.
 *   - A new source (a photo dropped in, a name changed, the art redrawn)
 *     gives a new URL, which replaces the old seeded one and deletes its files.
 */

import type { StorageAdapter } from '@stacksjs/storage'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AVATAR_ART_VERSION, renderAvatarArt } from './avatarArt'
import { processAvatar } from './avatarProcessing'
import { avatarPath, deleteAvatarFiles, isSeededAvatar, seededAvatarUuid, writeAvatarFiles } from './avatars'

export interface SeededAthlete {
  email: string
  /** Names the photo file, `database/seeders/avatars/<slug>.jpg`. */
  slug: string
}

/** Everyone UserSeeder and AdminSeeder create. */
export const SEEDED_ATHLETES: SeededAthlete[] = [
  { email: 'chris@wildloop.test', slug: 'chris-breuer' },
  { email: 'pawel@wildloop.test', slug: 'pawel-dregan' },
  { email: 'kim@wildloop.test', slug: 'kim-gottwald' },
  { email: 'mark@wildloop.test', slug: 'mark-dowdle' },
  { email: 'harvey@wildloop.test', slug: 'harvey-lewis' },
  { email: 'user@wildloop.test', slug: 'wildloop-user' },
  { email: 'paid@wildloop.test', slug: 'wildloop-paid-user' },
  { email: 'admin@wildloop.test', slug: 'wildloop-admin' },
]

const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']

export type SeedDecision = 'keep' | 'user-chosen' | 'set'

/**
 * What to do about one athlete's avatar.
 *
 *   keep         already the seeded avatar for this source
 *   user-chosen  somebody picked this one: leave it alone
 *   set          empty, or an older seeded one: put this source's in place
 */
export function planSeededAvatar(current: unknown, target: string): SeedDecision {
  const value = String(current ?? '').trim()
  if (value === target)
    return 'keep'
  if (value && !isSeededAvatar(value))
    return 'user-chosen'
  return 'set'
}

export interface AvatarSource {
  /** Identifies the image: same source, same seeded UUID. */
  seed: string
  /** Produce the image bytes. Only called when the avatar has to be written. */
  bytes: () => Promise<Uint8Array>
}

/** A committed photo if there is one, otherwise generated art. */
export function avatarSourceFor(slug: string, name: string, directory: string): AvatarSource {
  for (const extension of PHOTO_EXTENSIONS) {
    const path = join(directory, `${slug}.${extension}`)
    if (!existsSync(path))
      continue
    const photo = new Uint8Array(readFileSync(path))
    const digest = createHash('sha256').update(photo).digest('hex')
    return { seed: `photo:${slug}:${digest}`, bytes: async () => photo }
  }
  // The name is part of the seed so a renamed athlete gets new initials.
  return { seed: `art:${AVATAR_ART_VERSION}:${slug}:${name}`, bytes: () => renderAvatarArt(name, slug) }
}

export interface SeedAvatarOptions {
  userId: number
  current: unknown
  source: AvatarSource
  store: StorageAdapter
  /**
   * Point the user at `avatar`, but only while their avatar is still
   * `previous`. Answers whether it did, so an upload that lands between the
   * read and the write wins.
   */
  save: (avatar: string, previous: string | null) => Promise<boolean>
}

/** Seed one athlete's avatar. Answers what it decided. */
export async function seedAvatar(options: SeedAvatarOptions): Promise<SeedDecision> {
  const uuid = seededAvatarUuid(options.source.seed)
  const target = avatarPath(options.userId, uuid)
  const decision = planSeededAvatar(options.current, target)
  if (decision !== 'set')
    return decision

  const processed = await processAvatar(await options.source.bytes())
  const written = await writeAvatarFiles(options.store, options.userId, uuid, processed)
  const previous = String(options.current ?? '').trim() || null

  if (!await options.save(written, previous)) {
    await deleteAvatarFiles(options.store, written)
    return 'user-chosen'
  }
  if (previous)
    await deleteAvatarFiles(options.store, previous)
  return 'set'
}
