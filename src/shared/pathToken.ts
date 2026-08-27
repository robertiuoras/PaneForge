/**
 * Finding file paths in a line of terminal output.
 *
 * Agents print paths constantly - `docs/proposals/rightkey-knowledge-proposal.pdf`,
 * `src/main/index.ts:1059` - and every one of them is somewhere you might want to open.
 * Nothing in a pty marks them, so they have to be guessed out of plain text.
 *
 * The rule here is deliberately mean: a run of characters only counts if it carries a
 * path separator or a real-looking file extension. Everything that survives is still
 * checked against the disk in the main process before it is ever drawn as a link, so a
 * false positive costs one `stat` and disappears. A matcher loose enough to underline
 * half the prose would be worse than no matcher at all, which is why "does it exist"
 * does the real work and this only has to be cheap and roughly right.
 */

/** One path-looking run, with the columns it occupies in the line it came from. */
export interface PathToken {
  /** the token as printed, line-number suffix and all */
  text: string
  /** 0-based index of the first character in the line */
  start: number
  /** 0-based index one past the last character */
  end: number
  /**
   * Shorter readings of the same run, longest first, for a candidate carrying spaces.
   *
   * A filename with spaces in it cannot be found by shape - `Sonia 21st Birthday V9.mp4`
   * and a sentence about a file are the same characters - so the caller asks the DISK,
   * longest first, and takes the first one that is really there. `text` is the longest
   * reading; these are what to fall back to, ending with the plain no-spaces run that was
   * the only thing this function used to return.
   */
  alts?: PathToken[]
}

/** A token split into the part that is a path and the `:line:col` an agent appended. */
export interface ParsedPath {
  path: string
  line?: number
  column?: number
}

/**
 * A token the main process confirmed is really there.
 *
 * Lives here rather than beside the `stat` that produces it because both sides of the IPC
 * bridge name this type, and `shared` is the only place both are allowed to import from.
 */
export interface RevealTarget {
  /** absolute path, resolved against the pane's cwd */
  abs: string
  kind: 'file' | 'dir'
  /** the `:1059` an agent appended, kept so a future "open at line" has it */
  line?: number
}

/** Brackets and quotes an agent wraps a path in, which are not part of the path. */
const LEADING = /^[('"`[{<]+/
const TRAILING = /[.,;:!?)\]}>'"`]+$/

/** `index.ts:1059` and `index.ts:1059:12`, the two shapes editors and agents both use. */
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/

/** A scheme like `https://` or `file://`. Those are links, but not ones this opens. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/** `report.pdf`, `index.ts` - a bare filename with a plausible extension. */
const HAS_EXTENSION = /^[\w.@+-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/

/** Something on both sides of a separator, so a lone `/` or a bare `//` is not a path. */
const HAS_SEPARATOR = /[^\\/\s][\\/][^\\/\s]/

/**
 * Split `src/main/index.ts:1059:12` into its path and its position.
 *
 * The suffix is only taken when the path in front of it survives on its own, so a Windows
 * drive letter and a bare `12:30` timestamp are both left alone.
 */
export function parsePathToken(text: string): ParsedPath {
  const m = LINE_SUFFIX.exec(text)
  if (!m) return { path: text }
  const head = text.slice(0, m.index)
  if (!head || !looksLikePath(head)) return { path: text }
  return {
    path: head,
    line: Number(m[1]),
    column: m[2] === undefined ? undefined : Number(m[2])
  }
}

/**
 * Is this run of characters worth asking the disk about?
 *
 * Kept strict on shape and silent on existence: this module never touches the filesystem,
 * so it can be unit tested and so the renderer can call it on every visible line without
 * paying for IO.
 */
export function looksLikePath(token: string): boolean {
  if (token.length < 3) return false
  if (URL_LIKE.test(token)) return false

  const { path } = parsePathToken(token)
  if (path.length < 3) return false
  // `...`, `--`, `1.2.3` - punctuation and version numbers reach here often.
  if (!/[A-Za-z]/.test(path)) return false
  // A flag, not a path. `--out=x/y` is a flag too, but its value is worth catching.
  if (/^-{1,2}[A-Za-z]/.test(path)) return false

  if (HAS_SEPARATOR.test(path)) return true
  return HAS_EXTENSION.test(path)
}

/**
 * How many words a spaced candidate may reach across.
 *
 * A real filename with spaces is a handful of words; a sentence is not. Eight covers
 * `Sonia 21st Birthday final V9.mp4` twice over and keeps the number of disk questions a
 * hover can ask bounded, which is the cost this constant actually controls.
 */
export const MAX_SPACE_WORDS = 8

/** A run's final word carries a real-looking extension - the anchor a spaced path needs. */
const ENDS_WITH_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/

/**
 * Is this run - which contains spaces - worth asking the disk about?
 *
 * Deliberately weaker than `looksLikePath`, because with spaces allowed there is no shape
 * left that separates a filename from prose. The one thing held onto is the extension at
 * the END: a candidate has to finish on something that looks like a file, which is what
 * stops every clause in a paragraph from becoming a question for the filesystem. Existence
 * does the rest, exactly as it does for the no-spaces case.
 */
export function looksLikeSpacedPath(token: string): boolean {
  if (token.length < 3) return false
  if (URL_LIKE.test(token)) return false
  if (/^-{1,2}[A-Za-z]/.test(token)) return false
  if (!/[A-Za-z]/.test(token)) return false
  const { path } = parsePathToken(token)
  return ENDS_WITH_EXTENSION.test(path)
}

/** Strip the brackets and quotes an agent wrapped a run in, keeping the columns honest. */
function trimRun(line: string, start: number, end: number): PathToken | null {
  let text = line.slice(start, end)
  const lead = LEADING.exec(text)
  if (lead) {
    start += lead[0].length
    text = text.slice(lead[0].length)
  }
  const tail = TRAILING.exec(text)
  if (tail) text = text.slice(0, text.length - tail[0].length)
  return text ? { text, start, end: start + text.length } : null
}

/**
 * Every path-looking token in one line, left to right.
 *
 * Columns are indices into the string handed in. The caller decides what a column means -
 * for xterm that is a cell in the buffer row, which is why this returns positions rather
 * than doing anything with them.
 */
export function findPathTokens(line: string): PathToken[] {
  const words: Array<{ start: number; end: number }> = []
  const runs = /\S+/g
  let m: RegExpExecArray | null
  while ((m = runs.exec(line)) !== null) words.push({ start: m.index, end: m.index + m[0].length })

  const out: PathToken[] = []
  for (let i = 0; i < words.length; i++) {
    const readings: PathToken[] = []
    // Longest first, so the caller's first confirmed answer is also the most complete one.
    // Only SINGLE spaces are crossed: two or more is column padding in a table or a listing,
    // never the inside of a filename, and crossing it would join two unrelated cells.
    const last = Math.min(words.length - 1, i + MAX_SPACE_WORDS)
    for (let j = last; j > i; j--) {
      if (line.slice(words[i].end, words[j].start).match(/^(?: [^ ]+)* $/) === null) continue
      // A separator may only appear in the FIRST word of a spaced candidate. That is the
      // whole difference between `~/Work/Clients/Sonia/Sonia 21st Birthday V9.mp4`, where
      // the folders are all in front, and `Wrote docs/proposals/thing.pdf`, where the word
      // before the path is prose - without it every sentence containing a path becomes a
      // second, longer candidate covering the words around it.
      if (/[\\/]/.test(line.slice(words[i].end, words[j].end))) continue
      const cand = trimRun(line, words[i].start, words[j].end)
      if (cand && looksLikeSpacedPath(cand.text)) readings.push(cand)
    }
    const base = trimRun(line, words[i].start, words[i].end)
    if (base && looksLikePath(base.text)) readings.push(base)
    if (!readings.length) continue
    const [head, ...alts] = readings
    out.push(alts.length ? { ...head, alts } : head)
  }
  return out
}
