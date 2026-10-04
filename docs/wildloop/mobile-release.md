# Native mobile release checklist

This checklist is for a signed Wildloop store candidate. It deliberately does
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
buddy build:ios
buddy build:android
```

For iOS, produce a signed archive with a distribution provisioning profile and
inspect its entitlements. The archive must contain a production APNs
entitlement. A development entitlement is valid for local testing only.

## Spotlight and Siri entries

The app's shortcuts and its own content — trails, clubs, events — are donated
as `NSUserActivity` objects through Craft's `siri` bridge, and `buddy
build:ios` declares their activity types in the generated `Info.plist`
(`scripts/generate-ios-shortcuts.ts`). What gets indexed, how many of each, and
where a tapped entry opens is `config/spotlight.ts`; adding a kind is an entry
there and nothing else.

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

- Craft v0.0.91 selects the APNs entitlement from the build configuration:
  Debug uses development and Release uses production. A signed Release archive
  is still required to verify the entitlement with the Apple provisioning
  profile before submission.
- Android runtime permission parity remains gated on the open Craft location
  permission issue. Static project generation is not substitute evidence for a
  device run.
- A current iPhone 17 Pro Simulator build has passed navigation, offline
  fallback, and custom deep-link journeys. This is useful device evidence, but
  it is not a substitute for a signed physical-device archive.
- Craft exposes no CoreSpotlight API at the pinned revision, so a record is
  indexed as a donated activity under one of its kind's fixed slots rather
  than as a searchable item of its own. iOS hands a tapped activity back only
  for a type the `Info.plist` declares, and a type per record id cannot be
  declared, so raising a kind's `slots` in `config/spotlight.ts` is the only
  way to widen its index.
