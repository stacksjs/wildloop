/**
 * Bars in a box, for the small charts a native screen draws as SVG.
 *
 * A native screen has no percentage heights — the web pages give each bar a
 * `height: 42%` and let the browser resolve it. So the geometry is computed
 * here, once, and the markup binds `:x`, `:y`, `:width` and `:height`.
 *
 * Extracted when the training-stats screen became the second chart. The first
 * was the achievements year.
 *
 * @module functions/bar-chart
 */

export interface BarBox {
  width: number
  height: number
  /** Space between bars, in the same units as the box. */
  gap: number
}

export interface Bar {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One bar per value, each as tall as its share of the largest.
 *
 * A value above zero always gets at least a sliver: nothing and almost
 * nothing look the same otherwise, and only one of them is true. A value of
 * zero gets no bar at all, which is the honest shape of a week nobody ran.
 */
export function barGeometry(values: number[], box: BarBox, minimum = 2): Bar[] {
  if (values.length === 0)
    return []

  const best = Math.max(1, ...values)
  const gaps = box.gap * Math.max(0, values.length - 1)
  const width = Math.max(1, (box.width - gaps) / values.length)

  return values.map((value, index) => {
    const height = value > 0 ? Math.max(minimum, Math.round((value / best) * box.height)) : 0
    return {
      x: Math.round(index * (width + box.gap)),
      y: box.height - height,
      width: Math.round(width),
      height,
    }
  })
}
