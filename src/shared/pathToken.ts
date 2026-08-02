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
 * Every path-looking token in one line, left to right.
 *
 * Columns are indices into the string handed in. The caller decides what a column means -
 * for xterm that is a cell in the buffer row, which is why this returns positions rather
 * than doing anything with them.
 */
export function findPathTokens(line: string): PathToken[] {
  const out: PathToken[] = []
  const runs = /\S+/g
  let m: RegExpExecArray | null
  while ((m = runs.exec(line)) !== null) {
    let start = m.index
    let text = m[0]

    const lead = LEADING.exec(text)
    if (lead) {
      start += lead[0].length
      text = text.slice(lead[0].length)
    }
    const tail = TRAILING.exec(text)
    if (tail) text = text.slice(0, text.length - tail[0].length)

    if (text && looksLikePath(text)) out.push({ text, start, end: start + text.length })
  }
  return out
}
