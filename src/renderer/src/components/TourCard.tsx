// A dev copy walks you through what it has that the installed app does not - see
// `src/shared/tour.ts` for the arithmetic this only draws. `App.tsx` asks `api.tour()`
// once on mount; the answer is `null` outside a dev copy, so the installed app never sees
// this card at all.
//
// Each step: the change in plain words, WHERE it lives, what to look for, a ring drawn
// around the control it is about (`TourSpot`), `Try it` to open a pane and type the
// change's own prompt, and the change's own test suites run right here with the result on
// the card - so a change with nothing to click still gets checked in front of you.
//
// Same shape as every other corner card (`MoveSoon.tsx`, `WhatsNewCard.tsx`): a static
// child of `.corner-stack`, never its own `position: fixed`, no animation, no focus taken.
// `.tour-card` follows design-vault/linear.app.md: surface ladder, hairline border, no
// motion beyond the two hover durations.

import { useEffect, useState } from 'react'
import type { TourCheck, TourState, TourStep, TourSurface } from '../../../shared/tour'
import { checkName, currentStep, done, howToCheck, next, nextUnchecked, previous, shouldAutoTry, stepKey } from '../../../shared/tour'
import CardX from './CardX'

const api = window.api

// Which steps already opened a pane, and which are ticked done - kept across a reopen of
// the same dev copy. Keyed by the commit's own subject (`stepKey`), never a slot number,
// so a rebuilt tour with the same commits still remembers.
const SEEN_KEY = 'tour.seen'
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
  const [tried, setTried] = useState<Record<number, string>>({})
  const [seen, setSeen] = useState<Record<string, boolean>>(() => loadMap(SEEN_KEY))
  const [doneMap, setDoneMap] = useState<Record<string, boolean>>(() => loadMap(DONE_KEY))

  // Opens a step's pane - pressed by hand, or run automatically the moment a step with a
  // Try (written or derived from See) is first shown. `idx`/`root` are passed explicitly
  // so this works from the auto-try effect, which runs before `state` is known non-null.
  const tryIt = (idx: number, step: TourStep, root: string): void => {
    if (!step.try || tried[idx] === 'opening') return
    setTried((t) => ({ ...t, [idx]: 'opening' }))
    setSeen((s) => {
      const next = { ...s, [stepKey(step)]: true }
      saveMap(SEEN_KEY, next)
      return next
    })
    void api
      .startSessions([{ cwd: root, prompt: step.try, title: `Try: ${step.text.slice(0, 40)}` }])
      .then(() => setTried((t) => ({ ...t, [idx]: 'opened' })))
      .catch(() => setTried((t) => ({ ...t, [idx]: 'failed' })))
  }

  useEffect(() => {
    let live = true
    void api
      .tour()
      .then((t) => {
        if (!live || !t) return
        // A step already ticked done is skipped - the tour opens on the first one that
        // is not, never back at the first step just because it exists.
        const start = nextUnchecked(t.steps, doneMap)
        setState(start === -1 ? t : { ...t, index: start })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Only runs once, at mount - `doneMap` here is whatever loaded from storage before
    // this fired, which is all a start position needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const index = state?.index ?? -1
  useEffect(() => {
    if (!state || gone) return
    const step = currentStep(state)
    onOpen(step.open)
    // The change's own suites run the moment its step is on screen, once per step.
    if (step.checks.length && !checks[index]) {
      setChecks((c) => ({ ...c, [index]: { state: 'running' } }))
      void Promise.all(step.checks.map((s) => api.tourCheck(s))).then((results) =>
        setChecks((c) => ({ ...c, [index]: { state: 'done', results } }))
      )
    }
    // And its pane opens the moment it is shown, once per step ever (Robert 2026-09-04:
    // "it should just automatically do it for the step").
    if (shouldAutoTry(step, seen)) tryIt(index, step, state.root)
    // Only the step actually on screen should open anything - not `onOpen` itself, which
    // is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, gone])

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
        </div>
        <div className="tour-body">
          <div className="tour-text">{step.text}</div>
          <div className="tour-where">Where to look: {step.where}</div>
          <div className="tour-how">{howToCheck(step)}</div>
          {step.try && step.tryDerived && (
            <div className="tour-derived">Trying it from what to look for - this change wrote no Try line.</div>
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
            {!check || check.state === 'running' ? (
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
          {step.try && (
            <button
              type="button"
              className="ghost small"
              disabled={tried[index] === 'opening'}
              onClick={() => tryIt(index, step, state.root)}
            >
              {tried[index] === 'opening'
                ? 'Opening…'
                : tried[index] === 'failed'
                  ? 'Could not open'
                  : tried[index]
                    ? 'Try again'
                    : 'Try it in a pane'}
            </button>
          )}
          <button
            type="button"
            className="ghost small"
            disabled={state.index === 0}
            onClick={() => setState((s) => (s ? previous(s) : s))}
          >
            Previous
          </button>
          {!isLast && (
            <button type="button" className="ghost small" onClick={() => setState((s) => (s ? next(s) : s))}>
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
