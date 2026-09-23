import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { Gazetteer } from 'ts-maps/gazetteer'

/**
 * Where the place-search database lives: `GAZETTEER_PATH`, or beside the app
 * database. In production that is the shared directory outside the release,
 * so the file is built once and every release and both processes read it.
 */
export function gazetteerPath(): string {
  if (process.env.GAZETTEER_PATH)
    return resolve(process.env.GAZETTEER_PATH)
  const database = process.env.DB_DATABASE_PATH || 'database/stacks.sqlite'
  return join(dirname(resolve(database)), 'gazetteer.sqlite')
}

let open: { path: string, mtimeMs: number, gazetteer: Gazetteer } | null = null

/**
 * The gazetteer, or null when it has not been built yet (`buddy geo:import`).
 *
 * A rebuild renames a new file over the old one, and a handle already open
 * keeps reading the old inode — so the modification time is checked on each
 * call and a newer file is reopened. A stat is microseconds; a search that
 * silently kept answering from last month's data would not be noticed.
 */
export function openGazetteer(): Gazetteer | null {
  const path = gazetteerPath()
  if (!existsSync(path)) {
    open?.gazetteer.close()
    open = null
    return null
  }
  const { mtimeMs } = statSync(path)
  if (open && open.path === path && open.mtimeMs === mtimeMs)
    return open.gazetteer
  open?.gazetteer.close()
  try {
    open = { path, mtimeMs, gazetteer: new Gazetteer(path) }
    return open.gazetteer
  }
  catch {
    open = null
    return null
  }
}
