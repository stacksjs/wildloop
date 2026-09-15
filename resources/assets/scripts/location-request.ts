export const LOCATION_REQUEST_TIMEOUT_MS = 15_000

/**
 * Bounds a location lookup even when a native bridge loses its callback.
 *
 * The platform request remains in flight after this timeout, but its eventual
 * completion cannot revive a recorder session the person has already seen
 * fail and chosen to retry.
 */
export function withLocationRequestTimeout<T>(operation: Promise<T>, timeout = LOCATION_REQUEST_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('Location request timed out')), timeout)
    }),
  ])
}
