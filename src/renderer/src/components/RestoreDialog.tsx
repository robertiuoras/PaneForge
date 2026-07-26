import { useEffect, useRef, useState } from 'react'
import type { RestoreOffer } from '@shared/types'
import AgentLogo from './AgentLogo'
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
  // Everything that can actually be reopened starts ticked: the common answer is
  // "all of it", and a pane whose folder or agent is gone cannot be started at all.
  const [ticked, setTicked] = useState<string[]>(() =>
    offer.panes.filter((p) => !p.gone).map((p) => p.id)
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
            </div>
          ))}
        </div>

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
