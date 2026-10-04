/**
 * Sign in with Apple: the parts that differ from Google, away from the network.
 *
 * Apple is OAuth with four habits of its own, and each one is here so it can
 * be tested without Apple:
 *
 *  - **No client secret.** Apple issues a private key instead, and the
 *    "secret" is a short-lived ES256 JWT signed with it. This mints one per
 *    exchange, so there is nothing to rotate: the key is the credential.
 *  - **It comes back by POST.** Asking for a name or an address obliges
 *    `response_mode=form_post`, so the callback is a form Apple submits.
 *  - **The name arrives once.** Apple sends the person's name only the first
 *    time they authorize the app, as an unsigned `user` field beside the code,
 *    and never in the id token. Miss it and it is gone.
 *  - **The address may be a relay.** "Hide My Email" gives each app its own
 *    `@privaterelay.appleid.com` address that forwards to the real one.
 *    Apple vouches for it like any other address, but it will never match an
 *    account somebody made with their real address.
 *
 * Who an Apple profile is, once read, is decided by `decideLink` exactly as
 * for Google.
 */

import type { SocialProfile } from './socialIdentity'

export const APPLE_ISSUER = 'https://appleid.apple.com'

/** The domain Apple's "Hide My Email" addresses are at. */
export const PRIVATE_RELAY_DOMAIN = 'privaterelay.appleid.com'

/**
 * How long a minted client secret is good for.
 *
 * Apple allows up to six months. Minutes is plenty, because one is minted for
 * each exchange and used at once — and a secret that leaks in a log is worth
 * five minutes to whoever finds it rather than half a year.
 */
const CLIENT_SECRET_SECONDS = 5 * 60

export interface AppleCredentials {
  /** The Services ID, e.g. `org.wildloop.signin`. Apple calls it the client id. */
  clientId: string
  /** The ten-character Team ID from the membership page. */
  teamId: string
  /** The ten-character Key ID of the Sign in with Apple key. */
  keyId: string
  /** The `.p8` key file's contents. */
  privateKey: string
}

export interface AppleProfile extends SocialProfile {
  /** Whether the address is a "Hide My Email" relay. */
  isPrivateEmail: boolean
}

/**
 * The URL to send somebody to.
 *
 * `form_post` is not a choice: Apple refuses `name email` with any other
 * response mode. There is no account chooser to force, as there is with
 * Google — an Apple device is signed in to one Apple ID.
 */
export function appleAuthorizeUrl(options: { clientId: string, redirectUri: string, state: string }): string {
  const query = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state: options.state,
  })
  return `${APPLE_ISSUER}/auth/authorize?${query.toString()}`
}

/**
 * A `.p8` key as DER bytes, however it was pasted into the environment.
 *
 * Env files make multi-line values awkward, so the key is accepted as the PEM
 * file with real newlines, with `\n` escapes, or as the bare base64 body with
 * the header lines left off.
 */
// `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`: WebCrypto
// will not take bytes that might sit in a SharedArrayBuffer, and with some
// lib versions in scope the checker says so.
export function pkcs8FromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  if (!body)
    throw new Error('APPLE_PRIVATE_KEY is empty')
  return Uint8Array.from(Buffer.from(body, 'base64'))
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

/**
 * Mint the client secret for one token exchange.
 *
 * Apple's specification, field for field: ES256, the key id in the header;
 * the team as issuer, the Services ID as subject, Apple as audience. WebCrypto
 * signs ECDSA as the raw 64-byte `r || s` that JWS wants, so the signature
 * needs no re-encoding. `now` is seconds, so this can be checked at a moment.
 */
export async function appleClientSecret(credentials: AppleCredentials, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8FromPem(credentials.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: credentials.teamId,
    iat: now,
    exp: now + CLIENT_SECRET_SECONDS,
    aud: APPLE_ISSUER,
    sub: credentials.clientId,
  }))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

/** Apple sends booleans in its id token as booleans or as strings, depending. */
function claimIsTrue(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * The claims we take from Apple's id token, and nothing else — or `null` when
 * the token is not one Apple issued for this app.
 *
 * The token comes straight from Apple's token endpoint over TLS, so its
 * signature is not checked (see the callback for why that holds there and
 * nowhere else). The issuer and audience are checked anyway: they cost
 * nothing, and a token for some other app has no business signing anybody in
 * here.
 */
export function appleProfileFromClaims(claims: Record<string, unknown>, clientId: string): AppleProfile | null {
  if (claims.iss !== APPLE_ISSUER)
    return null
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!clientId || !audience.includes(clientId))
    return null

  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : ''
  if (!sub)
    return null

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  return {
    sub,
    email,
    emailVerified: claimIsTrue(claims.email_verified),
    isPrivateEmail: claimIsTrue(claims.is_private_email) || email.endsWith(`@${PRIVATE_RELAY_DOMAIN}`),
    name: null,
    picture: null,
  }
}

/**
 * The person's name from the `user` field Apple posts on first authorization,
 * or `null`.
 *
 * That field is not signed — it arrives in the browser's form post, beside the
 * code — so it is trusted for nothing but a display name, and its `email` is
 * ignored in favour of the id token's. Bounded, because it ends up in a
 * column and on a profile page.
 */
export function appleNameFromUser(user: unknown): string | null {
  if (typeof user !== 'string' || !user || user.length > 2000)
    return null
  try {
    const parsed = JSON.parse(user) as { name?: { firstName?: unknown, lastName?: unknown } }
    const parts = [parsed?.name?.firstName, parsed?.name?.lastName]
      .filter((part): part is string => typeof part === 'string')
      .map(part => part.trim())
      .filter(Boolean)
    const name = parts.join(' ').replace(/\s+/g, ' ').slice(0, 100).trim()
    return name || null
  }
  catch {
    return null
  }
}

/**
 * What to call a new account when Apple did not say.
 *
 * `decideLink` falls back to the address's local part, which is a fair guess
 * for `ada.lovelace@icloud.com` and gibberish for a relay address like
 * `x7k2p9q4mz@privaterelay.appleid.com`. Nobody wants to be greeted as that,
 * so a relay with no name gets a plain placeholder they can change.
 */
export function appleDisplayName(profile: AppleProfile, givenName: string | null): string | null {
  if (givenName)
    return givenName
  if (profile.isPrivateEmail)
    return 'Wildloop athlete'
  return null
}
