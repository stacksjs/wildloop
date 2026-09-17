/**
 * Faces for people whose photo we do not have.
 *
 * WildLoop accounts carry a name and, for most of them, nothing else — so an
 * avatar is an initial in a coloured circle. The colour is derived from the
 * account rather than picked at random, which is what makes the same person
 * the same colour on every card they appear on, and across reloads.
 */

/**
 * The tints a face can take.
 *
 * Named classes rather than utility strings, defined in `config/crosswind.ts`
 * alongside the difficulty chips: a class assembled at runtime is invisible to
 * the CSS scanner, so a palette written out here would generate no rules and
 * every avatar would render grey. The same reason the difficulty colours are
 * shortcuts and safelisted.
 */
const AVATAR_TINTS = [
  'avatar-tint-0',
  'avatar-tint-1',
  'avatar-tint-2',
  'avatar-tint-3',
  'avatar-tint-4',
  'avatar-tint-5',
]

/**
 * The letter on the circle.
 *
 * Takes the first character of the name as the reader sees it, which is why it
 * splits by code point: a name starting with an emoji or an astral character
 * would otherwise be cut in half and render as a replacement box.
 */
export function avatarInitial(name: string | null | undefined): string {
  const text = String(name ?? '').trim()
  if (!text)
    return '·'
  return [...text][0].toUpperCase()
}

/** A stable small hash. Same input, same colour, on every device. */
function hashSeed(seed: string): number {
  let hash = 0
  for (const character of seed)
    hash = (hash * 31 + character.codePointAt(0)!) % 100_000_007
  return hash
}

/** Classes for one face. `seed` is an account id, or its name as a fallback. */
export function avatarTint(seed: string | number | null | undefined): string {
  const key = String(seed ?? '')
  if (!key)
    return AVATAR_TINTS[0]
  return AVATAR_TINTS[hashSeed(key) % AVATAR_TINTS.length]
}

/**
 * How a count of recent reviews reads on a card.
 *
 * "new" rather than "recent" because the number is what has arrived since the
 * last time somebody looked at this trail, and singular is spelled out: "1 new
 * reviews" is the kind of detail that makes a page look unfinished.
 */
export function newReviewsLabel(count: number): string {
  const value = Math.max(0, Math.round(Number(count) || 0))
  if (value === 0)
    return ''
  return value === 1 ? '1 new review' : `${value.toLocaleString()} new reviews`
}

/** `+2` for the faces a stack could not show. Empty when it showed them all. */
export function overflowLabel(total: number, shown: number): string {
  const extra = Math.max(0, Math.round(Number(total) || 0) - Math.max(0, shown))
  return extra > 0 ? `+${extra > 99 ? 99 : extra}` : ''
}
