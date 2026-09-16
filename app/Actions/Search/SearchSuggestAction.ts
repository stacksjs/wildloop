// Autocomplete for the home search. Public and read-only.
//
// A separate endpoint from GET /api/trails on purpose. That one always counts
// its matches and returns whole rows with their geometry, which is right for a
// results page and far too heavy to run on every keystroke.

import { db } from '@stacksjs/orm'
import { buildSuggestions, placeSuggestionsSql, suggestMatch, trailSuggestionsSql } from '../../Support/searchSuggest'

export default new Action({
  name: 'Search Suggest',
  description: 'Suggest regions, places and trails for a partly typed search',
  method: 'GET',

  async handle(request) {
    const query = String(request.get('q') ?? '').slice(0, 100)
    const match = suggestMatch(query)
    const nameMatch = suggestMatch(query, 'name')

    if (!match || !nameMatch)
      return response.json({ success: true, query, suggestions: [] })

    // Each half fails on its own. A place list that has not been built yet, on
    // an environment whose migration ran before its first rebuild, must not
    // take the trail suggestions down with it.
    const [places, trails] = await Promise.all([
      db.sql`${db.unsafe(placeSuggestionsSql(match))}`.execute().catch((error: unknown) => {
        console.warn('[search] place suggestions failed:', error)
        return []
      }),
      db.sql`${db.unsafe(trailSuggestionsSql(nameMatch))}`.execute().catch((error: unknown) => {
        console.warn('[search] trail suggestions failed:', error)
        return []
      }),
    ])

    return response.json({
      success: true,
      query,
      suggestions: buildSuggestions(places as any[], trails as any[]),
    })
  },
})
