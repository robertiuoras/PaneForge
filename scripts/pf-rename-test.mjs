#!/usr/bin/env node
/**
 * `pf rename` of a pane that lives on the OTHER computer.
 *
 * 2026-09-29 9:16am on the Mac: `pf rename 12 "PC disk cleanup"` printed `sessions:rename
 * answered but @e38080cc645760c5/s13-mulu3uhw is still "assistant"` - and minutes later the
 * card said "PC disk cleanup". A PC pane is renamed BY THE PC, and its new name comes back
 * with that desk's next list; pf-ctl read the list once, at once, and called a rename that
 * was still on its way a failure. A second one at 9:36am landed before the read.
 *
 * Runs the real CLI against a stand-in app on this machine's loopback: the list says the
 * new name only after a delay, like the PC's does. No PaneForge, no other computer.
 *
 *   node scripts/pf-rename-test.mjs
 */
import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PC_PANE = '@e38080cc645760c5/s13-mulu3uhw'

/** A stand-in app: `lands` ms after a rename the list says it; `linkUp` false = the PC is gone. */
async function app({ lands, linkUp = true }) {
  const timers = []
  const pane = { id: PC_PANE, title: 'assistant', cwd: 'C:\\Users\\Gamer\\Desktop\\Projects\\assistant', status: 'working' }
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
      if (channel === 'sessions:list') value = [pane]
      else if (channel === 'sessions:rename') {
        if (linkUp) timers.push(setTimeout(() => (pane.title = args[1]), lands))
        value = linkUp
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ value }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'pf-rename-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ phone: { port: server.address().port, code: 'x' } }))
  return {
    dir,
    close: () => {
      timers.forEach(clearTimeout)
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

let n = 0
async function check(name, fn) {
  await fn()
  n++
  console.log(`ok - ${name}`)
}

await check('a rename that lands a moment later on the other computer is a rename', async () => {
  const a = await app({ lands: 700 })
  try {
    const r = await pf(a.dir, 'rename', PC_PANE, 'PC', 'disk', 'cleanup')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /renamed .* \(assistant -> PC disk cleanup\)/)
  } finally {
    a.close()
  }
})

await check('a rename that never lands still fails, and says what the card still says', async () => {
  const a = await app({ lands: 60_000 })
  try {
    const r = await pf(a.dir, 'rename', PC_PANE, 'PC disk cleanup')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /answered but .* is still "assistant"/)
  } finally {
    a.close()
  }
})

await check('a rename the link could not carry says the computer is not connected', async () => {
  const a = await app({ lands: 0, linkUp: false })
  try {
    const r = await pf(a.dir, 'rename', PC_PANE, 'PC disk cleanup')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /not connected/)
  } finally {
    a.close()
  }
})

console.log(`\n${n} checks passed`)
