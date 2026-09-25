-- A profile an athlete can fill in: a photo, a short bio and where they are
-- based. All three are optional, so every existing account stays as it is.
--
-- avatar holds the URL the photo is served from (/api/avatars/<id>/<uuid>.jpg,
-- see app/Support/avatars.ts), not the storage key, so any query that reads a
-- user row can hand the client an image it can show without a second lookup.
--
-- Additive only. The release still serving during a deploy never reads or
-- writes these columns, and a nullable column needs no default. Comments
-- avoid semicolons and apostrophes: the migration runner splits this file on
-- semicolons.

ALTER TABLE "users" ADD COLUMN "avatar" TEXT;
ALTER TABLE "users" ADD COLUMN "bio" TEXT;
ALTER TABLE "users" ADD COLUMN "location" TEXT;
