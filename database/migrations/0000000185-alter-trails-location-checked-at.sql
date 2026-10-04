-- When a trail was last asked for a better place name than its region.
--
-- Most of the catalog came from OpenStreetMap, which records no place for a
-- trail, so the ingest wrote the region and nothing finer. Around Los Angeles
-- 76 percent of 2190 sampled trails read California. The nightly
-- trails:repair-locations names them after the park they are in or the
-- nearest town, a slice a night.
--
-- Some trails have no better answer: nothing near enough to name them by, or
-- a line too long for one town to describe. Keyed on the location alone those
-- rows would be asked again every night forever. This column records that
-- the question was answered, the same way elevation_checked_at does for gain.
--
-- NULL means never asked, which is every row today and the behaviour the
-- release still serving during a deploy expects.
--
-- The partial index keeps the outstanding rows findable without reading the
-- table. The column sits after geometry, so finding unchecked rows by a scan
-- would page through every stored line, and the index shrinks to nothing as
-- the backfill finishes. Comments avoid semicolons and apostrophes: the
-- migration runner splits this file on semicolons.

ALTER TABLE "trails" ADD COLUMN "location_checked_at" TEXT;
CREATE INDEX IF NOT EXISTS "trails_location_unchecked_index" ON "trails" ("id") WHERE "location_checked_at" IS NULL
