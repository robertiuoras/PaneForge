// `pf` reachable from every pane on any install - `shared/pfAccess.ts`, `main/pfAccess.ts`,
// and the phone server's local-only listener (`PhoneServer.localOnly`).
//
// Robert, 2026-09-24: an agent reported "PaneForge's local control API appears disabled" -
// on every install that never switched phone access on, it was (`phone.on` defaults to
// false and `pf` rides the phone server), and `pf` itself existed only as a symlink into
// Robert's checkout. This pins:
//   - the primer each agent gets, and that a Codex user's own developer_instructions win
//   - the shim files per platform/Node shape, and that the POSIX one really runs pf-ctl
//   - PATH gets the bin dir at its END, once, under the key the env already uses
//   - a local-only listener answers pf on loopback, reports itself off, and is NOT reachable
//     on the LAN address
//
//   node scripts/pf-access-test.mjs
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-access-'))
let pass = 0
let fail = 0
const ok = (cond, what, detail) => {
  if (cond) pass++
  else {
    fail++
    console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
  }
}
const load = async (entry, name) => {
  const outfile = join(work, `${name}.mjs`)
  buildSync({ absWorkingDir: root, entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  return await import(pathToFileURL(outfile).href)
}

const A = await load('src/shared/pfAccess.ts', 'pfaccess')

// ---- primer -----------------------------------------------------------------------------
{
  const claude = A.primerArgs('claude')
  ok(claude[0] === '--append-system-prompt' && claude[1] === A.PF_PRIMER, 'Claude gets the primer appended')
  ok(A.PF_PRIMER.includes('pf help'), 'the primer names `pf help`')
  const codex = A.primerArgs('codex')
  ok(codex[0] === '-c' && codex[1].startsWith('developer_instructions="'), 'Codex gets it as a -c override', codex.join(' '))
  ok(A.primerArgs('codex', true).length === 0, "a Codex user's own developer_instructions are never replaced")
  ok(A.primerArgs('grok').length === 0 && A.primerArgs('shell').length === 0, 'other agents get no argv')
  ok(A.tomlString('a "q" \\ b') === '"a \\"q\\" \\\\ b"', 'TOML string escapes quotes and backslashes')
  ok(A.hasOwnCodexInstructions('model = "x"\ndeveloper_instructions = "mine"\n'), 'top-level developer_instructions is theirs')
  ok(!A.hasOwnCodexInstructions('# developer_instructions = "off"\nmodel = "x"\n'), 'a commented line is not')
  ok(!A.hasOwnCodexInstructions('[profiles.x]\ndeveloper_instructions = "p"\n'), 'one inside a table is not top level')
}

// ---- PATH -------------------------------------------------------------------------------
{
  const mac = A.withPfOnPath({ PATH: '/usr/bin:/bin' }, '/U/bin', 'darwin')
  ok(mac.PATH === '/usr/bin:/bin:/U/bin', 'bin dir goes on the END of PATH', mac.PATH)
  ok(A.withPfOnPath(mac, '/U/bin/', 'darwin').PATH === mac.PATH, 'added once, however it is spelled')
  const win = A.withPfOnPath({ Path: 'C:\\Windows;C:\\x' }, 'C:\\U\\bin', 'win32')
  ok(win.Path === 'C:\\Windows;C:\\x;C:\\U\\bin' && !('PATH' in win), "Windows keeps its own 'Path' key", JSON.stringify(win))
  ok(A.withPfOnPath({}, '/U/bin', 'linux').PATH === '/U/bin', 'an empty env still gets it')
}

// ---- shims ------------------------------------------------------------------------------
{
  const mNode = A.pfShimFiles('darwin', '/opt/node', '/App/PaneForge', '/R/scripts/pf-ctl.mjs', '/U/bin')
  ok(mNode.length === 1 && mNode[0].name === 'pf' && mNode[0].exec, 'POSIX: one executable pf')
  ok(mNode[0].body.includes(`exec '/opt/node' '/R/scripts/pf-ctl.mjs' "$@"`), 'POSIX with Node runs it on Node', mNode[0].body)
  const mApp = A.pfShimFiles('darwin', null, "/Apps/Pane'Forge", '/R/pf-ctl.mjs', '/U/bin')
  ok(mApp[0].body.includes(`ELECTRON_RUN_AS_NODE=1 exec '/Apps/Pane'\\''Forge'`), 'POSIX without Node runs on the app, quoted', mApp[0].body)
  const wNode = A.pfShimFiles('win32', 'C:\\node\\node.exe', 'C:\\P\\PaneForge.exe', 'C:\\P\\resources\\scripts\\pf-ctl.mjs', 'C:\\U\\bin')
  ok(wNode.map((f) => f.name).join() === 'pf.cmd,pf', 'Windows with Node: pf.cmd and a Git Bash pf')
  ok(wNode[0].body.startsWith('@"C:\\node\\node.exe" "C:\\P\\resources\\scripts\\pf-ctl.mjs" %*'), 'pf.cmd runs Node', wNode[0].body)
  const wApp = A.pfShimFiles('win32', null, 'C:\\P\\PaneForge.exe', 'C:\\P\\s\\pf-ctl.mjs', 'C:\\U\\bin\\')
  ok(wApp.map((f) => f.name).join() === 'pf.ps1,pf.cmd,pf', 'Windows without Node: all three hand to pf.ps1')
  ok(/\| Write-Output\r\nexit \$LASTEXITCODE/.test(wApp[0].body), 'pf.ps1 pipes so PowerShell waits and keeps the exit code')
  ok(wApp[1].body.includes('-File "C:\\U\\bin\\pf.ps1" %*'), 'pf.cmd names pf.ps1 once, no doubled separator', wApp[1].body)
}

// ---- local-only listener + the real pf-ctl through a real shim -------------------------
const { PhoneServer, LOCAL_ONLY } = await load('src/main/phone.ts', 'phone')
const staticDir = join(work, 'renderer')
mkdirSync(staticDir, { recursive: true })
writeFileSync(join(staticDir, 'index.html'), '<html></html>')
const code = 'PFA234'
const server = new PhoneServer({
  staticDir,
  code: () => code,
  secret: () => 'device-secret',
  channels: { invoke: ['sessions:list', 'login:list'], send: [], on: [] },
  invoke: async () => [],
  send: () => {}
})
const port = 7480 + (process.pid % 90)
const st = await server.start(port, LOCAL_ONLY)
ok(server.running && server.localOnly, 'local-only listener is running', st.error)
ok(st.on === false && st.urls.length === 0 && st.port === 0, 'and reports phone access OFF with no address', JSON.stringify(st))

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
if (lan) {
  const reached = await new Promise((res) => {
    const s = connect({ host: lan, port }, () => (s.destroy(), res(true)))
    s.on('error', () => res(false))
    s.setTimeout(1500, () => (s.destroy(), res(false)))
  })
  ok(!reached, `not reachable on the LAN address ${lan}`)
} else console.log('  (no LAN address on this machine - LAN refusal not checked)')

const userData = join(work, 'userData')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ phone: { on: false, port, code } }))
const bin = join(work, 'bin')
mkdirSync(bin, { recursive: true })
if (process.platform !== 'win32') {
  const [shim] = A.pfShimFiles(process.platform, process.execPath, process.execPath, join(root, 'scripts', 'pf-ctl.mjs'), bin)
  writeFileSync(join(bin, shim.name), shim.body)
  chmodSync(join(bin, shim.name), 0o755)
  // Async on purpose: this process IS the app's server, and a sync spawn would freeze the
  // listener `pf` is talking to until the timeout.
  const { exit, out } = await new Promise((res) =>
    execFile(join(bin, 'pf'), ['list'], { encoding: 'utf8', env: { ...process.env, PF_USER_DATA: userData }, timeout: 20_000 }, (e, stdout, stderr) =>
      res({ exit: e ? (e.code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` })
    )
  )
  ok(exit === 0, 'the shim runs the real pf-ctl and it drives a local-only app', `exit ${exit}: ${out.trim().slice(0, 300)}`)
}

const back = await server.start(port)
ok(back.on === true && !server.localOnly, 'switching phone access on turns the same port into a real phone server')
await server.stop()

console.log(fail ? `\npf-access-test: ${fail} of ${pass + fail} failed` : `\npf-access-test: ${pass} checks passed`)
process.exit(fail ? 1 : 0)
