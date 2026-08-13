// Same as probe2 but through the app's real keepScrollback transformer.
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = '/Users/robertiuoras/Projects/PaneForge-a'
const require_ = createRequire(root + '/package.json')
const { Terminal } = require_('@xterm/headless')
const work = join(tmpdir(), 'pf-probe3')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'keep.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/keepScrollback.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { keepScrollback } = require_(outfile)
const HIST = '/Users/robertiuoras/Library/Application Support/claude-orchestrator/history/'

async function run(file, label) {
  const t = new Terminal({ rows: 56, cols: 157, scrollback: 10000, allowProposedApi: true })
  const keep = keepScrollback(
    () => t.rows,
    () => t.buffer.active.type === 'alternate'
  )
  const d = readFileSync(HIST + file, 'utf8')
  const marks = []
  const at = [0.2, 0.4, 0.6, 0.8].map((f) => Math.floor(d.length * f))
  let i = 0
  while (i < d.length) {
    const end = Math.min(d.length, i + 4096)
    await new Promise((r) => t.write(keep(d.slice(i, end)), r))
    for (const p of at) {
      if (i <= p && p < end) {
        const m = t.registerMarker(0)
        if (m) marks.push({ m, atBase: t.buffer.active.baseY })
      }
    }
    i = end
  }
  const b = t.buffer.active
  const span = Math.max(1, b.length - 56)
  console.log(
    `${label}: len=${b.length} baseY=${b.baseY} | ` +
      marks.map((x) => `line=${x.m.line} f=${(x.m.line / span).toFixed(3)}`).join('  ')
  )
  t.dispose()
}

await run('s2-msr6w0rj.log', 'CODEX ')
await run('s5-msr6w0uc.log', 'CODEX2')
await run('s4-msr6w0u0.log', 'CLAUDE')
