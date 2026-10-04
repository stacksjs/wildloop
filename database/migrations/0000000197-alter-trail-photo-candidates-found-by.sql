-- How each trail photo candidate was found, and how far from the trail (#1006).
--
-- Until now every candidate came from a geosearch around the trail head, so
-- the review page could say each one was taken within a few kilometres of
-- it. The nightly job now also searches Commons by the trail name, and those
-- files are held to a different test: coordinates within a few kilometres of
-- the trail when the file has any, and the park or region named on the file
-- page when it has none. A reviewer should know which kind is in front of
-- them, so the row says.
--
-- found_by is nearby for the geosearch and name for the name search.
-- distance_m is metres from the trail for a name-search file with
-- coordinates, and empty otherwise. Rows already written are all nearby.
--
-- Trails already looked up that found nothing to review are forgotten, so
-- the next nights search them again with both searches rather than waiting
-- out the 90 days. Those are the trails a search by name helps most. A
-- trail with candidates waiting is skipped by the job either way, and a
-- second geosearch adds only files not already on record.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

ALTER TABLE "trail_photo_candidates" ADD COLUMN "found_by" TEXT NOT NULL DEFAULT 'nearby';
ALTER TABLE "trail_photo_candidates" ADD COLUMN "distance_m" REAL;
DELETE FROM "trail_photo_searches" WHERE "accepted" = 0
