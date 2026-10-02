-- Heart rate on an activity, as a summary rather than a track.
--
-- Two columns, not a per-sample series. The series is the better shape for a
-- chart later, but it belongs beside the route in gpx_data rather than in a
-- column, and nothing in the app draws one yet. Average and max are what the
-- activity page shows and what every importable file already summarises.
--
-- Nullable with no default on purpose. Most activities have no heart rate and
-- never will, and a default of zero would read as a stopped heart on every
-- row ever saved. Null means the app does not know, which is the truth.
ALTER TABLE "activities" ADD COLUMN "heart_rate_avg" INTEGER;
ALTER TABLE "activities" ADD COLUMN "heart_rate_max" INTEGER;
