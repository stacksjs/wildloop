-- The indexes the catalog is walked by when somebody sorts it by rating, by
-- popularity or by name and has not shared where they are.
--
-- Migration 0000000199 gave the order the catalog opens on an index of its
-- own, everywhere and by country. The other orders a visitor can pick had
-- none: top rated and popular each read every row of the country, or of the
-- catalog, and sorted them in a temporary tree, and A to Z did the same for
-- one country. On a 596,556 row copy built from these migrations the first
-- page took, warm, about 500 ms (top rated, everywhere), 870 ms (top rated,
-- US), 300 ms and 800 ms (popular) and 850 ms (A to Z, US), and 4.9 seconds
-- for top rated from a cold cache.
--
-- Each holds every column of its order, in its directions, as
-- app/Support/catalogOrder.ts writes them. id is the rowid every index ends
-- on, so the planner walks one in order and stops at the end of the page.
-- One for everywhere and one led by country for top rated and popular. A to
-- Z everywhere already walks trails_name_index, so it only needs the one led
-- by country. The pieces trail_parts names are still left out with one
-- primary key lookup per row walked. On the same copy every one of those
-- pages now takes 0.3 to 1.5 ms, and the eleventh page about as long.
--
-- Popular, without a location, is reviews and then rating, both columns of
-- the row, so an index answers it. Nearby, popular also reads views and
-- activities, and is ranked in app/Support/trailRanking.ts from the rows in
-- the box rather than from an index.
--
-- Building them reads every row, country included, which sits after the
-- stored line. Under a second each on the copy, whose lines are short, and
-- expect about what migration 0000000199 took on production lines, some ten
-- seconds an index, once. Together they add about 90 MB on the copy.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE INDEX IF NOT EXISTS "trails_rating_order_index" ON "trails" ("rating" DESC, "review_count" DESC, "browse_band", "distance" DESC);
CREATE INDEX IF NOT EXISTS "trails_country_rating_order_index" ON "trails" ("country", "rating" DESC, "review_count" DESC, "browse_band", "distance" DESC);
CREATE INDEX IF NOT EXISTS "trails_popular_order_index" ON "trails" ("review_count" DESC, "rating" DESC, "browse_band", "distance" DESC);
CREATE INDEX IF NOT EXISTS "trails_country_popular_order_index" ON "trails" ("country", "review_count" DESC, "rating" DESC, "browse_band", "distance" DESC);
CREATE INDEX IF NOT EXISTS "trails_country_name_index" ON "trails" ("country", "name")
