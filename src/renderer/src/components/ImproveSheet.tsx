// The review sheet: what an improvement looks like before anything is typed anywhere.
//
// An in-renderer overlay, never a `dialog.showMessageBox` - the app decided to show this,
// and nothing the app decides on its own is allowed to take the screen. Same class of
// thing as the find bar and the Stash overlay.
//
// The contract this component holds up:
//
//   - the original is displayed and kept, and Restore original puts it back
//   - the suggestion is editable before it is accepted
//   - what changed is shown as a word diff, not asserted in prose
//   - Accept writes to the pane; Reject writes nothing at all
//   - nothing here can submit. There is no code path from this file to a `\r`.

import { useEffect, useMemo, useRef, useState } from 'react'
import { diffWords, changeRatio } from '../../../shared/diffWords'
import type { ImproveResult } from '../../../shared/types'
import type { ImproveQuestion } from '../../../shared/promptSchema'

const api = window.api

export type SheetState =
  | { phase: 'working'; original: string }
  | { phase: 'failed'; original: string; error: string }
  | { phase: 'review'; result: ImproveResult }
  | { phase: 'asking'; result: ImproveResult }

interface Props {
  sessionId: string
  state: SheetState
  /** Accepted and written into the pane. The sheet closes; the pane keeps the text. */
  onAccepted: (text: string, editedChars: number) => void
  /** Closed without touching the pane. */
  onRejected: () => void
  /** Answers to the questions the first pass asked. Exactly one second pass, ever. */
  onAnswered: (answers: Array<{ question: string; answer: string }>) => void
}

export default function ImproveSheet({
  sessionId,
  state,
  onAccepted,
  onRejected,
  onAnswered
}: Props): React.JSX.Element {
  const result = state.phase === 'review' || state.phase === 'asking' ? state.result : null
  const suggested = result?.improvement?.improved ?? ''
  const [text, setText] = useState(suggested)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // A new suggestion replaces what is in the box; an edit the user made to the previous
  // one is theirs and is not carried across, because it was written against other words.
  useEffect(() => setText(suggested), [suggested])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onRejected()
      }
    }
    // Capture: the pane below has its own key handling and this overlay owns the keyboard
    // while it is up. Escape hands it straight back.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onRejected])

  const parts = useMemo(
    () => (result ? diffWords(result.original, text) : []),
    [result, text]
  )
  const ratio = useMemo(
    () => (result ? changeRatio(result.original, text) : 0),
    [result, text]
  )

  if (state.phase === 'working') {
    return (
      <div className="improve-sheet" role="dialog" aria-label="Improving prompt">
        <div className="improve-head">
          <span className="improve-title">Improving…</span>
          {/* Through onRejected, which cancels AND closes. Cancelling the request while
              leaving the overlay up is a button that appears to do nothing: the spawn is
              gone but the sheet sits there until a reply that is never coming. */}
          <button className="improve-btn" onClick={onRejected}>
            Cancel
          </button>
        </div>
        <div className="improve-original">{state.original}</div>
        <div className="improve-foot improve-muted">
          Typing in the pane cancels this. Nothing is sent.
        </div>
      </div>
    )
  }

  if (state.phase === 'failed') {
    return (
      <div className="improve-sheet" role="dialog" aria-label="Improvement failed">
        <div className="improve-head">
          <span className="improve-title">Not improved</span>
          <button className="improve-btn" onClick={onRejected}>
            Close
          </button>
        </div>
        <div className="improve-error">{state.error}</div>
        <div className="improve-foot improve-muted">Your prompt is untouched.</div>
      </div>
    )
  }

  if (!result?.improvement) return <></>
  const imp = result.improvement

  if (state.phase === 'asking') {
    const ready = imp.questions.every((q) => (answers[q.question] ?? '').trim())
    return (
      <div className="improve-sheet" role="dialog" aria-label="Questions">
        <div className="improve-head">
          <span className="improve-title">A couple of things only you know</span>
          <span className="improve-meta">{imp.taskType}</span>
        </div>
        <div className="improve-questions">
          {imp.questions.map((q: ImproveQuestion) => (
            <div className="improve-q" key={q.question}>
              <div className="improve-q-text">{q.question}</div>
              {q.why ? <div className="improve-muted">{q.why}</div> : null}
              <div className="improve-options">
                {q.options.map((o) => (
                  <button
                    key={o}
                    className={
                      'improve-chip' + (answers[q.question] === o ? ' improve-chip-on' : '')
                    }
                    onClick={() => setAnswers((a) => ({ ...a, [q.question]: o }))}
                  >
                    {o}
                  </button>
                ))}
              </div>
              <input
                className="improve-free"
                placeholder="or say it in your own words"
                value={answers[q.question] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="improve-foot">
          <button
            className="improve-btn improve-primary"
            disabled={!ready}
            onClick={() =>
              onAnswered(
                imp.questions.map((q) => ({
                  question: q.question,
                  answer: answers[q.question] ?? ''
                }))
              )
            }
          >
            Improve with these
          </button>
          {/* Skip is always available, and it produces the assumption path rather than
              a worse improvement: the model was told to assume when it cannot ask. */}
          <button className="improve-btn" onClick={() => onAnswered([])}>
            Skip
          </button>
          <button className="improve-btn" onClick={onRejected}>
            Reject
          </button>
        </div>
      </div>
    )
  }

  const edited = text !== suggested
  const editedChars = Math.abs(text.length - suggested.length)

  return (
    <div className="improve-sheet" role="dialog" aria-label="Improved prompt">
      <div className="improve-head">
        <span className="improve-title">Improve prompt</span>
        <span className="improve-meta">
          {imp.taskType} · {result.metrics.originalTokens} → {result.metrics.improvedTokens} tokens
          {ratio < 0.1 ? ' · already good' : ''}
        </span>
      </div>

      <div className="improve-diff" aria-label="what changed">
        {parts.map((p, i) => (
          <span key={i} className={`improve-${p.op}`}>
            {p.text}
          </span>
        ))}
      </div>

      <textarea
        ref={areaRef}
        className="improve-edit"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        aria-label="improved prompt, editable"
      />

      {imp.changed.length ? (
        <ul className="improve-list">
          {imp.changed.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}

      {imp.assumptions.length ? (
        <div className="improve-assumed">
          {imp.assumptions.map((a) => (
            <div key={a}>Assumed: {a}</div>
          ))}
        </div>
      ) : null}

      {result.sources.length ? (
        <div className="improve-sources">
          references:{' '}
          {result.sources.map((s, i) => (
            <span key={s.id}>
              {i ? ', ' : ''}
              <span className={s.trusted ? '' : 'improve-untrusted'} title={s.source}>
                {s.title}
                {s.trusted ? '' : ' (unverified)'}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {result.held ? <div className="improve-held">{result.held}</div> : null}

      <div className="improve-foot">
        <button
          className="improve-btn improve-primary"
          onClick={() => onAccepted(text, editedChars)}
        >
          Accept
        </button>
        {imp.questions.length ? (
          <button className="improve-btn" onClick={() => onAnswered([])}>
            Ask what matters ({imp.questions.length})
          </button>
        ) : null}
        {edited ? (
          <button className="improve-btn" onClick={() => setText(suggested)}>
            Undo edits
          </button>
        ) : null}
        <button className="improve-btn" onClick={() => setText(result.original)}>
          Restore original
        </button>
        <button className="improve-btn" onClick={onRejected}>
          Reject (Esc)
        </button>
        <span className="improve-muted improve-right">
          your draft is kept · nothing is sent
        </span>
      </div>
    </div>
  )
}
