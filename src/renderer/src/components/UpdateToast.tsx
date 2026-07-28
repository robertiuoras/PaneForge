import { useEffect, useState } from 'react'
import type { InstallOutcome, UpdateState } from '@shared/types'

const api = window.api

/**
 * The Claude-desktop shaped prompt: nothing at all until a new build is already
 * downloaded, then one card offering the restart. Dismissing hides it until the
 * next version, so a build every hour does not turn into a nag every hour.
 */
export default function UpdateToast(): JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState<string>('')
  // The click has to say something immediately. Main hides the window as its first act
  // now, but the frame between the click and that still belonged to a card that looked
  // like it had ignored the press, which is what "it lags and then closes" was.
  const [restarting, setRestarting] = useState(false)
  // Do-not-disturb queues the restart rather than running it. Until this existed the
  // click left the button on "Restarting..." with nothing behind it - the whole of
  // "installing from the update popup does not work".
  const [held, setHeld] = useState<InstallOutcome | null>(null)

  useEffect(() => {
    api.updateState().then(setState)
    return api.onUpdate(setState)
  }, [])

  const restart = (): void => {
    setRestarting(true)
    setHeld(null)
    // Two frames, not one: a rAF callback runs before the paint of the frame it is in,
    // so a single one fired while the button still read "Restart now" - which is the
    // frozen-looking frame this is here to remove.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void Promise.resolve(api.installUpdate())
          .then((r) => {
            // 'installing' never gets here: the window is already gone.
            if (!r || r.status === 'installing') return
            setRestarting(false)
            if (r.status === 'held') setHeld(r)
          })
          .catch(() => setRestarting(false))
      })
    )
  }

  const ready = state?.phase === 'ready'
  // On macOS the app cannot replace itself (unsigned build), so the card offers the
  // download page instead of a restart. Same prompt, honest button.
  const manual = state?.phase === 'available'
  if (!state || (!ready && !manual) || !state.version) return null
  if (dismissed === state.version) return null

  return (
    <div className="update-toast">
      <div className="ut-text">
        <strong>PaneForge {state.version} is {ready ? 'ready' : 'out'}</strong>
        <span className="hint">
          {held
            ? held.manual
              ? 'Do not disturb is on, so the restart is queued rather than taking the screen. It happens the moment you turn it off - or restart now anyway.'
              : `${held.game ?? 'A game'} is running, so the restart is queued rather than pulling it off the screen. It happens by itself when that closes - or restart now anyway.`
            : ready
              ? `You are on ${state.current}. It installs silently and reopens your panes where they were - or on Later, the next time you quit.`
              : `You are on ${state.current}. Download it and drag it over the old app.`}
        </span>
      </div>
      <div className="ut-actions">
        <button
          className="ghost small"
          disabled={restarting}
          onClick={() => setDismissed(state.version as string)}
        >
          Later
        </button>
        {ready ? (
          <button
            className="primary small"
            disabled={restarting}
            onClick={held ? () => api.installUpdateAnyway() : restart}
          >
            {restarting ? 'Restarting…' : held ? 'Restart anyway' : 'Restart now'}
          </button>
        ) : (
          <button className="primary small" onClick={() => state.url && api.openExternal(state.url)}>
            Download
          </button>
        )}
      </div>
    </div>
  )
}
