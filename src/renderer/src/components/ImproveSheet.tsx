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
import type { ImproveResult, ResearchReport } from '../../../shared/types'
import type { ImproveQuestion } from '../../../shared/promptSchema'
import Blurb from './Blurb'

const api = window.api

/**
 * The lifecycle word shown beside a reference.
 *
 * `verified` and `recommended` are the only two a person may act on without reading
 * further, so everything else is spelled out rather than left blank - a chip with no
 * label reads as approved.
 */
const STAGE_LABEL: Record<string, string> = {
  discovered: 'unverified',
  evaluated: 'evaluated, untested',
  tested: 'tested in a sandbox',
  verified: 'verified',
  recommended: 'recommended',
  'needs-review': 'due a re-check',
  rejected: 'ruled out',
  deprecated: 'deprecated',
  superseded: 'superseded'
}

/** Just the host, so a long documentation URL does not wrap the sheet. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

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
  /**
   * Improve again, without these capability ids.
   *
   * Removal has to be a re-run and not a redraw: the improved text was written with that
   * capability named in it, so hiding the chip would leave the prompt still recommending
   * something the user just said they did not want.
   */
  onRerun?: (exclude: string[]) => void
  /**
   * "Shorter", "keep the file names", "ask me about the auth part" - a note on the
   * suggestion, which produces a new one written to it.
   *
   * A re-run and not an edit of the box, for the same reason removal is: the words have to
   * be rewritten around the instruction, and the diff has to keep meaning what it says.
   * The removals so far ride along, or asking for a change would quietly bring back a
   * capability that had been taken out.
   */
  onTweak?: (tweak: string, exclude: string[]) => void
}

export default function ImproveSheet({
  sessionId,
  state,
  onAccepted,
  onRejected,
  onAnswered,
  onRerun,
  onTweak
}: Props): React.JSX.Element {
  const result = state.phase === 'review' || state.phase === 'asking' ? state.result : null
  const suggested = result?.improvement?.improved ?? ''
  const [text, setText] = useState(suggested)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [research, setResearch] = useState<'idle' | 'running'>('idle')
  const [report, setReport] = useState<ResearchReport | null>(null)
  const [removed, setRemoved] = useState<string[]>([])
  const [tweak, setTweak] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Seconds, counted out loud while it works.
   *
   * The run is a headless CLI and takes twenty-odd seconds - measured 22.5 s for a small
   * one on 2026-07-31 - which is far past the point where a still card reads as a hung
   * app. Nothing here decides anything; it is the difference between waiting and wondering.
   */
  useEffect(() => {
    if (state.phase !== 'working') return setElapsed(0)
    setElapsed(0)
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [state.phase, state.phase === 'working' ? state.original : ''])

  /**
   * One bounded research pass, on demand and never automatically.
   *
   * The user's draft is preserved throughout: this writes nothing into the box and does
   * not replace the suggestion. It records what was found, and rebuilding the prompt is a
   * second, explicit click.
   */
  const doResearch = async (): Promise<void> => {
    if (!result || research === 'running') return
    setResearch('running')
    setReport(null)
    const r = await api.researchRequest(sessionId, result.original)
    setResearch('idle')
    setReport(r)
  }

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
          <span className="improve-title">
            <span className="improve-spin" aria-hidden="true" />
            Improving…
          </span>
          {/* The seconds, because the honest answer to "is it stuck" is a number. A run
              that has gone past the usual is still working; one that has gone past the
              deadline is killed and says so. */}
          <span className="improve-meta">
            {elapsed}s{elapsed > 45 ? ' · longer than usual' : ' · usually 20-40s'}
          </span>
          {/* Through onRejected, which cancels AND closes. Cancelling the request while
              leaving the overlay up is a button that appears to do nothing: the spawn is
              gone but the sheet sits there until a reply that is never coming. */}
          <button className="improve-btn" onClick={onRejected}>
            Cancel
          </button>
        </div>
        <div className="improve-original">{state.original}</div>
        <div className="improve-foot improve-muted">
          Editing the prompt cancels this. Nothing is sent.
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
        <div className="improve-foot">
          {/* A failure that can only be closed is a dead end, and the commonest one - a
              run that took longer than the deadline - succeeds on the second go. */}
          {onRerun ? (
            <button className="improve-btn improve-primary" onClick={() => onRerun([])}>
              Try again
            </button>
          ) : null}
          <span className="improve-muted">Your prompt is untouched.</span>
        </div>
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
      <Blurb id="improve" />

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
                {/* The lifecycle word, not a tick. "recommended" and "discovered" are
                    different claims and the difference is the whole point of the
                    catalogue; collapsing both to "reference" is what makes an untested
                    library read like an endorsed one. */}
                {STAGE_LABEL[s.stage] ? ` · ${STAGE_LABEL[s.stage]}` : ''}
                {s.stale ? ' · stale' : ''}
              </span>
              {s.removable && onRerun ? (
                <button
                  className="improve-chip-x"
                  title={`Remove ${s.title} and improve again without it`}
                  onClick={() => {
                    // Kept across the re-run: removing a second capability must not bring
                    // the first one back.
                    const next = [...removed, s.id]
                    setRemoved(next)
                    onRerun(next)
                  }}
                  aria-label={`remove ${s.title}`}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      <div className="improve-research">
        {research === 'running' ? (
          <>
            <span>Researching… nothing is being installed.</span>
            <button
              className="improve-btn"
              onClick={() => {
                api.cancelResearch(sessionId)
                setResearch('idle')
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="improve-btn"
            title="One bounded pass over public documentation. Installs nothing."
            onClick={() => void doResearch()}
          >
            Research this request
          </button>
        )}
      </div>

      {report ? (
        <div className="improve-report">
          <div>
            {report.outcome === 'skipped'
              ? `Already known — ${report.detail}`
              : report.detail}
          </div>
          {report.kept.length ? (
            <ul className="improve-list">
              {report.kept.map((k) => (
                <li key={k.id}>
                  <strong>{k.name}</strong> ({k.category}) — {k.description}{' '}
                  <span className="improve-untrusted">new, untested</span>
                </li>
              ))}
            </ul>
          ) : null}
          {report.sources.length ? (
            <div className="improve-sources">
              checked:{' '}
              {report.sources.map((s, i) => (
                <span key={s.url} title={`${s.sourceClass}${s.opened ? '' : ' (not opened)'}`}>
                  {i ? ', ' : ''}
                  {hostOf(s.url)}
                  {s.opened ? '' : ' (not opened)'}
                </span>
              ))}
            </div>
          ) : null}
          {report.rejected.length ? (
            <div className="improve-untrusted">
              {report.rejected.length} rejected: {report.rejected.map((r) => r.why).join('; ')}
            </div>
          ) : null}
          {report.kept.length && onRerun ? (
            <button className="improve-btn" onClick={() => onRerun(removed)}>
              Improve again with what was found
            </button>
          ) : null}
        </div>
      ) : null}

      {result.held ? <div className="improve-held">{result.held}</div> : null}

      {/* Ask for something different, in words, rather than editing the box by hand.
          Submitting re-runs the improver with the note attached, so what comes back is a
          whole suggestion written to it - and the removals so far ride along, or a change
          request would quietly bring back a capability that had been taken out. */}
      {onTweak ? (
        <form
          className="improve-tweak"
          onSubmit={(e) => {
            e.preventDefault()
            const note = tweak.trim()
            if (!note) return
            setTweak('')
            onTweak(note, removed)
          }}
        >
          <input
            className="improve-free"
            value={tweak}
            placeholder="Ask for a change - shorter, keep the file names, ask me about auth…"
            aria-label="ask for a change to this suggestion"
            onChange={(e) => setTweak(e.target.value)}
          />
          <button className="improve-btn" type="submit" disabled={!tweak.trim()}>
            Suggest again
          </button>
        </form>
      ) : null}

      <div className="improve-foot">
        <button
          className="improve-btn improve-accept"
          onClick={() => onAccepted(text, editedChars)}
        >
          <span aria-hidden="true">✓</span> Accept
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
        <button className="improve-btn improve-reject" onClick={onRejected}>
          <span aria-hidden="true">✗</span> Reject (Esc)
        </button>
        <span className="improve-muted improve-right">
          your draft is kept · nothing is sent
        </span>
      </div>
    </div>
  )
}
