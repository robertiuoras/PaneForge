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
import { mkdirSync, rmSync } from 'node:fs'
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
  buildButton,
  DEFAULT_DISCORD_STYLE,
  DEFAULT_LINK_LABEL,
  DEFAULT_LINK_URL,
  OP_HANDSHAKE,
  OP_FRAME
} =
  req(outShared)
const { DiscordPresence } = req(outMain)

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
  const busy = buildActivity({ running: 3, total: 6, names: ['PaneForge', 'Toolstash'], oldestRunSince: 500, ...base })
  check('activity: 3/6 sessions running', busy.details === '3/6 sessions running', busy.details)
  check('activity: names on the second line', busy.state === 'on PaneForge, Toolstash', busy.state)
  check('activity: elapsed anchors on the oldest running turn', busy.timestamps.start === 500)
  const idle = buildActivity({ running: 0, total: 2, names: [], ...base })
  check('activity: idle desk says idle', idle.details === '2 sessions idle', idle.details)
  check('activity: idle elapsed anchors on app start', idle.timestamps.start === 1000)
  // The mark is the one part of the card that is not a preference: an application's
  // icon names the header, so without `assets` Discord draws no artwork at all.
  check('activity: the card carries the PaneForge mark', busy.assets?.large_image === 'icon', JSON.stringify(busy.assets))
  check('activity: the mark is on the idle card too', idle.assets?.large_image === 'icon', JSON.stringify(idle.assets))
  const one = buildActivity({ running: 1, total: 1, names: ['x'], ...base })
  check('activity: singular noun', one.details === '1/1 session running', one.details)
  const many = buildActivity({
    running: 9,
    total: 9,
    names: [...Array(30)].map((_, i) => `some-quite-long-project-name-${i}`),
    ...base
  })
  check('activity: name list capped under Discord\'s 128', many.state.length <= 128, String(many.state.length))
  check('activity: capped list says how many were dropped', / \+\d+ more$/.test(many.state), many.state)
}

// ---------- the Discord tab's knobs ----------
{
  const base = { appStart: 1000 }
  const desk = { running: 2, total: 5, names: ['PaneForge', 'Toolstash'], oldestRunSince: 500, ...base }
  const style = (over) => ({ ...DEFAULT_DISCORD_STYLE, ...over })

  // The whole point of empty-string defaults: an untouched config must send the same
  // bytes the version before the tab existed sent.
  const same = JSON.stringify(buildActivity(desk)) === JSON.stringify(buildActivity(desk, style({})))
  check('style: an untouched style is byte-identical to no style at all', same)

  const custom = buildActivity(desk, style({ details: 'forging on {project}', state: '{running} of {total} busy' }))
  check('style: custom first line', custom.details === 'forging on PaneForge', custom.details)
  check('style: custom second line', custom.state === '2 of 5 busy', custom.state)

  const tokens = buildActivity(desk, style({ details: '{idle} {sessions} waiting, {projects}' }))
  check('style: {idle} is total minus running', tokens.details === '3 sessions waiting, PaneForge, Toolstash', tokens.details)

  const noProjects = buildActivity(desk, style({ projects: false }))
  check('style: projects off drops the second line', noProjects.state === undefined && !!noProjects.details)

  const noClock = buildActivity(desk, style({ elapsed: false }))
  check('style: elapsed off sends no timestamps', noClock.timestamps === undefined)

  const quiet = { running: 0, total: 3, names: [], ...base }
  check('style: idle off is a clear, not a line', buildActivity(quiet, style({ whileIdle: false })) === null)
  check('style: a running desk is unaffected by the idle switch', buildActivity(desk, style({ whileIdle: false })) !== null)
  const idleText = buildActivity(quiet, style({ idleDetails: 'desk of {total} asleep' }))
  check('style: custom idle line', idleText.details === 'desk of 3 asleep', idleText.details)

  // A template that renders to nothing must not become a blank badge on the profile.
  check('style: an all-blank presence is a clear', buildActivity(desk, style({ details: '   ', projects: false })) === null)

  const longNames = { running: 9, total: 9, names: [...Array(30)].map((_, i) => `some-quite-long-project-name-${i}`), ...base }
  const longLine = buildActivity(longNames, style({ state: 'working on {projects} right now' }))
  check('style: a custom line is capped too', longLine.state.length <= 128, String(longLine.state.length))
  check('style: capping keeps the tail of the template', / right now$/.test(longLine.state), longLine.state)

  // ---------- the link ----------
  // A URL in `details`/`state` is drawn as text, so the only clickable thing a
  // rich presence has is `buttons`. These pin the shape Discord accepts, because
  // a malformed button is not ignored - it costs the whole frame.
  const linked = buildActivity(desk)
  check(
    'link: the default presence carries the toolstash button',
    Array.isArray(linked.buttons) &&
      linked.buttons.length === 1 &&
      linked.buttons[0].label === DEFAULT_LINK_LABEL &&
      linked.buttons[0].url === DEFAULT_LINK_URL,
    JSON.stringify(linked.buttons)
  )
  check('link: the switch turns it off', buildActivity(desk, style({ link: false })).buttons === undefined)
  const named = buildActivity(desk, style({ linkLabel: 'Get PaneForge', linkUrl: 'https://toolstash.xyz/x' }))
  check(
    'link: a custom label and url are used',
    named.buttons[0].label === 'Get PaneForge' && named.buttons[0].url === 'https://toolstash.xyz/x',
    JSON.stringify(named.buttons)
  )
  // Discord rejects the frame rather than the field, so anything it would refuse
  // has to be dropped here.
  check('link: a non-http url is dropped', buildButton(style({ linkUrl: 'javascript:alert(1)' })) === null)
  check('link: a bare domain is dropped', buildButton(style({ linkUrl: 'toolstash.xyz/paneforge' })) === null)
  check(
    'link: a long label is cut to 32 characters',
    buildButton(style({ linkLabel: 'x'.repeat(80) })).label.length === 32
  )
  check(
    'link: a label of only spaces falls back to nothing rather than a blank button',
    buildButton(style({ linkLabel: '   ' })).label === DEFAULT_LINK_LABEL
  )
  // An empty desk is still a clear: the button must not keep a dead presence alive.
  check('link: no desk means no presence at all', buildActivity({ total: 0, running: 0, names: [], ...base }) === null)
}

// ---------- the client against a fake Discord on a real pipe ----------
const PIPE =
  process.platform === 'win32'
    ? `\\\\?\\pipe\\pf-discord-test-${process.pid}`
    : join(work, `pf-discord-test-${process.pid}`)

function fakeDiscord(onFrame) {
  const socks = new Set()
  const server = net.createServer((sock) => {
    socks.add(sock)
    const s = new FrameStream()
    sock.on('data', (chunk) => {
      for (const f of s.push(chunk)) {
        if (f.op === OP_HANDSHAKE) {
          sock.write(encodeFrame(OP_FRAME, { evt: 'READY', data: { v: 1 } }))
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
  check('reconnect: activity carried the pre-connect counts', first?.payload.args.activity?.details === '1/2 session running' || first?.payload.args.activity?.details === '1/2 sessions running', first?.payload.args.activity?.details)
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
  check('throttle: trailing state wins', details[details.length - 1] === '5/6 sessions running', JSON.stringify(details))

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
  check('drop: fresh READY re-sends current counts', got2[0]?.payload.args.activity?.details === '2/3 sessions running', got2[0]?.payload.args.activity?.details)

  // The switch: off clears and disconnects; on comes back.
  got2.length = 0
  p.configure(false, 'c')
  await sleep(60)
  p.update(counts(1, 1))
  await sleep(60)
  check('off: no frames while disabled', got2.length === 0, String(got2.length))
  p.configure(true, 'c')
  p.update(counts(1, 1))
  await sleep(150)
  check('on: presence resumes after re-enable', got2.some((f) => f.payload.args.activity?.details === '1/1 session running'))

  p.dispose()
  await discord2.close()
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

console.log(failed ? `\n${failed} FAILED` : '\nall good')
process.exit(failed ? 1 : 0)
