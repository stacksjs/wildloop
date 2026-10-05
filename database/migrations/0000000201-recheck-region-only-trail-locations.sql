-- Ask again for a place name for every trail that still names only its region.
--
-- The nightly trails:repair-locations stamps location_checked_at on every row
-- it reads, including the ones it found nothing for, so none is asked twice.
-- After a full pass 30833 production trails still read only their region, and
-- the rules that left them have since grown. Towns over a border no longer
-- crowd out the ones on this side, an operator tag naming a park or forest
-- counts, a forest is recognised in the back country where its trails are
-- kilometres apart, and a trail with no town within 25 km can be Near one
-- within 45 km when no ridge stands between them. Clearing the stamp hands
-- these rows to the next night, which decides them with those rules.
--
-- Only rows that still name only their region: the location is empty, or is
-- the region name or code. A trail already named after a park or a town is
-- never touched, and keeps its stamp.
--
-- Written for the size of the table. The region columns and the stamp sit
-- after geometry, so comparing them on every row would page through every
-- stored line. The location sits before it, so the scan first matches the
-- location against the set of region names and codes, which the region
-- index answers without reading the table, and reads the later columns only
-- for the rows that match. Comments avoid semicolons and apostrophes: the
-- migration runner splits this file on semicolons.

UPDATE "trails"
SET "location_checked_at" = NULL
WHERE (
    trim(coalesce("location", '')) = ''
    OR lower(trim("location")) IN (
      SELECT lower(trim("state_name")) FROM "trails" WHERE "state_name" IS NOT NULL
      UNION
      SELECT lower(trim("state")) FROM "trails" WHERE "state" IS NOT NULL
    )
  )
  AND (
    trim(coalesce("location", '')) = ''
    OR lower(trim("location")) = lower(trim(coalesce("state_name", '')))
    OR lower(trim("location")) = lower(trim(coalesce("state", '')))
  )
  AND "location_checked_at" IS NOT NULL
