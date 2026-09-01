// Does the LIVE reading find the leak, and refuse everything else on this real desk?
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)
const out = process.env.SP + '/dd.cjs'
buildSync({ absWorkingDir: process.env.PWD, entryPoints: ['src/main/deadDev.ts'], bundle: true,
  format: 'cjs', platform: 'node', outfile: out, external: ['electron'] })
const dd = req(out)
const outDev = process.env.SP + '/dv.cjs'
buildSync({ absWorkingDir: process.env.PWD, entryPoints: ['src/main/devServers.ts'], bundle: true,
  format: 'cjs', platform: 'node', outfile: outDev, external: ['electron'] })
const ds = req(outDev)
const outShared = process.env.SP + '/sh.cjs'
buildSync({ absWorkingDir: process.env.PWD, entryPoints: ['src/shared/deadDev.ts'], bundle: true,
  format: 'cjs', platform: 'node', outfile: outShared })
const sh = req(outShared)

const devs = await ds.listRunningDevs([])
const [listening, supervised, procs] = await Promise.all([dd.listeningPids(), dd.supervisedPids(), ds.table()])
const serving = dd.servingDevs(devs, procs, listening)
console.log(`listening pids ${listening.size} | supervised pids ${supervised.size} | dev servers ${devs.length}`)
for (const d of devs) {
  const why = serving.has(d.pid) ? 'SERVING' : supervised.has(d.pid) ? 'supervised' : 'SERVING NOTHING'
  console.log(`  pid ${d.pid}\t${d.label}\tport ${d.port ?? '-'}\t${d.where}\t-> ${why}`)
}
const now = Date.now()
const since = new Map(devs.filter((d) => !serving.has(d.pid)).map((d) => [d.pid, now - 120_000]))
const dead = sh.deadDevs(devs, serving, since, { now, kept: new Set(), supervised })
console.log('verdict:', dead.length ? dead.map((d) => `${d.pid} ${d.label} ${d.where}`).join(', ') : 'nothing to close')
for (const d of dead) console.log('  card would say:', sh.stopSoonWords(d), '|', sh.stopSoonWhy(d))
