// Counts what Settings puts on screen, per tab: rows, controls, words of hint text.
// The brief for the settings rework asks for this table before and after, so it is a
// script rather than a one-off: the same numbers, read the same way, twice.
import { readSettings } from './settings-index.mjs'

const per = new Map()
for (const s of readSettings()) {
  const row = per.get(s.tab) ?? { rows: 0, hintWords: 0, longest: 0 }
  const hint = s.find.slice(s.label.length).trim()
  const words = hint ? hint.split(/\s+/).length : 0
  row.rows++
  row.hintWords += words
  row.longest = Math.max(row.longest, words)
  per.set(s.tab, row)
}
let rows = 0
let words = 0
console.log('tab'.padEnd(12), 'rows'.padStart(5), 'hint words'.padStart(11), 'longest'.padStart(8))
for (const [tab, r] of per) {
  rows += r.rows
  words += r.hintWords
  console.log(tab.padEnd(12), String(r.rows).padStart(5), String(r.hintWords).padStart(11), String(r.longest).padStart(8))
}
console.log('TOTAL'.padEnd(12), String(rows).padStart(5), String(words).padStart(11))
