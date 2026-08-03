// What `runSafe` actually hands the program it runs.
//
// On Windows every command in lane.mjs is spawned with `shell: true`, because `gh` and
// `npx` are `.cmd` shims and Node cannot exec those directly. That option concatenates
// the arguments into one command line and does NOT escape them - Node warns about it
// itself (DEP0190) - so cmd.exe re-reads them as syntax. A space splits an argument in
// two; `&`, `|`, `<`, `>` and `^` split the whole COMMAND in two.
//
// This is what that cost, and it is the reason this file exists rather than a comment:
//
//   gh api "repos/o/r/actions/runs?event=push&per_page=10" --jq '[...head_branch]'
//
// ran as `gh api repos/o/r/actions/runs?event=push` AND THEN `per_page=10 --jq [...]`.
// The first half answered - with the whole 380 KB of unfiltered JSON, because the `--jq`
// had been swept into the second half. The second half is not a program, so it exited 1,
// and `spawnSync` reports the LAST status. The call therefore returned `ok: false` while
// holding a perfectly good answer.
//
// `publishFallback` polls with exactly that call to ask "did Actions build this tag?", so
// for as long as the bug lived the answer was always no. Every release built a SECOND set
// of installers on this machine and published them over the ones Actions had already
// uploaded. Binaries are first-write-wins and `latest.yml` is last-write-wins, so the pair
// tears: v0.4.27 shipped a feed naming the other build's installer and every Windows
// auto-update failed its hash check, with nobody to report it.
//
// So the test is not "does the string look quoted". It runs a real cmd.exe and requires
// the child process to receive, byte for byte, the arguments that were passed - including
// the ones that are nothing but cmd syntax.
//
//   node scripts/lane-args-test.mjs

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

// lane.mjs runs its CLI on import, so the function is lifted out of the source rather
// than imported. Reading the shipping text is the point: a test with its own copy of
// the quoting would pass while the released one was broken.
const src = readFileSync(join(HERE, 'lane.mjs'), 'utf8')
const fn = /\nfunction cmdQuote\(arg\) \{[\s\S]*?\n\}/.exec(src)
if (!fn) {
  console.error('cmdQuote is gone from lane.mjs - if it was renamed, rename it here too.')
  process.exit(1)
}
const cmdQuote = new Function(`${fn[0]}; return cmdQuote`)()

// A child that reports precisely what it was given.
const dir = mkdtempSync(join(tmpdir(), 'pf-args-'))
const echo = join(dir, 'echo-argv.mjs')
writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8')

// The arguments that matter, each with the reason it is here.
const CASES = [
  ['the bug: a query string with &', 'repos/o/r/actions/runs?event=push&per_page=10'],
  ['a jq filter with brackets', '[.workflow_runs[].head_branch]'],
  ['a jq filter with a space and a pipe', '.body | select(. != null)'],
  ['a path with spaces', 'C:\\Program Files\\PaneForge\\PaneForge Setup.exe'],
  ['redirection and caret', 'a<b>c^d'],
  ['parentheses', 'x(1)&&y'],
  ['an empty argument', ''],
  ['a trailing backslash', 'C:\\dist\\'],
  ['an embedded quote', 'say "hi" twice'],
  ['a quote after backslashes', 'a\\\\"b'],
  ['a semicolon and comma', 'a;b,c'],
  ['a percent that is not a variable', '100%'],
  ['an ordinary flag', '--clobber']
]

const shell = process.platform === 'win32'
console.log(`runSafe argument round-trip (shell: ${shell})`)

// One command carrying every case at once: an argument that splits does not merely
// corrupt itself, it shifts every argument after it, and passing them together is what
// catches that.
const all = CASES.map(([, v]) => v)
const r = spawnSync('node', shell ? [echo, ...all].map(cmdQuote) : [echo, ...all], {
  encoding: 'utf8',
  shell,
  windowsHide: true,
  timeout: 30_000
})

ok('the command itself succeeds', r.status === 0, `status ${r.status} ${(r.stderr || '').trim()}`)

let got = []
try {
  got = JSON.parse((r.stdout || '').trim())
} catch {
  ok('the child printed its arguments', false, JSON.stringify((r.stdout || '').slice(0, 200)))
}

ok('the argument COUNT is unchanged', got.length === all.length, `${got.length} of ${all.length}`)
CASES.forEach(([name, want], i) => {
  ok(name, got[i] === want, `got ${JSON.stringify(got[i])}, want ${JSON.stringify(want)}`)
})

// And the specific shape of the original failure: cmd must not have run a second command.
if (shell) {
  const stderr = (r.stderr || '').trim()
  ok(
    'cmd did not run half of it as a separate command',
    !/is not recognized as an internal or external command/.test(stderr),
    stderr.slice(0, 160)
  )
}

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
