-- Photographs from Wikimedia Commons that might show a trail, waiting for a
-- person to say whether they do (#1006).
--
-- The nightly job (buddy trails:source-photos) finds files near a trail head
-- whose titles name the trail, and writes them here as pending. Nothing here
-- is shown to anybody until an administrator approves it on /admin/photos -
-- proximity and a matching title are evidence, never proof, and a wrong photo
-- presented as the trail is worse than the illustrative one it replaced.
--
-- Files under a licence that does not allow commercial reuse with attribution
-- (NC, ND, or anything that is not CC BY, CC BY-SA, CC0 or public domain) are
-- written as rejected with the reason, so a later run does not offer them
-- again and the queue can say why it never showed them.
--
-- One file per trail at most once: the unique index is what makes a rerun
-- add only what is new. Approving one makes it the cover, and the read path
-- takes the most recently approved if two ever are.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "trail_photo_candidates" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "trail_id" INTEGER NOT NULL REFERENCES "trails"("id") ON DELETE CASCADE,
  "file_title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "page_url" TEXT NOT NULL,
  "credit" TEXT NOT NULL,
  "license" TEXT NOT NULL,
  "license_url" TEXT NOT NULL DEFAULT '',
  "matched_words" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'rejected')),
  "reason" TEXT,
  "priority" REAL NOT NULL DEFAULT 0,
  "reviewed_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "trail_photo_candidates_trail_file_unique" ON "trail_photo_candidates" ("trail_id", "file_title");
CREATE INDEX IF NOT EXISTS "trail_photo_candidates_status_priority_index" ON "trail_photo_candidates" ("status", "priority");

-- Which trails have been looked up, and when. The cache that keeps the nightly
-- job from asking Commons about the same trail head every night: a trail is
-- searched again only once its last search is old enough that new uploads are
-- worth checking for.
CREATE TABLE IF NOT EXISTS "trail_photo_searches" (
  "trail_id" INTEGER PRIMARY KEY REFERENCES "trails"("id") ON DELETE CASCADE,
  "searched_at" TEXT NOT NULL,
  "found" INTEGER NOT NULL DEFAULT 0,
  "accepted" INTEGER NOT NULL DEFAULT 0,
  "priority" REAL NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS "trail_photo_searches_searched_at_index" ON "trail_photo_searches" ("searched_at")
