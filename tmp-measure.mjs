// Measure: how many prompt echoes does seedPrompts recover from a REAL restored tail?
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync, openSync, fstatSync, readSync, closeSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import xtermPkg from '@xterm/headless'
const { Terminal } = xtermPkg

const root = '/Users/robertiuoras/Projects/PaneForge'
const out = join(tmpdir(), 'pf-measure-promptecho.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/promptEcho.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out })
const { promptEcho, seedPrompts } = createRequire(import.meta.url)(out)

const dir = join(homedir(), 'Library/Application Support/claude-orchestrator/history')
const BUFFER_LIMIT = 400_000

function tail(file, bytes) {
  const fd = openSync(file, 'r')
  const size = fstatSync(fd).size
  const want = Math.min(bytes, size)
  const buf = Buffer.alloc(want)
  readSync(fd, buf, 0, want, size - want)
  closeSync(fd)
  const cut = buf.toString('utf8')
  if (size <= bytes) return cut
  const nl = cut.indexOf('\n')
  return nl === -1 ? cut.replace(/^�+/, '') : cut.slice(nl + 1)
}

async function rowsOf(raw, cols) {
  const t = new Terminal({ cols: Math.max(20, cols), rows: 24, scrollback: 400000, allowProposedApi: true })
  await new Promise((r) => t.write(raw, r))
  const b = t.buffer.active
  const lines = []
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  t.dispose()
  return lines
}

const logs = readdirSync(dir).filter((f) => f.endsWith('.log'))
const rows = []
for (const f of logs) {
  const id = f.replace(/\.log$/, '')
  let cols = 0
  try { cols = JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')).cols || 0 } catch {}
  const raw = tail(join(dir, f), BUFFER_LIMIT)
  if (raw.length < 5000) continue
  const lines = await rowsOf(raw, cols || 120)
  // ceiling: every distinct echo text anywhere in the tail
  const all = new Map()
  const noBlank = []
  const ruled = []
  for (let i = 0; i < lines.length; i++) {
    const text = promptEcho(lines[i])
    if (!text) continue
    const key = text.replace(/\s+/g, ' ').toLowerCase()
    all.set(key, text)
    if (RULEtest(lines[i]) || RULEtest(lines[i + 1] ?? '')) { ruled.push(text); continue }
    if (i > 0 && lines[i - 1].trim() !== '') noBlank.push(text)
  }
  const seeded = seedPrompts(lines)
  rows.push({ id, cols, bytes: raw.length, lines: lines.length, echoes: all.size, seeded: seeded.length, ruled: ruled.length, noBlank: noBlank.length, sample: [...all.values()].slice(-2).map(s=>s.slice(0,50)) })
}
function RULEtest(s) { return /─{3,}/.test(s) }

rows.sort((a, b) => a.seeded / Math.max(1,a.echoes) - b.seeded / Math.max(1,b.echoes))
const tot = rows.reduce((a, r) => ({ echoes: a.echoes + r.echoes, seeded: a.seeded + r.seeded }), { echoes: 0, seeded: 0 })
console.log('logs measured:', rows.length, 'distinct echoes:', tot.echoes, 'seeded:', tot.seeded)
console.log('logs with echoes but ZERO seeded:', rows.filter(r => r.echoes > 0 && r.seeded === 0).length)
console.log('logs with zero echoes at all:', rows.filter(r => r.echoes === 0).length)
for (const r of rows.filter(r => r.echoes > 0).slice(0, 12)) console.log(JSON.stringify(r))
