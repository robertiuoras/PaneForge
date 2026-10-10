// Work held for Robert's "release" is not abandoned work: the clock must not open a chat to
// finish it. liftgym lane a fc4dd41, 10-11 Oct 2026: a login change whose Opus review said
// RISKY waited for his release; two "Finish preserved work" chats re-verified it overnight
// and the second only re-asked him, as a notification about abandoned work.
// `LANE_DECIDER` stands in for claude-config's decider (`release-held`).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, git, fixture, finish } from './lane-completion-fixture.mjs'

const committed = (x, name) => {
  writeFileSync(join(x.dir, `${name}.txt`), name); git(x.dir, 'add', `${name}.txt`); git(x.dir, 'commit', '-qm', name)
  return git(x.dir, 'rev-parse', 'HEAD')
}
// A decider that answers `answer` and logs what it was asked; `answer` can change mid-test.
const decider = (x, answer) => {
  const script = join(x.repo, '.git', 'decider.mjs')
  const reply = join(x.repo, '.git', 'decider-answer.json')
  const asked = join(x.repo, '.git', 'decider-asked.jsonl')
  writeFileSync(script, `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(asked)}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(readFileSync(${JSON.stringify(reply)}, 'utf8'))
`)
  x.env.LANE_DECIDER = script
  const say = (a) => writeFileSync(reply, JSON.stringify(a))
  say(answer)
  return { say, asked: () => existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] }
}
const HELD = { verdict: 'ASK', held: true, reason: 'Opus review says RISKY: changes the login cookie lifetime' }
const FREE = { verdict: 'AUTO', reason: 'no RISKY release review holds it: a chat can finish it' }

// ---------------------------------------------------------------- held: no chat, one record
const held = fixture('held')
const heldAnswer = decider(held, HELD)
const heldSha = committed(held, 'login')
held.patch((s) => { delete s.lanes.a })
held.run('retry')
const heldKey = `lane:a:${heldSha}`
const heldItem = () => held.state().recovery.items[heldKey]
check('A: work held for release opens no chat', held.requests().length === 0, JSON.stringify(held.requests()))
const q = heldAnswer.asked()[0] ?? []
check('B: the decider is asked about exactly that commit', q[0] === 'release-held' && q.includes('--repo') && q[q.indexOf('--ref') + 1] === heldSha, JSON.stringify(heldAnswer.asked()))
check('C: it is recorded as held, with the review\'s reason, no owner and nothing active',
  heldItem()?.status === 'blocked' && heldItem().held === true && heldItem().owner === null && /RISKY: changes the login cookie lifetime/.test(heldItem().reason) && !held.state().recovery.active,
  JSON.stringify(held.state().recovery))
held.run('retry')
check('D: the next tick neither opens a chat nor asks again', held.requests().length === 0 && heldAnswer.asked().length === 1, JSON.stringify(heldAnswer.asked()))

// The release path stays open: once Robert says release, a chat records his words and ships.
const claimed = held.run('claim', '--prefer', 'a', '--cwd', held.dir, '--session', 'releaser')
check('E: a chat can take the held lane', claimed.code === 0 && JSON.parse(claimed.out).lane === 'a', claimed.out + claimed.err)
const refused = held.run('ready', '--session', 'releaser', '--lane', 'a')
check('F: ready waits, and says it waits for Robert\'s release and how to record it',
  refused.code !== 0 && /waits for Robert's "release"/.test(refused.err) && /--disposition reviewed/.test(refused.err), refused.out + refused.err)
const words = join(held.repo, '.git', 'release.json')
writeFileSync(words, JSON.stringify({ reason: 'Robert: "release fc4dd41"' }))
const recorded = held.run('recover', '--key', heldKey, '--session', 'releaser', '--disposition', 'reviewed', '--receipt', words)
check('G: his words are recorded by the chat he told', recorded.code === 0 && heldItem().status === 'reviewed', recorded.err + JSON.stringify(heldItem()))
const shipped = held.run('ready', '--session', 'releaser', '--lane', 'a')
check('H: then ready lands it on trunk', shipped.code === 0 && git(held.repo, 'merge-base', '--is-ancestor', heldSha, 'master') === '', shipped.out + shipped.err)

// ---------------------------------------------------------------- not held: dispatched as before
const free = fixture('not-held')
const freeAnswer = decider(free, FREE)
const freeSha = committed(free, 'feature')
free.patch((s) => { delete s.lanes.a })
free.run('retry')
const freeKey = `lane:a:${freeSha}`
check('I: work no release holds still gets exactly one finishing chat',
  free.requests().length === 1 && free.requests()[0].key === freeKey && free.state().recovery.items[freeKey]?.status === 'dispatched' && !free.state().recovery.items[freeKey].held,
  JSON.stringify(free.state().recovery))
check('J: ...after asking the decider once', freeAnswer.asked().length === 1, JSON.stringify(freeAnswer.asked()))

// ------------------------------------------- a finishing chat ended, and the work is now held
// The liftgym shape: the first chat ended without recording anything, so the clock would
// send a second one. Held by then, it is recorded as held instead.
free.patch((s) => { Object.assign(s.recovery.items[freeKey], { owner: 'gone-chat', status: 'owned', at: Date.now() - 46 * 60_000 }) })
writeFileSync(free.beat, JSON.stringify({ at: Date.now(), chats: [] })); writeFileSync(free.panes, '')
freeAnswer.say(HELD)
free.run('retry')
const resumed = free.state().recovery.items[freeKey]
check('K: an ended finishing chat whose work is now held gets no successor',
  free.requests().length === 1 && resumed?.status === 'blocked' && resumed.held === true && resumed.owner === null && !free.state().recovery.active,
  JSON.stringify(free.state().recovery))

finish()
