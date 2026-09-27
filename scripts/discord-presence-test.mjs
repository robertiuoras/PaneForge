// Discord Rich Presence, without Discord.
//
// The pure half (frame codec, what the presence says) plus the whole client run
// against a fake Discord served over a REAL named pipe, because the two bugs worth
// pinning are invisible in a unit test of functions: a frame split across data
// events being decoded early (the device link's own launch bug, relearned), and a
// socket error nobody handles taking the main process down with it (the tee's).
//
//   node scripts/discord-presence-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-discord-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outShared = join(work, 'rpc.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/discordRpc.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: outShared
})
const outMain = join(work, 'presence.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/discordPresence.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: outMain
})
const req = createRequire(import.meta.url)
const {
  FrameStream,
  encodeFrame,
  buildActivity,
  buildButtons,
  chosenRows,
  migrateRows,
  needsTokens,
  togglePhrase,
  TOKEN_PHRASES,
  PRESET_ROWS,
  DEFAULT_DISCORD_STYLE,
  DEFAULT_ROWS,
  MAX_BUTTONS,
  VISIBLE_ROWS,
  DEFAULT_LINK_LABEL,
  DEFAULT_LINK_URL,
  DISCORD_APP_ID,
  OP_HANDSHAKE,
  OP_FRAME,
  countPresence,
  folderName,
  readDeskReport,
  readStyle,
  newerSettings,
  withLook,
  DISCORD_PRESETS,
  wholeDesk
} =
  req(outShared)
const { DiscordPresence } = req(outMain)
// The card every profile had before the ready-made looks: numbers, then project names.
// What the row engine below is exercised with, since those are the rows it was built on.
const CLASSIC = { ...DEFAULT_DISCORD_STYLE, preset: 'custom', rows: DEFAULT_ROWS }

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failed++
}

// ---------- frame codec: every split point must reassemble identically ----------
{
  const frames = [
    encodeFrame(OP_HANDSHAKE, { v: 1, client_id: 'x' }),
    encodeFrame(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: 1 } }),
    encodeFrame(OP_FRAME, { evt: 'READY', data: { user: { username: 'u' } } })
  ]
  const whole = Buffer.concat(frames)
  let allGood = true
  for (let cut = 1; cut < whole.length; cut++) {
    const s = new FrameStream()
    const got = [...s.push(whole.subarray(0, cut)), ...s.push(whole.subarray(cut))]
    if (got.length !== 3 || got[2].payload.evt !== 'READY' || got[0].op !== OP_HANDSHAKE) {
      allGood = false
      break
    }
  }
  check('codec: reassembly identical at every split point', allGood)
  const s = new FrameStream()
  const byByte = []
  for (const b of whole) byByte.push(...s.push(Buffer.from([b])))
  check('codec: one byte at a time still yields 3 frames', byByte.length === 3)
}

// ---------- what the presence says ----------
{
  const base = { appStart: 1000 }
  check('activity: empty desk is a clear, not "0/0"', buildActivity({ running: 0, total: 0, names: [], ...base }) === null)
  const busy = buildActivity({ running: 3, total: 6, names: ['PaneForge', 'Toolstash'], oldestRunSince: 500, ...base }, CLASSIC)
  check('activity: 3/6 sessions running', busy.details === '3/6 sessions running', busy.details)
  check('activity: names on the second line', busy.state === 'on PaneForge, Toolstash', busy.state)
  check('activity: elapsed anchors on the oldest running turn', busy.timestamps.start === 500)
  const idle = buildActivity({ running: 0, total: 2, names: [], ...base }, CLASSIC)
  check('activity: idle desk says idle', idle.details === '2 sessions idle', idle.details)
  check('activity: idle elapsed anchors on app start', idle.timestamps.start === 1000)
  // The mark is the one part of the card that is not a preference: an application's
  // icon names the header, so without `assets` Discord draws no artwork at all.
  check('activity: the card carries the PaneForge mark', busy.assets?.large_image === 'icon', JSON.stringify(busy.assets))
  check('activity: the mark is on the idle card too', idle.assets?.large_image === 'icon', JSON.stringify(idle.assets))
  const one = buildActivity({ running: 1, total: 1, names: ['x'], ...base }, CLASSIC)
  check('activity: singular noun', one.details === '1/1 session running', one.details)
  // The Discord tab builds lines from buttons: a chip adds its phrase, a second press takes it out.
  check('chips: add to an empty line with no separator', togglePhrase('', '{tokens} tokens today') === '{tokens} tokens today')
  check('chips: add after existing text', togglePhrase('{running} running', 'on {projects}') === '{running} running · on {projects}')
  check('chips: second press removes it', togglePhrase('{running} running · on {projects}', 'on {projects}') === '{running} running')
  check('chips: every token has a plain-word button', TOKEN_PHRASES.every((t) => t.label && !/[{}]/.test(t.label) && t.phrase.includes(t.token)))
  check('presets: every ready-made line fills in', PRESET_ROWS.every((r) => buildActivity({ running: 1, total: 2, asleep: 1, names: ['x'], tokensToday: 1200, tokensWeek: 9000, ...base }, { ...DEFAULT_DISCORD_STYLE, rows: [{ id: 'p', text: r.text, when: 'always', on: true }] })?.details && !/[{}]/.test(buildActivity({ running: 1, total: 2, asleep: 1, names: ['x'], tokensToday: 1200, tokensWeek: 9000, ...base }, { ...DEFAULT_DISCORD_STYLE, rows: [{ id: 'p', text: r.text, when: 'always', on: true }] }).details)))
  // 2026-09-23: the PC's desk of one pane put "1/1 session running" on the profile over the
  // Mac's 7/15. A desk whose panes another connected desk already counts sends a clear.
  check('activity: a desk counted by another desk says nothing',
    buildActivity({ running: 1, total: 1, names: ['x'], ...base, countedBy: 'MacBook' }) === null)
  const many = buildActivity({
    running: 9,
    total: 9,
    names: [...Array(30)].map((_, i) => `some-quite-long-project-name-${i}`),
    ...base
  }, CLASSIC)
  check('activity: name list capped under Discord\'s 128', many.state.length <= 128, String(many.state.length))
  check('activity: capped list says how many were dropped', / \+\d+ more$/.test(many.state), many.state)
}

// ---------- the Discord tab's knobs ----------
{
  const base = { appStart: 1000 }
  const desk = { running: 2, total: 5, names: ['PaneForge', 'Toolstash'], oldestRunSince: 500, ...base }
  const style = (over) => ({ ...DEFAULT_DISCORD_STYLE, ...over })

  // The default card is counts only: a profile is public, so project names are a look
  // somebody picks (Robert, 2026-09-27).
  const plain = buildActivity(desk)
  check('looks: the default card is the numbers and nothing else',
    plain.details === '2 running · 3 idle' && plain.state === undefined,
    JSON.stringify([plain.details, plain.state]))
  const look = (preset, idle, tokens) => withLook(DEFAULT_DISCORD_STYLE, { preset, idle, tokens })
  const card = (c, st) => {
    const a = buildActivity(c, st)
    return a ? [a.details, a.state].filter(Boolean).join(' | ') : null
  }
  const quietDesk = { running: 0, total: 5, names: [], ...base }
  const expect = [
    ['counts', true, false, '2 running · 3 idle', '5 sessions idle'],
    ['counts', false, false, '2 running', '5 sessions open'],
    ['fraction', true, false, '2/5 sessions running · 3 idle', '5 sessions idle'],
    ['fraction', false, false, '2/5 sessions running', '5 sessions open'],
    ['projects', true, false, '2 running · 3 idle | on PaneForge, Toolstash', '5 sessions idle'],
    ['counts', true, true, '2 running · 3 idle | 1.5M tokens today', '5 sessions idle | 1.5M tokens today'],
    ['projects', false, true, '2 running | on PaneForge, Toolstash · 1.5M tokens today', '5 sessions open | 1.5M tokens today']
  ]
  for (const [preset, idle, tokens, busyCard, quietCard] of expect) {
    const st = look(preset, idle, tokens)
    const got = [card({ ...desk, tokensToday: 1_480_000 }, st), card({ ...quietDesk, tokensToday: 1_480_000 }, st)]
    check(`looks: ${preset}${idle ? ' +idle' : ''}${tokens ? ' +tokens' : ''} reads as intended`,
      got[0] === busyCard && got[1] === quietCard, JSON.stringify(got))
  }
  check('looks: every look is counts only unless it says it names projects',
    DISCORD_PRESETS.filter((p) => p.id !== 'projects').every((p) => !card(desk, look(p.id, true, true)).includes('PaneForge')))
  check('looks: the tokens switch is the only thing that asks for the disk walk',
    DISCORD_PRESETS.every((p) => !needsTokens(look(p.id, true, false)) && needsTokens(look(p.id, true, true))))
  const handWritten = { ...DEFAULT_DISCORD_STYLE, preset: 'custom', rows: [{ id: 'x', text: 'mine', when: 'always', on: true }] }
  check('looks: a hand-written card keeps its lines when a switch moves',
    withLook(handWritten, { idle: false }).rows[0].text === 'mine')
  check('looks: picking a look replaces hand-written lines',
    withLook(handWritten, { preset: 'counts' }).rows[0].text === '{running} running · {idle} idle')

  // Configs written before the looks existed.
  const untouchedOld = migrateRows({ rows: DEFAULT_ROWS.map((r) => ({ ...r })), elapsed: true, buttons: [] })
  check('old config: lines nobody changed become the new default (no project names)',
    untouchedOld.preset === 'counts' && card(desk, untouchedOld) === '2 running · 3 idle', JSON.stringify(untouchedOld))
  // Robert's Mac on 2026-09-27: fraction line, a switched-off tokens line, the idle line.
  const robert = migrateRows({
    rows: [
      { id: 'running', text: '{running}/{total} {sessions} running', when: 'running', on: true },
      { id: 'projects', text: 'used {tokens}', when: 'running', on: false },
      { id: 'idle', text: '{total} {sessions} idle', when: 'idle', on: true }
    ],
    elapsed: true,
    buttons: [{ id: 'link', label: 'toolstash.xyz/paneforge', url: 'https://toolstash.xyz/paneforge', on: true }]
  })
  check('old config: lines somebody wrote are kept exactly, as their own',
    robert.preset === 'custom' && card(desk, robert) === '2/5 sessions running' && robert.rows.length === 3, JSON.stringify(robert))
  check('old config: a saved look is rebuilt from the look, not from stale lines',
    migrateRows({ preset: 'fraction', idle: false, tokens: false, rows: [{ id: 'x', text: 'stale', when: 'always', on: true }], elapsed: true, buttons: [] }).rows[0].text === '{running}/{total} {sessions} running')

  // Settings cross the device link: whatever arrives is rebuilt from checked parts.
  check('wire: a style that is not one is nothing', readStyle(null) === undefined && readStyle({ rows: 'x' }) === undefined && readStyle({ rows: [{ text: 1 }] }) === undefined)
  const wired = readStyle({ preset: 'bogus', rows: [{ id: 'a', text: 'hi', when: 'sometimes', on: 'yes' }], buttons: [{ id: 'b', label: 'x'.repeat(99), url: 'https://a.b' }, { id: 'c' }], elapsed: 0 })
  check('wire: an unknown look is a hand-written card, odd fields made safe',
    wired.preset === 'custom' && wired.rows[0].when === 'always' && wired.rows[0].on === true && wired.buttons.length === 1 && wired.buttons[0].label.length === 32 && wired.elapsed === true,
    JSON.stringify(wired))
  const mine = { on: true, style: DEFAULT_DISCORD_STYLE, at: 100 }
  const said = (at, on = false) => ({ id: 'PC', name: 'PC', report: { counts: { running: 0, total: 0, asleep: 0, names: [] }, discord: false, settings: { on, style: look('fraction', false, false), at } } })
  check('settings: a newer change on the other machine is taken', newerSettings(mine, [said(200)])?.style.preset === 'fraction')
  check('settings: an older one, or the same moment, is not', newerSettings(mine, [said(50)]) === undefined && newerSettings(mine, [said(100)]) === undefined)
  check('settings: switching it off travels too', newerSettings(mine, [said(300, false)])?.on === false)
  const roundTrip = readDeskReport(JSON.parse(JSON.stringify(said(200).report)))
  check('settings: they survive the wire', roundTrip.settings?.at === 200 && roundTrip.settings.style.rows[0].text === '{running}/{total} {sessions} running', JSON.stringify(roundTrip))

  const rows = (list) => ({ ...DEFAULT_DISCORD_STYLE, rows: list })
  const row = (over) => ({ id: 'r', text: '', when: 'always', on: true, ...over })

  // The whole point of the list: which line is on top is the user's, not the app's.
  const swapped = buildActivity(desk, rows([DEFAULT_ROWS[1], DEFAULT_ROWS[0], DEFAULT_ROWS[2]]))
  check('rows: moving a line up puts it on top',
    swapped.details === 'on PaneForge, Toolstash' && swapped.state === '2/5 sessions running',
    JSON.stringify([swapped.details, swapped.state]))

  const off = buildActivity(desk, rows([{ ...DEFAULT_ROWS[0], on: false }, DEFAULT_ROWS[1]]))
  check('rows: switching one off hands its place to the one under it',
    off.details === 'on PaneForge, Toolstash' && off.state === undefined, JSON.stringify(off))

  // Discord draws two lines. A third is kept in the list and simply never sent, which
  // is the one thing about this that cannot be fixed by writing more code.
  const three = buildActivity(desk, rows([
    row({ id: 'a', text: 'one' }), row({ id: 'b', text: 'two' }), row({ id: 'c', text: 'three' })
  ]))
  check('rows: only the first two reach the card',
    three.details === 'one' && three.state === 'two' && !JSON.stringify(three).includes('three'),
    JSON.stringify(three))
  check('rows: and the list says which two', 
    chosenRows(desk, rows([row({ id: 'a', text: 'one' }), row({ id: 'b', text: 'two' }), row({ id: 'c', text: 'three' })]))
      .map((r) => r.id).join(',') === 'a,b')
  check('rows: two is the number Discord draws', VISIBLE_ROWS === 2)

  const quiet = { running: 0, total: 3, names: [], ...base }
  const always = rows([row({ id: 'a', text: '{total} {sessions}', when: 'always' })])
  check('rows: an always row shows in both halves',
    buildActivity(desk, always).details === '5 sessions' &&
      buildActivity(quiet, always).details === '3 sessions')
  check('rows: a running-only row says nothing on a quiet desk',
    buildActivity(quiet, rows([row({ text: 'busy', when: 'running' })])) === null)
  check('rows: an idle-only row says nothing while a turn runs',
    buildActivity(desk, rows([row({ text: 'resting', when: 'idle' })])) === null)

  // A row whose words come out empty takes no line, and the one under it moves up -
  // which is what the old "name the projects" switch did by hand.
  const emptied = buildActivity(quiet, rows([
    row({ id: 'a', text: 'on {projects}' }), row({ id: 'b', text: '{total} idle' })
  ]))
  check('rows: a row that renders to nothing gives up its line',
    emptied.details === '3 idle' && emptied.state === undefined, JSON.stringify(emptied))

  check('rows: custom wording', buildActivity(desk, rows([row({ text: 'forging on {project}' })])).details === 'forging on PaneForge')
  check('rows: {idle} is total minus running',
    buildActivity(desk, rows([row({ text: '{idle} {sessions} waiting, {projects}' })])).details ===
      '3 sessions waiting, PaneForge, Toolstash')

  const noClock = buildActivity(desk, { ...DEFAULT_DISCORD_STYLE, elapsed: false })
  check('style: elapsed off sends no timestamps', noClock.timestamps === undefined)
  check('style: a card with nothing on it is a clear, never a blank badge',
    buildActivity(desk, rows([row({ text: '   ' })])) === null)
  check('style: a list with no rows at all is a clear', buildActivity(desk, rows([])) === null)

  const longNames = { running: 9, total: 9, names: [...Array(30)].map((_, i) => `some-quite-long-project-name-${i}`), ...base }
  const longLine = buildActivity(longNames, rows([row({ text: 'working on {projects} right now' })]))
  check('style: a custom line is capped too', longLine.details.length <= 128, String(longLine.details.length))
  check('style: capping keeps the tail of the template', / right now$/.test(longLine.details), longLine.details)

  // ---------- the token rows ----------
  const spent = { ...desk, tokensToday: 1_480_000, tokensWeek: 9_200_000 }
  const spend = buildActivity(spent, rows([row({ text: '{tokens} today, {tokensWeek} this week' })]))
  check('tokens: written the way a card can be read', spend.details === '1.5M today, 9.2M this week', spend.details)
  check('tokens: a desk that has not counted yet says 0, never undefined',
    buildActivity(desk, rows([row({ text: '{tokens} today' })])).details === '0 today')
  check('tokens: nothing asks for the disk walk unless a row says so',
    needsTokens(DEFAULT_DISCORD_STYLE) === false &&
      needsTokens(rows([row({ text: 'spent {tokensWeek}' })])) === true &&
      needsTokens(rows([row({ text: 'spent {tokens}', on: false })])) === false)

  // ---------- an old config ----------
  // The three fixed wording fields became three rows. An empty field meant "the
  // built-in wording", so the migration has to fill it in rather than carry the blank.
  const old = migrateRows({ details: '', state: 'building {project}', idleDetails: '', projects: true, whileIdle: false, link: true, linkLabel: 'Site', linkUrl: 'https://x.dev' })
  check('old config: three rows, in the order the card drew them',
    old.rows.map((r) => `${r.id}:${r.when}:${r.on}`).join(' ') === 'running:running:true projects:running:true idle:idle:false',
    JSON.stringify(old.rows))
  check('old config: an empty field keeps its built-in wording',
    old.rows[0].text === '{running}/{total} {sessions} running' && old.rows[1].text === 'building {project}')
  check('old config: the link becomes the first button',
    old.buttons.length === 1 && old.buttons[0].label === 'Site' && old.buttons[0].url === 'https://x.dev')
  check('old config: one that already has rows is left alone',
    migrateRows({ rows: [row({ id: 'z', text: 'kept' })], elapsed: false, buttons: [] }).rows[0].id === 'z')

  // ---------- the buttons ----------
  // A URL in a text row is drawn as text, so the only clickable thing a rich presence
  // has is `buttons`. A malformed one is not ignored - it costs the whole frame.
  const linked = buildActivity(desk)
  check(
    'link: the default presence carries the toolstash button',
    Array.isArray(linked.buttons) && linked.buttons.length === 1 &&
      linked.buttons[0].label === DEFAULT_LINK_LABEL && linked.buttons[0].url === DEFAULT_LINK_URL,
    JSON.stringify(linked.buttons)
  )
  const btn = (list) => buildButtons({ ...DEFAULT_DISCORD_STYLE, buttons: list })
  const B = (over) => ({ id: 'b', label: 'x', url: 'https://a.dev', on: true, ...over })
  check('link: the switch turns it off', btn([B({ on: false })]).length === 0)
  check('link: a custom label and url are used',
    btn([B({ label: 'Get PaneForge', url: 'https://toolstash.xyz/x' })])[0].label === 'Get PaneForge')
  check('link: two buttons are sent', btn([B({ id: 'a' }), B({ id: 'b' })]).length === 2)
  check('link: a third is dropped, because Discord refuses the frame over it',
    btn([B({ id: 'a' }), B({ id: 'b' }), B({ id: 'c' })]).length === MAX_BUTTONS)
  check('link: a non-http url is dropped', btn([B({ url: 'javascript:alert(1)' })]).length === 0)
  check('link: a bare domain is dropped', btn([B({ url: 'toolstash.xyz/paneforge' })]).length === 0)
  check('link: a long label is cut to 32 characters', btn([B({ label: 'x'.repeat(80) })])[0].label.length === 32)
  check('link: a label of only spaces falls back rather than drawing a blank button',
    btn([B({ label: '   ' })])[0].label === DEFAULT_LINK_LABEL)
  check('link: no desk means no presence at all', buildActivity({ total: 0, running: 0, names: [], ...base }) === null)
}

// ---------- the client against a fake Discord on a real pipe ----------
const PIPE =
  process.platform === 'win32'
    ? `\\\\?\\pipe\\pf-discord-test-${process.pid}`
    : join(work, `pf-discord-test-${process.pid}`)

function fakeDiscord(onFrame, onHandshake) {
  const socks = new Set()
  const server = net.createServer((sock) => {
    socks.add(sock)
    const s = new FrameStream()
    sock.on('data', (chunk) => {
      for (const f of s.push(chunk)) {
        if (f.op === OP_HANDSHAKE) {
          onHandshake?.(f)
          sock.write(
            encodeFrame(OP_FRAME, {
              evt: 'READY',
              data: { v: 1, user: { username: 'tester', global_name: 'Tester' } }
            })
          )
        } else {
          onFrame(f, sock)
        }
      }
    })
    sock.on('close', () => socks.delete(sock))
    sock.on('error', () => {})
  })
  return new Promise((resolve) =>
    server.listen(PIPE, () =>
      resolve({
        server,
        // server.close alone waits for live connections, and the client under test
        // holds one open on purpose - killing Discord means killing its sockets.
        close: () =>
          new Promise((r) => {
            for (const s of socks) s.destroy()
            server.close(r)
          })
      })
    )
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const counts = (running, total, names = ['PaneForge']) => ({
  running,
  total,
  names,
  oldestRunSince: running ? 111 : undefined,
  appStart: 222
})

{
  // No pipe at all: construction and updates must cost nothing and kill nothing.
  const p = new DiscordPresence({ clientId: 'c', enabled: true, pipePaths: [PIPE], retryMs: 50, throttleMs: 10 })
  p.update(counts(1, 2))
  await sleep(120)
  check('no Discord: silence, no crash, retries armed', true)

  // Fake Discord appears; the armed retry must find it and deliver the counts.
  const got = []
  const discord = await fakeDiscord((f) => got.push(f))
  await sleep(150)
  check('reconnect: retry finds a Discord that arrived late', got.length >= 1, String(got.length))
  const first = got[0]
  check('reconnect: frame is SET_ACTIVITY with our pid', first?.payload.cmd === 'SET_ACTIVITY' && first?.payload.args.pid === process.pid)
  check('reconnect: activity carried the pre-connect counts', first?.payload.args.activity?.details === '1 running · 1 idle', first?.payload.args.activity?.details)
  // Not just built - actually written down the pipe. The button is the only part of
  // the presence a person can press, and it is worth nothing if the client drops it
  // between buildActivity and the frame.
  check(
    'reconnect: the frame Discord receives carries the link button',
    first?.payload.args.activity?.buttons?.[0]?.url === DEFAULT_LINK_URL,
    JSON.stringify(first?.payload.args.activity?.buttons)
  )
  check(
    'reconnect: the frame Discord receives carries the mark',
    first?.payload.args.activity?.assets?.large_image === 'icon',
    JSON.stringify(first?.payload.args.activity?.assets)
  )

  // Throttle: a burst is one trailing frame with the last state, not five frames.
  got.length = 0
  p.update(counts(2, 6))
  p.update(counts(3, 6))
  p.update(counts(4, 6))
  p.update(counts(5, 6))
  await sleep(120)
  const details = got.map((f) => f.payload.args.activity?.details)
  check('throttle: burst collapsed', got.length <= 2, JSON.stringify(details))
  check('throttle: trailing state wins', details[details.length - 1] === '5 running · 1 idle', JSON.stringify(details))

  // Identical desk shape must not spend rate-limit budget.
  got.length = 0
  await sleep(30)
  p.update(counts(5, 6))
  p.update(counts(5, 6))
  await sleep(60)
  check('dedup: unchanged counts send nothing', got.length === 0, String(got.length))

  // Empty desk clears: SET_ACTIVITY with no activity in args.
  p.update(counts(0, 0, []))
  await sleep(60)
  const clear = got[got.length - 1]
  check('clear: empty desk sends SET_ACTIVITY without activity', clear && clear.payload.cmd === 'SET_ACTIVITY' && !('activity' in clear.payload.args))

  // Discord dies mid-session: the client survives and reconnects to the next one.
  await discord.close()
  await sleep(20)
  p.update(counts(2, 3))
  await sleep(100)
  const got2 = []
  const discord2 = await fakeDiscord((f) => got2.push(f))
  await sleep(150)
  check('drop: reconnected after Discord died', got2.length >= 1, String(got2.length))
  check('drop: fresh READY re-sends current counts', got2[0]?.payload.args.activity?.details === '2 running · 1 idle', got2[0]?.payload.args.activity?.details)

  // The switch: off clears and disconnects; on comes back.
  got2.length = 0
  p.configure(false)
  await sleep(60)
  p.update(counts(1, 1))
  await sleep(60)
  check('off: no frames while disabled', got2.length === 0, String(got2.length))
  p.configure(true)
  p.update(counts(1, 1))
  await sleep(150)
  check('on: presence resumes after re-enable', got2.some((f) => f.payload.args.activity?.details === '1 running · 0 idle'))

  p.dispose()
  await discord2.close()
}

// ---------- what Discord SAYS BACK ----------
//
// The settings tab reports Discord's own answer rather than the app's intent, so the
// frames coming the other way are now load-bearing and used to be dropped on the floor.
// A refused presence and an accepted one looked identical from inside the app, which is
// exactly how a card nobody could see went unnoticed.
{
  const seen = []
  const shakes = []
  // A Discord that acknowledges properly: the ack echoes back the activity it STORED,
  // with the application name it resolved - which is where the header comes from.
  const discord = await fakeDiscord(
    (f, sock) => {
      if (f.payload.cmd !== 'SET_ACTIVITY') return
      const a = f.payload.args.activity
      sock.write(
        encodeFrame(OP_FRAME, {
          cmd: 'SET_ACTIVITY',
          nonce: f.payload.nonce,
          evt: null,
          data: a ? { ...a, name: 'PaneForge', application_id: '1' } : null
        })
      )
    },
    (f) => shakes.push(f)
  )
  const p = new DiscordPresence({
    enabled: true,
    pipePaths: [PIPE],
    retryMs: 40,
    throttleMs: 10,
    onStatus: (s) => seen.push(s)
  })
  check('status: before anything connects it claims nothing', p.status().connected === false && p.status().acceptedAt === null)
  p.update(counts(1, 2))
  await sleep(200)
  let s = p.status()
  check('status: connected once the handshake lands', s.connected === true)
  // The identity is a constant, not a setting: a build that shipped an empty or edited
  // id would send a presence Discord has no application for and nobody would be told.
  check(
    'identity: the handshake carries the shipped application id with nothing passed in',
    shakes[0]?.payload.client_id === DISCORD_APP_ID,
    String(shakes[0]?.payload.client_id)
  )
  check('status: the account Discord handed over is named', s.user === 'Tester', String(s.user))
  check('status: the header is what Discord resolved, not what we hoped', s.appName === 'PaneForge', String(s.appName))
  check('status: the accepted time is real', typeof s.acceptedAt === 'number' && s.acceptedAt > 0)
  check('status: the lines are the ones Discord stored', s.lines[0] === '1 running · 1 idle', JSON.stringify(s.lines))
  check('status: nothing refused', s.error === null, String(s.error))
  check('status: the renderer was told', seen.length >= 1, String(seen.length))
  // An empty desk is a CLEAR, and a clear is a success - it must not read as a failure
  // or as a stale presence still standing.
  p.update(counts(0, 0, []))
  await sleep(80)
  s = p.status()
  check('status: an empty desk reads as cleared, not as broken', s.cleared === true && s.error === null && s.lines.length === 0)

  // Discord goes away: nothing it said is true any more.
  await discord.close()
  await sleep(80)
  check('status: a dead pipe is not still "accepted"', p.status().connected === false && p.status().acceptedAt === null)
  p.dispose()
}

// A Discord that REFUSES the frame. Nothing about the app changes - the presence simply
// never appears - so the reason has to survive to the settings tab or it is lost.
{
  const discord = await fakeDiscord((f, sock) => {
    if (f.payload.cmd !== 'SET_ACTIVITY') return
    sock.write(
      encodeFrame(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        nonce: f.payload.nonce,
        evt: 'ERROR',
        data: { code: 4000, message: 'Invalid activity' }
      })
    )
  })
  const p = new DiscordPresence({ enabled: true, pipePaths: [PIPE], retryMs: 40, throttleMs: 10 })
  p.update(counts(1, 2))
  await sleep(200)
  const s = p.status()
  check('error: the refusal is kept in Discord\'s own words', s.error === 'Invalid activity', String(s.error))
  check('error: a refused frame is not reported as accepted', s.acceptedAt === null, String(s.acceptedAt))
  check('error: still connected - the pipe is fine, the presence is not', s.connected === true)
  p.dispose()
  await discord.close()
}

// A server that speaks garbage must not take the process down (the tee's lesson).
{
  const server = net.createServer((sock) => {
    sock.write(Buffer.from('this is not a frame and never will be'))
    setTimeout(() => sock.destroy(), 20)
  })
  await new Promise((r) => server.listen(PIPE, r))
  const p = new DiscordPresence({ clientId: 'c', enabled: true, pipePaths: [PIPE], retryMs: 30, throttleMs: 10 })
  p.update(counts(1, 1))
  await sleep(120)
  check('hostile: non-protocol bytes survive without crashing', true)
  p.dispose()
  await new Promise((r) => server.close(r))
}

// What the profile counts. The desk below is a real one, read off the running app on
// 2026-08-17: five local panes and three mirrored from the Windows box, five turns
// running between them. The profile said "4/5 sessions running" - it was counting the
// local half and calling that the whole desk.
{
  const desk = [
    { status: 'working', cwd: '/Users/robertiuoras/Projects/taskdriver.ai-b', runSince: 3000 },
    { status: 'idle', cwd: '/Users/robertiuoras/Projects/taskdriver.ai' },
    { status: 'working', cwd: '/Users/robertiuoras/Projects/taskdriver.ai-a', runSince: 5000 },
    { status: 'working', cwd: '/Users/robertiuoras/Projects/toolstash' },
    { status: 'idle', cwd: '/Users/robertiuoras/Projects/assistant' },
    { status: 'working', cwd: 'C:\\Users\\Gamer\\Desktop\\Projects\\assistant-b', runSince: 1000 },
    { status: 'idle', cwd: 'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge' },
    { status: 'working', cwd: 'C:\\Users\\Gamer\\Desktop\\Projects\\Manic-s-Auction-House-a', runSince: 2000 },
    { status: 'exited', cwd: '/Users/robertiuoras/Projects/betting' }
  ]
  const c = countPresence(desk, 999)
  // Nine, not eight, from 2026-09-10: the `exited` pane at the end is one the idle clock
  // SLEPT, and a slept pane is still a pane - its card, screen and conversation are all
  // still on the desk and one press wakes it. Dropping it made the desk's own number go
  // down every time the sleep clock fired. Robert: "can u also count sleeping sessions in
  // paneforge as well for our discord rich prescene".
  check('counts: mirrored panes are on the desk too', c.total === 9, `total ${c.total}`)
  check('counts: ...and a sleeping pane is counted, not dropped', c.asleep === 1, `asleep ${c.asleep}`)
  check('counts: every running turn counts, whichever machine runs it', c.running === 5, `running ${c.running}`)
  check(
    'counts: a mirrored pane\'s Windows cwd becomes a folder name, not a path',
    c.names.includes('assistant-b') && !c.names.some((n) => n.includes('\\')),
    c.names.join(', ')
  )
  check(
    'counts: the elapsed clock starts at the oldest run on EITHER machine',
    c.oldestRunSince === 1000,
    String(c.oldestRunSince)
  )
  check('counts: an exited pane is off the desk', !c.names.includes('betting'))
  check('counts: an empty desk is empty, not one blank name', countPresence([], 1).total === 0)
  check('folderName: trailing separator does not yield an empty name', folderName('C:\\Projects\\foo\\') === 'foo')
  check('folderName: a posix path still works', folderName('/a/b/c') === 'c')

  // A pane in both halves of the desk. The name list has always deduped, so an inflated
  // fraction would sit next to a projects line that looked perfectly right.
  const twice = countPresence(
    [
      { id: 's4', status: 'working', cwd: '/p/foo', runSince: 100 },
      { id: 's4', status: 'working', cwd: '/p/foo', runSince: 100 },
      { id: 's5', status: 'idle', cwd: '/p/bar' }
    ],
    1
  )
  check('counts: a pane that arrives twice is one pane', twice.running === 1 && twice.total === 2, JSON.stringify(twice))
  const noIds = countPresence(
    [
      { status: 'working', cwd: '/p/foo' },
      { status: 'working', cwd: '/p/foo' }
    ],
    1
  )
  check('counts: without ids nothing is deduped away', noIds.running === 2)

  // Every running turn started before this app did, so there is no stamp to date the
  // clock from. The elapsed timer has to fall back, not read as "started at 1970".
  const noStamps = countPresence(
    [
      { status: 'working', cwd: '/p/foo' },
      { status: 'working', cwd: '/p/bar' }
    ],
    4242
  )
  check('counts: no run stamps at all leaves the clock unset', noStamps.oldestRunSince === undefined, String(noStamps.oldestRunSince))
  const fallback = buildActivity(noStamps, { ...DEFAULT_DISCORD_STYLE, elapsed: true }, 9000)
  check('elapsed: with no run stamp the clock falls back to app start', fallback.timestamps.start === 4242, JSON.stringify(fallback.timestamps))

  // The other machine's clock is ahead of this one. Discord counts UP from the stamp,
  // so an unclamped future start renders as a negative or absurd timer.
  const skewed = countPresence([{ status: 'working', cwd: '/p/foo', runSince: 10_000 }], 1)
  const clamped = buildActivity(skewed, { ...DEFAULT_DISCORD_STYLE, elapsed: true }, 5_000)
  check(
    'elapsed: a mirrored run stamp from a fast clock is clamped to now',
    clamped.timestamps.start === 5_000,
    JSON.stringify(clamped.timestamps)
  )
  const sane = buildActivity(countPresence([{ status: 'working', cwd: '/p/foo', runSince: 3_000 }], 1), { ...DEFAULT_DISCORD_STYLE, elapsed: true }, 5_000)
  check('elapsed: an ordinary run stamp is left alone', sane.timestamps.start === 3_000, JSON.stringify(sane.timestamps))

  // 'starting' is a real production status (types.ts) and is not a running turn.
  const booting = countPresence(
    [
      { status: 'starting', cwd: '/p/foo' },
      { status: 'working', cwd: '/p/bar' }
    ],
    1
  )
  check('counts: a pane still booting its CLI is on the desk but not running', booting.running === 1 && booting.total === 2)

  // 2026-09-23: "discord only 6 running but theres 16 running". The turn is over, a
  // background shell or subagent is still going, and the sidebar lists it under Running.
  const backJobs = countPresence(
    [
      { status: 'idle', cwd: '/p/foo', backJob: 'npm run dev', backJobSince: 700 },
      { status: 'idle', cwd: '/p/bar', engaged: true },
      { status: 'working', cwd: '/p/baz', runSince: 900 },
      { status: 'exited', cwd: '/p/old', backJob: 'stale' }
    ],
    1
  )
  check('counts: a pane running a background job is running, like the sidebar says', backJobs.running === 2, JSON.stringify(backJobs))
  check('counts: ...and its job start dates the clock', backJobs.oldestRunSince === 700, String(backJobs.oldestRunSince))
  check('counts: ...and a finished pane with nothing running is not', !backJobs.names.includes('bar') && !backJobs.names.includes('old'))
}

// ---------- two desks, one Discord profile ----------
// Measured 2026-09-27 with `pf call discord:status` on both machines: the Mac ran 14 panes
// with work going in several, the PC ran none of its own and mirrored ONE of the Mac's
// (an asleep one). The Mac said `countedBy: DESKTOP-CMSUCM1` and sent a clear; the PC sent
// "1 session idle", and that was the profile. A desk that mirrors a few panes does not
// count the rest - so "the other desk already counts mine" was never true.
{
  const MAC = 'e8a289e1e7d70116'
  const PC = 'e38080cc645760c5'
  // Robert's own card that day: running line, tokens line switched off, idle line.
  const style = {
    rows: [
      { id: 'running', text: '{running}/{total} {sessions} running', when: 'running', on: true },
      { id: 'projects', text: 'used {tokens}', when: 'running', on: false },
      { id: 'idle', text: '{total} {sessions} idle', when: 'idle', on: true }
    ],
    elapsed: true,
    buttons: [{ id: 'link', label: 'toolstash.xyz/paneforge', url: 'https://toolstash.xyz/paneforge', on: true }]
  }
  const pane = (id, status, extra = {}) => ({ id, status, cwd: `/Users/r/Projects/${id}`, ...extra })
  const macPanes = [
    pane('s26', 'working', { runSince: 1_000 }),
    pane('s44', 'idle', { backJob: 'rbuild.mjs', backJobSince: 2_000 }),
    pane('s59', 'working', { runSince: 3_000 }),
    pane('s60', 'working', { runSince: 4_000 }),
    pane('s61', 'working', { runSince: 5_000 }),
    pane('s51', 'idle'),
    pane('s57', 'idle'),
    pane('s58', 'idle'),
    pane('s62', 'idle'),
    pane('s41', 'exited'),
    pane('s46', 'exited'),
    pane('s52', 'exited'),
    pane('s54', 'exited'),
    pane('s55', 'exited')
  ]
  const now = 10_000
  // What each machine would put on the profile, given what each one knows.
  const desks = ({ macDiscord = true, pcDiscord = true, pcReports = true, macIsClient = true } = {}) => {
    const reportOf = (local, discord) => ({ counts: countPresence(local, 0), discord })
    const mac = wholeDesk(
      { id: MAC, discord: macDiscord, own: countPresence(macPanes, 1) },
      [
        {
          id: PC,
          name: 'DESKTOP-CMSUCM1',
          guest: true,
          ...(pcReports ? { report: reportOf([], pcDiscord) } : {}),
          ...(macIsClient ? { panes: [] } : {})
        }
      ]
    )
    const pc = wholeDesk(
      { id: PC, discord: pcDiscord, own: countPresence([], 1) },
      [
        {
          id: MAC,
          name: 'Roberts-MacBook-Pro',
          guest: macIsClient,
          report: reportOf(macPanes, macDiscord),
          panes: macPanes.map((p) => ({ ...p, watched: p.id === 's54' }))
        }
      ]
    )
    const sent = []
    if (macDiscord) sent.push(['mac', buildActivity(mac, style, now)])
    if (pcDiscord && pcReports) sent.push(['pc', buildActivity(pc, style, now)])
    return { mac, pc, speaking: sent.filter(([, a]) => a) }
  }

  const both = desks()
  check('two desks: exactly one of them puts a card on the profile',
    both.speaking.length === 1, both.speaking.map(([w, a]) => `${w}: ${a.details}`).join(' | '))
  check('two desks: and it counts every pane on both machines',
    both.speaking[0]?.[1].details === '5/14 sessions running', both.speaking[0]?.[1].details)
  check('two desks: the quiet one names the one that speaks',
    [both.mac, both.pc].filter((c) => c.countedBy).length === 1)
  check('two desks: both desks agree on the numbers',
    both.mac.running === both.pc.running && both.mac.total === both.pc.total, `${both.mac.running}/${both.mac.total} vs ${both.pc.running}/${both.pc.total}`)

  const macOnly = desks({ pcDiscord: false })
  check('Discord open on the Mac only: the Mac says the whole desk',
    macOnly.speaking.length === 1 && macOnly.speaking[0][0] === 'mac' && macOnly.speaking[0][1].details === '5/14 sessions running',
    macOnly.speaking.map(([w, a]) => `${w}: ${a.details}`).join(' | '))
  const pcOnly = desks({ macDiscord: false })
  check('Discord open on the PC only: the PC says the whole desk',
    pcOnly.speaking.length === 1 && pcOnly.speaking[0][0] === 'pc' && pcOnly.speaking[0][1].details === '5/14 sessions running',
    pcOnly.speaking.map(([w, a]) => `${w}: ${a.details}`).join(' | '))
  // The PC connects to the Mac but the Mac was never paired back: the Mac has no pane list
  // for the PC, only what the PC says about itself.
  const oneWay = wholeDesk(
    { id: MAC, discord: true, own: countPresence(macPanes.slice(0, 4), 1) },
    [{ id: PC, name: 'PC', guest: true, report: { counts: countPresence([pane('p1', 'working', { runSince: 1 }), pane('p2', 'idle')], 0), discord: false } }]
  )
  check('one-way pairing: the machine Discord is on still counts the other one',
    oneWay.running === 5 && oneWay.total === 6 && !oneWay.countedBy, JSON.stringify(oneWay))
  // A PC still on a build from before desks reported themselves says nothing about its
  // Discord; the Mac counts it from the pane list it already has, and speaks.
  const older = wholeDesk(
    { id: MAC, discord: true, own: countPresence(macPanes, 1) },
    [{ id: PC, name: 'PC', guest: true, panes: [pane('p1', 'working', { runSince: 1 })] }]
  )
  check('older build on the other desk: counted from its pane list, and this desk speaks',
    older.running === 6 && older.total === 15 && !older.countedBy, JSON.stringify(older))
  // Linked both ways, the same machine is two links: counted once.
  const twice = wholeDesk(
    { id: MAC, discord: true, own: countPresence([], 1) },
    [
      { id: PC, name: 'PC', report: { counts: countPresence([pane('p1', 'working', { runSince: 1 })], 0), discord: false }, panes: [pane('p1', 'working', { runSince: 1 })] },
      { id: PC, name: 'PC', guest: true, report: { counts: countPresence([pane('p1', 'working', { runSince: 1 })], 0), discord: false } }
    ]
  )
  check('a machine linked both ways is counted once', twice.running === 1 && twice.total === 1, JSON.stringify(twice))
}

// ---------- a desk report, as it lands off the wire ----------
{
  check('report: not a report is nothing', readDeskReport(null) === undefined && readDeskReport({ discord: true }) === undefined && readDeskReport({ counts: { running: -1, total: 3 } }) === undefined)
  const r = readDeskReport({ counts: { running: 9, total: 4, asleep: 7, names: ['a', 3, 'b'], oldestRunSince: 'x' }, discord: 'yes' })
  check('report: running and asleep never exceed the total', r.counts.running === 4 && r.counts.asleep === 4, JSON.stringify(r))
  check('report: only real names, and Discord only when it says true', r.counts.names.join() === 'a,b' && r.discord === false && r.counts.oldestRunSince === undefined, JSON.stringify(r))
}

// ---------- desk reports cross the device link, both ways ----------
{
  const entry = join(work, 'remote-entry.ts')
  const from = (p) => JSON.stringify(join(root, p).replace(/\\/g, '/'))
  writeFileSync(entry, [
    `export { RemoteHost } from ${from('src/main/remote/host.ts')}`,
    `export { RemoteClient } from ${from('src/main/remote/client.ts')}`,
    `export { newCode } from ${from('src/main/remote/wire.ts')}`
  ].join('\n'))
  const outRemote = join(work, 'remote.bundle.cjs')
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning', outfile: outRemote })
  const { RemoteHost, RemoteClient, newCode } = req(outRemote)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (cond, ms = 5_000) => {
    for (const stop = Date.now() + ms; Date.now() < stop; await wait(20)) if (cond()) return true
    return false
  }
  const port = await new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
  const sessions = [{ id: 's1', title: 'a', cwd: '/w/a', agent: 'claude', status: 'working', lastOutput: 0, createdAt: 0, cols: 80, rows: 24 }]
  const none = () => () => {}
  const backend = {
    list: () => sessions, buffer: () => '', log: () => '', write() {}, resize() {}, returnSize() {}, redraw() {},
    setBusy() {}, clearAttention() {}, kill() {}, restart: () => null, rename() {}, switchAgent: () => null,
    startSession: () => sessions[0], projects: async () => [], agents: async () => [], jobs: async () => [],
    onData: none, onTyped: none, onSessions: none, onAttention: none
  }
  const code = newCode()
  const host = new RemoteHost(backend, () => ({ id: 'HOSTID', name: 'PC', platform: 'win32', version: '0' }), () => code)
  const hostSaid = { counts: { running: 0, total: 1, asleep: 0, names: [] }, discord: true }
  // Both ends say their piece BEFORE the link exists; each must still reach the other.
  host.tellDesk(hostSaid)
  host.start(port)
  await until(() => host.listening)
  const client = new RemoteClient(
    { id: 'HOSTID', name: 'PC', address: '127.0.0.1', port, code, watch: [] },
    () => ({ id: 'GUESTID', name: 'Mac', platform: 'darwin', version: '0' })
  )
  client.sendDesk({ counts: { running: 5, total: 14, asleep: 5, names: ['PaneForge'], oldestRunSince: 1000 }, discord: false })
  client.connect()
  check('link: the guest comes online', await until(() => client.status === 'online'), client.error)
  check('link: the host\'s report reaches a guest that joined after it was said',
    await until(() => client.peerDesk?.discord === true && client.peerDesk.counts.total === 1), JSON.stringify(client.peerDesk))
  check('link: the guest\'s report, said before the link came up, reaches the host',
    await until(() => host.deskReports()[0]?.report?.counts.total === 14), JSON.stringify(host.deskReports()))
  host.tellDesk({ ...hostSaid, discord: false })
  check('link: Discord closing on the host reaches the guest', await until(() => client.peerDesk?.discord === false))
  client.sendDesk({ counts: { running: 6, total: 14, asleep: 5, names: ['PaneForge'] }, discord: true })
  check('link: a turn starting on the guest reaches the host',
    await until(() => host.deskReports()[0]?.report?.counts.running === 6 && host.deskReports()[0].report.discord === true))
  client.disconnect()
  check('link: a machine that went away has said nothing', await until(() => client.peerDesk === undefined && host.deskReports().length === 0))
  host.stop()
}

console.log(failed ? `\n${failed} FAILED` : '\nall good')
process.exit(failed ? 1 : 0)
