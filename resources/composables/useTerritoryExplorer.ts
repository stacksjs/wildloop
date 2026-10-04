import { derived, onDestroy, state } from 'stx'
import {
  diffTerritories,
  formatTerritoryArea,
  territoryAppearance,
  type TerritorySnapshot,
} from '../functions/territory-style'
import { loadTerritories, type TerritoryViewport } from './useTerritoryCatalog'
import {
  createTrailMap,
  drawTrailMarker,
  drawTrailRoute,
  drawTerritoryPolygon,
  ensureTsMaps,
  runWhenMapReady,
  trailDifficultyColor,
  type LatLng,
  type TrailMapHandle,
} from './useTrailMap'

interface TerritoryStore {
  currentUserId: () => number
  territories: () => Array<{ id: number, name: string, user_id: number, status: string, areaSize: number, conquestCount: number, defendCount: number }>
  users: () => Array<{ id: number, name: string }>
  territoryPolygons: () => Record<number, LatLng[]>
  trailRoutes: () => Record<number, LatLng[]>
  trails: () => Array<{ id: number, lat: number, lng: number, difficulty: string }>
  hydrateTerritoriesFromApi: (
    territories: unknown[],
    polygons: Record<number, LatLng[]>,
    users: unknown[],
  ) => void
}

export function useTerritoryExplorer(wl: TerritoryStore | null) {
  let territoryMap: TrailMapHandle | null = null
  let viewportTimer: ReturnType<typeof setTimeout> | null = null
  let refreshingViewport = false
  const filter = state<'all' | 'mine' | 'contested'>('all')

  const currentUserId = derived(() => wl?.currentUserId())

  const filtered = derived(() => {
    if (!wl) return []
    const f = filter()
    if (f === 'all') return wl.territories()
    if (f === 'mine') return wl.territories().filter(t => t.user_id === currentUserId())
    return wl.territories().filter(t => t.status === 'contested')
  })

  const leaderboard = derived(() => {
    if (!wl) return []
    return wl.users().map((u) => {
      const owned = wl.territories().filter(t => t.user_id === u.id)
      return {
        user_id: u.id,
        userName: u.name,
        totalTerritoriesOwned: owned.length,
        totalAreaOwned: owned.reduce((sum, t) => sum + t.areaSize, 0),
      }
    }).sort((a, b) => b.totalAreaOwned - a.totalAreaOwned).slice(0, 10)
  })

  const rankedLeaderboard = derived(() =>
    leaderboard().map((entry, index) => ({ ...entry, rank: index + 1 })),
  )

  // `area_size` is square metres, from `calculatePolygonArea`. Dividing by a
  // thousand and calling the result km² overstated every territory by a factor
  // of a thousand — a 1 km² claim read as "1000.0 km²" — and the unit is now
  // chosen for the magnitude, because the game spans four orders of it.
  const formatArea = (area: number): string => formatTerritoryArea(area)

  async function mountTerritoryMap() {
    if (!wl) return
    territoryMap?.destroy()
    // The game map is the page, so it gets the full chrome: a compass that also
    // tilts the view, a scale bar, fullscreen, and a place search — the last two
    // being what turn "here is your ground" into something you can actually go
    // and look around in.
    territoryMap = await createTrailMap('territories-map', {
      scrollWheelZoom: true,
      chrome: 'full',
      search: true,
    })
    if (!territoryMap) return
    const { map } = territoryMap
    const { CircleMarker, LayerGroup } = await ensureTsMaps()
    // Keyed by territory so a pan can update what changed instead of tearing
    // the whole map down. Rebuilding everything on `moveend` destroyed and
    // recreated hundreds of paths to move the map by a block, and took any
    // open popup with them.
    const territoryLayers = new Map<number, any>()
    // Ownership pins, swapped in for the polygons below the zoom at which a
    // claim is bigger than a pixel. Held in one group so the swap is two calls
    // rather than one per territory.
    const territoryPins = new LayerGroup()
    const pinLayers = new Map<number, any>()
    // Trailheads and their routes. Shown only when the map is close enough for
    // a territory to be a shape rather than a pin — see `syncZoomLayers`.
    const trailReference = new LayerGroup()
    const drawn = new Map<number, TerritorySnapshot>()
    // Three candidate framings, most specific first. See the fit below.
    const ownBounds: LatLng[] = []
    const bounds: LatLng[] = []
    const trailBounds: LatLng[] = []
    const uid = currentUserId()

    const ownerName = (ownerId: number): string =>
      wl!.users().find(u => u.id === ownerId)?.name ?? 'Unknown athlete'

    async function addTerritory(t: { id: number, name: string, user_id: number, status: string, areaSize: number }) {
      const coords = wl!.territoryPolygons()[t.id]
      if (!coords)
        return

      const style = territoryAppearance(t.user_id, uid, t.status)
      const popupHtml
        // Colour is identity on this map, so the popup names whose it is and
        // what it is worth rather than leaving the player to decode a hue.
        = `<strong>${t.name}</strong><br>${ownerName(t.user_id)} · ${formatTerritoryArea(t.areaSize)}`
      const polygon = await drawTerritoryPolygon(map, coords, { ...style, popupHtml })
      if (!polygon)
        return

      const zoomTo = () => map.flyToBounds(polygon.getBounds(), { padding: [40, 40] })
      polygon.on('click', zoomTo)
      territoryLayers.set(t.id, polygon)

      /*
       * A pin standing in for the polygon while the polygon is too small to
       * see.
       *
       * A claim is a few hundred metres across. Anywhere above about zoom 13
       * that is a shape; below it, it is less than a pixel — which is why this
       * screen used to open on a map whose only visible marks were trailheads,
       * coloured by difficulty, on a page whose legend says green means yours.
       * The pin carries the ownership colour so the overview answers the
       * question the page is named after.
       */
      const centre = polygon.getBounds().getCenter()
      const pin = new CircleMarker([centre.lat, centre.lng], {
        radius: t.user_id === uid ? 7 : 5.5,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillColor: style.color,
        fillOpacity: 1,
        className: 'wl-map-pin',
      })
      pin.bindPopup(popupHtml)
      pin.on('click', zoomTo)
      territoryPins.addLayer(pin)
      pinLayers.set(t.id, pin)
    }

    function removeTerritory(id: number) {
      const pin = pinLayers.get(id)
      if (pin) {
        territoryPins.removeLayer(pin)
        pinLayers.delete(id)
      }
      const layer = territoryLayers.get(id)
      if (!layer)
        return
      map.removeLayer(layer)
      territoryLayers.delete(id)
    }

    async function drawTerritories(shouldFit: boolean) {
      const polygons = wl!.territoryPolygons()
      const territories = wl!.territories()

      const snapshots: TerritorySnapshot[] = territories
        .filter(t => polygons[t.id])
        .map(t => ({
          id: t.id,
          userId: t.user_id,
          status: t.status,
          shapeVersion: String(polygons[t.id]!.length),
        }))

      const { added, changed, removed } = diffTerritories(drawn, snapshots)

      for (const id of removed)
        removeTerritory(id)

      // A changed territory is redrawn, because ownership and shape are what
      // its appearance is derived from.
      for (const snapshot of [...added, ...changed]) {
        removeTerritory(snapshot.id)
        const territory = territories.find(t => t.id === snapshot.id)
        if (territory)
          await addTerritory(territory)
      }

      drawn.clear()
      for (const snapshot of snapshots)
        drawn.set(snapshot.id, snapshot)

      if (shouldFit) {
        for (const snapshot of snapshots) {
          const ring = polygons[snapshot.id]!
          bounds.push(...ring)
          if (snapshot.userId === uid)
            ownBounds.push(...ring)
        }
      }
    }

    // The store starts with no territories, and the app-wide load may not have
    // answered yet; drawing before it did left the map empty until a pan.
    if (!wl.territories().length)
      await loadTerritories(wl)
    await drawTerritories(true)

    const routes = wl.trailRoutes()
    for (const tr of wl.trails()) {
      if (!tr.lat || !tr.lng) continue
      const fill = trailDifficultyColor(tr.difficulty)
      const coords = routes[tr.id]
      if (coords && coords.length > 1)
        await drawTrailRoute(trailReference, coords, { color: fill, weight: 3, opacity: 0.75 })
      await drawTrailMarker(trailReference, tr.lat, tr.lng, {
        difficulty: tr.difficulty,
        radius: 6,
        onClick: () => {
          if (coords && coords.length > 1)
            territoryMap!.fitPoints(coords, [40, 40])
          else
            map.flyTo([tr.lat, tr.lng], 14)
        },
      })
      trailBounds.push([tr.lat, tr.lng])
    }

    /*
     * Open on the player's own ground.
     *
     * The trailheads span four time zones, so framing everything on the map put
     * this screen at continental zoom — where a territory a few hundred metres
     * across is a dot, and "your territory map" showed the player none of their
     * own. Their holdings come first, every territory in view second, and the
     * trail network only if the game has not started yet.
     */
    const frame = ownBounds.length ? ownBounds : bounds.length ? bounds : trailBounds
    if (frame.length)
      territoryMap.fitPoints(frame, [40, 40])

    /*
     * One threshold, two complementary layers.
     *
     * Zoomed out, the question is who owns what, and the answer is a field of
     * ownership pins. Zoomed in, the polygons say it better than a pin can, and
     * the useful extra is where the trails run. Showing both at once was the
     * problem this replaces: a trailhead dot coloured by difficulty and a
     * territory dot coloured by owner are the same mark in the same place
     * meaning two different things, and green meant "easy" on the screen whose
     * legend says green means yours.
     */
    const PIN_MAX_ZOOM = 13
    function syncZoomLayers() {
      const wide = map.getZoom() < PIN_MAX_ZOOM
      if (wide && !map.hasLayer(territoryPins))
        map.addLayer(territoryPins)
      if (!wide && map.hasLayer(territoryPins))
        map.removeLayer(territoryPins)
      if (!wide && !map.hasLayer(trailReference))
        map.addLayer(trailReference)
      if (wide && map.hasLayer(trailReference))
        map.removeLayer(trailReference)
    }
    syncZoomLayers()
    map.on('zoomend', syncZoomLayers)

    // Query only what the athlete can currently see. The backend applies the
    // indexed bounding-box predicate before LIMIT, so dense cities no longer
    // crowd unrelated regions out of the response.
    map.on('moveend', () => {
      if (viewportTimer)
        clearTimeout(viewportTimer)
      viewportTimer = setTimeout(async () => {
        if (refreshingViewport || !territoryMap)
          return
        const visible: any = territoryMap.map.getBounds()
        const viewport: TerritoryViewport = {
          minLat: visible.getSouth(),
          minLng: visible.getWest(),
          maxLat: visible.getNorth(),
          maxLng: visible.getEast(),
        }
        refreshingViewport = true
        try {
          if (await loadTerritories(wl, viewport))
            await drawTerritories(false)
        }
        finally {
          refreshingViewport = false
        }
      }, 250)
    })
  }

  onDestroy(() => {
    if (viewportTimer)
      clearTimeout(viewportTimer)
    territoryMap?.destroy()
    territoryMap = null
  })

  return {
    filter,
    currentUserId,
    filtered,
    rankedLeaderboard,
    formatArea,
    mountTerritoryMap: () => runWhenMapReady('territories-map', mountTerritoryMap),
  }
}
