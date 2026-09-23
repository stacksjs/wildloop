-- Trips someone has planned: a catalog trail or any spot, on a calendar day.
--
-- The destination point and title are copied onto the row even for a trail.
-- Directions need a point, the plan must open offline at a trailhead, and a
-- trail renamed or pulled from the catalog must not take the trip with it.
-- trail_id is therefore nullable and only links back when there is a trail.
--
-- planned_for is a YYYY-MM-DD calendar day, not an instant. timezone is where
-- the plan was made, and the day-before reminder counts days in it.
-- reminded_at stays NULL until that reminder is sent, so the hourly job can
-- find the plans still owed one through the second index.
--
-- A new table only, so the release still serving during a deploy is not
-- affected. Comments avoid semicolons and apostrophes: the migration runner
-- splits this file on semicolons outside quotes.

CREATE TABLE IF NOT EXISTS "trip_plans" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER not null REFERENCES "users"("id"),
  "trail_id" INTEGER REFERENCES "trails"("id"),
  "title" TEXT not null,
  "place_label" TEXT,
  "latitude" REAL not null,
  "longitude" REAL not null,
  "planned_for" TEXT not null,
  "start_time" TEXT,
  "timezone" TEXT,
  "activity_type" TEXT,
  "notes" TEXT,
  "reminded_at" TEXT,
  "uuid" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "trip_plans_user_date_index" ON "trip_plans" ("user_id", "planned_for");
CREATE INDEX IF NOT EXISTS "trip_plans_reminder_index" ON "trip_plans" ("reminded_at", "planned_for");
CREATE UNIQUE INDEX IF NOT EXISTS "trip_plans_uuid_unique" ON "trip_plans" ("uuid");
