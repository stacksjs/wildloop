-- When the elevation gain on a trail was last measured, as opposed to what it is.
--
-- The column "elevation" treats 0 as not recorded, so the backfill never
-- writes a zero: a flat trail would otherwise claim a measurement the page
-- then denies. That left the two states indistinguishable. A sample of 150
-- production trails measured 49 percent with gain, 33 percent at exactly zero
-- and all of those under half a mile, so a third of the catalog was measured,
-- discarded, and measured again on the next run. The job had no end state.
--
-- This column records the answer having been reached. The backfill skips rows
-- that carry it, so a second run is a no-op, and the trail page can say a
-- trail is flat rather than that nobody knows.
--
-- NULL means never measured, which is every row today and the behaviour the
-- release still serving during a deploy expects. Comments avoid semicolons and
-- apostrophes: the migration runner splits this file on semicolons.

ALTER TABLE "trails" ADD COLUMN "elevation_checked_at" TEXT;
UPDATE "trails" SET "elevation_checked_at" = "updated_at" WHERE "elevation" > 0;
