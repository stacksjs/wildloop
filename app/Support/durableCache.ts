import type { CacheDriver } from '@stacksjs/types'
import { createCache } from '@stacksjs/cache'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * Results worth keeping across deploys, in `cache.sqlite` beside the app's
 * database.
 *
 * The default cache is memory, and production restarts on every deploy, so
 * whatever it held - an elevation profile measured by an external service in
 * 600-800ms - was paid for again after each one. Beside the database means
 * the shared directory in production (config/cloud.ts, kept across releases),
 * `database/` locally, and the throwaway QA directory in a QA run. A file of
 * its own keeps cache writes off the app database's write lock and out of
 * its backups.
 */
export function durableCachePath(databasePath: string | undefined = process.env.DB_DATABASE_PATH): string {
  return join(dirname(databasePath || 'database/stacks.sqlite'), 'cache.sqlite')
}

let durable: CacheDriver | null = null

/** Opened on first use, so importing an action does not open a database. */
export function durableCache(): CacheDriver {
  durable ??= createCache('sqlite', { path: durableCachePath(), prefix: 'wildloop' })
  return durable
}
