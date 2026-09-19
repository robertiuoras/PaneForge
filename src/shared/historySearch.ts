// Which past sessions a query names.
//
// The transcript half of History search runs in main over half a gigabyte of logs
// (`main/history.ts`). This is the other half, and it is the one people actually use
// first: a session is searched for by its NAME - "pizzasrus" - and that used to find
// nothing at all unless the word also happened to be printed in the output, which is the
// opposite of the question being asked. The name, folder and asks are already in the
// renderer's own list, so matching them costs one pass over a few hundred small objects.
//
// It is not a substring test, because the person typing has half-remembered what they
// asked for: `reserch repo` has to find `repo triage research`, and `pizzasrus` has to be
// found from `pizasrus`. So every query word is scored against every word the session
// carries - exact, prefix, inside-a-word, then a bounded edit distance for a typo - and
// the rows come back BEST FIRST rather than in whatever order the list happened to be in.
// A query word that matches nothing at all drops the row: typing two words means both.
//
// Pure, so scripts/history-search-test.mjs can pin it without a window.

/** Anything about a session a person would type to find it again. */
export interface Named {
  title?: string
  cwd?: string
  gist?: string
  chapters?: string[]
  /** every ask the session made - the half of "what was this about" chapters drop */
  askLines?: string[]
}

/** Shortest query worth filtering on; one character names every session on the desk. */
export const MIN_QUERY = 2

/**
 * How much a field is worth when it matches.
 *
 * The name on the card is what somebody types to get a session back, so it leads. What
 * was ASKED is the next best answer to "which one was that", and the folder is last:
 * every session in a project shares it, so it separates nothing on its own.
 */
const WEIGHT = { title: 3, gist: 2.5, chapter: 2, ask: 1.6, cwd: 1.2 } as const

/** Asks past this are not read: a long session has hundreds and the first ones say most. */
const MAX_ASKS = 60

/**
 * How wrong a word may be and still be the word.
 *
 * Short words get no budget at all - at three characters an edit reaches half the
 * dictionary, so `cat` would match `chat`, `cut` and `car` and the ranking would be
 * noise. The budget only opens up once a word is long enough for a typo to still leave
 * it recognisable.
 */
export function typoBudget(len: number): number {
  if (len < 4) return 0
  if (len < 7) return 1
  return 2
}

/** Words, lowercased, punctuation and path separators dropped. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Edit distance, abandoned as soon as it passes `max`.
 *
 * Bounded because the answer is never wanted, only "is it close enough": a full matrix
 * over every ask of every session is work nobody reads.
 */
export function within(a: string, b: string, max: number): boolean {
  if (a === b) return true
  if (max <= 0) return false
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      row.push(v)
      if (v < best) best = v
    }
    // Nothing later in the word can bring the distance back down below the best on this
    // row, so a row that is already too far is the end of it.
    if (best > max) return false
    prev = row
  }
  return prev[b.length] <= max
}

/**
 * How well one typed word matches one word the session carries. 0 is no match.
 *
 * The ladder is the confidence: the whole word is what was meant, a prefix is what
 * somebody stopped typing, a word CONTAINING it is a fair guess, and a near miss is a
 * typo. Each rung is worth less than the one above so an exact hit cannot lose to two
 * vague ones.
 */
export function wordScore(needle: string, word: string): number {
  if (word === needle) return 1
  if (word.startsWith(needle)) return 0.85
  if (word.includes(needle)) return 0.6
  const budget = typoBudget(needle.length)
  if (budget > 0 && within(needle, word, budget)) return 0.45
  return 0
}

/** Every word the session carries, with what its field is worth. */
function fieldsOf(e: Named): Array<{ words: string[]; weight: number }> {
  const out: Array<{ words: string[]; weight: number }> = []
  if (e.title) out.push({ words: wordsOf(e.title), weight: WEIGHT.title })
  if (e.gist) out.push({ words: wordsOf(e.gist), weight: WEIGHT.gist })
  for (const c of e.chapters ?? []) out.push({ words: wordsOf(c), weight: WEIGHT.chapter })
  for (const a of (e.askLines ?? []).slice(0, MAX_ASKS))
    out.push({ words: wordsOf(a), weight: WEIGHT.ask })
  // Only the tail of a path says anything: every session under Projects shares the head.
  if (e.cwd) out.push({ words: wordsOf(e.cwd).slice(-3), weight: WEIGHT.cwd })
  return out
}

/**
 * How well a query names a session. 0 means it does not.
 *
 * Every word typed has to find SOMETHING - two words is a narrowing, not a wish list -
 * and each one is worth the best match it found anywhere, times what that field is
 * worth. A phrase that appears whole somewhere gets a bonus on top, so `menu photos`
 * beats a session that said `menu` in one place and `photos` in another.
 */
export function scoreSession(e: Named, q: string): number {
  const needles = wordsOf(q)
  if (!needles.length || q.trim().length < MIN_QUERY) return 0
  const fields = fieldsOf(e)
  let total = 0
  for (const needle of needles) {
    let best = 0
    for (const f of fields) {
      for (const w of f.words) {
        const s = wordScore(needle, w) * f.weight
        if (s > best) best = s
      }
    }
    if (best === 0) return 0
    total += best
  }
  const phrase = q.trim().toLowerCase()
  if (needles.length > 1) {
    const whole = [e.title, e.gist, ...(e.chapters ?? []), ...(e.askLines ?? []).slice(0, MAX_ASKS)]
    if (whole.some((t) => t && t.toLowerCase().includes(phrase))) total += 1
  }
  return total
}

/** Does `q` name this session at all? Kept as the yes/no half of `scoreSession`. */
export function namesSession(e: Named, q: string): boolean {
  return scoreSession(e, q) > 0
}

/**
 * The order the results come back in: closest match first, then whichever printed the
 * word most. A name match is what the person typed; a transcript match is where the word
 * happened to appear, and there are hundreds of those - so any name score at all still
 * leads a session that only printed it.
 */
export function rankBy<T extends Named & { id: string }>(
  rows: T[],
  q: string,
  hits: (id: string) => number
): T[] {
  const needle = q.trim()
  if (needle.length < MIN_QUERY) return rows
  const scored = rows.map((e) => ({ e, score: scoreSession(e, needle) }))
  return scored
    .filter((r) => r.score > 0 || hits(r.e.id) > 0)
    .sort((a, b) => b.score - a.score || hits(b.e.id) - hits(a.e.id))
    .map((r) => r.e)
}
