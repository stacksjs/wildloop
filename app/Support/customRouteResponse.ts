export function routeResponse(route: any) {
  return {
    id: route.id,
    name: route.name,
    route: parseRoute(route.route_data),
    distance: route.distance,
    elevation: route.elevation,
    closedLoop: !!route.closed_loop,
    createdAt: route.created_at,
  }
}

function parseRoute(raw: string): unknown[] {
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value : [] }
  catch { return [] }
}
