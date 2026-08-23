/**
 * A pane's output as TEXT, for a finger.
 *
 * Two things a phone could not do, and both come from the same fact: xterm draws to a
 * canvas, so there is nothing on the page to select. On a desk that is covered by
 * dragging the mouse - xterm implements selection itself, on mouse events - and a touch
 * screen never sends those: a finger dragged across a terminal is a scroll, so there was
 * no gesture on a phone that could pick out a line of an agent's answer. That is "let me
 * select and copy some text from the output on mobile".
 *
 * The second is depth. The live replay a pane re-attaches with is capped at 400 KB
 * (`BUFFER_LIMIT`), which is generous for a shell and nothing at all for an agent: its
 * "thinking" line is repainted many times a second, so those 400 KB are minutes rather
 * than turns, and everything said earlier is unreachable on a phone even though the desk
 * still shows it - the desk's terminal accumulated the lines as they arrived and never
 * needed the replay. So this reads the pane's transcript off disk (up to 8 MB) instead.
 *
 * Rendered, not stripped. Passing the raw log through `strip()` would put every one of
 * those repaint frames on its own line - the "it spams the thinking info" complaint,
 * written down as a document. A terminal is what turns a stream of repaints back into the
 * lines a person saw, so the bytes go through a real xterm off-screen and its BUFFER is
 * what is shown. That also means no ANSI parsing lives here to drift from the one in the
 * pane.
 */

import { useEffect, useRef, useState } from 'react'
import { renderLines } from '../termRender'

const api = window.api

/** How much of the transcript to ask for. 2 MB is ~10x the live replay and renders fast. */
const LOG_BYTES = 2_000_000

export function TextSheet({
  sessionId,
  title,
  cols,
  onClose,
  onToast
}: {
  sessionId: string
  title: string
  /** the pty's width, so the replay is re-drawn at the width it was written for */
  cols: number
  onClose(): void
  onToast?(message: string): void
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const body = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let dead = false
    void (async () => {
      try {
        const raw = (await api.paneLog(sessionId, LOG_BYTES)) || (await api.getBuffer(sessionId))
        if (dead) return
        const lines = await renderLines(raw, cols)
        if (dead) return
        setText(lines.join('\n'))
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      dead = true
    }
  }, [sessionId, cols])

  // Open at the newest line: this is a transcript, and the thing you came to read is what
  // the agent said last.
  useEffect(() => {
    if (text !== null && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [text])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  return (
    <div className="text-sheet-back" role="dialog" aria-label={`Output of ${title}`}>
      <div className="text-sheet">
        <div className="text-sheet-head">
          <span className="tsh-title">{title}</span>
          <button
            className="tsh-btn"
            disabled={!text}
            onClick={() => {
              if (!text) return
              api.copyText(text)
              onToast?.('Output copied')
            }}
          >
            Copy all
          </button>
          <button className="tsh-btn" onClick={onClose} aria-label="Close">
            Done
          </button>
        </div>
        {/* Selecting is the whole point, so this is the one place in the app that says so
            out loud rather than inheriting the window's `user-select: none`. */}
        <pre className="text-sheet-body" ref={body}>
          {error ? `Could not read this pane: ${error}` : (text ?? 'Reading the transcript…')}
        </pre>
        <div className="text-sheet-foot">
          Press and hold to select. Everything this pane printed, as far back as its
          transcript goes.
        </div>
      </div>
    </div>
  )
}
