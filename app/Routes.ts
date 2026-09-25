import type { RouteRegistry } from '@stacksjs/router'

/**
 * Which route files to load, and under which prefix.
 *
 * Not ours by choice: the framework imports this exact path with no
 * fallback — `@stacksjs/server`'s production entry does a static
 * `import routeRegistry from '../../../../../app/Routes'`, and the
 * dashboard, error page and AI context each read `projectPath('app/Routes.ts')`.
 * A copy under `storage/framework/defaults/app/` is never consulted, so
 * deleting this file stops the app booting.
 *
 * It is a manifest, not routing: `routes/api.ts` is where Wildloop's routes
 * are written, and the one line below is what mounts it at `/api`.
 *
 * @see https://docs.stacksjs.org/routing
 */
export default {
  api: 'api',
} satisfies RouteRegistry

export type { RouteDefinition, RouteRegistry } from '@stacksjs/router'
