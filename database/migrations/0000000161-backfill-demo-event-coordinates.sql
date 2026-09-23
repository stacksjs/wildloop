-- Coordinates for the three demo events already in the table.
--
-- Migration 160 added latitude and longitude, and EventSeeder writes them,
-- but that seeder is not tagged for deploys: re-running it on every release
-- would also reset each event clock and every entrant lap count. So the rows
-- it created before the columns existed stayed at NULL, and the events page
-- had nothing to sort by distance. These are the same points the seeder
-- carries, matched by name and only where no point has been set, so a host
-- who has placed one of these events is left alone.
--
-- Comments here avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons outside quotes.

UPDATE events SET latitude = 40.6084, longitude = -75.4902
WHERE name = 'Rappid Backyard Invitational' AND latitude IS NULL AND longitude IS NULL;

UPDATE events SET latitude = 40.0150, longitude = -105.2705
WHERE name = 'Winter Trail Half' AND latitude IS NULL AND longitude IS NULL;

UPDATE events SET latitude = 48.1351, longitude = 11.5820
WHERE name = 'Sunday Long Run' AND latitude IS NULL AND longitude IS NULL;
