-- A plan can be for a route someone drew, not only a catalog trail or a spot.
--
-- custom_route_id links the plan to that saved route so the plans page can
-- open it again. The plan still carries its own point and title, copied from
-- the route start and name, so a deleted route leaves a plan that works.
--
-- Nullable with no default, so the change is additive and the release still
-- serving during a deploy keeps working. Comments avoid semicolons and
-- apostrophes: the migration runner splits this file on semicolons.

ALTER TABLE "trip_plans" ADD COLUMN "custom_route_id" INTEGER REFERENCES "custom_routes"("id");
