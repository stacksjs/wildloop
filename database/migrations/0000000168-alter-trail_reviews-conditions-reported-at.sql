-- When the condition on a review was seen, as opposed to when the review was
-- written.
--
-- There is one review per person per trail, so somebody who walked a trail
-- months ago and finds it flooded today edits the review they already have.
-- created_at still says months ago, so the trail page filed the flooding as
-- old news and showed no warning. This column carries the report time.
--
-- Backfilled from the visit date, else the day the review was written, which
-- is exactly what the page used to read. Rows without a condition stay NULL.
-- The release still serving during a deploy does not write this column, and a
-- NULL falls back to the old behaviour. Comments avoid semicolons and
-- apostrophes: the migration runner splits this file on semicolons.

ALTER TABLE "trail_reviews" ADD COLUMN "conditions_reported_at" TEXT;
UPDATE "trail_reviews" SET "conditions_reported_at" = COALESCE("visit_date", "created_at") WHERE "conditions" IS NOT NULL;
