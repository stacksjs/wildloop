/** Count a table in SQL, returning 0 when an optional table is unavailable. */
export async function countOf(model: { count: () => Promise<number> }): Promise<number> {
  try {
    return Number(await model.count()) || 0
  }
  catch {
    return 0
  }
}
