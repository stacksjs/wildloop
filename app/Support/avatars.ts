/**
 * Profile photos: how they are stored, how they are addressed, and what the
 * API says about a person's face. No database here, so all of it is testable.
 *
 * `users.avatar` holds the URL the photo is served from, root-relative, e.g.
 * `/api/avatars/5/<uuid>.jpg`. Storing the URL rather than the storage key
 * means every query that already reads a user row hands the client something
 * it can put straight into an `<img src>`, with no second lookup. The storage
 * key is derived from it: `avatars/5/<uuid>.jpg`, beside `<uuid>-thumb.jpg`.
 *
 * The file route only serves the key a user's row currently points at, so an
 * old photo stops being served the moment it is replaced or removed, and no
 * path can reach anything else in the photo store.
 *
 * Seeded avatars use a name-based (version 5) UUID derived from their source,
 * while uploads get a random (version 4) one. That is how the seeder tells a
 * face it put there, which it may replace, from one somebody chose, which it
 * must never touch.
 */

import type { StorageAdapter } from '@stacksjs/storage'
import { createHash } from 'node:crypto'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const USER_ID = '[1-9][0-9]{0,9}'
const AVATAR_KEY = new RegExp(`^avatars/(${USER_ID})/(${UUID})(-thumb)?\\.jpg$`)
const AVATAR_PATH = new RegExp(`^/api/avatars/(${USER_ID})/(${UUID})\\.jpg$`)

export type AvatarSize = 'display' | 'thumb'

/** The storage keys for one avatar's display image and thumbnail. */
export function avatarKeys(userId: number, uuid: string): { display: string, thumb: string } {
  const base = `avatars/${userId}/${uuid}`
  if (!isAvatarKey(`${base}.jpg`))
    throw new Error('An avatar key needs a positive user id and a lowercase UUID.')
  return { display: `${base}.jpg`, thumb: `${base}-thumb.jpg` }
}

/** Whether a string is an avatar key this app could have written. */
export function isAvatarKey(key: string): boolean {
  return AVATAR_KEY.test(key)
}

/** The URL an avatar is served from, which is also what `users.avatar` holds. */
export function avatarPath(userId: number, uuid: string, size: AvatarSize = 'display'): string {
  return `/api/avatars/${userId}/${uuid}${size === 'thumb' ? '-thumb' : ''}.jpg`
}

/**
 * The stored avatar a `users.avatar` value points at, when it is one of ours.
 * Null for an empty value or an external URL, which have no files here.
 */
export function storedAvatar(value: unknown): { userId: number, uuid: string, keys: { display: string, thumb: string } } | null {
  const match = AVATAR_PATH.exec(String(value ?? '').trim())
  if (!match)
    return null
  const userId = Number(match[1])
  const uuid = match[2]
  return { userId, uuid, keys: avatarKeys(userId, uuid) }
}

/**
 * The avatar as the API hands it out: one of our own paths, an https URL, or
 * null. Anything else in the column (a stray relative path, a `javascript:`
 * URL written by hand) is dropped rather than rendered into an `src`.
 */
export function publicAvatar(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text)
    return null
  if (AVATAR_PATH.test(text))
    return text
  return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text : null
}

/** A user row's avatar, for payloads that already hold the row. */
export function avatarOf(user: { avatar?: unknown } | null | undefined): string | null {
  return publicAvatar(user?.avatar)
}

/** Trimmed text, or null when nothing is left. */
function optionalText(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text ? text : null
}

/**
 * What a profile says about its athlete beyond the name: the avatar, the bio
 * and where they are based, plus when they joined.
 */
export function profileFields(user: { avatar?: unknown, bio?: unknown, location?: unknown, created_at?: unknown } | null | undefined): {
  avatar: string | null
  bio: string | null
  location: string | null
  joinedAt: string | null
} {
  return {
    avatar: avatarOf(user),
    bio: optionalText(user?.bio),
    location: optionalText(user?.location),
    joinedAt: optionalText(user?.created_at),
  }
}

/**
 * A stable UUID for a seeded avatar, derived from what it was made from.
 *
 * Shaped as a version 5 UUID (name-based, SHA hashed), so it can never collide
 * with an upload's random version 4 one, and the same source always gives the
 * same id: re-running the seeder finds the face already in place.
 */
export function seededAvatarUuid(seed: string): string {
  const hex = createHash('sha256').update(`wildloop-avatar:${seed}`).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/** Whether a `users.avatar` value is one the seeder put there. */
export function isSeededAvatar(value: unknown): boolean {
  const stored = storedAvatar(value)
  return stored !== null && stored.uuid[14] === '5'
}

/**
 * Write one avatar's two files and answer the URL to store on the user.
 * Leaves nothing half-written: if either write fails, both are removed.
 */
export async function writeAvatarFiles(store: StorageAdapter, userId: number, uuid: string, files: { display: Uint8Array, thumb: Uint8Array }): Promise<string> {
  const keys = avatarKeys(userId, uuid)
  try {
    await store.write(keys.display, files.display)
    await store.write(keys.thumb, files.thumb)
  }
  catch (error) {
    await store.deleteFile(keys.display).catch(() => {})
    await store.deleteFile(keys.thumb).catch(() => {})
    throw error
  }
  return avatarPath(userId, uuid)
}

/**
 * Remove the files behind a `users.avatar` value. Does nothing for an empty
 * value or an external URL, and never fails the caller: an orphaned file costs
 * a few kilobytes, a failed profile edit costs the person their change.
 */
export async function deleteAvatarFiles(store: StorageAdapter, value: unknown): Promise<void> {
  const stored = storedAvatar(value)
  if (!stored)
    return
  await store.deleteFile(stored.keys.display).catch(() => {})
  await store.deleteFile(stored.keys.thumb).catch(() => {})
}
