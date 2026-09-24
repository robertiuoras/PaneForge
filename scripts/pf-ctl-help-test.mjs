#!/usr/bin/env node
/**
 * `pf help`, `pf tidy`, `pf move` - the agent-first half of pf-ctl.
 *
 * No app, no network, no CLI: the command table is checked against the dispatcher's own
 * source (so a command added without help text fails here), the CLI is run only for the
 * answers it gives BEFORE it looks for an app, and the rules that decide which pane may
 * be closed or moved are the pure functions in pf-ctl-lib.mjs, fed rows shaped like a
 * real `sessions:list` answer and transcripts shaped like real Claude Code / Codex files.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_CHARS,
  COMMANDS,
  COMMAND_NAMES,
  REPLY_CHARS,
  buildHandoffBrief,
  claimHolder,
  claudeProjectDir,
  commandHelp,
  findDuplicates,
  findTranscript,
  folderRefusal,
  helpText,
  isFinishedPane,
  lastExchange,
  laneLedger,
  movePrompt,
  moveRefusal,
  readTail,
  samePath,
  stripAnsi,
  tidyHoldReasons
} from './pf-ctl-lib.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
}

const CTL = join(import.meta.dirname, 'pf-ctl.mjs')
const source = readFileSync(CTL, 'utf8')
const DIR = mkdtempSync(join(tmpdir(), 'pf-ctl-help-test-'))
// Never the real app: a settings folder with nothing in it answers exit 2 if anything
// below were to reach for one.
const pf = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CTL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PF_USER_DATA: join(DIR, 'no-app'), PF_PANE: '', ...env }
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// ----------------------------------------------------------------- help vs dispatcher
console.log('1. every command the dispatcher runs has help, and nothing else does')
{
  const dispatched = new Set([...source.matchAll(/cmd === '([a-z][a-z-]*)'/g)].map((m) => m[1]))
  const missing = [...dispatched].filter((c) => !COMMAND_NAMES.includes(c))
  const stale = COMMAND_NAMES.filter((c) => !dispatched.has(c))
  check('every dispatched command has a help row', missing.length === 0, missing.join(', '))
  check('every help row names a dispatched command', stale.length === 0, stale.join(', '))
  check('the dispatcher knows a real number of commands', dispatched.size >= 20, String(dispatched.size))
  // One branch per command: a second `else if` for the same word is dead code nobody sees
  // (two `composer` branches sat in this file from 2026-09-19 to 2026-09-24).
  const branches = {}
  for (const m of source.matchAll(/else if \(cmd === '([a-z-]+)'\)/g)) branches[m[1]] = (branches[m[1]] ?? 0) + 1
  const twice = Object.entries(branches).filter(([, n]) => n > 1).map(([c]) => c)
  check('no command has two dispatcher branches', twice.length === 0, twice.join(', '))
  const listed = /unknown command[^\n]*use: ([^`\n]+)/.exec(source)?.[1] ?? ''
  const words = listed.replace(/ - run: pf help$/, '').split('|').map((w) => w.trim())
  const same = words.length === COMMAND_NAMES.length && COMMAND_NAMES.every((c) => words.includes(c))
  check('the unknown-command line lists exactly the commands', same, words.join(','))
  for (const c of COMMANDS) {
    const good = c.summary && c.usage?.startsWith(`pf ${c.name}`) && c.example?.startsWith(`pf ${c.name}`)
    if (!good) check(`help row for ${c.name} has summary, usage and a pf ${c.name} example`, false)
  }
  check('every help row has summary, usage and an example of itself', COMMANDS.every((c) => c.summary && c.usage?.startsWith(`pf ${c.name}`) && c.example?.startsWith(`pf ${c.name}`)))
  const text = helpText()
  check('help prints every command', COMMAND_NAMES.every((c) => new RegExp(`^  ${c} +\\S`, 'm').test(text)))
  const agents = text.slice(text.indexOf('For agents:'), text.indexOf('Commands:'))
  check('"For agents:" comes first', text.indexOf('For agents:') > 0 && text.indexOf('For agents:') < text.indexOf('Commands:'))
  check('with six recipes', (agents.match(/^ {6}pf /gm) ?? []).length === 6)
  for (const need of ['pf list', 'pf open', '--agent', '--prompt', 'pf tell', 'pf close', 'pf tidy', 'pf move', '--to'])
    check(`the recipes show ${need}`, agents.includes(need))
  check('pf help move explains the refusal', /working/.test(commandHelp('move')) && /asking/.test(commandHelp('move')))
  check('no help for a command that does not exist', commandHelp('bogus') === null)
}

// ----------------------------------------------------------------- the CLI, no app
console.log('2. help answers with no app; a wrong word points at it')
{
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const r = pf(args)
    check(`pf ${args.join(' ') || '(nothing)'} exits 0 with the help`, r.code === 0 && r.out.includes('For agents:'), `exit ${r.code} ${r.err}`)
  }
  const one = pf(['help', 'tidy'])
  check('pf help tidy prints that command', one.code === 0 && one.out.startsWith('pf tidy - ') && one.out.includes('--dupes'))
  const flagged = pf(['move', '--help'])
  check('pf move --help prints that command', flagged.code === 0 && flagged.out.startsWith('pf move - '))
  const bad = pf(['bogus'])
  check('an unknown command exits 1', bad.code === 1, `exit ${bad.code}`)
  check('and its message ends with run: pf help', bad.err.trim().endsWith('run: pf help'), bad.err.trim())
  const badTopic = pf(['help', 'bogus'])
  check('pf help <unknown> exits 1 pointing at pf help', badTopic.code === 1 && badTopic.err.trim().endsWith('run: pf help'))
  const tidyBad = pf(['tidy', '--everything'])
  check('tidy refuses a flag that is not its own, before any app', tidyBad.code === 1 && /--everything/.test(tidyBad.err))
  const moveBare = pf(['move', '3'])
  check('move with no --to refuses before any app', moveBare.code === 1 && /--to/.test(moveBare.err))
  const moveOk = pf(['move', '3', '--to', 'codex'], { PF_CTL_NO_APP: '1' })
  check('a well-formed move gets past the checks', moveOk.code === 0, `exit ${moveOk.code} ${moveOk.err}`)
}

// ----------------------------------------------------------------- tidy
console.log('3. tidy: which duplicates close, which stay')
const T = Date.UTC(2026, 8, 24, 12, 0, 0)
const min = 60_000
/** A row shaped like a real `sessions:list` answer (fields as the live app sends them). */
const row = (id, over = {}) => ({
  id,
  title: 'PaneForge',
  cwd: '/Users/r/Projects/PaneForge',
  agent: 'claude',
  model: 'claude-opus-5-5',
  status: 'idle',
  lastOutput: T - 60 * min,
  lastKeyboard: T - 90 * min,
  createdAt: T - 180 * min,
  openedAt: T - 180 * min,
  engaged: true,
  cols: 120,
  rows: 40,
  borrowed: false,
  printed: 0,
  interventions: 0,
  bell: false,
  ...over
})
{
  const list = [
    row('s1-old', { lastOutput: T - 120 * min }),
    row('s2-new', { lastOutput: T - 5 * min }),
    row('s3-codex', { agent: 'codex', model: 'gpt-5.5' }), // same folder, other agent: no group
    row('s4-work', { cwd: '/Users/r/Projects/site', status: 'working', runSince: T - 2 * min }),
    row('s5-ask', { cwd: '/Users/r/Projects/site', ask: { kind: 'choice', text: 'Proceed?' } }),
    row('s6-bg', { cwd: '/Users/r/Projects/site', backJob: 'npm test', backJobSince: T - 3 * min }),
    row('s7-typed', { cwd: '/Users/r/Projects/site', lastKeyboard: T - 2 * min }),
    row('s8-idle', { cwd: '/Users/r/Projects/site/' }), // trailing slash: same folder
    row('s9-dead', { cwd: '/Users/r/Projects/site', status: 'exited', exitedAt: T - 30 * min }),
    row('@e38/s1-a', { cwd: 'C:\\Users\\G\\Projects\\x', remote: { device: 'e38' } }),
    row('@e38/s2-b', { cwd: 'c:\\users\\g\\projects\\x\\', remote: { device: 'e38' }, lastOutput: T - 1 * min }),
    row('s10-self', { cwd: '/Users/r/Projects/memory' }),
    row('s11-mem', { cwd: '/Users/r/Projects/memory', lastOutput: T - 1 * min }),
    row('s12-draft', { cwd: '/Users/r/Projects/memory', drafting: true }),
    row('s13-hand', { cwd: '/Users/r/Projects/memory', handingOff: true }),
    row('s14-kept', { cwd: '/Users/r/Projects/memory', keepOpen: true }),
    row('s15-scr', { cwd: '/Users/r/Projects/memory', agent: 'screen', screen: { role: 'sink' } }),
    row('s16-sleep', { cwd: '/Users/r/Projects/memory', status: 'exited', asleep: true })
  ]
  const groups = findDuplicates(list, { now: T, self: 's10-self' })
  const byCwd = (frag) => groups.find((g) => g.cwd.includes(frag))
  const pf1 = byCwd('PaneForge')
  check('two idle claude panes in one folder are a group', pf1 && pf1.keep.pane.id === 's2-new', pf1?.keep.pane.id)
  check('the older idle one closes', pf1?.close.map((m) => m.pane.id).join() === 's1-old')
  check('and its number is its place on the desk', pf1?.close[0]?.number === 1)
  check('another agent in the same folder is not a duplicate', !groups.some((g) => g.agent === 'codex'))
  const site = byCwd('site')
  check('a working pane is the one kept, over a more recent idle one', site?.keep.pane.id === 's4-work', site?.keep.pane.id)
  check('the one idle, untouched extra closes (a trailing slash is the same folder)', site?.close.map((m) => m.pane.id).join() === 's8-idle', site?.close.map((m) => m.pane.id).join())
  const heldWhy = (id) => site?.held.find((m) => m.pane.id === id)?.why.join('; ') ?? ''
  check('a pane asking a question stays', /asking a question/.test(heldWhy('s5-ask')))
  check('a pane with a background job stays', /background job/.test(heldWhy('s6-bg')))
  check('a pane typed into 2 minutes ago stays', /typed into 2 min ago/.test(heldWhy('s7-typed')), heldWhy('s7-typed'))
  check('an exited pane is not a duplicate (clear finished takes it)', ![...site.close, ...site.held].some((m) => m.pane.id === 's9-dead'))
  const remote = groups.find((g) => g.keep.pane.id.startsWith('@'))
  check('a Windows folder in another case is the same folder', remote && remote.close.length + remote.held.length === 1)
  check('a pane on another computer is never closed', remote?.close.length === 0 && /another computer/.test(remote?.held[0]?.why.join() ?? ''))
  const mem = byCwd('memory')
  const memHeld = Object.fromEntries((mem?.held ?? []).map((m) => [m.pane.id, m.why.join('; ')]))
  check('the pane running pf is never closed', /running this command/.test(memHeld['s10-self'] ?? ''))
  check('text typed and not sent keeps a pane', /typed in its prompt box/.test(memHeld['s12-draft'] ?? ''))
  check('a pane mid-handoff stays', /handoff/.test(memHeld['s13-hand'] ?? ''))
  check('a pane set to stay open stays', /stay open/.test(memHeld['s14-kept'] ?? ''))
  check('screen views and sleeping panes are not counted', ![...(mem?.held ?? []), ...(mem?.close ?? [])].some((m) => ['s15-scr', 's16-sleep'].includes(m.pane.id)))
  check('nothing in memory closes', mem?.close.length === 0)
  check('a single pane is no group', findDuplicates([row('only')], { now: T }).length === 0)
  check('a clean idle pane has no reason to stay', tidyHoldReasons(row('x'), { now: T }).length === 0)
  check('the pane open on screen stays', tidyHoldReasons(row('x', { focused: true }), { now: T }).some((w) => /on screen/.test(w)))
  // A pane opened a minute ago and never used has the NEWEST output (its banner) - it
  // must not outrank, and so close, the chat that has the work in it.
  const worked = row('s20-work', { cwd: '/w', lastOutput: T - 30 * min, lastKeyboard: T - 40 * min })
  const blank = row('s21-new', { cwd: '/w', engaged: false, createdAt: T - 60_000, openedAt: T - 60_000, lastKeyboard: T - 60_000, lastOutput: T - 55_000 })
  const g = findDuplicates([worked, blank], { now: T })[0]
  check('a used chat is kept over a newer never-used pane', g?.keep.pane.id === 's20-work' && g?.close[0]?.pane.id === 's21-new', g?.keep.pane.id)
  const fresh = row('f', { createdAt: T - 2 * min, openedAt: T - 2 * min, lastKeyboard: T - 2 * min, lastOutput: T - 2 * min })
  check('a pane nobody typed into is not "typed into" (the app stamps lastKeyboard at open)', !tidyHoldReasons(fresh, { now: T }).some((w) => /typed into/.test(w)))

  const dead = row('d', { status: 'exited', exitedAt: T - 20 * min, lastKeyboard: T - 60 * min })
  check('an exited, untouched pane is finished', isFinishedPane(dead))
  check('a sleeping pane is not finished', !isFinishedPane({ ...dead, asleep: true }))
  check('one typed into after it exited is not finished', !isFinishedPane({ ...dead, lastKeyboard: T - 1 * min }))
  check('one on another computer is not finished', !isFinishedPane({ ...dead, id: '@e/d' }))
  check('an idle pane is not finished', !isFinishedPane(row('i')))
}

const RESUME = '849b009a-e33d-4189-8960-6240e8f72219'
// ----------------------------------------------------------------- move refusals
console.log('4. move refuses a pane that is mid-anything')
{
  const r = (over) => moveRefusal(row('m', { resumeId: RESUME, ...over }), { now: T, self: 's99-me' })
  check('an idle chat may move', r({}) === null)
  check('a chat whose conversation has no id yet is refused (it could not be reopened)', /not been identified/.test(r({ resumeId: undefined }) ?? ''))
  check('an agent the app keeps no id for may move without one', r({ agent: 'grok', resumeId: undefined }) === null)
  check('a working pane is refused', /working/.test(r({ status: 'working' }) ?? ''))
  check('a pane mid-turn reading idle is refused', /working/.test(r({ runSince: T - min }) ?? ''))
  check('a pane asking a question is refused', /asking a question/.test(r({ ask: { kind: 'yesno' } }) ?? ''))
  check('the refusal says what to do', /wait until it is idle/.test(r({ ask: { kind: 'yesno' } }) ?? ''))
  check('a pane mid-handoff is refused', /handoff/.test(r({ handingOff: true }) ?? ''))
  check('a pane with unsent text is refused', /not sent/.test(r({ drafting: true }) ?? ''))
  check('a pane with a background job is refused', /background job/.test(r({ backJob: 'sleep 60' }) ?? ''))
  check('a shell is refused', /shell/.test(r({ agent: 'shell' }) ?? ''))
  check('a pane on another computer is refused', /another computer/.test(moveRefusal(row('@d/s1'), { now: T }) ?? ''))
  check('a pane cannot move itself', /itself/.test(moveRefusal(row('s99-me'), { now: T, self: 's99-me' }) ?? ''))
}

// ----------------------------------------------------------------- handoff brief
{
  // The folder must be free the moment the old pane closes, or the app opens the new
  // agent in a copy of it (a second pane in a busy git folder gets its own worktree).
  const repo = join(DIR, 'repo')
  const laneA = join(DIR, 'repo-a')
  mkdirSync(repo, { recursive: true })
  mkdirSync(laneA, { recursive: true })
  const pane = row('s5-me', { cwd: repo, resumeId: RESUME })
  const desk = [row('s1-x', { cwd: join(DIR, 'elsewhere') }), pane]
  check('a folder nobody else is in is free', folderRefusal(desk, pane, null) === null)
  const shell = row('s7-sh', { cwd: `${repo}/`, agent: 'shell', title: 'build' })
  check('another pane open in the same folder refuses, naming it', /pane 3 "build"/.test(folderRefusal([...desk, shell], pane, null) ?? ''))
  check('a sleeping pane in the folder refuses too', /pane 3/.test(folderRefusal([...desk, { ...shell, status: 'exited', asleep: true }], pane, null) ?? ''))
  check('a finished pane in the folder does not', folderRefusal([...desk, { ...shell, status: 'exited', exitedAt: T }], pane, null) === null)
  check('a pane on another computer in a same-named folder does not', folderRefusal([...desk, { ...shell, id: '@pc/s1' }], pane, null) === null)
  const ledger = { main: repo, lanes: { main: { pane: 's5-me' }, a: { pane: 's9-other' } } }
  check('the ledger names who holds the main folder', claimHolder(ledger, repo) === 's5-me')
  check('and a lane folder, spelled <repo>-<lane>', claimHolder(ledger, laneA) === 's9-other')
  check('an unclaimed folder has no holder', claimHolder({ main: repo, lanes: {} }, repo) === null && claimHolder(null, repo) === null)
  check('its own claim does not refuse the move (it goes with the close)', folderRefusal(desk, pane, 's5-me') === null)
  check('another chat\'s claim refuses it', /another chat \(s9-other\)/.test(folderRefusal(desk, { ...pane, cwd: laneA }, 's9-other') ?? ''))
  check('/tmp and /private/tmp are one folder', process.platform !== 'darwin' || samePath('/tmp', '/private/tmp'))
  check('a scratch folder with no repo has no ledger', laneLedger(DIR) === null)
}

console.log('5. the handoff brief, from real-shaped transcripts')
const CWD = '/Users/r/Projects/PaneForge'
const line = (o) => JSON.stringify(o)
const base = { parentUuid: null, isSidechain: false, userType: 'external', cwd: CWD, sessionId: RESUME, version: '2.3.1', gitBranch: 'master' }
const user = (content, over = {}) => line({ ...base, type: 'user', message: { role: 'user', content }, uuid: 'u', timestamp: '2026-09-24T10:00:00Z', ...over })
const asst = (blocks, over = {}) =>
  line({ ...base, type: 'assistant', message: { model: 'claude-opus-5-5', id: 'msg_1', type: 'message', role: 'assistant', content: blocks, stop_reason: null, usage: {} }, requestId: 'req_1', uuid: 'a', timestamp: '2026-09-24T10:00:05Z', ...over })
const claudeRows = [
  line({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: RESUME }),
  line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
  user('Fix the flaky login test'),
  asst([{ type: 'thinking', thinking: 'hmm', signature: 's' }]),
  asst([{ type: 'text', text: 'Old reply about login.' }]),
  user('Now make pf tidy close duplicates'),
  line({ ...base, type: 'attachment', attachment: { type: 'hook_additional_context', content: ['x'] } }),
  user([{ type: 'text', text: 'Skill body injected' }], { isMeta: true }),
  asst([{ type: 'thinking', thinking: 'plan', signature: 's' }]),
  asst([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
  user([{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'a\nb', is_error: false }]),
  user('<command-name>/model</command-name>\n<command-message>model</command-message>'),
  asst([{ type: 'text', text: 'Subagent chatter' }], { isSidechain: true }),
  user('A subagent prompt', { isSidechain: true }),
  asst([{ type: 'text', text: 'Tidy now lists duplicates.' }]),
  asst([{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'node test' } }]),
  user([{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'ok' }]),
  asst([{ type: 'text', text: 'Tests pass: 42 ok.' }]),
  user([{ type: 'text', text: '[Request interrupted by user]' }]),
  line({ type: 'last-prompt', leafUuid: 'u', sessionId: RESUME }),
  line({ type: 'ai-title', title: 'pf tidy', sessionId: RESUME })
]
{
  const ex = lastExchange(claudeRows.join('\n'))
  check('the last ask is the last thing a person typed', ex.ask === 'Now make pf tidy close duplicates', ex.ask)
  check('the reply is every text block after it, in order', ex.reply === 'Tidy now lists duplicates.\n\nTests pass: 42 ok.', JSON.stringify(ex.reply))
  check('and it is marked answered', ex.answered === true)
  const pending = lastExchange([...claudeRows, user('And now the move command')].join('\n'))
  check('an ask with no reply yet keeps the reply before it', pending.ask === 'And now the move command' && pending.reply.startsWith('Tidy now') && pending.answered === false)
  check('a half-written last line is skipped, not fatal', lastExchange(claudeRows.join('\n') + '\n{"type":"assis').ask === 'Now make pf tidy close duplicates')

  const codexRows = [
    line({ timestamp: '2026-09-24T10:00:00Z', type: 'session_meta', payload: { id: '019ff85b-5bc1-72b1-bce5-0fd77bbf6530', cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.60.0' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }, { type: 'input_text', text: '<environment_context>' }] } }),
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the release script' }] } }),
    line({ type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'x' } }),
    line({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '...' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ported; 3 files changed.' }] } }),
    line({ type: 'event_msg', payload: { type: 'task_complete' } })
  ]
  const cx = lastExchange(codexRows.join('\n'))
  check('Codex: the injected context is not the ask', cx.ask === 'Port the release script', cx.ask)
  check('Codex: the reply is the assistant output', cx.reply === 'Ported; 3 files changed.' && cx.answered)

  // Where the files are.
  const claudeHome = join(DIR, 'claude')
  const codexHome = join(DIR, 'codex')
  const projDir = claudeProjectDir(claudeHome, CWD)
  check('Claude folder names spell every non-alphanumeric as a dash', projDir.endsWith(join('projects', '-Users-r-Projects-PaneForge')))
  mkdirSync(projDir, { recursive: true })
  const cFile = join(projDir, `${RESUME}.jsonl`)
  writeFileSync(cFile, claudeRows.join('\n') + '\n')
  check('a Claude conversation is found in its folder', findTranscript({ cwd: CWD, resumeId: RESUME, agent: 'claude', claudeHome, codexHome }) === cFile)
  check('and found from a lane copy of the folder', findTranscript({ cwd: `${CWD}-a`, resumeId: RESUME, agent: 'claude', claudeHome, codexHome }) === cFile)
  const codexId = '019ff85b-5bc1-72b1-bce5-0fd77bbf6530'
  const day = join(codexHome, 'sessions', '2026', '09', '24')
  mkdirSync(day, { recursive: true })
  const xFile = join(day, `rollout-2026-09-24T10-00-00-${codexId}.jsonl`)
  writeFileSync(xFile, codexRows.join('\n') + '\n')
  check('a Codex rollout is found by its id', findTranscript({ cwd: CWD, resumeId: codexId, agent: 'codex', claudeHome, codexHome }) === xFile)
  check('no id, no file', findTranscript({ cwd: CWD, resumeId: undefined, agent: 'claude', claudeHome, codexHome }) === null)
  check('an id that is a path is refused', findTranscript({ cwd: CWD, resumeId: '../../etc/passwd', agent: 'claude', claudeHome, codexHome }) === null)
  check('an unknown id finds nothing', findTranscript({ cwd: CWD, resumeId: 'deadbeef-0000', agent: 'claude', claudeHome, codexHome }) === null)

  // A long file is read from its tail, and the first (cut) line is dropped.
  const long = join(DIR, 'long.jsonl')
  writeFileSync(long, `${'x'.repeat(5000)}\n${claudeRows.join('\n')}\n`)
  const tail = readTail(long, 4000)
  check('a tail read drops the cut line', !tail.startsWith('x') && lastExchange(tail).reply.endsWith('42 ok.'))
  check('a short file is read whole', readTail(cFile) === readFileSync(cFile, 'utf8'))

  const pane = row('s31-muf23r25', { title: 'paneforge-next', cwd: CWD, resumeId: RESUME })
  const exchange = lastExchange(readTail(cFile))
  const brief = buildHandoffBrief({ pane, number: 3, to: 'codex', model: 'gpt-5.5', transcript: cFile, exchange, now: new Date(T) })
  check('the brief names the folder', brief.includes(`Folder: ${CWD}`))
  check('the previous agent and pane', brief.includes('claude (claude-opus-5-5)') && brief.includes('3 "paneforge-next" (s31-muf23r25)'))
  check('the conversation file', brief.includes(cFile))
  check('the last ask and the last reply', brief.includes('Now make pf tidy close duplicates') && brief.includes('Tests pass: 42 ok.'))
  check('and where to start', brief.includes('## Before you start') && brief.includes('git status'))
  const huge = buildHandoffBrief({
    pane,
    number: 3,
    to: 'codex',
    transcript: cFile,
    exchange: { ask: 'A'.repeat(ASK_CHARS + 500), reply: `${'B'.repeat(REPLY_CHARS)}THE END`, answered: true },
    now: new Date(T)
  })
  const replyPart = huge.slice(huge.indexOf('## The last reply'), huge.indexOf('## Before you start'))
  check('a long reply keeps its end', replyPart.includes('THE END') && replyPart.includes('earlier characters cut'))
  check('cut to about 4000 characters', (replyPart.match(/B/g) ?? []).length === REPLY_CHARS - 'THE END'.length)
  check('a long ask keeps its start and says it was cut', huge.includes('A'.repeat(ASK_CHARS)) && !huge.includes('A'.repeat(ASK_CHARS + 1)) && huge.includes('more characters cut'))
  const noFile = buildHandoffBrief({ pane, number: 3, to: 'codex', transcript: null, exchange: null, screen: stripAnsi('\x1b[1mDone\x1b[0m: 3 files\r\n\x1b]0;title\x07$ '), now: new Date(T) })
  check('with no conversation, it says so and carries the last screen', noFile.includes('not found on this computer') && noFile.includes('Done: 3 files'))
  check('colour codes are stripped from the screen', stripAnsi('\x1b[31mred\x1b[0m\r\nnext') === 'red\nnext')
  check('the prompt points at the brief', movePrompt('/tmp/b.md') === 'Continue this work. Handoff brief: /tmp/b.md. Read it first.')
}

rmSync(DIR, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
