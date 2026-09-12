import { derived, onDestroy, onMount, state, useStore } from 'stx'
import { formatTerritoryArea } from '../functions/territory-style'
import { appReview, device, haptics, health, isNativeMobile, keepAwake, lifecycle, liveActivities, location, permissions, secureStorage, watchConnectivity } from '@stacksjs/mobile'
import type { CircleMarker as CircleMarkerType } from 'ts-maps'
import type { Polygon as PolygonType } from 'ts-maps'
import type { TsMap as TsMapType } from 'ts-maps'
import {
  createLiveRouteLine,
  createTrailMap,
  drawTerritoryPolygon,
  drawTrailMarker,
  ensureTsMaps,
  runWhenMapReady,
  type LatLng,
  type LiveRouteLine,
} from './useTrailMap'
import {
  persistRunAndProcess,
  routeToGeoJson,
  runResultMessage,
} from '../assets/scripts/game-api'
import {
  computeSplitsFromSamples,
  ELEVATION_NOISE_FLOOR_FT,
  METERS_TO_FEET,
  type MileSplit,
  type RecorderSample,
} from '../functions/splits'
import { loadTerritories } from './useTerritoryCatalog'
import { loadActivityVisibilityDefault } from '../assets/scripts/privacy-defaults'
import {
  clearRecordingCheckpoint,
  loadRecordingCheckpoint,
  mergeNativeLocationSamples,
  saveRecordingCheckpoint,
} from '../assets/scripts/recording-checkpoint'

type ActivityType = 'Trail Run' | 'Hike' | 'Walk' | 'Bike'
type RecordMode = 'idle' | 'simulated' | 'manual'
type GpsStatus = 'searching' | 'active' | 'stopped'

interface Trail {
  id: number
  name: string
  location: string
  difficulty: 'easy' | 'moderate' | 'hard'
  distance: number
  elevation: number
  lat: number
  lng: number
}

interface Territory {
  id: number
  name: string
  user_id: number
  areaSize: number
  conquestCount: number
}

interface TrailStore {
  currentUserId: () => number
  trails: () => Trail[]
  territories: () => Territory[]
  territoryPolygons: () => Record<number, LatLng[]>
  trailRoutes: () => Record<number, LatLng[]>
  findTrail: (id: number) => Trail | undefined
  applyCaptureSample: (id: number, samplesNeeded?: number) => number
  resetCaptureSamples: () => void
  conquerTerritory: (id: number, distance: number) => boolean
  addSessionXp: (amount: number) => number
  addActivity: (activity: Record<string, unknown>) => void
  hydrateTerritoriesFromApi: (
    territories: unknown[],
    polygons: Record<number, LatLng[]>,
    users: unknown[],
  ) => void
}

interface RecorderOptions {
  mapElId: string
  wl: TrailStore | null
}

const YOURS = '#059669'
const ENEMY = '#f59e0b'
const CAPTURING = '#a855f7'
const SIM_ROUTE = '#0ea5e9'
const CAPTURE_SAMPLES_NEEDED = 10

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function haversine(a: LatLng, b: LatLng): number {
  const R = 3958.8
  const dLat = (b[0] - a[0]) * Math.PI / 180
  const dLng = (b[1] - a[1]) * Math.PI / 180
  const lat1 = a[0] * Math.PI / 180
  const lat2 = b[0] * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function pointInPolygon(pt: LatLng, poly: LatLng[]): boolean {
  const [lat, lng] = pt
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [iLat, iLng] = poly[i]
    const [jLat, jLng] = poly[j]
    const intersect = (iLng > lng) !== (jLng > lng)
      && lat < (jLat - iLat) * (lng - iLng) / (jLng - iLng) + iLat
    if (intersect) inside = !inside
  }
  return inside
}

interface TerritoryBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

function polygonBounds(poly: LatLng[]): TerritoryBounds {
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  for (const [lat, lng] of poly) {
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
  }
  return { minLat, maxLat, minLng, maxLng }
}

function boundsContain(bounds: TerritoryBounds, lat: number, lng: number): boolean {
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng
}

async function maybeRequestNativeReview(): Promise<void> {
  if (!isNativeMobile() || typeof localStorage === 'undefined') return
  const key = 'wildloop_completed_activities'
  const count = Number(localStorage.getItem(key) ?? '0') + 1
  localStorage.setItem(key, String(count))
  if (count === 3) await appReview.request().catch(() => false)
}

export function useRecorder({ mapElId, wl }: RecorderOptions) {
  const recording = state(false)
  const paused = state(false)
  const activityType = state<ActivityType>('Trail Run')
  const visibility = state('followers')
  const mode = state<RecordMode>('idle')
  const elapsed = state(0)
  const distance = state(0)
  const elevation = state(0)
  const gpsStatus = state<GpsStatus>('stopped')
  const selectedTrailId = state<number>(wl?.trails()[0]?.id ?? 0)
  const conqueredIds = state<number[]>([])
  const captureProgress = state<Record<number, number>>({})
  const sessionXp = state(0)
  const runMode = state<'capture' | 'free'>('capture')
  const targetTerritoryId = state<number | null>(null)
  const conquestToast = state<string | null>(null)
  const saveStatus = state<'idle' | 'saving' | 'saved' | 'queued' | 'error'>('idle')
  const saveMessage = state<string | null>(null)
  const recordingError = state<string | null>(null)
  const wrongTurn = state(false)

  onMount(async () => {
    if (!recording())
      visibility.set(await loadActivityVisibilityDefault())
  })

  const trailOptions = derived(() =>
    wl ? wl.trails().map(t => ({ id: t.id, name: t.name, location: t.location })) : [],
  )

  const refs: {
    mapHandle: Awaited<ReturnType<typeof createTrailMap>> | null
    map: TsMapType | null
    territoryLayers: Record<number, PolygonType>
    territoryBounds: Record<number, TerritoryBounds>
    trailMarkers: Record<number, CircleMarkerType>
    routeLine: LiveRouteLine | null
    routeCoords: LatLng[]
    /** Timestamped samples (alt + moving time) for splits/elevation (#952/#953). */
    samples: RecorderSample[]
    /** Wall-clock start of the run - elapsed time includes pauses (#960). */
    startedAtMs: number | null
    elapsedTimer: ReturnType<typeof setInterval> | null
    simTimer: ReturnType<typeof setInterval> | null
    watchId: number | null
    toastTimer: ReturnType<typeof setTimeout> | null
    lastPanAt: number
    checkpointPending: boolean
    lifecycleCleanup: (() => void) | null
    watchCleanup: (() => void) | null
    liveActivityStarted: boolean
    lastLiveActivityUpdateAt: number
  } = {
    mapHandle: null,
    map: null,
    territoryLayers: {},
    territoryBounds: {},
    trailMarkers: {},
    routeLine: null,
    routeCoords: [],
    samples: [],
    startedAtMs: null,
    elapsedTimer: null,
    simTimer: null,
    watchId: null,
    toastTimer: null,
    lastPanAt: 0,
    checkpointPending: false,
    lifecycleCleanup: null,
    watchCleanup: null,
    liveActivityStarted: false,
    lastLiveActivityUpdateAt: 0,
  }

  async function startNativeLiveActivity(): Promise<void> {
    if (!isNativeMobile() || !device.isIOS() || mode() !== 'manual') return
    try {
      await liveActivities.start({
        activityId: crypto.randomUUID(),
        title: activityType(),
        status: 'Recording',
        distanceMeters: distance() * 1609.344,
        durationSeconds: elapsed(),
        progress: 0,
      })
      refs.liveActivityStarted = true
      refs.lastLiveActivityUpdateAt = Date.now()
    }
    catch {
      refs.liveActivityStarted = false
    }
  }

  async function updateNativeLiveActivity(force = false): Promise<void> {
    if (!isNativeMobile() || !device.isIOS() || mode() !== 'manual') return
    const now = Date.now()
    if (!force && now - refs.lastLiveActivityUpdateAt < 5_000) return
    try {
      await liveActivities.update({
        status: paused() ? 'Paused' : 'Recording',
        distanceMeters: distance() * 1609.344,
        durationSeconds: elapsed(),
        progress: 0,
      })
      refs.liveActivityStarted = true
      refs.lastLiveActivityUpdateAt = now
    }
    catch {
      if (!refs.liveActivityStarted) await startNativeLiveActivity()
    }
  }

  async function endNativeLiveActivity(): Promise<void> {
    if (!isNativeMobile() || !device.isIOS() || mode() !== 'manual') return
    await liveActivities.end().catch(() => undefined)
    refs.liveActivityStarted = false
    refs.lastLiveActivityUpdateAt = 0
  }

  function watchState(status?: string): Record<string, unknown> {
    return {
      recording: recording(),
      paused: paused(),
      distanceMeters: distance() * 1609.344,
      durationSeconds: elapsed(),
      status: status ?? (recording() ? paused() ? 'Paused' : 'Recording' : 'Ready'),
    }
  }

  async function updateWatchState(status?: string): Promise<void> {
    if (!isNativeMobile() || !device.isIOS()) return
    await watchConnectivity.updateContext(watchState(status)).catch(() => undefined)
  }

  async function saveNativeWorkout(activityId: number | null, endedAt: number): Promise<void> {
    if (!isNativeMobile() || mode() !== 'manual' || !refs.startedAtMs || refs.samples.length < 2) return
    const connected = await secureStorage.get('wildloop_health_connected').catch(() => null)
    if (connected !== 'true') return
    const workoutTypes = {
      'Trail Run': 'running',
      'Hike': 'hiking',
      'Walk': 'walking',
      'Bike': 'cycling',
    } as const
    const calories = Math.max(1, Math.round(elapsed() / 60 * 10))
    await health.saveWorkout({
      activityId: `wildloop:${activityId ?? refs.startedAtMs}`,
      type: workoutTypes[activityType()],
      startDate: refs.startedAtMs,
      endDate: endedAt,
      distanceMeters: distance() * 1609.344,
      activeEnergyCalories: calories,
      locations: refs.samples.map(sample => ({
        latitude: sample.lat,
        longitude: sample.lng,
        altitude: sample.eleFt == null ? undefined : sample.eleFt / METERS_TO_FEET,
        accuracy: sample.accuracy ?? undefined,
        timestamp: sample.t,
      })),
    })
  }

  function paintTerritory(territoryId: number, mine: boolean, progress = 0) {
    const layer = refs.territoryLayers[territoryId]
    if (!layer) return
    if (mine) {
      layer.setStyle({ color: YOURS, fillColor: YOURS, fillOpacity: 0.45, weight: 3 })
      return
    }
    const pct = progress / 100
    const color = progress > 0 && progress < 100 ? CAPTURING : ENEMY
    layer.setStyle({
      color,
      fillColor: color,
      fillOpacity: 0.12 + pct * 0.38,
      weight: targetTerritoryId() === territoryId ? 4 : 2,
      dashArray: progress > 0 && progress < 100 ? '6 4' : undefined,
    })
  }

  // Repaint existing territory layers to match current store ownership (after a
  // backend re-hydration). New/split territories appear on the next full map
  // load (the territories page); here we reflect ownership flips of what's drawn.
  function repaintTerritories() {
    if (!wl) return
    const uid = wl.currentUserId()
    for (const t of wl.territories())
      paintTerritory(t.id, t.user_id === uid)
  }

  async function checkpointRecording(): Promise<void> {
    if (!recording() || mode() !== 'manual' || !refs.startedAtMs || refs.checkpointPending) return
    refs.checkpointPending = true
    try {
      await saveRecordingCheckpoint({
        activityType: activityType(),
        visibility: visibility(),
        runMode: runMode(),
        targetTerritoryId: targetTerritoryId(),
        startedAtMs: refs.startedAtMs,
        elapsed: elapsed(),
        distance: distance(),
        elevation: elevation(),
        paused: paused(),
        samples: [...refs.samples],
      })
    }
    catch (error) {
      console.error('recording checkpoint failed:', error)
    }
    finally {
      refs.checkpointPending = false
    }
  }

  function rebuildTrackFromSamples(samples: RecorderSample[]): void {
    refs.samples = samples
    refs.routeCoords = samples.map(sample => [sample.lat, sample.lng])
    let miles = 0
    let gainFeet = 0
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1]
      const current = samples[index]
      miles += haversine([previous.lat, previous.lng], [current.lat, current.lng])
      if (previous.eleFt != null && current.eleFt != null) {
        const delta = current.eleFt - previous.eleFt
        if (delta >= ELEVATION_NOISE_FLOOR_FT) gainFeet += delta
      }
    }
    distance.set(miles)
    elevation.set(Math.round(gainFeet))
    refs.routeLine?.setLatLngs(refs.routeCoords)
  }

  async function mergeNativeTrack(): Promise<void> {
    if (!isNativeMobile() || mode() !== 'manual') return
    try {
      const nativeSamples = await location.readRecording()
      const merged = mergeNativeLocationSamples(refs.samples, nativeSamples)
      if (merged.length === refs.samples.length) return
      const startedAt = refs.startedAtMs ?? merged[0]?.t ?? Date.now()
      for (const sample of merged) {
        if (sample.movingS === 0 && sample.t > startedAt)
          sample.movingS = Math.max(0, Math.round((sample.t - startedAt) / 1000))
      }
      rebuildTrackFromSamples(merged)
      await checkpointRecording()
    }
    catch (error) {
      console.error('native recording recovery failed:', error)
    }
  }


  // Live, VISUAL-ONLY feedback while running through enemy territory. The
  // authoritative capture is decided by the backend on stop (closed-loop claim
  // + route-intersection split), then the map is re-hydrated from the API
  // (#943). We no longer flip ownership client-side, which used a different
  // rule (10 proximity pings) and disagreed with the persisted result.
  function checkConquest(lat: number, lng: number) {
    if (!wl || runMode() === 'free') return
    const uid = wl.currentUserId()
    const polys = wl.territoryPolygons()
    const territories = wl.territories()
    const progressMap = { ...captureProgress() }

    for (const t of territories) {
      if (t.user_id === uid) continue
      const poly = polys[t.id]
      if (!poly) continue
      const bounds = refs.territoryBounds[t.id] ??= polygonBounds(poly)
      if (!boundsContain(bounds, lat, lng)) continue
      if (!pointInPolygon([lat, lng], poly)) continue

      // Fill the meter as a "you're on enemy turf" cue (capped just under full
      // so the UI doesn't promise a capture the engine hasn't confirmed).
      const pct = Math.min(90, wl.applyCaptureSample(t.id, CAPTURE_SAMPLES_NEEDED))
      progressMap[t.id] = pct
      captureProgress.set(progressMap)
      paintTerritory(t.id, false, pct)
    }
  }

  // altitudeM comes from the GPS (metres, often null on desktop) or, for
  // simulated runs, from the trail's published elevation profile. While paused
  // nothing accrues - no distance, no samples, no capture progress (#960).
  function addRoutePoint(lat: number, lng: number, altitudeM: number | null = null, accuracy: number | null = null) {
    if (!refs.routeLine || !refs.map) return
    if (paused() || !recording()) return
    const coords = refs.routeCoords
    if (coords.length > 0) {
      const prev = coords[coords.length - 1]
      distance.set(distance() + haversine(prev, [lat, lng]))
    }
    coords.push([lat, lng])

    // Elevation gain: positive altitude deltas above the GPS noise floor (#953).
    const eleFt = altitudeM != null ? altitudeM * METERS_TO_FEET : null
    const prevSample = refs.samples[refs.samples.length - 1]
    if (eleFt != null && prevSample?.eleFt != null) {
      const d = eleFt - prevSample.eleFt
      if (d >= ELEVATION_NOISE_FLOOR_FT)
        elevation.set(Math.round(elevation() + d))
    }
    refs.samples.push({ lat, lng, t: Date.now(), eleFt, movingS: elapsed(), accuracy })

    refs.routeLine.addLatLng([lat, lng])
    if (mode() === 'manual' && wl) {
      const guide = wl.trailRoutes()[selectedTrailId()] ?? []
      if (guide.length > 1) {
        const nearestMiles = guide.reduce((nearest, point) => Math.min(nearest, haversine([lat, lng], point)), Number.POSITIVE_INFINITY)
        wrongTurn.set(nearestMiles > 0.08)
      }
    }
    checkConquest(lat, lng)
    if (refs.samples.length % 10 === 0) void checkpointRecording()
  }

  function clearTimers() {
    if (refs.elapsedTimer) { clearInterval(refs.elapsedTimer); refs.elapsedTimer = null }
    if (refs.simTimer) { clearInterval(refs.simTimer); refs.simTimer = null }
    if (refs.watchId !== null) {
      location.clearWatch(refs.watchId)
      refs.watchId = null
    }
  }

  function resetRun() {
    clearTimers()
    void clearRecordingCheckpoint()
    void keepAwake.disable().catch(() => undefined)
    elapsed.set(0)
    distance.set(0)
    elevation.set(0)
    conqueredIds.set([])
    captureProgress.set({})
    sessionXp.set(0)
    conquestToast.set(null)
    saveStatus.set('idle')
    saveMessage.set(null)
    recordingError.set(null)
    wrongTurn.set(false)
    paused.set(false)
    if (wl) wl.resetCaptureSamples()
    refs.routeCoords = []
    refs.samples = []
    refs.startedAtMs = null
    refs.lastPanAt = 0
    refs.liveActivityStarted = false
    refs.lastLiveActivityUpdateAt = 0
    if (refs.routeLine && refs.map) {
      refs.map.removeLayer(refs.routeLine)
      refs.routeLine = null
    }
    if (wl) {
      const uid = wl.currentUserId()
      for (const t of wl.territories()) paintTerritory(t.id, t.user_id === uid)
    }
  }

  function startTicker() {
    refs.elapsedTimer = setInterval(() => {
      if (!paused() && recording()) elapsed.set(elapsed() + 1)
      if (recording()) {
        void updateNativeLiveActivity()
        void updateWatchState()
      }
    }, 1000)
  }

  async function simulate() {
    if (!wl || !refs.map) return
    if (!wl.currentUserId()) {
      recordingError.set('Sign in before recording an activity.')
      return
    }
    const id = selectedTrailId()
    const route = wl.trailRoutes()[id]
    if (!route || route.length < 2) return
    resetRun()
    mode.set('simulated')
    recording.set(true)
    gpsStatus.set('active')
    void haptics.impact('medium')
    refs.routeCoords = []
    refs.startedAtMs = Date.now()
    refs.routeLine = await createLiveRouteLine(refs.map, SIM_ROUTE)
    const { Polyline } = await ensureTsMaps()
    const guide = new Polyline(route, { weight: 0, opacity: 0 }).addTo(refs.map)
    refs.map.fitBounds(guide.getBounds(), { padding: [40, 40] })
    refs.map.removeLayer(guide)

    // Simulated elevation comes from the trail's published total gain,
    // distributed monotonically along the route - deterministic, no random
    // values (#953). Converted to metres so addRoutePoint's single GPS-style
    // accumulation path applies to both modes.
    const totalGainFt = wl.findTrail(id)?.elevation ?? 0
    let i = 0
    startTicker()
    refs.simTimer = setInterval(() => {
      if (paused() || !recording()) return
      if (i >= route.length) {
        stop()
        return
      }
      const [lat, lng] = route[i++]
      const syntheticAltM = (totalGainFt * (i / route.length)) / METERS_TO_FEET
      addRoutePoint(lat, lng, syntheticAltM)
    }, 350)
  }

  async function startManual() {
    if (!refs.map) return
    recordingError.set(null)
    if (!wl?.currentUserId()) {
      recordingError.set('Sign in before recording an activity.')
      return
    }
    if (!isNativeMobile() && !navigator.geolocation) {
      gpsStatus.set('stopped')
      recordingError.set('Location is not available on this device. Use Preview instead.')
      return
    }
    if (isNativeMobile()) {
      let access = await permissions.check('location').catch(() => 'undetermined')
      if (access === 'undetermined')
        access = await permissions.request('location').catch(() => 'undetermined')
      if (access !== 'granted') {
        gpsStatus.set('stopped')
        recordingError.set(access === 'denied' || access === 'restricted'
          ? 'Location access is off. Open device settings above to allow precise location.'
          : 'Allow precise location above before starting a recording.')
        return
      }
    }
    if (!refs.map) {
      recordingError.set('The map is still loading. Try again in a moment.')
      return
    }
    resetRun()
    mode.set('manual')
    gpsStatus.set('searching')
    refs.routeCoords = []
    refs.routeLine = await createLiveRouteLine(refs.map, YOURS)

    const beginTracking = async (startLat: number, startLng: number, startAltM: number | null, accuracy: number | null) => {
      if (isNativeMobile())
        await location.startRecording({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 })
      recording.set(true)
      gpsStatus.set('active')
      void haptics.impact('medium')
      refs.startedAtMs = Date.now()
      addRoutePoint(startLat, startLng, startAltM, accuracy)
      refs.map!.setView([startLat, startLng], 17)
      startTicker()
      void keepAwake.enable().catch(() => undefined)
      void startNativeLiveActivity()
      void updateWatchState('Recording')
      refs.watchId = location.watchPosition(
        (position) => {
          gpsStatus.set('active')
          addRoutePoint(position.latitude, position.longitude, position.altitude ?? null, position.accuracy)
          const now = Date.now()
          if (now - refs.lastPanAt >= 1_500) {
            refs.lastPanAt = now
            refs.map!.panTo([position.latitude, position.longitude])
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
      )
      await checkpointRecording()
    }

    void location.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
      .then(position => beginTracking(position.latitude, position.longitude, position.altitude ?? null, position.accuracy))
      .catch((error: unknown) => {
        gpsStatus.set('stopped')
        if (refs.routeLine && refs.map) {
          refs.map.removeLayer(refs.routeLine)
          refs.routeLine = null
        }
        const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : 0
        recordingError.set(code === 1
          ? 'Location access is off. Open device settings above to allow precise location.'
          : 'Could not get your location. Try again in a moment.')
      })
  }

  async function togglePause() {
    const shouldPause = !paused()
    if (isNativeMobile() && mode() === 'manual') {
      try {
        if (shouldPause) await location.pauseRecording()
        else await location.resumeRecording()
      }
      catch (error) {
        console.error('native recording pause failed:', error)
      }
    }
    paused.set(shouldPause)
    void haptics.impact(paused() ? 'soft' : 'medium')
    await checkpointRecording()
    await updateNativeLiveActivity(true)
    await updateWatchState(shouldPause ? 'Paused' : 'Recording')
  }

  interface RunMetrics {
    durationStr: string
    movingTimeStr: string
    paceStr: string | null
    splits: MileSplit[]
  }

  // Persist the run before inserting it into the local catalog. A stable
  // upload id makes retries idempotent; transient failures are queued in
  // IndexedDB and retried by the app shell when connectivity returns.
  const persistRun = async (
    routeSnapshot: LatLng[],
    sampleSnapshot: RecorderSample[],
    trailId: number | null,
    metrics: RunMetrics,
  ): Promise<number | null> => {
    if (!wl || routeSnapshot.length < 2) return null
    saveStatus.set('saving')
    saveMessage.set('Saving activity…')
    try {
      const result = await persistRunAndProcess({
        user_id: wl.currentUserId(),
        trail_id: trailId,
        activity_type: activityType(),
        distance: Number(distance().toFixed(2)),
        duration: metrics.durationStr,
        moving_time: metrics.movingTimeStr,
        pace: metrics.paceStr,
        elevation: elevation(),
        gpx_data: routeToGeoJson(routeSnapshot, sampleSnapshot),
        splits: metrics.splits,
        visibility: visibility(),
        completed_at: new Date().toISOString(),
        upload_id: `run:${crypto.randomUUID()}`,
        recording_source: mode() === 'simulated' ? 'simulation' : isNativeMobile() ? 'native_gps' : 'web_gps',
        game_mode: runMode(),
        target_territory_id: targetTerritoryId(),
      })
      const message = runResultMessage(result)
      if (message) {
        conquestToast.set(message)
        if (refs.toastTimer) clearTimeout(refs.toastTimer)
        refs.toastTimer = setTimeout(() => conquestToast.set(null), 3600)
      }
      // Re-hydrate territories from the backend so the map reflects the real
      // claim/conquest outcome (single source of truth), then repaint.
      if ((result.claim && result.claim.success) || (result.conquest && (result.conquest.conqueredCount ?? 0) > 0)) {
        await loadTerritories(wl)
        repaintTerritories()
      }
      if (result.queued) {
        saveStatus.set('queued')
        saveMessage.set(result.error ?? 'Saved offline; syncing is automatic')
        return null
      }
      saveStatus.set(result.activityId ? 'saved' : 'error')
      saveMessage.set(result.error ?? (result.activityId ? 'Activity saved' : 'Activity could not be saved'))
      return result.activityId
    }
    catch (err) {
      console.error('persistRun failed:', err)
      saveStatus.set('error')
      saveMessage.set(err instanceof Error ? err.message : 'Activity could not be saved')
      return null
    }
  }

  async function stop() {
    const endedAt = Date.now()
    if (isNativeMobile() && mode() === 'manual') {
      try {
        const nativeResult = await location.stopRecording()
        const merged = mergeNativeLocationSamples(refs.samples, nativeResult.locations)
        const startedAt = refs.startedAtMs ?? merged[0]?.t ?? Date.now()
        for (const sample of merged) {
          if (sample.movingS === 0 && sample.t > startedAt)
            sample.movingS = Math.max(0, Math.round((sample.t - startedAt) / 1000))
        }
        rebuildTrackFromSamples(merged)
      }
      catch (error) {
        console.error('native recording stop failed:', error)
        await mergeNativeTrack()
      }
    }
    recording.set(false)
    paused.set(false)
    gpsStatus.set('stopped')
    void haptics.notification('success')
    clearTimers()
    void keepAwake.disable().catch(() => undefined)
    await endNativeLiveActivity()
    if (distance() > 0 && wl) {
      const trail = mode() === 'simulated' ? wl.findTrail(selectedTrailId()) : null

      // Moving time is the pause-aware ticker; elapsed is wall-clock (#960).
      // Pace derives from moving time, splits from the timestamped samples.
      const movingS = elapsed()
      const wallS = refs.startedAtMs
        ? Math.max(movingS, Math.round((Date.now() - refs.startedAtMs) / 1000))
        : movingS
      const splits = computeSplitsFromSamples(refs.samples)
      const paceStr = distance() > 0.01 ? `${fmtDuration(Math.round(movingS / distance()))}/mi` : null

      // Persist to the backend + run the territory engine using the recorded
      // GPS track (snapshot before it's cleared on the next run).
      const activityId = await persistRun([...refs.routeCoords], [...refs.samples], trail?.id ?? null, {
        durationStr: fmtDuration(wallS),
        movingTimeStr: fmtDuration(movingS),
        paceStr,
        splits,
      })
      const title = mode() === 'simulated'
        ? `Route preview: ${trail?.name ?? activityType()}`
        : `${runMode() === 'capture' ? 'Capture Run' : activityType()}, ${new Date().toLocaleDateString()}`
      if (activityId) wl.addActivity({
        id: activityId,
        user_id: wl.currentUserId(),
        userName: 'You',
        trail_id: trail?.id ?? null,
        trail_name: trail?.name ?? `${activityType()} Activity`,
        title,
        activityType: activityType(),
        distance: Number(distance().toFixed(2)),
        duration: fmtDuration(wallS),
        moving_time: fmtDuration(movingS),
        pace: paceStr ?? '--',
        elevation_gain: elevation(),
        calories: Math.round(movingS / 60 * 10),
        heartRateAvg: null,
        heartRateMax: null,
        cadence: null,
        splits,
        kudos_count: 0,
        comments: [],
        visibility: visibility(),
        hasGps: true,
      })
      await saveNativeWorkout(activityId, endedAt).catch(error => console.error('native workout save failed:', error))
      if (activityId) void maybeRequestNativeReview()
    }
    await clearRecordingCheckpoint().catch(() => undefined)
    mode.set('idle')
    await updateWatchState('Finished')
  }

  async function recoverRecording(): Promise<void> {
    const checkpoint = await loadRecordingCheckpoint().catch(() => null)
    let nativeState = null
    if (isNativeMobile())
      nativeState = await location.getRecordingState().catch(() => null)
    if (!checkpoint && !nativeState?.active) return
    if (checkpoint && Date.now() - checkpoint.savedAt > 24 * 60 * 60 * 1000 && !nativeState?.active) {
      await clearRecordingCheckpoint().catch(() => undefined)
      return
    }

    const restored = checkpoint
    mode.set('manual')
    recording.set(true)
    paused.set(nativeState?.paused ?? restored?.paused ?? false)
    gpsStatus.set('active')
    if (restored) {
      activityType.set(restored.activityType)
      visibility.set(restored.visibility)
      runMode.set(restored.runMode)
      targetTerritoryId.set(restored.targetTerritoryId)
      refs.startedAtMs = restored.startedAtMs
      elapsed.set(restored.elapsed)
      distance.set(restored.distance)
      elevation.set(restored.elevation)
      refs.samples = restored.samples
      refs.routeCoords = restored.samples.map(sample => [sample.lat, sample.lng])
    }
    else {
      refs.startedAtMs = nativeState?.startedAt ?? Date.now()
    }

    refs.routeLine = await createLiveRouteLine(refs.map!, YOURS)
    if (refs.samples.length) refs.routeLine.setLatLngs(refs.routeCoords)
    if (isNativeMobile()) {
      if (!nativeState?.active)
        await location.startRecording({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 })
      await mergeNativeTrack()
    }

    const lastSample = refs.samples[refs.samples.length - 1]
    if (lastSample && refs.startedAtMs && !paused())
      elapsed.set(Math.max(elapsed(), Math.round((lastSample.t - refs.startedAtMs) / 1000)))
    refs.watchId = location.watchPosition((position) => {
      gpsStatus.set('active')
      addRoutePoint(position.latitude, position.longitude, position.altitude ?? null, position.accuracy)
      const now = Date.now()
      if (now - refs.lastPanAt >= 1_500) {
        refs.lastPanAt = now
        refs.map?.panTo([position.latitude, position.longitude])
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 })
    if (lastSample) refs.map?.setView([lastSample.lat, lastSample.lng], 17)
    startTicker()
    void keepAwake.enable().catch(() => undefined)
    await updateNativeLiveActivity(true)
    saveStatus.set('queued')
    saveMessage.set('Recovered your in-progress activity')
  }

  async function initRecordMap() {
    try {
      const store = wl ?? useStore('wl')
      if (!store) return
      refs.mapHandle = await createTrailMap(mapElId, { scrollWheelZoom: true })
      if (!refs.mapHandle) return
      refs.map = refs.mapHandle.map

      const uid = store.currentUserId()
      const polys = store.territoryPolygons()
      const trailBounds: LatLng[] = []

      for (const t of store.territories()) {
        const poly = polys[t.id]
        if (!poly) continue
        const mine = t.user_id === uid
        const color = mine ? YOURS : ENEMY
        const layer = await drawTerritoryPolygon(refs.map, poly, {
          color,
          fillOpacity: mine ? 0.45 : 0.15,
          weight: targetTerritoryId() === t.id ? 4 : 2,
          popupHtml: `<b>${t.name}</b><br>${mine ? 'Your turf' : 'Enemy turf. Run through to capture'}<br>${formatTerritoryArea(t.areaSize)}`,
          onClick: () => {
            if (!mine && !recording())
              targetTerritoryId.set(t.id)
          },
        })
        if (!layer)
          continue

        refs.territoryLayers[t.id] = layer
        refs.territoryBounds[t.id] = polygonBounds(poly)
      }

      for (const tr of store.trails()) {
        if (!tr.lat || !tr.lng) continue
        const marker = await drawTrailMarker(refs.map, tr.lat, tr.lng, {
          difficulty: tr.difficulty,
          popupHtml: `<b>${tr.name}</b><br>${tr.location}<br>${tr.distance} mi • ${tr.difficulty}`,
          onClick: () => selectedTrailId.set(tr.id),
        })
        refs.trailMarkers[tr.id] = marker
        trailBounds.push([tr.lat, tr.lng])
      }

      /*
       * Open on one territory, not on a map of the country.
       *
       * Framing everything put this screen at continental zoom, where a claim a
       * few hundred metres across is smaller than the dot drawn over it — a
       * start screen showing nothing anyone could set off from. Holdings are
       * not necessarily near each other either, so fitting all of them is no
       * better than fitting all the trailheads. One territory always frames to
       * a runnable view: the athlete's biggest, or the biggest in play for
       * someone who has not claimed any ground yet.
       */
      const focus = store.territories()
        .filter(t => polys[t.id]?.length)
        .sort((a, b) =>
          Number(b.user_id === uid) - Number(a.user_id === uid)
          || b.areaSize - a.areaSize)[0]
      const frame = focus ? polys[focus.id]! : trailBounds
      if (frame.length) refs.mapHandle.fitPoints(frame, [40, 40])
      else refs.map.setView([37.7749, -122.4194], 5)

      await recoverRecording()
      if (isNativeMobile() && device.isIOS()) {
        refs.watchCleanup = watchConnectivity.onMessage((message) => {
          if (message.type !== 'recording-control' || typeof message.action !== 'string') return
          if (message.action === 'start' && !recording()) void startManual()
          if (message.action === 'pause' && recording() && !paused()) void togglePause()
          if (message.action === 'resume' && recording() && paused()) void togglePause()
          if (message.action === 'finish' && recording()) void stop()
        })
        void updateWatchState()
      }
      refs.lifecycleCleanup = lifecycle.onStateChange((appState) => {
        if (!recording()) return
        if (appState === 'background') void checkpointRecording()
        if (appState === 'active') void mergeNativeTrack()
      })
    }
    catch (err) {
      console.error('record map init failed:', err)
    }
  }

  onDestroy(() => {
    void checkpointRecording()
    clearTimers()
    void keepAwake.disable().catch(() => undefined)
    refs.lifecycleCleanup?.()
    refs.lifecycleCleanup = null
    refs.watchCleanup?.()
    refs.watchCleanup = null
    if (refs.toastTimer) clearTimeout(refs.toastTimer)
    refs.mapHandle?.destroy()
    refs.mapHandle = null
    refs.map = null
  })

  return {
    recording,
    paused,
    activityType,
    visibility,
    mode,
    elapsed,
    distance,
    elevation,
    gpsStatus,
    selectedTrailId,
    targetTerritoryId,
    conqueredIds,
    captureProgress,
    sessionXp,
    runMode,
    conquestToast,
    saveStatus,
    saveMessage,
    recordingError,
    wrongTurn,
    trailOptions,
    simulate,
    startManual,
    togglePause,
    stop,
    resetRun,
    mountRecordMap: () => runWhenMapReady(mapElId, initRecordMap),
  }
}
