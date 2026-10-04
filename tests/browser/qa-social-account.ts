/**
 * An account "Google made", in the isolated QA database and nowhere else.
 *
 * The QA stack has no Google or Apple credentials, so no sign-in there can
 * create one. `scripts/start-recording-qa.ts` writes the rows such a sign-in
 * leaves behind instead: a user, and an identity marked as the one that
 * created the account. The real sign-in hashes 32 random bytes nobody sees as
 * the password; this one hashes a known throwaway value so the suites can
 * open a session through /api/login, which stands in for coming back from
 * Google. As far as the server can tell it is an account with no password of
 * its own, which is what account-deletion.test.ts needs.
 */
export const QA_SOCIAL_ACCOUNT = {
  name: 'QA Google Athlete',
  email: 'google-athlete@qa.invalid',
  /** Never shown to the athlete it stands for. Only the QA harness signs in with it. */
  sessionSecret: 'qa-social-throwaway-db-only',
  providerUserId: 'qa-google-subject-0001',
} as const
