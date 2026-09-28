-- An account somebody signs in with, at a provider that is not us.
--
-- Keyed on the provider subject rather than the address, because the address
-- on a Google account can change and the person is the same person when it
-- does. The address is kept anyway, for support questions and for reading a
-- row without joining users.
--
-- One row per provider account: the unique index is what stops two Wildloop
-- users both claiming the same Google account, which is the shape of an
-- account takeover rather than a duplicate.
--
-- A person may hold several rows, one per provider, which is what makes Apple
-- a second insert later rather than a second table.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "user_identities" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('google', 'apple')),
  "provider_user_id" TEXT NOT NULL,
  "email" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_identities_provider_subject_unique" ON "user_identities" ("provider", "provider_user_id");
CREATE INDEX IF NOT EXISTS "user_identities_user_index" ON "user_identities" ("user_id");
