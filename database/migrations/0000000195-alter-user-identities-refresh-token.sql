-- The refresh token Apple issued at the last sign-in, sealed with APP_KEY.
--
-- An app offering Sign in with Apple has to revoke the user tokens when the
-- account is deleted, through the revoke endpoint, which wants a token Apple
-- issued. The id token is gone a minute after sign-in, so the refresh token
-- from the same exchange is kept for this one purpose. Nothing else reads it.
--
-- Sealed rather than stored plain (see app/Support/appleTokens.ts): a copy of
-- the database must not hand anybody a token Apple would still honour.
-- NULL for Google, and for Apple sign-ins from before this column existed.
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

ALTER TABLE "user_identities" ADD COLUMN "refresh_token" TEXT
