-- Clear dog policies the ingest guessed rather than read.
--
-- Until now the ingest recorded a value for every trail even where its source
-- says nothing. NPS was hardcoded to no, USFS to yes, and OSM read a missing
-- dog tag as no. The trail page shows a "No dogs" notice for no and a
-- Dog-friendly badge for yes, so most trails made a claim with nothing
-- behind it.
--
-- NULL means not recorded, which the page shows as nothing. Only rows the
-- ingest wrote are touched. Their source ids contain a slash (relation/123,
-- nps/..., usfs/...). Seeded trails use plain slugs and carry hand-checked
-- values, so they are left alone. OSM rows marked yes came from an explicit
-- tag and stay. An explicit OSM dog=no is cleared here too, because the
-- stored 0 cannot be told apart from a missing tag. The next re-sync restores
-- it, since dogs_allowed is one of the columns a re-sync rewrites.
--
-- Comments here avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons outside quotes.

UPDATE trails SET dogs_allowed = NULL
WHERE source IN ('nps', 'usfs') AND source_id LIKE source || '/%';

UPDATE trails SET dogs_allowed = NULL
WHERE source = 'osm' AND dogs_allowed = 0 AND source_id LIKE '%/%';
