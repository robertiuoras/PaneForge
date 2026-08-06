// A mac update download that goes wrong must SAY SO. Silence is the bug.
//
// v0.4.62 stopped at exactly 30 MiB of a 95.8 MB zip on 2026-08-06 and `fetchTo` never
// settled - not resolved, not rejected. Because `offerMac` only clears `macStaging` in
// that promise's then/catch, and `busy()` refuses every check while the phase is
// `downloading`, the badge sat on 33% and the app stopped looking for updates entirely.
// Fourteen hours, and not one line in updater.log to find it by.
//
// So this asserts the only property that matters: every way a download can end, ends the
// promise. A real TLS server, a real socket, real partial bodies.
//
//   node scripts/mac-download-test.mjs

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-mac-download-test-'))

// The watchdog is a minute in the app, which is right for a bad hotel connection and
// wrong for a test. This is the only thing that reads the variable.
const STALL_MS = 1200
process.env.PF_DOWNLOAD_STALL_MS = String(STALL_MS)

// A self-signed cert, so the server is a REAL https one - `fetchTo` uses node:https and
// swapping it for http here would test a code path the app never runs.
let key = ''
let cert = ''
try {
  execFileSync(
    'openssl',
    // prettier-ignore
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'k.pem'),
      '-out', join(work, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' }
  )
  key = readFileSync(join(work, 'k.pem'), 'utf8')
  cert = readFileSync(join(work, 'c.pem'), 'utf8')
} catch (e) {
  console.log('SKIP mac-download-test: openssl could not make a test certificate -', String(e.message || e))
  rmSync(work, { recursive: true, force: true })
  process.exit(0)
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')}}
`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/macUpdate.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'macUpdate.bundle.cjs'),
  alias: { electron: join(work, 'electron-stub.cjs') }
})

const m = createRequire(join(work, 'x.cjs'))('./macUpdate.bundle.cjs')
m.setMacUpdateLog(() => {})

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

// 40 KB of body, announced honestly in Content-Length. Each route below lies about it in
// a different way, which is the whole point.
const BODY = Buffer.alloc(40_000, 7)

const server = createServer({ key, cert }, (req, res) => {
  if (req.url === '/missing') {
    res.writeHead(404)
    return res.end('no')
  }
  res.writeHead(200, { 'content-length': String(BODY.length) })
  if (req.url === '/whole') return res.end(BODY)
  // Both of the failures start the same way: some of the body arrives, the percentage
  // moves, and then the connection does one of the two things it can do.
  res.write(BODY.subarray(0, 10_000))
  if (req.url === '/dropped') setTimeout(() => res.socket?.destroy(), 30)
  // '/stalled': write nothing more, ever, and hold the socket open.
})

const settled = (p) => p.then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e?.message ?? e) }))

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `https://127.0.0.1:${server.address().port}`

try {
  // --- the ordinary case, so a watchdog that fires too eagerly is caught here ---------
  const good = join(work, 'good.bin')
  let top = -1
  const a = await settled(m.fetchTo(`${base}/whole`, good, (p) => (top = Math.max(top, p))))
  ok(a.ok, 'a whole body resolves', a.message)
  ok(statSync(good).size === BODY.length, 'and the file on disk is the whole body', a.ok ? statSync(good).size : 'n/a')
  ok(top === 100, 'and the percentage reaches 100', top)

  // --- the connection dies mid-body: THE v0.4.62 CASE ---------------------------------
  const dropped = join(work, 'dropped.bin')
  const started = Date.now()
  const b = await settled(m.fetchTo(`${base}/dropped`, dropped, () => {}))
  ok(!b.ok, 'a body that stops arriving REJECTS rather than hanging', b.message)
  ok(/10000 of 40000/.test(b.message ?? ''), 'and says how far it got', b.message)
  // It must not wait out the watchdog: a dropped socket is knowable immediately, and the
  // difference between the two is a minute of a user watching a frozen percentage.
  ok(Date.now() - started < STALL_MS, 'and does not sit there until the stall timer', Date.now() - started)

  // --- the connection stays open and sends nothing more --------------------------------
  const stalled = join(work, 'stalled.bin')
  const at = Date.now()
  const c = await settled(m.fetchTo(`${base}/stalled`, stalled, () => {}))
  const took = Date.now() - at
  ok(!c.ok, 'a half-open connection REJECTS on the stall watchdog', c.message)
  ok(/stalled at 10000 of 40000/.test(c.message ?? ''), 'and names the byte it stopped on', c.message)
  ok(took >= STALL_MS && took < STALL_MS * 6, 'and waits about one watchdog, not for ever', took)

  // --- a status nobody can download ----------------------------------------------------
  const d = await settled(m.fetchTo(`${base}/missing`, join(work, 'missing.bin'), () => {}))
  ok(!d.ok && /404/.test(d.message ?? ''), 'a 404 rejects with its status', d.message)
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall passed')
process.exit(fail.length ? 1 : 0)
