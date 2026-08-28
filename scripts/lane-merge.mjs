// The conflicts that are not disagreements.
//
// Split out of lane.mjs so it can be tested without running the CLI - lane.mjs dispatches
// on argv at the top level, so importing it IS running it.
//
// What this exists for: on 2026-08-02 lane c held a finished feature out of two releases
// because master had added `import { agentsMidTurn }` four lines away from the lane's
// `import { installLaneHooks }`. Both lines were wanted. There was no decision to make,
// and a human still had to open the file and type back the exact text git already had on
// both sides.

/**
 * Lines whose two versions are not an argument.
 *
 * An import list is a SET the compiler sorts out, not an order anyone chose. Deliberately
 * narrow: anything that is not one of these shapes is a real disagreement and stays a real
 * conflict. Comment lines are allowed only because they ride along inside import blocks -
 * they are never what a hunk is made of on their own, since a hunk of nothing but comments
 * still has to contain an import line to reach here.
 */
const IMPORT_LINE =
  /^\s*(?:\/\/|#|\*|import\b|export\s+(?:\*|\{|type\b|default\b)[^=]*\bfrom\b|(?:const|let|var)\s+[\w{},\s*:]+\s*=\s*require\(|from\s+[\w.]+\s+import\b|use\s+[\w:{}, *]+;)/

/**
 * Union both sides of an import-only conflict, or refuse.
 *
 * Returns the resolved text, or null the moment a hunk holds anything that is not an
 * import - one real conflict anywhere in the file and the whole file is a human's, because
 * a half-resolved file is worse than an unresolved one. Also refuses diff3-style markers:
 * a base section means three versions to reason about, and this only knows how to add.
 */
export function mergeImportConflicts(text) {
  const lines = text.split('\n')
  const out = []
  let healed = 0
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i])
      i++
      continue
    }
    let sep = -1
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('|||||||')) return null
      if (sep < 0 && lines[j].startsWith('=======')) sep = j
      else if (lines[j].startsWith('>>>>>>>')) {
        end = j
        break
      }
    }
    if (sep < 0 || end < 0) return null
    const ours = lines.slice(i + 1, sep)
    const theirs = lines.slice(sep + 1, end)
    const both = [...ours, ...theirs]
    // A side that is empty means one lane DELETED the line the other added, which is a
    // decision, not an addition.
    if (!ours.length || !theirs.length) return null
    if (!both.every((l) => !l.trim() || IMPORT_LINE.test(l))) return null
    if (!both.some((l) => /\b(import|require|use)\b/.test(l))) return null
    // Ours first, theirs after, and a line both sides added only appears once.
    const seen = new Set()
    for (const l of both) {
      const key = l.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(l)
    }
    healed++
    i = end + 1
  }
  return healed ? out.join('\n') : null
}

/**
 * Union both sides of a markdown conflict where both sides appended separate sections or items.
 */
export function mergeMarkdownConflicts(text) {
  const lines = text.split('\n')
  const out = []
  let healed = 0
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i])
      i++
      continue
    }
    let sep = -1
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('|||||||')) return null
      if (sep < 0 && lines[j].startsWith('=======')) sep = j
      else if (lines[j].startsWith('>>>>>>>')) {
        end = j
        break
      }
    }
    if (sep < 0 || end < 0) return null
    const ours = lines.slice(i + 1, sep)
    const theirs = lines.slice(sep + 1, end)
    if (!ours.length || !theirs.length) return null

    const hasOursHeadings = ours.some((l) => /^#{1,6}\s+/.test(l.trim()))
    const hasTheirsHeadings = theirs.some((l) => /^#{1,6}\s+/.test(l.trim()))
    const hasOursBullets = ours.some((l) => /^[-*]\s+/.test(l.trim()))
    const hasTheirsBullets = theirs.some((l) => /^[-*]\s+/.test(l.trim()))

    if ((hasOursHeadings && hasTheirsHeadings) || (hasOursBullets && hasTheirsBullets)) {
      out.push(...ours)
      if (ours[ours.length - 1]?.trim() && theirs[0]?.trim()) out.push('')
      out.push(...theirs)
      healed++
      i = end + 1
      continue
    }
    return null
  }
  return healed ? out.join('\n') : null
}


/** Ignore-style files: one pattern per line, order only matters when negation is in play. */
const LIST_FILES = /(?:^|\/)\.(?:git|npm|docker|eslint|prettier|vercel)ignore$/

/** `"key": value` or `"key": value,` - one member of a JSON object, on its own line. */
const JSON_MEMBER = /^\s*"([^"]+)"\s*:\s*.+?,?\s*$/

/**
 * Union both sides of a conflict that is two lanes APPENDING TO ONE LIST, or refuse.
 *
 * The commonest lane conflict there is, and the one with the least in it to decide.
 * Measured on taskdriver.ai over the fortnight to 2026-08-28: 10 of 92 lane merges needed
 * a human, and the subjects say what they were - "keep both sides of the test script
 * list", "union of both sides' test scripts", "keep both test scripts", plus a .gitignore
 * where one lane ignored a scratch file and the other ignored the logs beside it. Every
 * one of them was retyping text git already held on both sides.
 *
 * Two shapes only:
 *   - a `.gitignore` and its siblings, which are a SET of patterns - except when either
 *     side carries a `!` negation, where order IS the meaning and a person decides;
 *   - JSON object members (`package.json`'s script map is the one that keeps happening),
 *     when the two sides declare DIFFERENT keys. The same key with two values is a real
 *     disagreement and stays one.
 *
 * Anything else in any hunk refuses the whole file: a half-resolved file is worse than an
 * unresolved one.
 */
export function mergeListConflicts(text, filePath = '') {
  const isList = LIST_FILES.test(filePath)
  const isJson = filePath.endsWith('.json')
  if (!isList && !isJson) return null
  const lines = text.split('\n')
  const out = []
  let healed = 0
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i])
      i++
      continue
    }
    let sep = -1
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      // diff3 markers mean three versions to reason about; this only knows how to add.
      if (lines[j].startsWith('|||||||')) return null
      if (sep < 0 && lines[j].startsWith('=======')) sep = j
      else if (lines[j].startsWith('>>>>>>>')) {
        end = j
        break
      }
    }
    if (sep < 0 || end < 0) return null
    const ours = lines.slice(i + 1, sep).filter((l) => l.trim())
    const theirs = lines.slice(sep + 1, end).filter((l) => l.trim())
    // An empty side means one lane DELETED what the other added. That is a decision.
    if (!ours.length || !theirs.length) return null

    let merged = null
    if (isList) {
      // `!pattern` un-ignores something ignored ABOVE it, so where a line sits changes
      // what the file means and a union is not safe.
      if ([...ours, ...theirs].some((l) => l.trim().startsWith('!'))) return null
      merged = dedupe([...ours, ...theirs])
    } else {
      const both = [...ours, ...theirs]
      if (!both.every((l) => JSON_MEMBER.test(l))) return null
      const keyOf = (l) => JSON_MEMBER.exec(l)[1]
      const ourKeys = new Set(ours.map(keyOf))
      // The same key on both sides is two answers to one question - that is the human's.
      if (theirs.some((l) => ourKeys.has(keyOf(l)))) return null
      // The last member of a JSON object carries no comma and every earlier one must. Both
      // sides sit in the same slot, so they agree on that unless the hunk straddles the end
      // of the object, which is not a shape worth guessing at.
      const comma = (l) => l.trimEnd().endsWith(',')
      if (comma(ours[ours.length - 1]) !== comma(theirs[theirs.length - 1])) return null
      const tail = comma(theirs[theirs.length - 1])
      merged = dedupe(both).map((l, idx, all) => {
        const bare = l.trimEnd().replace(/,$/, '')
        return idx === all.length - 1 ? (tail ? bare + ',' : bare) : bare + ','
      })
    }
    out.push(...merged)
    healed++
    i = end + 1
  }
  return healed ? out.join('\n') : null
}

/** Ours first, theirs after, and a line both sides added appears once. */
function dedupe(lines) {
  const seen = new Set()
  const out = []
  for (const l of lines) {
    const key = l.trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/**
 * Auto-merge non-conflicting additions across imports, markdown sections, and logs.
 */
export function mergeAutoConflicts(text, filePath = '') {
  if (filePath.endsWith('.md')) {
    const md = mergeMarkdownConflicts(text)
    if (md !== null) return md
  }
  const list = mergeListConflicts(text, filePath)
  if (list !== null) return list
  return mergeImportConflicts(text)
}
