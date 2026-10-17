const FEET_PER_METRE = 3.28084

/**
 * Convert recorded [lat, lng] points to a GeoJSON LineString string the engine parses.
 *
 * `altitude` goes up in metres. The recorder keeps feet for its own display,
 * but every reader of this envelope on the server reads metres, as GPX and FIT
 * do: the vertical-speed check, the elevation profile, segment matching.
 * Sending feet made the integrity check 3.3 times stricter than its 6 m/s
 * limit, so an ordinary altitude wobble between two fixes refused the whole
 * run, and every elevation profile was drawn 3.3 times too tall.
 */
export function routeToGeoJson(
  points: Array<[number, number]>,
  samples: Array<{ t: number, accuracy?: number | null, eleFt?: number | null }> = [],
): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: points.map(([lat, lng]) => [lng, lat]),
    properties: {
      // Said out loud, so a stored track is never again ambiguous about it:
      // runs uploaded before this field existed sent feet (migration
      // 0000000183 converted them).
      altitudeUnit: 'm',
      samples: points.map((_, index) => {
        const feet = samples[index]?.eleFt
        return {
          time: samples[index]?.t ?? null,
          accuracy: samples[index]?.accuracy ?? null,
          altitude: feet == null ? null : feet / FEET_PER_METRE,
        }
      }),
    },
  })
}

