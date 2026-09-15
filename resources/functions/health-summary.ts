export interface HealthSummaryValues {
  steps?: unknown
  distanceMetres?: unknown
  activeEnergy?: unknown
}

function finiteNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** Format optional native health values without ever exposing NaN to the UI. */
export function formatHealthSummary(values: HealthSummaryValues): string {
  const steps = Math.round(finiteNumber(values.steps)).toLocaleString()
  const distanceKm = (finiteNumber(values.distanceMetres) / 1000).toFixed(1)
  const energy = Math.round(finiteNumber(values.activeEnergy))
  return `${steps} steps · ${distanceKm} km · ${energy} kcal today`
}
