// Signing in to another machine's Chrome from a pane: the arithmetic, the flow control,
// and the two doors (the surface channel and the `pf` command) that reach it.
//
//   node scripts/remote-login-test.mjs
//
// No Chrome, no window, no ssh. The fake CDP below is the load-bearing part: it emits
// frames as fast as it likes while the renderer acks slowly, which is exactly the shape
// a slow link has, and the assertion is that NOTHING queues.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-remote-login-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'remoteLogin.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/remoteLogin.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const M = createRequire(import.meta.url)(out)

let n = 0
const eq = (got, want, why) => {
  n++
  assert.deepEqual(got, want, why)
}
const ok = (cond, why) => {
  n++
  assert.ok(cond, why)
}

// ---------------------------------------------------------------- the picture's cost
eq(M.STEPS.length, 3, 'three rungs: full, half, and barely')
eq(M.STEPS.map((s) => s.quality), [60, 40, 30], 'the qualities the spec fixed')
eq(M.STEPS.map((s) => s.maxWidth), [1440, 960, 720], 'and the widths')

eq(M.nextStep(0, 40, 0), 0, 'a healthy link stays at full quality')
eq(M.nextStep(0, 260, 0), 1, 'past 250ms the picture gets cheaper')
eq(M.nextStep(0, 700, 0), 2, 'past 600ms it gets cheapest, in one move, not two')
eq(M.nextStep(2, 300, 0), 2, 'a limping link does not climb back out of the cheapest rung')
eq(M.nextStep(2, 40, 5), 2, 'five quick frames is not a recovery')
eq(M.nextStep(2, 40, 20), 1, 'twenty of them buys exactly one rung back')
eq(M.nextStep(1, 40, 40), 0, 'and another twenty buys the last one')
eq(M.nextStep(0, 40, 99), 0, 'there is nothing above the top rung')
eq(M.lagWord(40), 'ok', 'the badge is quiet on a good link')
eq(M.lagWord(300), 'slow', 'amber past 250ms')
eq(M.lagWord(900), 'bad', 'red past 600ms')
eq(M.median([]), 0, 'no samples is not a lag reading')
eq(M.median([5, 1, 3]), 3, 'an odd count')
eq(M.median([4, 1, 3, 2]), 2.5, 'an even one')

// ------------------------------------------------------- one frame in flight, ever
// The control this suite exists for: a fake CDP that fires 50 frames while the paint
// takes its time. If the pacer ever holds two, the picture becomes a recording.
{
  const p = new M.Pacer()
  let delivered = 0
  let maxUnacked = 0
  let painting = null
  for (let f = 1; f <= 50; f++) {
    const give = p.frame(f, f * 10)
    if (give !== null) {
      delivered++
      painting = give
    }
    maxUnacked = Math.max(maxUnacked, p.unacked())
    // The renderer paints every third frame's worth of time - slower than they arrive.
    if (f % 3 === 0 && painting !== null) {
      const { next } = p.painted(f * 10 + 5)
      painting = next
      if (next !== null) delivered++
      maxUnacked = Math.max(maxUnacked, p.unacked())
    }
  }
  eq(maxUnacked, 1, 'never more than one frame is out being painted')
  ok(delivered < 50, `a slow paint drops frames rather than queueing them (${delivered} of 50 drawn)`)
  ok(p.skipped > 0, 'the frames it did not draw are counted, not silently lost')
}

// A frame arriving while one is being painted REPLACES the one waiting, so what gets
// drawn next is the present rather than the oldest thing still in hand.
{
  const p = new M.Pacer()
  eq(p.frame(1, 0), 1, 'the first frame paints immediately')
  eq(p.frame(2, 1), null, 'the second waits')
  eq(p.frame(3, 2), null, 'so does the third')
  const { next } = p.painted(3)
  eq(next, 3, 'and the one that gets drawn is the NEWEST, not frame 2')
}

// The step-down fires off real round trips, at the rtt the spec names.
{
  const p = new M.Pacer()
  for (let f = 1; f <= 12; f++) {
    p.frame(f, f * 1000)
    p.painted(f * 1000 + 500) // 500ms round trip: limping, not dead
  }
  eq(p.step, 1, 'a 500ms median steps the picture down one rung')
  eq(Math.round(p.medianRtt()), 500, 'and the median is what it stepped on')
}
{
  const p = new M.Pacer()
  for (let f = 1; f <= 12; f++) {
    p.frame(f, f * 2000)
    p.painted(f * 2000 + 900)
  }
  eq(p.step, 2, 'a 900ms median goes straight to the cheapest rung')
}
{
  const p = new M.Pacer()
  for (let f = 1; f <= 12; f++) {
    p.frame(f, f * 2000)
    p.painted(f * 2000 + 900)
  }
  eq(p.step, 2, 'starts limping')
  // The link comes good. RTT_WINDOW is 20, so the median only clears once the slow
  // samples have aged out - which is the point: one fast frame is not a recovery.
  let f = 100
  for (let i = 0; i < 60; i++, f++) {
    p.frame(f, f * 2000)
    p.painted(f * 2000 + 20)
  }
  eq(p.step, 0, 'a link that stays good climbs all the way back to full quality')
}

// ------------------------------------------------------------------ where a click lands
// The canvas is the pane; the picture inside it is whatever the rung allows; the page's
// own coordinates are neither. Every rung has to map to the SAME page point.
{
  const meta = { deviceWidth: 1280, deviceHeight: 800 }
  const canvas = { width: 640, height: 400 } // pane at half the page's size
  eq(M.toRemotePoint({ x: 0, y: 0 }, canvas, meta), { x: 0, y: 0 }, 'the corner is the corner')
  eq(M.toRemotePoint({ x: 320, y: 200 }, canvas, meta), { x: 640, y: 400 }, 'the middle is the middle')
  eq(
    M.toRemotePoint({ x: 640, y: 400 }, canvas, meta),
    { x: 1279, y: 799 },
    'the far edge clamps INSIDE the page, never one pixel past it'
  )
  eq(M.toRemotePoint({ x: -5, y: -5 }, canvas, meta), { x: 0, y: 0 }, 'a pointer that left the canvas clamps too')
  // Same click, each rung: the picture is smaller but the page is not, and the metadata
  // is what says so - so the answer may not move.
  for (const step of M.STEPS) {
    const shrunk = { width: Math.min(step.maxWidth, 1280) / 2, height: Math.min(step.maxHeight, 800) / 2 }
    const p = M.toRemotePoint(
      { x: shrunk.width / 2, y: shrunk.height / 2 },
      shrunk,
      meta
    )
    eq(p, { x: 640, y: 400 }, `the middle is still the middle at quality ${step.quality}`)
  }
  eq(M.toRemotePoint({ x: 5, y: 5 }, { width: 0, height: 0 }, meta), { x: 0, y: 0 }, 'a canvas with no size answers the origin, not NaN')
}

// ------------------------------------------------------------------------- keystrokes
{
  const k = (key, code, mods = {}) => ({ key, code, ...mods })
  const down = (key, code, mods, opts) => M.keyEvent(k(key, code, mods), 'keyDown', opts)

  eq(down('a', 'KeyA').windowsVirtualKeyCode, 65, 'a letter is its own uppercase code point')
  eq(down('a', 'KeyA').text, 'a', 'and it carries the character to type')
  eq(down('A', 'KeyA', { shift: true }).text, 'A', 'shifted, the capital is what is typed')
  eq(down('A', 'KeyA', { shift: true }).modifiers, M.MOD.shift, 'with the shift modifier set')
  eq(down('Enter', 'Enter').windowsVirtualKeyCode, 13, 'Enter')
  eq(down('Enter', 'Enter').text, '\r', "Enter's text is what submits a form rather than moving focus")
  eq(down('Backspace', 'Backspace').windowsVirtualKeyCode, 8, 'Backspace')
  eq(down('Tab', 'Tab').windowsVirtualKeyCode, 9, 'Tab')
  eq(down('Tab', 'Tab').text, '\t', 'Tab types a tab')
  eq(down('Escape', 'Escape').windowsVirtualKeyCode, 27, 'Escape')
  eq(down('ArrowLeft', 'ArrowLeft').windowsVirtualKeyCode, 37, 'left')
  eq(down('ArrowUp', 'ArrowUp').windowsVirtualKeyCode, 38, 'up')
  eq(down('ArrowRight', 'ArrowRight').windowsVirtualKeyCode, 39, 'right')
  eq(down('ArrowDown', 'ArrowDown').windowsVirtualKeyCode, 40, 'down')
  eq(down('Delete', 'Delete').windowsVirtualKeyCode, 46, 'Delete')
  ok(down('F5', 'F5').windowsVirtualKeyCode === 0, 'a key with no number still goes, by name')
  eq(down('9', 'Digit9').windowsVirtualKeyCode, 57, 'a digit is its own code point too')
  // The one that cost an email address. `.` upper-cased is still `.`, code point 46, which
  // is VK_DELETE - so a full stop typed into a login box deleted the character after it
  // instead. Punctuation carries its `text` and NO virtual key.
  eq(down('.', 'Period').windowsVirtualKeyCode, 0, 'a full stop claims no virtual key')
  eq(down('.', 'Period').text, '.', 'and types itself')
  eq(down('@', 'Digit2', { shift: true }).windowsVirtualKeyCode, 0, 'nor does an at sign')
  eq(down('@', 'Digit2', { shift: true }).text, '@', 'which also types itself')
  eq(down('-', 'Minus').windowsVirtualKeyCode, 0, 'nor a hyphen (45 is VK_INSERT)')
  eq(down(' ', 'Space').windowsVirtualKeyCode, 32, 'space is the one whose code point IS its virtual key')
  ok(M.keyEvent(k('a', 'KeyA'), 'keyUp').text === undefined, 'a key going up types nothing')

  // The one that matters on a PC: Windows Chrome has never heard of Meta.
  const cmdA = down('a', 'KeyA', { meta: true }, { mapMetaToCtrl: true })
  eq(cmdA.modifiers, M.MOD.ctrl, 'Cmd arrives at a Windows Chrome as Ctrl')
  eq(cmdA.text, undefined, 'and an accelerator types no character')
  const macCmdA = down('a', 'KeyA', { meta: true }, { mapMetaToCtrl: false })
  eq(macCmdA.modifiers, M.MOD.meta, "against this machine's own Chrome, Cmd stays Cmd")
  eq(down('a', 'KeyA', { ctrl: true }).modifiers, M.MOD.ctrl, 'a real Ctrl is a Ctrl either way')
  eq(down('a', 'KeyA', { ctrl: true }).text, undefined, 'Ctrl+A selects, it does not type an "a"')
  eq(
    down('a', 'KeyA', { alt: true, shift: true, ctrl: true }).modifiers,
    M.MOD.alt | M.MOD.ctrl | M.MOD.shift,
    'the modifier bits are a mask, not a choice'
  )

  eq(M.forwarded(k('w', 'KeyW', { meta: true })), false, 'Cmd+W would close the tab the sign-in lives in')
  eq(M.forwarded(k('w', 'KeyW', { ctrl: true })), false, 'so would Ctrl+W')
  eq(M.forwarded(k('q', 'KeyQ', { meta: true })), false, 'Cmd+Q would quit the remote browser')
  eq(M.forwarded(k('w', 'KeyW')), true, 'a bare w is a letter somebody is typing')
  eq(M.forwarded(k('a', 'KeyA', { meta: true })), true, 'select-all is fine')
}

// ----------------------------------------------------- words a person who never coded reads
eq(M.machineWord(undefined, 'darwin'), 'this Mac', 'no host means the machine in front of you')
eq(M.machineWord('Gamer@100.78.1.77', 'darwin'), 'the PC', 'a host, from the Mac, is the PC')
eq(M.machineWord('rob@mac', 'win32'), 'the Mac', 'and the other way round')
eq(M.machineWord(undefined, 'win32'), 'this PC', 'no host on the PC is the PC itself')
eq(M.siteWord('facebook'), 'Facebook', 'a site is named the way it is written on the page')
eq(M.siteWord(''), 'A website', 'and an unnamed one still reads as a sentence')

const card = M.loginCardText({ site: 'facebook', machine: 'the PC' })
eq(card.title, 'Facebook needs you to sign in', 'the card says what happened')
ok(card.body.includes('the PC'), 'and which computer to sign in on')
ok(card.open === 'Open and sign in', 'the button says what pressing it does')
eq(
  M.loginPaneTitle({ site: 'facebook', machine: 'the PC' }),
  'Sign in to Facebook on the PC',
  'and the pane wears the same words'
)
// No heading, button or sentence may use the machinery words.
const JARGON = /\b(CDP|screencast|tunnel|ssh|socket|debugger|target|localhost|127\.0\.0\.1|port)\b/i
for (const s of [card.title, card.body, card.open, M.loginPaneTitle({ site: 'x', machine: 'the PC' })]) {
  ok(!JARGON.test(s), `no machinery words on screen: ${s}`)
}

// ------------------------------------------------------------- "looks signed in" is a hint
eq(M.looksSignedIn('https://x.com/login', 'https://x.com/login'), false, 'nothing has happened yet')
eq(M.looksSignedIn('https://x.com/login', 'https://x.com/home'), true, 'the login path is behind us')
eq(M.looksSignedIn('https://x.com/login', 'https://accounts.google.com/o/oauth2'), true, 'an OAuth hop is a host change')
eq(M.looksSignedIn('https://x.com/login', 'https://x.com/signin'), false, 'still a login page, differently spelt')
eq(M.looksSignedIn('not a url', 'https://x.com/home'), false, 'an unreadable address decides nothing')

// ------------------------------------------------------ SOURCE: the two doors are wired
const surface = readFileSync(join(root, 'src/shared/surface.ts'), 'utf8')
for (const ch of [
  'login:list',
  'login:need',
  'login:open',
  'login:close',
  'login:dismiss',
  'login:input',
  'login:ack',
  'login:size',
  'login:frame',
  'login:changed'
]) {
  ok(surface.includes(`'${ch}'`), `${ch} is declared in the one list, not invented by a transport`)
}
const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
ok(/ipcMain\.handle\('login:need'/.test(index), 'main answers the request channel')
ok(/ipcMain\.handle\('login:open'/.test(index), 'main answers the open channel')
ok(/ipcMain\.on\('login:input'/.test(index), 'main takes the keystrokes')
ok(/ipcMain\.on\('login:ack'/.test(index), 'and the paint acknowledgement')

const main = readFileSync(join(root, 'src/main/remoteLogin.ts'), 'utf8')
ok(/ExitOnForwardFailure=yes/.test(main), 'a forward that cannot be made must fail loudly, not sit there')
ok(/BatchMode=yes/.test(main), 'ssh may never stop to ask a question nobody will see')
ok(/-L`?,?\s*$|\$\{local\}:127\.0\.0\.1:/.test(main), 'both ends of the forward are loopback')
ok(/windowsHide: true/.test(main), 'no console window on the PC desktop')
ok(/PF_REMOTE_LOGIN_FAKE_LAG_MS/.test(main), 'the dev-window lag rig sits in the ack path, where real lag lands')
ok(/Page\.screencastFrameAck/.test(main), 'the ack is what asks for the next frame')
ok(!/Page\.screencastFrameAck[\s\S]{0,200}onMessage/.test(main), 'and it is never sent from the receive path')

// The gate lists have to have been REVIEWED, not merely satisfied.
const phone = readFileSync(join(root, 'src/main/phone.ts'), 'utf8')
ok(phone.includes("'login:need'"), 'asking the desk to open a browser is behind the passkey')
ok(phone.includes("'login:open'"), 'so is opening the connection it needs')
ok(phone.includes("'login:input'"), 'and typing into it, which is the whole point of the gate')

// ------------------------------------------------------------------ `pf needs-login`
// The command refuses BEFORE it needs an app: an ask with no address is a mistake, and a
// mistake that opens nothing is cheaper than one that opens the wrong thing.
function pf(args) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts/pf-ctl.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PF_CTL_NO_APP: '1' }
    })
    return { code: 0, out: stdout, err: '' }
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }
  }
}
{
  const noUrl = pf(['needs-login', 'facebook'])
  eq(noUrl.code, 1, 'a needs-login with no address refuses')
  ok(/--url/.test(noUrl.err), 'and says what is missing')
  const noSite = pf(['needs-login'])
  eq(noSite.code, 1, 'a needs-login naming no site refuses')
  const badUrl = pf(['needs-login', 'facebook', '--url', 'facebook.com'])
  eq(badUrl.code, 1, 'an address with no http(s) refuses')
}
const ctl = readFileSync(join(root, 'scripts/pf-ctl.mjs'), 'utf8')
ok(/needs-login/.test(ctl), 'the command exists')
ok(
  /use: list \| open \| needs-login/.test(ctl),
  'and the usage line lists it, so it is findable without this file'
)
ok(/login:need/.test(ctl), 'and goes through the declared channel, not a second door')
ok(/--host/.test(ctl) && /--port/.test(ctl) && /--machine/.test(ctl), 'with the flags the spec named')
ok(/'list'/.test(ctl) && /login:list/.test(ctl), '`pf list` shows the sign-in requests as well as the panes')

// ------------------------------------------------------------- asking for it again
// Robert, 2026-09-03: "allow me to just ask, like that session who wanted it, to open
// again the login and it knows how to open it." Everything the pane leaves out is what it
// said last time, and the picture opens instead of a card waiting to be clicked.
{
  eq(M.siteFromUrl('https://www.facebook.com/login'), 'facebook', 'the word a person uses for the address')
  eq(M.siteFromUrl('https://accounts.google.co.uk/signin'), 'google', 'a two-part suffix is still a suffix')
  eq(M.siteFromUrl('http://127.0.0.1:8899/'), '127.0.0.1', 'an address that is a number is its own name')
  eq(M.siteFromUrl('not an address'), '', 'and nonsense names nothing')

  const first = M.askAgain(undefined, { site: 'facebook', url: 'https://facebook.com/login', host: 'Gamer@100.78.1.77' })
  ok(first.ok, 'a first ask that names a page is accepted')
  eq(first.ask.site, 'facebook', 'with the site it named')

  const again = M.askAgain(first.ask, {})
  ok(again.ok, 'the same pane asking again with no words at all is accepted')
  eq(again.ask.url, 'https://facebook.com/login', 'and gets the page it asked for last time')
  eq(again.ask.host, 'Gamer@100.78.1.77', 'on the same computer')

  const moved = M.askAgain(first.ask, { url: 'https://www.instagram.com/accounts/login/' })
  eq(moved.ask.site, 'instagram', 'a new address renames the site rather than keeping the old name')

  const cold = M.askAgain(undefined, {})
  ok(!cold.ok, 'a pane that has never asked and names no page is refused')
  ok(/pf login https/.test(cold.why), 'and is told exactly what to type')
  const bad = M.askAgain(undefined, { url: 'facebook.com' })
  ok(!bad.ok, 'an address with no http(s) is refused')

  const reqs = [
    { id: 'a', at: 10, show: false },
    { id: 'b', at: 20, show: true },
    { id: 'c', at: 15, show: true }
  ]
  eq(M.raiseLogin(reqs, null), 'b', 'the newest picture a pane asked for is the one the window opens')
  eq(M.raiseLogin(reqs, 'b'), null, 'the one already open is never reopened')
  eq(M.raiseLogin([{ id: 'a', at: 1, show: false }], null), null, 'a card nobody asked to open stays a card')
}

// ----------------------------------------------------------------------- `pf login`
{
  const bad = pf(['login', 'facebook.com'])
  eq(bad.code, 1, 'an address with no http(s) refuses before the app is asked anything')
  ok(/http:\/\//.test(bad.err), 'and says what a page address looks like')
  const badPort = pf(['login', 'https://facebook.com/login', '--port', 'nine'])
  eq(badPort.code, 1, 'a port that is not a number refuses')
  ok(/'login'/.test(ctl) && /open: true/.test(ctl), '`pf login` asks for the picture, not a card')
  ok(/PF_PANE/.test(ctl), 'and says which pane is asking, so the app knows what it asked for last')
}

console.log(`remote-login: ${n} checks passed`)
