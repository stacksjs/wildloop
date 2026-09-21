/**
 * What a save / kudos / follow / block endpoint should end with.
 *
 * PUT adds and DELETE removes, and repeating either changes nothing: a
 * double tap, or a retry after a dropped response, cannot undo itself. POST
 * is the old toggle, which flips whatever is there; it stays for apps that
 * are still open across a deploy.
 */
export function wantsIt(method: string | undefined, current: boolean): boolean {
  const verb = String(method ?? '').toUpperCase()
  if (verb === 'PUT')
    return true
  if (verb === 'DELETE')
    return false
  return !current
}
