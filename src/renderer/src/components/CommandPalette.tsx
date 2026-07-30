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
  const box = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => box.current?.focus(), [])
  useEffect(() => setHi(0), [q])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.cmd.hi')?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return commands.slice(0, 60)
    return commands
      .map((c) => ({ c, s: score(`${c.title} ${c.hint ?? ''} ${c.group ?? ''}`.toLowerCase(), needle) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((r) => r.c)
  }, [commands, q])

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
            placeholder="Jump to a session, run a command"
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
