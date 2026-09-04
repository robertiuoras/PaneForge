import xtermPkg from '@xterm/headless'
const { Terminal } = xtermPkg
import { readFileSync, openSync, fstatSync, readSync, closeSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const dir = join(homedir(), 'Library/Application Support/claude-orchestrator/history')
function tail(file, bytes) {
  const fd = openSync(file, 'r'); const size = fstatSync(fd).size
  const want = Math.min(bytes, size); const buf = Buffer.alloc(want)
  readSync(fd, buf, 0, want, size - want); closeSync(fd)
  const cut = buf.toString('utf8'); if (size <= bytes) return cut
  const nl = cut.indexOf('\n'); return nl === -1 ? cut : cut.slice(nl + 1)
}
async function rowsOf(raw, cols) {
  const t = new Terminal({ cols: Math.max(20, cols), rows: 24, scrollback: 400000, allowProposedApi: true })
  await new Promise((r) => t.write(raw, r))
  const b = t.buffer.active; const lines = []
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
  t.dispose(); return lines
}
// known prompt texts from the archive, newest first
const arch = readFileSync(join(homedir(), 'Library/Application Support/claude-orchestrator/prompt-archive.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l))
const recent = arch.slice(-400).map(a => a.x.split('\n')[0].trim()).filter(s => s.length > 12)
const logs = readdirSync(dir).filter(f=>f.endsWith('.log'))
let hit = 0, checked = 0
const shapes = new Map()
for (const f of logs.slice(-120)) {
  const raw = tail(join(dir,f), 400000); if (raw.length < 20000) continue
  let cols = 0; try { cols = JSON.parse(readFileSync(join(dir, f.replace(/\.log$/,'.json')),'utf8')).cols||0 } catch {}
  const lines = await rowsOf(raw, cols||120)
  checked++
  for (const p of recent) {
    const frag = p.slice(0, 30)
    for (const ln of lines) {
      const i = ln.indexOf(frag)
      if (i < 0) continue
      hit++
      const lead = ln.slice(0, i)
      shapes.set(lead, (shapes.get(lead)||0)+1)
      break
    }
  }
}
console.log('logs checked', checked, 'prompt-in-buffer hits', hit)
console.log([...shapes.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>JSON.stringify(k)+' x'+v).join('\n'))
