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

The browser checks are manually initiated test harnesses, not part of
`buddy test`. Both harnesses bind only to loopback. Their synthetic locations
must never be used against the production territory game.

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
- Rapid synthetic fixes deliberately/accidentally rejected by speed validation
  remained queued with an explicit not-yet-accepted message; they were not
  reported as server saves. These local QA rows were retained for inspection.
- Full test suite: 564 passed, zero failed. Typecheck passed. Lint had zero errors
  and six existing warnings under the vendored stacks-browse skill scripts.

One existing metric inconsistency was visible: the server derives elapsed time
from the GPS sample span but accepts the client's moving time. A short test
displayed 28 seconds moving versus 27 seconds elapsed. This needs a separate
metrics policy/test change; the recovery patch does not change server metrics.

## Physical-phone release gate

After these changes are reviewed and deployed, use a fresh account and a short,
safe walk before relying on the app for a hike. Keep an independent recording.

- Check location permission refusal, retry, GPS acquisition and visible progress.
- Walk with the screen on; pause, resume and finish. Check route and timestamps.
- Lose connectivity, finish offline, reopen, reconnect and verify exactly one
  complete activity. Do not clear site data or switch accounts during recovery.
- Check refresh/back navigation and expired-session recovery on the phone.
- Separately test locking the screen and switching apps. Document lost samples,
  browser suspension and battery behavior. Do not infer background support from
  a desktop browser test or an unlocked-screen success.
- Confirm private GPS cannot be read from another account in production.

Do not call this full hike readiness until that device evidence exists.
