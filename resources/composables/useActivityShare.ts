import { derived, effect, state } from 'stx'
import { haptics } from '@stacksjs/mobile'
import type { ActivityShareBasemap, ActivityShareCardPreset, ActivitySharePoint } from 'ts-images/activity-card'
import { activitySharePreview, downloadActivityShareImage, loadActivityShareBasemap, shareActivityImage, type ShareableActivity } from '../functions/activity-share'

export function useActivityShare(getActivity: () => ShareableActivity | null, getRoute: () => ActivitySharePoint[]) {
  const sharePreset = state<ActivityShareCardPreset>('square')
  const shareBusy = state(false)
  const shareMessage = state<string | null>(null)
  const shareBasemap = state<ActivityShareBasemap | null>(null)

  // The preview draws at once without a map, then again once the tiles are
  // in. A late answer for a preset no longer chosen is dropped.
  effect(() => {
    const route = getRoute()
    const preset = sharePreset()
    loadActivityShareBasemap(route, preset).then((basemap) => {
      if (sharePreset() === preset)
        shareBasemap.set(basemap)
    })
  })

  const sharePreview = derived(() => {
    const activity = getActivity()
    const basemap = shareBasemap()
    return activity ? activitySharePreview(activity, getRoute(), sharePreset(), basemap?.preset === sharePreset() ? basemap : null) : ''
  })

  function chooseSharePreset(preset: ActivityShareCardPreset): void {
    sharePreset.set(preset)
    shareMessage.set(null)
  }

  async function downloadShareImage(): Promise<void> {
    const activity = getActivity()
    if (!activity || shareBusy())
      return
    shareBusy.set(true)
    shareMessage.set(null)
    try {
      await downloadActivityShareImage(activity, getRoute(), sharePreset())
      shareMessage.set('Image downloaded. It is ready to post anywhere.')
      await haptics.notification('success')
    }
    catch (error) {
      shareMessage.set(error instanceof Error ? error.message : 'Could not create the activity image')
      await haptics.notification('error')
    }
    finally {
      shareBusy.set(false)
    }
  }

  async function shareImage(): Promise<void> {
    const activity = getActivity()
    if (!activity || shareBusy())
      return
    shareBusy.set(true)
    shareMessage.set(null)
    try {
      const outcome = await shareActivityImage(activity, getRoute(), sharePreset())
      if (outcome === 'shared')
        shareMessage.set('Activity image shared.')
      else if (outcome === 'downloaded')
        shareMessage.set('Sharing is not available here, so the image was downloaded instead.')
      if (outcome !== 'cancelled') await haptics.notification('success')
    }
    catch (error) {
      shareMessage.set(error instanceof Error ? error.message : 'Could not share the activity image')
      await haptics.notification('error')
    }
    finally {
      shareBusy.set(false)
    }
  }

  return {
    chooseSharePreset,
    downloadShareImage,
    shareBusy,
    shareImage,
    shareMessage,
    sharePreset,
    sharePreview,
  }
}
