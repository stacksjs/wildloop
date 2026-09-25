# wildloop — Catch-Up & Roadmap

> Status snapshot for a solo dev returning after a break. Synthesized from per-subsystem surveys. Honest, dense, file-cited.

---

## 1. TL;DR

- **It's a polished, fully-interactive demo UI sitting on top of a real-but-disconnected, unpopulated backend.** Every one of the 16 stx views renders and is clickable, but they all read from a single ~620-line client-side seed store (`resources/components/stores.stx`, `defineStore('tb')`) persisted to `localStorage` (key `wildloop-tb-v2`) — not from the database.
- **The backend is NOT all stubs.** There are 8 real DB-querying Actions (Auth ×2, Trail ×1, Territory ×5), real Stacks ORM models + 27–29 migrations, a genuine hand-rolled geometry engine (`resources/functions/geo.ts`, `gpx.ts`), and a working OSM scraper command. All routes are wired in `routes/api.ts`. The problem is connection and data, not absence.
- **The core territory-capture loop "works" — but only as a self-contained browser toy.** `useRecorder.ts` does real GPS (`navigator.geolocation.watchPosition`) + a simulate mode, and "capture" flips ownership in the in-memory store. It uses its OWN `pointInPolygon` + a hardcoded "10 GPS pings inside an enemy polygon" rule — it never calls the real backend conquest engine, never persists, no multiplayer.
- **There are TWO incompatible capture designs that have never met.** Backend = run a *closed loop* to claim empty land, then *route-intersection splits* enemy land (area-based, `ClaimTerritoryAction` + `ProcessActivityConquestAction`). Client = accumulate 10 proximity pings (Paper.io-style). Wiring them is a *game-design reconciliation*, not just plumbing.
- **Only ONE endpoint is consumed by the UI** (`GET /api/trails` via `useTrailCatalog.ts`), and even that returns `[]` because every table has **0 rows** — so the app falls back to seed data 100% of the time. A fully-written API client (`resources/assets/scripts/api.ts`, 287 lines, has `claimTerritory`/`processConquest`/`giveKudos`/etc.) exists but is **dead code with zero importers**.
- **Highest-leverage next move:** make the run→activity→territory loop persist server-side end-to-end (populate DB → persist GPS to an Activity → invoke the already-built claim/conquest engine → render territories from `/territories/map`). That single thread turns the "browser toy" into a real product and exercises the most-built, least-connected code.

---

## 2. How to run it

**Stack/runtime:** Bun >= 1.3.0, SQLite >= 3.47.2. Stacks framework (v0.70.45) is **vendored in-repo** under `storage/framework/**` as workspaces (not npm-installed). stx `^0.2.66` (resolves 0.2.70). Maps via **ts-maps** (NOT leaflet).

**First-run / clean checkout (critical):**
```sh
./bootstrap          # downloads pantry from github.com/home-lang/pantry,
                     # regenerates the GITIGNORED pantry/ dep tree,
                     # re-vendors bun-query-builder. REQUIRED on fresh checkout.
# (or) ./buddy install
```
`pantry/` (333 entries) is gitignored (`.gitignore` 43/56/61) and **will not exist** on a clean checkout. `pantry/bun-query-builder/` is a **vendored** copy; root `package.json` does not declare it (HEAD commit: "bump vendored bun-query-builder to ^0.1.26 (not in root)"). Don't change `bunfig.toml` `linker = 'hoisted'` (required by better-dx convention).

**Run:**
```sh
./buddy dev                       # full Stacks dev
bun --watch serve.ts              # stx-only frontend
bun run dev:frontend              # same, alt
bun build.ts                      # build (buildApp from @stacksjs/stx)
bun preview.ts                    # preview
```

**Ports / URL (gotcha):** `config/ports.ts` says frontend 3000 / api 3008 / db 3010, **but `.env` `PORT=6700` wins** (`serve.ts` honors `process.env.PORT`). App is at **`wildloop.localhost` on port 6700** — easy to look in the wrong place.

**Database — three configs disagree; only one is real:**

| Source | Says | Reality |
|---|---|---|
| `config/database.ts:14` | default `mysql`, sqlite path `database/stacks.sqlite` | misleading |
| `.env` | `DB_CONNECTION=postgres`, `DB_DATABASE='bench_review'` (5432) | misleading (points at a leftover benchmark DB) |
| `config/query-builder.ts:5-7` | **`dialect:'sqlite'`, `database/stacks.sqlite`** | **THE config the ORM actually uses** |

- All 27–29 migrations are **SQLite-only DDL** (`INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT/REAL`) — they will NOT run on postgres/mysql as-is. But the alter migrations use **`ADD CONSTRAINT ... FOREIGN KEY`, which SQLite rejects** — so the migration set is internally contradictory (see Caveats).
- **Every table is empty (0 rows)** in `database/wildloop.sqlite`; `database/stacks.sqlite` only has framework tables. **No seeders exist** anywhere.
- To get data: `buddy scrape:trails` (hits live OSM Overpass — network-dependent) or manual insert.

**Maps:** `public/js/ts-maps.mjs` (336KB) + `public/css/ts-maps.css` are already built/committed, so maps render now. **Rebuilding** (`bun run build:maps`) requires the `ts-maps` sibling repo at `../../Libraries/ts-maps/packages/ts-maps`, which is **currently MISSING on this machine** — `build:maps` would fail.

**Working tree:** clean, up to date with origin/main. Recent theme: "feat: add territory capture gameplay and Strava-style run UI" landed on top of a framework upgrade to v0.70.45.

---

## 3. Architecture at a glance

**Layout (Stacks conventions):**
- `resources/views/` — 16 stx page templates (file-based routing); `resources/layouts/default.stx` `@include`s the store + runs `useTrailCatalog`.
- `resources/components/` — components + the `tb` store (`stores.stx`).
- `resources/composables/` — `useRecorder`, `useTrailMap`, `useTerritoryExplorer`, `useTrailCatalog`, `useRoutePreview`.
- `resources/functions/` — `geo.ts`, `gpx.ts`, `scraper/*`.
- `app/Actions/` — `Auth/`, `Trail/`, `Territory/`, and an **empty `Scraper/`** (dead scaffolding; scraper actually lives in `app/Commands/ScrapeTrails.ts`).
- `app/Models/` — 12 ORM models. `routes/api.ts` — routes (mostly framework boilerplate; wildloop routes at 18-19, 378, 381-392, 395-398).

**Data layer.** 12 Stacks ORM models with attributes, validation, faker factories, relations: User, Trail, Activity, Territory, TerritoryStats, TerritoryHistory, Kudos, Review (`trail_reviews`), SavedTrail, Achievement, UserAchievement, UserStats. Each has create + alter migrations and a uuid/timestamps trait. Relationship chain is end-to-end: `User → Activity (belongsTo User+Trail) → Trail`; capture path `Activity → Territory (belongsTo User+Activity) → TerritoryHistory + TerritoryStats`.

**Geospatial approach — relational/JSON-in-TEXT, NOT PostGIS.** Trail tracks in `trails.geometry` (TEXT), run tracks in `activities.gpx_data` (TEXT), territories store a GeoJSON Polygon string in `territories.polygon_data` + a CSV `bounding_box` (`minLat,minLng,maxLat,maxLng`) + `center_lat/lng`, `area_size`, `perimeter` (REAL). All spatial math is **hand-rolled and genuinely implemented** in `resources/functions/geo.ts` (503 lines: Haversine, Shoelace area with cos(lat) projection, Douglas-Peucker, ray-cast point-in-polygon, segment/route intersection, bbox overlap, centroid, GeoJSON round-trip, `splitPolygonByRoute`) and `gpx.ts` (regex GPX/GeoJSON/JSON parsing + `validateGpsDataForClaim`). No spatial index — conquest loads ALL active territories and filters in JS (O(n)).

**How the frontend talks to the backend: mostly it doesn't.** There is no `resources/stores/` dir — all client state is the `tb` store. The ONLY live fetch in the whole app is `useTrailCatalog.ts:28` → `GET /api/trails?limit=500` → `tb.hydrateTrailsFromApi` (normalized by `resources/assets/scripts/trail-data.ts`, km→mi / m→ft). Because trails table is empty, the length guard fails and `catalogSource` stays `'seed'`; the "live data" badge in `trails.stx` has effectively never lit up. Everything else (activities, territories, conquests, leaderboard, social) is seed-only.

**The intended run→territory pipeline (built but disconnected):**
```
record.stx → useRecorder (real GPS / simulate)
   → [INTENDED] POST gpx_data → create Activity
   → POST /territories/claim     (ClaimTerritoryAction: closed-loop validate, area 1k–5M m², Territory.create + History + Stats)
   → POST /territories/process-conquest (ProcessActivityConquestAction: bbox prefilter → routeIntersectsPolygon → splitPolygonByRoute → child Territory + history + dual stats)
   → GET /territories/map | /leaderboard | /user/{id}  → render
```
**What actually happens today:** `useRecorder.stop()` calls in-memory `tb.addActivity()` + `tb.conquerTerritory()` and **never POSTs anything**. The real engine has never processed a single run (and structurally couldn't: `Activity.gpxData` factory returns `null`, and both claim/conquest Actions hard-fail with "Activity has no GPS data").

---

## 4. What's DONE

**Infra / build**
- Stack pinned and runnable; framework vendored under `storage/framework/**`; `buddy` CLI wrapper with rpx-resolution fix.
- Maps prebuilt and committed (`public/js/ts-maps.mjs` + `.css`); real ts-maps + OSM tile integration in `useTrailMap.ts` (createTrailMap/drawTrailRoute/drawTerritoryPolygon/drawTrailMarker/createLiveRouteLine), used by record/trail/activity/trails pages.

**Data / schema**
- 12 ORM models fully defined (attributes, validation, factories, relations, `useApi`, `useSeeder` counts). All 12 tables migrated and present (`sqlite3 .tables` confirms).
- Geospatial schema designed; `geo.ts` + `gpx.ts` math implemented (real Haversine/Shoelace/Douglas-Peucker/point-in-polygon/route-intersection/polygon-split/GeoJSON).

**API / backend**
- All 8 Actions are REAL DB queries (no TODO/mock markers in `app/`):
  - `Auth/LoginAction.ts` (Auth.login → {token,user}), `Auth/RegisterAction.ts` (register + getUserFromToken).
  - `Trail/TrailIndexAction.ts` — `Trail.limit().get()`, lat/lng mapping.
  - `Territory/ClaimTerritoryAction.ts` — closed-loop claim, area bounds, Territory + History + Stats.
  - `Territory/ProcessActivityConquestAction.ts` (~230 lines) — full polygon-split conquest, child territory, dual stat updates.
  - `Territory/{GetTerritoriesForMap,TerritoryLeaderboard,UserTerritories}Action.ts` — real `.where/.orderBy/.get` queries, GeoJSON FeatureCollection.
- All routes registered: `routes/api.ts` 18-19 (login/register), 378 (`GET /trails`), 381-392 (`/territories/{claim,process-conquest,map,leaderboard,user/{id}}`), 395-398 (`/me`, `/logout`).

**Run / trail UI**
- Real GPS capture (`useRecorder.ts` `watchPosition`, haversine, high-accuracy, permission states).
- record→save→view-activity loop works **client-side** end-to-end (`stop()` → `tb.addActivity()` → `feed`/`index`/`activity/[id]` render it).
- Trail + activity detail render real route geometry from seed `trailRoutes`; feed SVG route-preview thumbnails (`useRoutePreview.ts`).
- `GET /api/trails` wired (the one live path) with graceful `[]` fallback.
- OSM scraper is real and substantial: `app/Commands/ScrapeTrails.ts` (`buddy scrape:trails`) + `resources/functions/scraper/*` (overpass-client, region-definitions, trail-normalizer ~235 lines, deduplication; ~511 lines total), writes via `Trail.create()`.

**Territory UI**
- All game surfaces render and are interactive: `territories`, `territory/[id]`, `conquests`, `battles`, `challenges`, `leaderboard`, `stats` — working filters/tabs, Leaflet maps (green=yours/orange=enemy/dashed=contested), conquest-history timelines.
- In-browser capture mechanic visually functional: `applyCaptureSample` fills a meter, `conquerTerritory` flips ownership + bumps stats/achievements/notifications; simulate mode replays seed routes.

**Social / Auth**
- Login/Register are the ONLY real DB-backed social flows: forms wired to `auth.login()`/`auth.register()` with loading/error states, live password-strength + match logic.
- Profile, notifications (filter/group/mark-read), client-side leaderboard aggregation all render correctly (over seed data).

**Gameplay engine**
- Backend geo engine is real and complete enough to claim + conquest-split (see Data/API above). Routes reachable. Models' field names match the Actions (`polygonData`/`boundingBox`/`parentTerritoryId`/`conquestCount`; `eventType`/`previousOwnershipDuration`/`newTerritoryId`).

---

## 5. What's PARTIAL / demo (renders, isn't real)

| Surface | What renders | The precise gap |
|---|---|---|
| **Whole app data layer** | 16 views via `useStore('tb')` | Reads ~12 hardcoded seed arrays in `stores.stx` (lines ~209-417), persisted to localStorage. Only **trails** are API-replaceable. |
| **Trails "live data"** | `trails.stx` "live data" badge | Trails table empty → `/api/trails` returns `[]` → guard fails → always seed. Live path has never fired. |
| **Territory map / detail** (`territories.stx`, `territory/[id].stx`) | Maps, nearby grid, leaders sidebar | `useTerritoryExplorer.ts` reads ONLY `tb.territories()/users()`; never calls `/territories/map` or `/leaderboard` (recomputes leaderboard from seed at L36-47). CTAs link to `/record`, not the claim flow. |
| **In-game capture loop** | record.stx capture meters, ownership flip | `useRecorder.checkConquest` (L165) uses its OWN `pointInPolygon` (L81, not geo.ts) + hardcoded `CAPTURE_SAMPLES_NEEDED=10`. No closed-loop, no area, no split — a **proximity counter**, mutating localStorage only. |
| **conquests / battles** | Battle log, "Under Attack", "Live" badges | All seed rows (`seedConquests`); "live" = `status==='active'`; period filters slice seed timestamps client-side. No websocket/poll/API. |
| **Leaderboard** (`leaderboard.stx`) | Podium + ranked list, period/metric tabs | Computed from seed; **tabs are decorative** — always sorts by `b.totalDistance` (L30) regardless of selection. Backend `TerritoryLeaderboardAction` unused; page doesn't even rank by territory. |
| **stats.stx** | Summary tiles, weekly bar chart, PRs | All from `seedUserStats` (single hardcoded object for user 1); `weeklyHistory` fixed 7-point array. No backend query. |
| **Activity kudos / comments** | `activity/[id].stx` toggle/submit work | `tb.toggleKudos`/`tb.addComment` mutate the local array only; no POST, no Kudos/Comment endpoint. Feed kudos buttons (`feed.stx:103-110`) have NO `@click` — decoration. |
| **Trail reviews** | `trail/[id].stx` Reviews/Conditions tabs | Display-only from `seedReviews`; no submission form, no review API. |
| **Auth session / logout** | `onMount` `auth.user()`; `/me`, `/logout` routes declared | `AuthUserAction`/`LogoutAction` **files don't exist** → calls throw, swallowed by empty `catch{}`; redirect silently no-ops. No logout button anywhere. |
| **Frontend API client** | `resources/assets/scripts/api.ts` (287 lines) | Full client (`claimTerritory`/`processConquest`/`giveKudos`/`createActivity`/`fetchUserStats`…) but **zero importers** — dead code; only attaches `window.WildloopAPI`. |
| **`splitPolygonByRoute`** | conquest geometry | Self-labeled "simplified - for MVP" (geo.ts L378); boundary-walk math handles only clean 2-crossing convex case; >2 crossings / concave / self-intersecting routes produce wrong/degenerate polygons. Never run on real data. |
| **Activity save fidelity** | `useRecorder.stop()` payload | `splits:[]`, `heartRateAvg/Max:null`, `cadence:null`; no persisted link to triggered conquests (conqueredIds only used for the title string); real-GPS elevation stays 0 (sim fabricates via `Math.random()*12`). |

---

## 6. What's MISSING (not started)

**Backend endpoints that don't exist at all** (models/tables exist, but no Action and no route):
- **Activity / runs** — no create/list/show. The recorder cannot persist a run. `activity/[id].stx` renders from seed.
- **Kudos** — model + table exist; zero routes. Feed counts come from `seedActivities.kudos_count`.
- **Reviews** — model + `trail_reviews` exist; zero wildloop review routes (the `/reviews` in api.ts are unrelated Commerce boilerplate).
- **Achievements / UserAchievements** — models + tables; zero routes. No unlock engine; progress only changes as a side effect of `conquerTerritory`.
- **UserStats** public read — model + table; no endpoint (stats page uses seed).
- **User-facing Leaderboard, Feed** — views exist, demo-only.

**Features with NO model, NO table, AND NO endpoint** (pure frontend fictions):
- **Clubs** — `clubs.stx` Create/Join buttons have no handlers, no backend.
- **Challenges** — full UI, `+ New Challenge` is a no-op; no Challenge model/migration/Action.
- **Battles** — seed rows filtered by status/date; no real-time.
- **Segments, Notifications (as a backend), Follows/Friends** — seed-only; no social-graph backend (faked via seed `members` arrays).
- **Social OAuth (Google/GitHub)** — buttons render with brand SVGs, no `@click`, no provider config.
- **Forgot-password / Terms / Privacy pages** — linked but views don't exist (password-reset API routes exist at api.ts 101-105, no frontend).

**Gameplay-engine gaps:**
- **Any frontend→backend wiring for the game.** No view/composable calls a territory endpoint; the dead `api.ts` is the only bridge.
- **GPS ever reaching the backend.** `Activity.gpxData` factory returns `null`; `useRecorder.stop()` never persists `gpx_data`. Both claim/conquest Actions hard-fail without it.
- **Seeded/live game data.** DB empty; no Database Seeder for any model; seeding helpers `generateSampleLoopGpx`/`generateLoopCoordinates` have zero callers.
- **Contest / defend path.** `TerritoryHistory` has a `'defended'` event type that nothing ever writes; "contested"/`defendCount` exist only in the seed store.
- **Scraper HTTP Action** — `app/Actions/Scraper/` is an empty dir (CLI-only ingestion).
- **Ranking job** — `weeklyRank`/`allTimeRank` are hardcoded to `999` on create (`ClaimTerritoryAction.ts:117-118`, `ProcessActivityConquestAction.ts:211-212`); no cron/recompute.

---

## 7. Caveats & tech-debt

**Environment / build**
- **DB config trap:** trust `config/query-builder.ts` (sqlite, `stacks.sqlite`), NOT `.env` (postgres/`bench_review`) or `config/database.ts` (mysql). The active DB file is even ambiguous: `query-builder.ts` points at `stacks.sqlite` (framework tables only) while the schema-bearing `wildloop.sqlite` (90KB) is also present.
- **Frontend port is 6700**, not 3000.
- **Clean checkout needs `./bootstrap`** to regenerate gitignored `pantry/` + re-vendor `bun-query-builder`. `bun.lock` still pins `^0.1.21` while vendored is `^0.1.26`.
- **`ts-maps` sibling is missing** → `build:maps` fails; works only because output is committed. Maps silently fail (caught/logged) if the public chunks aren't served.

**Migrations (will break a from-scratch migrate)**
- **Duplicate geometry column:** `1780615824-add-trails-geometry-column.sql` AND `1780619054-alter-trails-table.sql` both `ALTER TABLE trails ADD COLUMN geometry TEXT` → "duplicate column name: geometry". (The 1780615824 file even contains it twice.) One must be removed/guarded.
- **17 SQLite-invalid `ADD CONSTRAINT` statements** across the `1780615*` alters — valid only on Postgres/MySQL. So the migration set is dialect-locked to Postgres/MySQL, yet the runtime is SQLite and the create migrations are SQLite syntax — internally contradictory.
- **Committed `.sqlite` files are stale:** `wildloop.sqlite` schema for trails/activities/territories LACKS the uuid/FK/geometry columns the models expect (only the create migrations ran; alters never applied). `stacks.sqlite` has 0 tables. Don't trust either as source of truth.

**Data modeling**
- **Type sloppiness:** FK-ish ids and counts (`giver_id`, `parent_territory_id`, `review_count`, `kudos_count`…) stored as **REAL** not INTEGER; "SQLite doesn't support ALTER COLUMN" so never corrected.
- **Denormalized counters drift:** `activities.kudos_count`, `trails.rating/review_count` are only set by factories; no code recomputes from related rows. No unique constraint preventing duplicate kudos.
- **One-directional relations:** `Territory/Kudos/TerritoryHistory` `belongsTo Activity`, but `Activity` declares no inverse `hasMany`.
- **No spatial index / PostGIS** — conquest is O(n) full scan with per-territory string bbox parse; fine for demo, won't scale.

**Security / correctness**
- **No auth on `/territories/*`** (only `/me`, `/logout` guarded). `ClaimTerritory`/`ProcessConquest` read `user_id` from the request body — any caller could claim/conquer as any user once data exists.
- **Two divergent capture rule-sets** (closed-loop+split vs. 10-ping proximity) that will never agree — reconcile the game design before wiring.
- **Frontend/backend models diverged:** Territory status enum is `['active','contested']` (model) vs. `'secure'|'contested'` (store); backend has `polygon_data/bounding_box`, store has `lat/lng` + a separate `territoryPolygons` map. Wiring needs a mapping layer.

**UI / dead code**
- **Two parallel component trees** (`resources/components/` and `resources/views/components/`) with near-identical, drifting copies of ActivityCard/TrailCard/FeaturedTrailCard/DifficultyBadge/StarRating/Territory* — used by NO surveyed view (pages inline their markup). Several have **broken stx interpolation** (`TrailCard.stx:59`, `FeaturedTrailCard.stx:55`, `DifficultyBadge.stx:23`, `InputGroup.stx:28`) — latent, masked only because unused.
- **localStorage persistence masks the stub:** key `wildloop-tb-v2` — captures/kudos survive reloads (looks "real"), and **seed edits won't appear until the key is cleared or bumped** (the `v2` suffix is the manual-bump mechanism).
- **Fragile route-param extraction:** `activity/[id].stx` reads `window.__routeParams?.id`, `trail/[id].stx` reads `window.stx._rp?.id ?? window.__stx_rp?.id` — inconsistent undocumented globals; if the router changes, detail pages silently fall back to id 1/0.
- **Two divergent API clients:** the unused `scripts/api.ts` is the *more complete* one (conquest/kudos/stats); the used `useTrailCatalog` is raw fetch. Standardize before extending.

---

## 8. Recommended roadmap

### P0 — Unblock a real, persistent core loop

The whole point of the app (territory capture) currently has no server backing. Everything below is needed to turn the browser toy into a real product. Tackle as one vertical thread.

1. **Get the migrations to actually run + seed data.** *(scope: ~½ day)*
   - Fix the duplicate geometry migration (remove/guard `1780619054-alter-trails-table.sql`; de-dupe the statement in `1780615824`).
   - Decide the dialect once. Easiest path: stay SQLite (matches `config/query-builder.ts` + create migrations) and **rewrite the 17 `ADD CONSTRAINT` alters** as SQLite-compatible (recreate-table or drop the FK constraints, keep the columns). Then point at one DB file consistently.
   - Run `buddy scrape:trails` (or write a minimal `database/seeders/` for trails/users/territories so you're not network-dependent).
   - *Touches:* `database/migrations/*`, `config/query-builder.ts`, new `database/seeders/`, `app/Commands/ScrapeTrails.ts`.
   - *Done when:* `GET /api/trails` returns rows and `trails.stx` flips to `catalogSource='api'` ("live data" badge lights).

2. **Reconcile the two capture designs, then persist a run as an Activity.** *(scope: ~1 day)*
   - Pick ONE capture rule (recommend the backend's closed-loop-claim + route-intersection-split — it's the differentiator and already built). Make `useRecorder` produce a real `gpx_data` payload.
   - **Add the missing Activity endpoints:** `ActivityStoreAction` (+ index/show). Wire `useRecorder.stop()` to POST the GPS track → create an Activity row (fix `Activity.gpxData` so it's persisted, not `null`).
   - *Touches:* new `app/Actions/Activity/*`, `routes/api.ts`, `app/Models/Activity.ts`, `useRecorder.ts`, `resources/assets/scripts/api.ts` (revive `createActivity`).

3. **Wire the run → claim/conquest engine.** *(scope: ~1 day)*
   - From the saved Activity, call `POST /territories/claim` and `POST /territories/process-conquest` (the engine is already built in `ClaimTerritoryAction`/`ProcessActivityConquestAction`). Revive the dead `claimTerritory`/`processConquest` in `scripts/api.ts` and actually import them.
   - Add `auth` middleware to `/territories/*` and derive `user_id` from the session instead of the request body.
   - *Touches:* `useRecorder.ts`, `resources/assets/scripts/api.ts`, `routes/api.ts:381-392`, the two Territory Actions.
   - *Caveat to expect:* `splitPolygonByRoute` is MVP-quality — this is the first time it runs on real input; budget time to harden the >2-crossing/concave cases.

4. **Render territories + leaderboard from the DB.** *(scope: ~½ day)*
   - Replace `tb.territories()/territoryPolygons()` reads in `useTerritoryExplorer.ts` with `GET /territories/map`; replace the seed leaderboard with `GET /territories/leaderboard`. Add a mapping layer for the model↔store shape divergence (status enum, polygon_data vs lat/lng).
   - *Touches:* `useTerritoryExplorer.ts`, `territories.stx`, `territory/[id].stx`, `leaderboard.stx`, `stores.stx` (hydration methods).

> **Net P0 outcome:** a single player can record a run, claim/conquer territory that persists to the DB, and see it on a map fed by the API — the real loop, end to end.

### P1 — Make the social/product layer real

- **Fix the broken Auth wiring:** create `AuthUserAction` + `LogoutAction` (routes already declared at api.ts 396-397); add a logout control to `nav.stx`; gate nav/pages on auth; feed the logged-in user into the store instead of hardwired `currentUserId:1`.
- **Persist social interactions:** Kudos and Review/Comment endpoints + wire `tb.toggleKudos`/`addComment` and the feed kudos buttons (`feed.stx:103-110`) to them. Add a unique constraint on kudos; recompute denormalized counters.
- **Fix the leaderboard sort bug** (`leaderboard.stx:30` ignores period/metric tabs) and make the ranking job populate `weeklyRank`/`allTimeRank` instead of the hardcoded `999`.
- **UserStats / Achievements endpoints** + a real unlock engine driven by activities/conquests (today progress only moves via `conquerTerritory`).

### P2 — Scale, polish, and the "fiction" features

- **Spatial indexing** (or at minimum a real bbox index) — conquest currently full-scans all active territories.
- **Decide on Clubs / Challenges / Battles / Segments / Follows** — these are pure UI with zero backend; either build models+endpoints or remove the dead UI.
- **Real-time / multiplayer** for battles/"under attack" (today entirely scripted seed).
- **Tech-debt cleanup:** delete one of the two component trees (fix the interpolation bugs or drop the files); standardize on ONE API client; bump the `tb` store persist key when the schema changes; unify route-param extraction across detail pages; correct REAL→INTEGER column types; remove the empty `app/Actions/Scraper/`.

---

### Suggested "first session back" concrete starting point

1. Confirm reality in 5 minutes: `sqlite3 database/stacks.sqlite ".tables"` and `… "SELECT COUNT(*) FROM trails"` (expect 0), then load `wildloop.localhost:6700` and note every page is seed.
2. **Fix the duplicate geometry migration** (`1780615824` / `1780619054`) and make migrations run clean on SQLite (neutralize the `ADD CONSTRAINT` alters).
3. **Get ONE trail into the DB** — run `buddy scrape:trails` (or hand-insert a row) and watch `GET /api/trails` return it and `trails.stx` flip to the "live data" badge. That single green light proves the migration/seed/ORM/route/fetch chain is healthy and is the foundation every P0 step builds on.