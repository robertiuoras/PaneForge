// A unified diff, turned into something a component can draw.
//
// The app ships two runtime dependencies and a diff library would be a third. It is also
// unnecessary: `git diff` already produces the patch, and has produced a correct one for
// twenty years against every rename, mode change and CRLF file this would otherwise have
// to get right by itself. So nothing here computes a diff - it reads one.
//
// What it adds is the part git does not put in the text: the line NUMBERS. A unified hunk
// header says where a hunk starts and nothing about where any individual line inside it
// lives, so a viewer that wants a gutter has to count, and counting is the one thing in a
// patch that is easy to get subtly wrong (a `\ No newline at end of file` marker is not a
// line, and a context line advances both sides while an addition advances one).
//
// Tested without a window by scripts/diff-test.mjs.

export type PatchLineKind = 'add' | 'del' | 'ctx' | 'meta'

export interface PatchLine {
  kind: PatchLineKind
  /** the line itself, with the leading +/-/space already removed */
  text: string
  /** its number on the left side, null for an addition */
  oldNo: number | null
  /** its number on the right side, null for a deletion */
  newNo: number | null
}

export interface PatchHunk {
  /** what git wrote after the second `@@` - usually the enclosing function */
  heading: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: PatchLine[]
}

export interface ParsedPatch {
  hunks: PatchHunk[]
  /** git said it could not diff this one as text */
  binary: boolean
  /** the file was cut short before parsing, so the last hunk may be partial */
  truncated: boolean
  added: number
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * `truncated` is passed in rather than worked out: whoever read the patch is the only one
 * that knows whether git's output was cut off, and a parser that guessed from a missing
 * trailing newline would call every last hunk suspect.
 */
export function parsePatch(text: string, truncated = false): ParsedPatch {
  const hunks: PatchHunk[] = []
  let current: PatchHunk | null = null
  let oldNo = 0
  let newNo = 0
  let binary = false
  let added = 0
  let removed = 0

  for (const raw of text.split('\n')) {
    // Strip a CR that came from a CRLF file, but only the one git added to the line
    // ending - a file with literal CRs mid-line keeps them.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    const m = HUNK.exec(line)
    if (m) {
      current = {
        heading: m[5] ?? '',
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: []
      }
      oldNo = current.oldStart
      newNo = current.newStart
      hunks.push(current)
      continue
    }

    if (!current) {
      // Everything before the first hunk is git's header. The only part of it worth
      // anything here is the sentence that says there are no hunks coming.
      if (/^(Binary files .* differ|GIT binary patch)/.test(line)) binary = true
      continue
    }

    // Not a line of the file: it is git telling you the file it just quoted has no final
    // newline. It belongs on screen (its absence changes what a byte-level reader sees)
    // and it must not advance either counter.
    if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: line.slice(2), oldNo: null, newNo: null })
      continue
    }

    const marker = line[0]
    const body = line.slice(1)
    if (marker === '+') {
      current.lines.push({ kind: 'add', text: body, oldNo: null, newNo: newNo++ })
      added++
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', text: body, oldNo: oldNo++, newNo: null })
      removed++
    } else if (marker === ' ') {
      current.lines.push({ kind: 'ctx', text: body, oldNo: oldNo++, newNo: newNo++ })
    } else if (line === '') {
      // A truly empty line inside a hunk is a context line whose single space git (or
      // something that touched the patch on the way here) dropped. Treating it as the end
      // of the hunk instead is what makes a viewer lose the second half of a file.
      current.lines.push({ kind: 'ctx', text: '', oldNo: oldNo++, newNo: newNo++ })
    } else {
      // `diff --git` of the NEXT file in a multi-file patch, or anything else unexpected.
      current = null
      if (/^(Binary files .* differ|GIT binary patch)/.test(line)) binary = true
    }
  }

  return { hunks, binary, truncated, added, removed }
}

/**
 * Records in git's `-z` output.
 *
 * Everything that lists paths is read with `-z`, because the alternative is git quoting
 * any path with a space or a non-ASCII byte in it and the reader having to un-quote C
 * escapes correctly. A NUL cannot appear in a path, so this split is exact.
 */
export function zSplit(out: string): string[] {
  const parts = out.split('\0')
  // The stream ends with a NUL, so the split leaves one empty tail.
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}
