-- More conditions a review can report: weather and hazards, not only how
-- the path felt. Snow, flooding, a washed out section, fallen trees, extreme
-- heat, wildfire or smoke, and closures, beside the six there were. The
-- trail page highlights the dangerous ones (resources/functions/trail-conditions.ts
-- is the list and its severities).
--
-- SQLite cannot change a CHECK in place, so the table is rebuilt the way
-- 0000000045 rebuilt it: same columns, same rows and ids, new CHECK, then
-- the indexes back. trail_photos.review_id refers to this table by name,
-- which the rename keeps, and foreign keys are off while it happens.
--
-- The release still serving during a deploy only writes the six old values,
-- which the new CHECK accepts. Comments avoid semicolons and apostrophes:
-- the migration runner splits this file on semicolons.

PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE "_qb_tmp_trail_reviews" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "users"("id"),
  "trail_id" INTEGER REFERENCES "trails"("id"),
  "rating" INTEGER not null,
  "title" TEXT,
  "content" TEXT not null,
  "visit_date" TEXT,
  "conditions" TEXT CHECK ("conditions" IN ('excellent', 'good', 'fair', 'poor', 'muddy', 'fallen-trees', 'snowy', 'icy', 'flooded', 'washed-out', 'extreme-heat', 'wildfire', 'closed')),
  "helpful_count" INTEGER,
  "photos" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT,
  "difficulty" TEXT CHECK ("difficulty" IN ('easy', 'moderate', 'hard'))
);
INSERT INTO "_qb_tmp_trail_reviews" ("id", "user_id", "trail_id", "rating", "title", "content", "visit_date", "conditions", "helpful_count", "photos", "created_at", "updated_at", "uuid", "difficulty") SELECT "id", "user_id", "trail_id", "rating", "title", "content", "visit_date", "conditions", "helpful_count", "photos", "created_at", "updated_at", "uuid", "difficulty" FROM "trail_reviews";
DROP TABLE "trail_reviews";
ALTER TABLE "_qb_tmp_trail_reviews" RENAME TO "trail_reviews";
CREATE UNIQUE INDEX IF NOT EXISTS "trail_reviews_trail_reviews_user_trail_unique" ON "trail_reviews" ("user_id", "trail_id");
CREATE UNIQUE INDEX IF NOT EXISTS "trail_reviews_trail_reviews_uuid_unique" ON "trail_reviews" ("uuid");
CREATE UNIQUE INDEX IF NOT EXISTS "trail_reviews_user_trail_unique" ON "trail_reviews" ("user_id", "trail_id");
CREATE UNIQUE INDEX IF NOT EXISTS "trail_reviews_uuid_unique" ON "trail_reviews" ("uuid");
CREATE INDEX IF NOT EXISTS "trail_reviews_trail_created_index" ON "trail_reviews" ("trail_id", "created_at");
PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys=ON;
