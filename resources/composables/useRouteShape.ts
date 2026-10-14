/**
 * Kept as a re-export so the eight views that import `routeShapeFor` from here
 * keep working. The implementation moved to `resources/functions/route-shape`
 * when a native screen needed it: a native screen may only import from
 * `resources/functions`, and two copies of the projection would be two answers
 * to "where does this line go".
 */
export { routeShapeFor, type RouteShape } from '../functions/route-shape'
