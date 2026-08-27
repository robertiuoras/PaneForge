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
  onKeep
}: {
  panes: Session[]
  onKeep: (id: string) => void
}): React.JSX.Element | null {
  const now = useNow()
  // The SOONEST one, never a card per pane: two countdowns are two cards fighting for one
  // corner, and the second is the one nobody reads.
  const soon = panes
    .filter((s) => s.autoClearAt)
    .sort((a, b) => (a.autoClearAt ?? 0) - (b.autoClearAt ?? 0))[0]
  if (!soon?.autoClearAt) {
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
            <b>{done.title}</b> {done.autoClearOutcome}
          </span>
        </div>
      </div>
    )
  }
  const left = Math.max(0, Math.ceil((soon.autoClearAt - now) / 1000))
  const steps = soon.autoClearSteps ?? []
  // A clear with nothing to carry is a different event and has to read as one. "Carrying on
  // from its handoff" over an empty prompt is a promise the clear does not keep: nothing is
  // typed after the /clear, the fresh session sits at its composer, and somebody who read
  // that sentence would come back expecting work to have continued. What this one buys is
  // the context, so the card says the context.
  const freeing = Math.round((soon.autoClearTokens ?? 0) / 1000)
  return (
    <div className="autoclear-card" role="status">
      <div className="autoclear-top">
        {/* Seconds first and biggest: read from across the desk, or not at all. */}
        <span className="autoclear-left">{left > 0 ? `${left}s` : 'now'}</span>
        <span className="autoclear-word">
          {soon.autoClearNoResume ? (
            <>
              Clearing <b>{soon.title}</b> - nothing open
              {freeing > 0 ? `, freeing about ${freeing}k of context` : ''}
            </>
          ) : (
            <>
              Clearing <b>{soon.title}</b> and carrying on from its handoff
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
      <button className="autoclear-keep" onClick={() => onKeep(soon.id)}>
        Keep this session
      </button>
    </div>
  )
}
