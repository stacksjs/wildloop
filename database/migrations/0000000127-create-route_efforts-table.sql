CREATE TABLE IF NOT EXISTS "route_efforts" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "trail_id" INTEGER not null REFERENCES "trails"("id"),
  "user_id" INTEGER not null REFERENCES "users"("id"),
  "activity_id" INTEGER REFERENCES "activities"("id"),
  "style" TEXT CHECK ("style" IN ('supported', 'self_supported', 'unsupported')) NOT NULL DEFAULT 'self_supported',
  "category" TEXT CHECK ("category" IN ('mens', 'womens', 'nonbinary')) NOT NULL DEFAULT 'mens',
  "direction" TEXT CHECK ("direction" IN ('standard', 'reverse', 'yo_yo')) NOT NULL DEFAULT 'standard',
  "team_size" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT CHECK ("status" IN ('in_progress', 'dnf', 'pending', 'verified', 'rejected')) NOT NULL DEFAULT 'pending',
  "started_at" TEXT not null,
  "finished_at" TEXT,
  "elapsed_seconds" INTEGER,
  "evidence_url" TEXT,
  "gpx_url" TEXT,
  "tracker_url" TEXT,
  "trip_report" TEXT,
  "reviewed_by" INTEGER REFERENCES "users"("id"),
  "reviewed_at" TEXT,
  "review_note" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);

CREATE INDEX IF NOT EXISTS "route_efforts_board_index" ON "route_efforts" ("trail_id", "direction", "category", "style", "elapsed_seconds");
CREATE INDEX IF NOT EXISTS "route_efforts_status_started_index" ON "route_efforts" ("status", "started_at");
CREATE INDEX IF NOT EXISTS "route_efforts_status_finished_index" ON "route_efforts" ("status", "finished_at");
CREATE INDEX IF NOT EXISTS "route_efforts_user_index" ON "route_efforts" ("user_id", "finished_at");
CREATE INDEX IF NOT EXISTS "route_efforts_activity_index" ON "route_efforts" ("activity_id");

-- An effort filed from a Wildloop recording is filed once. Without this a
-- double-tap on "claim this as a record" produces two identical rows on the
-- board, and the second one is indistinguishable from a real second attempt.
-- Partial, because NULL activity_id (a record set on somebody else's watch)
-- is the common case and must stay repeatable.
CREATE UNIQUE INDEX IF NOT EXISTS "route_efforts_activity_unique" ON "route_efforts" ("activity_id") WHERE "activity_id" IS NOT NULL;
