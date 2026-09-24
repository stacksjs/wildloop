-- A trail can be marked as done without being saved.
--
-- A saved_trails row used to mean the heart was on, with has_visited saying
-- the athlete had been. Marking a trail done from its page needs a row that
-- is done but not saved, and unsaving a trail that is done must not forget
-- that it was done. is_saved carries the heart, separately.
--
-- Default 1: every existing row was a save, and the release still serving
-- during a deploy inserts without this column. Comments avoid semicolons and
-- apostrophes: the migration runner splits this file on semicolons.

ALTER TABLE "saved_trails" ADD COLUMN "is_saved" INTEGER NOT NULL DEFAULT 1;
