import { Seeder } from '@stacksjs/database'
import {
  achievementMetricValues,
  computeAchievementProgress,
} from '../../resources/functions/achievements'
import Achievement from '../../app/Models/Achievement'
import Activity from '../../app/Models/Activity'
import Kudos from '../../app/Models/Kudos'
import TerritoryStats from '../../app/Models/TerritoryStats'
import User from '../../app/Models/User'
import UserAchievement from '../../app/Models/UserAchievement'

/**
 * The badge wall, and where every athlete stands on it.
 *
 * This used to be `factory.generate(Achievement, { count: 15 })` — fifteen
 * badges with `faker.lorem.sentence()` for a description and a target picked
 * from a list, every one of them on the `activities` metric because that is
 * what the model's factory hard-codes. It stopped working when `factory` was
 * removed from @stacksjs/database, so `/api/users/{id}/achievements` returned
 * an empty wall and the profile page had nothing to draw.
 *
 * A badge is a target on a named metric, and the model enumerates exactly ten
 * metrics the unlock engine knows how to compute. These definitions cover all
 * ten, at targets a seeded athlete can be somewhere along rather than either
 * trivially past or hopelessly short of — a wall where everything is unlocked
 * shows you as little as one where nothing is.
 *
 * Progress is NOT written by hand. `evaluateAchievementsForUser` folds each
 * user's activities, kudos and territory standing into metric values and
 * merges them against these targets; this seeder runs the same fold through
 * the same pure functions, so a seeded badge is unlocked exactly when the
 * seeded rows behind it say it should be. That is the whole point of seeding
 * it at all: a hand-written `is_complete` proves nothing about the engine.
 */

type Category = 'distance' | 'elevation' | 'streak' | 'social' | 'exploration' | 'speed'
type TargetUnit = 'trails' | 'miles' | 'feet' | 'days' | 'kudos' | 'hours' | 'activities' | 'territories'
type BadgeColor = 'gold' | 'silver' | 'bronze' | 'emerald' | 'ruby'
type Metric =
  | 'activities' | 'distinct_trails' | 'total_miles' | 'total_elevation'
  | 'territories_conquered' | 'territories_defended' | 'territories_owned'
  | 'kudos_given' | 'streak_days' | 'fast_mile'

interface SeedAchievement {
  name: string
  description: string
  icon: string
  category: Category
  metric: Metric
  targetValue: number
  targetUnit: TargetUnit
  points: number
  badgeColor: BadgeColor
}

const ACHIEVEMENTS: SeedAchievement[] = [
  // -- activities ----------------------------------------------------------
  {
    name: 'First Steps',
    description: 'Log your first activity on Wildloop.',
    icon: '👟',
    category: 'exploration',
    metric: 'activities',
    targetValue: 1,
    targetUnit: 'activities',
    points: 50,
    badgeColor: 'bronze',
  },
  {
    name: 'Regular',
    description: 'Log 25 activities.',
    icon: '📅',
    category: 'exploration',
    metric: 'activities',
    targetValue: 25,
    targetUnit: 'activities',
    points: 200,
    badgeColor: 'silver',
  },
  {
    name: 'Century Club',
    description: 'Log 100 activities.',
    icon: '💯',
    category: 'exploration',
    metric: 'activities',
    targetValue: 100,
    targetUnit: 'activities',
    points: 500,
    badgeColor: 'gold',
  },

  // -- distinct trails -----------------------------------------------------
  {
    name: 'Wanderer',
    description: 'Run or hike 5 different trails.',
    icon: '🧭',
    category: 'exploration',
    metric: 'distinct_trails',
    targetValue: 5,
    targetUnit: 'trails',
    points: 150,
    badgeColor: 'bronze',
  },
  {
    name: 'Cartographer',
    description: 'Run or hike 25 different trails.',
    icon: '🗺️',
    category: 'exploration',
    metric: 'distinct_trails',
    targetValue: 25,
    targetUnit: 'trails',
    points: 400,
    badgeColor: 'emerald',
  },

  // -- distance ------------------------------------------------------------
  {
    name: 'Fifty Miler',
    description: 'Cover 50 miles in total.',
    icon: '🏃',
    category: 'distance',
    metric: 'total_miles',
    targetValue: 50,
    targetUnit: 'miles',
    points: 100,
    badgeColor: 'bronze',
  },
  {
    name: 'Two Fifty',
    description: 'Cover 250 miles in total.',
    icon: '🔥',
    category: 'distance',
    metric: 'total_miles',
    targetValue: 250,
    targetUnit: 'miles',
    points: 300,
    badgeColor: 'silver',
  },
  {
    name: 'Thousand Mile Year',
    description: 'Cover 1,000 miles in total.',
    icon: '🐐',
    category: 'distance',
    metric: 'total_miles',
    targetValue: 1000,
    targetUnit: 'miles',
    points: 1000,
    badgeColor: 'gold',
  },

  // -- elevation -----------------------------------------------------------
  {
    name: 'Vertical Mile',
    description: 'Climb 5,280 feet in total.',
    icon: '🏔️',
    category: 'elevation',
    metric: 'total_elevation',
    targetValue: 5280,
    targetUnit: 'feet',
    points: 150,
    badgeColor: 'bronze',
  },
  {
    name: 'Everesting',
    description: 'Climb 29,032 feet in total — the height of Everest.',
    icon: '⛰️',
    category: 'elevation',
    metric: 'total_elevation',
    targetValue: 29032,
    targetUnit: 'feet',
    points: 750,
    badgeColor: 'gold',
  },

  // -- streaks -------------------------------------------------------------
  {
    name: 'Consistent',
    description: 'Move on 3 consecutive days.',
    icon: '🌅',
    category: 'streak',
    metric: 'streak_days',
    targetValue: 3,
    targetUnit: 'days',
    points: 100,
    badgeColor: 'bronze',
  },
  {
    name: 'Two Weeks Straight',
    description: 'Move on 14 consecutive days.',
    icon: '🌙',
    category: 'streak',
    metric: 'streak_days',
    targetValue: 14,
    targetUnit: 'days',
    points: 400,
    badgeColor: 'emerald',
  },

  // -- territory -----------------------------------------------------------
  {
    name: 'Landowner',
    description: 'Hold a territory of your own.',
    icon: '🚩',
    category: 'exploration',
    metric: 'territories_owned',
    targetValue: 1,
    targetUnit: 'territories',
    points: 100,
    badgeColor: 'bronze',
  },
  {
    name: 'Empire Builder',
    description: 'Hold 10 territories at once.',
    icon: '👑',
    category: 'exploration',
    metric: 'territories_owned',
    targetValue: 10,
    targetUnit: 'territories',
    points: 600,
    badgeColor: 'gold',
  },
  {
    name: 'Land Grab',
    description: 'Take a territory off another athlete.',
    icon: '⚔️',
    category: 'social',
    metric: 'territories_conquered',
    targetValue: 1,
    targetUnit: 'territories',
    points: 200,
    badgeColor: 'ruby',
  },
  {
    name: 'Conqueror',
    description: 'Take 10 territories off other athletes.',
    icon: '⚡',
    category: 'social',
    metric: 'territories_conquered',
    targetValue: 10,
    targetUnit: 'territories',
    points: 700,
    badgeColor: 'gold',
  },
  {
    name: 'Held the Line',
    description: 'Successfully defend a territory under attack.',
    icon: '🛡️',
    category: 'social',
    metric: 'territories_defended',
    targetValue: 1,
    targetUnit: 'territories',
    points: 200,
    badgeColor: 'emerald',
  },

  // -- social --------------------------------------------------------------
  {
    name: 'Good Sport',
    description: 'Give 25 kudos to other athletes.',
    icon: '🤝',
    category: 'social',
    metric: 'kudos_given',
    targetValue: 25,
    targetUnit: 'kudos',
    points: 100,
    badgeColor: 'bronze',
  },
  {
    name: 'Cheer Squad',
    description: 'Give 250 kudos to other athletes.',
    icon: '🦋',
    category: 'social',
    metric: 'kudos_given',
    targetValue: 250,
    targetUnit: 'kudos',
    points: 400,
    badgeColor: 'silver',
  },

  // -- speed ---------------------------------------------------------------
  {
    name: 'Sub-Seven',
    description: 'Record a mile split faster than 7:00.',
    icon: '💨',
    category: 'speed',
    metric: 'fast_mile',
    targetValue: 1,
    targetUnit: 'activities',
    points: 300,
    badgeColor: 'ruby',
  },
]

export default class AchievementSeeder extends Seeder {
  // After the territory seeders (-76): three metrics are read off
  // territory_stats, so the standings have to be settled first.
  static override order = -68

  async run(): Promise<void> {
    for (const seed of ACHIEVEMENTS) {
      const payload = {
        name: seed.name,
        description: seed.description,
        icon: seed.icon,
        category: seed.category,
        metric: seed.metric,
        target_value: seed.targetValue,
        target_unit: seed.targetUnit,
        points: seed.points,
        badge_color: seed.badgeColor,
      }

      // Idempotent by name: re-seeding retargets a badge rather than adding a
      // second copy of it to everybody's wall.
      const existing = await Achievement.where('name', '=', seed.name).first().catch(() => null)
      if (existing)
        await Achievement.forceUpdate(existing.id, payload)
      else
        await Achievement.forceCreate(payload)
    }

    await this.evaluateProgress()
  }

  /**
   * Recompute every athlete's progress from their own rows.
   *
   * This is `evaluateAchievementsForUser` without its HTTP wrapper: the same
   * fold (`achievementMetricValues`) merged against the same definitions by
   * the same function (`computeAchievementProgress`). The engine's unlock
   * notification is deliberately not sent — a seeded database is not a user
   * earning a badge, and a notification feed full of "achievement unlocked"
   * from the moment of seeding would bury the ones NotificationSeeder writes.
   */
  private async evaluateProgress(): Promise<void> {
    const definitions = (await Achievement.all().catch(() => [])) as any[]
    const users = (await User.all().catch(() => [])) as any[]
    if (!definitions.length || !users.length)
      return

    for (const user of users) {
      const activities = (await Activity.where('user_id', '=', user.id).get().catch(() => [])) as any[]
      const kudosGiven = (await Kudos.where('giver_id', '=', user.id).get().catch(() => [])) as any[]
      const stats = await TerritoryStats.where('user_id', '=', user.id).first().catch(() => null)

      const entries = computeAchievementProgress(
        definitions,
        achievementMetricValues({ activities, kudosGiven, stats }),
      )

      const existing = (await UserAchievement.where('user_id', '=', user.id).get().catch(() => [])) as any[]
      const byAchievement = new Map(existing.map(row => [row.achievement_id, row]))

      for (const entry of entries) {
        const row = byAchievement.get(entry.achievement_id)
        // The engine treats an unlock as sticky — progress can fall, a badge
        // never un-earns — so an already-complete row stays complete.
        const isComplete = !!row?.is_complete || entry.is_complete
        const payload = {
          user_id: user.id,
          achievement_id: entry.achievement_id,
          progress: entry.progress,
          is_complete: isComplete,
          completed_at: row?.completed_at ?? (isComplete ? new Date().toISOString() : null),
        }

        if (row)
          await UserAchievement.forceUpdate(row.id, payload)
        else
          await UserAchievement.forceCreate(payload)
      }
    }
  }
}
