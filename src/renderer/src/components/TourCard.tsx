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
// a check is still running), then moves on by itself. Pause stops it where it is and the
// arrows still work; pressing either one pauses, because somebody steering is somebody who
// does not want it moving under them. The button that opened a pane and typed the change's
// own prompt is gone (Robert 2026-09-04: "i dont want the try in pane testing helper").
//
// Same shape as every other corner card (`MoveSoon.tsx`, `WhatsNewCard.tsx`): a static
// child of `.corner-stack`, never its own `position: fixed`, no animation, no focus taken.
// `.tour-card` follows design-vault/linear.app.md: surface ladder, hairline border, no
// motion beyond the two hover durations.

import { useEffect, useState } from 'react'
import type { TourCheck, TourState, TourSurface } from '../../../shared/tour'
import { checkName, currentStep, done, dwellFor, howToCheck, next, nextUnchecked, previous, stepKey } from '../../../shared/tour'
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
  const [doneMap, setDoneMap] = useState<Record<string, boolean>>(() => loadMap(DONE_KEY))

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
    setChecks((c) => ({ ...c, [index]: { state: 'running' } }))
    void Promise.all(step.checks.map((s) => api.tourCheck(s))).then((results) =>
      setChecks((c) => ({ ...c, [index]: { state: 'done', results } }))
    )
  }

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
    if (wait === null) return
    const t = setTimeout(() => setState((s) => (s ? next(s) : s)), wait)
    return () => clearTimeout(t)
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
        <div className="tour-count">
          {doneCount} of {state.steps.length} checked
          {playing && !isLast ? ' · playing' : ''}
        </div>
        <div className="tour-body">
          <div className="tour-text">{step.text}</div>
          <div className="tour-where">Where to look: {step.where}</div>
          <div className="tour-how">{howToCheck(step)}</div>
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
              <button type="button" className="ghost small tour-run" data-testid="tour-run" onClick={runChecks}>
                Run {step.checks.map(checkName).join(', ')}
              </button>
            ) : check.state === 'running' ? (
              <div className="tour-check running">Checking {step.checks.map(checkName).join(', ')}…</div>
            ) : (
              check.results.map((r) => (
                <div key={r.script} className={'tour-check ' + (r.ok ? 'ok' : 'bad')}>
                  <span className="tour-check-mark">{r.ok ? '✓' : '✗'}</span>
                  <span>
                    {checkName(r.script)}: {r.ok ? `${r.passed} checks passed` : `failed (${r.failed} of ${r.passed + r.failed})`}
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
        {step.checks.length === 0 && step.byHand.length === 0 && (
          <div className="tour-check none">No automatic check came with this change.</div>
        )}
        </div>
        <div className="tour-acts">
          <button
            type="button"
            className="ghost small"
            data-testid="tour-play"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? 'Pause' : isLast ? 'Play again' : 'Start the tour'}
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={state.index === 0}
            onClick={() => {
              setPlaying(false)
              setState((s) => (s ? previous(s) : s))
            }}
          >
            Previous
          </button>
          {!isLast && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setPlaying(false)
                setState((s) => (s ? next(s) : s))
              }}
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
