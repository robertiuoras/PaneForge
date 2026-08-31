// A pane just named itself, and this is the three seconds in which that can be undone.
//
// The rename has already happened by the time this draws, which is the whole design: a
// card in the corner of a window that is usually behind something else is not a question
// anybody answers, and the reading is right nearly every time. So the automatic direction
// is the cheap one and the card carries the escape hatch - `Cancel`, which puts the folder
// name back AND stops the app offering again for that pane, because a person undoing it is
// saying the reading was wrong rather than that they wanted the name later.
//
// Shape borrowed wholesale from `MoveSoon`/`AutoClearToast`: bottom-right, no focus, no
// dialog, no animation, one step above them in the stack because it is the shortest-lived
// thing on screen and is gone before either of them arms. When there is a pet in that
// corner it moves up rather than sitting on the sprite.

import React, { useEffect } from 'react'
import type { ClientNamed } from '@shared/types'

export interface ClientToastProps {
  /** the newest rename, or nothing */
  named?: ClientNamed
  /** true when a sprite is in that corner - the card steps up off it */
  besidePet: boolean
  /** put the name back and stop reading this pane */
  onCancel: (id: string) => void
  /** the card has said its piece */
  onDone: () => void
}

/** How long the card stays. Long enough to read one line and reach one button. */
export const CLIENT_TOAST_MS = 3000

/** Why this pane is called what it is now, in one clause. */
export function whyWords(e: ClientNamed): string {
  if (e.from === 'folder') return 'This pane is open in their folder.'
  if (e.from === 'prompt') return 'The first thing you asked named them.'
  return 'Named after the first thing you asked.'
}

export default function ClientToast({
  named,
  besidePet,
  onCancel,
  onDone
}: ClientToastProps): React.JSX.Element | null {
  // Keyed on the pane AND the title, so a pane renamed twice (a topic, then the client it
  // turned out to be) restarts the clock rather than vanishing mid-read.
  const key = named ? `${named.id}:${named.title}` : ''
  useEffect(() => {
    if (!key) return
    const t = window.setTimeout(onDone, CLIENT_TOAST_MS)
    return () => window.clearTimeout(t)
  }, [key])
  if (!named) return null
  return (
    <div
      className={'client-toast' + (besidePet ? ' beside-pet' : '')}
      role="status"
      data-testid="client-toast"
    >
      <div className="client-toast-say">
        Renamed this pane <strong>{named.title}</strong>
      </div>
      <div className="client-toast-why">{whyWords(named)}</div>
      <div className="client-toast-acts">
        <button type="button" className="ghost" onClick={() => onCancel(named.id)}>
          Cancel
        </button>
        <button type="button" onClick={onDone}>
          Keep it
        </button>
      </div>
    </div>
  )
}
