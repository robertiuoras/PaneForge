/**
 * "A phone wants in" - the card that is the whole of pairing now.
 *
 * Rendered from `App`, not from the Devices dialog, for the same reason `PairAsk` is: the
 * request arrives while somebody is standing in the hall holding a phone, and a card only
 * an open dialog can show is a card nobody ever answers.
 *
 * **The four digits are the check.** They are generated on this desk and shown in both
 * places, so pressing Approve is a statement that the phone in your hand is the one that
 * just asked - not that the network is trustworthy, which it is not: anything that can
 * reach the port can raise this card. That is why it grants nothing until it is answered,
 * why it says WHERE the request came from, and why an address off the internet says so in
 * as many words rather than being drawn like the phone in your pocket.
 *
 * Approving mints that browser a secret of its own, so it comes back signed in - which is
 * the thing the pairing code could never do, being identical on every phone that ever
 * typed it. It does not take the screen: nothing is raised, nothing is modal, and Deny
 * holds the focus so Enter is the safe answer.
 */

import { useEffect, useRef } from 'react'
import type { PhoneAsk as Ask } from '@shared/types'

const api = window.api

export function PhoneAsk({ ask }: { ask: Ask }): JSX.Element {
  const deny = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus WITHIN the window, never the window itself: a card that pulled the desk to the
    // front would be the app taking the screen for something it decided on its own.
    deny.current?.focus({ preventScroll: true })
  }, [ask.id])

  const far = ask.origin === 'internet'
  return (
    <div className={'pair-ask phone-ask' + (far ? ' far' : '')} role="dialog" aria-label="A phone wants to sign in">
      <div className="pair-ask-who">
        <strong>{ask.kind}</strong> wants to sign in to this desk
        <span className="hint"> · {ask.address}</span>
      </div>
      <div className="pair-ask-sas" aria-label={`Verification number ${ask.sas.split('').join(' ')}`}>
        {ask.sas.slice(0, 2)} <span>{ask.sas.slice(2)}</span>
      </div>
      <p className="hint pair-ask-say">
        {far
          ? 'This came from the internet, not from this network. Approve it only if those four digits are on a screen you are holding.'
          : 'Approve only if those four digits are on the phone in your hand.'}
      </p>
      <div className="pair-ask-acts">
        <button ref={deny} className="ghost" onClick={() => void api.answerPhoneAsk(false)}>
          Deny
        </button>
        <button className="primary" onClick={() => void api.answerPhoneAsk(true)}>
          Numbers match — let it in
        </button>
      </div>
      <p className="hint pair-ask-note">It stays signed in until you sign it out here.</p>
    </div>
  )
}
