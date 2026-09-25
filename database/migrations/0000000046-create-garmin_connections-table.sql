-- Links a Wildloop account to a Garmin Connect user, so activity webhooks can
-- be attributed to the right person.
--
-- Garmin identifies the athlete by its own opaque `userId`, which is what push
-- notifications carry. That is the join key, so it is unique: one Garmin
-- account maps to at most one Wildloop account.
--
-- Tokens are stored because the Activity API needs them to pull details and
-- files after a push arrives, and to refresh without sending the person back
-- through the consent screen.
CREATE TABLE IF NOT EXISTS "garmin_connections" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
  -- Garmin's opaque user id. The key every push notification is keyed by.
  "garmin_user_id" TEXT NOT NULL,
  "access_token" TEXT NOT NULL,
  "refresh_token" TEXT,
  -- Unix seconds. Checked before each call so a stale token is refreshed
  -- rather than spending a request to be told it expired.
  "expires_at" INTEGER,
  "scope" TEXT,
  "last_sync_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);

-- One Wildloop account connects one watch; reconnecting replaces the row.
CREATE UNIQUE INDEX IF NOT EXISTS "garmin_connections_user_id_unique"
  ON "garmin_connections" ("user_id");

-- The lookup every webhook performs: Garmin user id to Wildloop account.
-- Unique so one Garmin account cannot feed two Wildloop accounts.
CREATE UNIQUE INDEX IF NOT EXISTS "garmin_connections_garmin_user_id_unique"
  ON "garmin_connections" ("garmin_user_id");

-- Records which Garmin activities have already been ingested.
--
-- Push notifications are at-least-once: Garmin retries on any non-2xx, and a
-- backfill replays history. Without a record of what has been seen, a retried
-- delivery would create a second copy of the same run.
CREATE TABLE IF NOT EXISTS "garmin_activity_imports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
  -- Garmin's `summaryId`, stable across redeliveries of the same activity.
  "summary_id" TEXT NOT NULL,
  -- The Wildloop activity this produced, so a later update can find it.
  "activity_id" INTEGER REFERENCES "activities"("id"),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The idempotency guarantee: a redelivered summaryId cannot insert twice.
CREATE UNIQUE INDEX IF NOT EXISTS "garmin_activity_imports_summary_id_unique"
  ON "garmin_activity_imports" ("summary_id");
