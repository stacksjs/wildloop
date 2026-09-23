-- Where an event happens, as coordinates.
--
-- Until now an event carried only a free-text location such as Boulder, CO,
-- which a person can read but a page cannot measure. The events page sorts
-- by distance from the visitor and filters by a radius, and both need a
-- point. An event on a trail takes the trail position when it is created.
-- Any other event takes the point its host gave, or none.
--
-- Both columns are nullable and have no default. NULL means the position is
-- not known, and the page sorts those events last rather than guessing. The
-- change is additive, so the release still serving during a deploy keeps
-- working while this runs.
--
-- Comments here avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons outside quotes.

ALTER TABLE "events" ADD COLUMN "latitude" REAL;
ALTER TABLE "events" ADD COLUMN "longitude" REAL;
