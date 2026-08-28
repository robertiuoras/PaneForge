// What an agent pane is still running once its turn is over - and, much more of this file,
// what it must never claim.
//
// The whole feature turns on one measurement: a `claude` pane holds MCP servers and a
// `caffeinate` for its entire life, so a count of the pty's descendants is 3-8 with nothing
// whatever happening. The fixtures below are real trees off this Mac on 2026-08-24 (four
// live panes, tree sizes 5/7/9/9) and the load-bearing half of the test is the negatives:
// every one of those permanent processes must be refused, and the CONTROL is that the naive
// reading - descendants minus the CLI - would have counted them.
//
//   node scripts/pane-backjobs-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-panebackjobs-test')

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'panebackjobs.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/paneBackJobs.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { JOB_MIN_SECONDS, isCommandShell, jobLabel, jobWords, paneBackJobs } = require(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const SNAP = '/Users/robertiuoras/.claude/shell-snapshots/snapshot-zsh-1787494420945-osom0x.sh'
const shellCmd = (tail) => `/bin/zsh -c source ${SNAP} 2>/dev/null || true && ${tail}`

// ---------------------------------------------------------------------------
// A real pane, measured. pid 22457, tree size 9, one background task in it.

const REAL = [
  { pid: 22457, ppid: 1, elapsed: 3991, cmd: '/Users/robertiuoras/.local/bin/claude --dangerously-skip-permissions --resume 05f48946' },
  { pid: 22990, ppid: 22457, elapsed: 3989, cmd: '/usr/bin/safaridriver --mcp' },
  { pid: 22992, ppid: 22457, elapsed: 3989, cmd: 'node /Users/robertiuoras/.nvm/versions/node/v22.21.1/bin/codegraph serve --mcp' },
  { pid: 23064, ppid: 22992, elapsed: 3989, cmd: '/Users/robertiuoras/.nvm/.../codegraph-darwin-arm64' },
  { pid: 23714, ppid: 23064, elapsed: 3987, cmd: '/Users/robertiuoras/.nvm/.../codegraph-darwin-arm64' },
  { pid: 24198, ppid: 23714, elapsed: 3986, cmd: '/Users/robertiuoras/.nvm/.../codegraph-darwin-arm64' },
  { pid: 62835, ppid: 22457, elapsed: 2350, cmd: shellCmd('tail -f /tmp/tasks/bep4fghcx.output') },
  { pid: 62838, ppid: 62835, elapsed: 2350, cmd: 'tail -f /tmp/tasks/bep4fghcx.output' },
  { pid: 62839, ppid: 62835, elapsed: 2350, cmd: 'ugrep -G --ignore-files --hidden -I' }
]

const real = paneBackJobs(REAL, 22457)
is(real.length, 1, 'one background task in a tree of nine')
is(real[0].pid, 62835, 'the shell subtree is the job, not the leaf and not the pty')
is(real[0].label, 'tail', 'and it is named by what it was told to run')

// The CONTROL. Without the shell rule this pane reports eight jobs, permanently, and the
// chip is on for every pane on the desk for ever.
is(REAL.filter((r) => r.pid !== 22457).length, 8, 'descendants-minus-the-CLI would have said eight')

// ---------------------------------------------------------------------------
// The permanent machinery, one refusal each. These are what made the naive reading useless.

const IDLE = [
  { pid: 2551, ppid: 1, elapsed: 3238, cmd: '/Users/robertiuoras/.local/bin/claude --dangerously-skip-permissions' },
  { pid: 2659, ppid: 2551, elapsed: 3236, cmd: '/usr/bin/safaridriver --mcp' },
  { pid: 2660, ppid: 2551, elapsed: 3236, cmd: 'chrome-devtools-mcp' },
  { pid: 3056, ppid: 2660, elapsed: 3235, cmd: '/opt/homebrew/Cellar/node/24.10.0/bin/node .../chrome-devtools-mcp/build/src/index.js' },
  { pid: 83648, ppid: 2551, elapsed: 222, cmd: 'caffeinate -i -t 300' }
]
is(paneBackJobs(IDLE, 2551), [], 'an idle pane full of MCP servers is running nothing')
ok(!isCommandShell('/usr/bin/safaridriver --mcp'), 'an MCP server is not a shell')
ok(!isCommandShell('caffeinate -i -t 300'), 'and neither is the CLI keeping the machine awake')
ok(!isCommandShell('node .../codegraph serve --mcp'), 'a node process is not a shell however long its line')

// ---------------------------------------------------------------------------
// The floor, which is what keeps a hook out of the list

const HOOKS = [
  { pid: 15868, ppid: 1, elapsed: 1656, cmd: '/Users/robertiuoras/.local/bin/claude' },
  { pid: 11582, ppid: 15868, elapsed: 2, cmd: shellCmd('tail -f -n +1 /tmp/scratch/x.log') },
  { pid: 11604, ppid: 11582, elapsed: 2, cmd: 'tail -f -n +1 /tmp/scratch/x.log' }
]
is(paneBackJobs(HOOKS, 15868), [], 'a shell two seconds old is this repo firing a hook, not a job')
is(JOB_MIN_SECONDS, 30, 'thirty seconds - the floor backJobs.ts already uses, for its reason')
is(paneBackJobs(HOOKS, 15868, 1).length, 1, 'and the floor is the only thing refusing it')

// ---------------------------------------------------------------------------
// Shape rules

ok(isCommandShell('/bin/zsh -c ls'), 'a shell with -c was started to run something')
ok(!isCommandShell('-zsh'), 'a login shell was started to sit at a prompt')
ok(!isCommandShell('/bin/zsh'), 'and so was a bare one')
ok(isCommandShell('cmd.exe /c npm run build'), 'Windows says /c')
ok(isCommandShell('powershell -NoProfile -Command Get-Date'), 'and PowerShell says -Command')

const NESTED = [
  { pid: 10, ppid: 1, elapsed: 900, cmd: '/usr/local/bin/claude' },
  { pid: 11, ppid: 10, elapsed: 600, cmd: shellCmd('npm run dev') },
  { pid: 12, ppid: 11, elapsed: 600, cmd: '/bin/sh -c next dev -p 3009' },
  { pid: 13, ppid: 12, elapsed: 599, cmd: 'node .../next dev -p 3009' }
]
is(paneBackJobs(NESTED, 10).length, 1, 'a shell inside a shell is one thing somebody started')
is(paneBackJobs(NESTED, 10)[0].label, 'npm', 'named by what was TYPED - its leaf is `node .../next`, which names nothing')
is(paneBackJobs([NESTED[0], { ...NESTED[1], cmd: shellCmd('') }, NESTED[2], NESTED[3]], 10)[0].label, 'next', 'and by the oldest live command when the -c string is only the prelude')

// Measured live 2026-08-24: a background `zsh -c 'sleep 400; true'` was named `true`,
// because the prelude rule took the LAST segment. The command is the FIRST segment that is
// not the CLI setting the shell up.
const TWO_PART = [
  { pid: 20, ppid: 1, elapsed: 900, cmd: '/usr/local/bin/claude' },
  { pid: 21, ppid: 20, elapsed: 44, cmd: shellCmd('sleep 400; true') }
]
is(paneBackJobs(TWO_PART, 20)[0].label, 'sleep', 'a job with two parts is named by the first, not the last')
is(
  paneBackJobs([TWO_PART[0], { ...TWO_PART[1], cmd: shellCmd('source ~/.zshrc && npm run build') }], 20)[0].label,
  'npm',
  'and shell housekeeping is never the name'
)

is(paneBackJobs(REAL, 0), [], 'no pty pid, no answer')
is(paneBackJobs([], 22457), [], 'an empty table is a failed read, never a busy pane')

// ---------------------------------------------------------------------------
// The words

is(jobWords([]), '', 'nothing to say is said as nothing')
is(jobWords([{ pid: 1, label: 'tail' }]), 'tail', 'one job is named')
is(jobWords([{ pid: 1, label: 'tail' }, { pid: 2, label: 'node' }]), '2 jobs', 'several are counted - two names do not fit a 190px card')

// ---------------------------------------------------------------------------
// This machine's real table, which is the half no fixture can check: the rule has to
// survive whatever is actually running here, and must not call an idle desk busy.

if (process.platform !== 'win32') {
  const text = execFileSync('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const secs = (t) => {
    const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]
    const p = rest.split(':').map(Number)
    const s = p.pop() ?? 0
    const m = p.pop() ?? 0
    const h = p.pop() ?? 0
    return (Number(d) * 24 + h) * 3600 + m * 60 + s
  }
  const rows = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsed: secs(m[3]), cmd: m[4] })
  }
  ok(rows.length > 20, `the real table answered (${rows.length} rows)`)
  const clis = rows.filter((r) => /\/claude(\s|$)/.test(r.cmd))
  for (const cli of clis) {
    const jobs = paneBackJobs(rows, cli.pid)
    ok(
      jobs.every((j) => isCommandShell(rows.find((r) => r.pid === j.pid).cmd)),
      `every job under live pid ${cli.pid} is a command shell`
    )
    // The claim is that DIRECTLY spawned machinery is never listed - not that the word
    // never appears anywhere. A test in this very suite runs `caffeinate` through a shell,
    // which is a real job, and it failed the first version of this assertion only under
    // `npm test`: the suite runs as a child of the very pane being read.
    const machinery = rows
      .filter((r) => /--mcp|caffeinate/.test(r.cmd) && !isCommandShell(r.cmd))
      .map((r) => r.pid)
    ok(
      !jobs.some((j) => machinery.includes(j.pid)),
      `and no MCP server or caffeinate reached the list under ${cli.pid}`
    )
  }
  console.log(`  (${clis.length} live agent CLIs on this machine, ${clis.reduce((n, c) => n + paneBackJobs(rows, c.pid).length, 0)} background jobs between them)`)
}

// ---------------------------------------------------------------------------
// The silent one: the reading that stops reaching the list
//
// The sampler only reads the process table while a window is on screen, so the wiring
// from it to the sessions list cannot be exercised from a minimised test copy. It is
// three assignments and each one is silent when it goes: the pane keeps its chip and
// sorts under `Your move` exactly as it did before this existed.

{
  const usage = readFileSync(join(root, 'src/main/usage.ts'), 'utf8')
  ok(/export function backJobInfo/.test(usage), 'usage.ts publishes the job WITH the moment it started')
  ok(/lastJobs\.set\([^)]*since:/s.test(usage), 'and the epoch is derived at the sample, not at draw time')

  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  ok(/backJobInfo\(/.test(sessions), 'the sweep asks for it')
  ok(/meta\.backJob = /.test(sessions), 'and puts it on the session, which is what the sidebar reads')
  ok(
    !/busyOnScreen\s*=\s*[^\n]*backJob/.test(sessions),
    'and it stays OUT of busyOnScreen - a false job there is a pane the idle sweep never closes'
  )

  const fleet = readFileSync(join(root, 'src/shared/fleet.ts'), 'utf8')
  const state = fleet.slice(fleet.indexOf('export function fleetState'))
  ok(/backJob\) return 'working'/.test(state.slice(0, state.indexOf('\n}'))), 'and fleetState ranks a pane by it')
}

rmSync(work, { recursive: true, force: true })
// The shell prelude Claude Code writes on this desk, verbatim off the live process table
// 2026-08-28. It cost a real card the words `running builtin`: `\builtin` was in neither
// word list and won, and `eval` was housekeeping, which threw away the one segment naming
// the job. Both halves are asserted, and the prelude's own words are the controls - a rule
// that answers `snapshot-zsh-...sh` or `setopt` is as wrong as one that answers `builtin`.
{
  const prelude =
    "/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1787917632728-up6ytj.sh 2>/dev/null || true" +
    " && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true" +
    " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true" +
    " && eval /private/tmp/claude-501/scratchpad/wait-site.sh < /dev/null" +
    " && pwd -P >| /tmp/claude-6c72-cwd"
  const shell = { pid: 1792, ppid: 34498, elapsed: 900, cmd: prelude }
  const label = jobLabel([shell], shell)
  ok(label === 'wait-site.sh', `the real prelude names the script, not the prelude (got "${label}")`)
  for (const wrong of ['builtin', 'eval', 'setopt', 'source', 'true', 'unalias'])
    ok(label !== wrong, `and never "${wrong}"`)

  // `source <snapshot>` must still own its whole segment: skipping the WORD rather than
  // the segment answers the snapshot's filename, which names nothing anybody ran.
  const onlyPrelude = {
    pid: 2,
    ppid: 1,
    elapsed: 900,
    cmd: "/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-9.sh 2>/dev/null || true"
  }
  const bare = jobLabel([onlyPrelude], onlyPrelude)
  ok(!/snapshot/.test(bare), `a prelude with no command names no snapshot file (got "${bare}")`)

  // A prefix word in front of a real command, one level less nested than the live shape.
  const envRun = { pid: 3, ppid: 1, elapsed: 900, cmd: '/bin/sh -c env FOO=1 nohup ./deploy.sh' }
  ok(jobLabel([envRun], envRun) === 'deploy.sh', 'env/nohup are in front of the job, not instead of it')
}


console.log(`pane-backjobs: ${checks} checks passed`)
