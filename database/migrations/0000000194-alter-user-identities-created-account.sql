-- Whether signing in with this identity is what created the account.
--
-- An account made by Google or Apple gets a random password nobody ever sees
-- (see app/Support/socialAccount.ts), so asking for that password before
-- deleting the account asks for something its owner never had. App Store
-- guideline 5.1.1(v) wants everyone able to delete their account in the app,
-- so those accounts confirm another way. This column is how the server tells
-- them apart from an account somebody registered with a password and linked
-- to Google or Apple later, which keeps its password check.
--
-- Setting a password through the reset flow stamps users.password_changed_at,
-- and from then on the account has a password of its own whatever this says.
--
-- The backfill relies on how accounts have been created so far. The sign-in
-- that creates an account writes the user and the identity with the very same
-- timestamp, while linking an existing account writes the identity long after
-- the user. Comments avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons.

ALTER TABLE "user_identities" ADD COLUMN "created_account" INTEGER NOT NULL DEFAULT 0;
UPDATE "user_identities" SET "created_account" = 1
  WHERE "created_at" = (SELECT "users"."created_at" FROM "users" WHERE "users"."id" = "user_identities"."user_id")
