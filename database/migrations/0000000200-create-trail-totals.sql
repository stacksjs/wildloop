-- How long a folded trail is, pieces included.
--
-- trails:fold-fragments hides the pieces of a trail under the row it keeps
-- (trail_parts, migration 0000000190), but that row still carries only its
-- own length: Mesa Trail in Boulder listed 1.14 miles while its pieces
-- together are much longer. In production 169,882 of 596,556 rows are pieces.
--
-- One row per kept trail that has pieces. distance is in miles, the kept
-- row distance plus each piece distance, less whatever part of a piece
-- lies along a line already counted, so a way drawn twice, or a route
-- relation beside the ways it is made of, counts once
-- (app/Support/wholeTrail.ts). elevation is the gain in feet summed the same
-- way, and null unless every row counted has had its elevation measured.
-- pieces is how many pieces folded into the trail. country, latitude and
-- longitude repeat the kept row, so the catalog sorted by length can find
-- the trails with pieces in a country or around somebody from this table
-- alone, in order of its length index, before it reads their rows.
--
-- The fold writes these with the pieces they account for, and fills any
-- kept trail that has pieces and no row here a batch at a time, so rows
-- folded before this table existed are filled by the nightly run.
--
-- A table of its own rather than columns on trails for the reason
-- trail_parts gives: a column added to trails sits after geometry, so
-- reading it reads through the stored line, and writing it would rewrite
-- the line of every trail it touched. The kept row keeps its own distance
-- and line for activity matching, records, territory and segments, which
-- all follow that line.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "trail_totals" (
  "trail_id" INTEGER PRIMARY KEY REFERENCES "trails"("id") ON DELETE CASCADE,
  "distance" REAL NOT NULL,
  "elevation" REAL,
  "pieces" INTEGER NOT NULL,
  "country" TEXT,
  "latitude" REAL,
  "longitude" REAL,
  "computed_at" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "trail_totals_distance_index" ON "trail_totals" ("distance");
CREATE INDEX IF NOT EXISTS "trail_totals_country_distance_index" ON "trail_totals" ("country", "distance")
