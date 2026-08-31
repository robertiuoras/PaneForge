// Which past sessions a query names.
//
// The transcript half of History search runs in main over half a gigabyte of logs
// (`main/history.ts`). This is the other half, and it is the one people actually use
// first: a session is searched for by its NAME - "pizzasrus" - and that used to find
// nothing at all unless the word also happened to be printed in the output, which is the
// opposite of the question being asked. The name, folder and asks are already in the
// renderer's own list, so matching them costs one pass over a few hundred small objects.
//
// Pure, so scripts/history-search-test.mjs can pin it without a window.

/** Anything about a session a person would type to find it again. */
export interface Named {
  title?: string
  cwd?: string
  gist?: string
  chapters?: string[]
}

/** Does `q` (already lowercase, 2+ characters) name this session? */
export function namesSession(e: Named, q: string): boolean {
  if (q.length < 2) return false
  return [e.title, e.cwd, e.gist, ...(e.chapters ?? [])].some((t) =>
    Boolean(t && t.toLowerCase().includes(q))
  )
}

/**
 * The order the results come back in: sessions the query NAMES first, then whichever
 * printed the word most. A name match is what the person typed; a transcript match is
 * where the word happened to appear, and there are hundreds of those.
 */
export function rankBy<T extends Named & { id: string }>(
  rows: T[],
  q: string,
  hits: (id: string) => number
): T[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return rows
  return rows
    .filter((e) => namesSession(e, needle) || hits(e.id) > 0)
    .sort((a, b) => {
      const byName = Number(namesSession(b, needle)) - Number(namesSession(a, needle))
      return byName || hits(b.id) - hits(a.id)
    })
}
