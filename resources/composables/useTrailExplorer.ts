import { useFullscreen } from '@stacksjs/composables'
import { onUnmounted, state } from 'stx'
import { apiFetch } from '../assets/scripts/auth'
import { qrSvgMarkup } from '../functions/qr'
import { trailGpx } from '../functions/trail-map'
import { trailProfilePath, trailProfileRange, type TrailProfilePoint as ProfilePoint } from '../functions/trail-profile'
import type { LatLng, TrailMapHandle } from './useTrailMap'

export function useTrailExplorer(handle: () => TrailMapHandle | null, route: () => LatLng[][], trail: () => { id: number, name: string } | null) {
  const mapMode = state<'outdoors' | 'topographic' | 'satellite' | 'street'>('outdoors')
  const layersOpen = state(false)
  const map3D = state(false)
  const reliefVisible = state(true)
  const mapMessage = state('')
  const phoneOpen = state(false)
  const { isFullscreen, isSupported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen(() => document.getElementById('trail-map-explorer'))
  const profileStatus = state<'loading' | 'ready' | 'unavailable'>('loading')
  const profile = state<ProfilePoint[]>([])
  const activePoint = state<ProfilePoint | null>(null)
  let controller: AbortController | null = null
  let profileTrail = 0

  function chooseMapMode(mode: 'outdoors' | 'topographic' | 'satellite' | 'street') {
    mapMode.set(mode)
    handle()?.setBasemap(mode)
    reliefVisible.set(mode === 'outdoors')
    handle()?.setRelief(reliefVisible())
  }

  function toggle3D() {
    map3D.set(!map3D())
    handle()?.set3D(map3D())
  }

  function toggleRelief() {
    reliefVisible.set(!reliefVisible())
    handle()?.setRelief(reliefVisible())
  }

  function fitRoute() {
    const points = route().flat()
    if (points.length < 2) {
      mapMessage.set('This trail has no recorded route to fit. The map shows its trailhead.')
      return
    }
    activePoint.set(null)
    handle()?.fitPoints(points, [48, 48])
  }

  async function fullscreenMap() {
    if (!fullscreenSupported.value) {
      mapMessage.set('Full screen is unavailable in this browser.')
      return
    }
    const wasFullscreen = isFullscreen.value
    await toggleFullscreen()
    if (isFullscreen.value === wasFullscreen)
      mapMessage.set('Full screen could not be changed. Try again from the map button.')
  }

  function downloadGpx() {
    const current = trail()
    if (!current || !route().some(part => part.length > 1)) {
      mapMessage.set('This trail has no recorded route to download.')
      return
    }
    const url = URL.createObjectURL(new Blob([trailGpx(current.name, route())], { type: 'application/gpx+xml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${current.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.gpx`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function printMap() {
    window.print()
  }

  function phoneCode(): string {
    const current = trail()
    return current ? qrSvgMarkup(`https://wildloop.org/trail/${current.id}`, { title: 'Scan to open this trail on your phone', class: 'h-40 w-40 sm:h-52 sm:w-52' }) : ''
  }

  async function loadProfile(id: number) {
    if (profileTrail === id)
      return
    profileTrail = id
    controller?.abort()
    const request = new AbortController()
    controller = request
    profile.set([])
    activePoint.set(null)
    profileStatus.set('loading')
    try {
      const response = await apiFetch(`/api/trails/${id}/profile`, { signal: request.signal })
      const body = response.ok ? await response.json() : null
      if (request.signal.aborted)
        return
      if (!body?.success || !Array.isArray(body.points) || !body.points.some((p: ProfilePoint) => Number.isFinite(p.ft))) {
        profileStatus.set('unavailable')
        return
      }
      profile.set(body.points)
      profileStatus.set('ready')
    }
    catch {
      if (!request.signal.aborted)
        profileStatus.set('unavailable')
    }
  }

  function profileRange() {
    return trailProfileRange(profile())
  }

  function profilePath(): string {
    return trailProfilePath(profile())
  }

  function inspectProfile(event: Event) {
    const index = Number((event.target as HTMLInputElement).value)
    const point = profile()[index]
    if (!point)
      return
    activePoint.set(point)
    handle()?.map.panTo([point.lat, point.lng])
  }

  onUnmounted(() => controller?.abort())
  return { isFullscreen, mapMode, layersOpen, map3D, reliefVisible, mapMessage, phoneOpen, profileStatus, profile, activePoint, chooseMapMode, toggle3D, toggleRelief, fitRoute, fullscreenMap, downloadGpx, printMap, phoneCode, loadProfile, profileRange, profilePath, inspectProfile }
}
