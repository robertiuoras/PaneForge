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
import { mkdirSync, rmSync } from 'node:fs'
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
  console.log('reply-read: codex rollout ok')
}

// 6. Which machine a step names.
{
  assert.equal(machineOf('Run /login on the PC'), 'pc')
  assert.equal(machineOf('Sign in to Vercel on my mac'), 'mac')
  assert.equal(machineOf('Approve the invoice'), null)
  assert.equal(machineOf('Restart it on the Windows machine'), 'pc')
  console.log('reply-read: machine words ok')
}
