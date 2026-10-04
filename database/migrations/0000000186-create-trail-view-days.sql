-- How many times each trail page was looked at, one row per trail per day.
--
-- Ranking reads what people do with a trail - saves, completions, photos -
-- and today almost nobody has done any of that, so the near-me lists lean on
-- what a trail name suggests. A page view is the weakest kind of interest, but
-- it is the one there is plenty of, and it is the signal a popular sort needs.
--
-- Only the daily total is kept. No row says who looked: no user id, no
-- address, no browser. Telling one visitor from the next, so a reload is not
-- a second view, happens in the memory of the server process and is gone
-- within hours. See app/Support/trailViews.ts for what counts as a view.
--
-- The primary key is the read: ranking asks for a few thousand trails at a
-- time, each over the last thirty days. Without rowid, so the table is that
-- index and nothing else. The day index is for the nightly prune, which
-- removes days older than the ranking will ever read.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "trail_view_days" (
  "trail_id" INTEGER NOT NULL REFERENCES "trails"("id") ON DELETE CASCADE,
  "day" TEXT NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("trail_id", "day")
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS "trail_view_days_day_index" ON "trail_view_days" ("day")
