import { Seeder } from '@stacksjs/database'
import Challenge from '../../app/Models/Challenge'
import Territory from '../../app/Models/Territory'
import User from '../../app/Models/User'

/**
 * Head-to-head challenges over the seeded land.
 *
 * `/challenges` filters one list into four tabs — active, sent, received and
 * completed — so a single status leaves three of them empty and proves nothing
 * about the filtering. These cover all four, from the point of view of an
 * athlete who both sent and received them.
 *
 * Every challenge names a territory that exists and stakes the area that
 * territory actually holds, so the number on the card agrees with the parcel
 * it points at. The territories are addressed by the trail they were claimed
 * on rather than by id, which survives a reseed that renumbers them.
 */

type Status = 'pending' | 'active' | 'completed' | 'declined'

const DAY = 24 * 60 * 60 * 1000

interface SeedChallenge {
  challenger: string
  challenged: string
  /** Name of the seeded territory at stake. */
  territory: string
  status: Status
  /** Winner's name — only meaningful once completed. */
  winner?: string
  /** Days from today the challenge expires. Negative for one already past. */
  deadlineInDays: number
}

const CHALLENGES: SeedChallenge[] = [
  // Kim wants the parcel Chris took off his back.
  {
    challenger: 'Kim Gottwald',
    challenged: 'Chris Breuer',
    territory: 'Maroon Lake Scenic Trail Territory',
    status: 'pending',
    deadlineInDays: 5,
  },
  // Live: Kim already attacked Skyline once and is going again.
  {
    challenger: 'Kim Gottwald',
    challenged: 'Mark Dowdle',
    territory: 'Skyline Loop Trail Territory',
    status: 'active',
    deadlineInDays: 3,
  },
  // Settled: Mark held it, which is what the defence in the history says.
  {
    challenger: 'Chris Breuer',
    challenged: 'Mark Dowdle',
    territory: 'Navajo Loop and Queen\'s Garden Territory',
    status: 'completed',
    winner: 'Mark Dowdle',
    deadlineInDays: -2,
  },
  // Turned down: nobody is flying to Bavaria for a fight over a gorge.
  {
    challenger: 'Mark Dowdle',
    challenged: 'Pawel Dregan',
    territory: 'Partnachklamm Rundweg Territory',
    status: 'declined',
    deadlineInDays: -4,
  },
  // Received by Chris, so his page has something in the received tab too.
  {
    challenger: 'Harvey Lewis',
    challenged: 'Chris Breuer',
    territory: 'Matt Davis – Steep Ravine Loop Territory',
    status: 'pending',
    deadlineInDays: 6,
  },
]

export default class ChallengeSeeder extends Seeder {
  // After the territory seeders: a challenge stakes a parcel that must exist.
  static override order = -58

  async run(): Promise<void> {
    const users = (await User.all().catch(() => [])) as any[]
    const territories = (await Territory.all().catch(() => [])) as any[]
    const byName = new Map(users.map(u => [u.name, u]))
    const territoryByName = new Map(territories.map(t => [t.name, t]))
    if (!byName.size || !territoryByName.size) {
      console.warn('[seed] no users or territories yet; skipping challenges')
      return
    }

    const now = Date.now()

    for (const seed of CHALLENGES) {
      const challenger = byName.get(seed.challenger)
      const challenged = byName.get(seed.challenged)
      const territory = territoryByName.get(seed.territory)
      if (!challenger || !challenged || !territory) {
        console.warn(`[seed] challenge ${seed.challenger} → ${seed.challenged} is missing a side; skipping`)
        continue
      }

      const payload = {
        challenger_id: challenger.id,
        challenged_id: challenged.id,
        territory_id: territory.id,
        // The stake is the parcel, so it is read off the parcel.
        area_at_stake: territory.area_size ?? 0,
        status: seed.status,
        winner_id: seed.status === 'completed' ? (byName.get(seed.winner ?? '')?.id ?? null) : null,
        deadline: new Date(now + seed.deadlineInDays * DAY).toISOString(),
      }

      // One live challenge per (challenger, challenged, territory) — a second
      // one over the same land is the same argument, not a new one.
      const existing = await Challenge
        .where('challenger_id', '=', challenger.id)
        .where('challenged_id', '=', challenged.id)
        .where('territory_id', '=', territory.id)
        .first()
        .catch(() => null)

      if (existing)
        await Challenge.forceUpdate(existing.id, payload)
      else
        await Challenge.forceCreate(payload)
    }
  }
}
