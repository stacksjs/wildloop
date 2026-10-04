# Territory game rules

## Eligible activities

Only a live GPS activity (`web_gps` from the browser recorder, `native_gps` from the app) recorded in `capture` mode can score. The server requires at least 20 ordered samples, at least two minutes and 100 metres, recent completion, timestamps on every sample, and device accuracy of 75 metres or better on at least 80% of samples.

Manual activities, route previews/simulations, imported files, Garmin summary-only webhooks, and free runs are deliberately non-scoring. They remain useful activity records.

## Integrity

Eligibility is decided server-side from the telemetry. Client distance, duration, and capture claims are never trusted.

The checks divide into three, and the division matters: **what is impossible is refused, what is improbable is flagged, and nothing is refused on a statistic alone.** A legitimate athlete wrongly refused is a worse failure than a cheat getting through, because the athlete is real and is right.

### Refused — physically impossible

Every fix is a guess with a radius, so "impossible" means impossible **even after each fix is allowed two of its own reported accuracy radii of error** (5 m when the device reports none; altitude gets half as much again, being worse than position). Raw consecutive fixes are never compared as if they were exact: two honest fixes ten metres out in opposite directions, a second apart, would read as a 20 m/s sprint.

- **Burst speed** over 14 m/s on foot or 30 m/s on a bike. Faster than any sprinter, and a fast descent respectively. Checked step by step and, because a fix's error is mostly shared with the next one, also end to end over every span of about ten seconds — which is what refuses a car recorded at one fix a second.
- **Sustained pace** faster than a body holds for that long. Checked over every window of five minutes or more against a curve anchored to world records with 25% headroom. A per-sample cap alone permits 11 m/s held for twenty minutes — under the old limit, and a car in traffic.
- **Acceleration** over 12 m/s², on the least change of speed the fixes' error allows. Several times what a sprinter manages; it is there to catch a track assembled from waypoints, where speed jumps between legs with nothing in between.
- **Vertical speed** over 6 m/s. Faster than any trail, up or down. Step by step and over ten-second spans, like burst speed.
- **Non-monotonic or missing timestamps**, two different places at the same moment, coordinates off the globe, and GPS jumps over 2 km in an untimed track.

### Dropped — GPS glitches

A receiver throws a fix or a few out and recovers: multipath off a cliff, a phone that has not settled at the start, an altitude blip, a fix delivered twice. Those are dropped rather than refusing the run: a fix that cannot be reached from the last good one is a glitch when, within three fixes, the track comes back to somewhere that can. A jump the track never comes back from is not a glitch and is judged as a step.

Dropped fixes are removed from the **stored** track as well as from the checks, and the territory engine reads only the stored track, so a "glitch" can never draw or win ground. A run that needed more than 10% of its fixes dropped is kept in the log but does not capture: the line it would draw is a guess. Dropped fixes are noted for reviewers (`gps_fixes_dropped`, weight 0).
- **A duplicate trace.** Two recordings of the same route never agree to five decimal places at every sample, so a fingerprint match is a replay — the athlete's own, or somebody else's.
- **An overlap with another scoring activity.** Nobody is in two places at once.

Curves differ by activity: a 10 m/s bike ride is an ordinary club pace and refused as a run.

### Flagged — improbable, for a person to decide

Signals that a track was constructed rather than recorded. A real receiver samples at irregular intervals, reports an accuracy that moves as satellites do, and produces a pace that wanders; generated tracks tend to be regular in all three. Each is individually explainable by an unusual but genuine run, which is why none of them refuses anything:

- uniform sample interval, uniform speed, constant or quantised accuracy
- no accuracy reported at all
- geometry lying on near-perfect straight legs
- a single altitude for the whole track
- **impossible transit** between two activities — flagged rather than refused, because a wrong clock is likelier than a fraud

These sum to an anomaly score from 0 to 1. At 0.6 or above, or on any cross-activity finding, the capture stands and the activity enters the review queue.

### Review

`GET /api/admin/integrity-queue` lists flagged captures worst first, with the evidence behind each. `POST /api/admin/integrity-review/{id}` clears or upholds one; upholding strips eligibility and requires a reason, which the athlete is notified of. Clearing does not grant eligibility a track never had — a capture refused by the physics checks is not made legitimate by a reviewer deciding its statistics were innocent.

Evidence is stored on the activity (`anomaly_score`, `integrity_flags`, `track_fingerprint`, `review_state`) rather than recomputed, because the neighbouring activity that produced a finding may since have been deleted.

## Claims

A new claim must form a loop whose endpoints are within 50 metres. It must enclose between 1,000 and 5,000,000 square metres, avoid existing active/contested territory, and avoid the athlete's protected home zone (measured to the outline's edges, not only its vertices). Claim creation, history, XP, and holding counters commit in one serializable transaction.

"Enclose" is the non-zero winding rule: the ground the loop goes around at least once. Two laps of a park claim the park once, and both lobes of a figure of eight count. Containment checks (overlap, home zone, battles) use the same rule.

A claim is named after the nearest town in the gazetteer ("Silver Lake Loop", "Silver Lake Loop 2"). A refused claim says why, and the recorder shows that reason when the run fought no battle.

## Battles

An eligible route intersecting another athlete's territory creates one of these outcomes:

- `conquered`: a complete takeover of a small territory.
- `split`: the defender keeps the larger portion and the attacker receives a valid smaller portion.
- `contested`: an intersection or sliver too small to capture.
- `defended`: the owner traverses contested territory.

A focus target restricts processing to the selected territory. Land an attacker would win that reaches into their own protected home zone is not handed over: the attack stands as `contested`.

Every persisted battle is exposed by the battle feed, which clients refresh every 15 seconds. A split is one battle on the feed (the `split` and `conquered` history rows are folded together), and each row carries its territory's centre so clients can show the battles near a player.

## Where the game is shown

The territory map and the record screen open on the player's own area: the remembered or edge-guessed location from `useNearby`, never a permission prompt. The map API answers only the bounding box it is asked for, `GET /api/territories/leaderboard` ranks the holders inside a box when given one, and `GET /api/territories/{id}` serves one territory with the same outline privacy as the map.

## Decay and ranks

Territory ranks recompute hourly. Decay runs daily at 03:10 UTC and counter repair at 04:10 UTC. Scheduler tasks use overlap locks and the HTTP maintenance routes require the admin role.

