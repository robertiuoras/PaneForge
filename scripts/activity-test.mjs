// Two halves, and the second one is the load-bearing half.
//
// The arithmetic of the activity list is small: cap it, drop a duplicate, count what is
// new, and refuse to make a row out of a sweep that has only PICKED a pane. Those are
// checked first because they are cheap.
//
// The half that matters is the corner. The bug this shipped for was not in any of these
// functions: five cards were `position: fixed` at the same `right: 18px; bottom: 18px`,
// told apart only by z-index, so two of them up at once meant one was drawn underneath
// the other with its buttons unreachable (2026-09-01: "we couldnt see the keep it open or
// close now buttons"). A stacking bug cannot be caught by unit-testing the cards, so this
// reads the SOURCE: every card that docks in that corner must be inside `.corner-stack`,
// and none of them may still carry a `position: fixed` corner of its own inside it.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-activity-'))
const outfile = join(work, 'activity.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/activity.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { addActivity, unreadCount, activityFromReclaim, entry, MAX_ACTIVITY, KIND_WORDS, SAME_MS } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

const NOW = 1_700_000_000_000

// --- the list ---------------------------------------------------------------

{
  const one = entry('closed', 'closed (3) taskdriver', 'it had been quiet 31 min', NOW)
  const list = addActivity([], one)
  eq('an entry lands', list.length, 1)
  eq('newest first', list[0].what, 'closed (3) taskdriver')

  // Same thing said twice inside the window is one thing happening. The SAME array comes
  // back so the caller can skip a disk write and a broadcast by reference.
  const again = addActivity(list, entry('closed', 'closed (3) taskdriver', undefined, NOW + 100))
  check('a duplicate is dropped', again === list)

  // ...and past the window it is a second event, because a pane really can be closed
  // twice: closed, reopened from History, closed again.
  const later = addActivity(list, entry('closed', 'closed (3) taskdriver', undefined, NOW + SAME_MS + 1))
  eq('past the window it is a second thing', later.length, 2)

  // A different pane at the same instant is never a duplicate.
  const other = addActivity(list, entry('closed', 'closed (4) secondtonone', undefined, NOW))
  eq('a different pane is its own row', other.length, 2)
}

{
  let list = []
  for (let i = 0; i < MAX_ACTIVITY + 40; i++) {
    list = addActivity(list, entry('closed', `closed pane ${i}`, undefined, NOW + i * 10_000))
  }
  eq('the list is capped', list.length, MAX_ACTIVITY)
  eq('and it is the NEWEST that survive', list[0].what, `closed pane ${MAX_ACTIVITY + 39}`)
}

{
  const list = [
    entry('closed', 'a', undefined, NOW + 3000),
    entry('closed', 'b', undefined, NOW + 2000),
    entry('closed', 'c', undefined, NOW + 1000)
  ]
  eq('nothing seen counts everything', unreadCount(list, 0), 3)
  eq('seen in the middle counts the newer half', unreadCount(list, NOW + 1500), 2)
  eq('seen after the newest counts nothing', unreadCount(list, NOW + 9000), 0)
  // The clock the badge is judged against is the SEEN time, not now: a list opened and
  // left open must not start counting rows the person is looking at.
  eq('an entry exactly at the seen moment is not new', unreadCount(list, NOW + 3000), 0)
}

// --- what becomes a row, and what does not -----------------------------------

{
  const closed = activityFromReclaim({ event: 'closed', id: 's1', name: '(3) taskdriver', idleMin: 31 }, NOW)
  check('a close is a row', closed !== null)
  eq('...saying what it did', closed.kind, 'closed')
  check('...naming the pane the way the rest of the app does', closed.what.includes('(3) taskdriver'))
  // The row's left column already says Closed. A sentence that says it again reads
  // "Closed closed (3) taskdriver", which is what the first live desk drew.
  for (const [kind, word] of Object.entries(KIND_WORDS)) {
    void kind
    check('the sentence does not repeat the kind word', !closed.what.toLowerCase().startsWith(word.toLowerCase()), closed.what)
  }
  check('...and why', closed.why.includes('31 min'))

  // The refusal. A sweep that has only PICKED a pane has a countdown card on screen
  // saying so, and it can still be kept open - a row saying "closed" that was then kept
  // is a lie left on a list nobody re-reads.
  eq('armed is NOT a row', activityFromReclaim({ event: 'armed', id: 's1', name: '(3) x' }, NOW), null)
  eq('an unknown event is not a row', activityFromReclaim({ event: 'wibble' }, NOW), null)
  eq('a line with no event at all is not a row', activityFromReclaim({}, NOW), null)

  const moved = activityFromReclaim({ event: 'moved', name: '(2) vrb', to: 'DESKTOP-CMSUCM1' }, NOW)
  check('a move names where it went', moved.what.includes('DESKTOP-CMSUCM1'))
  const slept = activityFromReclaim({ event: 'slept', name: '(5) betting', idleMin: 30 }, NOW)
  eq('sleep is its own kind', slept.kind, 'slept')

  // A line whose pane has no name still produces a readable sentence rather than `undefined`.
  const bare = activityFromReclaim({ event: 'closed' }, NOW)
  check('a nameless close still reads', /^a pane$/.test(bare.what), bare.what)
}

// --- every word on it is plain ------------------------------------------------

{
  // Same rule as `test:laneplain`: the reader has never used git and does not know what
  // the code calls any of this.
  const banned = /\b(lane|worktree|checkout|trunk|pty|ipc|sweep|reclaim|verdict|slot)\b/i
  for (const [kind, word] of Object.entries(KIND_WORDS)) {
    check(`the word for ${kind} is plain`, !banned.test(word), word)
    check(`the word for ${kind} is a word`, /^[A-Z][a-z]+$/.test(word), word)
  }
  const rows = [
    activityFromReclaim({ event: 'closed', name: '(3) taskdriver', idleMin: 31 }, NOW),
    activityFromReclaim({ event: 'moved', name: '(2) vrb', to: 'PC' }, NOW),
    activityFromReclaim({ event: 'slept', name: '(5) betting', idleMin: 30 }, NOW),
    activityFromReclaim({ event: 'trimmed', name: '(1) PaneForge' }, NOW)
  ]
  for (const r of rows) {
    check('the sentence is plain', !banned.test(r.what + ' ' + (r.why ?? '')), r.what)
  }
}

// --- the corner is ONE column -------------------------------------------------

const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

{
  const open = app.indexOf("<div className={'corner-stack'")
  check('the stack exists', open > 0)
  // Its closing tag: the first `      </div>` at the same indentation after the open.
  const close = app.indexOf('\n      </div>', open)
  check('the stack is closed', close > open)

  // Every card that docks in that corner. If a sixth is ever added at `right: 18px;
  // bottom: 18px` and left outside this list, the CSS check below is what catches it.
  for (const tag of ['<AutoClearToast', '<MoveSoon', '<ClientToast', '<UpdateToast', '<WhatsNewCard', '<Tips']) {
    const at = app.indexOf(tag)
    check(`${tag} is drawn`, at > 0)
    check(`${tag} is inside the stack`, at > open && at < close, { at, open, close })
  }

  // The order is the promise: the FIRST child is the one in the corner (the column is
  // reversed), and it must be a countdown - the card whose buttons take something away
  // if they are not pressed. A tip must be furthest from the hand.
  const order = ['<AutoClearToast', '<MoveSoon', '<ClientToast', '<UpdateToast', '<WhatsNewCard', '<Tips'].map(
    (t) => app.indexOf(t)
  )
  for (let i = 1; i < order.length; i++) {
    check(`urgency order holds at ${i}`, order[i] > order[i - 1], order)
  }
  check('the column is reversed, or the order above is upside down', /\.corner-stack\s*\{[^}]*column-reverse/.test(css))
}

{
  // The bug itself, as a rule: nothing inside the stack may still place ITSELF in the
  // corner. Two cards that both say `position: fixed; right: 18px; bottom: 18px` are two
  // cards in one place again, whatever the stack does around them.
  const rule = css.match(/\.corner-stack > \.move-soon,[\s\S]*?\{([^}]*)\}/)
  check('the stack un-fixes its children', Boolean(rule))
  // relative, not static: `.card-x` inside each card anchors to its own card.
  check('...by making them relative', /position:\s*relative/.test(rule[1]), rule && rule[1])
  for (const sel of ['.autoclear-card', '.move-soon', '.client-toast', '.update-toast', '.tip-toast']) {
    check(`${sel} is un-fixed inside the stack`, css.includes(`.corner-stack > ${sel}`), sel)
  }
  // One step up for the whole stack when a sprite is parked in the same corner - and the
  // per-card version of that must be gone, or the stack steps up twice.
  check('the stack steps up off the pet', /\.corner-stack\.beside-pet\s*\{\s*bottom:\s*108px/.test(css))
  check('and the card no longer does it too', /\.corner-stack > \.client-toast\.beside-pet\s*\{\s*bottom:\s*auto/.test(css))
  // No animation: `test:anim` refuses a looping decoration, and this is a container.
  const stack = css.match(/\.corner-stack\s*\{([^}]*)\}/)
  check('the stack has no animation', !/animation|transition/.test(stack[1]), stack[1])
  // The layer must not eat clicks meant for the panes underneath it.
  check('the layer takes no clicks', /pointer-events:\s*none/.test(stack[1]))
  check('...but the cards do', /\.corner-stack > \*\s*\{\s*pointer-events:\s*auto/.test(css))
}

{
  // The bell is a READING: it opens a panel, and the panel is not a dialog - nothing in
  // it can be pressed, so it must never dim or take the screen.
  check('the flyout is drawn', app.includes('<ActivityFlyout'))
  check('opening it marks the list seen', app.includes('api.markActivitySeen()'))
  const fly = readFileSync(join(root, 'src/renderer/src/components/ActivityFlyout.tsx'), 'utf8')
  check('no row is a button', !/<button[^>]*className="act-row/.test(fly))
  check('escape closes it', fly.includes("e.key === 'Escape'"))
  check('the empty state is a sentence, not a container', fly.includes('Nothing has happened on its own yet.'))
  const back = css.match(/\.act-back\s*\{([^}]*)\}/)
  check('the backdrop is drawn', Boolean(back))
  check('the backdrop does not dim', !/background/.test(back[1]), back && back[1])
}

{
  // Every corner card carries the one shared dismiss button, top-right - never a
  // one-off X hand-drawn per card.
  for (const file of [
    'AutoClearToast.tsx',
    'MoveSoon.tsx',
    'StopServer.tsx',
    'ClientToast.tsx',
    'UpdateToast.tsx',
    'WhatsNewCard.tsx',
    'Tips.tsx'
  ]) {
    const src = readFileSync(join(root, 'src/renderer/src/components', file), 'utf8')
    check(`${file} imports CardX`, /import CardX from ['"]\.\/CardX['"]/.test(src), file)
    check(`${file} renders <CardX`, src.includes('<CardX'), file)
  }
  const cardX = readFileSync(join(root, 'src/renderer/src/components/CardX.tsx'), 'utf8')
  check('CardX is a button, not a link or a div', /<button/.test(cardX))
  check('CardX names itself for a screen reader', /aria-label="Dismiss"/.test(cardX))
}

rmSync(work, { recursive: true, force: true })
console.log(`activity: ${checks} checks passed`)
