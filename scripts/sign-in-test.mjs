// A job that cannot sign in: `pf needs-login` puts a "needs you" card up and marks the
// pane that asked - and does nothing else.
//
//   node scripts/sign-in-test.mjs
//
// The command is driven end to end: the real `pf-ctl.mjs` talks to a stand-in for the
// app's local server, which hands the ask to the real main-process module. No window,
// no Chrome, no ssh.
//
// Why the "nothing else" half is pinned: until 2026-09-25 the same command could open a
// live picture of the automation browser beside the chat (an ssh tunnel and a CDP
// screencast). A Claude pane asked for a Keap sign-in at 05:10 that morning, the picture
// opened on the desk by itself, and 2 s later it said "looks signed in" on Keap's own
// sign-in page. Robert: "remove this feature ... its terrible and doesnt work properly".

import { build } from 'esbuild'
import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), `pf-sign-in-test-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const require = createRequire(import.meta.url)

let n = 0
const ok = (cond, why, detail = '') => {
  n++
  assert.ok(cond, `${why}${detail ? `\n  ${detail}` : ''}`)
  console.log(`ok ${n} - ${why}`)
}
const eq = (got, want, why) => {
  n++
  assert.deepEqual(got, want, why)
  console.log(`ok ${n} - ${why}`)
}

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
      contents: `exports.app={getPath:()=>${JSON.stringify(work)}}`,
      loader: 'js'
    }))
  }
}
async function bundle(entry, name) {
  const out = join(work, name)
  const r = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    metafile: true,
    plugins: [stubs]
  })
  return { mod: require(out), meta: r.metafile }
}

// ------------------------------------------------------------------ the words
const { mod: W } = await bundle('src/shared/signIn.ts', 'words.cjs')
{
  const at = Date.UTC(2026, 8, 25, 5, 10)
  const card = W.loginCardText(
    { site: 'keap', url: 'https://hs700.infusionsoft.com', machine: 'this Mac', fromName: 'Angie C. | clients', at },
    at + 3 * 60000
  )
  eq(card.title, 'Keap needs you to sign in', 'the card names the site and says it needs you')
  ok(card.body.includes('https://hs700.infusionsoft.com'), 'the card carries the address to sign in at', card.body)
  ok(card.body.includes('this Mac'), 'and which computer to do it on')
  eq(card.who, 'Angie C. | clients on this Mac - waiting 3 min', 'and which pane is waiting, and for how long')
  ok(!/open|picture|tunnel/i.test(`${card.body} ${card.done}`), 'and promises nothing that opens', card.body)
  ok(
    W.paneChipTitle({ site: 'keap', url: 'https://x.test/login', machine: 'the PC' }).includes('https://x.test/login'),
    "the pane row's chip says the site and the address on hover"
  )
}

// ------------------------------------------------------------------ the main process
const { mod: M, meta } = await bundle('src/main/signIn.ts', 'main.cjs')
{
  // Nothing in what main runs for a sign-in can open a connection or start a process.
  const inputs = Object.keys(meta.inputs).join('\n')
  const bundled = readFileSync(join(work, 'main.cjs'), 'utf8')
  for (const mod of ['child_process', 'node:net', 'ws', 'node:http', 'node:https'])
    ok(!bundled.includes(`require("${mod}")`), `the sign-in module does not load ${mod}`)
  ok(!/remote[-]?login/i.test(inputs), 'and pulls in nothing of the old picture', inputs)
  ok(!/WebSocket|Page\.|Input\.dispatch|ssh|9333/.test(bundled), 'and has no CDP, ssh or debugger port in it')
}
const published = []
const told = []
M.initSignIn({
  publish: (reqs) => published.push(reqs),
  paneName: (id) => (id === 's133-mufuvm5m' ? 'Angie C. | clients' : undefined),
  tell: (pane, text) => {
    told.push([pane, text])
    return pane !== 'gone'
  }
})

// ------------------------------------------------------------------ `pf` end to end
// A stand-in for the app's local server: it pairs, and hands `login:need` to the real
// module. Every call it sees is recorded, so the test can say what `pf` asked for.
const calls = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/pf/pair') {
      res.writeHead(200, { 'set-cookie': 'pf=ok; Path=/', 'content-type': 'application/json' })
      return res.end('{}')
    }
    const { channel, args } = JSON.parse(body || '{}')
    calls.push({ path: req.url, channel, args })
    let out
    try {
      if (channel === 'login:need') out = { value: M.requestLogin(args[0]) }
      else if (channel === 'login:list') out = { value: M.listLogins() }
      else if (channel === 'sessions:list') out = { value: [] }
      else out = { error: `unknown channel ${channel}` }
    } catch (e) {
      out = { error: String(e?.message ?? e) }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const userData = join(work, 'userData')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ phone: { port, code: 'TEST' } }))

function pf(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, 'scripts/pf-ctl.mjs'), ...args],
      { cwd: root, env: { ...process.env, PF_USER_DATA: userData, PF_PANE: 's133-mufuvm5m', ...env } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout, err: stderr })
    )
  })
}

const got = await pf(['needs-login', 'keap', '--url', 'https://hs700.infusionsoft.com', '--why', 'finish the footer check'])
eq(got.code, 0, '`pf needs-login` succeeds')
ok(/^login-\S+\n$/.test(got.out), 'and prints the request id', JSON.stringify(got.out))
const need = calls.filter((c) => c.channel === 'login:need')
eq(need.length, 1, 'it made exactly one ask of the app')
eq(
  need[0].args,
  [{ site: 'keap', url: 'https://hs700.infusionsoft.com', why: 'finish the footer check', from: 's133-mufuvm5m' }],
  'and the ask is the site, the address, the reason and the pane - nothing to open, no host, no port'
)
eq(
  calls.map((c) => c.channel),
  ['login:need'],
  'and it called nothing else: no open, no picture, no input'
)
const [req] = M.listLogins()
eq(
  { site: req.site, url: req.url, machine: req.machine, from: req.from, fromName: req.fromName },
  {
    site: 'keap',
    url: 'https://hs700.infusionsoft.com',
    machine: process.platform === 'darwin' ? 'this Mac' : 'this PC',
    from: 's133-mufuvm5m',
    fromName: 'Angie C. | clients'
  },
  'the desk holds one card naming the site, the address, the computer and the pane that asked'
)
eq(Object.keys(req).sort(), ['at', 'from', 'fromName', 'id', 'machine', 'site', 'url', 'why'], 'and the card has no state to open, no host and no port')
ok(published.length === 1 && published[0].length === 1, 'the window was told once, so it draws the card and marks the pane')

// The same site asked again - a sweep every ten minutes - is still one card.
await pf(['needs-login', 'keap', '--url', 'https://login.labs.thryv.com/u/login/identifier'])
eq(M.listLogins().length, 1, 'asking again for the same site is one card, not a pile')
eq(M.listLogins()[0].url, 'https://login.labs.thryv.com/u/login/identifier', 'with the newer address on it')

// `pf list` shows it beside the panes, as a card that needs a person.
calls.length = 0
const listed = await pf(['list'])
eq(listed.code, 0, '`pf list` succeeds')
ok(
  listed.out.includes(`${req.id}\tneeds you\tSign in to keap on`),
  '`pf list` shows the request as needing a person',
  listed.out
)

// The flags that used to open the picture or reach the other computer are refused by
// name, before the app is asked for anything.
for (const extra of [['--open'], ['--host', 'Gamer@100.78.1.77'], ['--port', '9333'], ['--desk', 'robert@100.89.94.66'], ['--report-to', 's1']]) {
  calls.length = 0
  const r = await pf(['needs-login', 'keap', '--url', 'https://keap.com/login', ...extra])
  eq(r.code, 1, `${extra[0]} is refused`)
  ok(r.err.includes(`${extra[0]} was removed`), `and says it was removed`, r.err)
  eq(calls.length, 0, 'and nothing reached the app')
}
const oldWord = await pf(['login', 'https://keap.com/login'])
eq(oldWord.code, 1, '`pf login` is gone')
ok(oldWord.err.includes('pf needs-login <site> --url <url>'), 'and names the command that replaced it', oldWord.err)
const bad = await pf(['needs-login', 'keap', '--url', 'keap.com'])
eq(bad.code, 1, 'an address with no http(s) is refused')
const noSite = await pf(['needs-login'])
eq(noSite.code, 1, 'an ask naming no site is refused')

server.close()

// ------------------------------------------------------------------ the card's buttons
{
  const id = M.listLogins()[0].id
  M.doneLogin(id)
  eq(told.length, 1, 'Signed in tells the pane that asked')
  eq(told[0][0], 's133-mufuvm5m', 'and tells that pane, not another')
  ok(/Signed in to Keap/.test(told[0][1]) && /carry on/.test(told[0][1]), 'in a sentence an agent can act on', told[0][1])
  eq(M.listLogins().length, 0, 'and the card goes')
  M.doneLogin(id)
  eq(told.length, 1, 'pressing it twice tells nobody twice')

  const r = M.requestLogin({ site: 'wix', url: 'https://manage.wix.com', from: 's9' })
  M.dismissLogin(r.id)
  eq(told.length, 1, 'Not now tells nobody')
  eq(M.listLogins().length, 0, 'and takes the card down')

  // Two panes stuck on the same site are two requests: Signed in tells ONE pane, and a
  // pane folded into another's request would be marked nowhere and told nothing.
  const a = M.requestLogin({ site: 'keap', url: 'https://keap.com/login', from: 'sA' })
  const b = M.requestLogin({ site: 'keap', url: 'https://keap.com/login', from: 'sB' })
  ok(a.id !== b.id, 'a second pane asking for the same site gets its own request')
  M.doneLogin(b.id)
  eq(told.at(-1)[0], 'sB', 'and Signed in on it tells that pane')
  eq(M.listLogins().map((x) => x.from), ['sA'], 'while the first pane is still marked')
  M.dismissLogin(a.id)
  const gone = M.requestLogin({ site: 'keap', url: 'https://keap.com/login', from: 'gone' })
  M.doneLogin(gone.id)
  // The log is written by the async appender (logWrite.ts), so it lands a moment later.
  let log = ''
  for (let i = 0; i < 40 && !/that pane is gone/.test(log); i++) {
    await new Promise((r) => setTimeout(r, 50))
    try {
      log = readFileSync(join(work, 'sign-in.log'), 'utf8')
    } catch {
      /* not written yet */
    }
  }
  ok(/could not tell gone: that pane is gone/.test(log), 'a pane that closed meanwhile is logged as not told, not as told', log.split('\n').slice(-3).join(' / '))
  assert.throws(() => M.requestLogin({ site: 'wix', url: 'wix.com' }), /http/)
  n++
  console.log(`ok ${n} - main refuses an address that is not one, whoever asks`)
}

// ------------------------------------------------------------------ the window
{
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok(/logins\.flatMap\(\(r\) => \(r\.from \? \[r\.from\] : \[\]\)\)/.test(app), "the asking pane's row glows like any other pane waiting on a person")
  ok(/signInFor\(s\.id\)/.test(app) && />\s*sign in\s*</.test(app), 'and says "sign in" on it, because a ring never travels without a word')
  const comps = readdirSync(join(root, 'src/renderer/src/components'))
  ok(!comps.some((f) => /login.*view/i.test(f)), 'no component draws a sign-in picture', comps.filter((f) => /login/i.test(f)).join(', '))
  const card = readFileSync(join(root, 'src/renderer/src/components/LoginCard.tsx'), 'utf8')
  ok(!/onOpen|openLogin/.test(card), 'and the card has no button that opens anything')
  const surface = readFileSync(join(root, 'src/shared/surface.ts'), 'utf8')
  for (const ch of ['login:open', 'login:input', 'login:ack', 'login:size', 'login:close', 'login:frame'])
    ok(!surface.includes(`'${ch}'`), `the window has no ${ch} channel any more`)
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${n} passed`)
