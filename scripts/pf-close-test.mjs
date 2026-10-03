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
async function app(panes, peers) {
  const killed = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/pf/pair') {
        res.writeHead(200, { 'set-cookie': 'pf=ok; Path=/' })
        return res.end('{}')
      }
      const { channel, args } = JSON.parse(body)
      let value
      if (channel === 'sessions:list') value = panes
      else if (channel === 'remote:state' && peers) value = { peers }
      else if (channel === 'sessions:kill') {
        killed.push(args[0])
        panes = panes.filter((p) => p.id !== args[0])
        value = true
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ value }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'pf-close-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ phone: { port: server.address().port, code: 'x' } }))
  return {
    dir,
    killed,
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

await check('a number on a chat that just arrived and is working is refused, with its id', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '9')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /card 9 is "Paneforge not showing in agent" \(s35-murnlovm\)/)
    assert.match(r.out, /pf close s35-murnlovm/)
    assert.match(r.out, /it may not be the pane you read as 9/)
    assert.deepEqual(a.killed, [])
  } finally {
    a.close()
  }
})

await check('a "PC 3" style label on a pane that came onto the desk under two minutes ago is refused', async () => {
  const a = await app(desk())
  const label = `${MACHINE_NAME[localMachine()]} 10`
  try {
    const r = await pf(a.dir, 'close', label)
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`card ${label} is "Just opened" (s36-fresh)`), r.out)
    assert.match(r.out, /came onto the desk 20 s ago/)
    assert.match(r.out, /pf close s36-fresh/)
    assert.deepEqual(a.killed, [])
  } finally {
    a.close()
  }
})

await check('a number on a pane that came onto the desk under two minutes ago is refused', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '10')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /came onto the desk 20 s ago/)
    assert.deepEqual(a.killed, [])
  } finally {
    a.close()
  }
})

await check('a number on an old pane that is working is refused', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '7')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /is working right now/)
    assert.deepEqual(a.killed, [])
  } finally {
    a.close()
  }
})

await check('a number on an old quiet pane still closes it', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', '8')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /closed s8-quiet/)
    assert.deepEqual(a.killed, ['s8-quiet'])
  } finally {
    a.close()
  }
})

await check('an id closes the arrived, working chat - an id never moves', async () => {
  const a = await app(desk())
  try {
    const r = await pf(a.dir, 'close', 's35-murnlovm')
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(a.killed, ['s35-murnlovm'])
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

await check('a label names a pane by its computer; a listed-only pane is refused, not closed', async () => {
  const d = pairedDesk()
  const a = await app(d.panes, d.peers)
  try {
    const listed = await pf(a.dir, 'close', 'mac5')
    assert.equal(listed.code, 1, listed.out)
    assert.match(listed.out, /Mac 5 runs on the Mac and is not open on this desk/)
    const none = await pf(a.dir, 'close', 'PC 9')
    assert.equal(none.code, 1, none.out)
    assert.match(none.out, /there is no pane PC 9 - the cards on the desk are PC 1, Mac 3/)
    // A bare 3 is this computer's pane 3, never the Mac's - and there is none here.
    assert.equal((await pf(a.dir, 'close', '3')).code, 1)
    const mirrored = await pf(a.dir, 'close', 'Mac 3')
    assert.equal(mirrored.code, 0, mirrored.out)
    assert.deepEqual(a.killed, ['@mac/s3-m'])
  } finally {
    a.close()
  }
})

console.log(`\n${n} checks passed`)
