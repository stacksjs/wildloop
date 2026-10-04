-- How much of each route relation is walked along streets and sidewalks.
--
-- A route relation in OpenStreetMap says what the route is and nothing about
-- what it is walked on, so a city walking tour arrives looking like a loop
-- hike: the Hollywood Walk of Fame is a 3 mile route=foot loop whose every
-- member is a sidewalk or a crosswalk, and it ranked sixth near downtown Los
-- Angeles. The ingest now reads the member ways and records the share of the
-- route length on streets (app/Support/streetShare.ts), and ranking demotes a
-- route that is mostly street (streetAppeal in app/Support/trailRanking.ts).
--
-- Demoted, not hidden or deleted. Nothing that points at a trail id breaks,
-- and a street walk can still be found by name. It is just never offered as
-- one of the trails near somebody.
--
-- One row per relation measured, including those with no street at all, so
-- the nightly trails:measure-streets can tell a relation it has measured from
-- one it has not. Ways have no row: the ingest asks for them by their own
-- tags and already leaves sidewalks out. share is null for a relation that
-- gave nothing to measure, which includes one OpenStreetMap no longer has.
--
-- A table of its own rather than a column on trails for the reason
-- trail_parts gives: a column added to trails sits after geometry, and ranking
-- reads a few thousand rows at a time without reading their lines.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE TABLE IF NOT EXISTS "trail_street_shares" (
  "trail_id" INTEGER PRIMARY KEY REFERENCES "trails"("id") ON DELETE CASCADE,
  "share" REAL,
  "measured_at" TEXT NOT NULL
)
