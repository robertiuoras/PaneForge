import { looksLikePath, MAX_ROOTED_WORDS, ROOTED, type RevealTarget } from '../../shared/pathToken'

/**
 * A path the CLI wrapped over several rows, put back together.
 *
 * Claude Code and Codex hard-wrap their answers: a long path is cut at the pane's width
 * with a real line break and the rest is printed on the next row, indented. A path with
 * long folder names (`.../Pizza Ovens R Us/3D-demo-2026-10-02/numbered-` /
 * `packages/01 - Weatherproof Outdoor Kitchen ... Preview.png`) takes three or four rows
 * at an ordinary width, and every cut is one of two things: inside a word (the row ends
 * `numbered-`, the next starts `packages`, nothing between) or at a space the wrap ate.
 * Nothing on screen says which, so both are tried and the DISK picks: a reading is a link
 * only when that exact file or folder is there.
 *
 * Trying both at every cut is 2^cuts readings, so the folders prune it. Everything up to
 * the last slash before a cut is a folder that must already exist, whatever comes after:
 * one question per cut throws away the wrong join whenever the cut falls inside a folder
 * name, and only cuts inside the file's own name ever leave both alive. `MAX_QUESTIONS`
 * caps what one hover may ask whatever the screen holds, and each path start gets at most
 * half of it, so a start that is not really there cannot spend the real path's budget. The
 * caller's cache answers the same question again for free.
 */

/** One terminal cell a character was drawn in; xterm columns, 1-based, end inclusive. */
export interface Cell {
  x: number
  endX: number
  y: number
}

/** One logical line: soft-wrapped rows already joined, `cells[i]` drawing `text[i]`. */
export interface WrappedLine {
  /** trailing blanks removed */
  text: string
  cells: Cell[]
}

export interface WrappedLink {
  text: string
  start: Cell
  end: Cell
  target: RevealTarget
}

/** A path wraps over at most this many lines... */
export const MAX_RUN_ROWS = 8
/** ...and this many characters. */
export const MAX_RUN_CHARS = 4096
/** Disk questions one hover may ask, cached or not... */
export const MAX_QUESTIONS = 48
/** ...and one path start within it. */
const MAX_START_QUESTIONS = MAX_QUESTIONS / 2
/** Joined readings one hover, and one path start, may build. Most cost nothing to throw away. */
const MAX_NODES = 160
const MAX_START_NODES = MAX_NODES / 2

/** A line the wrap continued onto: the CLIs indent every continuation. */
export const continues = (line: WrappedLine): boolean => /^\s+\S/.test(line.text)

/** Brackets and quotes in front of a path (`pathToken.ts` LEADING). */
const LEADING = /^[('"`[{<]+/
/** Punctuation after a path that is not part of it (`pathToken.ts` TRAILING). */
const TRAILING = /[.,;:!?)\]}>'"`]+$/
/**
 * A root with a name after it: `/x`, `~/x`, `./x`, `C:\x`, a network share `\\nas\x` -
 * never a bare `/` or `//`.
 */
const NAMED_ROOT = /^(?:~[\\/]|[\\/]|\\\\|\.{1,2}[\\/]|[A-Za-z]:[\\/])[^\\/\s]/
/** A reading ending on a file extension, `:line:col` allowed after it. */
const FILE_END = /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}$/

/**
 * A name holding a file name with more words after it, `x.json then`: past the file, so
 * not a folder. Only the folders pass trusts it - a FILE can be named `Node.js Guide.pdf`.
 */
const FILE_THEN_MORE = /\.[A-Za-z][A-Za-z0-9]{0,7}[.,;:!?)\]}>'"`]* \S/

const lastSeparator = (text: string): number => Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
const pastFile = (text: string): boolean => FILE_THEN_MORE.test(text.slice(lastSeparator(text) + 1))

/**
 * The paths in `lines` that cross from one line onto the next and are really there.
 *
 * `hovered` is the index of the line under the mouse, `row` the buffer row (1-based) it is
 * on: a link must cover that row. `ask` is the disk. One link per path start, the longest
 * that exists. A path that fits on one line is `findPathTokens`'s, unless it has more
 * words than that reaches (`MAX_ROOTED_WORDS`): the same path on a wide pane is one line.
 */
export async function wrappedPathLinks(
  lines: WrappedLine[],
  hovered: number,
  row: number,
  ask: (token: string) => Promise<RevealTarget | null>
): Promise<WrappedLink[]> {
  if (!lines[hovered]?.text.trim()) return []
  let lo = hovered
  while (lo > 0 && hovered - lo < MAX_RUN_ROWS - 1 && continues(lines[lo]) && lines[lo - 1].text.trim()) lo--
  let hi = hovered
  while (hi + 1 < lines.length && hi - hovered < MAX_RUN_ROWS - 1 && continues(lines[hi + 1])) hi++

  let questions = 0
  let nodes = 0
  let startQuestions = 0
  let startNodes = 0
  const spent = (): boolean => questions >= MAX_QUESTIONS || startQuestions >= MAX_START_QUESTIONS
  const asked = new Map<string, Promise<RevealTarget | null>>()
  const disk = (token: string): Promise<RevealTarget | null> | null => {
    const hit = asked.get(token)
    if (hit) return hit
    if (spent()) return null
    questions++
    startQuestions++
    const answer = ask(token).catch(() => null)
    asked.set(token, answer)
    return answer
  }
  /** Is everything up to the last separator a folder that is there? Unaskable = yes. */
  const folderHolds = async (text: string): Promise<boolean> => {
    const cut = lastSeparator(text)
    const folder = text.slice(0, cut)
    if (cut <= 0 || !looksLikePath(folder)) return true
    const answer = await disk(folder)
    return answer?.kind === 'dir' && !answer.ancestor
  }

  const found: WrappedLink[] = []
  // Nearest line first: the path under the mouse most likely starts on it or just above.
  for (let s = hovered; s >= lo; s--) {
    const line = lines[s]
    // Every word on the line that starts at a named root, last first: only the last path
    // on a line can be the one the wrap cut.
    const starts: number[] = []
    for (const m of line.text.matchAll(/\S+/g)) {
      const lead = LEADING.exec(m[0])?.[0].length ?? 0
      if (ROOTED.test(m[0]) && NAMED_ROOT.test(m[0].slice(lead))) starts.push(m.index! + lead)
    }
    for (const at of starts.reverse()) {
      // One line is findPathTokens' job, as far as its word limit reaches.
      const long = (line.text.slice(at).match(/\S+/g)?.length ?? 0) > MAX_ROOTED_WORDS + 1
      if (lo === hi && !long) continue
      startQuestions = 0
      startNodes = 0
      let best: WrappedLink | null = null
      // Two passes. The first asks only readings that end on a file extension - the wrong
      // join at a cut inside a file name then costs one question, not one per word after
      // it. Only when that finds nothing does the second ask everything, folders included;
      // answers already given are not asked again. `cut` is where line k's own text
      // starts inside `text`.
      let filesOnly = true
      const walk = async (k: number, text: string, cells: Cell[], cut: number): Promise<void> => {
        if (++nodes > MAX_NODES || ++startNodes > MAX_START_NODES || spent()) return
        let ended = false
        // Readings ending on this line, file-like first, longest first in each; the first
        // one that is there wins. A line the link cannot end on (above the mouse) is still
        // asked about its files: one that is there and stops before the line does means
        // the path ended here, and the prose below it is not walked word by word.
        const linkable = k >= hovered && (k > s || long)
        const readings: string[] = []
        for (let e = text.length; e > cut; e--) {
          if ((e < text.length && text[e] !== ' ') || text[e - 1] === ' ') continue
          const reading = text.slice(0, e).replace(TRAILING, '')
          if (reading.length > cut && !reading.includes('  ') && !readings.includes(reading)) readings.push(reading)
        }
        const fileLike = (r: string): boolean => FILE_END.test(r)
        for (const reading of [
          ...readings.filter(fileLike),
          ...(filesOnly || !linkable ? [] : readings.filter((r) => !fileLike(r) && !pastFile(r)))
        ]) {
          const start = cells[0]
          const end = cells[reading.length - 1]
          if (!start || !end || (linkable && (start.y > row || end.y < row))) continue
          // A cut inside the folders is settled by the folder, once for every reading
          // under it. A folder wholly before the cut was settled on the way here.
          if (lastSeparator(reading) >= cut && !(await folderHolds(reading))) continue
          const answer = disk(reading)
          if (!answer) return
          const target = await answer
          if (!target || target.ancestor) continue
          if (linkable && (!best || reading.length > best.text.length)) best = { text: reading, start, end, target }
          // A path that stops before its line does is not carried onto the next one, and
          // neither is a file: only a folder has more path after it.
          ended = reading.length < text.length || target.kind === 'file'
          break
        }
        // Only a line the path runs to the end of can carry on, and only from a folder
        // that exists.
        if (ended || k === hi || k - s + 1 >= MAX_RUN_ROWS || text.length >= MAX_RUN_CHARS || text.includes('  '))
          return
        if ((!filesOnly && pastFile(text)) || !(await folderHolds(text))) return
        const next = lines[k + 1]
        const indent = next.text.length - next.text.trimStart().length
        const more = next.text.slice(indent)
        const moreCells = next.cells.slice(indent, next.text.length)
        // A cut inside a word first, then a cut at a space the wrap ate.
        await walk(k + 1, text + more, [...cells, ...moreCells], text.length)
        if (!/[\\/]$/.test(text))
          await walk(k + 1, `${text} ${more}`, [...cells, cells[cells.length - 1], ...moreCells], text.length + 1)
      }
      await walk(s, line.text.slice(at), line.cells.slice(at, line.text.length), 0)
      filesOnly = false
      if (!best) await walk(s, line.text.slice(at), line.cells.slice(at, line.text.length), 0)
      if (best) found.push(best)
    }
  }
  return found
}
