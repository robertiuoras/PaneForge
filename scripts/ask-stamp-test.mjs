// A button that outlives its question, and the press that must not land.
//
// PaneForge already puts an agent's question on Robert's phone and turns a tap back into
// the arrows and the return (main/askNotify.ts, scripts/pf-telegram.mjs). What the tap
// carried was a pane id and an option number, and nothing else - so between a question
// being answered and the sweep that strips the buttons off the old message, a tap pressed
// option 2 of whatever that pane was asking at that moment. Silent, and it types.
//
// The fix is the one atomic-agent settled on for the same shape (MIT; dossier at
// claude-memory/toolstash/repo-dossiers/AtomicBot-ai--atomic-agent.md, "callback-id
// correlation" and "delete-before-resolve"): the button carries the identity of the
// question it was drawn for, and a press that names a question the pane has moved on from
// is refused. Where this differs from theirs on purpose: they auto-DENY on a timeout,
// which is a decision; refusing is not one, so nothing here ever answers a question.
//
// Two halves. The arithmetic, and then the source - because the copy of the hash that
// pf-telegram.mjs uses cannot import TypeScript, so the only thing stopping the two from
// drifting apart is the check below that runs both on the same input.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { askStamp as scriptStamp } from './ask-stamp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-ask-stamp-'))
const outfile = join(work, 'choices.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/choices.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { askStamp, stampMatches, sameAsk } = createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}

const ask = (over = {}) => ({
  question: 'Do you want to proceed?',
  selected: 1,
  options: [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'No, tell Claude what to do differently' }
  ],
  ...over
})

// ---- the stamp ----------------------------------------------------------------------

{
  check('a stamp is eight hex characters', /^[0-9a-f]{8}$/.test(askStamp(ask())), askStamp(ask()))
  check('no question, no stamp', askStamp(null) === '' && askStamp(undefined) === '')
  check('the same question stamps the same', askStamp(ask()) === askStamp(ask()))
}

{
  // The one the arrow's position must NOT change: somebody at the desk moving the
  // selection is not asking a different question, and keysForChoice navigates from
  // wherever the arrow really is when the press lands.
  const moved = ask({ selected: 2 })
  check('moving the selection does not change the question', askStamp(ask()) === askStamp(moved))
  check('and sameAsk agrees with it', sameAsk(ask(), moved))
}

{
  const relabelled = ask({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] })
  const requestioned = ask({ question: 'Delete the branch?' })
  const extra = ask({ options: [...ask().options, { n: 3, label: 'Always allow' }] })
  check('a changed option is a different question', askStamp(ask()) !== askStamp(relabelled))
  check('a changed question is a different question', askStamp(ask()) !== askStamp(requestioned))
  check('an option arriving is a different question', askStamp(ask()) !== askStamp(extra))
}

// ---- the refusal ---------------------------------------------------------------------

{
  check('nobody said, so nothing is checked', stampMatches(ask(), undefined))
  check('an empty stamp is nobody saying', stampMatches(ask(), ''))
  check('the right stamp presses', stampMatches(ask(), askStamp(ask())))
  check(
    'a stamp for the question that WAS being asked is refused',
    !stampMatches(ask({ question: 'Delete the branch?' }), askStamp(ask()))
  )
  check('a stamp against a pane asking nothing is refused', !stampMatches(null, askStamp(ask())))
  check(
    'and a pane asking nothing with nobody saying is still refused by the caller, not here',
    stampMatches(null, undefined)
  )
}

// ---- the copy in the script must agree with the app ----------------------------------

{
  for (const a of [ask(), ask({ selected: 3 }), ask({ question: 'Run npm test?' }), ask({ options: [] })]) {
    check(`the script's stamp matches the app's for "${a.question}"`, scriptStamp(a) === askStamp(a), [
      scriptStamp(a),
      askStamp(a)
    ])
  }
  check('and both refuse a missing question the same way', scriptStamp(null) === askStamp(null))
}

{
  // Telegram's callback_data is 64 BYTES. The stamp adds nine to a string that was already
  // checked - a mirrored pane's id carries a device name, and past the limit the button is
  // posted and every tap is silently ignored, which is the failure this whole file is about
  // wearing a different hat.
  const data = (id) => `c|${id}|2|${askStamp(ask())}`
  check('an ordinary pane id fits', Buffer.byteLength(data('s12-mtqtjw80')) <= 64, Buffer.byteLength(data('s12-mtqtjw80')))
  check(
    'and a mirrored one still fits',
    Buffer.byteLength(data('@roberts-macbook-pro/s12-mtqtjw80')) <= 64,
    Buffer.byteLength(data('@roberts-macbook-pro/s12-mtqtjw80'))
  )
}

// ---- the source: the stamp has to actually be carried and actually be checked ---------

{
  const tg = readFileSync(join(root, 'scripts/pf-telegram.mjs'), 'utf8')
  check('the button carries the stamp', /callbackData\(id, o\.n, want\)/.test(tg))
  check('the stamp comes off the question the button is drawn for', /const want = askStamp\(ask\)/.test(tg))
  check('a tap hands it back', /call\('pty:choose', \[id, Number\(n\), want \|\| undefined\]\)/.test(tg))
  check(
    'an older button with no stamp is still a real press',
    /may be absent/.test(tg) && /want \|\| undefined/.test(tg)
  )

  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  check('the press is refused on this desk', /manager\.choose\(id, n, 'desk', want\)/.test(index))
  check('and on the other one', /if \(!stampMatches\(ask, want\)\) return false/.test(index))

  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  check('the refusal is before a single key is written', /if \(!stampMatches\(ask, want\)\) return false/.test(sessions))
  check(
    'and nothing in it answers the question instead',
    !/autoDeny|auto-deny/.test(sessions + tg)
  )
}

rmSync(work, { recursive: true, force: true })
console.log(`ask stamp: ${checks} checks passed`)
