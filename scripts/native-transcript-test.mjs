// The native reader serves semantic, exact JSONL only after transcriptFor has bound the
// file to a pane. These fixtures cover the mobile DTO rather than terminal decoration.
//
//   node scripts/native-transcript-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-native-transcript-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const before = { PF_CLAUDE_HOME: process.env.PF_CLAUDE_HOME }
process.env.PF_CLAUDE_HOME = join(work, 'claude')
const fixtureCodexHome = join(work, 'codex')

const out = join(work, 'transcripts.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/main/transcripts.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out, define: { 'process.env.CODEX_HOME': JSON.stringify(fixtureCodexHome) } })
const { noteSession, forgetSession, projectDir, nativeTranscriptPage } = createRequire(import.meta.url)(out)
const cwd = '/Users/native/Projects/reader'
const line = (value) => JSON.stringify(value)
const claudeRow = (type, content, extra = {}) => line({ type, timestamp: '2026-09-09T01:02:03.000Z', message: { role: type, content }, ...extra })
const dto = (page, id) => {
  assert.equal(page?.messages instanceof Array, true, 'messages is an array')
  assert.equal(typeof page?.rawOutput, 'string', 'rawOutput is always bounded text')
  assert.equal(page?.nextCursor === null || typeof page?.nextCursor === 'string', true, 'cursor is nullable text')
  for (const message of page.messages) {
    assert.equal(typeof message.id, 'string'); assert.ok(['user', 'assistant', 'system'].includes(message.role))
    assert.ok(['claude', 'codex', 'terminal'].includes(message.provider))
    assert.equal(message.at === null || typeof message.at === 'string', true)
    assert.equal(typeof message.raw, 'string'); assert.ok(Array.isArray(message.blocks))
    for (const block of message.blocks) {
      assert.ok(['text', 'code', 'tool', 'notice'].includes(block.type))
      if (block.type === 'tool') {
        assert.equal(typeof block.name, 'string'); assert.equal(typeof block.input, 'string'); assert.equal(typeof block.output, 'string')
        assert.ok(['requested', 'running', 'complete', 'error'].includes(block.state))
        assert.ok(block.callId === undefined || typeof block.callId === 'string')
        assert.ok(block.phase === undefined || ['call', 'result'].includes(block.phase))
      } else assert.equal(typeof block.text, 'string')
    }
  }
  return page
}

try {
  const claudeDir = projectDir(cwd); mkdirSync(claudeDir, { recursive: true })
  const claudeId = 'claude-native'
  const claudeFile = join(claudeDir, `${claudeId}.jsonl`)
  const code = 'before\n```ts\n  const x = 1  \n```\nafter'
  const tool = { type: 'tool_use', id: 'call-claude', name: 'functions.exec_command', input: { cmd: 'pwd' } }
  const result = { type: 'tool_result', tool_use_id: 'call-claude', content: 'ok\n', is_error: false }
  const claudeLines = [
    claudeRow('user', code),
    claudeRow('assistant', [{ type: 'text', text: 'working' }, tool]),
    claudeRow('user', [result])
  ]
  writeFileSync(claudeFile, claudeLines.join('\n') + '\n')
  noteSession('claude-pane', cwd, 'claude', claudeId)
  const first = dto(nativeTranscriptPage('claude-pane', 'claude'), claudeId)
  assert.equal(first.messages.length, 3, 'Claude messages are semantic rows')
  assert.equal(first.messages[0].raw, claudeLines[0], 'message raw is the exact source JSONL')
  assert.equal(first.messages[0].blocks[1].type, 'code', 'fenced text is a code block')
  assert.equal(first.messages[0].blocks[1].text, '  const x = 1  \n', 'code whitespace is preserved')
  assert.equal(first.messages[1].blocks[1].type, 'tool', 'Claude tool use is exposed')
  assert.equal(first.messages[2].blocks[0].type, 'tool', 'Claude tool result is exposed')
  assert.equal(first.messages[1].blocks[1].state, 'requested', 'a saved request does not claim a still-running process')
  assert.equal(first.messages[1].blocks[1].phase, 'call'); assert.equal(first.messages[2].blocks[0].phase, 'result')
  assert.equal(first.messages[1].blocks[1].callId, 'call-claude'); assert.equal(first.messages[2].blocks[0].callId, 'call-claude')
  assert.equal(first.messages[2].id, String(Buffer.byteLength(claudeLines.slice(0, 2).join('\n') + '\n')), 'result keeps its exact byte identity')
  assert.equal(first.rawOutput, claudeLines.join('\n'), 'page raw output is exact records')
  forgetSession('claude-pane')

  // More than the page limit: latest first, then a cursor that moves strictly backward.
  const manyId = 'claude-many'; const manyFile = join(claudeDir, `${manyId}.jsonl`)
  const many = Array.from({ length: 55 }, (_, n) => claudeRow('user', `turn-${n}`))
  writeFileSync(manyFile, many.join('\n') + '\n')
  noteSession('many-pane', cwd, 'claude', manyId)
  const latest = dto(nativeTranscriptPage('many-pane', 'claude'), manyId)
  assert.equal(latest.messages.length, 50); assert.equal(latest.messages.at(-1).blocks[0].text, 'turn-54')
  assert.ok(latest.nextCursor && Number(latest.nextCursor) > 0, 'latest page exposes an older cursor')
  const older = dto(nativeTranscriptPage('many-pane', 'claude', latest.nextCursor), manyId)
  assert.equal(older.messages.length, 5); assert.equal(older.messages[0].blocks[0].text, 'turn-0')
  assert.equal(older.nextCursor, null, 'oldest page terminates')
  appendFileSync(manyFile, claudeRow('assistant', [{ type: 'text', text: 'newly appended' }]) + '\n')
  const refresh = dto(nativeTranscriptPage('many-pane', 'claude'), manyId)
  assert.equal(refresh.messages.at(-1).blocks[0].text, 'newly appended', 'latest refresh notices appended transcript rows')
  appendFileSync(manyFile, '{"type":"assistant"')
  const partial = dto(nativeTranscriptPage('many-pane', 'claude'), manyId)
  assert.equal(partial.messages.at(-1).blocks[0].text, 'newly appended', 'partial trailing JSONL is ignored')
  forgetSession('many-pane')

  // Codex records use response_item payloads. Tool and tool-output rows are visible rather
  // than dropped, and a resume id makes the claim exact rather than folder based.
  const codexId = '12345678-1234-1234-1234-123456789abc'
  const codexFile = join(fixtureCodexHome, 'sessions', '2026', '09', '09', 'native.jsonl')
  mkdirSync(dirname(codexFile), { recursive: true })
  const codexRows = [
    line({ type: 'session_meta', payload: { id: codexId, session_id: codexId, cwd, timestamp: '2026-09-09T01:02:03.000Z' } }),
    line({ timestamp: '2026-09-09T01:02:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '```json\n{ "ok": true }\n```' }] } }),
    line({ timestamp: '2026-09-09T01:02:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-codex', name: 'exec', input: 'pwd', status: 'completed' } }),
    line({ timestamp: '2026-09-09T01:02:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-codex', output: [{ type: 'input_text', text: '/tmp' }] } }),
    line({ type: 'response_item', payload: { type: 'function_call', call_id: 'call-function', name: 'run', arguments: '{"cmd":"false"}' } }),
    line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-function', output: 'failed exactly\n', is_error: true } })
  ]
  writeFileSync(codexFile, codexRows.join('\n') + '\n')
  noteSession('codex-pane', cwd, 'codex', codexId)
  const codex = dto(nativeTranscriptPage('codex-pane', 'codex'), codexId)
  assert.equal(codex.messages.length, 5, 'Codex message and tool records are semantic rows')
  assert.equal(codex.messages[0].blocks[0].type, 'code', 'Codex fenced code is rendered as code')
  assert.equal(codex.messages[1].blocks[0].type, 'tool'); assert.equal(codex.messages[2].blocks[0].type, 'tool')
  assert.equal(codex.messages[1].blocks[0].state, 'requested', 'completed call emission is not proof of completed execution')
  assert.equal(codex.messages[1].blocks[0].callId, 'call-codex'); assert.equal(codex.messages[2].blocks[0].callId, 'call-codex')
  assert.equal(codex.messages[3].blocks[0].phase, 'call'); assert.equal(codex.messages[4].blocks[0].phase, 'result')
  assert.equal(codex.messages[4].blocks[0].state, 'error'); assert.equal(codex.messages[4].blocks[0].output, 'failed exactly\n')
  assert.equal(codex.rawOutput, codexRows.slice(1).join('\n'), 'correlation metadata never changes raw JSONL')
  forgetSession('codex-pane')

  // A giant unbroken record must still return a smaller cursor, never the same one.
  const giantId = 'claude-giant'; const giantFile = join(claudeDir, `${giantId}.jsonl`)
  writeFileSync(giantFile, '{"type":"assistant","message":{"role":"assistant","content":"' + 'x'.repeat(300 * 1024) + '"}}')
  noteSession('giant-pane', cwd, 'claude', giantId)
  const giant = dto(nativeTranscriptPage('giant-pane', 'claude'), giantId)
  assert.equal(giant.messages[0].role, 'system'); assert.equal(giant.messages[0].blocks[0].type, 'notice')
  assert.ok(giant.nextCursor && Number(giant.nextCursor) < 300 * 1024, 'oversized row makes strict older progress')
  forgetSession('giant-pane')

  console.log('native transcript: OK')
} finally {
  for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value
  rmSync(work, { recursive: true, force: true })
}
