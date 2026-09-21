interface BattleRow {
  territory_id: number
  event_type: string
}

/**
 * A contest that a later event on the same land answered (the owner
 * defending it, or a takeover) is that event's battle, not a second one.
 * Listing both showed every defended contest twice.
 *
 * `rows` is newest first, so everything before `row` happened after it.
 */
export function isAnsweredContest(rows: readonly BattleRow[], row: BattleRow): boolean {
  if (row.event_type !== 'contested')
    return false
  const index = rows.indexOf(row)
  return rows.slice(0, index).some(later => later.territory_id === row.territory_id && later.event_type !== 'contested')
}
