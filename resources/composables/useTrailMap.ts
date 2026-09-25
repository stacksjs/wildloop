import type { CircleMarker as CircleMarkerType } from 'ts-maps'
import type { Polygon as PolygonType } from 'ts-maps'
import type { Polyline as PolylineType } from 'ts-maps'
import type { RunTrailLayer as RunTrailLayerType } from 'ts-maps'
import type { TsMap as TsMapType } from 'ts-maps'
import type { Style as StyleSpec } from 'ts-maps/style-spec'

export type LatLng = [number, number]

type TsMapsModule = typeof import('ts-maps')

/**
 * The basemap is a vector style, not a sheet of pictures.
 *
 * That is the whole difference between this looking like a map app and looking
 * like OpenStreetMap in an iframe. Vector tiles carry the geometry rather than
 * a rendering of it, so labels stay upright and crisp at any fractional zoom,
 * the palette is ours, and — the part that matters for a trail app — we can
 * pull footpaths out of the road network and draw them as their own class.
 *
 * On top of the built-in `styles.light` / `styles.dark` skeletons this app lifts
 * trails, tracks and footways out of `road-minor` — where OpenMapTiles leaves
 * them — and draws them dashed and in the brand green, then multiplies shaded
 * relief over the whole thing so a ridge reads as a ridge.
 *
 * `RASTER_FALLBACK` is the same style skeleton over pre-rendered images, used
 * when the vector service cannot be reached — an offline WebView, a locked-down
 * network. It looks worse, and it is still a map.
 */
const VECTOR_TILEJSON = 'https://tiles.openfreemap.org/planet'

const RASTER_FALLBACK = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
} as const

/**
 * Shaded relief, pre-rendered by Esri and served keyless.
 *
 * The obvious alternative is to shade a DEM in the browser — ts-maps has a
 * `hillshade` layer that does exactly that, over the terrarium elevation tiles
 * AWS publishes. It is rejected here for one practical reason: that bucket
 * drops requests when a viewport asks for eight tiles at once, and every drop
 * is a rectangle with no relief in it. A viewport that renders correctly on the
 * third reload is not a basemap.
 *
 * Pre-rendered relief costs nothing to decode, arrives as one reliable image
 * per tile, and — the deciding factor — is drawn by cartographers rather than
 * by a Lambertian one-liner. Note `{z}/{y}/{x}`: Esri's REST tiles put row
 * before column.
 */
const TERRAIN_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'
const TERRAIN_MAX_NATIVE_ZOOM = 16

/**
 * Relief starts here and not before.
 *
 * Esri's plate is an opaque grey-on-white sheet, and it is composited over the
 * basemap rather than multiplied into it — `mix-blend-mode: multiply` computes
 * on the layer but does not survive to the rendered output, so the honest way
 * to treat this layer is as ink laid on top at low opacity. Which it is: set
 * the blend to `normal` and the result is pixel-identical.
 *
 * That is fine where the shading carries information and terrible where it does
 * not. At continental zoom the sheet is near-white over the whole map and all
 * it does is wash the palette grey; from about a county's width down, it is the
 * shape of the ground the trail runs over. So it is drawn from there.
 */
const TERRAIN_MIN_ZOOM = 9

const VECTOR_ATTRIBUTION = '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
const RASTER_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
const TERRAIN_ATTRIBUTION = 'Terrain: Esri'

const MAX_ZOOM = 20

/**
 * How hard the relief bites, per theme.
 *
 * Esri's plate is opaque grey on white and lands on top rather than into the
 * map (see `TERRAIN_MIN_ZOOM`), so these are the opacities at which it reads as
 * terrain instead of as a veil. Both are lower than they want to be, because
 * relief is the one layer that will happily eat the whole design: at full
 * strength a mountain valley goes uniformly grey and every colour underneath —
 * the parks, the water, the territory fills — turns to mud. It is background,
 * and has to lose to the data drawn on top of it.
 *
 * Dark takes less again: a pale sheet over near-black ground lifts it much
 * further than the same sheet over paper.
 */
function reliefOpacity(theme: BasemapTheme): number {
  return theme === 'dark' ? 0.35 : 0.5
}

/** The green a route is drawn in, and the green a mapped trail is drawn in. */
const ROUTE_GREEN = '#059669'

type BasemapTheme = 'light' | 'dark'

function currentTheme(): BasemapTheme {
  if (typeof document === 'undefined')
    return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

let mapsModule: TsMapsModule | null = null
let mapsLoad: Promise<TsMapsModule> | null = null

const TS_MAPS_JS = '/js/ts-maps.mjs'
const TS_MAPS_CSS = '/css/ts-maps.css'

function ensureTsMapsCss() {
  if (typeof document === 'undefined')
    return
  if (document.querySelector('link[data-ts-maps-css]'))
    return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = TS_MAPS_CSS
  link.dataset.tsMapsCss = '1'
  document.head.appendChild(link)
}

/** Lazy-load ts-maps from a separate public chunk (keeps STX page scripts small). */
export async function ensureTsMaps(): Promise<TsMapsModule> {
  if (mapsModule)
    return mapsModule
  if (!mapsLoad) {
    mapsLoad = (async () => {
      ensureTsMapsCss()
      mapsModule = await import(/* @vite-ignore */ TS_MAPS_JS) as TsMapsModule
      return mapsModule
    })()
  }
  return mapsLoad
}

/**
 * OpenFreeMap publishes its current tile URL through a TileJSON, and the path
 * carries a dated version that changes when the planet is rebuilt. Reading it
 * once per session means a rebuild on their side does not blank every map here.
 *
 * The answer is cached in `sessionStorage` so only the first page load of a
 * session pays for it, and the lookup is raced against a timeout: a hanging
 * request must fall through to raster rather than leave the map empty.
 */
const TILE_URL_CACHE_KEY = 'wildloop:vector-tiles'
let tileUrlPromise: Promise<string | null> | null = null

export async function resolveVectorTiles(): Promise<string | null> {
  if (typeof fetch !== 'function')
    return null

  if (!tileUrlPromise) {
    tileUrlPromise = (async () => {
      try {
        const cached = sessionStorage?.getItem(TILE_URL_CACHE_KEY)
        if (cached)
          return cached
      }
      catch { /* private mode; just fetch */ }

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 6000)
        const response = await fetch(VECTOR_TILEJSON, { signal: controller.signal })
        clearTimeout(timer)
        if (!response.ok)
          throw new Error(`HTTP ${response.status}`)
        const tilejson = await response.json() as { tiles?: string[] }
        const url = tilejson?.tiles?.[0] ?? null
        if (url) {
          try { sessionStorage?.setItem(TILE_URL_CACHE_KEY, url) }
          catch { /* not fatal */ }
        }
        return url
      }
      catch {
        // Every caller falls back to raster. Not worth a console error on a
        // page whose map still works.
        return null
      }
    })()
  }
  return tileUrlPromise
}

/**
 * Wildloop's palette, applied to the map.
 *
 * ts-maps ships a good general-purpose pair of basemaps, and they are the wrong
 * pair for this app: the light one is warm paper-and-beige and the dark one is
 * a neutral charcoal, while every other surface here is cool slate with a
 * single emerald accent. A map that does not share the product's neutrals reads
 * as an embed from somewhere else, which on a screen that is mostly map is most
 * of the screen.
 *
 * So the greys are slate, the same ramp the rest of the UI is built from, and
 * parks carry the accent's hue rather than olive — the one place a basemap can
 * say "this is a trail app" without saying anything.
 *
 * Dark sits a step below the page (`#0f172a`) rather than matching it, so the
 * map reads as inset into the card instead of dissolving through it.
 */
const PALETTE = {
  light: {
    background: '#e8eef3',
    land: '#f4f7fa',
    green: '#dbeee3',
    water: '#bcd7ea',
    roadMajor: '#ffffff',
    roadMinor: '#ffffff',
    roadCasing: '#d8e1ea',
    buildings: '#e4ebf2',
    boundary: '#c3cede',
    label: '#334155',
    labelHalo: '#ffffff',
    labelMuted: '#64748b',
  },
  dark: {
    background: '#0b1220',
    land: '#111a2b',
    green: '#102a20',
    water: '#0b1a2b',
    roadMajor: '#3d4c63',
    roadMinor: '#222d40',
    roadCasing: '#080e18',
    buildings: '#182338',
    boundary: '#2b3950',
    label: '#cbd5e1',
    labelHalo: '#0b1220',
    labelMuted: '#8fa0b6',
  },
} as const

/**
 * The app's own type on the map.
 *
 * `text-font` resolves to a CSS family stack, and Geist is already loaded for
 * the rest of the page, so place names cost nothing extra and stop looking like
 * a different product's map. The weight rides in the name — the style spec
 * carries it there rather than as a separate property.
 */
const LABEL_FONT = ['Geist Medium'] as const
const PLACE_FONT = ['Geist Semibold'] as const

/** Insert `layers` directly before the layer with id `beforeId`, or append. */
function insertBefore(spec: StyleSpec, beforeId: string, layers: StyleSpec['layers']) {
  const at = spec.layers.findIndex(layer => layer.id === beforeId)
  spec.layers.splice(at < 0 ? spec.layers.length : at, 0, ...layers)
}

const TRAIL_CLASSES = ['path', 'track', 'bridleway'] as const

function buildStyle(
  maps: TsMapsModule,
  theme: BasemapTheme,
  tiles: string | null,
): StyleSpec {
  const build = theme === 'dark' ? maps.styles.dark : maps.styles.light

  if (!tiles) {
    return build({
      tiles: RASTER_FALLBACK[theme],
      mode: 'raster',
      attribution: RASTER_ATTRIBUTION,
      maxzoom: MAX_ZOOM,
      palette: { ...PALETTE[theme] },
    })
  }

  const spec = build({
    tiles,
    attribution: VECTOR_ATTRIBUTION,
    palette: { ...PALETTE[theme] },
  }) as StyleSpec

  // Labels in the app's own face rather than the atlas's system default.
  for (const layer of spec.layers) {
    if (layer.type !== 'symbol')
      continue
    const layout = (layer.layout ??= {}) as { 'text-font'?: readonly string[] }
    layout['text-font'] = layer.id === 'place-label' ? PLACE_FONT : LABEL_FONT
  }

  // Read tiles back out of the shared cache that "download for offline" fills.
  // Without this a style's source never touches the cache, and the download
  // would be fetching tiles the basemap never asks for.
  const basemap = spec.sources.basemap
  if (basemap)
    (basemap as { offlineCache?: boolean }).offlineCache = true

  // OpenMapTiles files footpaths under `transportation` with everything else
  // that is not a motorway, so the stock style paints them as minor roads.
  // On a trail app that is backwards: the trail is the subject.
  const minor = spec.layers.find(layer => layer.id === 'road-minor') as
    | { filter?: unknown }
    | undefined
  if (minor) {
    minor.filter = [
      'all',
      ['!', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]],
      ['!', ['in', ['get', 'class'], ['literal', [...TRAIL_CLASSES]]]],
    ]
  }

  insertBefore(spec, 'building', [
    {
      id: 'trail-casing',
      type: 'line',
      'source-layer': 'transportation',
      source: 'basemap',
      minzoom: 12,
      filter: ['in', ['get', 'class'], ['literal', [...TRAIL_CLASSES]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': theme === 'dark' ? '#081018' : '#ffffff',
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 2, 16, 6, 20, 14],
        'line-opacity': 0.7,
      },
    },
    {
      id: 'trail',
      type: 'line',
      'source-layer': 'transportation',
      source: 'basemap',
      minzoom: 12,
      filter: ['in', ['get', 'class'], ['literal', [...TRAIL_CLASSES]]],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        // `--accent-bright` and `--accent`: the same two greens the buttons and
        // the route lines use, so a mapped trail and a run read as one family.
        'line-color': theme === 'dark' ? '#34d399' : '#059669',
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.9, 16, 2.2, 20, 5],
        // Dashes are how a paper map says "unpaved". They also keep the
        // trail legible where it runs alongside a road of the same width.
        'line-dasharray': [2.5, 2],
      },
    },
  ] as StyleSpec['layers'])
  return spec
}

export interface TrailMapHandle {
  map: TsMapType
  destroy: () => void
  /** Frame these points. Deferred if the container has not been laid out yet. */
  fitPoints: (points: LatLng[], padding?: [number, number]) => void
}

interface TrailMapElement extends HTMLElement {
  _tsMap?: TsMapType
  _tsMapHandle?: TrailMapHandle
}

export function trailDifficultyColor(difficulty: string): string {
  if (difficulty === 'hard') return '#dc2626'
  if (difficulty === 'moderate') return '#f59e0b'
  return '#10b981'
}

function resolveElement(container: HTMLElement | string): HTMLElement | null {
  if (typeof container === 'string')
    return document.getElementById(container)
  return container
}

export interface TrailMapOptions {
  center?: LatLng
  zoom?: number
  minZoom?: number
  maxZoom?: number
  scrollWheelZoom?: boolean
  /**
   * Share gestures with the page. On by default, because every map here sits
   * in a page that scrolls: a plain wheel or a one-finger swipe scrolls past
   * the map instead of being swallowed by it, and ⌘/Ctrl + scroll, a trackpad
   * pinch or two fingers move the map — with a hint saying so, the way a
   * Google Maps embed behaves. Fullscreen hands gestures back to the map.
   */
  cooperativeGestures?: boolean
  /**
   * How much map chrome to put on screen.
   *
   * `'full'` — navigation (zoom, compass, pitch), scale, locate, fullscreen.
   *   For a map that is the page.
   * `'compact'` — zoom and locate only. For a map beside other content.
   * `'none'` — attribution and nothing else. For thumbnails and previews,
   *   where a control stack would cover most of the map.
   */
  chrome?: 'full' | 'compact' | 'none'
  /** A keyless place-search box in the corner. */
  search?: boolean
  /** Shaded relief. On by default; off for small previews, where it is noise. */
  terrain?: boolean
}

export async function createTrailMap(
  container: HTMLElement | string,
  options?: TrailMapOptions,
): Promise<TrailMapHandle | null> {
  try {
    const maps = await ensureTsMaps()
    const { TsMap, Polyline, LocateControl, NavigationControl, ScaleControl, FullscreenControl, GeocoderControl } = maps
    // Loading the map chunk yields to STX hydration. Resolve the target after
    // that await so a structural render cannot leave us mounting into a
    // detached copy of the original container.
    const el = resolveElement(container)
    if (!el?.isConnected)
      return null
    const mapElement = el as TrailMapElement
    if (mapElement._tsMapHandle)
      return mapElement._tsMapHandle
    const prev = mapElement._tsMap
    if (prev) {
      try { prev.remove() }
      catch { /* noop */ }
    }
    el.innerHTML = ''

    const chrome = options?.chrome ?? 'compact'
    let theme = currentTheme()

    const map = new TsMap(el, {
      center: options?.center ?? [39.5, -98.35],
      zoom: options?.zoom ?? 4,
      minZoom: options?.minZoom ?? 2,
      maxZoom: options?.maxZoom ?? MAX_ZOOM,
      scrollWheelZoom: options?.scrollWheelZoom ?? true,
      cooperativeGestures: options?.cooperativeGestures ?? true,
      // The chrome the app adds below is the chrome it wants; the built-in
      // zoom box would be a second, differently-styled one.
      zoomControl: false,
      theme,
    })
    mapElement._tsMap = map

    if (chrome === 'full') {
      // `addTo`, not `map.addControl`: the latter is mixed onto TsMap at
      // runtime and is not on its type, while every Control carries addTo.
      new NavigationControl({ position: 'topright', visualizePitch: true }).addTo(map)
      new FullscreenControl({ position: 'topright' }).addTo(map)
      new ScaleControl({ position: 'bottomleft', imperial: true, metric: false }).addTo(map)
    }
    else if (chrome === 'compact') {
      new NavigationControl({ position: 'topleft', showCompass: false }).addTo(map)
    }

    // "Where am I". Geolocation is requested on press, never on load — a
    // permission prompt nobody asked for is the fastest way to be denied for
    // the rest of the session, and a denial cannot be re-requested without the
    // user digging through browser settings.
    if (chrome !== 'none')
      new LocateControl({ position: chrome === 'full' ? 'topright' : 'topleft', zoom: 14 }).addTo(map)

    // Place search from this server's gazetteer (/api/geo). The control's
    // default is the public Nominatim service, whose usage policy forbids
    // exactly this — a request per keystroke — and which sees what people
    // type.
    if (options?.search) {
      new GeocoderControl({
        position: 'topleft',
        collapsed: true,
        marker: false,
        minLength: 2,
        provider: new maps.services.GazetteerGeocoder({ baseUrl: '/api/geo' }),
      }).addTo(map)
    }

    /*
     * Relief goes over the basemap, not into its style.
     *
     * A vector source draws every one of its style layers into one canvas per
     * tile, so a `hillshade` layer sequenced among them can only land wholly
     * above or wholly below that canvas — and below it, the opaque land-cover
     * fills hide it completely. Over the top, multiplied, it darkens the slopes
     * beneath instead of covering them, which is the same thing a printed topo
     * map does with its grey plate. The blend mode lives in CSS
     * (`.wl-map-relief`) because it is the one part that differs between light
     * and dark, and the shading itself is theme-neutral: white highlights,
     * grey shadows.
     */
    let relief: ReturnType<TsMapsModule['tileLayer']> | null = null
    if (options?.terrain !== false && chrome !== 'none') {
      relief = maps.tileLayer(TERRAIN_TILES, {
        attribution: TERRAIN_ATTRIBUTION,
        crossOrigin: true,
        minZoom: TERRAIN_MIN_ZOOM,
        maxNativeZoom: TERRAIN_MAX_NATIVE_ZOOM,
        maxZoom: MAX_ZOOM,
        // Strength, not the blend. A tile layer writes `opacity` inline on its
        // own container, so a stylesheet rule for it could never win — which is
        // why this is an option here and only the blend mode lives in CSS.
        opacity: reliefOpacity(theme),
        className: 'wl-map-relief',
        // Above the basemap, below anything drawn on the overlay pane — a
        // route line is data and must not be shaded like ground.
        zIndex: 5,
      })
      relief.addTo(map)
    }

    // No style is painted until the tile URL resolves — which, after the first
    // page of a session, is a cached value one microtask away. Painting the
    // raster fallback first would download a screenful of images only to throw
    // them away a moment later, and the swap reads as a flicker. The container
    // carries the palette's ground colour in CSS, so the wait looks like a map
    // loading rather than a hole in the page.
    //
    // `url` is null when the vector service could not be reached; `buildStyle`
    // turns that into the raster fallback.
    let tiles: string | null = null
    void resolveVectorTiles().then((url) => {
      // The map this closure was opened for may have been destroyed and
      // replaced while the lookup was in flight. Styling a removed map throws
      // from deep inside the renderer, on a pane that no longer exists.
      if (mapElement._tsMap !== map)
        return
      tiles = url
      map.setStyle(buildStyle(maps, currentTheme(), url))
    })

    // Follow the app's dark-mode toggle. Repainting the style re-requests tiles
    // in place, which is far cheaper than tearing the map down and rebuilding
    // every route, marker and territory drawn on it.
    let themeWatcher: MutationObserver | null = null
    if (typeof MutationObserver !== 'undefined') {
      themeWatcher = new MutationObserver(() => {
        const next = currentTheme()
        if (next === theme || mapElement._tsMap !== map)
          return
        theme = next
        map.setStyle(buildStyle(maps, next, tiles))
        map.setTheme(next)
        relief?.setOpacity(reliefOpacity(next))
      })
      themeWatcher.observe(document.documentElement, { attributeFilter: ['class'] })
    }

    /*
     * A map sized before its container has been laid out is a map that thinks
     * it is 0×0, and `fitBounds` on a 0×0 viewport returns maxZoom — which is
     * how a map of twelve national parks ends up at zoom 20 over a field in
     * Nebraska, showing nothing.
     *
     * So the last fit is remembered rather than applied and forgotten: when the
     * container's size changes — layout settling, a panel opening, the window
     * resizing, going fullscreen — the map is re-measured and the fit is
     * redone against the size it actually has.
     *
     * Only while the fit is still what is on screen, though. The camera each
     * fit produced is recorded, and a resize re-fits only if the map has not
     * moved since — otherwise resizing the window would throw away whatever
     * the player had panned to and snap them back to the opening view.
     */
    let lastFit: { points: LatLng[], padding: [number, number] } | null = null
    let fitCamera: { center: { lat: number, lng: number }, zoom: number } | null = null

    function applyFit() {
      if (!lastFit)
        return
      const size = map.getSize()
      if (size.x < 2 || size.y < 2)
        return
      const { points, padding } = lastFit
      if (points.length === 1) {
        map.setView(points[0], Math.max(options?.zoom ?? 14, 14))
      }
      else {
        const guide = new Polyline(points, { weight: 0, opacity: 0 }).addTo(map)
        map.fitBounds(guide.getBounds(), { padding })
        map.removeLayer(guide)
      }
      const centre = map.getCenter()
      fitCamera = { center: { lat: centre.lat, lng: centre.lng }, zoom: map.getZoom() }
    }

    /** Has the map moved since the last fit put it somewhere? */
    function showingTheFit(): boolean {
      if (!fitCamera)
        return true
      const centre = map.getCenter()
      return Math.abs(centre.lat - fitCamera.center.lat) < 1e-9
        && Math.abs(centre.lng - fitCamera.center.lng) < 1e-9
        && Math.abs(map.getZoom() - fitCamera.zoom) < 1e-9
    }

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      let width = el.clientWidth
      let height = el.clientHeight
      resizeObserver = new ResizeObserver(() => {
        if (el.clientWidth === width && el.clientHeight === height)
          return
        width = el.clientWidth
        height = el.clientHeight
        // Measured before the resize, because `invalidateSize` keeps the centre
        // and would compare equal either way.
        const refit = showingTheFit()
        map.invalidateSize({ animate: false })
        if (refit)
          applyFit()
      })
      resizeObserver.observe(el)
    }

    const handle: TrailMapHandle = {
      map,
      destroy() {
        themeWatcher?.disconnect()
        themeWatcher = null
        resizeObserver?.disconnect()
        resizeObserver = null
        try { map.remove() }
        catch { /* noop */ }
        if (mapElement._tsMap === map) {
          mapElement._tsMap = undefined
          mapElement._tsMapHandle = undefined
        }
      },
      fitPoints(points, padding = [32, 32]) {
        const usable = points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        if (usable.length < 1)
          return
        lastFit = { points: usable, padding }
        applyFit()
      },
    }
    mapElement._tsMapHandle = handle
    return handle
  }
  catch (err) {
    console.error('[trail-map] init failed:', err)
    return null
  }
}

/** Wait for map container in DOM, then mount. Call from the page's onMount (WebView-safe). */
export function runWhenMapReady(
  containerId: string,
  mount: () => void | Promise<void>,
  options?: { delayMs?: number, maxAttempts?: number },
): () => void {
  let attempts = 0
  const max = options?.maxAttempts ?? 24
  const delay = options?.delayMs ?? 150
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  function tryMount() {
    if (cancelled)
      return
    const el = document.getElementById(containerId)
    if (!el) {
      if (++attempts < max)
        timer = setTimeout(tryMount, delay)
      return
    }
    if (el.offsetHeight < 2 && ++attempts < max) {
      timer = setTimeout(tryMount, delay)
      return
    }
    void Promise.resolve(mount()).catch(err => console.error('[trail-map] mount failed:', err))
  }

  timer = setTimeout(tryMount, delay)

  return () => {
    cancelled = true
    if (timer)
      clearTimeout(timer)
  }
}

/**
 * Where a drawn feature is added.
 *
 * Anything with `addLayer` will do — the map itself, or a `LayerGroup` a screen
 * uses to show and hide a whole class of feature at once (see the territory
 * map, which swaps trail references in and out by zoom).
 */
export interface LayerTarget {
  addLayer: (layer: unknown) => unknown
}

/**
 * Draw a trail's route: one line, or several parts of one trail.
 *
 * Parts are drawn as separate lines, never joined. A trail stored in several
 * pieces (see functions/trail-geometry) has real gaps between them, and a
 * single polyline through all of them drew a straight line across roads and
 * back gardens as if it were the trail. The returned line is the main (first)
 * part's, for callers that fit or style it.
 */
export async function drawTrailRoute(
  target: LayerTarget,
  coords: LatLng[] | LatLng[][],
  options?: { color?: string, weight?: number, opacity?: number, casing?: boolean },
): Promise<PolylineType | null> {
  const parts = (isRouteParts(coords) ? coords : [coords]).filter(part => part.length >= 2)
  if (parts.length === 0)
    return null
  const { Polyline } = await ensureTsMaps()
  const weight = options?.weight ?? 5

  // A single flat stroke disappears against a green hillside or a grey road.
  // Every map app draws the route twice — a dark casing, then the colour on
  // top — which is what gives the line an edge at any zoom. All casings go
  // under all colours, so where parts meet one never cuts across another.
  if (options?.casing !== false) {
    for (const part of parts) {
      target.addLayer(new Polyline(part, {
        color: '#0b1b15',
        weight: weight + 3.5,
        opacity: 0.35,
        lineCap: 'round',
        lineJoin: 'round',
      }))
    }
  }

  let main: PolylineType | null = null
  for (const part of parts) {
    const line = new Polyline(part, {
      color: options?.color ?? ROUTE_GREEN,
      weight,
      opacity: options?.opacity ?? 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    })
    target.addLayer(line)
    main ??= line
  }
  return main
}

/** `[[lat,lng],…]` parts rather than one `[lat,lng]` line. */
function isRouteParts(coords: LatLng[] | LatLng[][]): coords is LatLng[][] {
  return coords.length > 0 && Array.isArray(coords[0]?.[0])
}

export async function drawTerritoryPolygon(
  map: TsMapType,
  coords: LatLng[],
  options: {
    color: string
    fillOpacity: number
    weight?: number
    dashArray?: string
    popupHtml?: string
    onClick?: () => void
  },
): Promise<PolygonType | null> {
  // A polygon needs three points to be a shape. Handed fewer — a territory
  // whose ring failed to load, or one the API returned without geometry —
  // ts-maps dereferences an element it never created and throws
  // `Cannot read properties of undefined (reading 'appendChild')`, which takes
  // down the whole map rather than skipping the one bad record.
  if (!Array.isArray(coords) || coords.length < 3)
    return null

  const { Polygon } = await ensureTsMaps()
  const layer = new Polygon(coords, {
    color: options.color,
    fillColor: options.color,
    fillOpacity: options.fillOpacity,
    weight: options.weight ?? 2,
    dashArray: options.dashArray,
  }).addTo(map)
  if (options.popupHtml)
    layer.bindPopup(options.popupHtml)
  if (options.onClick)
    layer.on('click', options.onClick)
  return layer
}

export async function drawTrailMarker(
  target: LayerTarget,
  lat: number,
  lng: number,
  options: {
    difficulty: string
    popupHtml?: string
    radius?: number
    onClick?: () => void
  },
): Promise<CircleMarkerType> {
  const { CircleMarker } = await ensureTsMaps()
  const fill = trailDifficultyColor(options.difficulty)
  const marker = new CircleMarker([lat, lng], {
    radius: options.radius ?? 7,
    color: '#ffffff',
    weight: 2.5,
    opacity: 1,
    fillColor: fill,
    fillOpacity: 1,
    className: 'wl-map-pin',
  })
  target.addLayer(marker)
  if (options.popupHtml)
    marker.bindPopup(options.popupHtml)
  if (options.onClick)
    marker.on('click', options.onClick)
  return marker
}

/**
 * The line behind a runner, mid-run.
 *
 * `setLatLngs` / `addLatLng` keep the shape of the `Polyline` this replaced, so
 * a caller feeding GPS samples in does not have to care which layer is under
 * it — including `map.removeLayer(line)`, since the adapter *is* the layer.
 */
export type LiveRouteLine = RunTrailLayerType & {
  setLatLngs: (coords: LatLng[]) => void
  addLatLng: (coord: LatLng) => void
}

export async function createLiveRouteLine(
  map: TsMapType,
  color: string,
): Promise<LiveRouteLine> {
  const { RunTrailLayer } = await ensureTsMaps()

  /*
   * A live trail rather than a plain stroke, because the two things a runner
   * wants mid-run are not what a polyline says.
   *
   * The tail fades, so "where I have been since the last capture" reads at a
   * glance instead of having to be traced. The head pulses, so the line reads
   * as live rather than as a route someone planned. And `showPotential` shades
   * the ground the loop would enclose if they closed it from where they are —
   * which is the whole game, answered before the lap is run rather than after.
   */
  const layer = new RunTrailLayer({
    color,
    weight: 5,
    opacity: 0.95,
    showPotential: true,
    potentialOpacity: 0.16,
    showHead: true,
    pulse: true,
  })
  map.addLayer(layer as unknown as Parameters<TsMapType['addLayer']>[0])

  // ts-maps game geometry is [lng, lat] — GeoJSON order — while the rest of
  // this app is [lat, lng]. The swap lives here so it happens exactly once.
  const live = layer as LiveRouteLine
  live.setLatLngs = (coords: LatLng[]) => {
    layer.setTrack(coords.map(([lat, lng]) => [lng, lat]))
  }
  live.addLatLng = ([lat, lng]: LatLng) => {
    layer.addPoint([lng, lat])
  }
  return live
}
