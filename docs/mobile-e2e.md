# Mobile end-to-end tests

Every Wildloop mobile destination is a Craft native screen compiled from STX.
The iOS and Android builds use the frozen published Stacks, STX and Craft
packages. Tests must verify the installed native bundle, rather than the web
pages that preceded this migration.

## Prerequisites

- Bun 1.3 or newer, Java 17 or newer, and Maestro CLI 2.8.0.
- For iOS: Xcode and an installed iPhone simulator runtime. Run
  `./buddy setup:ios` to install the configured XcodeGen through Pantry.
- For Android: Android SDK tools, one running emulator, and a configured
  `ANDROID_MAPS_API_KEY` restricted to the app package and signing certificate.

Install the Maestro CLI from its official mobile-dev-inc/Maestro release.
The workflows verify the archive's checksum. The similarly named desktop
application is a different product.

## Local builds and journeys

```bash
bun run preview:ios
bun run preview:android
bun run test:e2e:ios
bun run test:e2e:android
```

The runner generates and compiles the app, installs it, and checks its native
renderer, screen registry, compiled bundle and published builder provenance.
It does not discover or substitute a sibling SDK checkout. Use
`MOBILE_E2E_APP` with `--skip-build` only to test an existing native product.

Screens always ship in the app. `MOBILE_URL` selects their API origin, with
`https://wildloop.org/feed` as the default. For an iOS preview against an
isolated local QA server:

```bash
bun run preview:ios -- --server=http://127.0.0.1:6320
```

The signed-in iOS journey requires `MOBILE_E2E_SIGNED_IN=true`,
`MOBILE_E2E_URL`, `MOBILE_E2E_EMAIL` and `MOBILE_E2E_PASSWORD`. Use a disposable
account on its isolated QA server. It covers login, recording controls,
checkpoint recovery, and saving. This journey must pass on the actual native
candidate before release.

Maestro reports and screenshots are written below
`storage/framework/runtime/e2e/`. The `Mobile E2E` workflow retains diagnostics
when a flow fails. `@stacksjs/mobile/testing` also supplies a package-owned
XCTest driver for native accessibility trees, screenshots, interaction scripts
and physical-device attachments; applications contain no Swift test generator.

`native-trail-ios` in the hosted workflow creates its own simulator and runs
`scripts/run-native-trail-e2e.ts`. Its map, review editing, review deletion,
sharing, export, planner and location phases use a fresh QA database to
exercise map cameras and layers, floating elevation controls, sticky saves,
and review creation, editing and deletion. Sharing checks the owned simulator
clipboard after the real share-sheet Copy action. Export checks the GPX written
inside the actual app container against the seeded route coordinates.
Location uses a public seeded trailhead on the owned simulator and accepts the
real system permission prompt; it does not grant permission through `simctl`.
Review deletion remains observable if editing fails, and any failed phase keeps
the aggregate red. Screenshots, driver logs
and XCTest results are retained separately for each journey. To run it locally, explicitly supply an owned, booted simulator:

```bash
QA_PORT_BASE=6320 NATIVE_QA_DEVICE=<simulator-udid> bun scripts/run-native-trail-e2e.ts
```

Its QA ports must be free. The caller retains ownership of the simulator;
the runner shuts down only the QA server it starts.

## Physical iPhone

Connect and unlock the iPhone, trust the Mac, enable Developer Mode, and add the
Apple developer account in Xcode. Then run:

```bash
bun run preview:iphone
bun run check:iphone
```

Set `APPLE_TEAM_ID` or `IOS_DEVICE_ID` when selection is ambiguous. The preview
uses the production API unless an HTTPS `--server` is specified; a phone cannot
use this Mac's localhost. `--personal-team` omits entitlements a free Apple team
cannot sign. The legacy `--bundled` flag remains accepted; native screens are
always bundled.

After installation, verify background and locked-screen route continuity,
Live Activities, checkpoint recovery, native sharing and file picking, Health,
notifications, deep links, and declined permissions. Watch support is currently
disabled in the app configuration. A simulator compile does not verify these
hardware and provisioning behaviors.

## Acceptance status

The native source, compiled-screen bridge tests and iOS app compilation pass.
The [hosted ec81 acceptance run](https://github.com/stacksjs/wildloop/actions/runs/39079831688)
passed actual installed-app map layers/camera/profile controls, sticky save and
unsave, GPX export with recorded coordinates, and native route customization.
It created a review successfully, then failed to focus the reopened editor.
Share-sheet presentation passed, but clipboard content verification failed and
requires its diagnostic follow-up. Neither edit/delete acceptance nor sharing
completion may be inferred from those partial results.

The [03b2074e iOS navigation smoke](https://github.com/stacksjs/wildloop/actions/runs/39081855451)
passed using actual native tab controls. The native direction-marker rendering,
hidden-modal keyboard focus and absolute-view minimum-size fixes are in Craft's
QA branch; they must pass their genuine host gates and reach a normal published
SDK before Wildloop adopts them. No application source override is permitted.
The [Craft UIKit run at 434f1c7a](https://github.com/craft-native/craft/actions/runs/39082217873)
passed all 140 tests, including those three regressions. Its overall source CI
still stops at Pantry 0.11.91's Linux Git catalog validation before the Android
emulator starts; this is not a green SDK release candidate.
Native offline and full review-lifecycle acceptance remain open. Android
currently cannot build without its Maps SDK key.
The airplane-mode flow is intended to enforce Android network isolation;
iOS offline behavior also needs explicit network-isolation evidence before it
can be considered verified. See `docs/wildloop/mobile-release.md` for the
remaining release gates. Do not infer a device pass from a build or a prior
WebView run.
