import { Seeder } from '@stacksjs/database'
import Activity from '../../app/Models/Activity'
import SavedTrail from '../../app/Models/SavedTrail'
import User from '../../app/Models/User'
import { trailIdBySeedSourceId } from './TrailSeeder'
import { seededTrails } from '../support/trails'

/**
 * The trails each athlete has bookmarked.
 *
 * `/api/users/{id}/saved-trails` backs the saved list on a profile and the
 * filled state of the bookmark control on every trail card; with the table
 * empty the control has only one state and the list is a permanent empty
 * message.
 *
 * `has_visited` is derived rather than declared: a bookmark on a trail the
 * athlete has already logged an activity on is a trail they have been to, and
 * one on a trail they have not is still a plan. Writing both flags by hand is
 * how a bookmark ends up claiming a visit that no activity supports.
 */

/** athlete → `source_id` of the trails they saved, with why. */
const SAVED: Record<string, Array<{ trail: string, notes: string }>> = {
  'Chris Breuer': [
    { trail: 'osm-way-24417702', notes: 'Standing Saturday loop.' },
    { trail: 'yose-half-dome', notes: 'Permit lottery opens in March — set a reminder.' },
    { trail: 'grca-bright-angel', notes: 'Rim to resthouse if we get the Arizona trip together.' },
  ],
  'Pawel Dregan': [
    { trail: 'osm-way-27204418', notes: 'Home gorge. Run it when the tourists have gone.' },
    { trail: 'osm-way-38155610', notes: 'Cable car up, run the loop, beer at the alm.' },
    { trail: 'zion-angels-landing', notes: 'Worth the permit faff.' },
  ],
  'Kim Gottwald': [
    { trail: 'romo-sky-pond', notes: 'The scramble is the reason to go back.' },
    { trail: 'mora-skyline-loop', notes: 'Unfinished business with the top half.' },
    { trail: 'brca-navajo-queens', notes: 'Short enough to do on the drive down.' },
  ],
  'Mark Dowdle': [
    { trail: 'osm-way-236152387', notes: 'Weekday only, it is a zoo at weekends.' },
    { trail: 'whiteriver-hanging-lake', notes: 'Permit + shuttle, plan it properly.' },
    { trail: 'acad-precipice', notes: 'Check the falcon closure before booking anything.' },
  ],
  'Harvey Lewis': [
    { trail: 'grsm-at-clingmans-newfound', notes: 'Good shakeout section the week before a race.' },
    { trail: 'grte-jenny-lake-loop', notes: 'Flat and fast, ideal for a rest day.' },
    { trail: 'osm-relation-2698343', notes: 'Want to run the race course properly one year.' },
  ],
  'WildLoop Admin': [
    { trail: 'romo-emerald-lake', notes: 'Sample bookmark for checking the saved list renders.' },
  ],
}

export default class SavedTrailSeeder extends Seeder {
  // After TrailSeeder (-92) and ActivitySeeder (-85): the visited flag is read
  // off the athlete's own activities.
  static override order = -60

  async run(): Promise<void> {
    const users = (await User.all().catch(() => [])) as any[]
    // Only the trails these bookmarks name — see support/trails.
    const trails = await seededTrails(
      Object.values(SAVED).flat().map(bookmark => bookmark.trail),
    )
    const byName = new Map(users.map(u => [u.name, u]))
    /**
     * Resolve a seeded trail reference to the row that represents it.
     *
     * TrailSeeder inserts a trail only when the catalog does not already have it;
     * on an environment where the national ingest has run, it adopts the ingested
     * row instead and records the id. So the source id declared in the seed data
     * is not always a key in the table, and looking only there silently left every
     * seeded activity, review and bookmark unlinked.
     */
    const bySourceId = new Map(trails.map(t => [t.source_id, t]))
    const byId = new Map(trails.map((t: any) => [t.id, t]))
    // The adoption map first: it is TrailSeeder's own answer about which row
    // represents this trail, and it is the only one that knows about a
    // superseded copy still sitting in the table under the same source id.
    const resolveTrail = (sourceId: string) =>
      byId.get(trailIdBySeedSourceId.get(sourceId) as number) ?? bySourceId.get(sourceId) ?? null

    if (!byName.size || !bySourceId.size) {
      console.warn('[seed] no users or trails yet; skipping saved trails')
      return
    }

    const activities = (await Activity.all().catch(() => [])) as any[]
    const visited = new Set(activities
      .filter(a => a.trail_id != null)
      .map(a => `${a.user_id}:${a.trail_id}`))

    for (const [name, bookmarks] of Object.entries(SAVED)) {
      const user = byName.get(name)
      if (!user)
        continue

      for (const bookmark of bookmarks) {
        const trail = resolveTrail(bookmark.trail)
        if (!trail) {
          console.warn(`[seed] ${name} bookmarked unknown trail "${bookmark.trail}"; skipping`)
          continue
        }

        const hasVisited = visited.has(`${user.id}:${trail.id}`)
        const payload = {
          user_id: user.id,
          trail_id: trail.id,
          notes: bookmark.notes,
          // Still on the list to do only if they have not been yet.
          want_to_visit: !hasVisited,
          has_visited: hasVisited,
        }

        const existing = await SavedTrail
          .where('user_id', '=', user.id)
          .where('trail_id', '=', trail.id)
          .first()
          .catch(() => null)

        if (existing)
          await SavedTrail.forceUpdate(existing.id, payload)
        else
          await SavedTrail.forceCreate(payload)
      }
    }
  }
}
