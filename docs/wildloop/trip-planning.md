# Trip planning

Somebody planning a run in another city finds the town, sees its trails, plans one (or any spot) for a day, and has directions ready in Apple Maps or Google Maps — including at a trailhead with no signal.

## Finding a place

`/api/geo/search?q=` and `/api/geo/reverse?lat=&lng=` answer from a GeoNames gazetteer on this server (`ts-maps/gazetteer`): every town of 1,000+ people worldwide, about 170,000 places in a ~60 MB SQLite file with a full-text index. Searches never leave the server and there is no quota, which matters because they run on every keystroke.

- The search page lists towns first, each linking to `/trails?near=<name>&lat=&lng=`.
- The trails page reads that link as the search origin ("Near San Diego"), offers a town search in its location bar, and a **Plan a run here** button.
- The plans page has its own "Where to?" search.

The file lives beside the app database (`GAZETTEER_PATH`, or the database directory). The deploy runs `./buddy geo:import --if-missing` after migrating: it builds the file once per server and never fails a deploy — if GeoNames is unreachable, place search answers `available: false` and the next deploy tries again. Rebuild by hand with `./buddy geo:import` (optionally `--dataset cities500` for villages too). The GeoNames licence (CC BY 4.0) asks for credit; the API returns the line in `attribution`.

## Plans

A plan (`trip_plans`, `app/Models/TripPlan.ts`) is a destination point and a calendar day:

- **Trail plans** take the trail's trailhead and name from the catalog, whatever the page sent.
- **Spot plans** come from a searched town, refined by tapping the map.
- `planned_for` is a date, not an instant. `timezone` is where the plan was made; "today" and the reminder are counted in it.

`GET/POST /api/plans`, `PATCH/DELETE /api/plans/{id}` — owner only; someone else's plan is a 404. Validation and every label live in `resources/functions/trip-plans.ts`, shared by the API and the pages.

## Drawing a route

`/routes` is a map you draw on: search a town, tap to add points, and each leg follows footpaths and trails (**Follow paths**) or runs straight (**Straight**). **Undo**, **Loop back** and **Out & back** do what they say; the pill over the map shows distance, climb and shape as you go. The logic is ts-maps' `RouteBuilder`; the page only draws it.

- Each leg is routed by `GET /api/geo/path?from=&to=` and the climb by `GET /api/geo/climb?path=<encoded polyline>` — proxied to Valhalla (`VALHALLA_URL`, or the public FOSSGIS server) so the page's content policy stays closed and a self-hosted router is a config change. A leg that cannot be routed is drawn straight and the page says so.
- Drawing needs no account; **Save route** asks to sign in. After saving, **Plan this route** opens the planner at the route's start (`/plans?route=<id>`), and the plan links back (`custom_route_id`, migration 164).
- A trail page's **Customize route** opens the builder on that trail's line (`/routes?trail=<id>`), to extend or reshape.

## Directions

`planDirections()` builds https links with ts-maps `directionsLinks`: `maps.apple.com/?daddr=…&dirflg=d` and `google.com/maps/dir/?api=1&destination=…&travelmode=driving`. Driving, because the trip to a trailhead is. In the native app the shell hands any link that is not wildloop.org to the system, so these open Apple Maps and, when installed, Google Maps.

## Reminders

- **In-app:** `./buddy plans:remind` runs hourly (`app/Scheduler.ts`) and notifies from 6 PM the evening before, in each plan's timezone. `reminded_at` makes it once only; moving the date re-arms it.
- **On the device:** the native app also schedules a local notification for the same moment (`localNotifications` capability), because the server cannot push and a local one rings without signal.

## Offline

`useTripPlans` keeps the list on the device: localStorage per account, and in the native app a copy in secure storage too — a launch with no signal opens the bundled copy of the site (`craft://app`), whose localStorage is not wildloop.org's. When `/api/plans` cannot be reached the page shows that copy and says so; the directions links still work. Planning a trail also saves its route and map for offline. Signing out clears the copies and the scheduled reminders.

The service worker still never caches page HTML (see `public/sw.js`), so in a browser `/plans` opens offline only if it was already open.

## Tests

- `tests/unit/trip-plans.test.ts` — validation, dates across timezones, sorting, directions, when a reminder is due.
- `tests/unit/polyline.test.ts` — the encoded-polyline format the climb endpoint takes.
- `tests/browser/planning.pw.ts` — planning a trail, a spot and a drawn route (draw, loop, undo, save, plan, reopen), against the isolated QA stack with a five-town gazetteer (`tests/browser/fixtures/geonames-sample.txt`) and one seeded trail. Routes are drawn straight there: path routing is a network call to Valhalla, and a deploy gate must not depend on a public server.
