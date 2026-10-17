# Native mobile release checklist

This checklist is for a signed Wildloop store candidate. It deliberately does
not treat a simulator build as evidence of production entitlement, push, or
background-location behaviour.

## Inputs

- Set `IOS_BUNDLE_ID`, `IOS_APP_VERSION`, `IOS_BUILD_NUMBER`, and
  `APPLE_TEAM_ID` for the release lane.
- Set the Android package name, version, version code, `ANDROID_MAPS_API_KEY`,
  and production Firebase configuration for the Android release lane. Restrict
  the Maps SDK key to the package and signing certificate used by that lane.
- Confirm `https://wildloop.org` is the intended mobile origin and that its
  associated-domain and app-link files cover `org.wildloop.app`.
- Create the matching identifiers and capabilities in the Apple Developer
  account before signing: associated domains, HealthKit, push notifications,
  and background location.

## App review evidence

- Record a physical-device run that starts in the foreground, locks the phone,
  returns to the app, and saves the complete route.
- Run the signed-in recording journey from a clean app state. It must cover
  authentication, location permission, start, pause, background/foreground
  continuity, cold-relaunch recovery, resume, stop, and save.
- Exercise the declined and revoked states for location, Apple Health, and
  notifications. Saving a Wildloop activity must remain available when an
  optional Apple Health write is declined.
- Verify an `https` universal link and a `wildloop://` link reach the intended
  in-app route from a cold launch.
- Verify the App Store Connect privacy answers match the generated privacy
  manifest: precise location and fitness data are linked to the user for app
  functionality and not used for tracking.

## Build checks

```bash
bunx --bun pickier .
bun run typecheck:app
buddy test
bun run build:ios
bun run build:android
```

For iOS, produce a signed archive with a distribution provisioning profile and
inspect its entitlements. The archive must contain a production APNs
entitlement. A development entitlement is valid for local testing only.

## Spotlight and Siri entries

`ios.appShortcuts` in `config/mobile.ts` declares the app's Siri/App Intents
and home-screen actions. Craft generates their Swift and restores it from the
published package during Xcode Cloud builds. Stacks declares their activity
types and the content slots from `config/spotlight.ts` in `Info.plist`.
Applications contain no Swift generator or source override.

The content-slot registry also describes device-search donations for trails,
clubs and events. Dynamic record donation still needs a native Siri capability
and its own device verification before that part of a native candidate is
considered complete.

Neither the donations nor the declarations are observable from a simulator
build's project files, so both need a device run:

- Search the app name from the home screen. The Top Hit row shows Favorites,
  Trails Near Me and View Stats, and each opens the screen it names.
- Open a trail, then search its name from the home screen. The trail must
  appear under Wildloop, and tapping it must open that trail rather than
  wherever the app was last — an entry whose activity type is not declared
  does the latter.
- Join a club and enter an event, then search each by name. Both must appear
  and open their own page. Leave the club and withdraw from the event: both
  must stop being findable, including while their page is still open.
- With more saved trails than the `trail` kind's `slots`, confirm the most
  recently saved are the ones Spotlight finds. Each kind is a fixed set of
  slots, and the oldest donation is what makes room — the same holds for clubs
  and events against their own budgets.
- Sign out, then search again. None of the previous athlete's trails, clubs or
  events may still be findable.

## Current external gates

- This migration uses Craft's native renderer for every app destination. Prior
  WebView journey results do not verify this native candidate; repeat the
  navigation, recording, offline, map and review journeys against its installed
  native bundle on both platforms.
- The published SDK map sources compile on iOS and Android. On 2026-10-17,
  Wildloop's all-native iOS app also compiled, passed code-signature
  verification, installed and launched in a fresh simulator. The local
  renderer test stalled before XCTest started, and this Mac's command-line
  Xcode installation has no Simulator desktop application available to CUA.
  Actual native visual and interaction acceptance remains pending; neither
  compilation nor compiled-screen bridge tests establish that acceptance.
- Android trail maps require the configured Maps SDK key. A missing key stops
  the Wildloop Android build rather than producing a candidate with blank maps.
- A signed physical-device archive is required to verify provisioning, APNs,
  Health, background location and real Spotlight/Siri behavior. Simulator
  compilation and bridge tests are separate evidence.
