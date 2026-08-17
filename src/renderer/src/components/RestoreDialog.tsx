import { useEffect, useRef, useState } from 'react'
import type { RestoreOffer } from '@shared/types'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'
import { Checkbox } from './Controls'

/**
 * "Restore your last session?" - the panes the previous run left behind, offered
 * back on a cold launch.
 *
 * An in-app dialog rather than dialog.showMessageBox: a native modal takes the
 * keyboard off whatever the user is typing in another app, and the very first thing
 * a launched app does must never be to grab the screen. Dismissing it (Escape, or a
 * click outside) is not an answer - main keeps the panes and offers them again next
 * time, so a mis-click cannot delete a desk.
 */
interface Props {
  offer: RestoreOffer
  onRestore: (ids: string[], always: boolean) => void
  onFresh: () => void
  onDismiss: () => void
}

export default function RestoreDialog({ offer, onRestore, onFresh, onDismiss }: Props): JSX.Element {
  // Everything that can actually be reopened starts ticked - the common answer is
  // "all of it", and a pane whose folder or agent is gone cannot be started at all -
  // EXCEPT on a machine already short of memory, where main sends a smaller `fits`.
  // Restoring is the one moment N agent CLIs start in a single tick, and six of them
  // on a laptop at pressure 2 is the desk that comes back unable to take a keystroke.
  // Nothing is lost by ticking fewer: the rest keep their conversation and their screen
  // and are one click away in History. Still a preselect - every box is still yours.
  const [ticked, setTicked] = useState<string[]>(() =>
    offer.panes
      .filter((p) => !p.gone)
      .slice(0, Math.max(1, offer.fits ?? Number.MAX_SAFE_INTEGER))
      .map((p) => p.id)
  )
  const [always, setAlways] = useState(false)
  const restore = useRef<HTMLButtonElement>(null)

  useEffect(() => restore.current?.focus(), [])

  const toggle = (id: string): void =>
    setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))

  return (
    <div
      className="overlay confirm-overlay"
      onMouseDown={onDismiss}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onDismiss()
        }
        if (e.key === 'Enter') {
          e.stopPropagation()
          if (ticked.length) onRestore(ticked, always)
        }
      }}
    >
      <div className="dialog restore" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Restore your last session?</strong>
          <span className="hint">{when(offer)}</span>
        </div>
        <Blurb id="restore" />

        <div className="proj-list">
          {offer.panes.map((p) => (
            <div
              key={p.id}
              className={'proj' + (ticked.includes(p.id) ? ' on' : '') + (p.gone ? ' gone' : '')}
              onClick={(e) => {
                if ((e.target as HTMLElement).dataset.tick) return
                if (!p.gone) toggle(p.id)
              }}
            >
              <span className="tick" data-tick="1" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={ticked.includes(p.id)}
                  disabled={Boolean(p.gone)}
                  onChange={() => toggle(p.id)}
                />
              </span>
              <AgentLogo id={p.agent} size={13} muted={Boolean(p.gone)} />
              <span className="proj-name">{p.title}</span>
              <span className="restore-path">{p.cwd}</span>
              {p.gone === 'folder' && <span className="tag">folder gone</span>}
              {p.gone === 'agent' && <span className="tag">{p.agent} not installed</span>}
              {/* The last thing typed into this pane's conversation - the only line here
                  that answers "which of these was the one I care about". Full text on
                  hover, because the useful half is often past the width of the row. */}
              {p.lastPrompt && (
                <span className="restore-prompt" title={p.lastPrompt}>
                  {p.lastPrompt}
                </span>
              )}
            </div>
          ))}
        </div>

        {offer.memoryNote && <div className="confirm-body">{offer.memoryNote}</div>}

        {offer.extra.length > 0 && (
          <div className="confirm-body">
            {offer.extra.length} more pane{offer.extra.length === 1 ? '' : 's'} will not be
            restored - {offer.extra.map((p) => p.title).join(', ')}. Starting more than{' '}
            {offer.panes.length} agents at once takes the machine out for a minute.
          </div>
        )}

        <div className="dialog-row">
          <Checkbox
            checked={always}
            onChange={setAlways}
            label="Always restore after a restart"
            title="Skips this question next time. Change it under Settings."
          />
          <button className="ghost" onClick={onFresh}>
            Start fresh
          </button>
          <button
            ref={restore}
            className="primary"
            disabled={ticked.length === 0}
            onClick={() => onRestore(ticked, always)}
          >
            Restore {ticked.length} pane{ticked.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * How old the desk is, and whether the app got to say goodbye. An unclean shutdown
 * is worth naming: it is the difference between "you closed this" and "the power
 * went", and it explains why the app is asking at all.
 */
function when(offer: RestoreOffer): string {
  const mins = Math.max(0, Math.round((Date.now() - offer.at) / 60000))
  const age =
    mins < 2
      ? 'a moment ago'
      : mins < 60
        ? `${mins} minutes ago`
        : mins < 60 * 36
          ? `${Math.round(mins / 60)} hours ago`
          : `${Math.round(mins / 1440)} days ago`
  return offer.clean ? `from ${age}` : `from ${age}, after an unclean shutdown`
}
