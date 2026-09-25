import type { RouteRegistry } from '@stacksjs/router'

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
