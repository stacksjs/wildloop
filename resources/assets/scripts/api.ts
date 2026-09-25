/**
 * Wildloop API Client
 *
 * Client-side API initialization and data fetching utilities.
 * Import this in STX files for typed API access.
 *
 * NOTE: API is auto-initialized when @stacksjs/browser is imported.
 * No manual initApi() call needed.
 */

import { apiFetch } from './auth'
import {
  auth,
  Trail,
  Activity,
  Review,
  Territory,
  TerritoryHistory,
  TerritoryStats,
  UserStats,
  Achievement,
  UserAchievement,
  Kudos,
  SavedTrail,
  User,
  formatAreaSize,
  formatDistance,
  formatElevation,
  formatDuration,
  getRelativeTime,
  fetchData,
} from '@stacksjs/browser'

// API is auto-initialized by @stacksjs/browser's auto-init.ts

// Export everything for use in STX files
export {
  // Auth
  auth,

  // Models
  Trail,
  Activity,
  Review,
  Territory,
  TerritoryHistory,
  TerritoryStats,
  UserStats,
  Achievement,
  UserAchievement,
  Kudos,
  SavedTrail,
  User,

  // Utilities
  formatAreaSize,
  formatDistance,
  formatElevation,
  formatDuration,
  getRelativeTime,
  fetchData,
}

// ============================================================================
// Convenience functions for common data fetching patterns
// ============================================================================

/**
 * Fetch trails with optional filters
 */
export async function fetchTrails(options?: {
  difficulty?: 'easy' | 'moderate' | 'hard'
  limit?: number
  orderBy?: 'rating' | 'distance' | 'created_at'
}) {
  let query = Trail.query()

  if (options?.difficulty) {
    query = query.where('difficulty', options.difficulty)
  }

  if (options?.orderBy) {
    query = query.orderByDesc(options.orderBy as any)
  }

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  return query.get()
}

/**
 * Fetch recent activities
 */
export async function fetchRecentActivities(limit = 10) {
  return Activity.orderByDesc('created_at' as any).limit(limit).get()
}

/**
 * Fetch territories for map display
 */
export async function fetchTerritories(options?: {
  minLat?: number
  maxLat?: number
  minLng?: number
  maxLng?: number
  userId?: number
}) {
  let query = Territory.query()

  if (options?.userId) {
    query = query.where('user_id' as any, options.userId)
  }

  // Note: Bounding box filtering would be done server-side via custom endpoint
  // For now, return all and filter client-side
  return query.get()
}

/**
 * Fetch territory leaderboard
 */
export async function fetchTerritoryLeaderboard(type: 'area' | 'count' | 'conquests' = 'area', limit = 10) {
  return TerritoryStats.orderByDesc(
    type === 'area' ? 'totalAreaOwned' :
    type === 'count' ? 'totalTerritoriesOwned' :
    'territoriesConquered'
  ).limit(limit).get()
}

/**
 * Fetch user's territory stats
 */
export async function fetchUserTerritoryStats(userId: number) {
  return TerritoryStats.where('user_id' as any, userId).first()
}

/**
 * Fetch user's general stats
 */
export async function fetchUserStats(userId: number) {
  return UserStats.where('user_id' as any, userId).first()
}

/**
 * Fetch achievements with progress for a user
 */
export async function fetchUserAchievements(userId: number) {
  return UserAchievement.where('user_id' as any, userId).get()
}

/**
 * Fetch all achievements
 */
export async function fetchAchievements() {
  return Achievement.all()
}

/**
 * Give kudos to an activity
 */
export async function giveKudos(activityId: number) {
  return Kudos.create({ giverId: activityId } as any)
}

/**
 * Save a trail
 */
export async function saveTrail(_trailId: number, notes?: string) {
  return SavedTrail.create({
    notes: notes || '',
    wantToVisit: true,
    hasVisited: false,
  } as any)
}

/**
 * Create a new activity
 */
export async function createActivity(data: {
  activityType: 'Trail Run' | 'Hike' | 'Walk' | 'Bike'
  distance: number
  duration: number
  elevation?: number
  gpxData?: string
  notes?: string
}) {
  return Activity.create({
    ...data,
    pace: calculatePace(data.distance, data.duration),
    kudosCount: 0,
    completedAt: new Date().toISOString(),
  } as any)
}

/**
 * Claim a territory from a completed activity
 */
export async function claimTerritory(activityId: number) {
  // This calls the custom claim endpoint
  const response = await apiFetch('/api/territories/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('token')}`,
    },
    body: JSON.stringify({ activity_id: activityId }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to claim territory')
  }

  return response.json()
}

/**
 * Process conquest for an activity
 */
export async function processConquest(activityId: number) {
  const response = await apiFetch('/api/territories/process-conquest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('token')}`,
    },
    body: JSON.stringify({ activity_id: activityId }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to process conquest')
  }

  return response.json()
}

// ============================================================================
// Helper functions
// ============================================================================

function calculatePace(distanceMiles: number, durationSeconds: number): string {
  if (distanceMiles === 0) return '0:00'
  const paceSeconds = durationSeconds / distanceMiles
  const minutes = Math.floor(paceSeconds / 60)
  const seconds = Math.floor(paceSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

// Make API available globally for non-module scripts
if (typeof window !== 'undefined') {
  (window as any).WildloopAPI = {
    auth,
    Trail,
    Activity,
    Review,
    Territory,
    TerritoryHistory,
    TerritoryStats,
    UserStats,
    Achievement,
    UserAchievement,
    Kudos,
    SavedTrail,
    User,
    fetchTrails,
    fetchRecentActivities,
    fetchTerritories,
    fetchTerritoryLeaderboard,
    fetchUserTerritoryStats,
    fetchUserStats,
    fetchUserAchievements,
    fetchAchievements,
    giveKudos,
    saveTrail,
    createActivity,
    claimTerritory,
    processConquest,
    formatAreaSize,
    formatDistance,
    formatElevation,
    formatDuration,
    getRelativeTime,
  }
}
