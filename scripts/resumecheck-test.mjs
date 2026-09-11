// Test for "a conversation handed over is proven running before the original is closed".
//
// Until 2026-09-11 the receiver said ok the moment the pane was spawned, the sender kept
// its copy asleep "until the resume is confirmed", and nothing ever confirmed it - two
// panes wearing one conversation on the same desk (rows 12 and 15), a wake that forked
// the transcript, and a re-send refused every sweep. `shared/resumeCheck.ts` is the
// reading that was missing. Frames are the verbatim captures busy-test.mjs uses.
//
//   node scripts/resumecheck-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-resumecheck-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'resumecheck.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/resumeCheck.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out })
const { resumeVerdict, RESUME_CONFIRM_MS, RESUME_POLL_MS } = createRequire(import.meta.url)(out)

const CHROME = [
  '────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────',
  '  [CAVEMAN] ◆ Opus 5 (1M context) | claude-orchestrator-c |  lane-c | ⟳ 68↑ | ░░░░░░░░░░ 0% | +0/-0',
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents'
].join('\n')
const IDLE = '⏺ Done - the sleep card now says sleeps.\n\n' + CHROME
const WORKING = '✢ Smooshing… (8s · ↓ 282 tokens)\n' + CHROME
const NOT_FOUND = 'No conversation found with session ID: c69a4bad-1020-4c35-a454-75d8034c64a0\n'

let checks = 0
const eq = (what, got, want) => { assert.equal(got, want, what); checks++ }
const read = (o) => ({ alive: true, printed: true, quietMs: 2000, painted: IDLE, ...o })

eq('an idle composer with a live process is a confirmed resume', resumeVerdict(read({})), 'ok')
eq('a pane that has not printed is still coming up', resumeVerdict(read({ printed: false, painted: '' })), 'pending')
eq('bytes still arriving is still coming up', resumeVerdict(read({ quietMs: 100 })), 'pending')
eq('the quiet floor is the caller\'s, not a guess here', resumeVerdict(read({ quietMs: 500 }), 400), 'ok')
eq('a working line is a turn in flight, not a confirmed resume', resumeVerdict(read({ painted: WORKING })), 'pending')
eq('a process that quit is a failed resume', resumeVerdict(read({ alive: false })), 'failed')
eq('the CLI saying it found no such conversation is a failed resume', resumeVerdict(read({ painted: NOT_FOUND + CHROME })), 'failed')
eq('...even before it has gone quiet', resumeVerdict(read({ painted: NOT_FOUND, quietMs: 0 })), 'failed')
eq('a signed-out CLI is a failed resume', resumeVerdict(read({ painted: 'Not logged in · Please run /login\n' })), 'failed')
eq('a dead process outranks an idle-looking screen', resumeVerdict(read({ alive: false, painted: IDLE })), 'failed')
eq('the wait fits inside the handoff ask (180 s)', RESUME_CONFIRM_MS < 180_000 && RESUME_CONFIRM_MS >= 10_000, true)
eq('the poll is fast enough to answer within a second of the composer going idle', RESUME_POLL_MS <= 500, true)

rmSync(work, { recursive: true, force: true })
console.log(`resumecheck: ${checks} checks passed`)
