/**
 * The rules a password change has to satisfy, in one place.
 *
 * Both halves of the feature need them: the settings form, so somebody finds
 * out about a short password while typing rather than after a round trip, and
 * the action, which re-checks everything because a browser is not a place to
 * enforce anything.
 *
 * Eight characters matches the framework's reset path, which is the stricter
 * of the two minimums the codebase carries — `RegisterAction` still accepts
 * six, so an older account can hold a password it could no longer choose.
 */

export const PASSWORD_MIN_LENGTH = 8

/** bcrypt truncates past 72 bytes; this is the column's limit, not the hash's. */
export const PASSWORD_MAX_LENGTH = 255

/**
 * What is wrong with this change, in a sentence somebody can act on, or an
 * empty string when nothing is.
 *
 * Order matters: a person fixes the first problem they are told about, so the
 * missing field comes before the short password, which comes before the
 * mismatch they cannot see yet.
 */
export function passwordChangeError(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string {
  if (!currentPassword)
    return 'Enter your current password.'

  if (!newPassword)
    return 'Enter a new password.'

  if (newPassword.length < PASSWORD_MIN_LENGTH)
    return `Your new password must be at least ${PASSWORD_MIN_LENGTH} characters.`

  if (newPassword.length > PASSWORD_MAX_LENGTH)
    return `Your new password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`

  // Not a formality: "change your password" that accepts the current one back
  // reads as done while nothing has changed.
  if (newPassword === currentPassword)
    return 'Your new password must be different from your current one.'

  if (newPassword !== confirmation)
    return 'The new passwords do not match.'

  return ''
}
