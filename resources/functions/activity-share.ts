import { ACTIVITY_SHARE_CARD_PRESETS, activityShareCardFileName, activityShareCardSvg, type ActivityShareCardOptions, type ActivityShareCardPreset, type ActivitySharePoint } from 'ts-images/activity-card'

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

export function activityShareOptions(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset): ActivityShareCardOptions {
  return {
    activityType: activity.activityType,
    athlete: activity.userName,
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

export function activityShareSvg(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset): string {
  return activityShareCardSvg(activityShareOptions(activity, route, preset))
}

export function activitySharePreview(activity: ShareableActivity, route: ActivitySharePoint[], preset: ActivityShareCardPreset): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(activityShareSvg(activity, route, preset))}`
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
  const source = new Blob([activityShareSvg(activity, route, preset)], { type: 'image/svg+xml;charset=utf-8' })
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
