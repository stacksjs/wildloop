/**
 * Whether a trail's difficulty badge is describing a measurement or a guess.
 *
 * `deriveDifficulty` in `app/Ingest/normalize.ts` decides the grade, and takes
 * both distance and ascent. For most of the catalog's life it was handed a
 * zero ascent, because the NPS and Forest Service layers publish no elevation
 * and OSM rarely tags it — so the grade was distance alone while the badge
 * claimed to describe difficulty. Mist Trail in Yosemite, 2.67 miles and a
 * thousand feet up to Vernal Fall, is served `easy` (#1004).
 *
 * The signal here is the stored elevation itself rather than a new column, so
 * nothing has to be backfilled twice and nothing can drift: a trail becomes
 * properly graded the moment the elevation backfill reaches it, and a regrade
 * then corrects the bucket.
 *
 * Lives in `resources/functions` rather than beside the grader because the
 * cards and the filter need it too, and `app/Ingest` is server-only.
 */

export type TrailDifficultyGrade = 'easy' | 'moderate' | 'hard'

/**
 * True when no ascent is on record, so the grade came from distance alone.
 *
 * Zero is the stored value for "nobody measured", because the column is
 * NOT NULL and always has been. That makes a genuinely flat trail
 * indistinguishable from an unmeasured one here — which is the right way
 * round: calling a flat trail's grade an estimate is a small inaccuracy,
 * while calling a mountain's grade measured is the defect itself.
 */
export function difficultyIsEstimated(elevationFeet: unknown): boolean {
  const feet = Number(elevationFeet)
  return !Number.isFinite(feet) || feet <= 0
}

/**
 * What to show in the badge.
 *
 * The tilde does the work, the way it does on a price or a duration, and the
 * long form goes in `difficultyTitle` for a tooltip and a screen reader —
 * a bare `~` announced on its own says nothing.
 */
export function difficultyLabel(difficulty: unknown, elevationFeet: unknown): string {
  const grade = String(difficulty ?? '').trim()
  if (!grade)
    return ''
  return difficultyIsEstimated(elevationFeet) ? `~${grade}` : grade
}

/** The sentence behind the tilde. Empty when the grade is measured. */
export function difficultyTitle(difficulty: unknown, elevationFeet: unknown): string {
  const grade = String(difficulty ?? '').trim()
  if (!grade || !difficultyIsEstimated(elevationFeet))
    return ''
  return `Estimated from distance — this trail's ascent has not been measured yet`
}
