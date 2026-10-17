/** The same review shape for the community list and its author's editor. */
export function trailReviewPayload(row: any, author: {name?: string, avatar?: string | null} = {}) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: author.name ?? 'Unknown',
    userAvatar: author.avatar ?? null,
    rating: row.rating ?? 0,
    title: row.title,
    content: row.content,
    conditions: row.conditions,
    difficulty: row.difficulty ?? null,
    // Preserve the stored legacy photo formats for the shared client parser.
    photos: row.photos ?? null,
    visitDate: row.visit_date,
    createdAt: row.created_at,
    conditionsReportedAt: row.conditions_reported_at ?? null,
  }
}
