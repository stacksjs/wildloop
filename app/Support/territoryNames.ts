/**
 * What a territory is called on the map, in the battle feed and in the
 * notification its owner gets when it is attacked.
 *
 * A claim used to be named `Territory #${Date.now()}`, so a player's first
 * territory was "Territory #1791088357100" everywhere it appeared, and an
 * attack on it read "Bob conquered Territory #1791088357100!". It is named
 * after the nearest town instead (the same gazetteer the place search uses),
 * numbered when that town already has one.
 */

const SPLIT_SUFFIX = ' (Conquered)'

/** A new claim's name: "Silver Lake Loop", "Silver Lake Loop 2", ... */
export function claimName(place: string | null | undefined, existingNames: string[]): string {
  const town = place?.trim()
  const base = town ? `${town} Loop` : 'Unnamed Loop'
  const taken = new Set(existingNames)
  if (!taken.has(base))
    return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate))
      return candidate
  }
}

/**
 * The piece an attacker cuts off. Every split used to append the suffix, so
 * land fought over three times was "X (Conquered) (Conquered) (Conquered)".
 */
export function splitPieceName(parentName: string | null | undefined): string {
  let base = (parentName ?? '').trim() || 'Unnamed Loop'
  while (base.endsWith(SPLIT_SUFFIX))
    base = base.slice(0, -SPLIT_SUFFIX.length).trimEnd()
  return `${base}${SPLIT_SUFFIX}`
}
