// Regression test: an uncommitted file stranded in the main folder must not hold finished
// work silently.
//
// What happened on 7 Oct 2026, in the clients repo (a `merge` repo): a Codex chat holding
// `main` left an untracked clients/alison-r/write-ledger.jsonl in the main folder and died
// at 10:25am. Lane b then brought the same path with different bytes, so `mainDirt` rightly
// refused to merge over it - and from 11:57am to 8:10pm every release answered
//
//   "No release yet: waiting on chats still working: main (uncommitted edits to
//    clients/alison-r/write-ledger.jsonl that finished work changes)"
//
// Four finished lanes (19 commits in one of them) sat behind a chat that no longer existed.
// The agents repeated the sentence as "queued behind another chat's main-checkout edits" and
// moved on, nothing raised a card, and a person found it by hand eight hours later.
//
// The rule now: once the files have been left alone and the chat that left them is gone (or
// nobody has touched them for HOLD_BUSY_MS whoever holds the folder), the reason says nobody
// is working on it, and the lane clock (`retry`) raises ONE waiting card naming the file, the
// holder and the waiting lanes - cleared when the blocker goes. The stranded bytes are never
// touched. A live chat mid-edit in the main folder still gets the old wait, and no card.
//
// Real git repos in the temp folder, real lane.mjs, no stubs. LANE_DISPATCH_LOG stands in for
// GuardDeck (see clashCards).
//
//   node scripts/lane-stranded-main-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-stranded-main-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const HOUR = 60 * 60 * 1000
const LEDGER = 'clients/alison-r/write-ledger.jsonl'

/**
 * The 7 Oct shape: `holder` holds main, a second chat's lane commits LEDGER, and the main
 * folder holds an untracked LEDGER with different bytes, last written `fileAge` ago. The
 * app inventory (`.git/paneforge-panes/pf-<pid>.json`, this live process's pid) hosts the
 * chats in `living`. `holderSeen` is how long ago the holder last ran a lane command.
 */
function fixture(name, { holder, living, fileAge, holderSeen }) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'clients', 'alison-r'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'clients', 'alison-r', 'notes.md'), 'notes\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  const origin = join(root, `${name}.git`)
  git(root, 'init', '-q', '--bare', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'master')

  const cards = join(root, `${name}-cards.jsonl`)
  const env = { ...process.env, PF_RELEASE: 'merge', LANE_DISPATCH_LOG: cards }
  delete env.PF_PANE
  const lane = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim()
      }
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }

  const main = JSON.parse(lane('claim', '--session', holder).out)
  const work = JSON.parse(lane('claim', '--session', 'lane-chat-b').out)

  writeFileSync(join(work.dir, LEDGER), '{"row":"the lane\'s write"}\n')
  git(work.dir, 'add', '-A')
  git(work.dir, 'commit', '-qm', 'log a write')

  const stranded = '{"row":"6 Oct write nobody committed"}\n'
  writeFileSync(join(repo, LEDGER), stranded)
  const t = (Date.now() - fileAge) / 1000
  utimesSync(join(repo, LEDGER), t, t)

  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.lanes.main.seen = Date.now() - holderSeen
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')

  mkdirSync(join(repo, '.git', 'paneforge-panes'), { recursive: true })
  writeFileSync(join(repo, '.git', 'paneforge-panes', `pf-${process.pid}.json`), JSON.stringify({ at: Date.now(), chats: living }))

  const readCards = () => (existsSync(cards) ? readFileSync(cards, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { repo, lane, work, main, stranded, readCards }
}

const landed = (repo) => git(repo, 'log', '--oneline', 'master').includes('log a write')

// ------------------------------------------------- the 7 Oct shape: holder gone, file left

{
  const f = fixture('holder-gone', { holder: 'deadmain-01a113ba', living: ['someone-else'], fileAge: 3 * HOUR, holderSeen: 3 * HOUR })
  ok('the holder took main, the lane chat a copy', f.main.lane === 'main' && f.work.lane !== 'main', JSON.stringify([f.main, f.work]))
  const done = f.lane('ready', '--session', 'lane-chat-b')
  ok('the finished lane does not merge over the stranded file', !landed(f.repo), done.out || done.err)
  ok('the reason no longer says a chat is still working', !/chats still working/i.test(done.out), done.out)
  ok('the reason says nobody is working on it and the holder has ended', /nobody is working on it/i.test(done.out) && /has ended/i.test(done.out), done.out)
  ok('the reason names the stranded file', done.out.includes(LEDGER), done.out)

  const r1 = f.lane('retry')
  const first = f.readCards()
  ok('the lane clock raises one card', first.length === 1 && first[0].card === true, r1.out || r1.err)
  const card = first[0] ?? {}
  const text = `${card.title ?? ''} ${card.detail ?? ''}`
  ok('the card names the file, the holder and the waiting lane', text.includes(LEDGER) && text.includes('deadmain') && text.includes(`lane ${f.work.lane}`), text)
  f.lane('retry')
  ok('a second tick does not raise it again', f.readCards().length === 1, JSON.stringify(f.readCards()))
  ok('the stranded bytes are untouched', readFileSync(join(f.repo, LEDGER), 'utf8') === f.stranded)

  // A person deals with it (here: moves it aside); the card comes down and the work goes out.
  const kept = join(root, 'kept-ledger.jsonl')
  writeFileSync(kept, readFileSync(join(f.repo, LEDGER)))
  unlinkSync(join(f.repo, LEDGER))
  const r3 = f.lane('retry')
  const all = f.readCards()
  ok('the card is cleared once the blocker is gone', all.length === 2 && all[1].clear === true, JSON.stringify(all))
  ok('and the finished work then merges', landed(f.repo), r3.out || r3.err)
}

// --------------------------------------- a live chat mid-edit in main keeps the old wait

{
  const f = fixture('holder-live', { holder: 'livemain-0000', living: ['livemain-0000'], fileAge: 2 * 60 * 1000, holderSeen: 60 * 1000 })
  const done = f.lane('ready', '--session', 'lane-chat-b')
  ok('a live holder still reads as a chat still working', /waiting on chats still working: main/.test(done.out), done.out)
  f.lane('retry')
  ok('and raises no card', f.readCards().length === 0, JSON.stringify(f.readCards()))
}

// ------------------------- the bound: a live holder that has left the file alone an hour+

{
  const f = fixture('holder-idle', { holder: 'idlemain-0000', living: ['idlemain-0000'], fileAge: 2 * HOUR, holderSeen: 60 * 1000 })
  const done = f.lane('ready', '--session', 'lane-chat-b')
  ok('a file untouched for over an hour reads as nobody working on it', /nobody is working on it/i.test(done.out) && /over an hour/i.test(done.out), done.out)
  f.lane('retry')
  ok('and raises one card', f.readCards().length === 1, JSON.stringify(f.readCards()))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
