/**
 * A plain `?q=` filter for the small directories (clubs, events).
 *
 * These tables hold hundreds of rows, not the trail catalog's hundreds of
 * thousands, and their index actions already load every row to work out
 * visibility. A case-insensitive substring match over the loaded rows is all
 * the Search screen needs from them; there is no search index behind it.
 */

/** Below this, a query matches nearly everything and is ignored. */
export const MIN_TEXT_QUERY = 2

/** The query as it is matched, or '' when there is no usable one. */
export function textQuery(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.normalize('NFC').trim().toLowerCase().slice(0, 100) : ''
  return text.length >= MIN_TEXT_QUERY ? text : ''
}

/** True when there is no query, or any field contains it. */
export function matchesText(query: string, ...fields: unknown[]): boolean {
  if (!query)
    return true
  return fields.some(field => typeof field === 'string' && field.normalize('NFC').toLowerCase().includes(query))
}
