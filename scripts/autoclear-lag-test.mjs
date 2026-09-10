// Autoclear under LAG: the two ways it spammed a pane on 2026-09-10.
//
// Neither of these is arithmetic drift - both were the flow doing exactly what it was
// written to do, on a machine slow enough that its readings stopped being true.
//
//   1. THE LOOP. `~/.claude/autoclear.log`: pane s14 (angie-c) cleared at 06:36, 06:39,
//      07:00 and 07:03 - four clears in 27 minutes - and assistant-c twice. A FRESH
//      session there read `tokens=157356` at its very first Stop: the handoff, the
//      injected memory index and CLAUDE.md are already past the 150k line before the
//      session has done anything. Every clear therefore produced a session that was
//      immediately due for another one. The hook's state file cannot stop this, because
//      `/clear` starts a NEW session id and the state file is keyed by it - so the
//      cooldown has to live on the PANE, which is the thing that repeats.
//
//   2. TYPING INTO A BUSY PANE. `autoclear-app.log`: 07:03:44 `/clear` typed, 07:03:47 the
//      resume prompt, 07:04:07 "a turn started". Robert's screen showed `Continue the
//      handoff...`, `/clear`, `Continue the handoff...` all sitting under "Press up to edit
//      queued messages". `dropFor` reads `runSince`, and `runSince` is dropped when the
//      busy footer stops saying so - which under load is not the same thing as the turn
//      being over. A Stop hook that BLOCKS (this one, ideas-gate, verify-gate) makes the
//      CLI write a second reply into the same pane; the countdown fires in the gap.
//
// So this suite drives the real hook binary against real fixtures for (1), and the real
// countdown in a real headless window for (2). The app half SKIPS out loud with the
// launch command when there is no window, the same contract every ui-lab suite has.
//
//   npm run build && npm run try -- --headless --remote-debugging-port=9333
//   node scripts/autoclear-lag-test.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect, SkipError } from './ui-lab.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'autoclear.mjs')

let checks = 0
let failures = 0
const ok = (what, cond, detail = '') => {
  checks++
  if (cond) return console.log(`  ok   ${what}`)
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}
const skip = (why) => {
  console.log(`SKIP autoclear-lag: ${why}`)
}

if (!existsSync(HOOK)) {
  skip(`the canonical hook is not on this machine (${HOOK})`)
  process.exit(0)
}

/* ------------------------------------------------------------------ the hook half */

const box = mkdtempSync(join(tmpdir(), 'pf-aclag-'))
const HOME = join(box, 'home')
const TMP = join(box, 'tmp')
const PROJ = join(box, 'project')
for (const d of [join(HOME, '.claude'), TMP, PROJ]) mkdirSync(d, { recursive: true })

const { handoffPathFor, planAutoClear } = await import(pathToFileURL(HOOK).href)

/** One assistant row of the shape `latestContext` reads. */
const row = (tokens) =>
  JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: tokens } } }) + '\n'

const transcript = join(box, 'transcript.jsonl')
const logPath = join(HOME, '.claude', 'autoclear.log')

// The pane id every hook run in this suite claims to sit in. It matches no pane in any
// PaneForge, so `pane-clear.mjs` exits 1 with `no pane "..."` and can never reach a real
// one - the hook half of this suite is safe to run beside a live desk.
const PANE = 'pf-autoclear-lag-test'

function runHook({ session, tokens, stopHookActive = false }) {
  writeFileSync(transcript, row(tokens))
  const r = spawnSync(
    process.execPath,
    [HOOK],
    {
      input: JSON.stringify({
        cwd: PROJ,
        transcript_path: transcript,
        session_id: session,
        stop_hook_active: stopHookActive
      }),
      encoding: 'utf8',
      env: { ...process.env, HOME, TMPDIR: TMP, PF_PANE: PANE, AUTOCLEAR: '' }
    }
  )
  return { status: r.status, stderr: r.stderr ?? '' }
}

const logText = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')

// The hook resolves this from the CHILD's HOME and PF_PANE, so the fixture is written
// where the child will look for it, never where this process would.
const handoffPath = () => handoffPathFor(PROJ, HOME, { PF_PANE: PANE })

function writeHandoff(steps) {
  const p = handoffPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `# Handoff\n\n## Next steps\n${steps}\n`, 'utf8')
  return p
}

console.log('autoclear under lag')

// 1. A session that ARRIVED over the line is never cleared. Clearing it produces the same
//    session one cache later, which is the 06:36/06:39/07:00/07:03 loop.
{
  writeHandoff('1. Something genuinely open, in this repo, that a fresh session could start.')
  const first = runHook({ session: 'lag-baseline', tokens: 157_356 })
  ok('a session already over the line at its FIRST Stop does not clear', first.status === 0 && /baseline_over/.test(logText()))
  const again = runHook({ session: 'lag-baseline', tokens: 190_000 })
  ok('and it stays refused as it grows', again.status === 0 && (logText().match(/baseline_over/g) ?? []).length >= 2)
}

// 2. The ordinary path still works: small first Stop, growth, block, then clear.
let clearedAt = 0
{
  rmSync(logPath, { force: true })
  const small = runHook({ session: 'lag-normal', tokens: 20_000 })
  ok('a small session is silent', small.status === 0 && logText() === '')

  rmSync(handoffPath(), { force: true })
  const blocked = runHook({ session: 'lag-normal', tokens: 200_000 })
  ok('over the line with no handoff blocks the turn', blocked.status === 2, `status ${blocked.status}`)
  ok('and the block says what to write', /AUTO-CLEAR/.test(blocked.stderr))

  writeHandoff('1. A step a fresh session can start.')
  const cleared = runHook({ session: 'lag-normal', tokens: 200_000 })
  clearedAt = Date.now()
  ok('a fresh handoff with open steps clears', cleared.status === 0 && /^\S+ clear tokens=/m.test(logText()))
}

// 3. ...and the SAME PANE may not clear again straight away, whatever session id asks.
//    This is the half a session-keyed state file can never hold: `/clear` mints a new id.
{
  const before = (logText().match(/ clear tokens=/g) ?? []).length
  // The fresh session the clear produced, doing it properly: a small first Stop (so the
  // baseline refusal is not what answers here) and then growth past the line.
  runHook({ session: 'lag-fresh-session-after-clear', tokens: 20_000 })
  const soon = runHook({ session: 'lag-fresh-session-after-clear', tokens: 200_000 })
  const after = (logText().match(/ clear tokens=/g) ?? []).length
  ok('a second clear in the same pane is refused', soon.status === 0 && after === before, `${before} -> ${after}`)
  ok('and the refusal names the cooldown', /pane_cooldown|too_soon_after_clear/.test(logText()))
  ok('the cooldown was decided in under a second of real time', Date.now() - clearedAt < 15 * 60_000)
}

// 4. The turn count, past the fifteen minutes. A fresh session that has taken one turn has
//    not yet done the work the clear was for.
{
  const handoff = { exists: true, mtimeMs: Date.now(), text: '## Next steps\n1. Open work.\n' }
  const old = Date.now() - 20 * 60_000
  const p = (stops) =>
    planAutoClear({
      tokens: 200_000,
      handoff,
      nowMs: Date.now(),
      baseline: 20_000,
      pane: { lastClear: old, stops }
    })
  ok('one turn since the clear is too soon', p(1).reason === 'too_soon_after_clear')
  ok('two turns is still too soon', p(2).reason === 'too_soon_after_clear')
  ok('three turns clears', p(3).action === 'clear')
  ok('a pane that never cleared is unaffected', planAutoClear({ tokens: 200_000, handoff, nowMs: Date.now(), baseline: 20_000, pane: {} }).action === 'clear')
}

rmSync(box, { recursive: true, force: true })

/* ------------------------------------------------------------------- the app half */

// The shared decision, driven directly: a pane that is still PRINTING is not finished,
// whatever `runSince` says. This is the reading the fire path was missing.
const { buildSync } = await import('esbuild')
const shimDir = mkdtempSync(join(tmpdir(), 'pf-aclag-build-'))
const shim = join(shimDir, 'shared.js')
buildSync({
  entryPoints: [join(root, 'src', 'shared', 'autoclear.ts')],
  outfile: shim,
  format: 'esm',
  bundle: true,
  platform: 'node'
})
const { expiryDecision, ARM_QUIET_MS } = await import(pathToFileURL(shim).href)
{
  const base = { exists: true, metaAt: 1, armedAt: 1, now: 1, drop: null }
  ok('a quiet pane still fires', expiryDecision({ ...base, quietMs: ARM_QUIET_MS + 1 }) === 'fire')
  ok('a pane that printed a moment ago holds the countdown', expiryDecision({ ...base, quietMs: 500 }) === 'settling')
  ok('a caller that cannot measure quiet is unchanged', expiryDecision(base) === 'fire')
  ok('a real drop still wins over the quiet reading', expiryDecision({ ...base, drop: 'asked', quietMs: 500 }) === 'asked')
}
rmSync(shimDir, { recursive: true, force: true })

// ...and the same thing in a real window: a countdown armed over a pane that is printing
// must not put a single byte into it.
let link
try {
  link = await connect()
} catch (e) {
  if (e instanceof SkipError) {
    console.log(`\n  skipped the driven half: ${e.message}`)
    console.log(`\n${checks} checks, ${failures} failed`)
    process.exit(failures ? 1 : 0)
  }
  throw e
}

const evalIn = (expr) => link.evaluate(`(async () => { ${expr} })()`)

// The app's own record. The SCREEN cannot answer this question: `/clear` wipes it, so a
// pane that was wrongly cleared looks exactly like one that was left alone. Every branch of
// the fire path writes a named line here instead.
const appLog = () => {
  const dir =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'claude-orchestrator-dev')
      : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'claude-orchestrator-dev')
  const f = join(dir, 'autoclear-app.log')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

try {
  const cwd = root
  const mark = appLog().length
  // An AGENT pane, because a shell pane has no clear command at all (`clearCommandFor` ->
  // null, "nothing here knows how to clear that pane") and can never exercise this path.
  // Nothing is ever typed at it: the CLI is left at its composer, so the pane costs one
  // boot and no conversation.
  const id = await evalIn(`
    const s = await window.api.startSession({ cwd: ${JSON.stringify(cwd)}, agent: 'claude' })
    return s?.id ?? s
  `)
  ok('an agent pane opened for the drive', typeof id === 'string' && id.length > 0, JSON.stringify(id))
  if (typeof id !== 'string') throw new Error('no pane')

  // Let the CLI boot and go quiet, or the ARM path holds the ask and there is no countdown
  // to test. That hold is old behaviour and is not what this drive is about.
  await new Promise((r) => setTimeout(r, 14_000))
  const armed = await evalIn(`
    return await window.api.askAutoClear({
      paneId: ${JSON.stringify(id)},
      seconds: 5,
      prompt: 'Continue the handoff: work its Next steps in order.',
      steps: ['a step'],
      tokens: 200000
    })
  `)
  ok('the countdown was accepted on a quiet pane', armed?.ok === true, JSON.stringify(armed))

  // ...and now the pane starts PRINTING again, with no turn and no draft behind it: a
  // resize makes the CLI repaint. This is the state a stale busy footer leaves behind under
  // load, and it is the state the clear was fired into at 07:03:44.
  const repaint = async () => {
    const size = await evalIn(`
      const t = window.__pf?.[${JSON.stringify(id)}]?.term
      return t ? { cols: t.cols, rows: t.rows } : null
    `)
    if (!size) return
    await evalIn(`window.api.resize(${JSON.stringify(id)}, ${'${'}0${'}'})`)
  }
  void repaint
  const wobble = setInterval(() => {
    void evalIn(`
      const t = window.__pf?.[${JSON.stringify(id)}]?.term
      if (!t) return
      window.api.resize(${JSON.stringify(id)}, t.cols - (t.cols % 2 ? 1 : 0) - (Date.now() % 2), t.rows)
    `).catch(() => {})
  }, 700)
  await new Promise((r) => setTimeout(r, 9000))
  clearInterval(wobble)

  const fresh = appLog().slice(mark)
  const mine = fresh
    .split('\n')
    .filter((l) => l.includes(id))
    .join('\n')
  ok('the countdown really armed', /armed: fires at/.test(mine), mine.slice(-300))
  ok('nothing was typed into the still-printing pane', !/typing "\/clear/.test(mine), mine.slice(-400))
  ok('and the app said why it held off', /may not be finished/.test(mine), mine.slice(-400))

  await evalIn(`window.api.killSession(${JSON.stringify(id)})`)
} finally {
  try {
    link.ws.close()
  } catch {
    /* the window may already be gone */
  }
}

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
