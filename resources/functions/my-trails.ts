/**
 * Labels for the Saved and Completed trail lists. Pure: this directory is
 * auto-imported into the server bundle too.
 */

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** "Done 3 times · last Sep 9, 2026", "Done Sep 9, 2026", or "Marked as done". */
export function completedLabel(times: number, lastCompletedAt: string | null | undefined): string {
  const when = lastCompletedAt ? new Date(lastCompletedAt) : null
  const date = when && !Number.isNaN(when.getTime()) ? DATE.format(when) : ''
  if (!times || times < 1)
    return 'Marked as done'
  if (times === 1)
    return date ? `Done ${date}` : 'Done once'
  return date ? `Done ${times} times · last ${date}` : `Done ${times} times`
}

