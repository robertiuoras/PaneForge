// The shipped auto-clear hook (scripts/autoclear-hook.mjs) and its installer
// (src/main/autoclearHooks.ts), end to end with a sandbox HOME - never the real
// ~/.claude/settings.json.
//
//   hook:      under the line does nothing; over it with no handoff blocks ONCE naming the
//              path the app reads; a fresh handoff with steps writes a request the app's own
//              `readAsk` accepts; `None` asks for nothing; a /clear start hands the file over.
//   parity:    the hook's copy of the handoff path math equals src/shared/handoffSteps.ts.
//   installer: fresh -> both events; rerun changes nothing; lane + autoclear entries do not
//              delete each other; a foreign stop-runner / invalid JSON is left byte-for-byte.
//   runner:    the command shape for a machine without Node, POSIX and Windows (PowerShell).
//
// Run: node scripts/autoclear-hook-test.mjs

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOK = join(REPO, 'scripts', 'autoclear-hook.mjs')
const work = mkdtempSync(join(tmpdir(), 'autoclear-hook-'))
let failed = 0
function say(what, ok, detail = '') {
  if (ok) console.log(`ok    ${what}`)
  else {
    failed++
    console.error(`FAIL  ${what}${detail ? `\n      ${detail}` : ''}`)
  }
}

const load = async (entry, extra = {}) => {
  const out = join(work, `${Math.random().toString(36).slice(2)}.mjs`)
  buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, ...extra })
  return import(pathToFileURL(out).href)
}
const shared = await load(join(REPO, 'src', 'shared', 'handoffSteps.ts'))
const { readAsk } = await load(join(REPO, 'src', 'shared', 'autoclear.ts'))
const hook = await import(pathToFileURL(HOOK).href)

// ---------------------------------------------------------------- parity with the app

const cwds = [
  '/Users/x/Projects/App',
  '/Users/x/Projects/App-a',
  'C:\\Users\\Jo Smith\\Projects\\My App',
  'C:\\Users\\Jo Smith\\Projects\\My App-b',
  '/tmp/wé ird/x.y'
]
let same = true
for (const cwd of cwds)
  for (const pane of ['s3-abc12', 'bad id', ''])
    for (const link of [true, false]) {
      const a = JSON.stringify(shared.handoffCandidates(cwd, pane, '/h/.claude', () => link))
      const b = JSON.stringify(hook.handoffCandidates(cwd, pane, '/h/.claude', () => link))
      if (a !== b || shared.slugFor(cwd) !== hook.slugFor(cwd)) {
        same = false
        console.error(`      ${cwd} ${pane} ${link}\n      app  ${a}\n      hook ${b}`)
      }
    }
say('hook path math equals shared/handoffSteps.ts (incl. a Windows path)', same)
const mds = [
  '## Next steps\n1. build it\n2. only after the release\n3. your call on pricing\n- [ ] **ship** the fix',
  '## Next steps\nNone',
  '# State\nx\n## Next steps\n- None\n## Gotchas\n1. not a step'
]
say(
  'hook Next-steps judgement equals the app',
  mds.every((m) => JSON.stringify(shared.actionableNextSteps(m)) === JSON.stringify(hook.actionableNextSteps(m)))
)

// ---------------------------------------------------------------- the hook, as Claude Code runs it

const home = join(work, 'home')
const claudeHome = join(home, '.claude')
const userData = join(work, 'user data') // a space, like Application Support
const cwd = join(work, 'proj')
mkdirSync(cwd, { recursive: true })
const PANE = 's7-test01'
const transcript = (tokens) => {
  const f = join(work, `t-${tokens}.jsonl`)
  const rows = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 } } },
    { type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: tokens - 300, cache_creation_input_tokens: 200 } } },
    { type: 'user', message: { content: 'tool result' } }
  ]
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PF_CLAUDE_HOME: claudeHome, PF_PANE: PANE }
function runHook(event, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOK, `--event=${event}`, `--user-data=${userData}`, '--installed-by=paneforge'], {
    input: JSON.stringify({ cwd, ...input }),
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...env, ...extraEnv }
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const reqDir = join(userData, 'autoclear-requests')
const requests = () => (existsSync(reqDir) ? readdirSync(reqDir) : [])
const expected = shared.handoffCandidates(cwd, PANE, claudeHome, () => false)[0]

const under = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(50_000) })
say('under the line: exit 0, nothing written', under.code === 0 && !under.err && requests().length === 0, JSON.stringify(under))

const outside = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(250_000) }, { PF_PANE: '' })
say('outside a PaneForge pane: exit 0, silent', outside.code === 0 && !outside.err && !existsSync(join(userData, 'autoclear-hook')), JSON.stringify(outside))

const off = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(250_000) }, { AUTOCLEAR: 'off' })
say('AUTOCLEAR=off: exit 0, silent', off.code === 0 && !off.err, JSON.stringify(off))

const block = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(250_000) })
say('over the line, no handoff: exit 2', block.code === 2, JSON.stringify(block))
say('the block names the exact path the app reads', block.err.includes(expected), `${expected}\n      ${block.err}`)
say('and asks for State and Next steps', /## State/.test(block.err) && /## Next steps/.test(block.err) && /None/.test(block.err))
const again = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(260_000) })
say('a second stop in the same session does not block again', again.code === 0 && !again.err, JSON.stringify(again))
const other = runHook('stop', { session_id: 'sess-2', transcript_path: transcript(260_000), stop_hook_active: true })
say('stop_hook_active never blocks', other.code === 0 && !other.err, JSON.stringify(other))

// The session did as it was told: the handoff exists, the continuation Stop arrives.
mkdirSync(dirname(expected), { recursive: true })
writeFileSync(expected, '# Handoff\n## State\nhalf done\n## Next steps\n1. finish the parser\n2. run the suite\n3. your call on the name\n')
const ask = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(262_000), stop_hook_active: true })
const files = requests()
say('fresh handoff with steps: exit 0 and one request file', ask.code === 0 && files.length === 1 && files[0] === `${PANE}.json`, JSON.stringify({ ask, files }))
const raw = files.length ? JSON.parse(readFileSync(join(reqDir, files[0]), 'utf8')) : null
const parsed = readAsk(raw)
say("the app's own readAsk accepts it", !!parsed && parsed.paneId === PANE && parsed.prompt.length > 0, JSON.stringify(raw))
say('carrying only the actionable steps', JSON.stringify(parsed?.steps) === JSON.stringify(['finish the parser', 'run the suite']), JSON.stringify(parsed?.steps))
// readAsk keeps only a plain POSIX path (it is typed into a pty); a Windows one is dropped
// and the app resolves the handoff itself (`handoffFor`).
say('and the handoff path where readAsk keeps one', process.platform === 'win32' ? parsed?.handoffPath === undefined : parsed?.handoffPath === expected, JSON.stringify(parsed))
const twice = runHook('stop', { session_id: 'sess-1', transcript_path: transcript(263_000) })
say('asked once per session', twice.code === 0 && requests().length === 1, JSON.stringify(twice))
rmSync(join(reqDir, files[0]), { force: true })

// Nothing open means no clear, even over the line with a fresh file.
writeFileSync(expected, '## Next steps\nNone\n')
const none = runHook('stop', { session_id: 'sess-3', transcript_path: transcript(250_000) })
say('`## Next steps` None: no request', none.code === 0 && requests().length === 0 && !none.err, JSON.stringify(none))

// A stale handoff is about earlier work: block rather than clear on it.
writeFileSync(expected, '## Next steps\n1. old work\n')
const old = (Date.now() - 45 * 60_000) / 1000
utimesSync(expected, old, old)
const stale = runHook('stop', { session_id: 'sess-4', transcript_path: transcript(250_000) })
say('a 45-minute-old handoff blocks, not clears', stale.code === 2 && requests().length === 0, JSON.stringify(stale))

// ---------------------------------------------------------------- SessionStart after /clear

writeFileSync(expected, '## State\nthe parser is half done – café\n## Next steps\n1. finish the parser\n')
const start = runHook('start', { session_id: 'sess-5', source: 'clear' })
let ctx = null
try {
  ctx = JSON.parse(start.out).hookSpecificOutput
} catch {
  /* judged below */
}
say('start after /clear prints the handoff as additionalContext', start.code === 0 && ctx?.hookEventName === 'SessionStart' && /SESSION HANDOFF/.test(ctx?.additionalContext) && ctx.additionalContext.includes('the parser is half done – café'), start.out)
say('stdout is pure ASCII (it may pass through a PowerShell pipe)', /^[\x00-\x7e]*$/.test(start.out), start.out.slice(0, 200))
const startup = runHook('start', { session_id: 'sess-6', source: 'startup' })
say('any other start prints nothing', startup.code === 0 && startup.out === '', startup.out)
// The resumed session must not read the file it was handed as a fresh ask to clear again.
const resumed = runHook('stop', { session_id: 'sess-5', transcript_path: transcript(250_000) })
say('the session resumed from a handoff does not clear on that same file', resumed.code === 2 && requests().length === 0, JSON.stringify(resumed))

const log = readFileSync(join(userData, 'autoclear-hook.log'), 'utf8')
say('every decision is logged', ['under', 'block', 'requested', 'no-open-steps', 'injected'].every((w) => log.includes(w)), log.slice(0, 400))

// ---------------------------------------------------------------- the app takes the request file

{
  const stub = join(work, 'electron-stub.mjs')
  writeFileSync(stub, `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO)}, getPath: () => ${JSON.stringify(join(work, 'appdata'))} }\n`)
  const { drainRequests } = await load(join(REPO, 'src', 'main', 'autoclearRequests.ts'), { alias: { electron: stub } })
  const dir = join(work, 'drain')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${PANE}.json`), JSON.stringify(raw))
  writeFileSync(join(dir, 'half.json.tmp'), '{')
  const got = []
  const n = drainRequests(dir, (r) => {
    got.push(readAsk(r))
    return { ok: true }
  })
  say('the watcher hands each request to the ask code and deletes it', n === 1 && got[0]?.paneId === PANE && !existsSync(join(dir, `${PANE}.json`)) && existsSync(join(dir, 'half.json.tmp')), JSON.stringify(got))
}

// ---------------------------------------------------------------- the installer

const stubDir = join(work, 'stub')
mkdirSync(stubDir, { recursive: true })
const UD = '/Users/Some One/Library/Application Support/claude-orchestrator'
writeFileSync(join(stubDir, 'electron.mjs'), `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO)}, getPath: () => ${JSON.stringify(UD)} }\n`)
writeFileSync(join(stubDir, 'entry.ts'), `export { installAutoClearHooks } from ${JSON.stringify(join(REPO, 'src/main/autoclearHooks'))}\nexport { installLaneHooks, runnerFor } from ${JSON.stringify(join(REPO, 'src/main/laneHooks'))}\n`)
const bundle = join(work, 'installers.mjs')
buildSync({ entryPoints: [join(stubDir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', alias: { electron: join(stubDir, 'electron.mjs') }, outfile: bundle })
const { runnerFor } = await import(pathToFileURL(bundle).href)

function install(h, settings, calls = 'installAutoClearHooks(true)', extraEnv = {}) {
  mkdirSync(join(h, '.claude'), { recursive: true })
  const file = join(h, '.claude', 'settings.json')
  if (settings !== undefined) writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2))
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(pathToFileURL(bundle).href)}\nconsole.log([${calls.split(',').map((c) => 'm.' + c.trim()).join(',')}].join('\\n'))`], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: h, USERPROFILE: h, PANEFORGE_NO_LANE_HOOKS: '', ...extraEnv }
  })
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* judged by the caller */
  }
  return { said: (r.stdout ?? '').trim() + (r.stderr ?? ''), settings: json, raw: text }
}
const commands = (s, tag) => Object.values(s?.hooks ?? {}).flatMap((gs) => gs.flatMap((g) => (g.hooks ?? []).map((x) => x.command).filter((c) => c?.includes(tag))))

const fresh = join(work, 'i-fresh')
const a = install(fresh, {})
const ac = commands(a.settings, 'autoclear-hook.mjs')
say('fresh machine: installed', /autoclear hooks: installed ->/.test(a.said), a.said)
say('Stop and SessionStart, one each', ac.length === 2 && commands({ hooks: { Stop: a.settings.hooks.Stop } }, 'autoclear-hook.mjs').length === 1 && commands({ hooks: { SessionStart: a.settings.hooks.SessionStart } }, 'autoclear-hook.mjs').length === 1, JSON.stringify(a.settings))
say('the user-data path with a space is one quoted argument', ac.every((c) => c.includes(`"--user-data=${UD}"`) && c.includes('--installed-by=paneforge')), JSON.stringify(ac))
const b = install(fresh, undefined)
say('rerun: already installed, no second copy', /already installed/.test(b.said) && commands(b.settings, 'autoclear-hook.mjs').length === 2, b.said)
const both = install(fresh, undefined, 'installLaneHooks(true), installAutoClearHooks(true), installLaneHooks(true), installAutoClearHooks(true)')
say(
  'lane and autoclear entries share a Stop group without deleting each other',
  commands(both.settings, 'autoclear-hook.mjs').length === 2 && commands(both.settings, 'lane-hook.mjs').length === 4 && /already installed[\s\S]*already installed/.test(both.said.split('\n').slice(2).join('\n')),
  both.said
)

const foreignSettings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/Users/r/claude-config/stop-runner.mjs"' }] }] } }
const foreignRaw = JSON.stringify(foreignSettings, null, 2)
const f = install(join(work, 'i-foreign'), foreignRaw)
say('a machine running its own stop-runner is left alone', /left alone/.test(f.said) && f.raw === foreignRaw, f.said)
const f2 = install(join(work, 'i-foreign2'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /x/handoff-inject.mjs' }] }] } })
say('so is one with a handoff injector', /left alone/.test(f2.said) && commands(f2.settings, 'autoclear-hook.mjs').length === 0, f2.said)
const bad = install(join(work, 'i-bad'), '{ not json')
say('invalid JSON is refused and left byte-for-byte', /not valid JSON/.test(bad.said) && bad.raw === '{ not json', bad.said)
const dev = install(join(work, 'i-dev'), '{}', 'installAutoClearHooks(false)')
say('a dev or try copy never writes', /never rewires/.test(dev.said) && dev.raw === '{}', dev.said)
const opt = install(join(work, 'i-opt'), '{}', 'installAutoClearHooks(true)', { PANEFORGE_NO_LANE_HOOKS: '1' })
say('PANEFORGE_NO_LANE_HOOKS skips it', /skipped/.test(opt.said) && opt.raw === '{}', opt.said)

// ---------------------------------------------------------------- the runner without Node

const winExe = 'C:\\Users\\O\'Brien Q\\AppData\\Local\\Programs\\claude-orchestrator\\PaneForge.exe'
const winScript = 'C:\\Users\\O\'Brien Q\\AppData\\Local\\Programs\\claude-orchestrator\\resources\\scripts\\autoclear-hook.mjs'
const winUd = "--user-data=C:\\Users\\O'Brien Q\\AppData\\Roaming\\claude-orchestrator"
const w = runnerFor('win32', false, winExe)
const wline = w.line(winScript, ['--event=stop', winUd, '--installed-by=paneforge'])
say('Windows without Node: PowerShell, pinned by the entry', w.shell === 'powershell', JSON.stringify(w))
say(
  'Windows without Node: forward slashes, quotes doubled, exit code kept',
  wline ===
    "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:/Users/O''Brien Q/AppData/Local/Programs/claude-orchestrator/PaneForge.exe' 'C:/Users/O''Brien Q/AppData/Local/Programs/claude-orchestrator/resources/scripts/autoclear-hook.mjs' '--event=stop' '--user-data=C:/Users/O''Brien Q/AppData/Roaming/claude-orchestrator' '--installed-by=paneforge' | Write-Output; exit $LASTEXITCODE",
  wline
)
const wn = runnerFor('win32', true, winExe).line(winScript, ['--event=stop', winUd])
say('Windows with Node: plain node line, no shell pinned', !runnerFor('win32', true, winExe).shell && wn === `node "C:/Users/O'Brien Q/AppData/Local/Programs/claude-orchestrator/resources/scripts/autoclear-hook.mjs" --event=stop "--user-data=C:/Users/O'Brien Q/AppData/Roaming/claude-orchestrator"`, wn)
const m = runnerFor('darwin', false, '/Applications/PaneForge.app/Contents/MacOS/PaneForge').line('/Applications/PaneForge.app/Contents/Resources/scripts/lane-hook.mjs', ['--event=prompt'])
say('Mac without Node: the app binary as Node', m === 'ELECTRON_RUN_AS_NODE=1 "/Applications/PaneForge.app/Contents/MacOS/PaneForge" "/Applications/PaneForge.app/Contents/Resources/scripts/lane-hook.mjs" --event=prompt', m)

// And they actually run: the POSIX line under sh with Electron's own binary as Node, and
// the PowerShell line wherever a PowerShell exists (node stands in for the app there - it
// ignores ELECTRON_RUN_AS_NODE, which is the part the PC run proved).
const hookInput = JSON.stringify({ cwd, session_id: 'sess-run', transcript_path: transcript(250_000) })
let electronBin = null
try {
  electronBin = createRequire(import.meta.url)('electron')
} catch {
  /* not installed */
}
if (process.platform !== 'win32' && typeof electronBin === 'string' && existsSync(electronBin)) {
  const line = runnerFor(process.platform, false, electronBin).line(HOOK, ['--event=stop', `--user-data=${join(work, 'ud-electron')}`])
  const r = spawnSync('/bin/sh', ['-c', line], { input: hookInput, encoding: 'utf8', timeout: 60_000, env: { ...env, PF_CLAUDE_HOME: join(work, 'ch-electron') } })
  say('POSIX line on the Electron binary blocks with exit 2', r.status === 2 && /AUTO-CLEAR/.test(r.stderr), `${r.status} ${r.stderr?.slice(0, 300)}`)
} else console.log('skip  POSIX Electron-as-Node run (no electron binary here)')
const ps = ['pwsh', 'powershell'].find((x) => spawnSync(x, ['-NoProfile', '-Command', 'exit 0']).status === 0)
if (ps) {
  // Electron's own binary where it is installed (the real fallback), else node standing in.
  const asNode = typeof electronBin === 'string' && existsSync(electronBin) ? electronBin : process.execPath
  const pr = runnerFor('win32', false, asNode)
  const line = pr.line(HOOK, ['--event=stop', `--user-data=${join(work, 'ud-ps')}`])
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', line], { input: hookInput, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env, PF_CLAUDE_HOME: join(work, 'ch-ps') } })
  say(`PowerShell line (${ps}, ${asNode === process.execPath ? 'node' : 'Electron'}) gets stdin and keeps exit 2`, r.status === 2 && /AUTO-CLEAR/.test(r.stderr), `${r.status} ${r.stderr?.slice(0, 300)}`)
} else console.log('skip  PowerShell run (no PowerShell here; proven on the PC 2026-09-23)')

try {
  rmSync(work, { recursive: true, force: true })
} catch {
  /* disposable */
}
if (failed) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nautoclear hook: all cases behaved')
