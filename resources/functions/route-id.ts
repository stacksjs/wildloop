/**
 * An id from a route parameter.
 *
 * Its own module because more than one screen needs it and neither owns it.
 * Written for the territory screen, then wanted immediately by the effort
 * screen — which is the usual sign.
 *
 * @module functions/route-id
 */

/**
 * A positive whole id from a route parameter, or null.
 *
 * Strict on purpose. `Number.parseInt` is lenient — `'7.5.1'` and `'7abc'`
 * both come back as 7 — so a malformed path would quietly load a *different*
 * record than the one it names. The record pages guard the same hazard with a
 * `-1` sentinel: record 1 is real, and loading it because a parameter did not
 * parse is worse than saying nothing was found.
 *
 * Digits only, so `'07'` is 7 and everything else is nothing.
 */
export function pathIdFrom(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number')
    return null
  const text = String(raw).trim()
  if (!/^\d+$/.test(text))
    return null
  const id = Number(text)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
