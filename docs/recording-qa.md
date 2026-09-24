# Mobile-web recording verification

## Scope and readiness

The September 24, 2026 local checks below used a fresh SQLite database, fictional
accounts and synthetic GPS. They do not certify real-phone GPS accuracy, battery
life, screen-lock recording, background recording, or production deployment.
Keep the web recorder visible with the screen unlocked. Use one recording tab.

## What changed

- Device storage reports success only after the IndexedDB transaction commits.
  Missing storage or a rolled-back write is an error, not an offline save.
- Finish freezes the track, finish time and upload ID. If neither the server nor
  offline queue accepts it, the recorder retains it and offers **Retry saving**.
- A finished checkpoint reopens as a pending upload, not a running GPS session.
  The upload ID is assigned at Start and survives checkpoint recovery.
- Start waits for recovery checks and does not replace an unfinished checkpoint.
  Old checkpoints are retained rather than discarded after 24 hours.
  Concurrent sign-in and Start callbacks cannot install multiple GPS watchers.
- Link/history navigation, closing the page and app logout are guarded while a
  web recording or unsaved finished track is active. A browser may still kill a
  tab without an unload warning. Future programmatic exits must call
  `requestRecordingExit`; this is not a framework-wide router hook.
- Activity options expose Hike, Walk, Bike and Trail Run. A trail guide is not
  selected implicitly, preventing unrelated wrong-turn warnings.
- New uploads cap moving time at the server's elapsed duration. For live GPS,
  the GPS sample span is authoritative, not the submitted timer. Paused/zero
  moving time is preserved. Existing historical rows are not rewritten.
- Recovering a resumed recording keeps its pause-aware moving clock. Reloading
  no longer turns a previous break into moving time.
- Permanent HTTP refusals stop automatic retries immediately. The Record page
  shows the API's validation reason and owner-scoped export/retry controls.
  Export is a lossless JSON backup, including precise GPS, not a GPX import file.
  It does not delete the local recording. Keep exported files private.
- Session expiry (401), timeouts (408), rate limits (429), network and server
  failures remain retryable. A rejected manual retry parks the recording again.

## Repeatable local checks

Use the repository-pinned Bun (`./pantry/.bin/bun`, 1.3.14 for this verification).
No test harness should be deployed or pointed at a production database.

1. Create a temporary SQLite database with the app migrations. Launch `buddy dev`
   with `STACKS_NO_NATIVE=1`, `APP_ENV=local`, `DB_CONNECTION=sqlite`, an explicit
   temporary `DB_DATABASE_PATH`, `MAIL_MAILER=log`, `APP_URL=http://127.0.0.1:4320`,
   `PORT=4320`, `PORT_API=4321`, and `PORT_BACKEND=4321`.
2. Run `./pantry/.bin/bun --no-env-file scripts/test-recording-api.ts`.
   It targets the API on loopback port 4321, creates local-only accounts, and
   tests signup/login, saving and retrieving GPS, retry deduplication, ownership,
   private-read/edit denials, unauthenticated writes and malformed uploads.
   It prints no session tokens. QA accounts and activities remain in the
   temporary database for inspection.
3. Run `./pantry/.bin/bun --no-env-file scripts/test-recording-browser.ts` and
   open `http://127.0.0.1:4319`. Click **Run storage tests**. This isolated origin
   uses real IndexedDB with deliberate transaction aborts, not a fake database.
   The harness also tests HTTP 401/422 retention and navigation guards.
4. Run `./pantry/.bin/bun --no-env-file scripts/test-recording-app.ts` and open
   `http://127.0.0.1:4322` at a 390 x 844 viewport. This loopback-only proxy injects
   synthetic GPS and upload/queue failure controls into the real app. Register
   a fictional local account. Choose Hike and Only me in Record options.
5. Start and advance GPS, leaving at least two seconds between synthetic fixes
   so rapid test clicks do not trip the API's acceleration checks.
   Trying to leave via Feed must keep Record open. Finish
   with both **Fail uploads** and **Fail queue** enabled: expect a clear error,
   **Retry saving**, and no Start control. Open Record in a fresh tab on the same
   origin: expect the finished track to recover without restarting GPS. Retry
   with failures disabled and verify the profile and activity detail. Retrying
   from the first tab must return the same activity rather than add another.
6. Repeat with only **Fail uploads** enabled. Expect a device-only save. Disable
   the fault and reopen the page. Allow the queue's retry delay to elapse and
   verify automatic upload. An offline save is not yet a server save.
   During another recording, use **Expire session**, then Finish: the in-place
   sign-in gate must open, preserve the track and finish after the owner signs in.
   Also pause before expiry, close the tab, reopen Record, and sign in via Start.
   **Advance GPS** should report exactly one watcher after recovery, not two.
7. Run the regular checks with pinned Bun on PATH: `./buddy test`,
   `bun run typecheck:app`, and `bunx --bun pickier .`.

### Automated browser suite

The CI workflow includes a `recording-browser` job, so its failure blocks the
CI-gated deployment. It uses Chromium at 390 x 844, a fresh temporary SQLite
database, log-only mail and fictional accounts. The Playwright dependency and
lockfile live under `tests/browser` without changing the app's dependency tree.

From `tests/browser`, with Bun on PATH:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run test
```

The suite starts its own servers on ports 4319, 4320, 4321 and 4322. They must be
free. `RECORDING_QA_REUSE=1` is only for reusing the isolated local QA app described
above, never a normal developer database. Test accounts remain in the temporary
database. CI uploads failure traces for seven days; they contain only QA data.

These browser checks are separate from `buddy test`. The fault-injection
harnesses bind only to loopback. Synthetic locations must never be used against
the production territory game. Browser automation does not replace real-phone QA.

The suite also covers permission denial followed by retry, too few GPS samples,
pause/resume across reload, one recovered GPS watcher, expired-session in-place
login, and a browser-wide network outage followed by automatic upload of the
unchanged saved payload. Recording-page tests fail on uncaught client runtime errors.

### Framework compatibility

The earlier STX 0.2.300 import-transform failure is tracked in
[stacksjs/stacks#2787](https://github.com/stacksjs/stacks/issues/2787).
A clean frozen install of the main branch's STX 0.2.303 passes the recording
browser tests, including activity-detail hydration. The pending local 0.2.300
patch was not shipped: the newer release preserves import-line boundaries and
does not need that workaround. No new dependency or lockfile change is required.

## Observed results

- Fresh-account browser registration/login succeeded.
- A Hike survived failed upload plus failed queue, recovered in another page,
  saved successfully, and appeared in profile and activity detail with its GPS.
- Replaying that finished hike returned one database row with the same upload ID.
- A second hike saved to IndexedDB and uploaded automatically after reconnection.
- Finishing with only one GPS sample retained the active recording and explained
  the problem. Collecting another sample allowed saving.
- Browser storage harness and direct API smoke test passed.
- Expired-session Finish opened in-place sign-in and saved afterward. Reopening
  a paused checkpoint through the sign-in gate installed exactly one GPS watcher.
- Rejected uploads survive reload, expose the server reason, export intact GPS,
  and upload successfully after an explicit retry with the original upload ID.
- Browser storage tests cover repeated rejection, owner isolation, lossless
  export and removal only after confirmed server acceptance.
- The API regression submits 40 seconds elapsed and 35 seconds moving against a
  30-second GPS span. Both stored/retrieved times are 30 seconds. Shorter, zero
  and omitted moving times are also covered.
- Full test suite: 633 passed, zero failed. Typecheck passed. Lint had zero errors
  and six existing warnings under the vendored stacks-browse skill scripts.
- Full mobile-width Chromium suite: 13 passed, including the recording/API/
  storage checks and existing planning/navigation regressions. The moving-clock
  regression was also run against the original faulty code and failed as expected.

The API's elapsed-time-based pace policy is unchanged. No historical activity
metrics were migrated by these fixes.

## Physical-phone release gate

After these changes are reviewed and deployed, use a fresh account and a short,
safe walk before relying on the app for a hike. Keep an independent recording.

- Check location permission refusal, retry, GPS acquisition and visible progress.
- Walk with the screen on; pause, resume and finish. Check route and timestamps.
- Lose connectivity, finish offline, reopen, reconnect and verify exactly one
  complete activity. Do not clear site data or switch accounts during recovery.
- Start the page while online before that test. Cold-starting the app or loading
  maps without a connection is a separate, unverified capability. Device-only
  recordings can be lost if browser storage is cleared or evicted.
- Check refresh/back navigation and expired-session recovery on the phone.
- Separately test locking the screen and switching apps. Document lost samples,
  browser suspension and battery behavior. Do not infer background support from
  a desktop browser test or an unlocked-screen success.
- Confirm private GPS cannot be read from another account in production.

Do not call this full hike readiness until that device evidence exists.
