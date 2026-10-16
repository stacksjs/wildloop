# Native screens

Wildloop's native screens live in `resources/native/` and are promoted **per
path** in `ios.nativeScreens` (`config/mobile.ts`):

```ts
nativeScreens: {
  '/achievements': 'Achievements',
  '/athlete/:id': 'AthleteDetail',
  '/athletes': 'Athletes',
  '/battles': 'Battles',
  '/challenges': 'Challenges',
  '/club/:id': 'ClubDetail',
  '/clubs': 'Clubs',
  '/effort/:id': 'EffortDetail',
  '/event/:id': 'EventDetail',
  '/conquests': 'Conquests',
  '/events': 'Events',
  '/records': 'Records',
  '/search': 'Search',
  '/stats': 'Stats',
  '/territories': 'Territories',
  '/territory/:id': 'TerritoryDetail',
  '/trails': 'Trails',
  '/notifications': 'Notifications',
  '/leaderboard': 'Leaderboard',
  '/activity/new': 'ManualActivity',
  '/activity/saved': 'ActivitySaved',
}
```

A path listed there is drawn as real UIViews; everything else stays the website
in one warm web view, sharing the same navigation stack. A half-migrated app is
the end state rather than a transition, and any line is reversible by deleting
it. The last two paths have no web page behind them — the web app logs a manual
activity in a modal — and are listed because only named screens are compiled
and the native flow pushes `ActivitySaved` by name.

That map is the single source of truth: `resources/native.config.json` held a
second copy and is gone. The generated `craft.config.json` carries the same map,
`bun run build:native-screens` compiles from it, and the test fixture compiles
from it too, so a test cannot pass against a screen list the app does not ship.

The flows so far:

- **Manual activity** — logs an activity through the same payload builder and
  `/api/activities` endpoint as the web UI, then opens the saved-activity screen
  with the returned id.
- **Records** — the public fastest-known-times board, the first list screen.
  A keyed `:for` inside a `ScrollView`, filtered server-side by style, and a
  row now **pushes** `EffortDetail` rather than handing off to the web.
- **Search** — one box for everything the app can find. Five endpoints asked
  in parallel and grouped by the same function the web page uses, with a
  ticket so a slow answer to an older query cannot replace a newer one. Its
  quick links `push` the native screen where we have one rather than opening a
  web view onto a page the app already draws.
- **Stats** — the training summary. There is no endpoint for these numbers —
  `user_stats` has no weekly or monthly split — so both screens fold them from
  the athlete's activities with `computeTrainingStats`. The web page does it in
  the store; the native screen asks the API and translates the rows first,
  because that function reads snake_case and the API answers camelCase. Feed it
  the API's shape untranslated and every number is zero, silently.
- **Trails** — the catalog, and the first screen that draws something. Each row
  carries its route as a real SVG polyline, projected by the same
  `routeShapeFor` the website uses, so a line is never a square thumbnail
  stretched into a strip.
- **Achievements** — the records, the year and every badge. The first screen
  that draws a chart: twelve bound `<rect>`s in one SVG, where the web page
  uses twelve divs with a percentage height, which native has no equivalent
  for. The numbers are `personal-bests.ts`, which the web page has always used.
- **Challenges** — who is challenging whom for which ground. Every line depends
  on which side of it the viewer is on, so the screen asks `/api/me` before it
  asks for anything else: a finished challenge reads Won or Lost, not
  "completed", and only the defender of a pending one gets an Accept.
- **Clubs** — the crew directory, and the second screen that writes per row.
  Join and leave are one endpoint the server decides, so the row moves
  optimistically and is then put back from the response rather than from what
  the tap assumed. An invite-only club opens its page instead of offering a
  button that would be refused.
- **Territories** — the first screen that draws a real map. One `MapPolyline`
  per zone, closed by repeating its first point because craft-native has
  polylines and markers and no polygon. Two things here fail silently and are
  therefore shared rather than written twice: a GeoJSON ring is `[lng, lat]`
  and everything that draws it wants `[lat, lng]`, and the query is built with
  `encodeURIComponent` because the native runtime has no `URLSearchParams`.
  Colour is identity, from the same `territory-style` the web map uses.
- **Battles** — the game's feed, and the only native screen that works signed
  out: `/api/territories/battles` answers without a viewer and only `?mine=1`
  needs one. Third person, about other people.
- **Athlete detail** — one athlete, and it closes **three** hand-offs: the
  directory, the leaderboard and the territory map all opened `/athlete/:id`
  in a web view, and the effort screen opened it too. `/api/users/{id}`
  answers an *envelope* — identity under `user`, numbers under `stats`, follow
  counts at the top — so `athleteProfileFrom` flattens it once; a screen
  reading `payload.name` shows a nameless profile of zeroes and nothing
  errors. Only **verified** records are listed, because a profile is where a
  record is read as a credential. Following is optimistic and settles through
  `settledFollowerCount`, shared with the web page: settling from the
  direction of the *tap* rather than the state before it is what took a club
  from 48 members to 47 on a refused join. **A block takes two taps** — there
  is no system confirm dialog in a native screen and a block cuts both
  follows, so the first tap arms and says what it will do.
- **Territory detail** — one zone, and the first promoted path with a
  **parameter**. `'/territory/:id'`: the shell matches patterns, static
  segments beating `:params` beating a trailing `*`, so `/territories` keeps
  going to the list screen. `tests/unit/native-route-table.test.ts` checks the
  whole table against craft's own `matchNativePath` rather than against a
  reading of those rules — including that a query cannot override the path's
  own `id`. The id is read digits-only (`territoryIdFrom`): `Number.parseInt`
  reads `/territory/7.5.1` as 7 and would load a zone the path does not name.
  Its history is filtered out of the battle feed, as the web page does from its
  store, and told in a *third* voice — the feed names the territory, and here
  the reader is already looking at it, so it reads "Marta is attacking it".
- **Event detail** — one event's live board, and the first screen built on the
  shared request skeleton rather than its own copy. **It does not tick, and
  this one costs the most**: the web page runs a poll that speeds up near a
  corral plus a local once-a-second tick anchored to the board's `serverTime`,
  so a device three minutes fast cannot disagree with the clock at the start
  line. The runtime promises no timer, so there is neither. What saves it is
  that `msToNextStart` is computed *by the server* and arrives on the board —
  the countdown is a real number, simply as of when the board was read, and
  the screen says so beside it. Refresh re-reads the board alone, since that
  is all that changes during a race, and a dropped refresh keeps the last good
  board rather than blanking out. The loop is drawn **open**: it is a lap, and
  closing it would draw a leg nobody ran. No organiser status controls —
  starting and stopping a race is the one thing worth doing on a laptop beside
  the start line.
- **Club detail** — one club, and the directory's two hand-offs (a row, and
  the "View" door on an invite-only club) become pushes. The permissions are
  read off the payload and shared with the web page: **inviting** needs an
  owner or an admin *on the roster* — `isMember` is not enough — and
  **deleting** is the creator's alone, which an admin's role sounds like it
  should cover and does not. Joining settles through the same
  `settledFollowerCount` the athlete screen uses. An invite-only club offers
  the code field instead of a button, held to eight characters before anything
  is sent. **No copy button on a code**: `enableClipboard` is false in the
  app's capability set, so `craft.clipboard` does not exist in a native screen
  and the code is shown as text.
- **Effort detail** — one record attempt, and the end of the records board's
  last hand-off to the web. Three things differ from the web page on purpose:
  it runs **no timer** (the web page ticks a live clock with `setInterval`, and
  the runtime does not promise one, so the clock is read once per load with a
  refresh button that says so); a **finish files now** rather than offering a
  `datetime-local`; and the course line is drawn **open**, because a route goes
  somewhere and closing it would draw a leg nobody ran.
  Which buttons exist comes from the server's own `isOwner`/`canReview` on the
  payload, never a locally-held viewer id — a screen that decided for itself
  would offer a button the API refuses.
  **`craft.navigation.open` is not "open the web view."** It means "let the
  shell route this path", so promoting a path changes what every existing
  `open()` to it does. The first version of this screen offered "Review it on
  the web" through `open('/effort/:id')`, which would have looped straight back
  into itself; review is on the screen instead, with the note a rejection
  requires.
- **Conquests** — the athlete's own record, from `?mine=1` rather than folded
  out of the global feed, which is the newest 200 battles in the whole game and
  holds only a few of anyone's. Second person — and the battle the feed badges
  "Conquered" is "Lost" here, which is the distinction the two web pages used
  to get wrong in opposite directions. The counters are
  `computeConquestRecord`, which the web page already used.

The screens are compiled to Craft's native document protocol; they do not use a
WebView or a second layout engine. Shared numbers come from
`resources/functions` — `manual-activity.ts`, `route-records.ts`, `trails.ts`
and the rest — so a
native screen and its web counterpart cannot drift on a value. They diverge on
presentation; never on data.

## Build and test

```bash
bun install
bun run build:native-screens --debug
bun test tests/unit/manual-activity.test.ts tests/unit/native-manual-activity-flow.test.ts \
  tests/unit/native-records-screen.test.ts tests/unit/notification-rows.test.ts \
  tests/unit/native-notifications-screen.test.ts
bun run typecheck
```

The build writes `storage/framework/native/native-screens.js`. The whole
directory is gitignored and excluded from the linter — a stale `native-screen.js`
(singular, from an earlier output name) sat tracked in the repo until the lint
cache went cold and reported 455 problems inside it.

`tests/fixtures/nativeScreen.ts` compiles that bundle once and drives it through
a fake Craft bridge: `start(screen, params)`, `event(testID, name)`,
`waitForRequest`, `waitForText`. A list row does not exist in the first
`RENDER` — it arrives as a `createNode` and its handler as an `updateNode`
after that — so `event()` looks in both places, and text is read from
`patch.children` rather than a `text` prop.

## Host contract

The `manual` route requires these maintained Craft capabilities:

- `secureStorage` reads the existing `auth_token`. The records board is public
  and reads none: identity for a write comes from the token, and
  `ActivityStoreAction` derives the actor from the session, so a screen never
  sends a `user_id` of its own.
- `fetch` sends an absolute HTTPS request to `https://wildloop.org/api/activities`.
- `haptics` confirms a successful save.
- `lifecycle` runs teardown and cancels in-flight capability requests when the
  screen closes.
- navigation supports push, back, replace, route params, and screen-local state.

The native compiler resolves application components before framework fallbacks;
`NativeRunMetric.stx` is the representative app-owned component in this flow.

## Building for the simulator

`bun run preview:ios:local` builds and launches. Two things will stop it, both
outside this repo:

- **The generated Xcode project has no `PRODUCT_NAME`.** Every `buildSettings`
  block in `storage/framework/mobile/ios/Wildloop.xcodeproj/project.pbxproj`
  sets the bundle id and the Info.plist and omits this one, so Xcode resolves
  it empty and both targets build a product called `.app` / `.appex`:

  ```
  error: Multiple commands produce '…/Debug-iphonesimulator/.app'
  ```

  Adding `PRODUCT_NAME = "$(TARGET_NAME)";` to each block fixes it. The project
  is regenerated on every build and is not tracked, **so this patch has to be
  re-applied after each regeneration** until craft-native/craft#354 closes.
  Derived data from before the fix holds `WildLoop.app` (capital L) against the
  current `Wildloop`, which collides on a case-insensitive filesystem and makes
  the error look like something else — remove
  `storage/framework/runtime/e2e/derived-data/ios` when in doubt.

- **craft-native 0.0.174 and 0.0.175 do not compile.** `contentPadding` is used
  in two functions that do not declare it, and `rawAttestationObject` is a
  `Data?` passed where `Data` is wanted. Both arrived in 0.0.174 — the release
  that brought the `Map` — so the pin is held at **0.0.173**.
  All three are fixed in published **0.0.187**: `rawAttestationObject` is
  unwrapped behind a `guard let`, `project.yml.template` sets `PRODUCT_NAME`,
  and `contentPadding` is declared in scope. craft-native/craft#354 is still
  open pending a clean Xcode build, which is what the pin is waiting on.
  **This is what gates the territory map on a device.** `Map`, `MapPolyline`
  and `MapMarker` have no renderer at all in 0.0.173 — they arrived with
  0.0.174 — so the Territories screen compiles, passes its tests against the
  mutation protocol, and draws nothing until the pin moves. The screen was
  written anyway because the protocol is the contract and the fixture tests it
  honestly; what cannot be checked until then is how it looks.

## Current boundaries

- The native routes cover manual activity entry and its saved confirmation, not
  GPS recording, maps, media upload, authentication, or the full activity feed.
- **Use `:show`, not `:if` — but not for the reason first recorded here.**
  `:if` *is* applied: it emits `removeNode` when the condition is false and
  `createNode` + `insertChild` when it turns true, standalone and on a loop
  row. What is true is narrower — the **initial RENDER carries every branch**
  regardless of the condition, and the corrections land in the first post-mount
  MUTATE batch. So the first frame shows all of them. Seven screens shipped
  that way before it was noticed, because every earlier `:if` sat on a `Text`
  whose bound text was empty anyway — the one that gave it away was a Button.
  `:show` resolves in that same batch, so it is not faster; it is easier to
  assert on, and it hides rather than unmounts, so a test that a control is
  *not* offered reads `style.display` rather than the text. `bun run gate:stx`
  fails on an `:if` under `resources/native/` for that reason.
  stacksjs/stx#2074 was filed saying `setVisible` is never called, which was a
  misreading of the RENDER payload; 0.2.532 adds a `display` patch beside each
  structural op but leaves the branches in the initial render.
  `tests/unit/native-conditional-timing.test.ts` pins the measured behaviour.
- **The map can be fed from data.** craft-native 0.0.174 draws `Map` with
  `MapPolyline`, `MapMarker` and `fitToBounds` on both hosts, and stx 0.2.520
  compiles all three. A bound `:geometry` reaches the host as
  `{"op":"updateNode","patch":{"props":{"geometry":[…]}}}` in the first
  post-mount batch — the initial RENDER carries only
  `data-stx-parent-bindings="geometry"`, which is what stacksjs/stx#2073
  mistook for the compiler dropping it. It does not. The trails screen draws
  its line as an SVG polyline for its own reasons (a 96×64 thumbnail, not a
  pannable map); a real `Map` is available wherever one is wanted.
- Network requests require an absolute `http://` or `https://` URL. Response
  bodies are text/JSON and are limited by the maintained host.
- Native `:for` renders the shared keyed STX mutation protocol and is the
  portable list boundary used by Records. It preserves row identity, event
  scope, and the scroll host across updates. It is not a React Native
  `FlatList`; `FlatList` item-template expansion remains host-specific, so
  large virtualized feeds remain host-owned work until that capability is
  explicitly advertised by every selected host.
- Browser-only DOM APIs, CSS layout assumptions, and web component behavior are
  unsupported in native screens.
- `:if` on an interactive node was dead when the condition *turned* true
  (stacksjs/stx#2067) — the node shipped in the first `RENDER`, nothing
  re-created it, and the handler never fired. **Fixed in stx 0.2.504**, which
  hydrates a revealed handler in the same batch; re-measured here with the same
  three-button probe, where flipped-later now runs. `scripts/stx-gate.ts` holds
  0.2.504 as the floor rather than banning the pattern.
- A capability request that never answers is more likely a dead handler than a
  hung bridge. `secureStorage.get` was blamed for exactly this and is innocent:
  every `request()` carries a new message id and the protocol holds no cache, so
  a second `get('auth_token')` resolves normally — checked by driving two reads
  through the bridge. The missing request came from the `:if` case above, where
  the tap never ran. Screens still read a token once and keep it, because that
  is one round trip rather than two, not because a second one fails.
- No timer is promised. The bridge's own timeout is written
  `typeof globalThis.setTimeout === 'function' ? … : null`, so the framework does
  not assume one exists. A debounce that works in the test harness — which
  provides `setTimeout` — can fail on a phone, which is why the athlete search
  is a button rather than a pause in typing.
- Share the in-flight token read, not just the resolved value. Two reads started
  at mount both wanted it, and caching only the value meant the second caller
  issued its own `secureStorage.get` before the first answered. Memoize the
  promise (`resources/native/Athletes.stx`).
- A module shared with a native screen cannot use a web API. JavaScriptCore has
  no `URLSearchParams`, `URL`, `document` or `localStorage`; a shared helper
  that reaches for one throws on the phone and passes in the browser. Build
  query strings with `encodeURIComponent`.

The integration test exercises the compiled bundle itself: app-component
precedence, input mutations, the exact API payload, response handling,
push/back/replace navigation, state isolation, and teardown cancellation.
