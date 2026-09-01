import React from 'react'
import type { Session } from '../../../shared/types'
import { useNow } from './Elapsed'

/**
 * A session is about to clear ITSELF - say so, and let somebody stop it.
 *
 * Robert's words, 2026-08-23: "it shouldnt be auto clearing instantly ... put popup for a
 * countdown when its about to auto clear just so i can stop it if needed". Everything else
 * about this feature is decided in a hook that has already exited; this card is the only
 * part of it a person can argue with, which is why the app refuses to clear at all when it
 * cannot draw one - `pane-clear.mjs` fails rather than falling back to a silent clear.
 *
 * Not a dialog: nothing the app decided by itself may take the screen. A card in the
 * corner, and doing nothing is consent.
 */
export default function AutoClearToast({
  panes,
  numberOf,
  onKeep
}: {
  panes: Session[]
  /** the pane's number in the sidebar - also its Ctrl key */
  numberOf: (id: string) => number
  onKeep: (id: string) => void
}): React.JSX.Element | null {
  const now = useNow()
  // One card per counting-down pane, soonest nearest the corner. It used to draw the
  // SOONEST one only, because two `position: fixed` cards at one corner were two cards
  // drawn on top of each other. The corner is a COLUMN now (`.corner-stack`), so a second
  // countdown has somewhere to go - and it has to have one: two handoffs ran on
  // 2026-09-01 and only one of them ever said so, which means the other pane cleared with
  // nobody given the chance to stop it. Capped, because a desk clearing six panes at once
  // is a wall of cards, and the ones past the cap are the ones with the most time left.
  const counting = panes
    .filter((s) => s.autoClearAt)
    .sort((a, b) => (a.autoClearAt ?? 0) - (b.autoClearAt ?? 0))
    .slice(0, MAX_CARDS)
  if (!counting.length) {
    // No countdown, but one JUST ended: say how. A card that vanishes without a word -
    // or worse, freezes at 0:00 - leaves whoever watched it guessing what the app
    // decided (ADDENDUM 2026-08-27, the s2 incident). Main deletes the outcome after
    // ~6s; the 5s window here is the belt to that brace.
    const done = panes
      .filter((s) => s.autoClearOutcome && now - (s.autoClearOutcomeAt ?? 0) < 5000)
      .sort((a, b) => (b.autoClearOutcomeAt ?? 0) - (a.autoClearOutcomeAt ?? 0))[0]
    if (!done) return null
    return (
      <div className="autoclear-card" role="status">
        <div className="autoclear-top">
          <span className="autoclear-word">
            <PaneNum n={numberOf(done.id)} />
            <b>{done.title}</b> {done.autoClearOutcome}
          </span>
        </div>
      </div>
    )
  }
  return (
    <>
      {counting.map((s) => (
        <ClearingCard key={s.id} pane={s} now={now} numberOf={numberOf} onKeep={onKeep} />
      ))}
    </>
  )
}

/** More countdowns than this at once is a wall of cards, not a warning. */
const MAX_CARDS = 3

/** One pane, counting down, with the button that stops it. */
function ClearingCard({
  pane,
  now,
  numberOf,
  onKeep
}: {
  pane: Session
  now: number
  numberOf: (id: string) => number
  onKeep: (id: string) => void
}): React.JSX.Element | null {
  if (!pane.autoClearAt) return null
  const left = Math.max(0, Math.ceil((pane.autoClearAt - now) / 1000))
  const steps = pane.autoClearSteps ?? []
  // A clear with nothing to carry is a different event and has to read as one. "Carrying on
  // from its handoff" over an empty prompt is a promise the clear does not keep: nothing is
  // typed after the /clear, the fresh session sits at its composer, and somebody who read
  // that sentence would come back expecting work to have continued. What this one buys is
  // the context, so the card says the context.
  const freeing = Math.round((pane.autoClearTokens ?? 0) / 1000)
  return (
    <div className="autoclear-card" role="status">
      <div className="autoclear-top">
        {/* Seconds first and biggest: read from across the desk, or not at all. */}
        <span className="autoclear-left">{left > 0 ? `${left}s` : 'now'}</span>
        <span className="autoclear-word">
          {pane.autoClearNoResume ? (
            <>
              Clearing <PaneNum n={numberOf(pane.id)} />
              <b>{pane.title}</b> - nothing open
              {freeing > 0 ? `, freeing about ${freeing}k of context` : ''}
            </>
          ) : (
            <>
              Clearing <PaneNum n={numberOf(pane.id)} />
              <b>{pane.title}</b> and carrying on from its handoff
            </>
          )}
        </span>
      </div>
      {/* What it will pick up. A countdown that only says something is about to happen
          gives nobody a reason to allow it, and the reason IS the next steps. */}
      {steps.length > 0 && (
        <ul className="autoclear-steps">
          {steps.slice(0, 3).map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ul>
      )}
      <button className="autoclear-keep" onClick={() => onKeep(pane.id)}>
        Keep this session
      </button>
    </div>
  )
}

/**
 * The pane's number, in the accent, in front of its name. A card naming a project by
 * TITLE left nobody able to find the row it meant on a desk holding two checkouts of it
 * (reported 2026-08-28); the number is also the Ctrl key that reaches the pane, so it is
 * the one label that is never ambiguous.
 */
function PaneNum({ n }: { n: number }): React.JSX.Element | null {
  if (n < 1) return null
  return (
    <span className="autoclear-num" title={`Ctrl ${n} reaches this pane`}>
      {n}
    </span>
  )
}
