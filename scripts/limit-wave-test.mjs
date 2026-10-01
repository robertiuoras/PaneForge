#!/usr/bin/env node
// Pins `src/shared/limitWave.ts` + `src/main/limitWaves.ts`: a usage-limit stop is not a
// Telegram message, it is one wave per reset, continued after the reset and reported to the
// phone ONCE with the count that really carried on. `npm run test:limitwave`.
//
// Wording below is the CLIs' own, from this desk's pane history (2026-10-01).
import { buildSync } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-limitwave-'))
for (const [entry, out] of [['src/main/limitWaves.ts', 'limitWaves.cjs'], ['src/shared/limitWave.ts', 'limitWave.cjs'], ['src/shared/paneError.ts', 'paneError.cjs']]) {
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: join(work, out), logLevel: 'error' })
}
const req = createRequire(join(work, 'x.cjs'))
const M = req('./limitWaves.cjs')
const W = req('./limitWave.cjs')
const E = req('./paneError.cjs')

let failed = 0
let passed = 0
function ok(name, cond, detail) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL ${name}${detail === undefined ? '' : `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}
const iso = (t) => (typeof t === 'number' ? new Date(t).toISOString() : String(t))
const BNE = 'Australia/Brisbane'
const MIN = 60_000
// 9:39pm Thu 1 Oct 2026 on the Gold Coast (UTC+10).
const NOW = Date.UTC(2026, 9, 1, 11, 39)

// ---- reading the reset off the stop ------------------------------------------------------
{
  const s = W.limitStopOf("⎿  You've hit your session limit · resets 9:40pm (Australia/Brisbane)", NOW, BNE)
  ok('claude session: provider/window', s?.provider === 'claude' && s?.window === 'session', s)
  ok('claude session: reset 9:40pm AEST', s?.resetAt === Date.UTC(2026, 9, 1, 11, 40), iso(s?.resetAt))
  const q = W.limitStopOf("You'vehityoursessionlimit·resets9:40pm(Australia/Brisbane)", NOW, BNE)
  ok('claude session: spaces stripped by cursor moves', q?.resetAt === Date.UTC(2026, 9, 1, 11, 40), iso(q?.resetAt))
  const late = W.limitStopOf("You've hit your session limit · resets 9:40pm (Australia/Brisbane)", NOW + 3 * MIN, BNE)
  ok('read 2 min after the reset = due now, not tomorrow', late?.resetAt === Date.UTC(2026, 9, 1, 11, 40), iso(late?.resetAt))
  const night = W.limitStopOf("You've hit your session limit · resets 1:50am (Australia/Brisbane)", Date.UTC(2026, 9, 1, 13, 0), BNE)
  ok('session reset past midnight rolls to tomorrow', night?.resetAt === Date.UTC(2026, 9, 1, 15, 50), iso(night?.resetAt))
  const wk = W.limitStopOf("You've hit your weekly limit · resets Oct 1 at 3pm (Australia/Brisbane)", Date.UTC(2026, 8, 28, 0, 0), BNE)
  ok('claude weekly "Oct 1 at 3pm" (the "at" ai-accounts.mjs misses)', wk?.window === 'weekly' && wk?.resetAt === Date.UTC(2026, 9, 1, 5, 0), wk && iso(wk.resetAt))
  const wk2 = W.limitStopOf("You've hit your weekly limit · resets Oct 1, 11am (Australia/Brisbane)", Date.UTC(2026, 8, 30, 0, 0), BNE)
  ok('claude weekly "Oct 1, 11am"', wk2?.resetAt === Date.UTC(2026, 9, 1, 1, 0), wk2 && iso(wk2.resetAt))
  ok('a session line whose reset already went is stale (a --resume repaint)',
    W.limitStopOf("You've hit your session limit · resets 4:40pm (Australia/Brisbane)", NOW, BNE) === 'stale')
  ok('a weekly line from last week is stale',
    W.limitStopOf("You've hit your weekly limit · resets Sep 24 at 3pm (Australia/Brisbane)", NOW, BNE) === 'stale')
  const codexText = "■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or\ntry again at Oct 6th, 20266:53 PM.\n"
  const cx = W.limitStopOf(codexText, NOW, BNE)
  ok('codex wrapped date, year glued to the hour', cx?.provider === 'codex' && cx?.resetAt === Date.UTC(2026, 9, 6, 8, 53), cx && iso(cx.resetAt))
  ok('codex date already gone is stale',
    W.limitStopOf("You've hit your usage limit. try again at Sep 26th, 2026 8:27 PM.", NOW, BNE) === 'stale')
  ok('claude: a "resets" on a LATER row is prose, not the reset',
    W.limitStopOf("You've hit your session limit\nthe cron resets 2am (Australia/Brisbane)", NOW, BNE) === null)
  ok('whyUnsent gone', W.whyUnsent('gone') === 'it was closed before the message went in')
  for (const line of ['API Error: 401 Invalid API key · Please run /login', 'Credit balance is too low', "You've hit your session limit",
    "You've hit your session limit · resets 9:40pm (Mars/Olympus_Mons)"]) {
    ok(`not a limit with a reset: ${line}`, W.limitStopOf(line, NOW, BNE) === null, W.limitStopOf(line, NOW, BNE))
  }
}

// ---- the stop line as the sweep finds it, then its reset ---------------------------------
{
  const painted = "some reply text\n■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or\ntry again at Oct 6th, 2026 6:53 PM.\n\n  2 background terminals running · /ps to view\n› \n"
  const line = E.stoppedLine(painted)
  ok('paneError finds the codex stop row', !!line && line.startsWith('■ You'), line)
  const stop = W.limitStopOf(M.stopText(line ?? '', painted), NOW, BNE)
  ok('...and the row below it carries the date', stop?.resetAt === Date.UTC(2026, 9, 6, 8, 53), stop)
}

// ---- grouping ----------------------------------------------------------------------------
{
  const waves = new W.LimitWaves()
  const at = (h, m) => Date.UTC(2026, 9, 1, h, m)
  waves.noteStop('a', 'A', { provider: 'claude', window: 'session', resetAt: at(11, 40) }, NOW)
  waves.noteStop('b', 'B', { provider: 'claude', window: 'session', resetAt: at(11, 41) }, NOW)
  waves.noteStop('c', 'C', { provider: 'claude', window: 'session', resetAt: at(11, 38) + 30_000 }, NOW)
  waves.noteStop('d', 'D', { provider: 'claude', window: 'session', resetAt: at(11, 45) }, NOW)
  waves.noteStop('e', 'E', { provider: 'codex', resetAt: at(11, 40) }, NOW)
  ok('jitter of 1-2 min is one wave; 5 min apart is another; codex is its own',
    waves.waves.length === 3 && waves.waves[0].panes.map((p) => p.id).join() === 'a,b,c', waves.waves.map((w) => w.panes.map((p) => p.id)))
  waves.noteStop('a', 'A', { provider: 'claude', window: 'session', resetAt: at(11, 45) }, NOW + MIN)
  ok('a waiting pane stopping again moves to the new reset',
    waves.waves[0].panes.map((p) => p.id).join() === 'b,c' && waves.waves[1].panes.map((p) => p.id).join() === 'd,a')
}

// ---- settling ------------------------------------------------------------------------------
const RESET = Date.UTC(2026, 9, 1, 11, 40)
const DUE = RESET + W.CONTINUE_AFTER_MS.claude
const stop = { provider: 'claude', window: 'session', resetAt: RESET }
const fresh = (over = {}) => ({ busy: false, turns: 5, drafting: false, ended: false, movedOn: false, ...over })
{
  const waves = new W.LimitWaves()
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) waves.noteStop(id, id.toUpperCase(), stop, NOW, 5)
  const desk = { p1: fresh(), p2: fresh(), p3: fresh(), p4: fresh(), p5: fresh(), p6: fresh(), p7: fresh() }
  const look = (id) => desk[id]
  let s = waves.step(RESET + 60_000, look)
  ok('nothing typed before claude has had its own chance (150 s)', s.prompt.length === 0 && s.push.length === 0, s)
  desk.p2 = fresh({ busy: true }) // Claude continued it by itself
  desk.p3 = fresh({ drafting: true })
  delete desk.p4 // closed
  desk.p5 = fresh({ ended: true })
  desk.p6 = fresh({ turns: 6 }) // ran a turn since the stop and finished it
  desk.p7 = fresh({ movedOn: true })
  s = waves.step(DUE, look)
  ok('only the idle pane still on the stop is asked', s.prompt.join() === 'p1', s.prompt)
  const w = waves.waves[0]
  const st = (id) => w.panes.find((p) => p.id === id)?.state
  ok('closed pane leaves the count', w.panes.length === 6 && !w.panes.some((p) => p.id === 'p4'))
  ok('busy / ran again / moved on = continuing, nothing typed',
    st('p2') === 'continuing' && st('p6') === 'continuing' && st('p7') === 'continuing', w.panes)
  ok('drafting and ended are not continuing', st('p3') === 'not' && st('p5') === 'not')
  waves.promptSettled('p1', true, false, DUE + 20_000)
  ok('submitted is not yet continuing', st('p1') === 'submitted')
  s = waves.step(DUE + 25_000, look)
  ok('no push while a pane is undecided', s.push.length === 0)
  desk.p1 = fresh({ busy: true })
  s = waves.step(DUE + 30_000, look)
  ok('submitted + working = continuing', st('p1') === 'continuing')
  ok('no push inside the quiet minute (a quick second limit must be counted)', s.push.length === 0)
  s = waves.step(DUE + 30_000 + W.SETTLE_QUIET_MS, look)
  ok('one push once settled and quiet', s.push.length === 1)
  const body = W.waveBody(s.push[0], (id) => ({ number: { p3: 3, p5: 7 }[id] ?? 0, title: id === 'p3' ? 'PaneForge config' : 'Car sheet' }))
  ok('body: count, then each one not continuing with why', body ===
    '4/6 chats continuing. Not continuing: Chat 3 (PaneForge config) - something was typed in its box, so it was left alone; Chat 7 (Car sheet) - the chat in it had ended', body)
  waves.pushed(s.push[0], false, DUE + 100_000)
  ok('failed push kept, not retried at once', waves.waves.length === 1 && waves.step(DUE + 110_000, look).push.length === 0)
  ok('...and retried later', waves.step(DUE + 100_000 + W.PUSH_RETRY_MS, look).push.length === 1)
  waves.pushed(waves.waves[0], true, DUE + 300_000)
  ok('sent = forgotten', waves.waves.length === 0 && waves.step(DUE + 400_000, look).push.length === 0)
}
{
  // LOST, a slow start, a second limit, the deadline, and the switch off.
  const waves = new W.LimitWaves()
  for (const id of ['lost', 'slow', 'relimit', 'stuck']) waves.noteStop(id, id, stop, NOW, 0)
  const desk = { lost: fresh({ turns: 0 }), slow: fresh({ turns: 0 }), relimit: fresh({ turns: 0 }), stuck: fresh({ turns: 0 }) }
  const look = (id) => desk[id]
  const s = waves.step(DUE, look)
  ok('four asked', s.prompt.length === 4)
  const w = waves.waves[0]
  const p = (id) => w.panes.find((x) => x.id === id)
  waves.promptSettled('lost', false, false, DUE + 10_000, W.whyUnsent('unsent'))
  ok('LOST prompt = not continuing', p('lost').state === 'not' && p('lost').why === 'the message was typed but never went in', p('lost'))
  waves.promptSettled('slow', true, false, DUE + 10_000)
  waves.promptSettled('relimit', true, true, DUE + 10_000)
  ok('sent while busy = continuing straight away', p('relimit').state === 'continuing')
  waves.noteStop('relimit', 'relimit', stop, DUE + 40_000, 1)
  ok('limit again after continuing = not, and no second wave for the same reset',
    p('relimit').state === 'not' && p('relimit').why === 'it hit the limit again' && waves.waves.length === 1, waves.waves)
  waves.step(DUE + 10_000 + W.START_WITHIN_MS - 1, look)
  ok('submitted waits START_WITHIN_MS', p('slow').state === 'submitted')
  waves.step(DUE + 10_000 + W.START_WITHIN_MS, look)
  ok('submitted, never worked = not', p('slow').state === 'not' && /did not start working/.test(p('slow').why))
  const last = waves.step(DUE + W.WAVE_DEADLINE_MS, look)
  ok('deadline settles the one still waiting to go in', p('stuck').state === 'not' && p('stuck').why === 'the message was still waiting to go in', p('stuck'))
  ok('deadline pushes without the quiet minute', last.push.length === 1)
  ok('nobody continuing reads 0/4', W.waveBody(w, () => undefined).startsWith('0/4 chats continuing. Not continuing: lost - '), W.waveBody(w, () => undefined))
}
{
  const waves = new W.LimitWaves()
  waves.noteStop('x', 'x', stop, NOW)
  waves.promptSettled('x', true, true, NOW) // not asked yet: ignored
  const s = waves.step(DUE, () => fresh({ turns: 0 }), false)
  ok('automatic continue off: nothing typed, said so', s.prompt.length === 0 && waves.waves[0].panes[0].why === 'automatic continue is switched off')
  waves.noteStop('y', 'y', { ...stop, window: 'weekly', resetAt: RESET + 3 * 86_400_000 }, NOW)
  waves.noteStop('later', 'later', stop, NOW)
  const w2 = new W.LimitWaves()
  w2.noteStop('gone', 'gone', stop, NOW)
  ok('every pane closed = no wave, no push', w2.step(DUE, () => undefined).push.length === 0 && w2.waves.length === 0)
  const w3 = new W.LimitWaves()
  w3.noteStop('z', 'z', stop, NOW, 0)
  w3.step(DUE, () => fresh({ turns: 0 }))
  w3.promptSettled('z', true, true, DUE + 1000)
  w3.noteStop('z', 'z', { provider: 'claude', window: 'weekly', resetAt: RESET + 2 * 86_400_000 }, DUE + 5000, 1)
  ok('a later (weekly) limit behind the 5h one: not in this wave, queued in a new one',
    w3.waves.length === 2 && w3.waves[0].panes[0].state === 'not' && w3.waves[1].panes[0].state === 'waiting', w3.waves)
}

// ---- words -----------------------------------------------------------------------------------
{
  ok('title 5h', W.waveTitle({ provider: 'claude', window: 'session' }) === 'Claude 5h limit reset')
  ok('title weekly', W.waveTitle({ provider: 'claude', window: 'weekly' }) === 'Claude weekly limit reset')
  ok('title codex', W.waveTitle({ provider: 'codex' }) === 'Codex limit reset')
  const all = { provider: 'claude', resetAt: RESET, panes: Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, title: '', stoppedAt: 0, turns: 0, state: 'continuing', at: 0 })) }
  ok('10/10 chats continuing', W.waveBody(all, () => undefined) === '10/10 chats continuing')
  ok('1/1 chat continuing', W.waveBody({ ...all, panes: all.panes.slice(0, 1) }, () => undefined) === '1/1 chat continuing')
  const many = { ...all, panes: Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, title: 'A long pane title that goes on for a while', stoppedAt: 0, turns: 0, state: 'not', why: 'it hit the limit again', at: 0 })) }
  const b = W.waveBody(many, (id) => ({ number: Number(id) + 1, title: '' }))
  ok('long list clipped to 500 with the rest counted', b.length <= 500 && /and \d+ more$/.test(b), `${b.length}: ${b.slice(-60)}`)
  ok('dedupe key', W.waveKey({ provider: 'claude', resetAt: RESET }, 'mac') === 'pf-limit-reset:claude:2026-10-01T11:40:00.000Z:mac')
  const pl = W.pushPayload('t'.repeat(200), 'b', 'k')
  ok('payload shape', pl.title.length === 140 && pl.kind === 'agent' && pl.category === 'agents' && pl.source === 'paneforge' && pl.priority === 'normal' && pl.dedupe_key === 'k', pl)
}

// ---- token and post ------------------------------------------------------------------------
{
  const home = mkdtempSync(join(tmpdir(), 'pf-limitwave-home-'))
  ok('no env, no file = no token', M.ingestToken({}, home) === null)
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'todos-ingest.token'), '"tok-from-file"\n')
  ok('file fallback, quotes and newline stripped', M.ingestToken({}, home) === 'tok-from-file')
  ok('env wins over the file', M.ingestToken({ TASKDRIVER_INGEST_TOKEN: ' tok-env ' }, home) === 'tok-env')
  const calls = []
  const fake = (status) => async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status } }
  const payload = W.pushPayload('Claude 5h limit reset', '10/10 chats continuing', 'k1')
  const sent = await M.postPush(payload, { env: {}, home, fetchImpl: fake(200) })
  ok('post ok', sent === true && calls.length === 1)
  ok('default URL', calls[0]?.url === M.NOTIFY_URL && M.NOTIFY_URL === 'https://app.taskdriver.ai/api/app/admin/notify')
  ok('bearer from the file', calls[0]?.init.headers.Authorization === 'Bearer tok-from-file')
  ok('body is the payload', calls[0]?.init.body === JSON.stringify(payload))
  await M.postPush(payload, { env: { PF_TASKDRIVER_NOTIFY_URL: 'http://127.0.0.1:1/x' }, home, fetchImpl: fake(200) })
  ok('test override URL', calls[1]?.url === 'http://127.0.0.1:1/x')
  ok('500 = false', (await M.postPush(payload, { env: {}, home, fetchImpl: fake(500) })) === false)
  ok('throw = false', (await M.postPush(payload, { env: {}, home, fetchImpl: async () => { throw new Error('offline') } })) === false)
  const before = calls.length
  ok('no token = false, nothing sent', (await M.postPush(payload, { env: {}, home: join(home, 'nope'), fetchImpl: fake(200) })) === false && calls.length === before)
}

// ---- the runner: routing, continue, one push ------------------------------------------------
{
  let t = NOW
  const desk = [
    { id: 's1', title: 'Phone link', status: 'idle', turnsHere: 3 },
    { id: 's2', title: 'Car sheet', status: 'exited', asleep: NOW - 3_600_000, turnsHere: 1 },
    { id: 's3', title: 'Lane h', status: 'idle', turnsHere: 2 }
  ]
  const typed = []
  const posts = []
  const runner = M.startLimitWaves({
    list: () => desk,
    label: (id) => ({ number: desk.findIndex((s) => s.id === id) + 1, title: desk.find((s) => s.id === id)?.title ?? '' }),
    movedOn: () => false,
    mayPrompt: () => true,
    carryOn: (id, text, done) => typed.push({ id, text, done }),
    post: async (p) => { posts.push(p); return true },
    host: 'mac',
    log: () => {},
    now: () => t
  }, { timer: false })
  const limit = "⎿  You've hit your session limit · resets 9:40pm (Australia/Brisbane)"
  ok('limit stop is the wave\'s (Telegram NOT called)', runner.stopped(desk[0], limit, `x\n${limit}\n❯ `) === true)
  runner.stopped(desk[1], limit)
  runner.stopped(desk[2], limit)
  ok('auth stop is not (Telegram still called)', runner.stopped(desk[0], 'API Error: 401 Invalid API key · Please run /login') === false)
  ok('credit stop is not', runner.stopped(desk[0], 'Credit balance is too low') === false)
  ok('a reset that has already been (a woken pane repainting) is no wave either',
    runner.stopped(desk[0], "You've hit your session limit · resets 9:38pm (Australia/Brisbane)") === true && runner.waves.waves.length === 1)
  ok('stale limit: no Telegram and no wave', runner.stopped(desk[0], "You've hit your session limit · resets 4:40pm (Australia/Brisbane)") === true && runner.waves.waves.length === 1)
  t = DUE - 1000
  runner.tick()
  ok('nothing before due', typed.length === 0)
  desk[2] = { ...desk[2], status: 'working', runSince: DUE - 5000 } // Claude carried on by itself
  t = DUE
  runner.tick()
  ok('continue typed into the idle and the asleep pane, not the working one', typed.map((x) => x.id).sort().join() === 's1,s2' && typed.every((x) => x.text === W.CONTINUE_TEXT), typed.map((x) => x.id))
  desk[0] = { ...desk[0], status: 'working', runSince: t }
  typed.find((x) => x.id === 's1').done('sent')
  t += 20_000
  typed.find((x) => x.id === 's2').done('unsent')
  for (let i = 0; i < 30; i++) { t += 5_000; runner.tick() }
  await new Promise((r) => setTimeout(r, 10))
  ok('exactly one push', posts.length === 1, posts)
  ok('push title', posts[0]?.title === 'Claude 5h limit reset')
  ok('push body', posts[0]?.body === '2/3 chats continuing. Not continuing: Chat 2 (Car sheet) - the message was typed but never went in', posts[0]?.body)
  ok('push key', posts[0]?.dedupe_key === 'pf-limit-reset:claude:2026-10-01T11:40:00.000Z:mac')
  for (let i = 0; i < 30; i++) { t += 60_000; runner.tick() }
  await new Promise((r) => setTimeout(r, 10))
  ok('never a second push', posts.length === 1)
  runner.stop()
}

console.log(`limit-wave: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
