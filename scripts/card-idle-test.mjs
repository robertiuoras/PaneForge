#!/usr/bin/env node
/**
 * A card nobody touched goes away by itself - and the cards that are ASKING something
 * never do.
 *
 * The arithmetic is `src/shared/cardIdle.ts`; the binding is `renderer/src/idleDismiss.ts`.
 * The load-bearing half of this file is the refusal list: a countdown card that quietly
 * picked this up would vanish instead of doing the thing it was counting down to.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { CARD_IDLE_MS, idleLeft, idleGone } = await import(
  pathToFileURL(join(root, 'src/shared/cardIdle.ts')).href
)

let bad = 0
const ok = (what, cond) => {
  console.log((cond ? 'ok    ' : 'FAIL  ') + what)
  if (!cond) bad++
}

const now = 1_000_000
console.log('a card nobody touched')
ok('five minutes, not thirty seconds', CARD_IDLE_MS === 5 * 60_000)
ok('fresh card has its whole clock', idleLeft({ since: now, held: false }, now) === CARD_IDLE_MS)
ok('and is not gone yet', !idleGone({ since: now, held: false }, now))
ok('gone once the clock runs out', idleGone({ since: now, held: false }, now + CARD_IDLE_MS))
ok('and stays gone past it', idleGone({ since: now, held: false }, now + CARD_IDLE_MS * 3))
// A pointer resting on it is somebody reading it. A held card has NO deadline at all -
// the same shape a tour step that waits for a person uses, rather than a paused number.
ok('a pointer on it holds it', idleLeft({ since: now, held: true }, now + CARD_IDLE_MS) === null)
ok('and a held card is never gone', !idleGone({ since: now, held: true }, now + CARD_IDLE_MS * 10))
// Touching it restarts the clock, it does not extend an expired one.
ok('a touch restarts the clock', idleLeft({ since: now + 10_000, held: false }, now + 10_000) === CARD_IDLE_MS)
ok('the clock never goes negative', idleLeft({ since: now, held: false }, now + CARD_IDLE_MS * 2) === 0)

console.log('\nwhat may use it')
const card = readFileSync(join(root, 'src/renderer/src/components/WhatsNewCard.tsx'), 'utf8')
ok('what changed in this build goes on its own', /useIdleDismiss\(shown, \(\) => setGone\(true\)\)/.test(card))
ok('and the handlers actually reach the card', /\{\.\.\.idle\.handlers\}/.test(card))

// THE REFUSALS. Each of these is counting down to doing something, or asking for an
// answer; a card like that ending itself by fading out is the app dropping the decision.
console.log('\nwhat may not')
for (const f of [
  'MoveSoon.tsx',
  'OffloadSoon.tsx',
  'AutoClearToast.tsx',
  'StopServer.tsx',
  'LoginCard.tsx',
  'UpdateToast.tsx',
  'TourCard.tsx'
]) {
  const src = readFileSync(join(root, 'src/renderer/src/components/' + f), 'utf8')
  ok(`${f} still ends at its own deadline`, !/useIdleDismiss/.test(src))
}

const hook = readFileSync(join(root, 'src/renderer/src/idleDismiss.ts'), 'utf8')
ok('one timeout, never a tick - nothing is drawn from this clock', !/setInterval/.test(hook))
ok('the callback is held in a ref, so a re-render does not restart the clock', /go\.current = onGone/.test(hook))

console.log(bad ? `\ncardidle: ${bad} failed` : '\ncardidle: all good')
process.exit(bad ? 1 : 0)
