-- The activity leaderboard index, holding integrity_status as well.
--
-- A track the integrity checks refuse on physics is saved to the athlete log
-- now instead of being thrown away with a 422, and marked rejected. The
-- boards leave those out, and they read only this index (see migration
-- 0000000188), so the index has to hold the column the boards now filter on
-- or every board would go back to reading activity rows, tracks and all.
--
-- Appended last: the boards filter on visibility and completed_at first, as
-- before, and integrity_status is only ever tested, never ranged over.
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

DROP INDEX IF EXISTS "activities_board_index";

CREATE INDEX IF NOT EXISTS "activities_board_index" ON "activities" ("visibility", "completed_at", "user_id", "distance", "elevation", "integrity_status")
