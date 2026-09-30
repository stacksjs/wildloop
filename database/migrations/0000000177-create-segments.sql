-- Segments, and the efforts run on them.
--
-- A segment is a named stretch of trail somebody drew - a climb, a descent, a
-- sprint - and an effort is one recorded run of it. The leaderboard is the
-- fastest effort per athlete, so nobody tops a board by running it often.
--
-- The geometry is stored as JSON rather than as a geometry type, the same way
-- trails and activities already are, because the database is SQLite in
-- production and matching happens in application code either way. See
-- resources/functions/segment-matching.ts for what counts as having run it.
--
-- The bounding box is denormalised onto the row so a saved activity can find
-- its candidate segments with an indexed range scan instead of parsing every
-- segment geometry in the catalog. It is derived from the geometry and must be
-- written with it.
--
-- Direction matters: a descent is not the climb, so the matcher requires the
-- track to visit the segment points in order. That is why start and end are
-- stored separately rather than inferred from an unordered box.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "segments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uuid" TEXT NOT NULL,
  "trail_id" INTEGER REFERENCES "trails"("id") ON DELETE SET NULL,
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "activity_type" TEXT NOT NULL DEFAULT 'Trail Run' CHECK ("activity_type" IN ('Trail Run', 'Hike', 'Walk', 'Bike')),
  "geometry" TEXT NOT NULL,
  "distance" REAL NOT NULL,
  "elevation" INTEGER NOT NULL DEFAULT 0,
  "start_lat" REAL NOT NULL,
  "start_lng" REAL NOT NULL,
  "end_lat" REAL NOT NULL,
  "end_lng" REAL NOT NULL,
  "min_lat" REAL NOT NULL,
  "max_lat" REAL NOT NULL,
  "min_lng" REAL NOT NULL,
  "max_lng" REAL NOT NULL,
  "effort_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "segments_uuid_unique" ON "segments" ("uuid");
CREATE INDEX IF NOT EXISTS "segments_trail_index" ON "segments" ("trail_id");
CREATE INDEX IF NOT EXISTS "segments_bbox_index" ON "segments" ("min_lat", "max_lat", "min_lng", "max_lng");

CREATE TABLE IF NOT EXISTS "segment_efforts" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "segment_id" INTEGER NOT NULL REFERENCES "segments"("id") ON DELETE CASCADE,
  "activity_id" INTEGER NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "elapsed_seconds" INTEGER NOT NULL,
  "started_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- The leaderboard reads this: fastest first within one segment.
CREATE INDEX IF NOT EXISTS "segment_efforts_board_index" ON "segment_efforts" ("segment_id", "elapsed_seconds");
-- An athlete asking for their own history on a segment, and the personal best
-- the board needs to rank them by.
CREATE INDEX IF NOT EXISTS "segment_efforts_athlete_index" ON "segment_efforts" ("user_id", "segment_id", "elapsed_seconds");
-- Re-saving or deleting an activity has to find its efforts without a scan.
CREATE INDEX IF NOT EXISTS "segment_efforts_activity_index" ON "segment_efforts" ("activity_id");
-- One effort per segment per activity per start: a re-run of the matcher over
-- the same activity must not double the board.
CREATE UNIQUE INDEX IF NOT EXISTS "segment_efforts_unique" ON "segment_efforts" ("segment_id", "activity_id", "started_at");
