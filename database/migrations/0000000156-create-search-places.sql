-- Autocomplete for the home search: the places the trail catalog can be
-- searched by.
--
-- Built from the trails themselves and never from an outside list, so every
-- suggestion leads to trails that exist. A `place` row is a distinct trail
-- `location` (a park, a forest, or a town where a record carries one) and a
-- `region` row is a state or Land.
--
-- Rebuilt in one pass rather than kept in step row by row. Grouping 600k
-- trails on every keystroke would be far too slow, and grouping them once
-- after an import or a seed is not. See app/Support/searchPlaces.ts.
--
-- Created empty. Backfilling here would hold a write on the shared production
-- file during deploy, and the first rebuild fills it instead.
--
-- Comments here avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons outside quotes.

CREATE TABLE IF NOT EXISTS search_places (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT '',
  "state_name" TEXT NOT NULL DEFAULT '',
  "country" TEXT NOT NULL DEFAULT '',
  "trail_count" INTEGER NOT NULL DEFAULT 0
);

-- prefix indexes for two and three characters, which is where a typed
-- prefix is short enough to match a large share of rows.
CREATE VIRTUAL TABLE IF NOT EXISTS search_places_fts USING fts5(
  label,
  state_name,
  content='search_places',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2",
  prefix='2 3'
);
