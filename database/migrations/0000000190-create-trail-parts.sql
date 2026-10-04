-- Which catalog rows are pieces of another trail, and so not listed on their own.
--
-- The catalog is imported from OpenStreetMap, where a way is whatever a mapper
-- drew between two junctions, so one real trail is often several rows. In 8,368
-- production rows around Los Angeles, Boulder and Garmisch, 57 percent share
-- their exact name with another row in the same country, and 35 percent are a
-- piece of a same-named row whose line they join and which starts within three
-- miles of them. The nightly trails:fold-fragments and the ingest decide which
-- (app/Support/trailFragments.ts), and this is where the answer is kept.
--
-- A piece is hidden, never deleted. Its row stays, so nothing that points at
-- a trail id breaks - saved trails, activities, reviews, photos, efforts,
-- segments, page views, plans - and its page answers with a permanent
-- redirect to the trail it is part of. Removing a row here lists it again.
--
-- A table of its own rather than a column on trails, for the catalog queries.
-- They filter with id NOT IN this table, which SQLite answers with one
-- primary key lookup per row it already reads and which cannot change the
-- index a query plans on, so the counts the existing indexes cover stay
-- covered. A column added to trails sits after geometry, so reading it reads
-- through the stored line: on a 600,000 row copy the count behind the
-- catalog for one country went from 6 ms to 530 ms that way, and 90 ms this
-- way. Writing here also leaves the trail rows, and their lines, unrewritten.
--
-- country repeats the piece row country, which is always its trail country
-- too. It is there for the count the catalog opens on, filtered by country
-- and nothing else: that is the covered count for the country less the
-- pieces in it, two index lookups instead of one lookup per row.
--
-- trail_fold_progress is where the nightly walk is up to. It walks the names
-- shared by more than one row in name order, a slice a night, and starts
-- again from the beginning once it reaches the end, so a decision the ingest
-- missed is corrected on the next pass.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "trail_parts" (
  "trail_id" INTEGER PRIMARY KEY REFERENCES "trails"("id") ON DELETE CASCADE,
  "part_of" INTEGER NOT NULL REFERENCES "trails"("id") ON DELETE CASCADE,
  "country" TEXT,
  "folded_at" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "trail_parts_part_of_index" ON "trail_parts" ("part_of");
CREATE INDEX IF NOT EXISTS "trail_parts_country_index" ON "trail_parts" ("country");
CREATE TABLE IF NOT EXISTS "trail_fold_progress" (
  "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
  "after_name" TEXT NOT NULL DEFAULT '',
  "passes" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TEXT
)
