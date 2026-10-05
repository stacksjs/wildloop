-- How hard a folded trail is, pieces included.
--
-- trail_totals (migration 0000000200) gave a trail folded from pieces its
-- whole length and ascent, and the catalog shows, filters and ranks on them.
-- Its grade stayed the one the kept row was given at ingest from its own
-- length and ascent: Mesa Trail in Boulder kept the grade of its own 1.14
-- miles whatever its pieces added, on the card, the page and the filter.
--
-- difficulty is the grade deriveDifficulty in app/Ingest/normalize.ts gives
-- the whole length and ascent, never easier than a grade the kept row has
-- from its source rather than from its length and ascent, such as a Forest
-- Service trail class (app/Support/wholeTrail.ts). The fold writes it with
-- the totals.
--
-- Null for a total written before this column, which the catalog then reads
-- as the grade of the kept row, as before. The nightly fold works those out
-- again with the totals it fills, up to its totals limit a night, or all at
-- once with trails:fold-fragments --totals-only --totals-limit 0.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

ALTER TABLE "trail_totals" ADD COLUMN "difficulty" TEXT CHECK ("difficulty" IN ('easy', 'moderate', 'hard'));
CREATE INDEX IF NOT EXISTS "trail_totals_difficulty_index" ON "trail_totals" ("difficulty")
