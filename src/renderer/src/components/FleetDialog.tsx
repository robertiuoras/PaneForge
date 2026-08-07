import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffScope, DriveRun, GitInfo, Session } from '@shared/types'
import type { AgentInfo } from '@shared/agents'
import { describePlace } from '@shared/place'
import { driveLine, runDone, unattended, unattendedLine } from '@shared/agentic'
import type { Goal } from '@shared/goals'
import { goalLine, queuePosition } from '@shared/goals'
import { density, fleetOrder, fleetRow, gitLine } from '@shared/fleet'
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

  // Lanes the app is driving itself. They have no pane, so nothing above this line can
  // see them - and this is the screen whose whole question is "what is happening and
  // who needs me", which a run nobody is watching is the sharpest case of.
  const [drives, setDrives] = useState<DriveRun[]>([])
  useEffect(() => {
    void api.listDrives().then(setDrives)
    return api.onDrive((run) =>
      setDrives((all) => {
        const i = all.findIndex((r) => r.id === run.id)
        return i === -1 ? [...all, run] : all.map((r) => (r.id === run.id ? run : r))
      })
    )
  }, [])

  // The queue behind the runs (I4). A goal that is RUNNING is already on this screen as
  // its drive, in full, so only the ones with nothing live to show appear here: the ones
  // waiting their turn, and the ones that ended - including the ones that were still
  // going when the app was last closed, which is the state nothing could report before.
  const [goals, setGoals] = useState<Goal[]>([])
  useEffect(() => {
    void api.listGoals().then(setGoals)
    return api.onGoals(setGoals)
  }, [])
  const waiting = goals.filter((g) => g.state !== 'running')

  const rows = useMemo(() => fleetOrder(sessions), [sessions])
  // The pane number is the sidebar's number and the Ctrl-N keystroke, so it has to come
  // from the ORIGINAL order, not from this screen's.
  const numberOf = useMemo(() => new Map(sessions.map((s, i) => [s.id, i + 1])), [sessions])

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
          {rows.map((s, i) => {
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
          {rows.length === 0 && drives.length === 0 && waiting.length === 0 && (
            <div className="empty">No panes open.</div>
          )}

          {waiting.length > 0 && (
            <div className="fleet-drive">
              <div className="fleet-drive-head">
                <strong>Queue</strong>
                <span className="muted">
                  {waiting.length} goal{waiting.length === 1 ? '' : 's'} · one runs at a time
                </span>
              </div>
              {waiting.map((g) => (
                <div key={g.id} className={`fleet-row is-drive goal-${g.state}`} title={g.cwd}>
                  <span className="fleet-dot m-still" aria-hidden="true" />
                  <span className="fleet-num" />
                  <span className="fleet-who">
                    <span className="fleet-title">{g.mission.slice(0, 80)}</span>
                    <span className="fleet-place">{goalLine(g, queuePosition(goals, g.id))}</span>
                  </span>
                  <span className="fleet-state">
                    {g.state === 'queued' ? (
                      <button
                        className="ghost small"
                        title="Take this out of the line. Nothing has started, so nothing is lost."
                        onClick={() => void api.cancelGoal(g.id)}
                      >
                        Cancel
                      </button>
                    ) : (
                      <>
                        <button
                          className="ghost small"
                          title="Put it back in the line, keeping every attempt so far. New worktrees - the old branches stay where they are."
                          onClick={() => void api.retryGoal(g.id)}
                        >
                          Retry
                        </button>
                        <button
                          className="ghost small"
                          title="Forget this goal. The branches it produced are untouched."
                          onClick={() => void api.removeGoal(g.id)}
                        >
                          Forget
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {drives.map((run) => (
            <div key={run.id} className="fleet-drive">
              <div className="fleet-drive-head">
                <strong>{run.mission.slice(0, 90)}</strong>
                {/* K4. This run's agents were started with their permission prompt off,
                    which is the one thing about a driven lane a person cannot see by
                    looking at it. Derived from the arguments the run actually carries. */}
                {unattended(run.agent) && (
                  <span className="perm-chip" title={unattendedLine(run.agent)}>
                    unattended
                  </span>
                )}
                <span className="muted">
                  {run.lanes.length} lane{run.lanes.length === 1 ? '' : 's'}
                  {run.tokens.output ? ` · ${Math.round(run.tokens.output / 1000)}k out` : ''}
                  {run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ''}
                </span>
                {!runDone(run) && (
                  <button
                    className="ghost small"
                    title="Stop this run now, mid-command if need be"
                    onClick={(e) => {
                      e.stopPropagation()
                      void api.stopDrive(run.id)
                    }}
                  >
                    Stop
                  </button>
                )}
              </div>
              {run.lanes.map((lane) => (
                <div
                  key={lane.name}
                  className={`fleet-row is-drive drive-${lane.state}`}
                  title={lane.cwd || 'no worktree yet'}
                  onClick={() => {
                    // A driven lane has no pane to focus, so the useful click is its
                    // diff - which is the whole deliverable, and the only thing a
                    // person is meant to do with it.
                    // No lane LABEL is passed: `branch` is `lane-a`, and the diff header
                    // wants the `a` the sidebar shows. Naming it wrongly is worse than
                    // not naming it - the folder is already in the title.
                    if (lane.cwd) onDiff(lane.cwd, undefined, 0, 'all')
                  }}
                >
                  <span className="fleet-dot m-still" aria-hidden="true" />
                  <span className="fleet-num" />
                  <span className="fleet-who">
                    <span className="fleet-title">{lane.name}</span>
                    <span className="fleet-place">{driveLine(lane)}</span>
                  </span>
                  <span className="fleet-state">
                    <span className="fleet-label">{lane.state}</span>
                    {lane.startedAt !== undefined && lane.endedAt === undefined && (
                      <Elapsed since={lane.startedAt} className="fleet-clock" title={lane.state} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="dialog-foot">
          <span className="muted">↑↓ to move, Enter to open that pane, Esc to close.</span>
          {/* A driven run has no pane to close, so without this the board keeps every
              finished run until the app restarts. Only the finished ones go: a live run
              cannot be dismissed, it can only be stopped. */}
          {drives.some(runDone) && (
            <button
              className="ghost small"
              onClick={() => {
                void api.clearDrives()
                setDrives((all) => all.filter((r) => !runDone(r)))
              }}
            >
              Clear finished
            </button>
          )}
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
