import { difficultyIsEstimated, trailDifficultyLabel } from '../../resources/functions/trail-difficulty'

/**
 * A trail's grade, shaped for a card that has to say what kind of grade it is.
 *
 * Most of the catalog has no measured ascent, so most grades come from length
 * alone (#1004). The badge marks those with a tilde, and the mark is derived
 * from the stored elevation, so it clears itself the moment the elevation
 * backfill reaches a trail.
 *
 * Server side because a payload has to carry the label as a string: an stx
 * client template interpolates properties and not calls, so a view holding
 * `elevation` still cannot decide anything from it. The feed and the saved
 * list both build their trail cards from explicit allow-lists, which is how
 * they came to show a bare grade while the catalog marked its own — this is
 * the one place that names the fields, so an action cannot ship half of them.
 */
export function trailGradeFields(row: { difficulty?: unknown, elevation?: unknown } | null | undefined): {
  difficulty: string
  difficultyLabel: string
  difficultyEstimated: boolean
} {
  const difficulty = String(row?.difficulty ?? '')
  return {
    difficulty,
    difficultyLabel: trailDifficultyLabel(difficulty, row?.elevation),
    difficultyEstimated: difficultyIsEstimated(row?.elevation),
  }
}
