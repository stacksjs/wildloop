# Mobile end-to-end tests

WildLoop uses one Maestro flow suite against deterministic bundled builds of
the shared STX application. The flows exercise the real Craft iOS and Android
hosts, WebView navigation, native deep-link delivery, permissions, and offline
cold starts. Android airplane mode is enforced by the flow; iOS verifies the
bundled cold-start path because iOS Simulator does not expose airplane mode.

## Prerequisites

- Bun 1.3 or newer
- Java 17 or newer and Maestro CLI 2.8.0
- For iOS: Xcode, XcodeGen, and an installed iPhone Simulator
- For Android: Android SDK tools and exactly one running emulator

### Install the local iOS test tools

Install XcodeGen and a Java 17 runtime, then use Maestro's mobile CLI
installer:

```bash
brew install xcodegen openjdk@17
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
curl -fsSL "https://get.maestro.mobile.dev" | bash
maestro --version
```

Do not use `brew install maestro` for this suite. That cask installs a
different desktop application, not the `mobile-dev-inc/Maestro` CLI used by the
flows and CI.

## Test on a physical iPhone

One-time Apple setup is required before macOS can sign an app for a phone:

1. Open Xcode, accept its license, and add the Apple developer account under
   **Xcode > Settings > Accounts**.
2. Connect and unlock the iPhone, trust the Mac, and enable Developer Mode on
   the phone.
3. Install XcodeGen (`brew install xcodegen`) if it is not already available.

Then build a Release app, sign every embedded target, install it, and open it:

```bash
./buddy preview:iphone
```

The default device build connects to `https://wildloop.org` and retains the
current `dist` output as its offline cold-start fallback. To make `dist` the
primary content source and test the exact local commit without a server:

```bash
./buddy preview:iphone --bundled
```

The command discovers a single connected iPhone and an unambiguous Apple
Development team automatically. Set `APPLE_TEAM_ID` when several teams are
installed, and `IOS_DEVICE_ID` when several phones are connected. Generated
device products live under `storage/framework/runtime/ios-device/`.

To validate the complete arm64 iPhone product without signing or connecting a
phone, including the Live Activity extension, watch app, bundled frontend, and
property lists:

```bash
./buddy build:iphone
```

After installation, exercise the real-device-only surfaces that simulators
cannot faithfully reproduce:

- Start a recording, accept When In Use location access, lock the screen, walk
  a short loop, reopen WildLoop, and stop/save the activity.
- Confirm the Live Activity updates while recording and the route survives a
  background/foreground transition.
- Open `wildloop://record` from Safari and confirm it reaches Capture Run.
- Disable Wi-Fi and cellular data, force-quit, relaunch, and confirm the bundled
  feed and recorder fallback remain usable.
- Confirm selection haptics, native sharing, file import, Health access, push
  permission handling, and Watch recording controls.

Maestro currently supports automated iOS runs on Simulators, not physical
iPhones. The checked-in simulator suite therefore remains the repeatable UI E2E
gate, while the commands above make the signed phone build and the small set of
hardware-only checks reproducible.

## Run locally

To build, install, and open WildLoop for hands-on testing without running the
automation suite:

```bash
bun run preview:ios
bun run preview:android
```

The iOS command boots an available iPhone Simulator and opens the app. The
Android command installs and opens it on the single attached emulator or
device. Both use a fresh bundled build of the current STX source, so developers
never accidentally inspect the deployed website instead of their local code.

To run the automated journeys:

```bash
bun run test:e2e:ios
bun run test:e2e:android
```

The runner discovers the sibling `../../Tools/craft` checkout automatically.
Set `CRAFT_IOS_SRC` or `CRAFT_ANDROID_SRC` when Craft lives elsewhere. Use
`MOBILE_E2E_APP` with `--skip-build` when invoking the runner directly to
install an already-built `.app` or APK while retaining the same flows.

`MOBILE_E2E=1` changes only the generated test projects: they load `dist`
instead of the production URL, so the binary under test is the exact commit and
offline behavior is deterministic. JUnit reports, per-screen screenshots (including
the expected sign-in gate for protected settings), and
diagnostics are written below `storage/framework/runtime/e2e/`.

The `Mobile E2E` GitHub Actions workflow runs both platforms and uploads those
diagnostics even when a flow fails.
