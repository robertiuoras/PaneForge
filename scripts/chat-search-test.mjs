// Which chats the Ctrl K box finds, open and closed, and what each row says it is about.
//
// 2026-09-24, Robert: "doesnt show history in the search ... im looking for a session that
// was looking how to invest 10k in stocks austrlia, i would search like stocks it should
// popup first". The box listed open panes and a `Start <project>` row per folder; a closed
// chat could not be found from it at all. The chat he meant is the first fixture below, in
// the shape its History file really has: named after its folder, first line `/model`, and
// `stocks` only in what was asked.
//
//   node scripts/chat-search-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), `pf-chat-search-test-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const load = (entry) => {
  const out = join(work, `${entry.replace(/\W/g, '_')}.bundle.cjs`)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}
const { findChats, aboutLine, FIRST_OPEN, FIRST_CLOSED, MAX_FOUND } = load('src/shared/chatSearch.ts')
const { noteAskInto, MAX_ASK_LINES } = load('src/shared/gist.ts')
rmSync(work, { recursive: true, force: true })

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const HOUR = 3_600_000
const now = Date.now()

const invest = {
  id: 's86-muf8kb8m',
  open: false,
  at: now - 2 * HOUR,
  title: 'taskdriver.ai',
  cwd: '/Users/r/Projects/taskdriver.ai-d',
  gist: '/model',
  askLines: [
    'I have a task from a friend to invest 10,000 into stocks in Australia. I am thinking of building it',
    'woudl investing in us stocks have any downsides? maybe mix of asx and us stock and etc?'
  ],
  chapters: ['I have a task from a friend to invest 10,000 into stocks in Australia. I am thinking of building it']
}
const paneforge = {
  id: 's34-muf2pfhz',
  open: true,
  at: now - 5 * HOUR,
  title: 'PaneForge',
  cwd: '/Users/r/Projects/PaneForge-b',
  gist: 'whats up with sessions do they sleep anymore',
  askLines: ['whats up with sessions do they sleep anymore', '/clear', 'fix the updater fallback on a mac'],
  chapters: ['whats up with sessions do they sleep anymore', 'fix the updater fallback on a mac']
}
const invoices = {
  id: 's12-aaaa',
  open: false,
  at: now - 30 * HOUR,
  title: 'clients',
  cwd: '/Users/r/Projects/clients',
  gist: 'chase the pizzasrus invoice',
  askLines: ['chase the pizzasrus invoice'],
  chapters: ['chase the pizzasrus invoice']
}
const rows = [paneforge, invoices, invest]

// --- the ask that started this ---------------------------------------------------------
ok(findChats(rows, 'stocks')[0]?.id === invest.id, '`stocks` puts the invest chat first, though its name is taskdriver.ai')
ok(findChats(rows, 'stocks').length === 1, '...and nothing that never mentioned stocks')
ok(findChats(rows, 'stoks')[0]?.id === invest.id, 'a typo still finds it (same matcher as History)')
ok(findChats(rows, 'invest australia')[0]?.id === invest.id, 'two words that are both in it find it')
ok(findChats(rows, 'invest pizzasrus').length === 0, 'two words is a narrowing: nothing has both')
ok(/stocks in Australia/.test(aboutLine(invest, 'stocks')), 'its row says WHY it is here: the ask that matched')

// --- open and closed in one list -------------------------------------------------------
ok(findChats(rows, 'updater')[0]?.id === paneforge.id, 'an open pane is found by what it was asked too')
const tieOpen = { ...invoices, id: 'open-twin', open: true, at: now - 90 * HOUR }
ok(findChats([invoices, tieOpen], 'pizzasrus')[0]?.id === 'open-twin', 'on an equal match the open one leads')
const newer = { ...invoices, id: 'newer', at: now - HOUR }
ok(findChats([invoices, newer], 'pizzasrus')[0]?.id === 'newer', '...and between two closed, the more recent')
const many = Array.from({ length: 20 }, (_, i) => ({ ...invoices, id: `m${i}` }))
ok(findChats(many, 'pizzasrus').length === MAX_FOUND, `a query shows at most ${MAX_FOUND}, so the actions stay in view`)

// --- nothing typed: an index of what you were just in ---------------------------------
const empty = findChats(rows, '')
ok(empty[0]?.id === paneforge.id, 'the empty box leads with the panes on screen')
ok(empty.slice(1).map((r) => r.id).join() === [invest.id, invoices.id].join(), '...then closed chats, newest closed first')
// Different start times on purpose: a sort by `at` would reorder these, screen order does not.
const lots = [
  ...Array.from({ length: 10 }, (_, i) => ({ ...paneforge, id: `o${i}`, at: now - (i % 3) * HOUR })),
  ...Array.from({ length: 10 }, (_, i) => ({ ...invoices, id: `c${i}`, at: now - i * HOUR }))
]
const idx = findChats(lots, '')
ok(idx.filter((r) => r.open).length === FIRST_OPEN, `at most ${FIRST_OPEN} open panes before typing`)
ok(idx.filter((r) => !r.open).length === FIRST_CLOSED, `...so a busy desk still shows ${FIRST_CLOSED} closed ones`)
ok(idx.slice(0, FIRST_OPEN).map((r) => r.id).join() === 'o0,o1,o2,o3,o4,o5', 'open panes keep the order they are on screen')
ok(findChats(rows, 's').length === 3, 'one letter is not a query yet: the index stays up')

// --- what the row says ------------------------------------------------------------------
ok(!aboutLine(invest).startsWith('/'), 'a closed chat never reads `/model` when it asked something real')
ok(/invest 10,000/.test(aboutLine(invest)), '...it reads the ask that opened it')
ok(aboutLine(paneforge) === 'fix the updater fallback on a mac', 'an open pane says what it is doing NOW: its latest ask')
// A long session: askLines keeps the FIRST 80, so its last line is not the latest ask.
let notes = {}
for (let i = 1; i <= MAX_ASK_LINES + 5; i++) notes = noteAskInto(notes, `ask number ${i} about the build`)
notes = noteAskInto(notes, '/model')
ok(notes.askLines.length === MAX_ASK_LINES && notes.lastAsk === `ask number ${MAX_ASK_LINES + 5} about the build`, 'the newest real ask is kept past the askLines cap, and a slash command does not replace it')
ok(aboutLine({ open: true, ...notes }) === notes.lastAsk, '...and it is what a long-running open pane says it is on')
ok(aboutLine({ open: true, gist: '/model', askLines: [] }) === '', 'a pane with only a slash command says nothing rather than `/model`')
ok(aboutLine({ open: false, gist: 'just the gist' }) === 'just the gist', 'a chat with no asks recorded falls back to its gist')
ok(aboutLine(paneforge, 'zzzz') === 'fix the updater fallback on a mac', 'a query no line matches keeps the ordinary line')

// --- wired: the pure half is worth nothing if the box does not use it ------------------
const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const palette = readFileSync(join(root, 'src/renderer/src/components/CommandPalette.tsx'), 'utf8')
ok(!/group: 'Start a project'/.test(app), 'no `Start <project>` rows in the box: that is New session')
ok(!/group: 'Open sessions'/.test(app), 'open panes are chats now, not a separate name-only group')
ok(/api\.listHistory\(\)\.then\(setPastChats\)/.test(app), 'the box reads History when it opens')
ok(/<CommandPalette[^>]*chats=\{chats\}/.test(app), '...and is handed the chats')
ok(/resume: true, resumeId: e\.resumeId/.test(app.slice(app.indexOf('const chats = useMemo'))), 'a closed chat reopens by its own id, like History')
ok(/findChats\(chats, q\)/.test(palette) && /aboutLine\(c, q\)/.test(palette), 'the palette ranks chats with findChats and labels them with aboutLine')
ok(/cmd-dot \$\{c\.dot\}/.test(palette), 'every chat row carries its open/closed dot')
ok(/onSearchAll\(q\.trim\(\)\)/.test(palette) && /initialQuery=\{historyQuery\}/.test(app), 'the last row carries the words on to History')
ok(/key=\{historyQuery\}/.test(app), '...even into a History window that is already open')
// Review 2026-09-24: with chats first, `settings` + Return opened History, not Settings.
ok(/\[\.\.\.ranked\.filter\(named\), \.\.\.found, \.\.\.ranked\.filter\(\(c\) => !named\(c\)\)\]/.test(palette), 'an action the words NAME comes before the chats, every other action after')
ok(/groups\.some\(\(g\) => g\.toLowerCase\(\) === q\.trim\(\)\.toLowerCase\(\)\)\) return \[\]/.test(palette), 'a group chip still shows its group, not chats that say its name')
ok(/useEffect\(\(\) => setHi\(0\), \[q, found\.length\]\)/.test(palette), 'the highlight resets when History lands above the actions')
const chatsBlock = app.slice(app.indexOf('const chats = useMemo'), app.indexOf('const chats = useMemo') + 4000)
ok(/seen\.has\(e\.resumeId\)/.test(chatsBlock), 'a reopened conversation is one row, not a green and a red that would start it twice')
ok(/run: e\.gone\s*\?\s*\(\) => searchAll\(e\.title\)/.test(chatsBlock), 'a chat whose folder is gone opens in History instead of failing to reopen')
ok(/e\.endedAt \? 'closed' : 'started'/.test(chatsBlock), 'a chat the app lost says when it started, never a made-up close time')

console.log(`chat search: ${checks} checks passed`)
