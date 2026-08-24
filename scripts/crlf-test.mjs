// A test that reads a SOURCE FILE may not spell the line break `\n`.
//
// This is the one class of test whose input is a file on disk in whatever line endings the
// machine checked out, and on Windows that is CRLF. A source assertion - "this guard is
// still inside that effect", "strip the interface before evaluating this module" - is
// written as a regex over the file's text, and a pattern spelling a bare `\n` cannot match
// a `\r\n` file. It does not fail loudly as a bad pattern; it silently matches nothing.
//
// Both spellings of that failure had already shipped on master and were red for three days
// while every automatic release was refused for a "failing suite" nobody had opened:
//
//   mascot-test.mjs          /const ms = hideAfterMs\(cfg\)\n\s*if \(!ms \|\| soon\) return/
//     -> reported a missing early-return that is on line 298 of Mascot.tsx
//   settings-search-test.mjs .replace(/export interface SettingEntry \{[\s\S]*?\n\}\n/, '')
//     -> stripped nothing, so raw TypeScript reached `new Function` (Unexpected token 'export')
//
// `\r?\n` costs nothing and is true on both machines, so the rule is simply that a bare
// `\n` may not appear in a regex inside a file that reads source off disk. The check is
// deliberately narrow: only files that call readFileSync/readFile, and only regex
// LITERALS - a `\n` in an ordinary string is a line break somebody is writing, not one
// they are matching.
//
//   node scripts/crlf-test.mjs

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'scripts')

let checks = 0
const ok = (what, cond, extra) => {
  assert.ok(cond, extra ? `${what} - ${extra}` : what)
  checks++
}

/**
 * Regex literals in a chunk of JavaScript, found without parsing it.
 *
 * A slash starts a regex only where a value may start, so the character before it decides:
 * after a name, a number, a `)` or a `]` it is division. That is the whole ambiguity, and
 * getting it wrong here costs a false positive on a source file nobody would think to look
 * at - so a line that is a comment is skipped outright, and anything still ambiguous is
 * left OUT rather than guessed at.
 */
function regexLiterals(src) {
  const out = []
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '/') continue
      const before = line.slice(0, i).replace(/\s+$/, '')
      const prev = before[before.length - 1]
      // `//` is a comment, `/*` opens one, and a value cannot follow a name or a `)`.
      if (line[i + 1] === '/' || line[i + 1] === '*') break
      if (prev && /[\w)\]]/.test(prev)) continue
      let body = ''
      let j = i + 1
      let escaped = false
      let inClass = false
      for (; j < line.length; j++) {
        const c = line[j]
        if (escaped) { body += c; escaped = false; continue }
        if (c === BS) { body += c; escaped = true; continue }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        body += c
      }
      if (j >= line.length) continue // never closed on this line: not a literal
      if (!body) continue
      out.push({ body, line: rawLine.trim() })
      i = j
    }
  }
  return out
}

/**
 * Is this pattern asserting a line break that a CRLF file cannot satisfy?
 *
 * A bare `\\n` is NOT wrong on its own - it matches the LF inside a CRLF perfectly well. What
 * breaks is demanding a literal character IMMEDIATELY before it: `\\\\)\\n` says a close
 * paren followed by the break, and the file has a carriage return between the two. So the
 * test is on what precedes the break. A quantifier, a class, a group end or an `\\r?` all
 * absorb the CR and are fine; an escaped literal like `\\\\)` or `\\\\}` is the bug,
 * and both shipped shapes were exactly that.
 */
const BS = String.fromCharCode(92)
function bareNewline(body) {
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] !== BS || body[i + 1] !== 'n') continue
    // An even run of backslashes means this is a literal backslash followed by n.
    let slashes = 0
    for (let k = i; k >= 0 && body[k] === BS; k--) slashes++
    if (slashes % 2 === 0) continue
    if (inClassAt(body, i)) continue // a class is membership, not a line break
    const before = body.slice(0, i)
    if (before.endsWith(BS + 'r?') || before.endsWith(BS + 'r')) continue
    if (!before) continue // the break opens the pattern: nothing is being demanded before it
    const prev = before[before.length - 1]
    // Is that predecessor itself ESCAPED? The backslashes are the ones before IT, not the
    // ones before the break - which is the whole distinction between a group end `)` and a
    // literal close paren `\\)`, and getting it the other way round let the mascot pattern
    // through while the check still reported green.
    const runBefore = before.slice(0, -1)
    let esc = 0
    for (let k = runBefore.length - 1; k >= 0 && runBefore[k] === BS; k--) esc++
    const escaped = esc % 2 === 1
    // A quantifier or a group/class END absorbs the CR; an ESCAPED one is a literal char.
    if (!escaped && ('*+?}])|(:'.includes(prev))) continue
    // Two breaks in a row is a blank-line matcher, a different intent from 'this exact
    // character, then the break' - and the caller is usually matching its own output.
    if (before.endsWith(BS + 'n')) continue
    return true
  }
  return false
}

/** Is offset i inside a character class? */
function inClassAt(body, i) {
  let open = false
  for (let k = 0; k < i; k++) {
    if (body[k] === BS) { k++; continue }
    if (body[k] === '[') open = true
    else if (body[k] === ']') open = false
  }
  return open
}

// --- the rule ------------------------------------------------------------------------
const READS_SOURCE = /readFileSync\(|readFile\(/
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'))
ok('there are test scripts to check', files.length > 10, `${files.length} found`)

const offenders = []
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8')
  if (!READS_SOURCE.test(src)) continue
  for (const r of regexLiterals(src)) {
    if (bareNewline(r.body)) offenders.push(`${f}: /${r.body}/`)
  }
}
ok(
  'no test matches a regex with a bare \n against a file it read off disk',
  offenders.length === 0,
  offenders.join('\n     ')
)

// --- and the check itself is red-proofed ----------------------------------------------
// Every line below would have caught one of the two that shipped. Without them a rule
// that never matches anything passes for ever, which is the same failure it exists to stop.
const F = (body) => bareNewline(body)
ok('the mascot pattern is caught', F(String.raw`const ms = hideAfterMs\(cfg\)\n\s*if`))
ok('the settings pattern is caught', F(String.raw`export interface X \{[\s\S]*?\n\}\n`))
ok('...and the fixed spelling is not', !F(String.raw`hideAfterMs\(cfg\)\r?\n\s*if`))
ok('an explicit \r\n is not flagged', !F(String.raw`foo\r\nbar`))
ok('a literal backslash-n is not a line break', !F(`spelled ${BS}${BS}n here`))
ok('a class is membership, not a line break', !F('[;' + BS + 'n]'))
ok('a quantifier before the break absorbs the CR', !F(BS + 's*' + BS + 'n' + BS + 's*'))
ok('a break that OPENS the pattern demands nothing before it', !F(BS + 'nfunction x'))
ok('an alternation before the break is not a literal', !F('(?:^|' + BS + 'n)' + BS + 's*import'))
ok('a blank-line matcher is a different intent', !F(BS + 'n' + BS + 'n'))
ok('a pattern with no newline at all is fine', !F(String.raw`^\s*ok\b`))

// The extractor must find a regex where one really is, and must not invent one out of a
// division or a comment - a false positive here fails a suite over nothing.
const found = (src) => regexLiterals(src).map((r) => r.body)
ok('a plain regex literal is found', found('const r = /ab' + BS + 'nc/.test(s)').includes('ab' + BS + 'nc'))
ok('division is not a regex', found('const x = (a) / b / c').length === 0)
ok('a comment is skipped', found('// see /foo' + BS + 'n/ in the notes').length === 0)
ok('a class holding a slash does not end the literal', found('x.replace(/[/' + BS + 'n]/g, "")').length === 1)

console.log(`\n${checks} checks - all good`)
