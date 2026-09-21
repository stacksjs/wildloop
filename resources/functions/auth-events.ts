/**
 * The events the session speaks in, kept in a module with no imports.
 *
 * stx copies a component's imports into that component's own bundle
 * (stacksjs/stx#1957), so a component that only needs an event name must not
 * get it from a module that also pulls in the whole auth client.
 */

/** Fired to open the sign-in sheet. Detail: `{ reason, mode }`. */
export const AUTH_REQUIRED_EVENT = 'wildloop:auth-required'

/** Fired once the session is resolved, signed in or not. Detail: `{ signedIn, user }`. */
export const AUTH_READY_EVENT = 'wildloop:auth-ready'
