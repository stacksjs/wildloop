# Native screens

Wildloop's native screens live in `resources/native/` and are promoted **per
path** in `ios.nativeScreens` (`config/mobile.ts`):

```ts
nativeScreens: {
  '/athletes': 'Athletes',
  '/events': 'Events',
  '/records': 'Records',
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
  row hands off to the web effort page through `craft.navigation.open` because
  that page is a map (craft-native/craft#340).
- **Trails** — the catalog, and the first screen that draws something. Each row
  carries its route as a real SVG polyline, projected by the same
  `routeShapeFor` the website uses, so a line is never a square thumbnail
  stretched into a strip.

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

## Current boundaries

- The native routes cover manual activity entry and its saved confirmation, not
  GPS recording, maps, media upload, authentication, or the full activity feed.
- **The map renders but cannot be fed.** craft-native 0.0.174 draws `Map` with
  `MapPolyline`, `MapMarker` and `fitToBounds` on both hosts, and stx 0.2.520
  compiles all three. A bound `:geometry` is dropped by the compiler, though —
  no prop, no binding, no manifest entry, no diagnostic (stacksjs/stx#2073) —
  so a route that comes from the API never reaches the map. Only a
  compile-time-constant geometry survives. The trails screen draws its line as
  an SVG polyline instead, where `:points` does bind; when #2073 lands, that is
  the screen to move onto a real map.
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
