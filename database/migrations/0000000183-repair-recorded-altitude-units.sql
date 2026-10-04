-- Recorded runs stored their GPS altitude in feet. Convert them to metres.
--
-- Until the fix in e3f98656 the in-app recorder, web and native alike, put
-- feet into the altitude of every sample it uploaded, and every reader of that
-- field takes metres: elevation profiles were drawn 3.28 times too tall, and
-- segments cut from those runs got 3.28 times their climb. Only recorded runs
-- are affected. Imported files and watch uploads always carried metres.
--
-- Converted are live GPS runs (web_gps and native_gps) saved before the fix
-- went live, whose track is the recorder envelope and does not already say
-- its unit. Each converted track is stamped with altitudeUnit m, the same
-- field the recorder now sends, so this can never apply twice. Samples with
-- no altitude keep none. ORDER BY key keeps the samples in their order.
--
-- The cutoff, 05.24.27 UTC on 4 October 2026, is when the fixed recorder went
-- live in production. A run saved after it carries metres. A page left open
-- from before then and recording afterwards would still send feet, and is not
-- caught here. From the next deploy on the recorder says altitudeUnit m on
-- every upload, so no stored track is ambiguous again. The same instant is FEET_ALTITUDE_UNTIL in
-- app/Support/segmentElevationRepair.ts, which recomputes segment climb from
-- the converted runs.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

UPDATE "activities"
SET "gpx_data" = json_set(
  "gpx_data",
  '$.properties.samples',
  (
    SELECT json_group_array(
      CASE
        WHEN json_type("value", '$.altitude') IN ('integer', 'real')
          THEN json_set("value", '$.altitude', json_extract("value", '$.altitude') / 3.28084)
        ELSE json("value")
      END
      ORDER BY "key"
    )
    FROM json_each("activities"."gpx_data", '$.properties.samples')
  ),
  '$.properties.altitudeUnit',
  'm'
)
WHERE "recording_source" IN ('web_gps', 'native_gps')
  AND "created_at" < '2026-10-04T05:24:27Z'
  AND "gpx_data" IS NOT NULL
  AND json_valid("gpx_data")
  AND json_extract("gpx_data", '$.type') = 'LineString'
  AND json_type("gpx_data", '$.properties.samples') = 'array'
  AND json_extract("gpx_data", '$.properties.altitudeUnit') IS NULL
