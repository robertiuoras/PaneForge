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
  if (!soon?.autoClearAt) return null
  const left = Math.max(0, Math.ceil((soon.autoClearAt - now) / 1000))
  const steps = soon.autoClearSteps ?? []
  return (
    <div className="autoclear-card" role="status">
      <div className="autoclear-top">
        {/* Seconds first and biggest: read from across the desk, or not at all. */}
        <span className="autoclear-left">{left > 0 ? `${left}s` : 'now'}</span>
        <span className="autoclear-word">
          Clearing <b>{soon.title}</b> and carrying on from its handoff
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
