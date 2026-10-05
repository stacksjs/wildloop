-- The index the catalog opens on.
--
-- The first page of the trail list for somebody who has not shared where they
-- are is ordered by browse_band, rating, review_count, national_trail and
-- distance, then id, in TrailIndexAction. The index from migration 0000000175
-- covered browse_band, rating and distance only, so SQLite walked it as far
-- as rating and then sorted every row of each band in a temporary tree: on a
-- 596,556 row copy that page took 550 ms to 3.3 s everywhere and 870 ms for
-- one country, against 2 ms near somebody.
--
-- These hold every column of that order, in its directions, and id is the
-- rowid every index ends on, so the planner walks one in order and stops at
-- the end of the page. One for everywhere and one led by country, because the
-- list is answered for the visitor country unless they ask for everywhere: on
-- the same copy both pages take 1 to 2 ms. The pieces trail_parts names are
-- still left out with one primary key lookup per row walked.
--
-- They replace trails_browse_band_index, whose columns are the leading part
-- of the first one and which nothing else reads: the ranked list near
-- somebody, and the metro photo picks, range on latitude instead.
--
-- Building them reads every row, national_trail and country included, which
-- sit after the stored line: about 20 seconds on the copy, once.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE INDEX IF NOT EXISTS "trails_browse_order_index" ON "trails" ("browse_band", "rating" DESC, "review_count" DESC, "national_trail" DESC, "distance" DESC);
CREATE INDEX IF NOT EXISTS "trails_country_browse_order_index" ON "trails" ("country", "browse_band", "rating" DESC, "review_count" DESC, "national_trail" DESC, "distance" DESC);
DROP INDEX IF EXISTS "trails_browse_band_index"
