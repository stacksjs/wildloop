/**
 * The profile form's rules: what a name, bio and location may be. Shared by
 * Settings, which checks as you type, and PUT /api/me/profile
 * (app/Actions/Profile/ProfileUpdateAction.ts), which is the one that counts.
 */

/** What a profile may say, enforced by the endpoint and mirrored by the form. */
export const PROFILE_LIMITS = {
  nameMin: 2,
  nameMax: 100,
  bio: 280,
  location: 80,
} as const

export interface ProfileInput {
  name: string
  bio: string | null
  location: string | null
}

/**
 * Check a profile edit. Returns the cleaned values, or a message per field
 * that is wrong. Whitespace is collapsed in the name and location, which are
 * one line, and only trimmed in the bio, which may have paragraphs.
 */
export function validateProfileInput(input: { name?: unknown, bio?: unknown, location?: unknown }): { value: ProfileInput } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim()
  const bio = String(input.bio ?? '').replace(/\r\n?/g, '\n').trim()
  const location = String(input.location ?? '').replace(/\s+/g, ' ').trim()

  if (name.length < PROFILE_LIMITS.nameMin)
    errors.name = `Your name needs at least ${PROFILE_LIMITS.nameMin} characters.`
  else if (name.length > PROFILE_LIMITS.nameMax)
    errors.name = `Your name can be up to ${PROFILE_LIMITS.nameMax} characters.`
  if ([...bio].length > PROFILE_LIMITS.bio)
    errors.bio = `Your bio can be up to ${PROFILE_LIMITS.bio} characters.`
  if ([...location].length > PROFILE_LIMITS.location)
    errors.location = `Your location can be up to ${PROFILE_LIMITS.location} characters.`

  if (Object.keys(errors).length > 0)
    return { errors }
  return { value: { name, bio: bio || null, location: location || null } }
}

/** "12 / 280": how much of a limit a value has used, counted as characters. */
export function characterCount(value: string, limit: number): string {
  return `${[...String(value ?? '')].length} / ${limit}`
}
