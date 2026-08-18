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
import type { RemotePeerState } from '@shared/types'
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
  /** any of them is mid-turn or holding a question - it changes what the button promises */
  busy?: boolean
  /** one of them is sitting on a question, which is the one state a move must not take */
  asking?: boolean
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

  async function go(): Promise<void> {
    if (!chosen || busy || sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const items = await api.handoffToDevice(chosen.id, target.ids, true)
      // Every outcome gets a clause - moved, queued, and each failure by name. The words
      // are `handoffReport` in shared/handoff.ts, where the mixed case can be tested.
      flash(handoffReport(items, chosen.name, target.ids.length === 1 ? target.title : undefined))
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
          <strong>Hand off {target.title}</strong>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="ho-lead">
          The work moves to another machine and keeps going there. The pty cannot travel, so
          everything that outlives it does: uncommitted code is pushed as an
          <code> auto-sync</code> commit, the conversation and the screen go over the link,
          and any dev server this pane had running is started again over there. The pane
          closes here and comes straight back as a mirror, so you keep watching it.
        </p>

        {target.asking ? (
          <p className="ho-note warn">
            This pane is sitting on a question it drew on screen, and a question lives on a
            screen and in no transcript - so it cannot travel. Queue it here and it moves as
            soon as you have answered; answer it first and it moves at once.
          </p>
        ) : target.busy ? (
          <p className="ho-note">
            This pane is mid-turn. Nothing is interrupted: it is queued and moves the moment
            the turn ends, with the answer intact.
          </p>
        ) : null}

        <div className="ho-list">
          {online.length === 0 && (
            <p className="dev-empty">
              No machine is online to take it. Open Devices on the other computer, press
              Copy invite, and paste it here.
            </p>
          )}
          {online.map((p) => (
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
          {offline.map((p) => (
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
          <button className="ghost" onClick={onPair}>
            Pair a device
          </button>
          <span className="ho-spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!chosen || busy} onClick={() => void go()}>
            {busy
              ? 'Handing off…'
              : chosen
                ? target.busy || target.asking
                  ? `Queue for ${chosen.name}`
                  : `Hand off to ${chosen.name}`
                : 'Hand off'}
          </button>
        </div>
      </div>
    </div>
  )
}
