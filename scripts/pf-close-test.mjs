#!/usr/bin/env node
/**
 * `pf close <number>` never closes a pane the number may have moved onto.
 *
 * 2026-10-03 10:28am on the Mac: chat 7 read its own test pane as card 9. That pane closed
 * itself into Review at 10:21. At 10:28:30 a chat moved back from the PC landed on the desk
 * as the new card 9, and at 10:28:43 chat 7's `pf close 9` closed it, mid-turn, 13 s after it
 * arrived. A card number is the pane's place on the desk RIGHT NOW; an id never moves.
 *
 * Runs the real CLI against a stand-in app on this machine's loopback. No PaneForge.
 *
 *   node scripts/pf-close-test.mjs
 */
import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACHINE_NAME, localMachine } from './pf-ctl-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOUR = 3_600_000

/**
 * A stand-in app whose desk is `panes`; `sessions:kill` takes a pane off it. `peers` is
 * what `remote:state` answers; without it the call answers nothing, like an older app.
 */
async function app(panes, peers, { queued, kill, draft } = {}) {
  const killed = []
  // Every channel the CLI reached past `sessions:list` / `remote:state`, in order: a refusal
  // must leave this empty - nothing typed, armed, opened or closed.
  const acted = []
  const started = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/pf/pair') {
        res.writeHead(200, { 'set-cookie': 'pf=ok; Path=/' })
        return res.end('{}')
      }
      if (req.url === '/pf/send') {
        for (const c of JSON.parse(body).calls ?? []) acted.push(c.channel)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      const { channel, args } = JSON.parse(body)
      let value
      if (channel === 'sessions:list') value = panes
      else if (channel === 'remote:state') value = peers ? { peers } : undefined
      else {
        acted.push(channel)
        if (channel === 'sessions:kill') {
          killed.push(args[0])
          panes = panes.filter((p) => p.id !== args[0])
          // `kill(id, peers)` stands in for the computer that owns an `@` chat: what the app
          // answers, after taking the row off that computer's list or leaving it there.
          value = kill ? kill(args[0], peers) : true
        } else if (channel === 'sessions:closeWhenDone') value = true
        else if (channel === 'sessions:start') started.push(args[0]), value = { id: 's99-new', cwd: args[0].cwd, reportTo: args[0].reportTo }
        else if (channel === 'sessions:draft') value = draft ? draft(args[0]) : { text: 'half a line', certain: true, from: 'screen' }
        else if (channel === 'agents:list') value = [{ id: 'claude' }, { id: 'codex' }]
        else if (channel === 'pane:tell') value = { kind: 'delivered', id: args[0], title: 'x', at: Date.now(), how: 'typed', receipt: 'test' }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ value }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'pf-close-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ phone: { port: server.address().port, code: 'x' } }))
  if (queued) writeFileSync(join(dir, 'queued-prompts.json'), JSON.stringify(queued))
  return {
    dir,
    killed,
    acted,
    started,
    close: () => {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function pf(dir, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'scripts/pf-ctl.mjs'), ...args], {
      env: { ...process.env, PF_USER_DATA: dir, PF_PANE: '' }
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out: out.trim() }))
  })
}

/** The desk of 10:28:43: card 9 is the chat that arrived 13 s ago and is working. */
function desk() {
  const now = Date.now()
  const old = (id, title, status = 'idle') => ({ id, title, status, cwd: '/x', createdAt: now - HOUR })
  return [
    ...Array.from({ length: 6 }, (_, i) => old(`s${i + 1}-old`, `Chat ${i + 1}`)),
    old('s7-busy', 'Faster tests', 'working'),
    old('s8-quiet', 'Old quiet chat'),
    { id: 's35-murnlovm', title: 'Paneforge not showing in agent', status: 'working', cwd: '/x', createdAt: now - 13_000 },
    { id: 's36-fresh', title: 'Just opened', status: 'idle', cwd: '/x', createdAt: now - 20_000 }
  ]
}

let n = 0
async function check(name, fn) {
  await fn()
  n++
  console.log(`ok - ${name}`)
}

// The words every refusal opens with, after `pf-ctl: `.
const SHIFT = 'card numbers shift when a chat above closes'

await check('a number on a chat that just arrived and is working is refused, with its id', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '9')
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`refused: "9" is a card number, and ${SHIFT}.`), r.out)
    assert.match(r.out, /Card 9 is s35-murnlovm \(Paneforge not showing in agent\) right now - it is working and came onto the desk 1\d s ago; run: pf close s35-murnlovm$/)
    assert.deepEqual(a.acted, [])
  } finally {
    a.close()
  }
})

await check('a "PC 3" style label is refused, naming the pane and its id', async () => {
  const a = await app(desk())
  const label = `${MACHINE_NAME[localMachine()]} 10`
  try {
    const r = await pf(a.dir, 'close', label)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, new RegExp(`refused: "${label}" is a card label, and ${SHIFT}\\. ${label} is s36-fresh \\(Just opened\\) right now - it came onto the desk 2\\d s ago; run: pf close s36-fresh`), r.out)
    assert.deepEqual(a.acted, [])
  } finally {
    a.close()
  }
})

await check('a number on an old quiet pane is refused too - the number may still have moved', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '8')
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.endsWith(`Card 8 is s8-quiet (Old quiet chat) right now; run: pf close s8-quiet`), r.out)
    assert.deepEqual(a.acted, [])
  } finally {
    a.close()
  }
})

await check('a number naming no card lists the cards and points at pf list', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '42')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /There is no card 42 right now \(the cards are 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\); run pf list and use the id in column 2\./)
    assert.deepEqual(a.acted, [])
  } finally {
    a.close()
  }
})

await check('an id closes the arrived, working chat - an id never moves - and says which chat it was', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', 's35-murnlovm')
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, 'closed s35-murnlovm (Paneforge not showing in agent)')
    assert.deepEqual(a.killed, ['s35-murnlovm'])
  } finally {
    a.close()
  }
})

await check('tell, type, close-when-done and move refuse a number before touching anything', async () => {
  const cases = [
    [['tell', '7', 'commit', 'and', 'stop'], 'pf tell s7-busy commit and stop'],
    [['type', '7', 'yes'], 'pf type s7-busy yes'],
    [['close-when-done', '7'], 'pf close-when-done s7-busy'],
    [['move', '7', '--to', 'codex'], 'pf move s7-busy --to codex']
  ]
  for (const [args, again] of cases) {
    const a = await app(desk())
    try {
      const r = await pf(a.dir, ...args)
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`)
      assert.ok(r.out.includes(`refused: "7" is a card number, and ${SHIFT}. Card 7 is s7-busy (Faster tests) right now - it is working; run: ${again}`), r.out)
      assert.deepEqual(a.acted, [], args.join(' '))
    } finally {
      a.close()
    }
  }
})

await check('--report-to a number is refused on open and close-when-done, both flag spellings', async () => {
  const cases = [
    [['open', '/x', '--here', '--report-to', '3'], 'pf open /x --here --report-to s3-old'],
    [['open', '/x', '--report-to=3', '--here'], 'pf open /x --report-to=s3-old --here'],
    [['close-when-done', 's8-quiet', '--report-to', '3'], 'pf close-when-done s8-quiet --report-to s3-old'],
    [['close-when-done', 's8-quiet', `--report-to=${MACHINE_NAME[localMachine()]} 3`], 'pf close-when-done s8-quiet --report-to=s3-old']
  ]
  for (const [args, again] of cases) {
    const a = await app(desk())
    try {
      const r = await pf(a.dir, ...args)
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`)
      assert.match(r.out, new RegExp(`is a card (number|label), and ${SHIFT}\\.`), r.out)
      assert.ok(r.out.includes(`is s3-old (Chat 3) right now; run: ${again}`), r.out)
      assert.deepEqual(a.acted, [], args.join(' '))
    } finally {
      a.close()
    }
  }
})

await check('--report-to an id goes through, on open and on close-when-done', async () => {
  const a = await app(desk())
  try {
    const opened = await pf(a.dir, 'open', '/x', '--here', '--report-to=s3-old')
    assert.equal(opened.code, 0, opened.out)
    const armed = await pf(a.dir, 'close-when-done', 's8-quiet', '--report-to', 's3-old')
    assert.equal(armed.code, 0, armed.out)
    assert.equal(armed.out, 's8-quiet (Old quiet chat) will close itself once it is done')
    assert.deepEqual(a.acted, ['sessions:start', 'sessions:closeWhenDone'])
    assert.equal(a.started[0].reportTo, 's3-old')
  } finally {
    a.close()
  }
})

await check('a command that only reads still takes a number', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'composer', '8')
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, 'half a line')
    assert.deepEqual(a.acted, ['sessions:draft'])
  } finally {
    a.close()
  }
})

// The Mac's panes on the PC desk: one mirrored (in `sessions:list`), one only listed.
function pairedDesk() {
  const now = Date.now()
  return {
    panes: [
      { id: 's1-own', number: 1, label: 'PC 1', title: 'Own chat', status: 'idle', cwd: '/x', createdAt: now - HOUR },
      { id: '@mac/s3-m', number: 3, label: 'Mac 3', title: 'Mirrored chat', status: 'idle', cwd: '/m', createdAt: now - HOUR, remote: { device: 'mac', name: 'MacBook', machine: 'mac' } }
    ],
    peers: [
      { id: 'mac', name: 'MacBook', status: 'online', panes: [
        { id: 's3-m', number: 3, machine: 'mac', watched: true, title: 'Mirrored chat', status: 'idle', cwd: '/m' },
        { id: 's5-m', number: 5, machine: 'mac', watched: false, title: 'Listed chat', status: 'working', cwd: '/m' }
      ] },
      { id: 'old', name: 'Old Mac', status: 'online', panes: [{ id: 's2-o', watched: false, title: 'No number', status: 'idle', cwd: '/o' }] }
    ]
  }
}


await check("pf list: column 1 is the card label, and a paired computer's listed pane follows with its own label", async () => {
  const d = pairedDesk()
  const a = await app(d.panes, d.peers)
  try {
    const r = await pf(a.dir, 'list')
    assert.equal(r.code, 0, r.out)
    const rows = r.out.split('\n').map((l) => l.split('\t').slice(0, 2))
    // An older Mac that sent no number has no label to print, so its row is left out.
    assert.deepEqual(rows, [['PC 1', 's1-own'], ['Mac 3', '@mac/s3-m'], ['Mac 5', '@mac/s5-m']])
  } finally {
    a.close()
  }
})

await check('a label names a pane by its computer; mirrored or listed, closing it by label is refused with its id', async () => {
  const d = pairedDesk()
  const a = await app(d.panes, d.peers)
  try {
    const listed = await pf(a.dir, 'close', 'mac5')
    assert.equal(listed.code, 1, listed.out)
    assert.match(listed.out, /Mac 5 is @mac\/s5-m \(Listed chat\) right now - it is working and runs on the Mac and is not open on this desk; open it here first, or on the Mac run: pf close s5-m$/)
    const none = await pf(a.dir, 'close', 'PC 9')
    assert.equal(none.code, 1, none.out)
    assert.match(none.out, /There is no PC 9 right now \(the cards are PC 1, Mac 3\)/)
    // A bare 3 is this computer's pane 3, never the Mac's - and there is none here.
    assert.match((await pf(a.dir, 'close', '3')).out, /There is no card 3 right now/)
    const mirrored = await pf(a.dir, 'close', 'Mac 3')
    assert.equal(mirrored.code, 1, mirrored.out)
    assert.match(mirrored.out, /Mac 3 is @mac\/s3-m \(Mirrored chat\) right now; run: pf close @mac\/s3-m$/)
    assert.deepEqual(a.acted, [])
    const byId = await pf(a.dir, 'close', '@mac/s3-m')
    assert.equal(byId.code, 0, byId.out)
    assert.deepEqual(a.killed, ['@mac/s3-m'])
  } finally {
    a.close()
  }
})

// `pf close @device/id` for a chat `pf list` shows from the other computer but this desk does
// not mirror: the help said it worked, and it answered "no pane named" (2026-10-03 review).
// The computer that owns it closes it; pf says closed only when the app says it is gone.
const dropFrom = (peers, ref) => {
  for (const p of peers) p.panes = p.panes.filter((x) => `@${p.id}/${x.id}` !== ref)
}

await check('pf close closes a listed, unmirrored chat on the other computer by its id', async () => {
  const d = pairedDesk()
  const a = await app(d.panes, d.peers, { kill: (id, peers) => (dropFrom(peers, id), { closed: true }) })
  try {
    const r = await pf(a.dir, 'close', '@mac/s5-m')
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, 'closed @mac/s5-m (Listed chat)')
    assert.deepEqual(a.killed, ['@mac/s5-m'])
  } finally {
    a.close()
  }
})

await check('pf close says so when the other computer did not close the chat', async () => {
  const d = pairedDesk()
  const reason = 'the Mac did not close it within 3 seconds; run pf list to see whether it is still open'
  const a = await app(d.panes, d.peers, { kill: () => ({ closed: false, reason }) })
  try {
    const r = await pf(a.dir, 'close', '@mac/s5-m')
    assert.equal(r.code, 1, r.out)
    assert.equal(r.out, `pf-ctl: @mac/s5-m (Listed chat) was not closed: ${reason}`)
  } finally {
    a.close()
  }
})

await check('pf close on a chat id no computer lists still says there is no such chat', async () => {
  const d = pairedDesk()
  const a = await app(d.panes, d.peers)
  try {
    const r = await pf(a.dir, 'close', '@mac/s9-gone')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /no pane named "@mac\/s9-gone"/)
    assert.deepEqual(a.acted, [])
  } finally {
    a.close()
  }
})

// `pf composer @device/id` printed "is not running" (s54, 2026-10-03): the app looked for the
// chat among its own and found nothing. It is asked of the computer the chat runs on.
await check('pf composer reads the input box of a listed chat on the other computer', async () => {
  const d = pairedDesk()
  const asked = []
  const a = await app(d.panes, d.peers, { draft: (id) => (asked.push(id), { text: 'Try this later', certain: true, from: 'screen' }) })
  try {
    const r = await pf(a.dir, 'composer', '@mac/s5-m')
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, 'Try this later')
    assert.deepEqual(asked, ['@mac/s5-m'])
  } finally {
    a.close()
  }
})

await check('pf composer says plainly when the other computer cannot be asked', async () => {
  const d = pairedDesk()
  const why = 'the Mac runs an older PaneForge that cannot say what is typed in its chats; update PaneForge there'
  const a = await app(d.panes, d.peers, { draft: () => ({ unavailable: why }) })
  try {
    const r = await pf(a.dir, 'composer', '@mac/s3-m')
    assert.equal(r.code, 1, r.out)
    assert.equal(r.out, `pf-ctl: could not read the input box of @mac/s3-m (Mirrored chat): ${why}`)
  } finally {
    a.close()
  }
})

await check('pf list adds a sixth column only for a pane owed a prompt or holding one never sent', async () => {
  const now = Date.now()
  const at = new Date(2026, 9, 2, 4, 10).getTime()
  const panes = [
    { id: 's1-plain', number: 1, title: 'Plain', status: 'idle', cwd: '/a', createdAt: now - HOUR },
    { id: 's2-owed', number: 2, title: 'Owed', status: 'working', cwd: '/b', createdAt: now - HOUR, owedPrompt: true },
    { id: 's3-unsent', number: 3, title: 'Unsent', status: 'working', cwd: '/c', createdAt: now - HOUR, promptUnsent: at },
    { id: '@pc/s4-far', number: 4, label: 'PC 4', title: 'Far', status: 'working', cwd: 'C:\\\\x', createdAt: now - HOUR, owedPrompt: true, remote: { device: 'pc', name: 'PC', machine: 'pc' } }
  ]
  const peers = [{ id: 'pc', name: 'PC', status: 'online', panes: [
    { id: 's4-far', number: 4, machine: 'pc', watched: true, title: 'Far', status: 'working', cwd: 'C:\\\\x' },
    { id: 's6-listed', number: 6, machine: 'pc', watched: false, title: 'Listed', status: 'idle', cwd: 'C:\\\\y', promptUnsent: at }
  ] }]
  const queued = {
    k1: { id: 's2-owed', key: 'k1', text: 'later one', at: at + 60_000 },
    k2: { id: 's2-owed', key: 'k2', text: 'first one', at }
  }
  const a = await app(panes, peers, { queued })
  try {
    const r = await pf(a.dir, 'list')
    assert.equal(r.code, 0, r.out)
    const rows = r.out.split('\n').map((l) => l.split('\t'))
    assert.deepEqual(rows.map((c) => c.slice(0, 2)), [['1', 's1-plain'], ['2', 's2-owed'], ['3', 's3-unsent'], ['PC 4', '@pc/s4-far'], ['PC 6', '@pc/s6-listed']])
    assert.equal(rows[0].length, 5, rows[0].join('|'))
    assert.deepEqual(rows[1].slice(2), ['working', 'Owed', '/b', 'prompt waiting since 4:10am Fri'])
    assert.equal(rows[2][5], 'prompt not sent - still in its input box')
    assert.equal(rows[3][5], 'prompt waiting')
    assert.equal(rows[4][5], 'prompt not sent - still in its input box')
  } finally {
    a.close()
  }
})

console.log(`\n${n} checks passed`)
