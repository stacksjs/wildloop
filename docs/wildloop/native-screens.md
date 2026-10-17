# Native screens

All 37 mobile paths in `config/mobile.ts` use Craft's native renderer on iOS
and Android. Screens live in `resources/native/`; the shared startup script is
`resources/mobile-app.ts`. Feed, Record and Menu form the native tab bar.
Legal pages and external services open in the platform browser.

The route registry is the source of truth. It covers authentication, profile
and settings, GPS recording, activities, trail discovery and detail, full-screen
maps, plans, route creation, community screens and manual activity entry. A
mobile destination must be added to that registry and compiled from STX; do
not send it to a WebView as a substitute.

## Components and capabilities

Use the published STX native primitives, Crosswind classes and Craft
capabilities. Application code owns no Swift or Kotlin generators and does not
substitute sibling SDK source. Reusable host fixes belong in STX or Craft and
must be published before the application adopts them.

- Native button labels use `title`, `:title`, direct text or `:text`. A nested
  `Text` is not a native UIButton title. Shared button colors and spacing live
  in `resources/functions/native-ui.ts`.
- Compact choices use `chooseNativeChoice` from `native-choice.ts`, which calls
  Craft's system action sheet. It preserves typed values and Cancel behavior.
  A wheel picker should be an intentional layout choice rather than the
  default for every filter.
- Maps have an explicit height or flex layout. STX 0.2.563 forwards the Map
  primitive's class to the native document; regression tests assert the actual
  emitted map height. Geometry and camera changes use native bindings.
- Trail maps use recorded geometry, direction markers, map layers and camera
  controls. The elevation card floats over the map, can collapse and uses the
  route's measured elevation profile. Unknown geometry, weather or surface
  data must be represented honestly.
- Reviews use the Stacks review actions with the authenticated actor from the
  session. The private viewer endpoint restores the current athlete's saved
  state and review independently of the public review page size.
- `native-api.ts` reads the keychain bearer and scopes its cached promise to
  the current account snapshot. Screen teardown and account changes must clear
  private state and prevent an old request from restoring another account.
  Signed-out mutations first fetch the framework CSRF cookie and echo it as
  both cookie and header; signed-in requests use the normal bearer contract.
- Native recording uses Craft location, background recording and checkpoints.
  Saving an activity must remain available when an optional Health write is
  declined. Background and locked-device behavior need physical-device tests.

Native screens use STX signals and lifecycle hooks rather than browser APIs.
JavaScriptCore has no browser DOM, `localStorage`, `URL` or `URLSearchParams`.
Shared helpers must honor that boundary. Build query strings with
`encodeURIComponent` and use Craft capabilities for storage, files, sharing,
notifications, permissions and native dialogs.

## Build and test

```bash
bun install --frozen-lockfile
bunx --bun pickier .
bun run typecheck:app
./buddy test
bun run build:ios
bun run build:android
```

`bun run build:native-screens` compiles the shared registry separately for
inspection. The mobile build generates platform projects and bundles from the
published packages. Generated host sources are build output, never patches to
maintain by hand. XcodeGen is resolved through Pantry by `./buddy setup:ios`.
Android map builds require the configured `ANDROID_MAPS_API_KEY`.

`tests/fixtures/nativeScreen.ts` runs the actual minified native bundle through
a Craft bridge fixture. It handles nodes added by keyed loops and applies
emitted prop and style patches before inspecting the current native state.
Tests should verify meaningful transitions and capability payloads, including
failed requests, account changes and declined permissions.

The initial native document can contain conditional branches before the first
mutation batch. Read the final visibility state when testing `:show`; finding
text in the initial document does not prove it is visible. Map geometry may
also arrive in a later prop patch. The native gate and compiled-screen tests
cover these boundaries.

For actual installed-app acceptance, the hosted `native-trail-ios` journey uses
the published Stacks XCTest driver against an isolated QA database. It retains
native screenshots, accessibility trees and separate XCTest results for map
and review journeys. It exercises
map controls, floating profile controls, sticky saves and review creation,
editing and deletion. See [mobile-e2e.md](../mobile-e2e.md) for local invocation
and the current acceptance status.

A green bundle test or project generation is not native visual acceptance.
Signed archives, Android maps, offline behavior, background GPS, Health, push,
and Spotlight/Siri each require their appropriate environment checks. See
[mobile-release.md](mobile-release.md) for release gates.
