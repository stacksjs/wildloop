-- Drop the indexes that deploys generated a second time over.
--
-- The deploy job ran its setup action on the CI runner, and that action ran
-- buddy migrate WITH generation against an empty database inside the very
-- checkout that was then packaged and shipped. Generation writes one
-- create-TABLE-table file per model, numbered after the newest migration, and
-- the server then applied them as if they had been committed. They are all
-- IF NOT EXISTS, so most were no-ops - but the models name their indexes
-- without the table prefix the committed migrations use, so each of these
-- created a SECOND identical index beside the committed one. Production held
-- 35 duplicate pairs, nine of them on the 600,000-row trails table, each one
-- costing disk and slowing every write for nothing.
--
-- Only names that no committed migration creates are dropped here, so the
-- runner (which re-creates a missing unique index from its migration file)
-- has nothing to put back. The nine pairs where BOTH names come from
-- committed migrations are left alone for the same reason.
--
-- The deploy now ships exactly the commit CI approved (deploy.yml), so this
-- does not recur.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits this
-- file on semicolons.

DROP INDEX IF EXISTS "achievements_uuid_unique";
DROP INDEX IF EXISTS "activities_uuid_unique";
DROP INDEX IF EXISTS "activity_comments_uuid_unique";
DROP INDEX IF EXISTS "challenges_uuid_unique";
DROP INDEX IF EXISTS "club_members_club_user_unique";
DROP INDEX IF EXISTS "club_members_uuid_unique";
DROP INDEX IF EXISTS "clubs_uuid_unique";
DROP INDEX IF EXISTS "follows_follower_following_unique";
DROP INDEX IF EXISTS "follows_uuid_unique";
DROP INDEX IF EXISTS "kudos_giver_activity_unique";
DROP INDEX IF EXISTS "kudos_uuid_unique";
DROP INDEX IF EXISTS "territories_uuid_unique";
DROP INDEX IF EXISTS "territory_histories_uuid_unique";
DROP INDEX IF EXISTS "trails_country_distance_index";
DROP INDEX IF EXISTS "trails_country_state_name_index";
DROP INDEX IF EXISTS "trails_distance_index";
DROP INDEX IF EXISTS "trails_bbox_index";
DROP INDEX IF EXISTS "trails_national_trail_index";
DROP INDEX IF EXISTS "trails_source_source_id_unique";
DROP INDEX IF EXISTS "trails_state_index";
DROP INDEX IF EXISTS "trails_synced_at_index";
DROP INDEX IF EXISTS "trails_uuid_unique";
DROP INDEX IF EXISTS "user_achievements_user_achievement_unique";
DROP INDEX IF EXISTS "user_achievements_uuid_unique";
DROP INDEX IF EXISTS "users_email_unique";
DROP INDEX IF EXISTS "users_uuid_unique"
