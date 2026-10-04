/**
 * An administrator in the isolated QA database, and nowhere else.
 *
 * `scripts/start-recording-qa.ts` creates it on a throwaway SQLite file bound
 * to loopback, so the suites can exercise the `role:admin` routes from both
 * sides: a stranger refused, an admin let through. There is no API that
 * grants the role, by design, so it has to be seeded rather than registered.
 */
export const QA_ADMIN = {
  name: 'QA Admin',
  email: 'admin@qa.invalid',
  password: 'qa-admin-throwaway-db-only',
} as const
