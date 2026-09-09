// "Hand off" is one question - WHICH machine - so it gets one box.
//
// It used to open Devices with a banner across the top: a screen carrying pairing codes,
// QR pictures, a phone server, a tunnel switch, per-pane mirror ticks and the "New pane"
// launcher, in which the answer to the only question being asked was a small ghost button
// on the third row of a card. This is that question and nothing else: the panes going,
// what travels with them, the machines that can take them, and one press.
//
// Everything below the picker is deliberately words rather than an icon: a handoff moves
// somebody's live work to another computer and closes the pane here, so what it does has
// to be readable BEFORE the press and not discovered afterwards.

import { useEffect, useRef, useState } from 'react'
import type { Agent, RemotePeerState } from '@shared/types'
import { handoffReport } from '@shared/handoff'

const api = window.api

/** A machine, the same mark Devices draws, so the two screens read as one feature. */
function DeviceGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 13.6h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8 11.25v2.35" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export interface HandoffTarget {
  /** the panes going: one, or every pane of a lane */
  ids: string[]
  /** what to call them on screen */
  title: string
  /** agent kinds in this selection; absent means this older caller cannot say */
  agents?: Agent[]
  /** any of them is mid-turn or holding a question - it changes what the button promises */
  busy?: boolean
  /** it is still booting its agent - not mid-turn, and the sentence must not say it is */
  starting?: boolean
  /** one of them is sitting on a question, which is the one state a move must not take */
  asking?: boolean
  /**
   * The other direction: this is a MIRRORED pane and the only place it can go is here.
   * The machine list is replaced by this one, and the press asks the owner to send it.
   */
  back?: { deviceName: string }
}

interface Props {
  target: HandoffTarget
  peers: RemotePeerState[]
  flash: (message: string) => void
  /** no device is paired yet, so the only useful action is opening the pairing screen */
  onPair: () => void
  onClose: () => void
}

export default function HandoffDialog({ target, peers, flash, onPair, onClose }: Props): JSX.Element {
  const online = peers.filter((p) => p.status === 'online')
  const offline = peers.filter((p) => p.status !== 'online')
  const [pick, setPick] = useState<string>(online[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  // State is not a lock: `busy` is read out of a render's closure, so a double-click (and
  // the row's own onDoubleClick shortcut) both pass the check before React has re-rendered,
  // and the panes are handed off twice - two pushes, two receivers, one killed pty.
  const sending = useRef(false)

  // A device that goes offline while this is open must not stay selected: the press would
  // then fail with a sentence about a link rather than simply not being offered.
  useEffect(() => {
    // Keyed on `peers`, not on `online`, which is a fresh array every render and would
    // re-run this on each one; and never while a send is in flight, since clearing the
    // pick mid-call disables the button for a handoff already on its way.
    if (busy) return
    const live = peers.filter((p) => p.status === 'online')
    if (pick && !live.some((p) => p.id === pick)) setPick(live[0]?.id ?? '')
  }, [peers, pick, busy])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const chosen = online.find((p) => p.id === pick) ?? null
  const agents = target.agents ?? []
  const hasConversation = agents.some((agent) => agent === 'claude' || agent === 'codex')
  const hasShell = agents.includes('shell')
  const unsupported = [...new Set(agents.filter((agent) => agent !== 'claude' && agent !== 'codex' && agent !== 'shell'))]
  const onlyUnsupported = agents.length > 0 && !hasConversation && !hasShell

  // The pane is mid-turn or on a question, so the press has to say which of two things
  // it does: wait for the turn (the queue) or stop the turn and go (`now`).
  const held = Boolean(target.busy || target.asking || target.starting)
  const back = target.back ?? null
  const destination = back ? 'this machine' : chosen?.name ?? ''

  /**
   * `now` interrupts the turn first - the CLI's own Escape - and the far end is asked to
   * carry on once it has resumed. Off, a busy pane is queued and moves when its turn ends.
   */
  async function go(now = false): Promise<void> {
    if ((!chosen && !back) || busy || sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const items = back
        ? await api.bringPaneHere(target.ids[0], now)
        : await api.handoffToDevice(chosen!.id, target.ids, true, !now, now)
      // Every outcome gets a clause - moved, queued, and each failure by name. The words
      // are `handoffReport` in shared/handoff.ts, where the mixed case can be tested.
      flash(handoffReport(items, destination, target.ids.length === 1 ? target.title : undefined))
      // Notes are the half that says what did NOT travel (no transcript, no repo, a dev
      // server that could not be named). They are worth one more line, never silence.
      const notes = items.flatMap((i) => i.notes ?? [])
      if (notes.length) setTimeout(() => flash(notes[0]), 2600)
      onClose()
    } catch (err) {
      flash((err as Error).message)
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog handoff-dialog" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Hand off">
        <div className="dialog-head">
          <strong>{back ? `Bring ${target.title} back` : `Where should ${target.title} run?`}</strong>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="ho-lead">
          A running process cannot travel. {hasConversation ? 'Claude and Codex open their saved conversation on the other machine. The original stays here so you can check the resumed conversation before closing it. Both computers need a PaneForge version that supports this transfer.' : hasShell ? 'A shell starts fresh in the transferred folder on the other machine, then closes here after it starts.' : 'Supported conversations can open on the other machine while the originals stay here.'} Uncommitted code is pushed as an <code> auto-sync</code> commit, and the screen and eligible dev-server names travel over the link.
        </p>

        {unsupported.length > 0 && (
          <p className="ho-note warn">
            {unsupported.join(', ')} {unsupported.length === 1 ? 'does' : 'do'} not support conversation handoff yet and {unsupported.length === 1 ? 'will' : 'will'} stay here.
          </p>
        )}

        {target.asking ? (
          <p className="ho-note warn">
            This pane is sitting on a question it drew on screen, and a question lives on a
            screen and in no transcript - so it cannot travel. <strong>Move now</strong> dismisses the
            question (Escape) and moves it; <strong>after this turn</strong> waits for your answer.
          </p>
        ) : target.starting ? (
          <p className="ho-note">
            This pane is still starting. It is queued and moves the moment it is ready - a
            few seconds, usually.
          </p>
        ) : target.busy ? (
          <p className="ho-note">
            This pane is mid-turn. <strong>Move now</strong> stops the turn (the same Escape you would press) and asks it to carry on over there. <strong>After this turn</strong> interrupts nothing: {hasConversation ? 'its conversation opens there once the turn ends.' : hasShell ? 'the shell moves once the turn ends.' : 'it moves once the turn ends.'}
          </p>
        ) : null}

        <div className="ho-list">
          {back && (
            <div className="ho-dev picked" aria-pressed="true">
              <span className="dev-glyph small online" aria-hidden="true">
                <DeviceGlyph />
              </span>
              <span className="ho-dev-text">
                <span className="ho-dev-name">This machine</span>
                <span className="ho-dev-sub">
                  <span className="dot online" />
                  {`back from ${back.deviceName}`}
                </span>
              </span>
              <span className="ho-tick" aria-hidden="true">✓</span>
            </div>
          )}
          {!back && online.length === 0 && (
            <p className="dev-empty">
              No machine is online to take it. Open Devices on the other computer, press
              Copy invite, and paste it here.
            </p>
          )}
          {!back && online.map((p) => (
            <button
              key={p.id}
              className={'ho-dev' + (pick === p.id ? ' picked' : '')}
              aria-pressed={pick === p.id}
              onClick={() => setPick(p.id)}
              onDoubleClick={() => void go()}
            >
              <span className="dev-glyph small online" aria-hidden="true">
                <DeviceGlyph />
              </span>
              <span className="ho-dev-text">
                <span className="ho-dev-name">{p.name}</span>
                <span className="ho-dev-sub">
                  <span className="dot online" />
                  {p.address}
                  {p.panes.length ? ` · ${p.panes.length} pane${p.panes.length === 1 ? '' : 's'} there` : ' · idle'}
                </span>
              </span>
              <span className="ho-tick" aria-hidden="true">
                {pick === p.id ? '✓' : ''}
              </span>
            </button>
          ))}
          {!back && offline.map((p) => (
            <div key={p.id} className="ho-dev off" title={p.error || 'Not connected'}>
              <span className="dev-glyph small off" aria-hidden="true">
                <DeviceGlyph />
              </span>
              <span className="ho-dev-text">
                <span className="ho-dev-name">{p.name}</span>
                <span className="ho-dev-sub">
                  <span className={'dot ' + p.status} />
                  {p.status === 'connecting' ? 'connecting…' : p.error || 'offline'}
                </span>
              </span>
              <button
                className="ghost small"
                onClick={() => void api.connectRemote(p.id, true)}
                disabled={p.status === 'connecting'}
              >
                Connect
              </button>
            </div>
          ))}
        </div>

        <div className="dialog-foot ho-foot">
          {!back && (
            <button className="ghost" onClick={onPair}>
              Devices…
            </button>
          )}
          <span className="ho-spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {/* A held pane gets TWO presses, each saying what it does to the turn. The
              queue is the gentle one and keeps the primary look; "now" is the one that
              interrupts, so it is a plain button that names it. Robert, 2026-09-08:
              "i want that mid turn ... and to pull it back mid turn if i want to". */}
          {held && (
            <button
              className="ghost"
              disabled={(!chosen && !back) || busy || onlyUnsupported}
              title="Stops the turn with the CLI's own Escape, then moves it. The conversation resumes over there and is asked to carry on."
              onClick={() => void go(true)}
            >
              {busy ? 'Moving…' : target.starting ? 'Move as soon as it is ready' : 'Move now'}
            </button>
          )}
          <button className="primary" disabled={(!chosen && !back) || busy || onlyUnsupported} onClick={() => void go(false)}>
            {busy
              ? back ? 'Bringing it back…' : 'Handing off…'
              : onlyUnsupported
                ? 'Selected agents cannot hand off'
                : held
                  ? back
                    ? 'Bring it back after this turn'
                    : destination
                      ? `Move to ${destination} after this turn`
                      : 'Move after this turn'
                  : back
                    ? 'Bring it back'
                    : chosen
                      ? `Move to ${destination}`
                      : 'Move'}
          </button>
        </div>
      </div>
    </div>
  )
}
