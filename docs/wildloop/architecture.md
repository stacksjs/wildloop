# Architecture

## Main data flow

1. STX recorder gathers timestamped Geolocation samples and keeps the screen awake when supported.
2. The client writes an idempotent activity envelope with `upload_id`, `recording_source`, and `game_mode`.
3. `ActivityStoreAction` validates telemetry and derives authoritative distance, duration, pace, integrity status, and capture eligibility.
4. Eligible capture activities run the claim and conquest engines. Free/simulated/imported activities stop after activity persistence.
5. Territory reads use indexed bounds, owner privacy settings, block relationships, and batched history counts.
6. The activity and battle catalogs refresh from server aggregation rather than calculating global state from the first client page.

## Offline behavior

The service worker caches only a static offline shell and cacheable same-origin assets; it never persists navigations, API responses, private/no-store responses, or another application's cache. Trail route downloads and pending activity uploads use versioned IndexedDB stores. Reconnect flushes only uploads belonging to the current authenticated user; FIFO backoff and server upload ids reconcile retries to one activity row.

## Trail and route data

Trail detail is fetched directly by id, so a search result is deep-linkable. Missing route geometry stays missing; Wildloop never fabricates a line. Saved custom routes use verified catalog geometry, and downloaded routes remain available offline. The recorder emits a wrong-turn warning around 425 feet from the selected trail.

## Portable formats

GPX and TCX parsers retain coordinates, timestamps, and elevation. FIT decoding uses the published `ts-health`/`ts-watches` implementation and requires a valid FIT checksum. Imports are bounded, private, and non-scoring. Activity owners can export the server-returned route as escaped, standards-shaped GPX.

## Shared adapters

`app/Support/integrationAdapters.ts` is the capability registry returned by
the integration-status endpoint. Garmin Connect and COROS use `ts-watches`;
Apple Health exports and portable FIT decoding use `ts-health`. The registry
distinguishes available file/device adapters from credentialed OAuth or native
bridges so the UI never claims an integration that cannot complete.
