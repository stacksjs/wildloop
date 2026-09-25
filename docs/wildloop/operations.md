# Operations

## Database

Database migrations are never run automatically by `bun run deploy`. The
catalog lives outside release directories, and an application rollback must
not imply a schema rollback. Before an intentional schema operation, take a
verified copy of `/var/www/wildloop-shared/database/stacks.sqlite`, inspect the
production migration ledger, then run:

```bash
./buddy migrate --force
```

Never use `migrate:fresh` against production. If a migration reports an
already-existing column or index, reconcile the ledger with the live schema;
do not rerun DDL blindly or fold the repair into an application deploy.

## Scheduler

Run one scheduler process per deployment group:

```bash
./buddy schedule:run
```

The configured tasks use `onOneServer()` and `withoutOverlapping()`. On multi-host deployments, the current Stacks lock is host-local; deploy the scheduler on a singleton worker or replace the lock with a distributed implementation.

## Provider configuration

Garmin:

- `GARMIN_CLIENT_ID`
- `GARMIN_CLIENT_SECRET`
- `GARMIN_REDIRECT_URI`
- `GARMIN_WEBHOOK_SECRET`

The Garmin webhook secret must be sent in `X-Garmin-Signature` or
`X-Webhook-Secret`; query-string secrets are rejected so credentials do not
leak into access logs or browser history. Revocation pushes delete stored
connections immediately.

COROS is currently a `ts-watches` device/file adapter and requires no cloud
credentials. `ts-health` provides Apple Health export parsing and the FIT
runtime used by portable imports.

Native applications enable `APPLE_HEALTH_NATIVE_BRIDGE=true` or `HEALTH_CONNECT_NATIVE_BRIDGE=true` only after implementing the platform permission and consent flows. The web app reports these live-sync adapters as unavailable until enabled; export/file imports remain available independently.

Offline uploads retry in FIFO order with exponential backoff. After eight
failed attempts an item stays on-device as needing attention instead of
hammering the API indefinitely. Portable activity files are limited to 25 MB
and 100,000 track points.

## Verification

```bash
bunx --bun pickier .
bun run typecheck:app
./buddy test
```

Inspect `/health`, verify the scheduler logs, and exercise an offline record/reconnect before each production release.

## Frontend production path

`app/ProductionServer.ts` is the production entry point. It deliberately loads
the exact `@stacksjs/stx` and `bun-plugin-stx` versions from `package.json`
instead of the generated pantry copy. A local `~/Code/Tools/stx` checkout is
preferred only for framework development.

Wildloop pages are client-data shells, so the server compiles one render per
view source, prewarms static routes, and lets the browser cache successful HTML
briefly. STX serves Brotli/gzip documents and external cached runtime, router,
and Crosswind assets. Production pages must never contain `data-stx-hmr` or
open `/_stx/hmr`; a permanent event stream consumes a reverse-proxy upstream
connection.

After deployment, verify the production contract:

```bash
curl -sSI -H 'Accept-Encoding: br, gzip' https://wildloop.org/
curl -sS --compressed https://wildloop.org/ | grep -E 'data-stx-hmr|/_stx/hmr'
```

The first command should report `Content-Encoding: br` or `gzip`, `Vary:
Accept-Encoding`, and the short public cache policy. The second command should
print nothing. Also confirm `/_stx/runtime.js`, `/_stx/router.js`, and the
fingerprinted Crosswind stylesheet return cacheable responses.
