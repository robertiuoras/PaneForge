// "Here is what you asked for, written out - send this, or send what you typed."
//
// The card a pane shows when it held the Enter on a long rough prompt. The pane owns the
// keystrokes and every send (`TerminalPane.tsx`, the held Enter); this only draws what the
// small model and the code search came back with and says which button was pressed. The
// rules that must hold whatever the model answers - which prompts qualify, how its answer
// is read, the prompt that is finally typed - are in `shared/promptExpand.ts`.
//
// Nothing here takes the keyboard. The terminal keeps focus while the card is up, so the
// person can keep typing and the card simply goes away: every button is pressed with the
// pointer and refuses the focus a mousedown would otherwise give it. The one exception is
// Edit, whose text box is the point.
//
// It ASKS first ("Write it up as a fuller brief?") and only then waits: a prompt is never
// rewritten without a yes. The brief reads as a short label/value sheet - everything shown,
// nothing folded away behind a disclosure (Robert, 2026-09-24: "stop with those dropdowns").
//
// No animation: it appears on a keypress somebody is looking at, and the only motion is
// the app's own `--fast` on hover. The waiting line counts seconds, which is the one
// honest thing to show for a run measured at 20-48 s.

import { useState } from 'react'
import { expandedPrompt, type ExpandAnswer, type Expansion } from '@shared/promptExpand'
import { useNow } from './Elapsed'

/** An answer the card can draw - the error half of `ExpandAnswer` never reaches it. */
export type ExpandReady = Extract<ExpandAnswer, { expansion: Expansion }>

/** One card, as the pane holds it. */
export interface ExpandOpen {
  /** Which opening this is. An answer that lands after its card was closed is dropped. */
  seq: number
  /** The draft exactly as the pane reconstructed it when Enter was held. */
  text: string
  words: number
  openedAt: number
  /** `null` while the model is still writing. */
  answer: ExpandReady | null
  /** The option picked for each question, as an index; 0 is the suggested one. */
  picks: number[]
  /** The brief is open for editing - Enter in the terminal must not send the unedited one. */
  editing?: boolean
  /** The person said yes to a brief. Until then the card only asks, and nothing is run
   * on their behalf that they will see. */
  accepted: boolean
}

/** The prompt "Send full brief" types, with the answers as they stand on the card. */
export function briefOf(card: ExpandOpen): string | null {
  if (!card.answer) return null
  const { expansion, where } = card.answer
  const answers = expansion.questions.map((q, i) => q.options[card.picks[i] ?? 0] ?? q.options[0])
  return expandedPrompt(card.text, expansion, answers, where)
}

interface Props {
  card: ExpandOpen
  onPick: (question: number, option: number) => void
  onBrief: (text: string, choice: 'expanded' | 'edited') => void
  onOriginal: () => void
  /** Yes, write the brief. */
  onAccept: () => void
  onEditing: (on: boolean) => void
  /** Present only where the split dialog can be opened; the button is hidden without it. */
  onSplit?: () => void
}

/**
 * A button that does not take the focus from the terminal. `preventDefault` on mousedown
 * is what keeps xterm's own text box focused; the click still arrives.
 */
function Btn({
  className,
  onPress,
  children,
  title
}: {
  className?: string
  onPress: () => void
  children: React.ReactNode
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={'expand-btn' + (className ? ' ' + className : '')}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

/** The seconds count, in its own component so the one-second tick lives only while waiting. */
function Waiting({ since }: { since: number }): JSX.Element {
  const now = useNow(1000, since)
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div className="expand-lead" role="status" aria-live="polite">
      <span className="expand-title">Writing a fuller brief…</span>
      <span className="expand-secs">{secs}s</span>
    </div>
  )
}

/** One row of the brief: what it is about on the left, what it says on the right. */
function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <dt className="expand-label">{label}</dt>
      <dd className="expand-value">{children}</dd>
    </>
  )
}

function Lines({ items }: { items: string[] }): JSX.Element {
  return (
    <ul className="expand-list">
      {items.map((d, i) => (
        <li key={i}>{d}</li>
      ))}
    </ul>
  )
}

export default function ExpandCard({
  card,
  onPick,
  onBrief,
  onOriginal,
  onAccept,
  onEditing,
  onSplit
}: Props): JSX.Element {
  // Local on purpose: a keystroke in the edit box must not re-render the whole pane.
  const [edited, setEdited] = useState('')
  const answer = card.answer
  const brief = briefOf(card)
  const e = answer?.expansion
  return (
    <div
      className="expand-card"
      role="dialog"
      aria-label="Fuller brief before sending"
      // The pane's own mouse handlers place the terminal cursor on a press; a press on this
      // card is not one of those. Only the edit box is allowed the focus.
      onMouseDown={(ev) => {
        ev.stopPropagation()
        if (!(ev.target instanceof HTMLTextAreaElement)) ev.preventDefault()
      }}
    >
      {!card.accepted ? (
        <div className="expand-lead">
          <span className="expand-title">Write this up as a fuller brief first?</span>
          <span className="expand-note">
            Adds a goal, where to start and what done means. You see it before anything is sent.
          </span>
        </div>
      ) : !answer ? (
        <Waiting since={card.openedAt} />
      ) : card.editing ? (
        <textarea
          className="expand-edit"
          value={edited}
          autoFocus
          spellCheck={false}
          aria-label="The brief that will be sent"
          onChange={(ev) => setEdited(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.preventDefault()
              onEditing(false)
            }
          }}
        />
      ) : e ? (
        <>
          <dl className="expand-sheet">
            <Row label="Goal">
              <p>{e.goal}</p>
            </Row>
            {answer.where.length > 0 && (
              <Row label="Start in">
                <ul className="expand-list expand-where">
                  {answer.where.map((w) => (
                    <li key={w.file + ':' + (w.line ?? '')}>
                      <code>{w.line ? `${w.file}:${w.line}` : w.file}</code>
                      {w.symbol ? <span className="expand-sym">{w.symbol}</span> : null}
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            {e.done.length > 0 && (
              <Row label="Done when">
                <Lines items={e.done} />
              </Row>
            )}
            {e.outOfScope.length > 0 && (
              <Row label="Leave alone">
                <Lines items={e.outOfScope} />
              </Row>
            )}
            {e.questions.map((q, qi) => (
              <Row key={qi} label={qi === 0 ? 'Your call' : ''}>
                <p>{q.ask}</p>
                <div className="expand-seg">
                  {q.options.map((o, oi) => {
                    const on = (card.picks[qi] ?? 0) === oi
                    return (
                      <Btn
                        key={oi}
                        className={'expand-opt' + (on ? ' on' : '')}
                        onPress={() => onPick(qi, oi)}
                        title={oi === 0 ? 'Suggested' : undefined}
                      >
                        {o}
                      </Btn>
                    )
                  })}
                </div>
              </Row>
            ))}
          </dl>
          {answer.bundled && onSplit && (
            <div className="expand-bundled">
              <span>This asks for several separate things</span>
              <Btn onPress={onSplit}>Open as separate panes</Btn>
            </div>
          )}
        </>
      ) : null}
      <div className="expand-actions">
        {!card.accepted ? (
          <>
            <Btn className="primary" onPress={onAccept} title="Enter">
              Write brief
            </Btn>
            <Btn onPress={onOriginal}>Send as typed</Btn>
            <span className="expand-hint">Enter to write it · Esc to keep typing</span>
          </>
        ) : card.editing ? (
          <>
            <Btn className="primary" onPress={() => onBrief(edited, 'edited')}>
              Send this
            </Btn>
            <Btn onPress={() => onEditing(false)}>Back</Btn>
          </>
        ) : (
          <>
            {brief !== null && (
              <Btn className="primary" onPress={() => onBrief(brief, 'expanded')} title="Enter">
                Send brief
              </Btn>
            )}
            {brief !== null && (
              <Btn
                onPress={() => {
                  setEdited(brief)
                  onEditing(true)
                }}
              >
                Edit
              </Btn>
            )}
            <Btn onPress={onOriginal}>Send as typed</Btn>
            <span className="expand-hint">Esc to keep typing</span>
          </>
        )}
      </div>
    </div>
  )
}
