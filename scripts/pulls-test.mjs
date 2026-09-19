// What the GitHub screen says, without GitHub.
//
// The wording is the whole feature: the rows exist so somebody who has never run `git`
// can tell at a glance which change is stuck and on whom. So these pin the SENTENCES
// and the order, not the fetching.
//
//   node scripts/pulls-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pulls-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'pulls.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/pulls.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { pullWords, needsSomebody, waitingCount, branchWords, sortPulls, agoWords, unsavedWords, repoWords } =
  createRequire(import.meta.url)(out)

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failed++
}

const pull = (over) => ({
  number: 1,
  title: 'a change',
  author: 'someone',
  draft: false,
  branch: 'lane-a',
  url: 'https://github.com/x/y/pull/1',
  updatedAt: 0,
  checks: 'passing',
  review: 'none',
  mergeable: true,
  mine: false,
  ...over
})

// ---------- one sentence, worst news first ----------
{
  check('a draft is nobody else’s problem yet', pullWords(pull({ draft: true, checks: 'failing' })) === 'Still being written')
  check('red tests outrank a review', pullWords(pull({ checks: 'failing', review: 'approved' })) === 'Its tests went red')
  check('a clash outranks a waiting review', pullWords(pull({ mergeable: false, review: 'waiting' })) === 'Clashes with the main copy')
  check('changes asked for', pullWords(pull({ review: 'changes' })) === 'Someone asked for changes')
  check('still running', pullWords(pull({ checks: 'running' })) === 'Tests still running')
  check('approved says it can go in', pullWords(pull({ review: 'approved' })) === 'Approved - it can go in')
  check('and the default is the honest one', pullWords(pull({})) === 'Nobody has looked at it yet')
  // No sentence here may use a word the reader would have to look up.
  const banned = /\b(merge conflict|rebase|upstream|HEAD|ref|commit-ish|CI)\b/i
  const all = [
    pullWords(pull({ draft: true })), pullWords(pull({ checks: 'failing' })),
    pullWords(pull({ mergeable: false })), pullWords(pull({ review: 'changes' })),
    pullWords(pull({ checks: 'running' })), pullWords(pull({ review: 'approved' })), pullWords(pull({}))
  ]
  check('no sentence needs a glossary', all.every((s) => !banned.test(s)), all.join(' | '))
}

// ---------- who is waiting ----------
{
  check('a draft waits on nobody', needsSomebody(pull({ draft: true })) === false)
  check('an approved, green one waits on nobody', needsSomebody(pull({ review: 'approved' })) === false)
  check('an unreviewed one waits on somebody', needsSomebody(pull({})) === true)
  check('a red one waits on somebody', needsSomebody(pull({ checks: 'failing' })) === true)

  const answer = {
    at: 0,
    repos: [
      {
        path: '/p', name: 'p', remote: 'a/b', main: 'master', unsaved: 0,
        pulls: [pull({ number: 1 }), pull({ number: 2, review: 'approved' }), pull({ number: 3, draft: true })],
        branches: [
          { name: 'lane-a', ahead: 2, pushed: false, updatedAt: 0 },
          { name: 'lane-b', ahead: 1, pushed: true, updatedAt: 0 }
        ]
      }
    ]
  }
  // One unreviewed pull request plus one branch that never left the machine.
  check('the button’s number counts local work too', waitingCount(answer) === 2, String(waitingCount(answer)))
  check('no answer is no number', waitingCount(null) === 0)
  const dirty = { ...answer, repos: [{ ...answer.repos[0], unsaved: 4 }] }
  check('unsaved edits count once, however many files', waitingCount(dirty) === 3, String(waitingCount(dirty)))
  check('and say how many', unsavedWords(4) === '4 files changed and not saved into the project yet')
  check('one file is not "1 files"', unsavedWords(1).startsWith('1 file changed'))
}

// ---------- the order ----------
{
  const rows = sortPulls([
    pull({ number: 1, review: 'approved', updatedAt: 9000 }),
    pull({ number: 2, updatedAt: 1000 }),
    pull({ number: 3, updatedAt: 5000 })
  ])
  check(
    'anything wanting a person comes above a newer one that does not',
    rows.map((r) => r.number).join(',') === '3,2,1',
    rows.map((r) => r.number).join(',')
  )
}

// ---------- local work ----------
{
  const b = (over) => ({ name: 'lane-a', ahead: 3, pushed: false, updatedAt: 0, ...over })
  check('work only here says so', branchWords(b({}), 'master') === '3 changes only on this machine')
  check('pushed work names the branch it is not in', branchWords(b({ pushed: true }), 'master') === '3 changes not in master yet')
  check('one change is not "1 changes"', branchWords(b({ ahead: 1 }), 'master') === '1 change only on this machine')
}

// ---------- which project, which copy ----------
{
  check('a plain folder is its own name', repoWords('PaneForge') === 'PaneForge')
  check('a lane copy names the project and the copy', repoWords('PaneForge-f') === 'PaneForge, copy 7')
  check('the first letter copy is copy 2', repoWords('PaneForge-a') === 'PaneForge, copy 2')
  check('a legacy w-copy keeps its number', repoWords('PaneForge-w2') === 'PaneForge, copy 2')
  check('a real project ending in a letter is left alone', repoWords('right-key-alison') === 'right-key-alison')
}

// ---------- when ----------
{
  const now = Date.parse('2026-09-19T12:00:00Z')
  check('a moment ago', agoWords(now - 10_000, now) === 'just now')
  check('minutes', agoWords(now - 5 * 60_000, now) === '5 min ago')
  check('hours', agoWords(now - 2 * 3_600_000, now) === '2 hours ago')
  check('one hour is singular', agoWords(now - 3_600_000, now) === '1 hour ago')
  check('days', agoWords(now - 3 * 86_400_000, now) === '3 days ago')
  check('a clock that ran backwards still says something', agoWords(now + 60_000, now) === 'just now')
}

console.log(failed ? `\n${failed} FAILED` : '\nall good')
process.exit(failed ? 1 : 0)
