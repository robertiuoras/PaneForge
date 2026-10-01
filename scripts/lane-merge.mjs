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
    const kept = []
    for (const l of both) {
      const key = l.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      kept.push(l)
    }
    const joined = joinSameSource(kept)
    if (joined === null) return null
    out.push(...joined)
    healed++
    i = end + 1
  }
  return healed ? out.join('\n') : null
}

/** `import { a, type B } from 'x'` on one line - the only shape two sides can be folded in. */
const BRACE_IMPORT = /^(\s*)import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"])([^'"]+)\4\s*;?\s*$/
const SOURCE = /\bfrom\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/

/**
 * Two lines importing from ONE module are one line each side edited, not two additions.
 *
 * 2026-09-25, faec0266 "merge lane a": master had
 * `import { handoffReceiverCanQuit, INTERRUPT_WAIT_MS, type HandoffItem, type HandoffRequest } from '../shared/handoff'`
 * and lane a had the same line with three more names. The union kept both, every name
 * was declared twice, and master stopped compiling (TS2300 Duplicate identifier).
 * Plain brace imports are folded into one line holding every name either side had;
 * any other shape importing one module twice is left for a person.
 */
function joinSameSource(lines) {
  const bySource = new Map()
  for (const l of lines) {
    const m = SOURCE.exec(l)
    if (!m) continue
    const src = m[1] ?? m[2]
    bySource.set(src, [...(bySource.get(src) ?? []), l])
  }
  const out = []
  const done = new Set()
  for (const l of lines) {
    const m = SOURCE.exec(l)
    const group = m ? bySource.get(m[1] ?? m[2]) : null
    if (!group || group.length < 2) {
      out.push(l)
      continue
    }
    if (done.has(group)) continue
    done.add(group)
    const parsed = group.map((g) => BRACE_IMPORT.exec(g))
    if (parsed.some((p) => !p || Boolean(p[2]) !== Boolean(parsed[0][2]))) return null
    const names = []
    for (const p of parsed)
      for (const n of p[3].split(',').map((s) => s.trim()).filter(Boolean))
        if (!names.includes(n)) names.push(n)
    const [, indent, typeOnly, , quote, src] = parsed[0]
    const semi = group[0].trimEnd().endsWith(';') ? ';' : ''
    out.push(`${indent}import ${typeOnly ?? ''}{ ${names.join(', ')} } from ${quote}${src}${quote}${semi}`)
  }
  return out
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

/** A markdown table row, and the `|---|---|` rule under a header that starts a table. */
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/

/**
 * Two lanes that each ADDED rows to one markdown table at the same spot, or refuse.
 *
 * research-lab files every finding as one row of CATALOG.md, always in the same place, so
 * any two research chats at once conflicted there (5 of its 6 CATALOG refusals since
 * 2026-09-18; one of the two alerts on screen at 3:49am on 2026-10-02). Takes diff3 text:
 * a hunk is settled only when its base section is EMPTY, because without the base a row one
 * side rewrote (research-lab 4c61956: "AI diagnostic offer" -> "... and agency offers")
 * looks exactly like a row it added, and keeping both would put the old wording back.
 */
export function mergeTableRowConflicts(diff3) {
  const lines = diff3.split('\n')
  const out = []
  let healed = 0
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i])
      i++
      continue
    }
    let base = -1
    let sep = -1
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (base < 0 && lines[j].startsWith('|||||||')) base = j
      else if (base >= 0 && sep < 0 && lines[j].startsWith('=======')) sep = j
      else if (sep >= 0 && lines[j].startsWith('>>>>>>>')) {
        end = j
        break
      }
    }
    // No base section, or one with lines in it: that is a rewrite, or nobody can tell.
    if (base < 0 || sep !== base + 1 || end < 0) return null
    const ours = lines.slice(i + 1, base)
    const theirs = lines.slice(sep + 1, end)
    if (!ours.length || !theirs.length) return null
    if (![...ours, ...theirs].every((l) => TABLE_ROW.test(l) && !TABLE_RULE.test(l))) return null
    out.push(...dedupe([...ours, ...theirs]))
    healed++
    i = end + 1
  }
  return healed ? out.join('\n') : null
}

/** Key order is not content: `{a, b}` and `{b, a}` are the same entry. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/**
 * Two lanes that each ADDED whole entries to one generated JSON list, or refuse.
 *
 * research-lab's library/index.json gets one entry per finding, at the top: 6 of 6 of its
 * refusals since 2026-09-18 were two lanes each adding their own. Git cuts those hunks in
 * the MIDDLE of entries (neighbours share lines like `"tags": []`), so no rule reading the
 * markers can settle them - parsed, the answer is plain. Takes the three whole versions.
 *
 * Settled only when every side is an array of objects with a unique `id`, every entry the
 * base had is still there unchanged and in the same order on both sides, and an id both
 * sides added has the same body. The result is written the way the file already was, and
 * a file that is not exactly what JSON.stringify writes is never rewritten at all.
 */
export function mergeJsonListAdds(base, ours, theirs) {
  let b, o, t
  try {
    ;[b, o, t] = [JSON.parse(base), JSON.parse(ours), JSON.parse(theirs)]
  } catch {
    return null
  }
  if (![b, o, t].every(Array.isArray)) return null
  const idOf = (e) =>
    e && typeof e === 'object' && !Array.isArray(e) && (typeof e.id === 'string' || typeof e.id === 'number')
      ? String(e.id)
      : null
  const byId = (list) => {
    const m = new Map()
    for (const e of list) {
      const id = idOf(e)
      if (id === null || m.has(id)) return null
      m.set(id, canon(e))
    }
    return m
  }
  const [bi, oi, ti] = [byId(b), byId(o), byId(t)]
  if (!bi || !oi || !ti) return null
  for (const [id, body] of bi) if (oi.get(id) !== body || ti.get(id) !== body) return null
  const baseOrder = (list) => list.map(idOf).filter((id) => bi.has(id)).join('\n')
  const want = [...bi.keys()].join('\n')
  if (baseOrder(o) !== want || baseOrder(t) !== want) return null

  const indent = /^\[\r?\n([ \t]+)/.exec(ours)?.[1] ?? 2
  const nl = ours.endsWith('\n') ? '\n' : ''
  const write = (list) => JSON.stringify(list, null, indent) + nl
  if (write(o) !== ours || write(t) !== theirs) return null

  // Ours as it is; each of theirs goes in just before the entry it preceded on their side,
  // so two lanes that both added at the top read ours first, then theirs.
  const out = [...o]
  let before = null
  for (let k = t.length - 1; k >= 0; k--) {
    const id = idOf(t[k])
    if (oi.has(id)) {
      if (oi.get(id) !== canon(t[k])) return null
    } else {
      out.splice(before === null ? out.length : out.findIndex((x) => idOf(x) === before), 0, t[k])
    }
    before = id
  }
  return write(out)
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
