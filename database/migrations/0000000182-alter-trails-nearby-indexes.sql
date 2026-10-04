-- Indexes behind the trails near somebody.
--
-- Near me filters trails to a box around a point by latitude and longitude.
-- Neither column was indexed. The index the Trail model describes as the
-- near-me prefilter is on min_lat, max_lat, min_lng and max_lng, which the
-- query never mentions, so every near-me request scanned all 596,556 rows to
-- find the two thousand around Los Angeles. This turns that into a range on
-- latitude with longitude checked inside the index.
--
-- The other two serve ranking. A near-me list counts, for each candidate
-- trail, the distinct people who saved it and who recorded an activity on it.
-- saved_trails was indexed only by user then trail, and activities.trail_id
-- not at all, so each count read the whole table.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE INDEX IF NOT EXISTS "trails_lat_lng_index" ON "trails" ("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "saved_trails_trail_index" ON "saved_trails" ("trail_id");
CREATE INDEX IF NOT EXISTS "activities_trail_index" ON "activities" ("trail_id")
