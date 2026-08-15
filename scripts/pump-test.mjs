// The pty-output pump has one contract: the renderer must receive exactly the bytes
// the pty produced, in order, per pane - just in far fewer messages.
//
//   node scripts/pump-test.mjs
//
// Compiled straight out of the source file, like outbuffer-test.mjs, so there is no
// second copy of the logic here to drift from the one that ships.
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/main/dataPump.ts')
assert.ok(existsSync(src), 'src/main/dataPump.ts is missing')

const tsc = (await import('typescript')).default
const js = tsc.transpileModule(readFileSync(src, 'utf8').replace(/^export /gm, ''), {
  compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.None }
}).outputText
const DataPump = new Function(`${js}; return DataPump`)()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// --- 1. Nothing goes out before the tick, everything goes out on it. ------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.push('a', 'one ')
  pump.push('a', 'two ')
  pump.push('a', 'three')
  check('held until the tick', sent.length === 0)
  await sleep(40)
  check('one message, not three', sent.length === 1)
  check('bytes are intact and in order', sent[0][1] === 'one two three')
  check('nothing left waiting', pump.waiting === 0)
}

// --- 2. Panes never bleed into each other. --------------------------------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  for (let i = 0; i < 50; i++) {
    pump.push('a', `a${i};`)
    pump.push('b', `b${i};`)
  }
  await sleep(40)
  const byId = Object.fromEntries(sent.map(([id, d]) => [id, d]))
  const expectA = Array.from({ length: 50 }, (_, i) => `a${i};`).join('')
  const expectB = Array.from({ length: 50 }, (_, i) => `b${i};`).join('')
  check('two panes, two messages', sent.length === 2)
  check('pane a is exactly its own bytes', byId.a === expectA)
  check('pane b is exactly its own bytes', byId.b === expectB)
}

// --- 3. The real measured load: 7,359 chunks/sec collapses to a handful. --------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  let expect = ''
  for (let i = 0; i < 7359; i++) {
    const chunk = 'x'.repeat(41)
    expect += chunk
    pump.push('a', chunk)
  }
  pump.flush()
  const joined = sent.map(([, d]) => d).join('')
  check('every byte survives the burst', joined === expect)
  // 7359 * 41 = 301,719 bytes, so MAX_PENDING (64 KB) forces 4 early sends plus the
  // final flush. Five messages instead of 7,359 is the whole point of the file.
  check(`burst sent as ${sent.length} messages, not 7359`, sent.length <= 8)
}

// --- 4. Exit and teardown paths. ------------------------------------------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.push('a', 'last words')
  pump.push('b', 'still going')
  pump.flushOne('a')
  check('flushOne sends only that pane', sent.length === 1 && sent[0][0] === 'a')
  check("the other pane's output is still waiting", pump.waiting === 'still going'.length)
  pump.discard()
  await sleep(40)
  check('discard drops the rest and cancels the tick', sent.length === 1)
  check('nothing waiting after discard', pump.waiting === 0)
}

// --- 5. Empty pushes and empty flushes are no-ops, not messages. ----------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.push('a', '')
  pump.flush()
  await sleep(40)
  check('an empty chunk sends nothing', sent.length === 0)
}

// --- 6. A pane nobody is looking at is gathered for longer. ---------------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.setVisible('desk', ['a'])
  pump.push('a', 'seen')
  pump.push('b', 'unseen')
  await sleep(40)
  check('the visible pane went out on the fast tick', sent.length === 1 && sent[0][0] === 'a')
  check('the hidden pane is still waiting', pump.waiting === 'unseen'.length)
  await sleep(110)
  check('and goes out on the slow one', sent.length === 2 && sent[1][0] === 'b')
  check('with its bytes intact', sent[1][1] === 'unseen')
}

// --- 7. Coming back on screen never shows a stale frame. ------------------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.setVisible('desk', ['a'])
  pump.push('b', 'while you were away')
  await sleep(20)
  check('nothing sent yet for the hidden pane', sent.length === 0)
  pump.setVisible('desk', ['b'])
  check('claiming it visible flushes it at once', sent.length === 1 && sent[0][1] === 'while you were away')
}

// --- 7b. Two screens, and neither erases the other. -----------------------------
// The desk and each phone are separate screens: keyed together, the second one to
// speak takes the first one's panes away and its pane starts stuttering.
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.setVisible('desk', ['a'])
  pump.setVisible('phone1', ['b'])
  pump.setVisible('phone2', ['c'])
  pump.push('a', 'A')
  pump.push('b', 'B')
  pump.push('c', 'C')
  pump.push('d', 'D')
  await sleep(40)
  const fast = sent.map(([id]) => id).sort().join('')
  check('every screen keeps its own pane on the fast tick', fast === 'abc')
  check('the pane nobody has on screen is still waiting', pump.waiting === 1)
}

// --- 7c. A screen that goes away without saying so stops counting. --------------
// A phone that is closed, locked or out of range never sends a parting message, so
// a claim that did not expire would keep its panes fast for the life of the process.
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  const realNow = Date.now
  try {
    pump.setVisible('desk', ['a'])
    pump.setVisible('phone', ['b'])
    // Two minutes later the phone has said nothing since. The desk is still talking.
    const later = realNow() + 120_000
    Date.now = () => later
    pump.setVisible('desk', ['a'])
    pump.push('b', 'nobody is watching this')
    check('the dead claim no longer buys a fast tick', pump.waiting === 'nobody is watching this'.length)
    // Its deadline was written against the fake clock, so flushing is what proves the
    // bytes are intact rather than waiting for a tick 120s in the future.
    pump.flush()
    check('and the bytes are still exactly right', sent.length === 1 && sent[0][1] === 'nobody is watching this')
  } finally {
    Date.now = realNow
  }
}

// --- 7d. A claim from a paired phone is not trusted for its size. ---------------
{
  const pump = new DataPump(() => {})
  pump.setVisible('phone', Array.from({ length: 5000 }, (_, i) => `p${i}`))
  pump.push('p4999', 'past the cap')
  check('a huge claim is cut to the cap, not stored whole', pump.waiting === 'past the cap'.length)
}

// --- 8. A steadily printing pane still flushes on time. ------------------------
// The deadline belongs to the oldest byte waiting. Keyed on the newest, a pane
// printing every few ms would push its own flush forward for ever.
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  const t0 = Date.now()
  const timer = setInterval(() => pump.push('a', '.'), 2)
  await sleep(40)
  clearInterval(timer)
  check('a steady stream is not starved', sent.length > 0)
  check('and the first message came within a frame', sent.length > 0 && Date.now() - t0 < 60)
}

// --- 9. What this actually saves: a real desk, one pane on screen. --------------
// The measured load (7,359 chunks/sec, median 41 bytes) across six panes, one of
// them being read. Message counts, not a claim.
{
  const count = (visible) => {
    let n = 0
    const pump = new DataPump(() => n++)
    if (visible) pump.setVisible('desk', ['p0'])
    // One second of the measured rate, spread over six panes, replayed against a
    // clock the pump reads for real - so the ticks are counted the way they fire.
    const per = Math.round(7359 / 6)
    let now = Date.now()
    const realNow = Date.now
    // finally, not a line after the loop: a throw in here would otherwise leave the
    // fake clock installed for every check below it.
    try {
      for (let i = 0; i < per; i++) {
        Date.now = () => now
        for (let p = 0; p < 6; p++) pump.push(`p${p}`, 'x'.repeat(41))
        // Fire whatever tick the wall clock would have fired by here.
        now += 1000 / per
        Date.now = () => now
        pump.tick?.()
      }
    } finally {
      Date.now = realNow
    }
    return n
  }
  // tick() is private in TS but present at runtime; if it ever goes, this reads 0
  // messages and the check below fails rather than passing quietly.
  const before = count(false)
  const after = count(true)
  console.log(`     six panes, one second: ${before} messages -> ${after} with visibility`)
  check('the measurement ran at all', before > 20)
  check(`hidden panes cost less (${before} -> ${after})`, after < before * 0.6)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pump checks passed')
process.exit(failures ? 1 : 0)
