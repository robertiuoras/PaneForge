import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { DiffScope, GitInfo, Session } from '@shared/types'
import type { AgentInfo } from '@shared/agents'
import { describePlace } from '@shared/place'
import { density, fleetRow, fleetSections, gitLine, previewFrom } from '@shared/fleet'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'
import Elapsed from './Elapsed'

const api = window.api

interface Props {
  sessions: Session[]
  agents: AgentInfo[]
  activeId: string | null
  onFocus: (id: string) => void
  onDiff: (cwd: string, lane: string | undefined, pane: number, scope: DiffScope) => void
  onClose: () => void
}

/** What we have asked git about one pane's folder. */
interface Repo {
  git: GitInfo | null
  added: number
  removed: number
  files: number
}

/**
 * Every pane at once: who is working, who is stuck, and what has changed.
 *
 * The sidebar answers this today only by reading eight cards and decoding eight sets of
 * marks, and it answers it in the order the panes were opened - which is the one order
 * that is never the order you care about. This screen is sorted by who needs a person:
 * a pane that has been waiting eleven minutes is the first row, a stall is the second,
 * and everything the app is happily busy with sits below both. `shared/fleet.ts` owns
 * those rules and is tested without a window (`npm run test:fleet`).
 *
 * **Motion is the status.** Every other runner in this category draws a spinner per row,
 * which is a lot of movement that all means one thing. Here there are exactly two
 * motions and they mean different things - a slow breath is the app working, a spreading
 * ring is the app waiting on YOU - and a finished pane is perfectly still, so the
 * movement stopping is itself the event. `prefers-reduced-motion` turns both off and the
 * colours and words carry it alone.
 *
 * It reads git rather than remembering it: an agent is editing these folders while this
 * is open, so a cached answer is a wrong answer. One `git status` and one `git diff` per
 * distinct folder per tick, not per pane - four panes in one repo cost what one does.
 */
export default function FleetDialog({
  sessions,
  agents,
  activeId,
  onFocus,
  onDiff,
  onClose
}: Props): JSX.Element {
  const [repos, setRepos] = useState<Record<string, Repo>>({})
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)


  const sections = useMemo(() => fleetSections(sessions), [sessions])
  const rows = useMemo(() => sections.flatMap((g) => g.sessions), [sections])
  const indexOf = useMemo(() => new Map(rows.map((s, i) => [s.id, i])), [rows])
  // The pane number is the sidebar's number and the Ctrl-N keystroke, so it has to come
  // from the ORIGINAL order, not from this screen's.
  const numberOf = useMemo(() => new Map(sessions.map((s, i) => [s.id, i + 1])), [sessions])

  // What each pane last SAID, read straight out of its live xterm buffer - this dialog
  // shares the renderer with every local pane, so the read costs no IPC and is as fresh
  // as the screen itself. A remote mirror renders through the same path, so it is covered
  // too. Faster than the git tick because this is the line a person is deciding on.
  const [previews, setPreviews] = useState<Record<string, string | null>>({})
  useEffect(() => {
    type TermLine = { translateToString: (trim?: boolean) => string }
    type Buf = { baseY: number; cursorY: number; getLine: (i: number) => TermLine | undefined }
    type Reg = Record<string, { term?: { buffer: { active: Buf } } }>
    const read = (): void => {
      const reg = (window as unknown as { __pf?: Reg }).__pf
      if (!reg) return
      const next: Record<string, string | null> = {}
      for (const s of sessions) {
        const t = reg[s.id]?.term
        if (!t) continue
        const buf = t.buffer.active
        // Up to the CURSOR row, not the buffer's end: the buffer is the whole screen, and
        // on a half-full screen everything under the cursor is empty rows - reading "the
        // last 40 lines" of those found nothing (measured: content on rows 0-10 of 57).
        const end = buf.baseY + buf.cursorY
        const lines: string[] = []
        for (let i = Math.max(0, end - 39); i <= end; i++)
          lines.push(buf.getLine(i)?.translateToString(true) ?? '')
        next[s.id] = previewFrom(lines)
      }
      setPreviews((p) => ({ ...p, ...next }))
    }
    read()
    const t = window.setInterval(read, 2000)
    return () => window.clearInterval(t)
  }, [sessions])

  // One request per distinct folder, so a swarm of four panes in one repo does not run
  // four identical diffs. The scope matches what the pane's own badge would open: a lane
  // is asked what it has done to the repo in total, anything else what is uncommitted.
  const folders = useMemo(() => {
    const m = new Map<string, { cwd: string; scope: DiffScope }>()
    for (const s of sessions) {
      if (s.remote) continue // its git lives on the other machine, not on this disk
      const scope: DiffScope = s.lane ? 'all' : 'working'
      m.set(`${s.cwd}\u0000${scope}`, { cwd: s.cwd, scope })
    }
    return [...m.entries()]
  }, [sessions])

  useEffect(() => {
    let live = true
    const read = (): void => {
      for (const [key, { cwd, scope }] of folders) {
        void Promise.all([api.gitInfo(cwd), api.diffFiles(cwd, scope)]).then(([git, set]) => {
          if (!live) return
          let added = 0
          let removed = 0
          for (const f of set.files) {
            added += f.added
            removed += f.removed
          }
          setRepos((r) => ({ ...r, [key]: { git, added, removed, files: set.files.length } }))
        })
      }
    }
    read()
    // Slower than the pane badge's six seconds because this asks for a diff as well as a
    // status, and nothing here is a number you watch tick.
    const t = window.setInterval(read, 8000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [folders])

  useEffect(() => {
    if (hi >= rows.length) setHi(Math.max(0, rows.length - 1))
  }, [rows.length, hi])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.fleet-row.hi')?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const go = (id: string): void => {
    onFocus(id)
    onClose()
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog wide fleet"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((i) => Math.min(i + 1, rows.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter' && rows[hi]) go(rows[hi].id)
        }}
      >
        <div className="dialog-head">
          <strong>Fleet</strong>
          <span className="muted">
            {rows.length} {rows.length === 1 ? 'pane' : 'panes'}
          </span>
        </div>
        <Blurb id="fleet" />
        <div className="fleet-list" ref={listRef}>
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              <div className={`fleet-sec sec-${sec.key}`}>
                {sec.title}
                <span className="n">{sec.sessions.length}</span>
              </div>
              {sec.sessions.map((s) => {
                const i = indexOf.get(s.id) ?? 0
                const row = fleetRow(s)
            const key = `${s.cwd}\u0000${s.lane ? 'all' : 'working'}`
            const repo = s.remote ? undefined : repos[key]
            const pane = numberOf.get(s.id) ?? 0
            const place = describePlace({ cwd: s.cwd, branch: repo?.git?.branch, lane: s.lane, pane })
            const d = density(repo?.added ?? 0, repo?.removed ?? 0)
            const git = gitLine(repo?.git)
            return (
              <div
                key={s.id}
                className={
                  'fleet-row' +
                  (i === hi ? ' hi' : '') +
                  (s.id === activeId ? ' current' : '') +
                  ` is-${row.state}`
                }
                onMouseEnter={() => setHi(i)}
                onClick={() => go(s.id)}
                title={`${place.full}\n${row.label}`}
              >
                <span className={`fleet-dot m-${row.motion}`} aria-hidden="true" />
                <span className="fleet-num">{pane <= 9 ? pane : ''}</span>
                <AgentLogo id={s.agent} spec={agents.find((a) => a.id === s.agent)} size={15} />
                <span className="fleet-who">
                  <span className="fleet-title">{s.title}</span>
                  <span className="fleet-place">
                    {place.short}
                    {s.remote && <span className="fleet-remote"> · {s.remote.name}</span>}
                  </span>
                  {previews[s.id] && <span className="fleet-preview">{previews[s.id]}</span>}
                </span>
                <span className="fleet-state">
                  <span className="fleet-label">{row.label}</span>
                  {row.since !== undefined && (
                    <Elapsed since={row.since} className="fleet-clock" title={row.label} />
                  )}
                </span>
                {/* The diff bar. Not a number, because the question it answers is "has
                    this one been busy or has it been fiddling", and eight numbers do not
                    answer that at a glance the way eight bars do. */}
                <button
                  className={'fleet-diff' + (d.total ? ' has' : '')}
                  disabled={!d.total}
                  title={
                    d.total
                      ? `${d.total} lines across ${repo?.files ?? 0} files - click to read them`
                      : git === null
                        ? 'Not a git checkout'
                        : 'Nothing changed here'
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    onDiff(s.cwd, s.lane, pane, s.lane ? 'all' : 'working')
                  }}
                >
                  <span className="fleet-bar" style={{ width: `${Math.round(d.weight * 100)}%` }}>
                    <span className="add" style={{ flexBasis: `${d.added * 100}%` }} />
                    <span className="del" style={{ flexBasis: `${d.removed * 100}%` }} />
                  </span>
                  <span className="fleet-git">{git ?? ''}</span>
                </button>
              </div>
                )
              })}
            </Fragment>
          ))}
          {rows.length === 0 && (
            <div className="empty">No panes open.</div>
          )}


        </div>
        <div className="dialog-foot">
          <span className="muted">↑↓ to move, Enter to open that pane, Esc to close.</span>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
