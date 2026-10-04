-- Activities whose completed_at is missing or not written the way
-- toISOString() writes it.
--
-- The clubs list and a club page count the week and find the newest runs from
-- the (user_id, completed_at) index, which is time order only for that one
-- fixed-width shape. completed_at only has to be something Date.parse reads,
-- so the few rows in any other shape are read separately and judged in
-- JavaScript (app/Support/clubWeeklyStats and clubRecentFeed). Without this
-- index, finding those few meant testing every member activity on every
-- request. With it SQLite keeps the set as rows are written, and reading it
-- costs what it holds, which in practice is nothing.
--
-- The queries repeat this WHERE clause, or one side of it, word for word:
-- SQLite only uses a partial index for a query whose terms imply its WHERE.
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

CREATE INDEX IF NOT EXISTS "activities_odd_completed_index" ON "activities" ("user_id")
  WHERE "completed_at" IS NULL OR "completed_at" IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', "completed_at")
