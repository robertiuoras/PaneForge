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
import { mkdirSync, rmSync } from 'node:fs'
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
const { paneJob, programName } = require(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
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
// A real pty. Everything above is arithmetic over two strings; this is the question of
// whether node-pty answers with the tty's foreground process at all.

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

console.log(`\n${checks} checks - all good`)
