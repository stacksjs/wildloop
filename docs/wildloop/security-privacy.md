# Security and privacy

## Identity and authorization

The browser stores a bearer token and a rendering cache of the last verified user. Every app load resolves the token through `/api/me`; an expired token clears the cache. The server derives every write actor from `Auth.user()`. Client-provided user ids exist only for in-process test harnesses.

Full-table maintenance endpoints require both authentication and the `admin` role. Social writes verify that the activity is visible before accepting kudos or comments.

## Location safety

New accounts default to followers-only activities, 400 metres of route masking at both endpoints, a 500 metre protected-home radius, no game territory within that radius, and coarse public territory geometry. Owners always see their own exact activity route.

The protected location is optional and stored separately from public profile data. It is never returned by public endpoints.

## Abuse controls

Blocks are mutual for reads and interactions. Creating a block removes existing follow relationships. Reports support users, activities, comments, trail reviews, and territories with deduplication and a moderation lifecycle (`open`, `reviewing`, `resolved`, `dismissed`).

## Integrity model

Browser GPS is not cryptographic attestation. Wildloop therefore combines source provenance, monotonic sample timestamps, accuracy quality, speed thresholds, completion recency, server-derived distance/duration, idempotent uploads, and non-scoring defaults for imports. Suspicious tracks are rejected; incomplete tracks can be saved as unverified but never score.

