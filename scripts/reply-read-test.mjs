// What a CLI's transcript says the agent last replied, and whether a subagent is still out.
//
// The fixtures are the SHAPES of real rows - a Claude Code jsonl from this machine and a
// Codex rollout - trimmed, not invented: the keys, the nesting and the async-agent
// result text are the ones the CLIs write. The row that matters most is the last one: a
// tool result that merely QUOTES a task notification (a grep over this code) must not
// read as the notification.
//
//   node scripts/reply-read-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-reply-read-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'replyRead.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/replyRead.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const { readClaudeReply, readCodexReply, machineOf } = createRequire(import.meta.url)(out)

const row = (o) => JSON.stringify(o)
const user = (content) => row({ parentUuid: 'p', isSidechain: false, promptId: 'q', type: 'user', message: { role: 'user', content }, uuid: 'u', timestamp: '2026-09-22T20:29:53.697Z', cwd: '/x', sessionId: 's', version: '2.1.0' })
const assistant = (content) => row({ parentUuid: 'p', isSidechain: false, message: { model: 'claude-fable-5-1', id: 'msg_1', type: 'message', role: 'assistant', content, stop_reason: 'end_turn' }, type: 'assistant', uuid: 'a', timestamp: '2026-09-22T20:29:54.000Z' })
const notification = (toolUseId) => row({ parentUuid: 'p', isSidechain: false, attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>a855c83a7300be424</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>` }, type: 'attachment', uuid: 'n' })
const asyncResult = (toolUseId) => user([{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a855c83a7300be424 (internal ID - do not mention to user." }] }])

// 1. The last reply, the typed prompt, and a background agent still out.
{
  const lines = [
    user('Build the PaneForge half of the brief'),
    assistant([{ type: 'text', text: 'Reading brief first.' }]),
    assistant([{ type: 'tool_use', id: 'toolu_01A', name: 'Agent', input: { subagent_type: 'locator', model: 'sonnet', prompt: 'map it' } }]),
    asyncResult('toolu_01A'),
    assistant([{ type: 'text', text: 'Waiting on the locator.\n\n## Next steps\n- None' }])
  ]
  const r = readClaudeReply(lines.join('\n'))
  assert.equal(r.text, 'Waiting on the locator.\n\n## Next steps\n- None')
  assert.equal(r.prompt, 'Build the PaneForge half of the brief')
  assert.equal(r.runningAgents, 1, 'an async agent with no notification is still running')
  // ...and reported back.
  const done = readClaudeReply([...lines, notification('toolu_01A'), assistant([{ type: 'text', text: 'All done.' }])].join('\n'))
  assert.equal(done.runningAgents, 0)
  assert.equal(done.text, 'All done.')
  console.log('reply-read: last reply, prompt, running agent ok')
}

// 1b. A background Workflow graph is out the same way (2026-09-27: pane s5 closed on a
// running research graph because only Agent/SendMessage counted; result text is the real one).
{
  const lines = [
    assistant([{ type: 'tool_use', id: 'toolu_01MZ', name: 'Workflow', input: { scriptPath: '/x/research-verify.mjs', args: {} } }]),
    user([{ tool_use_id: 'toolu_01MZ', type: 'tool_result', content: "Workflow launched in background. Task ID: wtzhrpsxe\nSummary: Breadth-first research: parallel lanes, adversarial verification, sourced synthesis\nRun ID: wf_c14fc25e-2b0" }]),
    assistant([{ type: 'text', text: 'Research is running.\n\nNext steps:\n1. Waiting on the research run.' }])
  ]
  assert.equal(readClaudeReply(lines.join('\n')).runningAgents, 1, 'a launched workflow with no notification is running')
  const note = row({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>wtzhrpsxe</task-id>\n<tool-use-id>toolu_01MZ</tool-use-id>\n<status>completed</status>\n</task-notification>' })
  assert.equal(readClaudeReply([...lines, note].join('\n')).runningAgents, 0, 'its notification ends it')
  console.log('reply-read: background workflow ok')
}

// 2. A foreground agent's result IS its report; an errored launch is nothing.
{
  const fg = [
    assistant([{ type: 'tool_use', id: 'toolu_02', name: 'Agent', input: { prompt: 'x' } }]),
    user([{ tool_use_id: 'toolu_02', type: 'tool_result', content: 'Findings: nothing wrong.' }])
  ]
  assert.equal(readClaudeReply(fg.join('\n')).runningAgents, 0)
  const err = [
    assistant([{ type: 'tool_use', id: 'toolu_03', name: 'Agent', input: { prompt: 'x' } }]),
    user([{ tool_use_id: 'toolu_03', type: 'tool_result', is_error: true, content: 'fable-guard denied' }])
  ]
  assert.equal(readClaudeReply(err.join('\n')).runningAgents, 0)
  console.log('reply-read: foreground and failed launches ok')
}

// 3. A tool result QUOTING a notification is not one.
{
  const lines = [
    assistant([{ type: 'tool_use', id: 'toolu_04', name: 'Agent', input: { prompt: 'x' } }]),
    asyncResult('toolu_04'),
    user([{ tool_use_id: 'toolu_05', type: 'tool_result', content: 'grep output: <task-notification>\n<tool-use-id>toolu_04</tool-use-id>' }])
  ]
  assert.equal(readClaudeReply(lines.join('\n')).runningAgents, 1)
  // Nor is a tool CALL or the model's own prose that quotes one (a brief, an echo): 2026-10-02,
  // `handoff-state.mjs` read such a line as the notification itself.
  const quoted = '<task-notification>\n<tool-use-id>toolu_04</tool-use-id>\n</task-notification>'
  const called = [...lines, assistant([{ type: 'tool_use', id: 'toolu_07', name: 'Bash', input: { command: `echo '${quoted}'` } }]), assistant([{ type: 'text', text: `It looks like ${quoted}` }])]
  assert.equal(readClaudeReply(called.join('\n')).runningAgents, 1, 'a tool call or prose quoting a notification does not end the agent')
  console.log('reply-read: quoted notification does not count ok')
}

// 4. Tool results, harness text and sidechains never become the prompt or the reply.
{
  const lines = [
    user('real ask'),
    user([{ type: 'text', text: '<system-reminder>not typed</system-reminder>' }]),
    user([{ tool_use_id: 'toolu_06', type: 'tool_result', content: 'file listing' }]),
    row({ isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent talking' }] } }),
    assistant([{ type: 'text', text: 'the answer' }])
  ]
  const r = readClaudeReply(lines.join('\n'))
  assert.equal(r.prompt, 'real ask')
  assert.equal(r.text, 'the answer')
  // A half record at the top of a tail read is skipped, not fatal.
  assert.equal(readClaudeReply('ontent":"broken\n' + lines.join('\n')).text, 'the answer')
  console.log('reply-read: noise rows ok')
}

// 5. Codex rollout rows.
{
  const lines = [
    row({ timestamp: '2026-09-22T11:35:50.060Z', ordinal: 5, type: 'response_item', payload: { type: 'message', id: 'msg_u', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>' }] } }),
    row({ timestamp: '2026-09-22T11:35:51.060Z', ordinal: 6, type: 'response_item', payload: { type: 'message', id: 'msg_u2', role: 'user', content: [{ type: 'input_text', text: 'audit the last week' }] } }),
    row({ timestamp: '2026-09-22T11:36:00.989Z', ordinal: 14, type: 'response_item', payload: { type: 'message', id: 'msg_a', role: 'assistant', content: [{ type: 'output_text', text: 'I’ll audit the last week.' }] } }),
    row({ timestamp: '2026-09-22T11:37:00.989Z', ordinal: 20, type: 'response_item', payload: { type: 'message', id: 'msg_b', role: 'assistant', content: [{ type: 'output_text', text: 'Done: two fixes.' }] } })
  ]
  const r = readCodexReply(lines.join('\n'))
  assert.equal(r.text, 'Done: two fixes.')
  assert.equal(r.prompt, 'audit the last week')
  assert.equal(r.runningAgents, 0)
  assert.equal(r.promptAt, Date.parse('2026-09-22T11:35:51.060Z'), 'the prompt carries its row time')
  console.log('reply-read: codex rollout ok')
}

// 5b. A PASTED prompt is the person, and its row time is when the pane was last asked.
// The real row (s81-muk0ypqg, transcript 21b47890, 2026-09-27 16:31:51.955Z): a string
// opening `\n\n<pasted_content id="05c9">`, with no closing tag in that row.
{
  const pasted = row({ parentUuid: 'p', isSidechain: false, promptId: 'q', type: 'user', message: { role: 'user', content: '\n\n<pasted_content id="05c9">\nGoal: finished PaneForge chats CLOSE themselves instead of "resting to free memory".\nnever kill the running PaneForge.' }, uuid: 'u2', timestamp: '2026-09-27T16:31:51.955Z', promptSource: 'typed', cwd: '/x', sessionId: 's', version: '2.1.0' })
  const r = readClaudeReply([user('first ask'), assistant([{ type: 'text', text: 'first answer' }]), pasted, assistant([{ type: 'text', text: 'second answer' }])].join('\n'))
  assert.match(r.prompt, /^Goal: finished PaneForge chats CLOSE themselves/, 'the tags are gone, the words kept')
  assert.equal(r.promptAt, Date.parse('2026-09-27T16:31:51.955Z'), 'the pasted row is the newest prompt')
  const closed = readClaudeReply(user('<pasted_content id="1">\nfix it\n</pasted_content id="1">'))
  assert.equal(closed.prompt, 'fix it', 'a closed paste reads as its words')
  const harness = readClaudeReply([user('real ask'), user('<command-name>/clear</command-name>')].join('\n'))
  assert.equal(harness.prompt, 'real ask', 'every other < is still the harness')
  assert.equal(harness.promptAt, Date.parse('2026-09-22T20:29:53.697Z'))
  assert.equal(readClaudeReply(assistant([{ type: 'text', text: 'x' }])).promptAt, undefined, 'no prompt in the tail: no time')
  console.log('reply-read: pasted prompts and their time ok')
}

// 6. Which machine a step names.
{
  assert.equal(machineOf('Run /login on the PC'), 'pc')
  assert.equal(machineOf('Sign in to Vercel on my mac'), 'mac')
  assert.equal(machineOf('Approve the invoice'), null)
  assert.equal(machineOf('Restart it on the Windows machine'), 'pc')
  console.log('reply-read: machine words ok')
}

// 7. A Stop hook's feedback is not the person, and its reply is not the report. s42 on 1 Oct
// (`fixtures/claude-stophook-followup.jsonl`, its own rows trimmed): the full report with
// `**Next steps:**`, then the AUTO-CLEAR hook's `isMeta` row, then a two-line follow-up.
// The Review row and the GuardDeck card carried the follow-up alone, and the hook's words
// were read as what Robert last typed.
{
  // readFileSync imported at the top
  const s42 = readClaudeReply(readFileSync(join(root, 'scripts/fixtures/claude-stophook-followup.jsonl'), 'utf8'))
  assert.ok(s42.text.startsWith("I can't release this one myself"), 'the report comes first')
  assert.ok(s42.text.includes('**Next steps:**\n1. Say "release"'), 'with its own steps')
  assert.ok(s42.text.endsWith('so whichever chat cuts the release runs them.'), 'and the follow-up after it')
  assert.ok(!/Stop hook feedback|AUTO-CLEAR/.test(s42.text), 'the hook is in neither')
  assert.equal(s42.prompt, undefined, 'a hook row is never the typed prompt')
  // A follow-up with its own steps is the report now; one with no hook before it stays alone.
  const hook = row({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\nwrite a handoff' }, timestamp: '2026-09-22T20:29:55.000Z' })
  const said = (t) => assistant([{ type: 'text', text: t }])
  assert.equal(readClaudeReply([said('Report.\n\n**Next steps:**\n- None'), hook, said('New report.\n\n## Next steps\n- None')].join('\n')).text, 'New report.\n\n## Next steps\n- None')
  assert.equal(readClaudeReply([said('Report.\n\nNext steps: None'), user('go on'), said('Short answer.')].join('\n')).text, 'Short answer.', 'a typed prompt ends the old report')
  assert.equal(readClaudeReply([said('Report.\n\nNext steps: None'), hook, said('Wrote it.'), hook, said('Done.')].join('\n')).text, 'Report.\n\nNext steps: None\n\nDone.', 'two hooks: still the report first')
  console.log('reply-read: stop-hook follow-up keeps the report ok')
}

// When the transcript's last turn ended - the only turn end a pane resumed onto a finished
// conversation ever gets (`seedTurnEnd`). Row shapes from a real Claude jsonl (PC s8,
// 2026-10-02: ... stop_hook_summary, turn_duration, cost-state) and a real Codex rollout.
{
  const sys = (subtype, timestamp) => row({ parentUuid: 'p', isSidechain: false, type: 'system', subtype, durationMs: 1200, timestamp, uuid: 's' })
  const cost = row({ type: 'cost-state', sessionId: 's' })
  const done = [user('fix it'), assistant([{ type: 'text', text: 'Fixed.' }]), sys('stop_hook_summary', '2026-10-02T06:52:30.816Z'), sys('turn_duration', '2026-10-02T06:52:30.838Z'), cost]
  assert.equal(readClaudeReply(done.join('\n')).turnEndedAt, Date.parse('2026-10-02T06:52:30.838Z'), 'turn_duration ends it, bookkeeping after it does not reopen it')
  assert.equal(readClaudeReply(done.slice(0, 3).join('\n')).turnEndedAt, Date.parse('2026-10-02T06:52:30.816Z'), 'a stop_hook_summary alone ends it')
  assert.equal(readClaudeReply(done.slice(0, 2).join('\n')).turnEndedAt, undefined, 'a reply with no end row is still a turn in flight')
  const hook = row({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\nwrite a handoff' }, timestamp: '2026-10-02T06:52:31.000Z' })
  assert.equal(readClaudeReply([...done, hook].join('\n')).turnEndedAt, undefined, 'a Stop hook answer reopens the turn')
  assert.equal(readClaudeReply([...done, user('and the next thing')].join('\n')).turnEndedAt, undefined, 'a new prompt reopens it')
  assert.equal(readClaudeReply([...done, row({ ...JSON.parse(sys('turn_duration', '2026-10-02T07:00:00.000Z')), isSidechain: true })].join('\n')).turnEndedAt, Date.parse('2026-10-02T06:52:30.838Z'), 'a subagent turn is not the pane turn')
  const ev = (type, timestamp) => row({ timestamp, type: 'event_msg', payload: { type, turn_id: 't' } })
  const codex = [ev('task_started', '2026-10-02T09:30:00.000Z'), row({ type: 'response_item', timestamp: '2026-10-02T09:39:20.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reviewed.' }] } }), ev('task_complete', '2026-10-02T09:39:22.068Z'), row({ timestamp: '2026-10-02T09:39:22.100Z', type: 'event_msg', payload: { type: 'token_count' } })]
  assert.equal(readCodexReply(codex.join('\n')).turnEndedAt, Date.parse('2026-10-02T09:39:22.068Z'), 'codex task_complete ends it')
  assert.equal(readCodexReply([...codex, ev('task_started', '2026-10-02T09:40:00.000Z')].join('\n')).turnEndedAt, undefined, 'codex task_started reopens it')
  console.log('reply-read: last turn end ok')
}

// The transcript's last word says whether the turn is still open (s105, 2026-10-02: closed
// between two Chrome tool calls because the screen had gone quiet).
{
  const { openTurnOf, OPEN_TURN_STALE_MS } = createRequire(import.meta.url)(out)
  const at = (iso) => Date.parse(iso)
  const rowAt = (ts, o) => JSON.stringify({ isSidechain: false, timestamp: ts, ...o })
  const call = (ts) => rowAt(ts, { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_x', name: 'mcp__claude-in-chrome__computer', input: {} }] } })
  const result = (ts) => rowAt(ts, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [{ type: 'text', text: 'Clicked' }] }] } })
  const final = (ts) => rowAt(ts, { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } })
  const end = (ts) => rowAt(ts, { type: 'system', subtype: 'turn_duration' })
  const prompt = (ts, text) => rowAt(ts, { type: 'user', message: { role: 'user', content: text } })
  const NOW = at('2026-10-02T09:39:20.244Z')
  const fixture = readFileSync(join(root, 'scripts/fixtures/claude-midturn-browser-calls.jsonl'), 'utf8')
  const real = readClaudeReply(fixture)
  assert.deepEqual(real.lastEntry, { kind: 'tool_result', at: at('2026-10-02T09:39:17.212Z') }, 'the real s105 tail ends on a tool result')
  assert.match(openTurnOf(real, NOW), /tool result the agent has not answered yet/)
  assert.match(openTurnOf(readClaudeReply([prompt('2026-10-02T09:39:00Z', 'go'), call('2026-10-02T09:39:05Z')].join('\n')), NOW), /tool call with no result yet/, 'mid tool call')
  assert.match(openTurnOf(readClaudeReply(prompt('2026-10-02T09:39:00Z', 'go')), NOW), /prompt the agent has not answered/, 'prompt not started on')
  assert.equal(openTurnOf(readClaudeReply([call('2026-10-02T09:39:05Z'), result('2026-10-02T09:39:06Z'), final('2026-10-02T09:39:07Z'), end('2026-10-02T09:39:08Z')].join('\n')), NOW), null, 'turn-end row: closed')
  assert.equal(openTurnOf(readClaudeReply([call('2026-10-02T09:39:05Z'), result('2026-10-02T09:39:06Z'), final('2026-10-02T09:39:07Z')].join('\n')), NOW), null, 'a final reply with no row yet is the screen\'s call, as before')
  assert.equal(openTurnOf(readClaudeReply([call('2026-10-02T09:39:05Z'), prompt('2026-10-02T09:39:06Z', '[Request interrupted by user for tool use]')].join('\n')), NOW), null, 'interrupted: closed')
  const slash = [final('2026-10-02T09:39:07Z'), end('2026-10-02T09:39:08Z'), rowAt('2026-10-02T09:39:09Z', { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } }), prompt('2026-10-02T09:39:09Z', '<command-name>/model</command-name>')]
  assert.equal(openTurnOf(readClaudeReply(slash.join('\n')), NOW), null, 'a slash command after the end opens nothing')
  assert.equal(openTurnOf(readClaudeReply(call('2026-10-02T09:00:00Z')), at('2026-10-02T09:00:00Z') + OPEN_TURN_STALE_MS + 1), null, 'a CLI dead mid-call for 20 min does not hold for ever')
  const codex = (type, ts) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type } })
  assert.match(openTurnOf(readCodexReply(codex('task_started', '2026-10-02T09:39:00Z')), NOW), /turn it started/, 'codex mid-turn')
  assert.equal(openTurnOf(readCodexReply([codex('task_started', '2026-10-02T09:39:00Z'), codex('task_complete', '2026-10-02T09:39:10Z')].join('\n')), NOW), null)
  console.log('reply-read: open turn by the transcript ok')
}
