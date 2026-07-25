import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'

const api = window.api

/**
 * The Claude-desktop shaped prompt: nothing at all until a new build is already
 * downloaded, then one card offering the restart. Dismissing hides it until the
 * next version, so a build every hour does not turn into a nag every hour.
 */
export default function UpdateToast(): JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState<string>('')

  useEffect(() => {
    api.updateState().then(setState)
    return api.onUpdate(setState)
  }, [])

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
          {ready
            ? `You are on ${state.current}. It installs silently and reopens your panes where they were.`
            : `You are on ${state.current}. Download it and drag it over the old app.`}
        </span>
        {state.notes && <pre className="ut-notes">{state.notes}</pre>}
      </div>
      <div className="ut-actions">
        <button className="ghost small" onClick={() => setDismissed(state.version as string)}>
          Later
        </button>
        {ready ? (
          <button className="primary small" onClick={() => api.installUpdate()}>
            Restart now
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
