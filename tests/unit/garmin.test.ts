import { createHash } from 'node:crypto'
import { describe, expect, it, spyOn } from 'bun:test'
import {
  buildAuthorizeUrl,
  createPkcePair,
  evaluateImportedAthletes,
  extractDisconnects,
  extractSummaries,
  isConfigured,
  mapActivity,
  toActivityType,
  toDurationString,
  isAuthenticWebhook,
  OAUTH_STATE_TTL_MS,
  openOAuthState,
  sealOAuthState,
  toPacePerMile,
} from '../../app/Actions/Garmin/garmin'

describe('toActivityType', () => {
  it('maps the Garmin types WildLoop records', () => {
    expect(toActivityType('TRAIL_RUNNING')).toBe('Trail Run')
    expect(toActivityType('RUNNING')).toBe('Trail Run')
    expect(toActivityType('HIKING')).toBe('Hike')
    expect(toActivityType('WALKING')).toBe('Walk')
    expect(toActivityType('MOUNTAIN_BIKING')).toBe('Bike')
  })

  it('refuses types that are not a trail activity', () => {
    // Filing a yoga session as a trail run is worse than not importing it:
    // it quietly corrupts totals and leaderboards.
    expect(toActivityType('YOGA')).toBeNull()
    expect(toActivityType('POOL_SWIMMING')).toBeNull()
    expect(toActivityType('INDOOR_CARDIO')).toBeNull()
    expect(toActivityType(undefined)).toBeNull()
  })

  it('is case-insensitive, since the wire format has varied', () => {
    expect(toActivityType('trail_running')).toBe('Trail Run')
  })
})

describe('toDurationString', () => {
  it('uses MM:SS under an hour and H:MM:SS beyond it', () => {
    expect(toDurationString(35 * 60 + 35)).toBe('35:35')
    expect(toDurationString(3 * 3600 + 25 * 60 + 48)).toBe('3:25:48')
  })

  it('zero-pads so the value sorts and reads correctly', () => {
    expect(toDurationString(3600 + 5 * 60 + 3)).toBe('1:05:03')
    expect(toDurationString(65)).toBe('1:05')
  })

  it('copes with nothing at all', () => {
    expect(toDurationString(undefined)).toBe('0:00')
    expect(toDurationString(0)).toBe('0:00')
  })
})

describe('toPacePerMile', () => {
  it('converts metres and seconds into minutes per mile', () => {
    // 1609.344 m in 600 s is exactly 10:00 per mile.
    expect(toPacePerMile(1609.344, 600)).toBe('10:00')
  })

  it('returns null rather than Infinity for a zero-distance activity', () => {
    // The feed would otherwise render "Infinity:NaN".
    expect(toPacePerMile(0, 600)).toBeNull()
    expect(toPacePerMile(1000, 0)).toBeNull()
  })

  it('rejects a pace that means the watch was left running', () => {
    expect(toPacePerMile(10, 36000)).toBeNull()
  })
})

describe('mapActivity', () => {
  const summary = {
    summaryId: 'x45e31a7-63e3d510-6',
    activityType: 'TRAIL_RUNNING',
    activityName: 'Morning Trail Run',
    startTimeInSeconds: 1_675_875_600,
    startTimeOffsetInSeconds: -18_000,
    durationInSeconds: 3600,
    distanceInMeters: 16_093.44, // exactly 10 miles
    totalElevationGainInMeters: 304.8, // exactly 1000 feet
    averageHeartRateInBeatsPerMinute: 148,
    deviceName: 'Forerunner 965',
  }

  it('converts metres to the miles and feet the model stores', () => {
    const mapped = mapActivity(summary)!

    // Garmin reports metric throughout; the model and UI are imperial.
    // Getting this backwards would not error, it would log a 5 km run as 5 mi.
    expect(mapped.distance).toBe(10)
    expect(mapped.elevation).toBe(1000)
  })

  it('formats duration and pace the way the rest of the app does', () => {
    const mapped = mapActivity(summary)!

    expect(mapped.duration).toBe('1:00:00')
    expect(mapped.pace).toBe('6:00')
  })

  it('records when the activity finished, not when it started', () => {
    const mapped = mapActivity(summary)!

    expect(mapped.completed_at).toBe(new Date((1_675_875_600 + 3600) * 1000).toISOString())
  })

  it('imports as private, so a sync never publishes someone by default', () => {
    expect(mapActivity(summary)!.visibility).toBe('private')
  })

  it('keeps the name, device and heart rate as context', () => {
    const notes = mapActivity(summary)!.notes!

    expect(notes).toContain('Morning Trail Run')
    expect(notes).toContain('Forerunner 965')
    expect(notes).toContain('148')
  })

  it('skips an activity type WildLoop does not record', () => {
    expect(mapActivity({ ...summary, activityType: 'YOGA' })).toBeNull()
  })

  it('skips a multisport parent, whose distance its children already carry', () => {
    expect(mapActivity({ ...summary, isParent: true })).toBeNull()
  })

  it('handles a summary with almost nothing on it', () => {
    const mapped = mapActivity({ summaryId: 'a', activityType: 'WALKING' })!

    expect(mapped.activity_type).toBe('Walk')
    expect(mapped.distance).toBe(0)
    expect(mapped.pace).toBeNull()
    expect(mapped.elevation).toBe(0)
  })
})

describe('createPkcePair', () => {
  it('derives the challenge as the S256 hash of the verifier', () => {
    const { verifier, challenge } = createPkcePair()

    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('stays inside the length RFC 7636 allows', () => {
    const { verifier } = createPkcePair()

    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('is different every time, or it would not be protecting anything', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })
})

describe('buildAuthorizeUrl', () => {
  it('sends the challenge, never the verifier', () => {
    const url = new URL(buildAuthorizeUrl({
      authorizeEndpoint: 'https://connect.garmin.com/oauth2Confirm',
      clientId: 'abc',
      redirectUri: 'https://wildloop.org/api/garmin/callback',
      state: 'state-123',
      challenge: 'challenge-456',
      scope: 'ACTIVITY_EXPORT',
    }))

    expect(url.searchParams.get('code_challenge')).toBe('challenge-456')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('state-123')
    // The verifier must never appear in a URL the browser can see.
    expect(url.toString()).not.toContain('code_verifier')
  })

  it('encodes the redirect uri rather than corrupting the query string', () => {
    const url = buildAuthorizeUrl({
      authorizeEndpoint: 'https://connect.garmin.com/oauth2Confirm',
      clientId: 'abc',
      redirectUri: 'https://wildloop.org/api/garmin/callback?x=1',
      state: 's',
      challenge: 'c',
    })

    expect(new URL(url).searchParams.get('redirect_uri')).toBe('https://wildloop.org/api/garmin/callback?x=1')
  })
})

describe('isConfigured', () => {
  it('is false until Garmin has issued credentials', () => {
    expect(isConfigured({})).toBe(false)
    expect(isConfigured({ clientId: 'abc' })).toBe(false)
    expect(isConfigured({ clientId: 'abc', clientSecret: 'shh' })).toBe(true)
  })
})

describe('extractSummaries', () => {
  it('reads the documented envelope', () => {
    const summaries = extractSummaries({ activities: [{ summaryId: 'a' }, { summaryId: 'b' }] })

    expect(summaries).toHaveLength(2)
  })

  it('also accepts a bare array, which Garmin has posted historically', () => {
    expect(extractSummaries([{ summaryId: 'a' }])).toHaveLength(1)
  })

  it('drops entries with no summaryId, since it is the idempotency key', () => {
    const summaries = extractSummaries({ activities: [{ summaryId: 'a' }, { activityType: 'RUNNING' }] })

    expect(summaries).toHaveLength(1)
  })

  it('returns nothing for a shape it does not recognise, rather than throwing', () => {
    expect(extractSummaries(null)).toEqual([])
    expect(extractSummaries({ unexpected: true })).toEqual([])
  })
})

describe('extractDisconnects', () => {
  it('reads revocations so stale tokens can be removed immediately', () => {
    expect(extractDisconnects({ deregistrations: [{ userId: 'garmin-42' }] })).toEqual([{ userId: 'garmin-42' }])
  })

  it('ignores malformed revocation entries', () => {
    expect(extractDisconnects({ deregistrations: [{ nope: true }] })).toEqual([])
  })
})

describe('sealOAuthState / openOAuthState', () => {
  const secret = 'test-app-key'
  const state = { userId: 7, state: 'abc', verifier: 'v-123', issuedAt: 1_700_000_000_000 }

  it('round-trips the in-flight connection', () => {
    const opened = openOAuthState(sealOAuthState(state, secret), secret, state.issuedAt + 1000)

    expect(opened).toEqual(state)
  })

  it('refuses a token whose userId was edited', () => {
    // Without the signature, someone could point their own connection at
    // another person's account by editing one number in their cookie.
    const sealed = sealOAuthState(state, secret)
    const [payload, signature] = sealed.split('.')
    const tampered = Buffer.from(JSON.stringify({ ...state, userId: 1 })).toString('base64url')

    expect(openOAuthState(`${tampered}.${signature}`, secret, state.issuedAt + 1000)).toBeNull()
  })

  it('refuses a token signed with a different secret', () => {
    expect(openOAuthState(sealOAuthState(state, 'other-key'), secret, state.issuedAt + 1000)).toBeNull()
  })

  it('refuses an attempt that has gone stale', () => {
    const sealed = sealOAuthState(state, secret)

    expect(openOAuthState(sealed, secret, state.issuedAt + OAUTH_STATE_TTL_MS + 1)).toBeNull()
  })

  it('refuses malformed input rather than throwing', () => {
    expect(openOAuthState(undefined, secret)).toBeNull()
    expect(openOAuthState('', secret)).toBeNull()
    expect(openOAuthState('no-separator', secret)).toBeNull()
    expect(openOAuthState('!!!.!!!', secret)).toBeNull()
  })

  it('refuses everything when no secret is configured', () => {
    expect(openOAuthState(sealOAuthState(state, secret), '')).toBeNull()
  })
})

describe('isAuthenticWebhook', () => {
  it('accepts only the configured secret', () => {
    expect(isAuthenticWebhook('shh', 'shh')).toBe(true)
    expect(isAuthenticWebhook('wrong', 'shh')).toBe(false)
  })

  it('rejects everything when no secret is set, rather than accepting everything', () => {
    // The endpoint writes activities, so an unconfigured secret must fail
    // closed. Failing open would leave a public write endpoint.
    expect(isAuthenticWebhook('anything', '')).toBe(false)
    expect(isAuthenticWebhook(null, '')).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(isAuthenticWebhook(null, 'shh')).toBe(false)
  })
})

describe('evaluateImportedAthletes', () => {
  it('evaluates each athlete once, however many runs one push carried', async () => {
    // A backfill replays history in a single push. Evaluating per activity
    // would re-read the whole history once for every run in it.
    const calls: number[] = []
    const evaluated = await evaluateImportedAthletes([7, 7, 7, 9], async (id) => {
      calls.push(id)
    })
    expect(calls).toEqual([7, 9])
    expect(evaluated).toBe(2)
  })

  it('does nothing when the push imported nothing', async () => {
    let called = false
    const evaluated = await evaluateImportedAthletes([], async () => {
      called = true
    })
    expect(called).toBe(false)
    expect(evaluated).toBe(0)
  })

  it('never throws, and one failure does not cost the next athlete', async () => {
    // A throw here would turn the response non-2xx and Garmin would redeliver
    // the whole batch, including every run that already imported.
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    const calls: number[] = []
    try {
      const evaluated = await evaluateImportedAthletes([1, 2], async (id) => {
        calls.push(id)
        if (id === 1)
          throw new Error('database is locked')
      })
      expect(calls).toEqual([1, 2])
      expect(evaluated).toBe(1)
      expect(logged).toHaveBeenCalledTimes(1)
    }
    finally {
      logged.mockRestore()
    }
  })
})
