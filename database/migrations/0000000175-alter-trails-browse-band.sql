-- The length band a trail falls in, so the catalog can open on day hikes.
--
-- The catalog is imported from OpenStreetMap, where a way is whatever a mapper
-- drew between two junctions, so most rows are not trails anybody would set
-- out to walk. A representative slice of production is 57 percent under four
-- tenths of a mile, with a median length of 0.32 miles.
--
-- That is why the list used to open on the longest routes: it was the only
-- ordering that kept quarter-mile path stubs off the first screen, and it paid
-- for that by opening on thousand-mile thru-hikes instead.
--
-- Band 0 is a day hike, up to fifteen miles. Band 1 is plausibly a walk or an
-- expedition. Band 2 is fragments and epics together at the back.
--
-- A generated column rather than a CASE in the ORDER BY, because ordering
-- 596,556 rows by an expression cannot use an index. VIRTUAL rather than
-- STORED because SQLite only allows ALTER TABLE to add the virtual kind, and
-- an index over a virtual column still stores the computed value.
--
-- Nothing has to write it and no backfill is needed: it is a function of
-- distance, so existing rows and every future import get it for free.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

ALTER TABLE "trails" ADD COLUMN "browse_band" INTEGER GENERATED ALWAYS AS (
  CASE
    WHEN "distance" >= 1 AND "distance" <= 15 THEN 0
    WHEN "distance" >= 0.4 AND "distance" <= 30 THEN 1
    ELSE 2
  END
) VIRTUAL;
CREATE INDEX IF NOT EXISTS "trails_browse_band_index" ON "trails" ("browse_band", "rating" DESC, "distance" DESC);
