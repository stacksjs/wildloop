import { describe, expect, it } from 'bun:test'
import {
  ACTIVITY_ROUTE_BOX,
  activityRoutePoints,
  athleteDistanceText,
  athleteElevationText,
  athletePath,
  athleteProfileFrom,
  blockRequest,
  followLabel,
  followRequest,
  recentActivityLine,
  recentActivityStats,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  reportRequest,
  settledFollowerCount,
} from '../../resources/functions/athletes'
import { recordsPath } from '../../resources/functions/route-records'

/**
 * One athlete's own page, added when `/athlete/:id` was promoted.
 *
 * Two things are the point. `/api/users/{id}` answers an *envelope* — identity
 * under `user`, numbers under `stats`, follow counts at the top — so a screen
 * reading `payload.name` shows a nameless profile and nothing errors. And the
 * follower count after an optimistic toggle is computed from the state
 * *before* the tap: counting from the tap's direction is what took a club from
 * 48 members to 47 on a refused join.
 */

const ENVELOPE = {
  success: true,
  user: {
    id: 44,
    name: 'Marta Keller',
    location: 'San Diego, CA',
    bio: 'Dawn patrol.',
    avatar: 'marta.jpg',
  },
  stats: {
    totalDistance: 412.37,
    activityCount: 96,
    totalElevation: 48_210,
    territoriesOwned: 3,
  },
  followerCount: 128,
  followingCount: 64,
  recentActivities: [
    { id: 9, activityType: 'Trail Run', trailName: 'Cowles Mountain', completedAt: '2026-10-15T07:00:00.000Z', distance: 6.23, elevationGain: 1240 },
    { id: 8, activityType: 'Hike', trailName: null, completedAt: '2026-10-14T07:00:00.000Z', distance: 4, elevationGain: 300 },
  ],
}

describe('athletePath', () => {
  it('names one athlete', () => {
    expect(athletePath(44)).toBe('/api/users/44')
  })
})

describe('athleteProfileFrom', () => {
  /*
   * The envelope. A screen reading `payload.name` and `payload.totalDistance`
   * finds neither and renders a nameless profile with zeroes — plausibly, like
   * an athlete who has done nothing.
   */
  it('flattens the envelope the endpoint actually answers', () => {
    const profile = athleteProfileFrom(ENVELOPE)!

    expect(profile).toMatchObject({
      id: 44,
      name: 'Marta Keller',
      location: 'San Diego, CA',
      bio: 'Dawn patrol.',
      totalDistance: 412.37,
      activityCount: 96,
      totalElevation: 48_210,
      territoriesOwned: 3,
      followerCount: 128,
      followingCount: 64,
    })
    expect(profile.recentActivities).toHaveLength(2)
  })

  it('does not read the flat shape, which the endpoint never sends', () => {
    expect(athleteProfileFrom({ id: 44, name: 'Marta', totalDistance: 10 })).toBeNull()
  })

  it('reads an athlete with no stats at all as zeroes, not as missing', () => {
    const bare = athleteProfileFrom({ user: { id: 5 } })!

    expect(bare).toMatchObject({ id: 5, name: 'Athlete', totalDistance: 0, followerCount: 0 })
    expect(bare.recentActivities).toEqual([])
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { user: null }, { user: {} }])
      expect(athleteProfileFrom(payload)).toBeNull()
  })
})

describe('the numbers as words', () => {
  const profile = athleteProfileFrom(ENVELOPE)!

  it('rounds distance to one decimal, as the web page does', () => {
    expect(athleteDistanceText(profile)).toBe('412.4 mi')
  })

  it('groups elevation, so five figures are readable', () => {
    expect(athleteElevationText(profile)).toBe('48,210 ft')
  })

  it('reads zero rather than throwing before anything loads', () => {
    expect(athleteDistanceText(null)).toBe('0.0 mi')
    expect(athleteElevationText(null)).toBe('0 ft')
  })
})

describe('following', () => {
  it('says which way the button goes', () => {
    expect(followLabel(true)).toBe('Following')
    expect(followLabel(false)).toBe('Follow')
  })

  it('follows with a PUT and unfollows with a DELETE', () => {
    expect(followRequest(44, true)).toEqual({ path: '/api/users/44/follow', method: 'PUT' })
    expect(followRequest(44, false)).toEqual({ path: '/api/users/44/follow', method: 'DELETE' })
  })
})

describe('settledFollowerCount', () => {
  it('counts up on a follow and down on an unfollow', () => {
    expect(settledFollowerCount(false, true, 128)).toBe(129)
    expect(settledFollowerCount(true, false, 128)).toBe(127)
  })

  /*
   * The clubs bug, in its new home. A refused follow rolls `now` back to
   * `was`, and the count must return to where it started — counting from the
   * tap's direction instead took 48 members to 47.
   */
  it('returns to where it started when the toggle is rolled back', () => {
    expect(settledFollowerCount(false, false, 128)).toBe(128)
    expect(settledFollowerCount(true, true, 128)).toBe(128)
  })

  it('lets the server have the last word', () => {
    expect(settledFollowerCount(false, true, 128, 131)).toBe(131)
    expect(settledFollowerCount(true, false, 128, 0)).toBe(0)
  })

  it('never goes below zero', () => {
    expect(settledFollowerCount(true, false, 0)).toBe(0)
    expect(settledFollowerCount(false, true, 5, -3)).toBe(0)
  })
})

describe('the safety actions', () => {
  it('blocks with a PUT and unblocks with a DELETE', () => {
    expect(blockRequest(44, true)).toEqual({ path: '/api/users/44/block', method: 'PUT' })
    expect(blockRequest(44, false)).toEqual({ path: '/api/users/44/block', method: 'DELETE' })
  })

  it('reports an athlete as a user subject', () => {
    expect(reportRequest(44, 'harassment')).toEqual({
      path: '/api/reports',
      body: { subject_type: 'user', subject_id: 44, reason: 'harassment' },
    })
  })

  /* Every reason the API accepts has a label, or the picker shows a slug. */
  it('labels every reason the API accepts', () => {
    for (const reason of REPORT_REASONS)
      expect(REPORT_REASON_LABELS[reason]).toBeTruthy()
    expect(Object.keys(REPORT_REASON_LABELS)).toHaveLength(REPORT_REASONS.length)
  })
})

describe('recent activities', () => {
  const profile = athleteProfileFrom(ENVELOPE)!

  it('names the activity and its route where there is one', () => {
    expect(recentActivityLine(profile.recentActivities[0])).toBe('Trail Run · Cowles Mountain')
  })

  it('leaves the route out rather than showing an empty separator', () => {
    expect(recentActivityLine(profile.recentActivities[1])).toBe('Hike')
  })

  it('reads its numbers', () => {
    expect(recentActivityStats(profile.recentActivities[0])).toBe('6.2 mi · 1,240 ft')
  })

  it('survives an activity with nothing on it', () => {
    expect(recentActivityLine(null)).toBe('Activity')
    expect(recentActivityStats(null)).toBe('0.0 mi · 0 ft')
  })
})

describe('activityRoutePoints', () => {
  const route: [number, number][] = [[32.70, -117.10], [32.72, -117.12], [32.74, -117.10]]

  it('projects a route into the row\'s box', () => {
    const points = activityRoutePoints({ id: 1, route })

    expect(points).not.toBe('')
    for (const pair of points.split(' ')) {
      const [x, y] = pair.split(',').map(Number)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(ACTIVITY_ROUTE_BOX.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(ACTIVITY_ROUTE_BOX.height)
    }
  })

  /*
   * Reads `route`, which is the field the endpoint puts on a recent activity
   * and the one the web page reads. A guessed field name draws nothing, which
   * looks exactly like an activity with no stored line.
   */
  it('reads `route`, and not a field the endpoint does not send', () => {
    expect(activityRoutePoints({ id: 1, route })).not.toBe('')
    expect(activityRoutePoints({ id: 1, line: route })).toBe('')
    expect(activityRoutePoints({ id: 1, geometry: route })).toBe('')
  })

  it('has nothing to draw without at least two points', () => {
    expect(activityRoutePoints({ id: 1, route: [[1, 2]] })).toBe('')
    expect(activityRoutePoints({ id: 1, route: [] })).toBe('')
    expect(activityRoutePoints({ id: 1 })).toBe('')
    expect(activityRoutePoints(null)).toBe('')
  })
})

describe('recordsPath', () => {
  /*
   * An athlete's profile asks the same board the records screen does, so the
   * parameter names live in one place — the profile wants only verified times,
   * because a profile is where a record is read as a credential.
   */
  it('asks for one athlete\'s verified records', () => {
    expect(recordsPath({ userId: 44, status: 'verified', limit: 20 }))
      .toBe('/api/route-efforts?limit=20&user_id=44&status=verified')
  })

  it('defaults to the board\'s own page size', () => {
    expect(recordsPath()).toBe('/api/route-efforts?limit=40')
  })

  it('leaves `all` out rather than sending it as a style', () => {
    expect(recordsPath({ style: 'all' })).toBe('/api/route-efforts?limit=40')
    expect(recordsPath({ style: 'supported' })).toBe('/api/route-efforts?limit=40&style=supported')
  })
})
