import { db } from '@stacksjs/orm'

/**
 * Run `work` as one SQLite write transaction on the ORM's connection.
 *
 * `BEGIN IMMEDIATE` takes the write lock before the first statement, so a
 * second process running a conflicting sequence waits for this one to commit
 * rather than interleaving with it, and a failure rolls everything back.
 *
 * `db.sql` and `db.upsert` both run on the connection this holds. That was
 * checked directly: while it is open, a write from another process is refused
 * with "database is locked", and it succeeds again after the rollback.
 */
export async function inWriteTransaction<T>(work: () => Promise<T>): Promise<T> {
  await db.sql`BEGIN IMMEDIATE`.execute()
  try {
    const result = await work()
    await db.sql`COMMIT`.execute()
    return result
  }
  catch (error) {
    await db.sql`ROLLBACK`.execute().catch(() => {})
    throw error
  }
}
