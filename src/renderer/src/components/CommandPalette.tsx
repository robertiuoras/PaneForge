import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keyLabel } from '../platform'

export interface Command {
  id: string
  title: string
  /** right-aligned context: a path, a shortcut, an agent name */
  hint?: string
  group?: string
  icon?: ReactNode
  keys?: string
  run: () => void
}

interface Props {
  commands: Command[]
  onClose: () => void
}

/** How many rows a group may spend before anything has been typed. */
const FIRST_PER_GROUP = 6

/**
 * The box cannot say what is in it, so it says what to type into it.
 *
 * A search box with a static placeholder teaches nothing: "Jump to a session, run a
 * command" names two categories and not one thing anybody could type. These are real
 * queries against the commands this app actually registers, cycled in the placeholder
 * so the box is showing a different one each time it is opened.
 *
 * It stops the moment anything is typed - a placeholder is gone by then anyway, and a
 * timer still running behind a box somebody is using is a render per tick for nothing.
 */
const EXAMPLES = [
  'settings',
  'a project name',
  'split a long ask',
  'history',
  'devices',
  'new session',
  'a pane you have open'
]

/** How long one example stays up. Slow enough to read a whole one before it moves. */
const EXAMPLE_MS = 3600

/**
 * Ctrl K: one box that reaches every session, workspace and action. It exists because
 * the sidebar stops being scannable past about eight sessions, and because switching
 * project should not need the mouse.
 *
 * Matching is subsequence-based (like an editor's file finder), so "afil" finds
 * "Airtasker filter". Score prefers matches that are earlier and less scattered.
 */
export default function CommandPalette({ commands, onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [ex, setEx] = useState(() => Math.floor(Math.random() * EXAMPLES.length))
  const box = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => box.current?.focus(), [])
  useEffect(() => {
    if (q) return
    const t = setInterval(() => setEx((i) => (i + 1) % EXAMPLES.length), EXAMPLE_MS)
    return () => clearInterval(t)
  }, [q])
  useEffect(() => setHi(0), [q])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.cmd.hi')?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // Nothing typed yet: a few of EACH group rather than the first 60 in build order.
    // The projects list alone is capped at 40, so on a desk with a handful of panes open
    // the flat slice spent most of its 60 rows on folders and the whole `Actions` group -
    // the half of this box the placeholder promises - was below the cut until you typed.
    // A cap per group is what makes the empty box an INDEX of what is in here.
    if (!needle) {
      const seen = new Map<string, number>()
      return commands.filter((c) => {
        const k = c.group ?? ''
        const n = (seen.get(k) ?? 0) + 1
        seen.set(k, n)
        return n <= FIRST_PER_GROUP
      })
    }
    return commands
      .map((c) => ({ c, s: score(`${c.title} ${c.hint ?? ''} ${c.group ?? ''}`.toLowerCase(), needle) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((r) => r.c)
  }, [commands, q])

  /**
   * The groups this box actually holds, in the order they were registered.
   *
   * Drawn as one row of chips under the input while nothing is typed, and gone the
   * moment something is: this is the answer to "what can I even search for here",
   * which the sidebar's button used to try to give by spelling out "sessions and
   * actions" in words nobody reads twice. A press types the group's own name, which
   * the subsequence match already scores against (`c.group` is part of the haystack),
   * so the chip is a real query and not a second filtering mechanism to keep in step.
   */
  const groups = useMemo(() => {
    const seen: string[] = []
    for (const c of commands) if (c.group && !seen.includes(c.group)) seen.push(c.group)
    return seen
  }, [commands])

  const go = (c?: Command): void => {
    if (!c) return
    onClose()
    c.run()
  }

  let last: string | undefined

  return (
    <div className="overlay cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={box}
            placeholder={`Search — try “${EXAMPLES[ex]}”`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Stop-propagation keeps the app's global handler from also acting on
              // Escape or the number keys while the palette owns the keyboard.
              e.stopPropagation()
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHi((i) => Math.min(i + 1, shown.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHi((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') go(shown[hi])
            }}
          />
          <span className="kbd-box">Esc</span>
        </div>
        {!q && groups.length > 0 && (
          <div className="cmdk-hints">
            <span className="cmdk-hint-lead">In here:</span>
            {groups.map((g) => (
              <button
                key={g}
                className="cmdk-chip"
                onClick={() => {
                  setQ(g)
                  box.current?.focus()
                }}
              >
                {g}
              </button>
            ))}
          </div>
        )}
        <div className="cmdk-list" ref={list}>
          {shown.map((c, i) => {
            const head = c.group && c.group !== last ? c.group : null
            last = c.group
            return (
              <div key={c.id}>
                {head && <div className="opt-group">{head}</div>}
                <div
                  className={'cmd' + (i === hi ? ' hi' : '')}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => go(c)}
                >
                  {c.icon}
                  <span className="cmd-title">{c.title}</span>
                  {c.hint && <span className="cmd-hint">{c.hint}</span>}
                  {c.keys && <span className="kbd-box">{keyLabel(c.keys)}</span>}
                </div>
              </div>
            )
          })}
          {shown.length === 0 && <div className="empty">Nothing matches.</div>}
        </div>
      </div>
    </div>
  )
}

/** Subsequence match: 0 = no match, higher = tighter and closer to the start. */
function score(text: string, needle: string): number {
  let i = 0
  let points = 0
  let streak = 0
  for (const ch of needle) {
    const at = text.indexOf(ch, i)
    if (at < 0) return 0
    streak = at === i ? streak + 1 : 0
    points += 10 + streak * 4 - Math.min(at - i, 8)
    i = at + 1
  }
  return points + Math.max(0, 20 - text.indexOf(needle[0]))
}
