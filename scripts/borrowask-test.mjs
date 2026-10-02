// What a mirror may ask the host for, and what it may never ask again.
//
// The load-bearing half is the negatives: a target that wobbles by one cell, and a burst
// of genuinely different targets, are the two shapes that used to ask for ever.
import { strict as assert } from 'node:assert'
import {
  shouldAsk,
  BORROW_EVERY_MS,
  BORROW_TRIES,
  BORROW_WINDOW_MAX,
  BORROW_WINDOW_MS
} from '../src/shared/borrowAsk.ts'

let ok = 0
const is = (a, b, what) => {
  assert.equal(a, b, `${what}: got ${a}, wanted ${b}`)
  ok++
}

// A mirror wanting a grid the host is not drawing asks once.
{
  const out = shouldAsk({ cols: 153, rows: 51, hostCols: 69, hostRows: 35, now: 1000, state: null })
  is(out.ask, true, 'first ask')
}

// ...and not again inside the rate limit.
{
  const a = shouldAsk({ cols: 153, rows: 51, hostCols: 69, hostRows: 35, now: 1000, state: null })
  const b = shouldAsk({
    cols: 153,
    rows: 51,
    hostCols: 69,
    hostRows: 35,
    now: 1000 + BORROW_EVERY_MS - 1,
    state: a.state
  })
  is(b.ask, false, 'same target inside the rate limit')
}

// THE BUG. A target alternating by one cell is the same target: with the old
// exact-equality guard each of these looked new and reset the counter, so the mirror
// asked on every repaint and the host resized the pty between two grids for ever.
{
  let state = null
  let asks = 0
  let now = 0
  for (let i = 0; i < 200; i++) {
    now += 40 // a repaint every 40ms
    const cols = i % 2 ? 153 : 152
    const out = shouldAsk({ cols, rows: 51, hostCols: 69, hostRows: 35, now, state })
    state = out.state
    if (out.ask) asks++
  }
  is(asks <= BORROW_TRIES, true, `one-cell wobble over 8s asked ${asks} times, cap ${BORROW_TRIES}`)
}

// The window brake: targets that are genuinely different every time still cannot buy an
// unlimited number of asks.
{
  let state = null
  let asks = 0
  let now = 0
  for (let i = 0; i < 100; i++) {
    now += 40
    const out = shouldAsk({ cols: 100 + i * 5, rows: 51, hostCols: 69, hostRows: 35, now, state })
    state = out.state
    if (out.ask) asks++
  }
  is(asks <= BORROW_WINDOW_MAX, true, `${asks} asks in 4s, budget ${BORROW_WINDOW_MAX}`)
}

// ...and the budget drains, so a window resized ten minutes later is still answered.
{
  let state = null
  let now = 0
  for (let i = 0; i < 20; i++) {
    now += 40
    state = shouldAsk({ cols: 100 + i * 5, rows: 51, hostCols: 69, hostRows: 35, now, state }).state
  }
  const later = shouldAsk({
    cols: 300,
    rows: 80,
    hostCols: 69,
    hostRows: 35,
    now: now + BORROW_WINDOW_MS + 1,
    state
  })
  is(later.ask, true, 'budget drains after the window')
}

// CONTROL: the host already drawing what we want, to within the deadband, is not an ask.
// This is the case a mirror hits on every single repaint once it has settled.
{
  const out = shouldAsk({
    cols: 153,
    rows: 51,
    hostCols: 152,
    hostRows: 51,
    now: 5000,
    state: null
  })
  is(out.ask, false, 'one cell of slack is not worth a resize')
  is(shouldAsk({ cols: 153, rows: 51, hostCols: 153, hostRows: 51, now: 5000, state: null }).ask, false, 'exact match')
}

// ...but only one way. A host grid one cell BIGGER than the room does not fit, and the
// mirror would draw it a whole font size smaller (12 for a pane with room at 13), so that
// is an ask. Measured 2026-10-02: a lend settled at 123x39 against room for 119x41.
{
  is(shouldAsk({ cols: 152, rows: 51, hostCols: 153, hostRows: 51, now: 5000, state: null }).ask, true, 'one column too wide is an ask')
  is(shouldAsk({ cols: 153, rows: 50, hostCols: 153, hostRows: 51, now: 5000, state: null }).ask, true, 'one row too tall is an ask')
  // ...and it still settles: the host lends what is asked, a wobbling room is answered once.
  let state = null
  let host = { cols: 160, rows: 51 }
  let asks = 0
  for (let i = 0; i < 200; i++) {
    const want = { cols: i % 2 ? 153 : 152, rows: 51 }
    const out = shouldAsk({ cols: want.cols, rows: want.rows, hostCols: host.cols, hostRows: host.rows, now: i * 40, state })
    state = out.state
    if (out.ask) {
      asks++
      host = { ...want }
    }
  }
  is(asks <= 2, true, `a one-cell wobble against a lending host asked ${asks} times`)
}

// A target the host can NEVER grant - a second viewer is smaller, so `smallestBorrow`
// wins - gives up after the tries cap rather than asking for ever.
{
  let state = null
  let asks = 0
  let now = 0
  for (let i = 0; i < 100; i++) {
    now += BORROW_EVERY_MS
    // granted stays 50x30 whatever we ask for
    const out = shouldAsk({ cols: 153, rows: 51, hostCols: 50, hostRows: 30, now, state })
    state = out.state
    if (out.ask) asks++
  }
  is(asks, BORROW_TRIES, `ungrantable target asked ${asks} times`)
}

console.log(`borrowask: ${ok} checks ok`)
