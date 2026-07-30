// A word-level diff for the sheet, in sixty lines and no dependency.
//
// The same rule the git diff view is held to: this app ships two runtime dependencies and
// a diff library would be a third for one overlay. Word level rather than line level
// because an improved prompt is prose - a line diff of a rewritten paragraph is one line
// removed and one line added, which shows nothing.

export type DiffOp = 'same' | 'add' | 'remove'

export interface DiffPart {
  op: DiffOp
  text: string
}

/** Split into words while keeping the whitespace, so the diff can be rendered verbatim. */
function tokenise(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

/**
 * Longest common subsequence over words.
 *
 * O(n·m) in both time and memory, which is fine at the sizes involved: the improved draft
 * is capped at 6000 characters, so the table is at most about a thousand by a thousand.
 * Anything larger is refused before it reaches here.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenise(before)
  const b = tokenise(after)

  // Trim the common head and tail first. On the common case - a prompt that kept most of
  // its wording - this removes almost all of the table.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  const rows = midA.length
  const cols = midB.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] =
        midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const parts: DiffPart[] = []
  const push = (op: DiffOp, text: string): void => {
    const last = parts[parts.length - 1]
    if (last && last.op === op) last.text += text
    else parts.push({ op, text })
  }

  if (head) push('same', a.slice(0, head).join(''))
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (midA[i] === midB[j]) {
      push('same', midA[i])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('remove', midA[i])
      i++
    } else {
      push('add', midB[j])
      j++
    }
  }
  while (i < rows) push('remove', midA[i++])
  while (j < cols) push('add', midB[j++])
  if (tail) push('same', a.slice(a.length - tail).join(''))

  return parts.filter((p) => p.text.length > 0)
}

/**
 * How much of the draft actually changed, 0 to 1.
 *
 * The number behind "leave already-good prompts mostly unchanged": a good prompt should
 * come back with a small ratio, and the sheet says so rather than pretending it rewrote
 * something.
 */
export function changeRatio(before: string, after: string): number {
  const parts = diffWords(before, after)
  let same = 0
  let changed = 0
  for (const p of parts) {
    const n = p.text.trim().length
    if (p.op === 'same') same += n
    else changed += n
  }
  const total = same + changed
  return total === 0 ? 0 : changed / total
}
