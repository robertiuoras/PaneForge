// The first-copy card (CopyToast) is sent once per machine, from main.
//
// Pins `sayFirstCopy` in src/main/index.ts, run as written against stand-ins for config
// and the window: a pane that stayed in the project's own folder sends nothing, the first
// copy sends one `lanes:copyMade` naming the project, the folder and copy 2, and the flag
// is written before the send so a second copy - or the same one after a restart - never
// sends again. Also checks the card is wired: surface entry, Api method, App renders it.
//
// Run: node scripts/copy-card-test.mjs
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repoRoot, p), 'utf8')
let failed = 0
const ok = (name, cond, got) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `\n     got: ${JSON.stringify(got)}`}`)
  if (!cond) failed++
}

const main = read('src/main/index.ts')
const start = main.indexOf('function sayFirstCopy(')
const end = main.indexOf('\n}\n', start) + 3
ok('sayFirstCopy exists in main', start > 0, start)
ok('laneFor calls it when a pane is moved into a copy', /sayFirstCopy\(lane\)\n\s+return \{\n\s+\.\.\.req,\n\s+cwd: lane\.cwd/.test(main))

const { copyNumber, projectOf } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(transformSync(read('src/shared/place.ts'), { loader: 'ts', format: 'esm' }).code).toString('base64')
)
let config = { seenCopyCard: false }
const sent = []
const deps = {
  getConfig: () => config,
  setConfig: (p) => { config = { ...config, ...p } },
  send: (channel, payload) => sent.push({ channel, payload, flagged: config.seenCopyCard }),
  copyNumber,
  projectOf
}
const compiled = transformSync(main.slice(start, end), { loader: 'ts' }).code
const say = new Function(...Object.keys(deps), `${compiled}; return sayFirstCopy`)(...Object.values(deps))

say({ cwd: '/Users/x/Projects/taskdriver' })
ok('a pane in the project folder itself sends nothing', sent.length === 0 && !config.seenCopyCard, sent)

say({ cwd: '/Users/x/Projects/taskdriver-a', lane: 'a' })
ok('the first copy sends exactly one card', sent.length === 1, sent)
ok('on the lanes:copyMade channel', sent[0]?.channel === 'lanes:copyMade', sent[0])
ok(
  'naming the project, the folder and copy 2',
  sent[0]?.payload.project === 'taskdriver' && sent[0]?.payload.path === '/Users/x/Projects/taskdriver-a' && sent[0]?.payload.copy === 2,
  sent[0]?.payload
)
ok('the flag is written before the card is sent', sent[0]?.flagged === true, sent[0])

say({ cwd: '/Users/x/Projects/other-b', lane: 'b' })
ok('a second copy, of any project, sends nothing more', sent.length === 1, sent)

const surface = read('src/shared/surface.ts')
ok('the channel is on the surface', surface.includes("onCopyMade: ['on', 'lanes:copyMade']"))
ok('the Api names it', read('src/shared/types.ts').includes('onCopyMade(fn: (e: CopyMade) => void): () => void'))
const app = read('src/renderer/src/App.tsx')
ok('App listens and draws the card', app.includes('api.onCopyMade(setCopyMade)') && app.includes('<CopyToast made={copyMade}'))
const card = read('src/renderer/src/components/CopyToast.tsx')
for (const word of ['lane', 'worktree', 'branch', 'checkout', 'merge', 'trunk']) {
  const visible = card.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').match(/>[^<{]*</g)?.join(' ') ?? ''
  ok(`the card never says "${word}"`, !new RegExp(`\\b${word}`, 'i').test(visible), visible)
}

if (failed) {
  console.log(`\ncopy-card: ${failed} FAILED`)
  process.exit(1)
}
console.log('\ncopy-card: all checks passed')
