// A prompt that never left a chat's input box is a GuardDeck card until it goes in.
//
// `shared/unsentCard.ts` decides (which chats, what the card says, what comes down) and
// `main/unsentCards.ts` writes the files; both run here against a scratch notices folder.
// One card per occurrence, never written again after Robert dismissed it, taken down the
// moment the prompt goes in or the chat is gone, and nothing else in the folder is touched.
//
//   node scripts/unsent-card-test.mjs

import { build } from 'esbuild'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), `pf-unsent-card-test-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const require = createRequire(import.meta.url)

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/profile$/ }, () => ({ path: 'profile', namespace: 'stub' }))
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({ contents: 'exports.app={isPackaged:true}', loader: 'js' }))
    b.onLoad({ filter: /^profile$/, namespace: 'stub' }, () => ({ contents: 'exports.profileName=()=>undefined', loader: 'js' }))
  }
}
async function bundle(entry, name) {
  const out = join(work, name)
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [stubs] })
  return require(out)
}
const card = await bundle('src/shared/unsentCard.ts', 'shared.cjs')
const { syncUnsentCards } = await bundle('src/main/unsentCards.ts', 'main.cjs')

let n = 0
function check(name, fn) {
  fn()
  n++
  console.log(`ok - ${name}`)
}

const AT = new Date(2026, 9, 2, 4, 10).getTime()
const notices = join(work, 'notices')
const files = () => (existsSync(notices) ? readdirSync(notices).sort() : [])
const read = (id) => JSON.parse(readFileSync(join(notices, `${id}.json`), 'utf8'))

check('the card names the computer, the chat, when, and the one thing to do', () => {
  const c = card.unsentCard({ id: 's12-abc123', title: 'Blender film', cwd: '/x', promptUnsent: AT, label: '3', machine: 'pc' })
  assert.equal(c.id, `paneforge-unsent-s12-abc123-${AT.toString(36)}`)
  assert.equal(c.actor, 'paneforge')
  assert.equal(c.waiting, true)
  assert.equal(c.at, AT)
  assert.equal(c.title, 'Prompt not sent to PC 3')
  assert.equal(c.chat, 'PC 3 · Blender film')
  assert.equal(c.machine, 'pc')
  assert.equal(c.pane, 's12-abc123')
  assert.equal(c.cwd, '/x')
  assert.equal(
    c.detail,
    "Blender film: a prompt was typed into this chat's input box at 4:10am Fri and the agent never took it. It is still in the box. Open the chat and press Enter to send it."
  )
  assert.equal('pid' in c, false, 'no pid: a pid would let GuardDeck drop the card when this process ends')
  assert.equal(card.unsentCard({ id: '@pc/s4-far', title: 'Far', promptUnsent: AT, label: 'PC 4', machine: 'pc' }).id, `paneforge-unsent--pc-s4-far-${AT.toString(36)}`)
})

check('rows: own panes, mirrored ones and listed-only ones, each once; offline and watched skipped', () => {
  const sessions = [
    { id: 's1-a', title: 'Own', cwd: '/a', label: '1', number: 1, promptUnsent: AT },
    { id: '@pc/s2-b', title: 'Mirrored', cwd: '/b', label: 'PC 2', number: 2, remote: { device: 'pc', name: 'PC', machine: 'pc' }, promptUnsent: AT }
  ]
  const peers = [
    {
      id: 'pc',
      status: 'online',
      panes: [
        { id: 's2-b', title: 'Mirrored', cwd: '/b', watched: true, number: 2, machine: 'pc', promptUnsent: AT },
        { id: 's5-c', title: 'Listed', cwd: '/c', watched: false, number: 5, machine: 'pc', promptUnsent: AT },
        { id: 's6-d', title: 'Quiet', cwd: '/d', watched: false, number: 6, machine: 'pc' }
      ]
    },
    { id: 'old', status: 'off', panes: [{ id: 's9', title: 'Off', cwd: '/e', watched: false, number: 9, machine: 'pc', promptUnsent: AT }] }
  ]
  const rows = card.unsentRows(sessions, peers, 'mac')
  assert.deepEqual(rows.map((r) => [r.id, r.machine]), [['s1-a', 'mac'], ['@pc/s2-b', 'pc'], ['@pc/s5-c', 'pc'], ['@pc/s6-d', 'pc']])
  const plan = card.planUnsentCards(rows, [], new Set())
  assert.deepEqual(plan.write.map((c) => c.title), ['Prompt not sent to Mac 1', 'Prompt not sent to PC 2', 'Prompt not sent to PC 5'])
})

const posted = new Set()
const own = (over = {}) => ({ id: 's12-abc123', title: 'Blender film', cwd: '/x', label: '3', number: 3, machine: 'mac', promptUnsent: AT, ...over })
const id1 = `paneforge-unsent-s12-abc123-${AT.toString(36)}`

check('a stuck prompt puts one card up; a chat with nothing stuck puts none', () => {
  mkdirSync(notices, { recursive: true })
  writeFileSync(join(notices, 'paneforge-step-r1-1.json'), '{}')
  writeFileSync(join(notices, 'someone-else.json'), '{}')
  const r = syncUnsentCards(notices, [own(), own({ id: 's2-ok', promptUnsent: undefined })], posted)
  assert.deepEqual(r, { wrote: [id1], removed: [] })
  assert.deepEqual(files(), ['paneforge-step-r1-1.json', `${id1}.json`, 'someone-else.json'])
  assert.equal(read(id1).title, 'Prompt not sent to Mac 3')
})

check('the next pass writes nothing more; dismissed by Robert, it stays down', () => {
  assert.deepEqual(syncUnsentCards(notices, [own()], posted), { wrote: [], removed: [] })
  unlinkSync(join(notices, `${id1}.json`))
  assert.deepEqual(syncUnsentCards(notices, [own()], posted), { wrote: [], removed: [] })
  assert.equal(files().includes(`${id1}.json`), false)
})

const AT2 = AT + 60_000
const id2 = `paneforge-unsent-s12-abc123-${AT2.toString(36)}`

check('a second prompt stuck in the same chat is a second card', () => {
  const r = syncUnsentCards(notices, [own({ promptUnsent: AT2 })], posted)
  assert.deepEqual(r, { wrote: [id2], removed: [] })
  assert.equal(posted.has(id1), false, 'the first occurrence is over, so it is forgotten')
})

check('the prompt went in: its card comes down, and nothing else in the folder is touched', () => {
  const r = syncUnsentCards(notices, [own({ promptUnsent: undefined })], posted)
  assert.deepEqual(r, { wrote: [], removed: [id2] })
  assert.deepEqual(files(), ['paneforge-step-r1-1.json', 'someone-else.json'])
  assert.equal(posted.size, 0)
})

check('the chat closed with its prompt still stuck: the card comes down too', () => {
  syncUnsentCards(notices, [own()], posted)
  assert.equal(files().includes(`${id1}.json`), true)
  assert.deepEqual(syncUnsentCards(notices, [], posted), { wrote: [], removed: [id1] })
  assert.equal(files().some((f) => f.endsWith('.tmp')), false, 'no half-written file is left behind')
})

check('no notices folder yet and nothing stuck: nothing is created', () => {
  const empty = join(work, 'never')
  assert.deepEqual(syncUnsentCards(empty, [own({ promptUnsent: undefined })], new Set()), { wrote: [], removed: [] })
  assert.equal(existsSync(empty), false)
})

rmSync(work, { recursive: true, force: true })
console.log(`\n${n} checks passed`)
