-- The activity leaderboard, read from an index rather than the table.
--
-- GET /api/activities/leaderboard sums distance and elevation per athlete
-- over the public activities of a week, a month or all time. Every column it
-- reads is in this index, in the order the public boards filter on, so a
-- board costs the entries in its period and never an activity row. That
-- matters because visibility and completed_at sit after gpx_data in the row,
-- and reading them from the table means reading every track on the way.
--
-- The following board reads the same index for the three visibilities.
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE INDEX IF NOT EXISTS "activities_board_index" ON "activities" ("visibility", "completed_at", "user_id", "distance", "elevation")
