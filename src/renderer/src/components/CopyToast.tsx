// A project just got a second folder, and this is the only time anybody is told why.
//
// Two chats cannot edit one folder without overwriting each other, so the second chat to
// open a project works in a copy of it beside the original. That copy appears on disk with
// nobody having asked for it, and until this card the only sign of it was a folder in
// Projects and a chip reading `copy 2` - which explains the fact to somebody who already
// knew it. So: one sentence, the path, and what happens to the work in there.
//
// Once per MACHINE, decided in main (`Config.seenCopyCard`, written when the event is
// sent) rather than here: a window that never drew this - minimised, wedged, closed on the
// beat the copy was made - must still not be told twice. Shape borrowed from ClientToast:
// bottom-right inside `.corner-stack`, no focus, no dialog, no animation, an X to dismiss.

import React, { useState } from 'react'
import type { CopyMade } from '@shared/types'
import CardX from './CardX'

export interface CopyToastProps {
  /** the copy that was just made, or nothing */
  made?: CopyMade
  /** the card has been read */
  onDone: () => void
}

export default function CopyToast({ made, onDone }: CopyToastProps): React.JSX.Element | null {
  // Keyed on the path, so the card is redrawn for a different copy rather than staying
  // dismissed - even though, today, there is only ever one of these per machine.
  const [dismissed, setDismissed] = useState('')
  if (!made || dismissed === made.path) return null
  return (
    <div className="copy-toast" role="status" data-testid="copy-toast">
      <CardX
        onDismiss={() => {
          setDismissed(made.path)
          onDone()
        }}
      />
      <div className="copy-toast-say">
        You now have two chats on <strong>{made.project}</strong>, so the second one works
        in its own copy of the folder.
      </div>
      <div className="copy-toast-where">{made.path}</div>
      <div className="copy-toast-why">
        Finished work comes back into the main copy by itself. Nothing to do.
      </div>
      <div className="copy-toast-acts">
        <button
          type="button"
          onClick={() => {
            setDismissed(made.path)
            onDone()
          }}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
