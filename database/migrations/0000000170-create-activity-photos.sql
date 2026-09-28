-- Photos on an activity: what the run looked like.
--
-- Mirrors trail_photos deliberately, because the storage, the re-encode that
-- strips a photo of its GPS position, and the serving route are the same
-- machinery. The difference is who may add one. A trail photo is a public
-- contribution to a shared page, so anyone signed in can add one and the row
-- carries a report count. An activity belongs to one athlete, only they can
-- add to it, and there is nobody else to report it — so that column is not
-- here. Hiding is, because a photo can turn out to show more than its owner
-- meant it to.
--
-- ON DELETE CASCADE on both keys: deleting an activity or an account must not
-- leave rows pointing at files that a later cleanup would fail to explain.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "activity_photos" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uuid" TEXT NOT NULL,
  "activity_id" INTEGER NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "storage_key" TEXT NOT NULL,
  "thumb_key" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "bytes" INTEGER NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'visible' CHECK ("status" IN ('visible', 'hidden')),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "activity_photos_uuid_unique" ON "activity_photos" ("uuid");
CREATE INDEX IF NOT EXISTS "activity_photos_activity_status_position_index" ON "activity_photos" ("activity_id", "status", "position");
CREATE INDEX IF NOT EXISTS "activity_photos_user_index" ON "activity_photos" ("user_id");
