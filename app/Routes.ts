import type { RouteRegistry } from '@stacksjs/router'
import process from 'node:process'

// Stacks' dashboard loads this registry without the API server's bootstrap.
// Initialize its existing, idempotent runtime before any app action is loaded.
// Remove when stacksjs/stacks#2789 is fixed in our installed framework.
if (process.env.STACKS_DASHBOARD_WORKER === '1') {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  await injectGlobalAutoImports()
}

/**
 * Wildloop's app-owned route registry. Keeping it here makes production API
 * releases independent of the vendored Stacks source tree.
 *
 * @see https://docs.stacksjs.org/routing
 */
export default {
  api: 'api',
  v1: { path: 'v1', prefix: 'v1' },
} satisfies RouteRegistry

export type { RouteDefinition, RouteRegistry } from '@stacksjs/router'
