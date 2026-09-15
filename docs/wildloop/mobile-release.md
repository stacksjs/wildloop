# Native mobile release checklist

This checklist is for a signed WildLoop store candidate. It deliberately does
not treat a simulator build as evidence of production entitlement, push, or
background-location behaviour.

## Inputs

- Set `IOS_BUNDLE_ID`, `IOS_APP_VERSION`, `IOS_BUILD_NUMBER`, and
  `APPLE_TEAM_ID` for the release lane.
- Set the Android package name, version, version code, and production Firebase
  configuration for the Android release lane.
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
  notifications. Saving a WildLoop activity must remain available when an
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
buddy build:ios
buddy build:android
```

For iOS, produce a signed archive with a distribution provisioning profile and
inspect its entitlements. The archive must contain a production APNs
entitlement. A development entitlement is valid for local testing only.

## Current external gates

- Current Craft generation writes the development APNs entitlement whenever
  push notifications are enabled. Do not ship push until Craft supports a
  production entitlement in its release configuration.
- Android runtime permission parity remains gated on the open Craft location
  permission issue. Static project generation is not substitute evidence for a
  device run.
- A current iPhone 17 Pro Simulator build has passed navigation, offline
  fallback, and custom deep-link journeys. This is useful device evidence, but
  it is not a substitute for a signed physical-device archive.
