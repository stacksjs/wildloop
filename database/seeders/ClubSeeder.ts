import { Seeder } from '@stacksjs/database'
import Club from '../../app/Models/Club'
import ClubMember from '../../app/Models/ClubMember'
import User from '../../app/Models/User'

/**
 * The clubs directory.
 *
 * Named crews with a stated purpose, not faker output. A directory is a page
 * you scan to decide where you belong, and it only works if the entries differ
 * from each other in ways that matter — city, discipline, pace, whether you can
 * simply walk in. One club and a "Create Club" button is not a directory; it is
 * an empty state with a row in it.
 *
 * Rappid Run is the real one, and the only closed team: `join_policy:
 * 'invite_only'` means the club is discoverable — it shows in the directory
 * with its site and its numbers — but the Join button does not apply to it.
 * Membership comes from a ClubInvite one of its owners issues, which
 * `ClubInviteAcceptAction` redeems. `is_private` is deliberately false: hiding
 * the club would be a different product decision. A closed team still wants to
 * be findable, it just does not want walk-ins.
 *
 * Every other club here is seeded so the states around Rappid Run are visible
 * too — open clubs you can join, a request-to-join club, a private one only its
 * members can see, and the three club types the filter tabs offer.
 *
 * Rosters are seeded by email rather than left empty, because the club card
 * shows this week's mileage aggregated from its members' activities. With no
 * members that number is honestly zero, and a directory of zeroes tells you
 * nothing about whether the aggregation works.
 *
 * Idempotent by name, so re-seeding a database that already has these clubs
 * updates them in place rather than filling the directory with duplicates.
 */

interface SeedClub {
  name: string
  description: string
  location: string | null
  club_type: 'Running' | 'Hiking' | 'Mixed' | 'Territory Game'
  is_private: boolean
  join_policy: 'open' | 'request' | 'invite_only'
  website: string | null
  /** Emails from UserSeeder. The first is the owner. */
  roster: string[]
}

const CLUBS: SeedClub[] = [
  {
    name: 'Rappid Run',
    // Their own words: rappid.run's tagline is "by inspiring others we
    // inspire ourselves". Worth using rather than inventing copy for a real
    // crew — a seeded club that misdescribes an actual team is worse than a
    // generated one.
    description:
      'By inspiring others we inspire ourselves. A closed running crew training for road and '
      + 'trail, with its own kit and drops. Members are invited by the crew — sessions, race '
      + 'plans, and the team calendar live behind the door.',
    location: null,
    club_type: 'Running',
    is_private: false,
    join_policy: 'invite_only',
    website: 'https://www.rappid.run',
    roster: ['chris@wildloop.test', 'pawel@wildloop.test', 'mark@wildloop.test'],
  },
  {
    name: 'Sunrise Mile Club',
    description:
      'Easy miles before work, every weekday at 6am from the boathouse. No drop, no watch check '
      + 'at the top of the hill, coffee afterwards. If you can hold a conversation you are '
      + 'running it right.',
    location: 'Portland, OR',
    club_type: 'Running',
    is_private: false,
    join_policy: 'open',
    website: null,
    roster: ['kim@wildloop.test', 'user@wildloop.test', 'paid@wildloop.test'],
  },
  {
    name: 'Ridgeline Collective',
    description:
      'Long weekend efforts on the ridges above the city — vert first, pace second. Saturday '
      + 'route drops on Thursday, and somebody always has a spare pair of poles.',
    location: 'Boulder, CO',
    club_type: 'Running',
    is_private: false,
    join_policy: 'open',
    website: null,
    roster: ['pawel@wildloop.test', 'chris@wildloop.test', 'harvey@wildloop.test'],
  },
  {
    name: 'Backyard Loop Society',
    description:
      'One loop, every hour, until one of us is left. Monthly last-runner-standing meetups plus '
      + 'the training block that makes them survivable. Newcomers get a pacer for their first '
      + 'twelve yards.',
    location: 'Cincinnati, OH',
    club_type: 'Running',
    is_private: false,
    join_policy: 'open',
    website: null,
    roster: ['harvey@wildloop.test', 'mark@wildloop.test'],
  },
  {
    name: 'Track Tuesday Crew',
    description:
      'Intervals on the blue track, 6:30pm sharp. Sessions are posted a week ahead so you can '
      + 'slot them into your own block — 400s in winter, 1ks when the racing starts.',
    location: 'Austin, TX',
    club_type: 'Running',
    is_private: false,
    join_policy: 'request',
    website: null,
    roster: ['mark@wildloop.test', 'kim@wildloop.test'],
  },
  {
    name: 'Alpenverein Trailläufer',
    description:
      'Hüttentouren und lange Bergläufe rund um die Nordalpen. Sunday tours are announced in '
      + 'both languages, and every route sheet lists the last bus home.',
    location: 'Innsbruck, AT',
    club_type: 'Hiking',
    is_private: false,
    join_policy: 'open',
    website: null,
    roster: ['pawel@wildloop.test', 'kim@wildloop.test'],
  },
  {
    name: 'Cascade Ramblers',
    description:
      'All-day hikes at a talking pace, with a strict turn-around time and a genuine enthusiasm '
      + 'for lunch. Loops picked so the last hour is downhill.',
    location: 'Seattle, WA',
    club_type: 'Hiking',
    is_private: false,
    join_policy: 'open',
    website: null,
    roster: ['user@wildloop.test', 'harvey@wildloop.test'],
  },
  {
    name: 'Bay Area Turf War',
    description:
      'Territory-first. We run loops to hold ground, defend what the club already owns, and '
      + 'compare maps on Sunday night. Bring GPS you trust.',
    location: 'Bay Area, CA',
    club_type: 'Territory Game',
    is_private: false,
    join_policy: 'open',
    website: null,
    roster: ['chris@wildloop.test', 'paid@wildloop.test', 'kim@wildloop.test'],
  },
  {
    name: 'Night Shift Runners',
    description:
      'A private crew for people whose miles happen after 9pm. Route safety notes, headtorch '
      + 'reviews, and a check-in thread so somebody always knows you got home.',
    location: 'Chicago, IL',
    club_type: 'Mixed',
    is_private: true,
    join_policy: 'invite_only',
    website: null,
    roster: ['chris@wildloop.test', 'mark@wildloop.test'],
  },
]

export default class ClubSeeder extends Seeder {
  // After UserSeeder — a club needs an owner.
  static override order = -90

  async run(): Promise<void> {
    // Resolved once. Every roster is written by email, so a club whose members
    // are missing is a seed-data bug that says so, rather than a club that
    // quietly ends up with one person in it.
    const emails = [...new Set(CLUBS.flatMap(club => club.roster))]
    const byEmail = new Map<string, { id: number }>()
    for (const email of emails) {
      const user = await User.where('email', '=', email).first().catch(() => null)
      if (user?.id)
        byEmail.set(email, user)
    }

    // Every club needs an owner. `static order` above guarantees UserSeeder
    // has already run, so fall back to the lowest id rather than inventing an
    // account: on a fresh database that is the first seeded athlete.
    const fallbackOwner = await User.orderBy('id', 'asc').first().catch(() => null)
    if (!fallbackOwner) {
      console.warn('[seed] no users yet; skipping clubs')
      return
    }

    for (const seed of CLUBS) {
      const roster = seed.roster.map(email => byEmail.get(email)).filter(Boolean) as { id: number }[]
      const owner = roster[0] ?? fallbackOwner

      const existing = await Club.where('name', '=', seed.name).first().catch(() => null)

      const club = existing
        ? (await Club.update(existing.id, {
            // `creator_id` is updated too. An earlier version of this seeder
            // handed every club to whichever account had the lowest id, and
            // leaving that in place meant the directory kept showing a random
            // athlete as the owner of somebody else's crew.
            creator_id: owner.id,
            description: seed.description,
            location: seed.location,
            club_type: seed.club_type,
            is_private: seed.is_private,
            join_policy: seed.join_policy,
            website: seed.website,
          }), existing)
        : await Club.forceCreate({
            creator_id: owner.id,
            name: seed.name,
            description: seed.description,
            location: seed.location,
            club_type: seed.club_type,
            is_private: seed.is_private,
            join_policy: seed.join_policy,
            website: seed.website,
          })

      if (!club?.id)
        continue

      /*
       * The roster is reconciled, not appended to.
       *
       * An additive seeder cannot correct itself: the first version of this
       * file made whoever had the lowest id the owner of every club, and
       * re-seeding left that membership sitting there — so Rappid Run listed
       * four members, one of whom had never been invited, and the Join button
       * read "Joined" for an account that was not on the team. Declaring the
       * roster here has to mean the roster IS this, including who is not on it.
       */
      const wanted = new Map(roster.map((member, index) => [
        member.id,
        index === 0 ? 'owner' as const : 'member' as const,
      ]))

      const current = (await ClubMember.where('club_id', '=', club.id).get().catch(() => [])) as any[]

      for (const row of current) {
        const role = wanted.get(row.user_id)

        if (!role) {
          await ClubMember.delete(row.id).catch(() => undefined)
          continue
        }

        if (row.role !== role)
          await ClubMember.update(row.id, { role }).catch(() => undefined)

        wanted.delete(row.user_id)
      }

      for (const [userId, role] of wanted) {
        await ClubMember.forceCreate({
          club_id: club.id,
          user_id: userId,
          role,
        }).catch(() => undefined)
      }
    }
  }
}
