import { ACTIVITY_SHARE_CARD_PRESETS, ACTIVITY_SHARE_MAP_BOXES, activityShareCardFileName, activityShareCardSvg, activityShareMapReserve, activityShareProjection, type ActivityShareBasemap, type ActivityShareCardOptions, type ActivityShareCardPreset, type ActivitySharePoint, type ActivityShareProjection } from 'ts-images/activity-card'
import { buildStyle, ensureTsMaps, resolveVectorTiles } from '../composables/useTrailMap'

export interface ShareableActivity {
  activityType: string
  created_at?: string
  distance: number
  duration: string
  elevation_gain?: number
  moving_time?: string
  pace?: string
  title: string
  userName?: string
}

export type ActivityShareOutcome = 'cancelled' | 'downloaded' | 'shared'

function completedAtLabel(value: string | undefined): string | undefined {
  if (!value)
    return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return undefined
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

/**
 * The card's map is Wildloop's own: the same vector tiles and the same style
 * the map screens draw, rendered by ts-maps as SVG paths and text. It stays
 * sharp at any size, it looks like the run did in the app, and it borrows no
 * one else's raster tiles. Places the route passes are named first, and no
 * label sits under the line.
 */
const basemapCache = new Map<string, Promise<ActivityShareBasemap | null>>()

/** The route's line, in the map box's own pixels, for labels to keep clear of. */
function routeInBox(route: ActivitySharePoint[], projection: ActivityShareProjection): Array<[number, number]> {
  const toY = (lat: number) => {
    const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180
    return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2
  }
  return route.map(point => [((point.lng + 180) / 360 - projection.left) * projection.scale, (toY(point.lat) - projection.top) * projection.scale])
}

async function drawActivityShareBasemap(route: ActivitySharePoint[], preset: ActivityShareCardPreset): Promise<ActivityShareBasemap | null> {
  const projection = activityShareProjection(route, preset)
  const tiles = await resolveVectorTiles()
  if (!projection || !tiles)
    return null
  const maps = await ensureTsMaps()
  const box = ACTIVITY_SHARE_MAP_BOXES[preset]
  const map = await maps.renderStaticMap({
    style: buildStyle(maps, 'dark', tiles),
    width: box.width,
    height: box.height,
    view: projection,
    avoid: [routeInBox(route, projection)],
    // The card's line is 10px over an 18px shadow.
    avoidPadding: 10,
    // The corner the card draws the map's credit in.
    reserve: [activityShareMapReserve(preset)],
    idPrefix: `share-${preset}`,
  })
  return { attribution: map.attribution, markup: map.markup, preset, projection }
}

/**
 * The map for a route in one preset, drawn once and kept, so switching
 * presets back and forth or sharing after previewing costs nothing. A failure
 * resolves to null, which draws the card without a map.
 */
export function loadActivityShareBasemap(route: ActivitySharePoint[], preset: ActivityShareCardPreset): Promise<ActivityShareBasemap | null> {
  if (route.length < 2)
    return Promise.resolve(null)
  const first = route[0]!
  const last = route[route.length - 1]!
  const key = `${preset}:${route.length}:${first.lat},${first.lng}:${last.lat},${last.lng}`
  let pending = basemapCache.get(key)
  if (!pending) {
    pending = drawActivityShareBasemap(route, preset).catch(() => null)
    basemapCache.set(key, pending)
  }
  return pending
}

export function activityShareOptions(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset, basemap?: ActivityShareBasemap | null): ActivityShareCardOptions {
  return {
    activityType: activity.activityType,
    athlete: activity.userName,
    basemap,
    brand: 'Wildloop',
    completedAt: completedAtLabel(activity.created_at),
    distance: `${activity.distance.toFixed(2)} mi`,
    duration: activity.moving_time || activity.duration,
    elevation: `${Math.round(activity.elevation_gain || 0).toLocaleString('en-US')} ft`,
    pace: activity.pace || '—',
    preset,
    route,
    title: activity.title,
  }
}

export function activityShareSvg(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset, basemap?: ActivityShareBasemap | null): string {
  return activityShareCardSvg(activityShareOptions(activity, route, preset, basemap))
}

export function activitySharePreview(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset, basemap?: ActivityShareBasemap | null): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(activityShareSvg(activity, route, preset, basemap))}`
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function renderActivitySharePng(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset): Promise<Blob> {
  if (typeof document === 'undefined')
    throw new TypeError('Activity images can only be rendered in a browser')

  const size = ACTIVITY_SHARE_CARD_PRESETS[preset]
  const basemap = await loadActivityShareBasemap(route, preset)
  const source = new Blob([activityShareSvg(activity, route, preset, basemap)], { type: 'image/svg+xml;charset=utf-8' })
  const sourceUrl = URL.createObjectURL(source)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = sourceUrl
    await image.decode()

    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context)
      throw new Error('This browser cannot create the activity image')
    context.drawImage(image, 0, 0, size.width, size.height)

    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png', 0.92))
    if (!png)
      throw new Error('This browser could not encode the activity image')
    return png
  }
  finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

export async function downloadActivityShareImage(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset): Promise<void> {
  const png = await renderActivitySharePng(activity, route, preset)
  downloadBlob(png, activityShareCardFileName(activity.title, preset))
}

export async function shareActivityImage(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset): Promise<ActivityShareOutcome> {
  const png = await renderActivitySharePng(activity, route, preset)
  const file = new File([png], activityShareCardFileName(activity.title, preset), { type: 'image/png' })
  const shareData = {
    files: [file],
    text: `${activity.title} on Wildloop`,
    title: activity.title,
  }

  if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData)
      return 'shared'
    }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        return 'cancelled'
      throw error
    }
  }

  downloadBlob(png, file.name)
  return 'downloaded'
}
