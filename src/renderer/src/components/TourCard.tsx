// A dev copy walks you through what it has that the installed app does not - see
// `src/shared/tour.ts` for the arithmetic this only draws. `App.tsx` asks `api.tour()`
// once on mount; the answer is `null` outside a dev copy, so the installed app never sees
// this card at all.
//
// Each step: the change in plain words, WHERE it lives, what to look for, a ring drawn
// around the control it is about (`TourSpot`), and the change's own test suites run right
// here with the result on the card - so a change with nothing to click still gets checked
// in front of you.
//
// AND IT PLAYS ITSELF. The card opens each step's surface, waits long enough for the thing
// to be looked at (`dwellFor` - longer when there is something on screen, and never while
// a check is still running), then moves on by itself. Pause is the ONLY thing that stops
// it: Next and Previous are steering, not stopping - they move to that step and the tour
// carries on from there (Robert 2026-09-04: "it should still continue with tour if i press
// next, its just to go to the next thing"). The button that opened a pane and typed the
// change's own prompt is gone (Robert 2026-09-04: "i dont want the try in pane testing
// helper"), and so is the one that asked before running a step's checks.
//
// Same shape as every other corner card (`MoveSoon.tsx`, `WhatsNewCard.tsx`): a static
// child of `.corner-stack`, never its own `position: fixed`, no animation, no focus taken.
// `.tour-card` follows design-vault/linear.app.md: surface ladder, hairline border, no
// motion beyond the two hover durations.

import { useEffect, useState } from 'react'
import type { TourCheck, TourProgress, TourState, TourStep, TourSurface } from '../../../shared/tour'
import { NO_SCREEN, checkWords, currentStep, done, dwellFor, howToCheck, next, nextUnchecked, previous, stepKey, waitsForYou } from '../../../shared/tour'
import CardX from './CardX'

const api = window.api

// Which steps have been ticked done - kept across a reopen of the same dev copy. Keyed by
// the commit's own subject (`stepKey`), never a slot number, so a rebuilt tour with the
// same commits still remembers what was already looked at.
const DONE_KEY = 'tour.done'

function loadMap(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function saveMap(key: string, map: Record<string, boolean>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    // Private window or full storage - the tour still works, it just forgets between opens.
  }
}

export interface TourCardProps {
  /** Set the same state the button for that surface sets - `setPicking(true)` for New
   * session, and so on. Called whenever the step now on screen changes. */
  onOpen: (surface: TourSurface) => void
}

type Checking = { state: 'running' } | { state: 'done'; results: TourCheck[] }

/** A ring around the control a step is about. Re-measured on a slow tick because the
 * surface it points at is opened by state the card cannot see settle; nothing animates. */
function TourSpot({ selector }: { selector: string }): JSX.Element | null {
  const [box, setBox] = useState<DOMRect | null>(null)
  useEffect(() => {
    const read = (): void => {
      const el = document.querySelector(selector)
      setBox(el ? el.getBoundingClientRect() : null)
    }
    read()
    const t = setInterval(read, 400)
    window.addEventListener('resize', read)
    return () => {
      clearInterval(t)
      window.removeEventListener('resize', read)
    }
  }, [selector])
  if (!box || box.width === 0) return null
  const pad = 6
  return (
    <div
      className="tour-spot"
      data-testid="tour-spot"
      style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
    />
  )
}

export default function TourCard({ onOpen }: TourCardProps): JSX.Element | null {
  const [state, setState] = useState<TourState | null>(null)
  const [gone, setGone] = useState(false)
  const [checks, setChecks] = useState<Record<number, Checking>>({})
  // NOT playing until it is asked to. The tour opens surfaces and runs test suites, and
  // doing either the moment a window appears is the app taking a turn nobody asked for:
  // Robert 2026-09-04, watching a suite start on its own - "it should wait for my approval
  // for each new feature to test". So the card waits on `Start`, and each step's checks
  // wait on their own press.
  const [playing, setPlaying] = useState(false)
  // Started once, for the whole run. Pressing Next or Previous STEERS the tour, it does
  // not stop it (Robert 2026-09-04: "when i start tour on dev window it should still
  // continue with tour if i press next, its just to go to the next thing") - so the two
  // arrows change `index` and nothing else, and only Pause clears `playing`. `started`
  // outlives a pause, which is what keeps each step's checks running by themselves after
  // one: the button that used to ask per step is gone.
  const [started, setStarted] = useState(false)
  const [doneMap, setDoneMap] = useState<Record<string, boolean>>(() => loadMap(DONE_KEY))
  // The last line the running check printed, and its tally so far - see `main/tour.ts`,
  // which sends one of these per counted line rather than a buffer at the end.
  const [live, setLive] = useState<TourProgress | null>(null)
  // Milliseconds left before the tour moves itself on, or null when nothing is counting.
  // A number nobody can see is a tour that looks stuck; Robert asked for the countdown
  // outright (2026-09-04, "add a coutndown when starting the tour").
  const [left, setLeft] = useState<number | null>(null)

  useEffect(() => api.onTourCheckLine((p: TourProgress) => setLive(p)), [])

  useEffect(() => {
    let live = true
    void api
      .tour()
      .then((t) => {
        if (!live || !t) return
        // A step already ticked done is skipped - the tour opens on the first one that is
        // not, never back at the first step just because it exists.
        const start = nextUnchecked(t.steps, doneMap)
        setState(start === -1 ? t : { ...t, index: start })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Only runs once, at mount - `doneMap` here is whatever loaded from storage before this
    // fired, which is all a start position needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const index = state?.index ?? -1
  useEffect(() => {
    if (!state || gone) return
    const step = currentStep(state)
    onOpen(step.open)
    // Only the step actually on screen should open anything - not `onOpen` itself, which
    // is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, gone])

  const runChecks = (): void => {
    if (!state) return
    const step = currentStep(state)
    if (!step.checks.length || checks[index]) return
    setLive(null)
    setChecks((c) => ({ ...c, [index]: { state: 'running' } }))
    void Promise.all(step.checks.map((s) => api.tourCheck(s))).then((results) =>
      setChecks((c) => ({ ...c, [index]: { state: 'done', results } }))
    )
  }

  // A TOUR RUNS ITS OWN CHECKS. The card used to wait to be told, one button press per
  // step - which was right while the card was something you clicked through, and became
  // the thing standing between Robert and a tour that plays itself: "if we doing tour then
  // it should do everything itself so we wont need the run test:cloudwork" (2026-09-04,
  // reversing his own 2026-09-04 "it should wait for my approval for each new feature to
  // test"). It still never runs anything until the tour is STARTED - that press is the
  // approval, once, for the whole run. It is keyed on `started`, not `playing`: a step
  // arrived at by pressing Next, or sat on while paused, is still a step in a tour that
  // was started, and Robert asking "why is there button checking this change? is it even
  // needed" is that button's answer - it is gone, nothing on the card asks twice.
  useEffect(() => {
    if (!state || gone || !started) return
    if (!currentStep(state).checks.length || checks[index]) return
    runChecks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, gone, started])

  // Playing: hold on this step for as long as it needs to be looked at, then move on.
  // The timer is rebuilt whenever the step, the play state or this step's checks change,
  // so a step that was holding for a check starts its dwell the moment the result lands.
  const checkRunning = checks[index]?.state === 'running'
  useEffect(() => {
    if (!state || gone || !playing) return
    if (done(state)) {
      // The last step is where it stops: nothing wraps, and the card stays on the change
      // most recently made rather than starting the list again under somebody reading it.
      setPlaying(false)
      return
    }
    const wait = dwellFor(currentStep(state), checkRunning)
    if (wait === null) {
      setLeft(null)
      return
    }
    // One second at a time, so the card can show the number going down. The move itself
    // still happens on its own timer below - a countdown that DECIDED when to move would
    // drift against it, and the two disagreeing is the bug this app has already had once
    // (`MoveSoon`, 2026-08-30).
    const until = Date.now() + wait
    setLeft(wait)
    const tick = setInterval(() => setLeft(Math.max(0, until - Date.now())), 500)
    const t = setTimeout(() => {
      // A step the tour has SHOWN is a step that has been checked off. Without this the
      // counter sat at `0 of 44` however long it ran, so the one number on the card that
      // says how far through you are said nothing, and there was no way to stop halfway
      // and come back - Robert, 2026-09-04: "0 of 44 checked and it keeps going next
      // thing". Ticking happens on the way OUT, never on arrival: a step still on screen
      // has not been looked at yet.
      tickDone(currentStep(state))
      setState((s) => (s ? next(s) : s))
    }, wait)
    return () => {
      clearTimeout(t)
      clearInterval(tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, gone, playing, checkRunning])

  if (!state) return null
  // Dismissed or Done: a pill stays in the corner so the steps can always be found
  // again (Robert 2026-09-04: "all times in dev window show that test steps").
  if (gone)
    return (
      <button type="button" className="tour-pill" data-testid="tour-pill" onClick={() => setGone(false)}>
        Test steps · {state.index + 1} of {state.steps.length}
      </button>
    )

  const step = currentStep(state)
  const isLast = done(state)
  const check = checks[index]
  const key = stepKey(step)
  const doneCount = state.steps.filter((s) => doneMap[stepKey(s)]).length
  const allDone = doneCount === state.steps.length

  // Tick a step off without moving anywhere - what the play loop uses on its way out of a
  // step, since it is already deciding where to go next. `markDone` below is the same
  // write plus the jump, which is what a PRESS should do and an automatic tick must not.
  const tickDone = (s: TourStep): void => {
    const k = stepKey(s)
    setDoneMap((was) => {
      if (was[k]) return was
      const upd = { ...was, [k]: true }
      saveMap(DONE_KEY, upd)
      return upd
    })
  }

  // Ticking a step off moves to the next one still unticked, so the card is always sitting
  // on something that has not been looked at yet.
  const markDone = (): void => {
    if (doneMap[key]) return
    const nextDone = { ...doneMap, [key]: true }
    setDoneMap(nextDone)
    saveMap(DONE_KEY, nextDone)
    const upcoming = nextUnchecked(state.steps, nextDone)
    if (upcoming !== -1) setState((s) => (s ? { ...s, index: upcoming } : s))
  }

  if (allDone)
    return (
      <div className="tour-card" role="status" data-testid="tour-card">
        <CardX onDismiss={() => setGone(true)} />
        <div className="tour-count">
          {doneCount} of {state.steps.length} checked
        </div>
        <div className="tour-body">
          <div className="tour-text">Every step is checked off.</div>
        </div>
        <div className="tour-acts">
          <button type="button" className="primary small" data-testid="tour-done" onClick={() => setGone(true)}>
            Close
          </button>
        </div>
      </div>
    )

  return (
    <>
      <div className="tour-card" role="status" data-testid="tour-card">
        <CardX onDismiss={() => setGone(true)} />
        <div className="tour-head">
          <div className="tour-count">
            Step {state.index + 1} of {state.steps.length}
            <span className="tour-count-done"> · {doneCount} checked</span>
          </div>
          {playing && !isLast && (
            <div className="tour-state" data-testid="tour-state">
              {waitsForYou(step) ? 'waiting for you' : left !== null ? `next in ${Math.ceil(left / 1000)}s` : 'playing'}
            </div>
          )}
        </div>
        <div className="tour-bar" aria-hidden="true">
          <span style={{ width: `${(doneCount / state.steps.length) * 100}%` }} />
        </div>
        <div className="tour-body">
          <div className="tour-text">{step.text}</div>
          {step.where !== NO_SCREEN && <div className="tour-where">Where to look: {step.where}</div>}
          <div className="tour-how">{howToCheck(step)}</div>
          {playing && waitsForYou(step) && (
            <div className="tour-wait" data-testid="tour-wait">
              Take as long as you want here - tick Done or press Next to carry on.
            </div>
          )}
        {step.see.length > 0 && (
          <ul className="tour-see">
            {step.see.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
        {step.checks.length > 0 && (
          <div className="tour-checks" data-testid="tour-checks">
            {!check ? (
              // No button. Before the tour is started this says what WILL happen; after it,
              // the check is already on its way and this is the half-second before the
              // running row replaces it.
              <div className="tour-check waiting" data-testid="tour-check-waiting">
                <span className="tour-check-mark">·</span>
                <span>{started ? `${checkWords(step.checks.length)}…` : `${checkWords(step.checks.length)} when you start the tour`}</span>
              </div>
            ) : check.state === 'running' ? (
              <div className="tour-check running">
                {/* Three dots on a `steps()` loop - discrete, so it composites on the step
                    and not on the frame (see scripts/anim-cost-test.mjs). It is the one
                    thing on the card that says the suite is alive between two lines. */}
                <span className="tour-check-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  {checkWords(step.checks.length)}…
                  {live && (
                    <span className="tour-check-count">
                      {' '}
                      {live.passed} proved
                      {live.failed > 0 ? `, ${live.failed} failed` : ''}
                    </span>
                  )}
                </span>
                {/* What it is doing THIS second, straight off the suite's own output. */}
                {live && <div className="tour-check-live" data-testid="tour-check-live">{live.line}</div>}
              </div>
            ) : (
              check.results.map((r) => (
                <div key={r.script} className={'tour-check ' + (r.ok ? 'ok' : 'bad')}>
                  <span className="tour-check-mark">{r.ok ? '✓' : '✗'}</span>
                  <span>
                    {r.ok
                      ? `Checked - ${r.passed} things proved`
                      : `Something is wrong here - ${r.failed} of ${r.passed + r.failed} failed`}
                  </span>
                  {!r.ok && <pre className="tour-check-tail">{r.tail}</pre>}
                </div>
              ))
            )}
          </div>
        )}
        {step.byHand.length > 0 && (
          <div className="tour-check byhand">Needs a window - run by hand: {step.byHand.join(', ')}</div>
        )}
        </div>
        <div className="tour-acts">
          <button
            type="button"
            className="ghost small"
            data-testid="tour-play"
            onClick={() => {
              setStarted(true)
              setPlaying((p) => !p)
            }}
          >
            {playing ? 'Pause' : isLast ? 'Play again' : started ? 'Carry on' : 'Start the tour'}
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={state.index === 0}
            onClick={() => setState((s) => (s ? previous(s) : s))}
          >
            Previous
          </button>
          {!isLast && (
            <button
              type="button"
              className="ghost small"
              onClick={() => setState((s) => (s ? next(s) : s))}
            >
              Next
            </button>
          )}
          <label className="tour-step-done">
            <input type="checkbox" data-testid="tour-step-done" checked={!!doneMap[key]} disabled={!!doneMap[key]} onChange={markDone} />
            Done
          </label>
          <button type="button" className="primary small" data-testid="tour-dismiss" onClick={() => setGone(true)}>
            Close
          </button>
        </div>
      </div>
      {step.spot && <TourSpot selector={step.spot} />}
    </>
  )
}
