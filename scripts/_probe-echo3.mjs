import pkg from '@xterm/headless'
const { Terminal } = pkg
import { readFileSync } from 'node:fs'
const ECHO = /^ {0,4}❯ {1,3}(\S.*)$/
const TORN = /─{3,}/
function seed(lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const m = ECHO.exec(lines[i].replace(/\s+$/, ''))
    if (!m) continue
    const text = m[1].trim()
    if (text.length < 2) continue
    if (TORN.test(lines[i]) || TORN.test(lines[i + 1] ?? '')) continue
    if (i > 0 && lines[i - 1].trim() !== '') continue
    found.push({ line: i, text })
  }
  const byKey = new Map()
  for (const f of found) byKey.set(f.text.replace(/\s+/g, ' ').toLowerCase(), f)
  return [...byKey.values()].sort((a, b) => a.line - b.line)
}
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f, 'utf8').slice(-200000)
  const t = new Terminal({ cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true })
  await new Promise((r) => t.write(raw, r))
  const b = t.buffer.active
  const cursor = b.baseY + b.cursorY
  const lines = []
  for (let i = 0; i < cursor; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
  const out = seed(lines)
  console.log(`== ${f.split('/').pop()} cursor=${cursor} tags=${out.length}`)
  for (const o of out) console.log('  ', o.line, JSON.stringify(o.text.slice(0, 70)))
}
