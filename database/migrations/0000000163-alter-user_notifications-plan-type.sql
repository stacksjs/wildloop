-- Allow plan reminders in user_notifications.
--
-- The type column carries a CHECK list and SQLite cannot alter a CHECK in
-- place, so the table is rebuilt with plan added, exactly as the record type
-- was added in 0000000130. Every row and column is copied across and the
-- uuid index recreated. One transaction, so a reader sees the old table or
-- the new one and never neither.
--
-- Comments avoid semicolons and apostrophes: the migration runner splits
-- this file on semicolons outside quotes.

PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE "_qb_tmp_user_notifications" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "recipient_id" INTEGER not null,
  "actor_id" INTEGER,
  "actor_name" TEXT,
  "type" TEXT CHECK ("type" IN ('kudos', 'comment', 'follow', 'conquest', 'conquest_attack', 'conquest_defend', 'conquest_win', 'achievement', 'challenge', 'record', 'plan')),
  "body" TEXT,
  "link" TEXT,
  "read" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
INSERT INTO "_qb_tmp_user_notifications" ("id", "recipient_id", "actor_id", "actor_name", "type", "body", "link", "read", "created_at", "updated_at", "uuid") SELECT "id", "recipient_id", "actor_id", "actor_name", "type", "body", "link", "read", "created_at", "updated_at", "uuid" FROM "user_notifications";
DROP TABLE "user_notifications";
ALTER TABLE "_qb_tmp_user_notifications" RENAME TO "user_notifications";
CREATE UNIQUE INDEX IF NOT EXISTS "user_notifications_uuid_unique" ON "user_notifications" ("uuid");
PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys=ON;
