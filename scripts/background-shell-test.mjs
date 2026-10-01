// A pane whose turn ended waiting on a `run_in_background` Bash command still owes work to
// its CLI; a restart that finds it idle restores it ASLEEP and the task is lost.
//
// The fixture rows are VERBATIM rows from a real conversation (pane 2 of taskdriver.ai,
// 2026-10-01, `toolUseResult` stripped), keyed by their 0-based line number in that file:
//   193/195 launch + "running in background", 241 turn ended, 243/244 the kill notification
//   enqueued then dequeued (the app was killed before it reached the model), 247-249 the
//   notification delivered after the restart; 86/88/112/114/115 an earlier pair that was
//   delivered mid-turn.
//
//   node scripts/background-shell-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-bgshell-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'runningAgents.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/runningAgents.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const { newAgentScan, scanAgentLines, runningAgents, pendingBackground, hasPendingBackground, runningAgentsIn } = createRequire(import.meta.url)(out)

const rows = JSON.parse(readFileSync(join(root, 'scripts/fixtures/claude-background-shell-rows.json'), 'utf8'))
const lines = (...ns) => ns.map((n) => rows[n]).join('\n') + '\n'
const scanOf = (text) => { const s = newAgentScan(); scanAgentLines(s, text); return s }
const LAUNCH = Date.parse('2026-10-01T07:58:05.787Z')
const NOW = Date.parse('2026-10-01T08:25:54Z')

// Pane 2 at the moment the app was killed.
const cut = scanOf(lines(193, 195, 241, 243, 244))
assert.equal(hasPendingBackground(cut, { since: LAUNCH - 60_000, now: NOW }), true, 'killed shell, notification only dequeued: pending')
const p = pendingBackground(cut, { since: LAUNCH - 60_000, now: NOW })
assert.equal(p.shells.length, 1)
assert.equal(p.shells[0].id, 'bc5oada0v')
assert.equal(p.shells[0].label, 'Wait in background for lane b release check run')
assert.equal(p.undelivered, 1)
assert.deepEqual(runningAgents(cut, { since: LAUNCH - 60_000, now: NOW }), [], 'refusal semantics unchanged: no agent is running')

// Only the launch + result: still running, still pending.
assert.equal(hasPendingBackground(scanOf(lines(193, 195)), { now: NOW }), true)

// Delivered after the restart: nothing pending, maps emptied.
const done = scanOf(lines(193, 195, 241, 243, 244, 247, 248, 249))
assert.equal(hasPendingBackground(done, { now: NOW }), false, 'delivered notification: not pending')
assert.equal(done.shells.size + done.undelivered.size, 0, 'maps do not grow')

// Earlier pair: enqueue, then absorbed mid-turn (remove) and the queued_command attachment.
const earlier = scanOf(lines(86, 88, 112))
assert.equal(hasPendingBackground(earlier, { now: NOW }), true, 'enqueued but not yet delivered')
const delivered = scanOf(lines(86, 88, 112, 114, 115))
assert.equal(hasPendingBackground(delivered, { now: NOW }), false)
assert.equal(delivered.shells.size + delivered.undelivered.size, 0)
// remove alone (before the attachment) is already delivery.
assert.equal(hasPendingBackground(scanOf(lines(86, 88, 112, 114)), { now: NOW }), false)

// A Bash tool_use WITHOUT run_in_background is not tracked.
const fg = JSON.parse(rows[193])
for (const c of fg.message.content) if (c.type === 'tool_use') delete c.input.run_in_background
assert.equal(scanOf(JSON.stringify(fg) + '\n' + rows[195] + '\n').shells.size, 0, 'foreground Bash not tracked')
assert.equal(hasPendingBackground(scanOf(JSON.stringify(fg) + '\n' + rows[195] + '\n'), { now: NOW }), false)

// An error / non-matching result means it never started.
const err = JSON.parse(rows[195])
err.message.content[0].is_error = true
assert.equal(scanOf(rows[193] + '\n' + JSON.stringify(err) + '\n').shells.size, 0)

// Launched before this CLI started: died with the earlier process.
assert.equal(hasPendingBackground(cut, { since: LAUNCH + 1, now: NOW }), false, 'launch before since: not pending')
// Older than the age cap: not believed.
assert.equal(hasPendingBackground(cut, { now: LAUNCH + 4 * 3600_000 }), false, 'past AGENT_MAX_AGE_MS')

// Whitespace in the JSON of a queue row is tolerated.
const spaced = JSON.stringify(JSON.parse(rows[243]), null, 1).replace(/\n\s*/g, ' ').replace(/":"/g, '" : "')
assert.equal(hasPendingBackground(scanOf(lines(193, 195) + spaced + '\n'), { now: NOW }), true)
assert.equal(scanOf(lines(193, 195) + spaced + '\n').undelivered.size, 1)

// An Agent background launch is reported by runningAgents exactly as before.
const agentLaunch = JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T07:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_AG', name: 'Agent', input: { description: 'Visual review' } }] } })
const agentResult = JSON.stringify({ type: 'user', timestamp: '2026-10-01T07:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_AG', content: 'Async agent launched successfully.\nagentId: a123 (internal ID)' }] } })
const ag = runningAgentsIn(agentLaunch + '\n' + agentResult + '\n', { now: Date.parse('2026-10-01T07:30:00Z') })
assert.deepEqual(ag, [{ id: 'a123', toolUseId: 'toolu_AG', via: 'Agent', at: Date.parse('2026-10-01T07:00:00.000Z'), label: 'Visual review' }])
const agScan = scanOf(agentLaunch + '\n' + agentResult + '\n')
assert.equal(hasPendingBackground(agScan, { now: Date.parse('2026-10-01T07:30:00Z') }), true)
// Agent notification only enqueued: refusal ends (as today) but it stays undelivered.
const agNote = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T07:10:00.000Z', content: '<task-notification>\n<tool-use-id>toolu_AG</tool-use-id>\n<status>completed</status>\n</task-notification>' })
agScan.undelivered.clear(); scanAgentLines(agScan, agNote + '\n')
assert.deepEqual(runningAgents(agScan, { now: Date.parse('2026-10-01T07:30:00Z') }), [], 'agent stopped on any notification, as today')
assert.equal(agScan.undelivered.size, 1)
assert.equal(hasPendingBackground(agScan, { now: Date.parse('2026-10-01T07:30:00Z') }), true)

console.log('background-shell-test: ok')
