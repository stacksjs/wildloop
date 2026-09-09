import { Seeder } from '@stacksjs/database'
import Activity from '../../app/Models/Activity'
import Review from '../../app/Models/Review'
import RouteEffort from '../../app/Models/RouteEffort'
import SavedTrail from '../../app/Models/SavedTrail'
import Trail from '../../app/Models/Trail'
import { supersededTrailIds } from './TrailSeeder'

/**
 * Move everything off the seeded trail rows the catalog has made redundant,
 * then remove them.
 *
 * TrailSeeder used to insert its twenty-five trails unconditionally. On an
 * environment seeded before the national ingest arrived — which is what the
 * deployed one is — that left a seeded copy of each beside the ingested one:
 * same path, two rows, and the seeded copy carrying no geometry, so an
 * activity linked to it could not draw a route on a map or in the feed.
 *
 * TrailSeeder now prefers the ingested row and records which of its own rows
 * that supersedes. This moves the references across.
 *
 * ## Why this runs early
 *
 * It would be tidier to delete at the end, after each seeder had re-pointed
 * itself. They cannot. Reviews are idempotent on (user, trail) and bookmarks
 * on (user, trail), so a trail id that changes underneath them does not move
 * the row — it fails to match, and a SECOND review is written on the new
 * trail while the old one stays on the old. Re-pointing first means every
 * later seeder finds its row already on the right trail and updates in place.
 */
/**
 * Everything that points at a trail, and whether the schema allows an athlete
 * more than one of them per trail. Reviews and saved trails carry a unique
 * index on (user_id, trail_id); activities and route efforts do not, and an
 * athlete having several is entirely normal.
 */
const REFERENCES = [
  { model: Activity, oncePerAthlete: false },
  { model: Review, oncePerAthlete: true },
  { model: SavedTrail, oncePerAthlete: true },
  { model: RouteEffort, oncePerAthlete: false },
]

export default class TrailDuplicateCleanupSeeder extends Seeder {
  // Between TrailSeeder (-92), which decides what is superseded, and
  // ActivitySeeder (-85), the first seeder to look for a row by trail.
  static override order = -91

  async run(): Promise<void> {
    if (supersededTrailIds.size === 0)
      return

    let moved = 0
    let discarded = 0
    let removed = 0
    const kept: number[] = []

    for (const [oldId, newId] of supersededTrailIds) {
      for (const { model, oncePerAthlete } of REFERENCES) {
        const rows = (await model.where('trail_id', '=', oldId).get().catch(() => [])) as any[]

        for (const row of rows) {
          /*
           * Reviews and bookmarks carry a unique index on (user_id,
           * trail_id). Where this athlete already has one on the real trail,
           * moving the old row would violate it — and the ORM's failure is
           * quiet, so the row simply stays where it was and the redundant
           * trail can never be removed. The old row is the duplicate in that
           * case, so it goes.
           */
          const duplicate = oncePerAthlete && row.user_id != null
            ? await model.where('trail_id', '=', newId).where('user_id', '=', row.user_id).first().catch(() => null)
            : null

          if (duplicate) {
            await model.delete(row.id).catch(() => undefined)
            discarded += 1
            continue
          }

          await model.forceUpdate(row.id, { trail_id: newId }).catch(() => undefined)
          moved += 1
        }
      }

      // Belt and braces: never delete a row something still points at. A
      // duplicate in a catalog is untidy; an orphaned activity is broken.
      const stillReferenced = await Promise.all(
        REFERENCES.map(({ model }) => model.where('trail_id', '=', oldId).first().catch(() => null)),
      )

      if (stillReferenced.some(Boolean)) {
        kept.push(oldId)
        continue
      }

      await Trail.delete(oldId).catch(() => undefined)
      removed += 1
    }

    if (moved > 0 || discarded > 0 || removed > 0) {
      console.warn(
        `[seed] catalog de-duplicated: moved ${moved} reference(s), `
        + `discarded ${discarded} that already existed on the real trail, `
        + `removed ${removed} redundant trail(s)`,
      )
    }

    if (kept.length > 0)
      console.warn(`[seed] kept ${kept.length} redundant trail(s) that still have references: ${kept.join(', ')}`)
  }
}
