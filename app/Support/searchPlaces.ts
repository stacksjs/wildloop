import { db } from '@stacksjs/orm'
import { REBUILD_SEARCH_PLACES_SQL } from './searchSuggest'

/**
 * Regenerate the autocomplete place list from the trails.
 *
 * Run after anything that writes trails in bulk: the seeder, and the ingest
 * once a batch has changed something. Sequential statements rather than one
 * transaction, which the query builder here only exposes for its own builder
 * calls. A suggestion request landing mid-rebuild sees fewer places for a
 * moment, never wrong ones, and the final FTS rebuild makes it consistent.
 *
 * Logged rather than thrown: stale suggestions are a far better outcome than
 * a seed or an ingest that stops.
 */
export async function rebuildSearchPlaces(): Promise<boolean> {
  try {
    for (const statement of REBUILD_SEARCH_PLACES_SQL)
      await db.sql`${db.unsafe(statement)}`.execute()
    return true
  }
  catch (error) {
    console.warn(`[search] place list rebuild failed: ${error instanceof Error ? error.message : error}`)
    return false
  }
}
