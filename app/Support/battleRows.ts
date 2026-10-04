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

interface HistoryRow {
  territory_id: number
  event_type: string
  user_id?: number | null
  previous_owner_id?: number | null
  new_territory_id?: number | null
  area_at_event?: number | null
}

/**
 * One battle per split, told from the attacker's side.
 *
 * A split writes two history rows: `split` on the defender's territory, with
 * the DEFENDER as its user and the area they kept, and `conquered` on the
 * attacker's new piece. The board read both as takeovers, so every split
 * appeared twice, once as "Alice conquered Silver Lake Loop from Alice", and
 * the defender's record counted a conquest of their own land beside the
 * loss.
 *
 * The pair becomes one row on the land that was attacked: the attacker from
 * the `conquered` row, the defender from the `split` row, and the area that
 * was taken rather than the area that was kept. A `split` whose partner is
 * outside the window has no attacker to name, and is left out.
 */
export function pairSplitRows<T extends HistoryRow>(rows: readonly T[]): T[] {
  const conqueredByTerritory = new Map<number, T>()
  for (const row of rows) {
    if (row.event_type === 'conquered')
      conqueredByTerritory.set(row.territory_id, row)
  }

  const consumed = new Set<T>()
  const merged = new Map<T, T>()
  for (const row of rows) {
    if (row.event_type !== 'split' || row.new_territory_id == null)
      continue
    const taken = conqueredByTerritory.get(row.new_territory_id)
    if (!taken)
      continue
    consumed.add(taken)
    merged.set(row, {
      ...taken,
      territory_id: row.territory_id,
      user_id: taken.user_id,
      previous_owner_id: row.user_id,
      area_at_event: taken.area_at_event,
    })
  }

  return rows.flatMap((row) => {
    if (consumed.has(row))
      return []
    if (row.event_type === 'split')
      return merged.has(row) ? [merged.get(row)!] : []
    return [row]
  })
}
