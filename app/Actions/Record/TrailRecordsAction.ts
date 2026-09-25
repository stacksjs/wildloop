// GET /api/trails/{id}/records - one route's records board.
//
// The centrepiece of a route page: every ranked time on the route, split into
// the buckets that make two times comparable (direction, category, style,
// solo vs team), plus the outright fastest and whatever attempts are running
// on it right now.
//
// Public and session-free. A records board is a reference work; requiring a
// login to read who holds a route would defeat the point of publishing it.

import RouteEffort from '../../Models/RouteEffort'
import Trail from '../../Models/Trail'

import {
  buildRecordBoards,
  CATEGORY_LABELS,
  DIRECTION_LABELS,
  formatElapsed,
  isHeadlineRecord,
  outrightRecord,
  recordPace,
  routeIsRankable,
  STYLE_LABELS,
} from '../../../resources/functions/route-records'
import { shapeEfforts } from '../../Support/routeEfforts'

export default new Action({
  name: 'Trail Records',
  description: 'The fastest known times on one route, grouped by style and category',
  method: 'GET',

  async handle(request) {
    const trailId = positiveInt(request.get('id') ?? request.get('trail_id'))
    if (!trailId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer trail id' } }, 422)

    try {
      const trail = await Trail.find(trailId)
      if (!trail)
        return response.json({ success: false, error: 'Route not found' }, 404)

      const rankable = routeIsRankable(trail)
      const rows = (await RouteEffort.where('trail_id', '=', trailId).get()) ?? []
      // A rejected claim never reaches a public board, and an unranked status
      // (in progress, DNF) is reported separately rather than mixed into the
      // times.
      const shaped = await shapeEfforts(rows.filter((row: any) => row.status !== 'rejected'))

      const boards = buildRecordBoards(shaped).map(board => ({
        ...board,
        label: `${DIRECTION_LABELS[board.direction]} · ${CATEGORY_LABELS[board.category]} · ${STYLE_LABELS[board.style]}${board.team ? ' · Team' : ''}`,
        entries: board.entries.map(entry => ({
          ...entry,
          // Whether this is *the* record on the route under rules at least
          // this strict - which separates "fastest supported" from "the
          // fastest anyone has covered this route". Labelling the former as
          // the latter is the thing that discredits a records board.
          headline: isHeadlineRecord(entry, shaped),
        })),
      }))

      const outright = outrightRecord(shaped)
      const inProgress = shaped
        .filter(effort => effort.status === 'in_progress')
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))

      return response.json({
        success: true,
        trail: {
          id: trail.id,
          name: trail.name,
          location: trail.location,
          distance: trail.distance,
          elevation: trail.elevation,
          routeType: trail.route_type,
        },
        rankable: rankable.eligible,
        rankableReason: rankable.reason,
        outright: outright
          ? {
              ...outright,
              elapsedLabel: formatElapsed(outright.elapsedSeconds),
              paceLabel: recordPace(Number(trail.distance ?? 0), outright.elapsedSeconds),
            }
          : null,
        boards,
        inProgress,
        totalEfforts: shaped.length,
      })
    }
    catch (error) {
      console.error('[records] trail board failed:', error)
      return response.json({ success: false, error: 'Failed to fetch the records board' }, 500)
    }
  },
})
