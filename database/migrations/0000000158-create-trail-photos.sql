-- Photos people add to a trail.
--
-- One row per photo. The image bytes live in object storage (S3 in
-- production), under storage_key for the display size and thumb_key for the
-- card size. Every upload is re-encoded on the server first, which drops the
-- camera metadata, GPS position included, before anything is stored.
--
-- status is visible or hidden. A reported photo is hidden until someone looks
-- at it, and a hidden photo is never listed.
--
-- review_id links a photo added with a review. It stays null for a photo added
-- to the trail directly.
--
-- Comments here avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons outside quotes.

CREATE TABLE IF NOT EXISTS trail_photos (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uuid" TEXT NOT NULL,
  "trail_id" INTEGER NOT NULL REFERENCES "trails"("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "review_id" INTEGER REFERENCES "trail_reviews"("id") ON DELETE SET NULL,
  "storage_key" TEXT NOT NULL,
  "thumb_key" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "bytes" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'visible' CHECK ("status" IN ('visible', 'hidden')),
  "report_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "trail_photos_uuid_unique" ON "trail_photos" ("uuid");

-- A trail page lists its visible photos newest first.
CREATE INDEX IF NOT EXISTS "trail_photos_trail_status_created_index" ON "trail_photos" ("trail_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "trail_photos_user_index" ON "trail_photos" ("user_id");
