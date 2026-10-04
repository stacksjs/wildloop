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

### Signing in with Google and Apple

Each provider is off until every one of its variables is set: the button is
absent from `/login` and `/register`, and its routes answer 503 rather than
sending anybody to a provider that will refuse them. Set them in
`.env.production` with `buddy env:set NAME=value --env=production` (they are
encrypted like every other value there), deploy, and the buttons appear.

Google:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — an OAuth client of type
  "Web application" in Google Cloud Console → APIs & Services → Credentials.
  Its authorized redirect URI must be exactly
  `https://wildloop.org/api/auth/google/callback`.

Apple (needs a paid Apple Developer Program membership):

- `APPLE_TEAM_ID` — the ten-character Team ID, shown under Membership details
  at developer.apple.com/account. The iOS build already reads this variable.
- `APPLE_CLIENT_ID` — the identifier of a **Services ID** (not the app's
  bundle id), e.g. `org.wildloop.signin`. Create it under Certificates,
  Identifiers & Profiles → Identifiers → Services IDs, enable Sign in with
  Apple on it, and configure it with the primary App ID, the domain
  `wildloop.org`, and the return URL
  `https://wildloop.org/api/auth/apple/callback`. Apple accepts only https
  return URLs on a verified domain, so there is no local Apple sign-in.
- `APPLE_KEY_ID` — the ten-character Key ID of a key created under Keys with
  Sign in with Apple enabled (and pointed at the same primary App ID).
- `APPLE_PRIVATE_KEY` — that key's `.p8` file, which Apple lets you download
  once. Paste the whole PEM; `\n` escapes, or the base64 body without the
  `BEGIN`/`END` lines, work too.

There is no Apple client secret to set or rotate. Apple's "secret" is a JWT
signed with that key, and the server mints a five-minute one for each sign-in
(`app/Support/appleSignIn.ts`). Revoking the key in the portal is what turns
Apple sign-in off.

People who choose "Hide My Email" get an address at
`privaterelay.appleid.com` that forwards to their own. Apple forwards only
mail from senders registered for the Services ID: add the domain and the
`MAIL_FROM_ADDRESS` under Certificates, Identifiers & Profiles → Services →
Sign in with Apple for Email Communication, or password resets and
notifications to those accounts are silently dropped.

Deleting an account revokes its Apple tokens, as Apple requires of apps that
offer Sign in with Apple. Each Apple sign-in keeps the refresh token from its
exchange, sealed with `APP_KEY`, in `user_identities.refresh_token`, and
deletion sends it to `https://appleid.apple.com/auth/revoke`
(`app/Support/appleTokens.ts`). Revoking is best effort: an Apple that cannot
be reached, or credentials removed since, is logged as `[account] could not
revoke an Apple token` and the account is deleted anyway. Rotating `APP_KEY`
makes the stored tokens unreadable, so they are logged and skipped.

An account Google or Apple created has no password anybody knows, so Settings
asks its owner to type DELETE instead, and the server accepts that only from a
session issued in the last 15 minutes (`app/Support/deletionProof.ts`).

Both providers link a sign-in to an existing account only when the provider
says it verified the address itself, and create the account only after the
token exchange succeeds, so an abandoned sign-in leaves nothing behind.

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
