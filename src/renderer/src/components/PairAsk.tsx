/**
 * "That device wants to pair" - and the number that decides whether it may.
 *
 * Rendered from `App`, not from the Devices dialog, because the request arrives while
 * somebody is standing at the OTHER machine: the dialog on this one is almost never open,
 * and a card only that dialog can show is a request nobody ever answers.
 *
 * **The digits are the check, not the name.** Anything on the network can raise this card
 * under any name it chooses, so the card leads with the number and says to match it - see
 * `main/remote/wire.ts` for why a machine relaying the exchange cannot make the two agree.
 * Deny is the wide button and gets the focus; Approve is the deliberate one.
 *
 * It does not take the screen: no focus is stolen, no window is raised, nothing is modal.
 * It sits in the corner and waits, and it goes away by itself when the request times out
 * over there - the state it draws from is pushed, so there is no timer here.
 */

import { useEffect, useRef } from 'react'
import type { RemoteAsk } from '@shared/types'

const api = window.api

export function PairAsk({ ask }: { ask: RemoteAsk }): JSX.Element {
  const deny = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus WITHIN the window, which is not the same as taking the window: if this window
    // is in the background it stays there. What this buys is that Enter is Deny.
    deny.current?.focus({ preventScroll: true })
  }, [ask.id])

  return (
    <div className="pair-ask" role="dialog" aria-label="A device wants to pair">
      <div className="pair-ask-who">
        <strong>{ask.name || 'A device'}</strong> wants to pair with this desk
        <span className="hint"> · {ask.address}</span>
      </div>
      <div className="pair-ask-sas" aria-label={`Verification number ${ask.sas.split('').join(' ')}`}>
        {ask.sas.slice(0, 3)} <span>{ask.sas.slice(3)}</span>
      </div>
      <p className="hint pair-ask-say">
        Approve only if that same number is on the other screen. If it is different,
        something is relaying the connection.
      </p>
      <div className="pair-ask-acts">
        <button ref={deny} className="ghost" onClick={() => void api.answerPair(false)}>
          Deny
        </button>
        <button className="primary" onClick={() => void api.answerPair(true)}>
          Numbers match, approve
        </button>
      </div>
    </div>
  )
}
