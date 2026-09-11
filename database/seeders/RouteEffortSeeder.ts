import { Seeder } from '@stacksjs/database'
import RouteEffort from '../../app/Models/RouteEffort'
import Trail from '../../app/Models/Trail'
import User from '../../app/Models/User'
import { routeIsRankable } from '../../resources/functions/route-records'
import { seededTrails } from '../support/trails'

/**
 * Fastest-known-time attempts on the seeded routes.
 *
 * `/records` and `/effort/:id` were the only surfaces left rendering their
 * empty state on a full database. That state is a good one — "Routes carry a
 * board once they are 5 miles or 500 feet of gain" — but it is the same page
 * whether the feature works or not, so nothing about ranking, filtering or
 * verification could be seen, let alone tested.
 *
 * What the boards have to exercise:
 *
 *   - **Ranking.** A board is only a board with more than one time on it, so
 *     three routes carry several efforts each and the order they come back in
 *     is the order the page must show.
 *   - **Bucketing.** Style, category and direction each split a board into
 *     separate records — an unsupported time does not compete with a supported
 *     one — so the same route carries times in more than one bucket.
 *   - **Every status.** `in_progress` is the tracking board, `pending` is the
 *     review queue, `rejected` carries the note the athlete has to answer,
 *     `dnf` is the attempt that ended early, and `verified` is the record.
 *     Four of the five are invisible on a database that only holds records.
 *
 * Times are written as start + duration rather than as two timestamps, because
 * `elapsed_seconds` is the sort key of every board query and a board whose
 * displayed time disagrees with its ranking is worse than an empty one. The
 * column is derived here from the same pair the page reads, so the three can
 * never drift.
 *
 * Every route named below is checked against `routeIsRankable` before anything
 * is filed on it. A record on a two-mile stroll is exactly what that rule
 * exists to keep off the boards, and a seeder that plants one is asserting the
 * opposite of the product.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR * 1000

type Style = 'supported' | 'self_supported' | 'unsupported'
type Category = 'mens' | 'womens' | 'nonbinary'
type Direction = 'standard' | 'reverse' | 'yo_yo'
type Status = 'in_progress' | 'dnf' | 'pending' | 'verified' | 'rejected'

interface SeedEffort {
  /**
   * Seed source id of the route.
   *
   * Resolved by source id first and by name second, because TrailSeeder does
   * not always insert its own row: where the catalog already held the trail it
   * ADOPTS it, and an adopted trail keeps the catalog's source id. Looking up
   * only the seeder's id finds nothing for those, which is silent — the effort
   * is skipped and the board it belonged to stays empty.
   */
  route: string
  /** The route's name, for the adopted case. */
  routeName: string
  athlete: string
  style: Style
  category: Category
  direction?: Direction
  status: Status
  /** Days ago the attempt started. */
  startedDaysAgo: number
  /** Elapsed time. Omitted for an attempt still out there, or a DNF. */
  durationSeconds?: number
  teamSize?: number
  evidenceUrl?: string
  trackerUrl?: string
  tripReport?: string
  /** Only meaningful once reviewed. */
  reviewNote?: string
}

/**
 * Three boards deep enough to rank, plus the attempts that are not records.
 *
 * Half Dome is the marquee route: 14.2 miles and 5,250 feet, with times in
 * two styles and both directions, which is what makes it a board rather than
 * a list. Dipsea and Skyline carry the shorter, faster end.
 */
const EFFORTS: SeedEffort[] = [
  // ── Sky Pond via Glacier Gorge — 9.0 mi, 1,780 ft ─────────────────────────
  // The marquee board: an alpine route long enough and steep enough to be
  // worth racing, carrying times in more than one bucket.
  {
    route: 'romo-sky-pond',
    routeName: 'Sky Pond via Glacier Gorge',
    athlete: 'Harvey Lewis',
    style: 'unsupported',
    category: 'mens',
    status: 'verified',
    startedDaysAgo: 46,
    durationSeconds: 2 * HOUR + 11 * MINUTE + 24,
    evidenceUrl: 'https://www.strava.com/activities/10482910031',
    tripReport: 'Left Glacier Gorge at first light and had the Loch to myself. The scramble beside Timberline Falls is the whole route — wet rock there costs more than any amount of fitness on the runnable miles below it. Dry today, so I took it at a jog and kept going.',
  },
  // Second in the same bucket: this is what makes it a ranking rather than a
  // single time on a page.
  {
    route: 'romo-sky-pond',
    routeName: 'Sky Pond via Glacier Gorge',
    athlete: 'Chris Breuer',
    style: 'unsupported',
    category: 'mens',
    status: 'verified',
    startedDaysAgo: 31,
    durationSeconds: 2 * HOUR + 34 * MINUTE + 8,
    evidenceUrl: 'https://www.strava.com/activities/10611204778',
    tripReport: 'Went out hard to Mills Junction and had nothing left for the falls. Lost four or five minutes picking a line up the wet slab, which is exactly where this route is won.',
  },
  // A different bucket on the same route: supported does not compete with
  // unsupported, so this is its own record despite the slower time.
  {
    route: 'romo-sky-pond',
    routeName: 'Sky Pond via Glacier Gorge',
    athlete: 'Kim Gottwald',
    style: 'supported',
    category: 'womens',
    status: 'verified',
    startedDaysAgo: 24,
    durationSeconds: 2 * HOUR + 48 * MINUTE + 51,
    evidenceUrl: 'https://www.strava.com/activities/10702551190',
    tripReport: 'Mark met me at the Loch with water on the way back through, so this is filed supported. Worth the penalty at altitude.',
  },
  // Reverse is a separate board again.
  {
    route: 'romo-sky-pond',
    routeName: 'Sky Pond via Glacier Gorge',
    athlete: 'Mark Dowdle',
    style: 'self_supported',
    category: 'mens',
    direction: 'reverse',
    status: 'pending',
    startedDaysAgo: 6,
    durationSeconds: 2 * HOUR + 29 * MINUTE + 2,
    evidenceUrl: 'https://www.strava.com/activities/10884412206',
    tripReport: 'Up past Sky Pond first and out via Loch Vale. Slower on paper but far more runnable coming down, and I think it is the honest way round for anyone who likes their knees.',
  },

  // ── Matt Davis – Steep Ravine Loop — 7.4 mi, 1,700 ft ─────────────────────
  {
    route: 'osm-way-24417702',
    routeName: 'Matt Davis – Steep Ravine Loop',
    athlete: 'Kim Gottwald',
    style: 'unsupported',
    category: 'womens',
    status: 'verified',
    startedDaysAgo: 18,
    durationSeconds: 1 * HOUR + 12 * MINUTE + 41,
    evidenceUrl: 'https://www.strava.com/activities/10761200554',
    tripReport: 'Down Matt Davis to Stinson and back up Steep Ravine. The ladder is the only place you cannot run, and everyone queues there on a Saturday — went early and did not see anyone until the redwoods.',
  },
  {
    route: 'osm-way-24417702',
    routeName: 'Matt Davis – Steep Ravine Loop',
    athlete: 'Pawel Dregan',
    style: 'unsupported',
    category: 'mens',
    status: 'verified',
    startedDaysAgo: 12,
    durationSeconds: 1 * HOUR + 19 * MINUTE + 9,
    evidenceUrl: 'https://www.strava.com/activities/10809334410',
    tripReport: 'First time round this loop and I ran the Dipsea connector by mistake, which cost me a couple of minutes and a lot of dignity.',
  },
  // Non-binary category, so all three are represented somewhere on the boards.
  {
    route: 'osm-way-24417702',
    routeName: 'Matt Davis – Steep Ravine Loop',
    athlete: 'WildLoop User',
    style: 'self_supported',
    category: 'nonbinary',
    status: 'verified',
    startedDaysAgo: 9,
    durationSeconds: 1 * HOUR + 27 * MINUTE + 26,
    evidenceUrl: 'https://www.strava.com/activities/10838117702',
    tripReport: 'Carried my own water and went steady. The fog came in over the ridge and it was the best hour of the week.',
  },

  // ── Skyline Loop Trail — 5.5 mi, 1,700 ft ─────────────────────────────────
  {
    route: 'mora-skyline-loop',
    routeName: 'Skyline Loop Trail',
    athlete: 'Mark Dowdle',
    style: 'unsupported',
    category: 'mens',
    status: 'verified',
    startedDaysAgo: 21,
    durationSeconds: 52 * MINUTE + 3,
    evidenceUrl: 'https://www.strava.com/activities/10731902244',
    tripReport: 'Snow-free to Panorama Point for the first time this year. Marmots unimpressed.',
  },
  {
    route: 'mora-skyline-loop',
    routeName: 'Skyline Loop Trail',
    athlete: 'Harvey Lewis',
    style: 'unsupported',
    category: 'mens',
    status: 'verified',
    startedDaysAgo: 15,
    durationSeconds: 55 * MINUTE + 47,
    evidenceUrl: 'https://www.strava.com/activities/10788440190',
    tripReport: 'Hiked in cold and never found the rhythm. The loop deserves better than I gave it.',
  },
  // A pair who started and finished together files on the team board.
  {
    route: 'mora-skyline-loop',
    routeName: 'Skyline Loop Trail',
    athlete: 'Chris Breuer',
    style: 'self_supported',
    category: 'mens',
    status: 'verified',
    startedDaysAgo: 7,
    durationSeconds: 1 * HOUR + 9 * MINUTE + 18,
    teamSize: 2,
    evidenceUrl: 'https://www.strava.com/activities/10861003377',
    tripReport: 'Ran this with Pawel start to finish, so it is filed as a pair. Neither of us would have gone that hard alone.',
  },

  // ── Attempts that are not records ─────────────────────────────────────────
  // Out on the course right now: this is the tracking board.
  {
    route: 'romo-sky-pond',
    routeName: 'Sky Pond via Glacier Gorge',
    athlete: 'Pawel Dregan',
    style: 'unsupported',
    category: 'mens',
    status: 'in_progress',
    startedDaysAgo: 0,
    trackerUrl: 'https://track.rtwr.live/pawel-sky-pond',
    tripReport: 'Going for the standard line before the afternoon storms build. Tracker is live.',
  },
  {
    route: 'osm-way-24417702',
    routeName: 'Matt Davis – Steep Ravine Loop',
    athlete: 'Kim Gottwald',
    style: 'self_supported',
    category: 'womens',
    status: 'in_progress',
    startedDaysAgo: 0,
    trackerUrl: 'https://track.rtwr.live/kim-steep-ravine',
    tripReport: 'Out and back before the fog lifts. Water at the Stinson end.',
  },
  // Filed and waiting on a human: the verification queue.
  {
    route: 'osm-way-24417702',
    routeName: 'Matt Davis – Steep Ravine Loop',
    athlete: 'Mark Dowdle',
    style: 'unsupported',
    category: 'mens',
    status: 'pending',
    startedDaysAgo: 3,
    durationSeconds: 1 * HOUR + 16 * MINUTE + 52,
    evidenceUrl: 'https://www.strava.com/activities/10901776621',
    tripReport: 'Clean run, GPS the whole way. Happy for anyone to pick the trace apart.',
  },
  // Ended early. No finish, no time, and it must not reach a board.
  {
    route: 'romo-sky-pond',
    routeName: 'Sky Pond via Glacier Gorge',
    athlete: 'WildLoop Paid User',
    style: 'unsupported',
    category: 'mens',
    status: 'dnf',
    startedDaysAgo: 27,
    tripReport: 'Turned round at Timberline Falls. Graupel on the slab and nobody needs to argue with that at 10,000 feet.',
  },
  // Not accepted, with the reason the athlete has to answer.
  {
    route: 'mora-skyline-loop',
    routeName: 'Skyline Loop Trail',
    athlete: 'WildLoop User',
    style: 'unsupported',
    category: 'mens',
    status: 'rejected',
    startedDaysAgo: 34,
    durationSeconds: 41 * MINUTE + 30,
    evidenceUrl: 'https://www.strava.com/activities/10655118820',
    tripReport: 'Felt fast. Watch had trouble in the trees above Glacier Vista.',
    reviewNote: 'The trace skips roughly 900 m between Glacier Vista and Panorama Point, and the elapsed time depends on that section. Re-file with a complete track and this will stand.',
  },
]

/** Source ids of every route named above, for one scoped trail load. */
const ROUTE_SOURCE_IDS = [...new Set(EFFORTS.map(effort => effort.route))]

/** The same routes by name, for the ones the catalog already held. */
const ROUTE_NAMES = [...new Set(EFFORTS.map(effort => effort.routeName))]

export default class RouteEffortSeeder extends Seeder {
  // After the athletes and the trails they are filed against, and alongside
  // the other social seeders that decorate an already-populated world.
  static override order = -55

  async run(): Promise<void> {
    const users = (await User.all().catch(() => [])) as any[]
    const byName = new Map(users.map(user => [user.name, user]))

    const trails = await seededTrails(ROUTE_SOURCE_IDS).catch(() => [] as any[])
    const bySourceId = new Map(trails.map(trail => [trail.source_id, trail]))
    const byTrailName = new Map(trails.map(trail => [trail.name, trail]))

    // Anything the source ids did not answer is an adopted route: look it up
    // by the name instead, which is what survives adoption.
    for (const name of ROUTE_NAMES) {
      if (byTrailName.has(name))
        continue
      const found = await Trail.where('name', '=', name).first().catch(() => null)
      if (found)
        byTrailName.set(name, found)
    }

    if (!byName.size || !bySourceId.size) {
      console.warn('[seed] no athletes or routes yet; skipping route efforts')
      return
    }

    // An admin signs the decisions, so a verification has an author. Falls back
    // to nobody rather than to an arbitrary athlete: an unsigned decision is
    // honest, and one attributed to whoever happened to be first is not.
    const reviewer = users.find(user => String(user.email ?? '').startsWith('admin@'))
      ?? byName.get('Chris Breuer')
      ?? null

    const now = Date.now()
    let filed = 0
    let skipped = 0

    for (const seed of EFFORTS) {
      const athlete = byName.get(seed.athlete)
      const trail = bySourceId.get(seed.route) ?? byTrailName.get(seed.routeName)

      if (!athlete || !trail) {
        console.warn(`[seed] effort by ${seed.athlete} on ${seed.route} is missing a side; skipping`)
        skipped++
        continue
      }

      // The product's own rule, applied to the seed data. A board on a route
      // that cannot carry one would contradict the page that renders it.
      const rankable = routeIsRankable(trail)
      if (!rankable.eligible) {
        console.warn(`[seed] ${trail.name} cannot carry a board (${rankable.reason}); skipping effort by ${seed.athlete}`)
        skipped++
        continue
      }

      const startedAt = new Date(now - seed.startedDaysAgo * DAY)
      // A finish only exists for an attempt that actually finished. `dnf` and
      // `in_progress` carry neither a finish nor a time, which is what keeps
      // them off the boards without a status check at every call site.
      const hasFinish = typeof seed.durationSeconds === 'number'
        && seed.status !== 'in_progress'
        && seed.status !== 'dnf'
      const finishedAt = hasFinish
        ? new Date(startedAt.getTime() + (seed.durationSeconds as number) * 1000)
        : null

      const reviewed = seed.status === 'verified' || seed.status === 'rejected'

      const payload = {
        trail_id: trail.id,
        user_id: athlete.id,
        activity_id: null,
        style: seed.style,
        category: seed.category,
        direction: seed.direction ?? 'standard',
        team_size: seed.teamSize ?? 1,
        status: seed.status,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt ? finishedAt.toISOString() : null,
        // Derived from the pair above rather than carried separately, so the
        // ranking and the displayed time cannot disagree.
        elapsed_seconds: hasFinish ? seed.durationSeconds : null,
        evidence_url: seed.evidenceUrl ?? null,
        gpx_url: null,
        tracker_url: seed.trackerUrl ?? null,
        trip_report: seed.tripReport ?? null,
        reviewed_by: reviewed ? (reviewer?.id ?? null) : null,
        // Reviewed a day after the attempt, which is the shape of a real queue.
        reviewed_at: reviewed ? new Date(startedAt.getTime() + DAY).toISOString() : null,
        review_note: seed.reviewNote ?? null,
      }

      // One effort per athlete, route and bucket.
      //
      // NOT keyed on `started_at`: it is derived from `startedDaysAgo` against
      // the clock, so it moves every time the seeder runs and the row would
      // never be recognised again — each reseed would file the whole board a
      // second time, which is the one thing a board must never show. The
      // bucket is what identifies the claim anyway: the same athlete's second
      // unsupported standard run on the same route is a new time for the same
      // record, not a separate one.
      const existing = await RouteEffort
        .where('trail_id', '=', trail.id)
        .where('user_id', '=', athlete.id)
        .where('style', '=', payload.style)
        .where('category', '=', payload.category)
        .where('direction', '=', payload.direction)
        .where('status', '=', payload.status)
        .first()
        .catch(() => null)

      if (existing)
        await RouteEffort.forceUpdate(existing.id, payload)
      else
        await RouteEffort.forceCreate(payload)

      filed++
    }

    console.log(`[seed] route efforts: ${filed} filed${skipped ? `, ${skipped} skipped` : ''}`)
  }
}
