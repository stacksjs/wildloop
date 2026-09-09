import { Seeder } from '@stacksjs/database'
import { calculatePerimeter } from '../../resources/functions/geo'
import Activity from '../../app/Models/Activity'
import User from '../../app/Models/User'
import { trailIdBySeedSourceId } from './TrailSeeder'
import { seededTrails } from '../support/trails'

/**
 * Activities for the seeded athletes.
 *
 * This used to be `factory.generate(Activity, { count: 50 })` — fifty rows of
 * faker output whose `user_id` pointed at nobody in particular. The feed, the
 * athletes directory and the leaderboard are all activity-driven, so the
 * result was a leaderboard ranking users who did not exist and an athletes
 * page that showed "No athletes" because none of the seeded people had
 * anything attached to them.
 *
 * These are attached to the named athletes, with distances and paces that
 * agree with the totals in UserSeeder, so the leaderboard sorts into the order
 * those numbers imply. A ranking is the one screen where plausible-but-random
 * data is actively misleading: you cannot tell a sorting bug from the data.
 *
 * Dates walk backwards from today, so a staging database always has a feed
 * with something recent in it.
 *
 * Sessions also name the trail they were run on, and the ones on loop trails
 * carry a real closed GPS ring. Both matter downstream: `trail_id` is what
 * gives a trail page its activity count and the `distinct_trails` achievement
 * something to count, and the ring is what TerritorySeeder claims land from —
 * territories belong to an activity, so land with no run behind it would be a
 * row the game itself could never have produced.
 */

const DAY = 24 * 60 * 60 * 1000

interface Session {
  type: 'Trail Run' | 'Hike' | 'Walk' | 'Bike'
  distance: number
  minutes: number
  elevation: number
  notes: string
  /** `source_id` of the trail this was run on, as seeded by TrailSeeder. */
  trail?: string
  /**
   * The run closed a loop, so it is eligible for territory capture. Only set
   * on sessions whose trail is itself a loop — an out-and-back cannot enclose
   * anything, which is the rule the capture engine enforces.
   */
  capture?: boolean
}

/**
 * Per athlete, most recent first — index 0 is today, index 1 yesterday, and
 * so on.
 *
 * The ordering is load-bearing for the capture sessions. TerritorySeeder walks
 * these runs oldest-first and claims land from each one that does not overlap
 * land already held, which is the engine's own rule; the ones that DO overlap
 * are the attacks and defences TerritoryHistorySeeder resolves. So a parcel
 * has to be claimed on an earlier day than it is attacked, and defended on a
 * later one — the sequence below is arranged so that falls out of the dates
 * rather than being asserted somewhere else.
 */
const SESSIONS: Record<string, Session[]> = {
  'Harvey Lewis': [
    { type: 'Trail Run', distance: 41.7, minutes: 600, elevation: 3200, notes: 'Ten yards before the heat came up. Legs fine, stomach better.' },
    { type: 'Trail Run', distance: 12.4, minutes: 96, elevation: 890, notes: 'Easy shakeout on the loop.', trail: 'grsm-alum-cave' },
    { type: 'Trail Run', distance: 26.2, minutes: 232, elevation: 1740, notes: 'Long effort, held pace through the back half.', trail: 'grsm-at-clingmans-newfound' },
    { type: 'Hike', distance: 6.1, minutes: 118, elevation: 1450, notes: 'Recovery hike, deliberately slow.', trail: 'grsm-alum-cave' },
    // Claims Jenny Lake.
    { type: 'Trail Run', distance: 7.1, minutes: 58, elevation: 600, notes: 'Lap of the lake on a rest day. Moose on the west shore.', trail: 'grte-jenny-lake-loop', capture: true },
  ],
  'Pawel Dregan': [
    { type: 'Trail Run', distance: 18.6, minutes: 152, elevation: 2100, notes: 'Ridge line out and back. Wind on the exposed section.', trail: 'osm-way-25848873' },
    // Claims the Partnachklamm.
    { type: 'Trail Run', distance: 9.4, minutes: 71, elevation: 640, notes: 'Tempo on the fire road above the gorge.', trail: 'osm-way-27204418', capture: true },
    { type: 'Bike', distance: 34.2, minutes: 118, elevation: 1980, notes: 'Cross-training, kept it aerobic.' },
    // Claims the Oeschinensee.
    { type: 'Hike', distance: 5.6, minutes: 122, elevation: 1300, notes: 'Panorama path above the lake with the family.', trail: 'osm-way-33218840', capture: true },
  ],
  'Chris Breuer': [
    // Claims Matt Davis.
    { type: 'Trail Run', distance: 7.8, minutes: 63, elevation: 720, notes: 'Morning loop before work.', trail: 'osm-way-24417702', capture: true },
    // A wider lap of Maroon Lake than the one Kim claimed it with — takes the
    // whole parcel off her.
    { type: 'Trail Run', distance: 6.5, minutes: 58, elevation: 420, notes: 'Out in Aspen for the week. Took the long way round the lake.', trail: 'whiteriver-maroon-lake', capture: true },
    // Claims Breakneck Ridge.
    { type: 'Trail Run', distance: 3.7, minutes: 41, elevation: 1400, notes: 'Scramble up and round before the train back.', trail: 'osm-way-42104432', capture: true },
    { type: 'Hike', distance: 11.2, minutes: 214, elevation: 2650, notes: 'Summit push with the dog. Cold at the top.', trail: 'goga-lands-end' },
    { type: 'Trail Run', distance: 13.1, minutes: 108, elevation: 1130, notes: 'Half distance, negative split.', trail: 'osm-relation-2698343' },
  ],
  'Kim Gottwald': [
    { type: 'Trail Run', distance: 10.5, minutes: 88, elevation: 980, notes: 'Forest singletrack, soft underfoot after the rain.', trail: 'romo-emerald-lake' },
    // Cuts into Mark's Skyline parcel without covering it — a contest, not a
    // takeover.
    { type: 'Trail Run', distance: 5.0, minutes: 52, elevation: 900, notes: 'Half of Skyline before the cloud came in.', trail: 'mora-skyline-loop', capture: true },
    // Claims Maroon Lake.
    { type: 'Walk', distance: 4.2, minutes: 62, elevation: 180, notes: 'Easy day round the lake.', trail: 'whiteriver-maroon-lake', capture: true },
    { type: 'Trail Run', distance: 15.8, minutes: 139, elevation: 1620, notes: 'Long run with the club.', trail: 'romo-sky-pond' },
    // Claims the Multnomah–Wahkeena loop.
    { type: 'Trail Run', distance: 4.9, minutes: 47, elevation: 1600, notes: 'Waterfall loop in the Gorge, wet the whole way.', trail: 'crgnsa-multnomah-wahkeena', capture: true },
  ],
  'Mark Dowdle': [
    // Runs his own contested land, which puts it back to active.
    { type: 'Trail Run', distance: 8.9, minutes: 76, elevation: 810, notes: 'Back round Skyline to hold it.', trail: 'mora-skyline-loop', capture: true },
    // Claims Navajo Loop.
    { type: 'Hike', distance: 9.6, minutes: 186, elevation: 2240, notes: 'Ridge traverse. Longer than it looked on the map.', trail: 'brca-navajo-queens', capture: true },
    // Claims Skyline.
    { type: 'Trail Run', distance: 8.9, minutes: 74, elevation: 810, notes: 'Steady, felt good.', trail: 'mora-skyline-loop', capture: true },
  ],
}

const METERS_PER_MILE = 1609.344

/** `h:mm:ss`, which is what the UI formats from. */
function duration(minutes: number): string {
  const total = Math.round(minutes * 60)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** `m:ss` per mile, derived so it always agrees with distance and time. */
function pace(minutes: number, distance: number): string {
  if (distance <= 0)
    return '0:00'
  const perMile = minutes / distance
  const m = Math.floor(perMile)
  const s = Math.round((perMile - m) * 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * A closed GPS ring centred on the trail, laid out as `lobes` scallops.
 *
 * A run does not trace a circle, and it matters here that it does not: a
 * circle whose circumference is a 12km loop encloses 11 square kilometres,
 * well past the 5 km² ceiling the capture engine refuses. A real trail loop
 * is a wiggly closed curve — it covers its distance without enclosing
 * anything like the circle-equivalent area — so the ring is modulated,
 * `r(θ) = radius · (1 + amplitude · sin(lobes · θ))`, and the amplitude is
 * solved for below so the ring's own length lands on the run's distance.
 *
 * Deliberately deterministic (no `Math.random`, unlike the framework's
 * `generateSampleLoopJson`): re-seeding has to refresh a territory in place,
 * and a track that moved on every run would redraw the map each time.
 */
function loopRing(centerLat: number, centerLng: number, radiusMeters: number, amplitude: number, lobes: number, points: number) {
  const latPerMeter = 1 / 111132.92
  const lngPerMeter = latPerMeter / Math.max(Math.cos(centerLat * Math.PI / 180), 0.01)

  const ring: Array<{ lat: number, lng: number }> = []
  for (let i = 0; i <= points; i++) {
    // The last point repeats the first exactly, which is what makes the track
    // a closed loop rather than one within the engine's 50m tolerance.
    const step = i === points ? 0 : i
    const angle = (2 * Math.PI * step) / points
    const r = radiusMeters * (1 + amplitude * Math.sin(lobes * angle))
    ring.push({
      lat: Number((centerLat + r * Math.sin(angle) * latPerMeter).toFixed(7)),
      lng: Number((centerLng + r * Math.cos(angle) * lngPerMeter).toFixed(7)),
    })
  }
  return ring
}

/**
 * The ring for a run of `distanceMiles` around a trail's centroid.
 *
 * `radius` is picked from the distance at a compactness typical of a trail
 * loop, which keeps the enclosed area inside the engine's 1,000 m² – 5 km²
 * band; the amplitude is then bisected until the ring's measured length
 * matches the distance the athlete actually covered.
 */
function trackForSession(centerLat: number, centerLng: number, distanceMiles: number): Array<{ lat: number, lng: number }> {
  const targetMeters = distanceMiles * METERS_PER_MILE
  const radius = (targetMeters / (2 * Math.PI)) * 0.4
  const lobes = 16
  // 64 samples keeps every lobe resolved and clears the engine's 20-point
  // minimum by a wide margin.
  const points = 64

  let low = 0
  let high = 0.9
  let ring = loopRing(centerLat, centerLng, radius, high, lobes, points)

  // If even the wiggliest ring is shorter than the run, the run simply covered
  // more ground than one lap of this loop — take the longest ring available
  // rather than distorting the shape past recognition.
  if (calculatePerimeter(ring) < targetMeters)
    return ring

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2
    ring = loopRing(centerLat, centerLng, radius, mid, lobes, points)
    if (calculatePerimeter(ring) < targetMeters)
      low = mid
    else
      high = mid
  }

  return loopRing(centerLat, centerLng, radius, high, lobes, points)
}

export default class ActivitySeeder extends Seeder {
  // After UserSeeder and TrailSeeder: every activity belongs to one of its
  // athletes, and the ones that name a trail need that trail to exist.
  static override order = -85

  async run(): Promise<void> {
    const users = await User.all().catch(() => [])
    const byName = new Map((users as any[]).map(u => [u.name, u]))
    if (byName.size === 0) {
      console.warn('[seed] no users yet; skipping activities')
      return
    }

    // Only the trails these sessions name — see support/trails.
    const trails = await seededTrails(
      Object.values(SESSIONS).flat().map(session => session.trail).filter((t): t is string => !!t),
    )
    /**
     * Resolve a seeded trail reference to the row that represents it.
     *
     * TrailSeeder inserts a trail only when the catalog does not already have it;
     * on an environment where the national ingest has run, it adopts the ingested
     * row instead and records the id. So the source id declared in the seed data
     * is not always a key in the table, and looking only there silently left every
     * seeded activity, review and bookmark unlinked.
     */
    const trailBySourceId = new Map((trails as any[]).map(t => [t.source_id, t]))
    const trailById = new Map((trails as any[]).map(t => [t.id, t]))
    // The adoption map first: it is TrailSeeder's own answer about which row
    // represents this trail, and it is the only one that knows about a
    // superseded copy still sitting in the table under the same source id.
    const resolveTrail = (sourceId: string) =>
      trailById.get(trailIdBySeedSourceId.get(sourceId) as number) ?? trailBySourceId.get(sourceId) ?? null


    const now = Date.now()

    for (const [name, sessions] of Object.entries(SESSIONS)) {
      const user = byName.get(name)
      if (!user)
        continue

      /*
       * Each athlete's days start over at 1 rather than continuing a running
       * count across everybody.
       *
       * A shared counter pushed the fifteen sessions across fifteen days, and
       * the leaderboard's default window is WEEKLY — so only the two athletes
       * seeded first landed inside it and the board showed two names out of
       * five. Per-athlete offsets keep every session inside the last four
       * days, which is also what a real week of training looks like.
       */
      /*
       * Starts at -1 so the first (most recent) session lands on day 0 —
       * today. Several surfaces are scoped to the current day rather than the
       * week: the battle board opens on its "Today" tab, and a seed whose
       * newest event was yesterday made that tab read "No battles yet" on a
       * database full of them.
       */
      let dayOffset = -1

      for (const session of sessions) {
        dayOffset += 1
        const completedAt = new Date(now - dayOffset * DAY).toISOString()

        const trail = session.trail ? resolveTrail(session.trail) : null
        if (session.trail && !trail)
          console.warn(`[seed] activity references unknown trail "${session.trail}"; leaving it unlinked`)

        // A capture run needs somewhere to have happened. Without the trail's
        // coordinates there is no ring to draw, so the session degrades to an
        // ordinary logged activity rather than a capture-eligible one with no
        // GPS behind the claim.
        const track = session.capture && trail?.latitude != null && trail?.longitude != null
          ? trackForSession(trail.latitude, trail.longitude, session.distance)
          : null

        // Idempotent per athlete + note, so re-seeding refreshes the dates
        // rather than stacking another copy of the same run onto the feed.
        const existing = await Activity
          .where('user_id', '=', user.id)
          .where('notes', '=', session.notes)
          .first()
          .catch(() => null)

        const payload = {
          user_id: user.id,
          trail_id: trail?.id ?? null,
          activity_type: session.type,
          distance: session.distance,
          duration: duration(session.minutes),
          moving_time: duration(session.minutes),
          pace: pace(session.minutes, session.distance),
          elevation: session.elevation,
          // Recomputed from the kudos rows by CounterSeeder — this is only the
          // starting value for an activity nobody has given kudos to yet.
          kudos_count: 0,
          notes: session.notes,
          visibility: 'public' as const,
          gpx_data: track ? JSON.stringify({ type: 'LineString', coordinates: track.map(p => [p.lng, p.lat]) }) : null,
          recording_source: track ? 'native_gps' as const : 'manual' as const,
          game_mode: track ? 'capture' as const : 'none' as const,
          capture_eligible: !!track,
          integrity_status: track ? 'verified' as const : 'unverified' as const,
          completed_at: completedAt,
          // Dated when the run happened, not when the seeder ran.
          //
          // `created_at` defaults to the insert time, and the feed, the
          // relative timestamps and the day-streak fold all read it in
          // preference to `completed_at` — so a week of training showed up as
          // fifteen runs logged in the same minute, and every athlete's streak
          // came out as one day.
          created_at: completedAt,
        }

        if (existing) {
          await Activity.forceUpdate(existing.id, payload)
        }
        else {
          await Activity.forceCreate(payload)
          // `useTimestamps` stamps `created_at` on INSERT and ignores the one
          // in the payload, so a freshly seeded database had every run dated
          // to the second the seeder ran. It has to be written back after the
          // insert — the update path above already honours it.
          const created = await Activity
            .where('user_id', '=', user.id)
            .where('notes', '=', session.notes)
            .first()
            .catch(() => null)
          if (created)
            await Activity.forceUpdate(created.id, { created_at: completedAt })
        }
      }
    }
  }
}
