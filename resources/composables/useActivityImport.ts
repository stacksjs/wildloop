import { state } from 'stx'
import { createActivity } from '../assets/scripts/game-api'
import { importedTrackGeoJson, parseActivityFile } from '../functions/activity-files'
import { estimateCalories } from '../functions/calories'

interface ImportStoreLike {
  currentUserId: () => number
  addActivity: (activity: Record<string, unknown>) => void
}

function durationLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function useActivityImport(wl: ImportStoreLike | null) {
  const importing = state(false)
  const importMessage = state<string | null>(null)
  const importError = state<string | null>(null)

  const importFile = async (event: Event) => {
    const file = (event.target as HTMLInputElement)?.files?.[0]
    if (!file || !wl) return
    if (!wl.currentUserId()) {
      importError.set('Sign in before importing an activity.')
      return
    }
    importing.set(true)
    importError.set(null)
    importMessage.set(null)
    try {
      const parsed = await parseActivityFile(file)
      const duration = durationLabel(parsed.durationSeconds)
      const created = await createActivity({
        user_id: wl.currentUserId(),
        activity_type: 'Trail Run',
        distance: Number(parsed.distanceMiles.toFixed(2)),
        duration,
        moving_time: duration,
        elevation: parsed.elevationGainFeet,
        notes: `Imported from ${file.name}`,
        gpx_data: importedTrackGeoJson(parsed.samples),
        visibility: 'private',
        completed_at: parsed.completedAt,
        upload_id: `file:${file.name}:${file.size}:${file.lastModified}`,
        recording_source: 'file_import',
        game_mode: 'none',
      })
      if (!created) throw new Error('The activity could not be created')
      wl.addActivity({
        id: created.id,
        user_id: wl.currentUserId(),
        userName: 'You',
        trail_id: null,
        trail_name: 'Imported activity',
        title: parsed.name,
        activityType: 'Trail Run',
        distance: parsed.distanceMiles,
        duration,
        moving_time: duration,
        pace: '--',
        elevation_gain: parsed.elevationGainFeet,
        calories: estimateCalories({
          activityType: 'Trail Run',
          distanceMiles: parsed.distanceMiles,
          movingTime: duration,
          elevationGainFeet: parsed.elevationGainFeet,
        }),
        heartRateAvg: null,
        heartRateMax: null,
        cadence: null,
        splits: [],
        kudos_count: 0,
        comments: [],
        visibility: 'private',
        hasGps: true,
      })
      importMessage.set('Imported privately. File imports never score territory.')
    }
    catch (error) {
      importError.set(error instanceof Error ? error.message : 'Could not import this file')
    }
    importing.set(false)
    ;(event.target as HTMLInputElement).value = ''
  }
  return { importing, importMessage, importError, importFile }
}

