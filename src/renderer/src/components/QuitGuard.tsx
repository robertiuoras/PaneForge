// The card behind a refused Cmd-Q.
//
// Main refuses the quit once while any pane is mid-turn or holding a job
// (`before-quit` in main/index.ts) and sends `app:quitAsk`; this draws the ask in the
// corner stack and answers it. Nothing here counts down: a quit is not something the
// app does on its own at a deadline, so the card waits for a press. `Keep working` (or
// the X) drops it; `Quit anyway` lowers the guard and quits.

import React, { useEffect, useState } from 'react'
import CardX from './CardX'

const api = window.api

interface QuitAsk {
  names: string[]
  count: number
}

export default function QuitGuard(): React.JSX.Element | null {
  const [ask, setAsk] = useState<QuitAsk | null>(null)
  useEffect(() => api.onQuitAsk((a: QuitAsk) => setAsk(a)), [])
  if (!ask) return null
  const answer = (go: boolean): void => {
    void api.answerQuit(go)
    setAsk(null)
  }
  const shown = ask.names.slice(0, 3).join(', ')
  const more = ask.count - Math.min(3, ask.names.length)
  return (
    <div className="move-soon" role="alertdialog" aria-label="Quit PaneForge?" data-testid="quit-guard">
      <CardX onDismiss={() => answer(false)} />
      <div className="move-soon-say">
        {ask.count === 1 ? 'A session is still working' : `${ask.count} sessions are still working`}
      </div>
      <div className="move-soon-why">
        {shown}
        {more > 0 ? ` and ${more} more` : ''}. Quitting now stops {ask.count === 1 ? 'it' : 'them'} mid-turn.
      </div>
      <div className="move-soon-acts">
        <button type="button" autoFocus onClick={() => answer(false)}>
          Keep working
        </button>
        <button type="button" className="ghost" onClick={() => answer(true)}>
          Quit anyway
        </button>
      </div>
    </div>
  )
}
