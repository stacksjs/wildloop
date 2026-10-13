# Native screens

Wildloop's native screens live in `resources/native/`. Two flows so far:

- **Manual activity** — logs an activity through the same payload builder and
  `/api/activities` endpoint as the web UI, then opens the saved-activity screen
  with the returned id.
- **Records** — the public fastest-known-times board, the first list screen.
  A keyed `:for` inside a `ScrollView`, filtered server-side by style, and a
  row hands off to the web effort page through `craft.navigation.open` because
  that page is a map (craft-native/craft#340).

The screens are compiled to Craft's native document protocol; they do not use a
WebView or a second layout engine. Shared numbers come from
`resources/functions` — `manual-activity.ts` and `route-records.ts` — so a
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

The build writes `storage/framework/native/native-screen.js`. This is generated
output and is gitignored.

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
- `:if` on an interactive node does not work: the node ships in the first
  `RENDER`, nothing re-creates it when the condition turns true, and the handler
  the host holds is dead. Render buttons unconditionally and decide in the
  handler. `:if` on `Text` behaves.
- `secureStorage.get` appears to cache by argument: a second
  `get('auth_token')` never answered. Read a token once and keep it.

The integration test exercises the compiled bundle itself: app-component
precedence, input mutations, the exact API payload, response handling,
push/back/replace navigation, state isolation, and teardown cancellation.
