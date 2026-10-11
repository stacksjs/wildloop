# Native screens

Wildloop's first ordinary STX native flow lives in `resources/native/`. It logs a
manual activity through the same payload builder and `/api/activities` endpoint
as the web UI, then opens the saved-activity screen with the returned id. The
screens are compiled to Craft's native document protocol; they do not use a
WebView or a second layout engine.

## Build and test

```bash
bun install
bun run build:native-screens --debug
bun test tests/unit/manual-activity.test.ts tests/unit/native-manual-activity-flow.test.ts
bun run typecheck
```

The build writes `storage/framework/native/native-screen.js`. This is generated
output and must not be committed.

## Host contract

The `manual` route requires these maintained Craft capabilities:

- `secureStorage` reads the existing `auth_token`.
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
- Native `:for` renders the shared keyed STX mutation protocol. It is not a
  React Native `FlatList`; large virtualized feeds remain host-owned work.
- Browser-only DOM APIs, CSS layout assumptions, and web component behavior are
  unsupported in native screens.

The integration test exercises the compiled bundle itself: app-component
precedence, input mutations, the exact API payload, response handling,
push/back/replace navigation, state isolation, and teardown cancellation.
