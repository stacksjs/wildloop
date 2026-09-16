import { db } from '@stacksjs/orm'
import { REBUILD_SEARCH_PLACES_SQL } from './searchSuggest'
import { inWriteTransaction } from './writeTransaction'

/**
 * Regenerate the autocomplete place list from the trails.
 *
 * Run after anything that writes trails in bulk: the seeder, and the ingest
 * once a batch has changed something.
 *
 * One transaction. As separate statements, two rebuilds that overlapped (the
 * worker's and a manual ingest's, say) interleaved their deletes and inserts
 * and stored every place twice, and a failure after the delete left the list
 * empty until the next success. Now a second rebuild waits, and a failure
 * keeps the previous list.
 *
 * Logged rather than thrown: stale suggestions are a far better outcome than
 * a seed or an ingest that stops.
 */
export async function rebuildSearchPlaces(): Promise<boolean> {
  try {
    await inWriteTransaction(async () => {
      for (const statement of REBUILD_SEARCH_PLACES_SQL)
        await db.sql`${db.unsafe(statement)}`.execute()
    })
    return true
  }
  catch (error) {
    console.warn(`[search] place list rebuild failed: ${error instanceof Error ? error.message : error}`)
    return false
  }
}
