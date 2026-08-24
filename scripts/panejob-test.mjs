// What a shell pane is running, and - much more of this file - what it must never claim.
//
// The expensive failure is a FALSE job. A pane wrongly marked working never goes quiet, so
// the idle sweep never closes it, the budget never hands it off, and its clock ticks a
// number that means nothing. So the positives here are three lines and the refusals are
// the rest, and the last block reads a REAL pty: the whole reading rests on node-pty
// answering with the tty's foreground process rather than with the file it spawned, which
// no fixture can check.
//
//   node scripts/panejob-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-panejob-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'panejob.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/paneJob.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { commandName, jobFromTable, paneJob, programName } = require(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

// ---------------------------------------------------------------------------
// The name, which is the only normalising anybody does

is(programName('-zsh'), 'zsh', 'a login shell reports itself with a dash and is still that shell')
is(programName('/bin/bash'), 'bash', 'a path is not a program name')
is(programName('C:\\Windows\\System32\\cmd.exe'), 'cmd', 'and neither is a Windows path with a suffix')
is(programName(''), '', 'nothing is nothing')
is(programName(undefined), '', 'and so is nothing at all')

// ---------------------------------------------------------------------------
// What it will say

is(paneJob('sleep', 'zsh'), 'sleep', 'a command in front of a shell is the job')
is(paneJob('/usr/bin/npm', '/bin/bash'), 'npm', 'both sides are named, not pathed')
is(paneJob('node.exe', 'powershell'), 'node', 'the Windows shell is a shell like the others')

// ---------------------------------------------------------------------------
// What it will not say, which is the feature

is(paneJob('zsh', 'zsh'), null, 'a shell sitting at its own prompt is not running anything')
is(paneJob('-zsh', '/bin/zsh'), null, 'and it is still not, wearing a dash and a path')
is(paneJob('bash', 'zsh'), null, 'a shell inside a shell is not a job somebody started')
is(paneJob('conhost', 'cmd'), null, 'nor is the console host Windows lists beside it')
is(paneJob('', 'zsh'), null, 'a pty with nothing to report is not a pane with nothing running')
is(paneJob(undefined, 'zsh'), null, 'and neither is one that could not be asked')
is(paneJob('sleep', ''), null, 'a pane whose runner is unknown is left alone')

// The load-bearing refusal: an agent pane. Its turn is tracked by its own footer, which
// knows things this reading cannot - and a Node-based CLI reporting its own foreground as
// `node` would otherwise read as a job that never ends.
is(paneJob('node', 'claude'), null, 'an agent CLI reporting its own runtime is not a job')
is(paneJob('rg', 'claude'), null, 'and neither is a tool it started for itself')
is(paneJob('npm', 'codex'), null, 'the refusal is about the RUNNER, not about the command')

// ---------------------------------------------------------------------------
// Windows, which has no foreground reading at all and answers off the process table.
// Both fixtures are the real rows measured on the PC 2026-08-23.

const winIdle = [{ pid: 67536, ppid: 14168, cmd: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoLogo' }]
const winBusy = [
  ...winIdle,
  { pid: 52388, ppid: 67536, cmd: '"C:\\Program Files\\nodejs\\node.exe" -e setTimeout(()=>{},25000)', elapsed: 7 }
]

is(commandName('"C:\\Program Files\\nodejs\\node.exe" -e setTimeout(()=>{},25000)'), 'node', 'a quoted path with a space is one program, not two')
is(commandName('/usr/bin/npm run dev'), 'npm', 'and an unquoted one stops at the first space')
is(commandName('   '), '', 'a blank command line names nothing')

is(jobFromTable(winIdle, 67536, 'powershell'), null, 'a shell with no children is running nothing')
is(jobFromTable(winBusy, 67536, 'powershell'), { name: 'node', elapsed: 7 }, "a child of the pty pid is the pane's job, with its age")
is(jobFromTable(winBusy, 14168, 'powershell'), null, 'and only of THAT pane - the parent pid is somebody else')
is(jobFromTable(winBusy, 67536, 'claude'), null, 'the runner refusal holds here too')
is(jobFromTable([], 67536, 'powershell'), null, 'a table that did not answer is not a machine running nothing')
is(
  jobFromTable(
    [
      { pid: 2, ppid: 1, cmd: 'npm run dev', elapsed: 90 },
      { pid: 3, ppid: 1, cmd: 'node ./x', elapsed: 4 }
    ],
    1,
    'bash'
  ),
  { name: 'npm', elapsed: 90 },
  'the OLDEST child is the command somebody ran; the young one is what it started'
)
is(
  jobFromTable([{ pid: 2, ppid: 1, cmd: 'conhost.exe 0x4', elapsed: 90 }], 1, 'cmd'),
  null,
  "the console host Windows hangs off a shell is not that pane's work"
)

// The load-bearing guard, and it is a SOURCE assertion because nothing else can catch it:
// `IPty.process` on Windows answers with the TERMINAL NAME whatever is running (measured:
// "xterm-256color" idle AND with a command up). A `jobOf` that still asked the tty there
// would mark every shell pane on that machine working for ever, and every test above would
// still pass.
{
  const src = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const body = src.slice(src.indexOf('private jobOf('), src.indexOf('private sweepWinJobs('))
  ok(/if \(WIN\)/.test(body), 'jobOf answers Windows from the table before it ever asks the tty')
  ok(body.indexOf('if (WIN)') < body.indexOf('proc.process'), 'and the refusal comes FIRST')
}

// ---------------------------------------------------------------------------
// A real pty. Everything above is arithmetic over two strings; this is the question of
// whether node-pty answers with the tty's foreground process at all.

// POSIX only, and that is the POINT rather than a gap: `jobOf` refuses the tty on
// Windows before it ever asks (the source assertion above pins that), because
// `IPty.process` there answers with the terminal NAME whatever is running. So this
// block asserts a reading Windows deliberately does not take - and conpty cannot even
// start a bare `powershell` here, which is how it failed: `Error: File not found:` with
// nothing after the colon, on a machine whose 96 other suites were green. Skipped OUT
// LOUD, never silently: a suite that quietly drops its only live check is worse than a
// red one. The Windows reading is `jobFromTable`, covered above.
if (process.platform === 'win32') {
  console.log('  skip real pty - POSIX only; Windows reads jobFromTable, asserted above')
} else {
  const { spawn } = require('@lydell/node-pty')
  const shell = process.platform === 'win32' ? 'powershell' : process.env.SHELL || '/bin/zsh'
  const p = spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env: process.env })
  p.onData(() => {})
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(1500)
  is(paneJob(p.process, shell), null, 'a real shell sitting at its prompt reports no job')
  p.write(process.platform === 'win32' ? 'Start-Sleep -Seconds 20\r' : 'sleep 20\r')
  await wait(2000)
  const job = paneJob(p.process, shell)
  assert.ok(job, `a real command in front of a real pty is named (got ${JSON.stringify(p.process)})`)
  checks++
  try {
    p.kill()
  } catch {
    /* already gone */
  }
}

console.log(`\n${checks} checks - all good`)
