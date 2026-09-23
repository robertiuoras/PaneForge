// The real sidebar, in a headless copy, at 1280 and 1440 wide: is any card text cut off,
// and does a renamed card still say its project?
//
// card-fit-test measures hand-built markup against the stylesheet; this one measures the
// cards the app itself draws. Robert, 2026-09-23: "things are cut off hard to see ...
// what happens if session renamed then i dont know what project im in".
//
//   node scripts/sidebar-fit-probe.mjs        (builds and launches a headless copy)
//   node scripts/sidebar-fit-probe.mjs --keep (reuses the last build)

import { basename } from 'node:path'
import { closeLaunched, connect, launch, root } from './ui-lab.mjs'

const port = process.env.PF_PORT ?? '9446'
const RENAMED = 'fix the compact sidebar so nothing is cut off anywhere'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const busy = process.platform === 'win32' ? 'ping -n 600 127.0.0.1' : 'sleep 600'

launch({ headless: true, port, keep: process.argv.includes('--keep') })
let failed = 0
try {
  const lab = await connect(port)
  for (const title of ['probe one', 'probe two'])
    await lab.openPane({ cwd: root, agent: 'shell', title, prompt: busy })
  const renamed = await lab.openPane({ cwd: root, agent: 'shell', title: 'probe three', prompt: busy })
  await sleep(4000)
  await lab.evaluate(`window.api.renameSession(${JSON.stringify(renamed.id)}, ${JSON.stringify(RENAMED)})`)
  await sleep(1500)
  for (const [w, h] of [[1280, 800], [1440, 900]]) {
    await lab.resize(w, h)
    await sleep(600)
    const m = await lab.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.sidebar .row')].filter((r) => r.querySelector('.row-name'))
      const cut = []
      let texts = 0
      for (const row of rows)
        for (const el of row.querySelectorAll('.row-name, .row-project, .row-copy, .row-sub .meta, .row-state, .row-tags > *')) {
          if (!el.textContent.trim()) continue
          texts++
          if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
            cut.push({ cls: el.className, text: el.textContent.trim(), w: el.clientWidth, want: el.scrollWidth, h: el.clientHeight, wantH: el.scrollHeight })
        }
      const card = rows.find((r) => r.querySelector('.row-name')?.textContent === ${JSON.stringify(RENAMED)})
      return {
        sidebar: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
        cards: rows.length, texts, cut,
        renamed: card ? { name: card.querySelector('.row-name').textContent, place: card.querySelector('.row-place')?.textContent ?? null } : null
      }
    })()`)
    console.log(`${w}x${h}: sidebar ${m.sidebar}px, ${m.cards} cards, ${m.texts} text pieces, ${m.cut.length} cut off`)
    for (const c of m.cut) console.log(`  CUT ${c.cls} "${c.text}" ${c.w}/${c.want}px wide, ${c.h}/${c.wantH}px tall`)
    console.log(`  renamed card: ${JSON.stringify(m.renamed)}`)
    const project = basename(root).replace(/-[a-z]$/, '')
    if (m.cut.length) failed++
    if (!m.cards) { console.log('  FAIL no cards drawn'); failed++ }
    if (!m.renamed || !m.renamed.place?.includes(project)) {
      console.log(`  FAIL the renamed card does not say "${project}"`)
      failed++
    }
  }
  lab.close()
} finally {
  closeLaunched()
}
console.log(failed ? `sidebar fit: ${failed} failure(s)` : 'sidebar fit: nothing cut off, renamed card names its project')
process.exit(failed ? 1 : 0)
