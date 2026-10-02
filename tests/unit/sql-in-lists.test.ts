import { describe, expect, it } from 'bun:test'

/**
 * `IN (...)` lists built from an array, and why they must go through
 * `db.unsafe`.
 *
 * `db.sql` is a tagged template that BINDS what it interpolates. So
 *
 *     db.sql`... WHERE id IN (${ids.join(',')})`
 *
 * does not produce `IN (1,2,3)`. It produces `IN (?)` bound to the string
 * "1,2,3", which equals no id at all. The failure is silent and it is worse
 * than a thrown error, because a list of one works: "1" binds and compares
 * equal to 1, so the query is right in development with a single row and
 * wrong the moment there are two.
 *
 * That is exactly how it shipped. The feed's photo lookup carried this for as
 * long as it has existed — an activity's photo appeared when the feed held one
 * activity and vanished when it held two — and the segment leaderboard picked
 * up the same shape from it. Both now use `db.unsafe`, with the ids coerced to
 * positive integers first, which is the only thing making that safe.
 *
 * This is a source-level guard rather than a query. The behaviour needs a
 * database and belongs in the browser suite; what is worth catching here is
 * the pattern coming back, since nothing about reading it says it is wrong.
 */

const FILES = [
  'app/Actions/Activity/ActivityIndexAction.ts',
  'app/Actions/Segment/SegmentIndexAction.ts',
]

/** `IN (${something.join(',')})` with no `db.unsafe` between the two. */
const BOUND_IN_LIST = /IN \(\$\{(?!db\.unsafe)[^}]*\.join\(/

describe('IN lists are not bound as a single string', () => {
  for (const file of FILES) {
    it(`${file} builds its IN list with db.unsafe`, async () => {
      // Comments stripped first: the block above each call site quotes the
      // broken shape to explain it, and a guard that trips on its own
      // explanation fails on the fixed file.
      const source = (await Bun.file(file).text())
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      const offender = source.match(BOUND_IN_LIST)

      expect(offender?.[0] ?? null, `${file} interpolates a joined array into IN (...) without db.unsafe — it will bind as one string and match nothing`)
        .toBeNull()
    })
  }

  /*
   * The guard has to actually recognise the shape it is guarding against, or
   * it is a test that passes because its regex is wrong.
   */
  it('recognises the broken shape, and accepts the fixed one', () => {
    expect(BOUND_IN_LIST.test('WHERE id IN (${ids.join(\',\')})')).toBe(true)
    expect(BOUND_IN_LIST.test('WHERE id IN (${photoIds.join(\',\')})')).toBe(true)
    expect(BOUND_IN_LIST.test('WHERE id IN (${db.unsafe(ids.join(\',\'))})')).toBe(false)
    // A single bound value is the normal, correct case and must not trip it.
    expect(BOUND_IN_LIST.test('WHERE id = ${id}')).toBe(false)
  })
})

describe('what makes db.unsafe safe here', () => {
  /*
   * `db.unsafe` puts the string into the statement verbatim, so the ids have
   * to be proven integers before they reach it. Both call sites coerce with
   * `Number` and filter on `Number.isInteger(id) && id > 0`; this pins that
   * the filter actually rejects everything that is not one.
   */
  const survives = (value: unknown) => {
    const id = Number(value)
    return Number.isInteger(id) && id > 0
  }

  it('admits a positive integer and nothing else', () => {
    expect(survives(1)).toBe(true)
    expect(survives('42')).toBe(true)

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '', 'abc', '1; DROP TABLE trails'])
      expect(survives(bad), String(bad)).toBe(false)
  })
})
