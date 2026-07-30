import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { appVisible, onAppVisible } from '../appVisible'

const api = window.api

interface Props {
  board: LaneBoard | null
  sessions: Session[]
  /** focus the pane a job was handed to */
  onFocus: (id: string) => void
}

/**
 * PaneForge's own development lanes.
 *
 * Several chats edit PaneForge at once, each in its own checkout, and the whole release
 * is automatic - which is fine until one lane's work will not merge into master. That
 * lane is then left out of every release, silently, until a human learns about it from a
 * sentence buried in another chat's hook output. Lane b sat like that for a day.
 *
 * The lane a pane holds is drawn ON that pane's card (LaneChip below), because that is
 * where you are already looking and a second list of the same sessions was two places to
 * read one fact. What is left over is what no card can say: a lane whose chat is gone,
 * finished work waiting on a release, a conflict nobody owns. Only those appear here, so
 * on an ordinary day this section is not on screen at all.
 */
export function useLaneBoard(): LaneBoard | null {
  const [board, setBoard] = useState<LaneBoard | null>(null)

  useEffect(() => {
    let live = true
    const poll = (): void => {
      // Not `document.hidden`: it never turns true in this window. See appVisible.ts.
      void appVisible().then((v) => {
        if (!v || !live) return
        api.laneBoard().then((b) => live && setBoard(b))
      })
    }
    poll()
    const t = window.setInterval(poll, 5000)
    const off = onAppVisible(poll)
    return () => {
      live = false
      window.clearInterval(t)
      off()
    }
  }, [])

  return board
}

/**
 * The pane a lane belongs to.
 *
 * Answered in the main process (laneBoard.ts `attachLaneOwners`), which is the only side
 * that can: a lane records the CHAT holding it, and matching that to a pane needs the
 * pane's conversation id, which never leaves the main process. Matching by folder here
 * instead was wrong in the case that actually happens - every chat records the main
 * checkout it started in, so one new pane opened there "owned" two dead chats' lanes at
 * once and both disappeared off the strip while still held.
 */
export function laneOwner(lane: LaneBoardEntry, sessions: Session[]): Session | undefined {
  if (!lane.ownerPane) return undefined
  return sessions.find((s) => s.id === lane.ownerPane && s.status !== 'exited')
}

/** Lanes keyed by the pane holding them, for the chip on a session card. */
export function useLanesByPane(board: LaneBoard | null): Map<string, LaneBoardEntry> {
  return useMemo(() => {
    const m = new Map<string, LaneBoardEntry>()
    for (const l of board?.lanes ?? []) if (l.ownerPane) m.set(l.ownerPane, l)
    return m
  }, [board])
}

/** The lane a pane holds, if any. Callers hold the map from useLanesByPane. */
export function laneOfSession(
  lanes: Map<string, LaneBoardEntry>,
  sessionId: string
): LaneBoardEntry | undefined {
  return lanes.get(sessionId)
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** What the lane is doing, in the words a human would use. */
function laneState(lane: LaneBoardEntry): string {
  if (lane.conflicted) return `conflicts with master, ${ago(lane.conflictSince ?? Date.now())}`
  if (lane.ready) return 'done, waiting for the release'
  if (!lane.held) return 'free'
  // "working" was a lie the strip told about every lane: a chat claims one the moment it
  // starts, so four chats that had typed nothing all read as busy. What the lane file
  // actually knows is who holds it and when that chat was last heard from.
  return Date.now() - lane.seen < 5 * 60 * 1000
    ? 'a chat has it, busy now'
    : `a chat has it, quiet ${ago(lane.seen)}`
}

function laneTip(lane: LaneBoardEntry): string {
  if (!lane.conflicted) return `${lane.dir} (${lane.branch})`
  return (
    `${lane.dir}\nWill not merge: ${lane.conflictDetail ?? 'see the lane'}\n` +
    (lane.resolver
      ? 'A chat has taken this over.'
      : lane.adoptable
        ? 'Its own chat has gone quiet, so any chat can finish it.'
        : 'Its own chat is still around and should fix it.')
  )
}

/** The job handed to a chat to unstick a lane, in the form lane.mjs expects back. */
function fixPrompt(lane: LaneBoardEntry): string {
  return (
    `PaneForge lane ${lane.lane} is conflicted, so its finished work is left out of every release. ` +
    `Take it over: node scripts/lane.mjs resolve --session <this chat's session id> --lane ${lane.lane}, ` +
    `resolve the files it lists in ${lane.dir}, commit, then node scripts/lane.mjs ready --session <same id> --lane ${lane.lane}.`
  )
}

/**
 * The lane a pane holds, on the pane's own card beside its agent and model.
 *
 * Colour carries the only state worth interrupting for: red means this pane's finished
 * work is being left out of every release.
 */
export function LaneChip({ lane }: { lane: LaneBoardEntry }): JSX.Element {
  // "lane a" beside a "w2" worktree chip read as two halves of one fact, and they are not
  // related at all: w2 is this pane's own checkout of whatever project it opened, and this
  // is a lane in PaneForge's release pool that the chat in this pane happens to hold. The
  // prefix is the whole difference, so it is in the label rather than only the tooltip.
  const label = lane.conflicted
    ? `PF lane ${lane.lane} stuck`
    : lane.ready
      ? `PF lane ${lane.lane} done`
      : `PF lane ${lane.lane}`
  return (
    <span
      className={'chip pf-lane' + (lane.conflicted ? ' stuck' : lane.ready ? ' done' : '')}
      title={
        `This chat is building PaneForge itself in lane ${lane.lane} (${lane.branch}) - ${laneState(lane)}.\n` +
        `Nothing to do with the folder this pane is open in.\n${laneTip(lane)}`
      }
    >
      {label}
    </span>
  )
}

export default function LaneStrip({ board, sessions, onFocus }: Props): JSX.Element | null {
  // A job is handed over once. Keyed by when the conflict started, so a lane that gets
  // stuck again later is a new job and not one this ref has already forgotten about.
  const handed = useRef(new Set<string>())

  // Unsticking a lane never needed a human to decide anything - the button only ever
  // typed the same paragraph into whichever pane was free. So the app does that itself:
  // the lane's own chat gets its own conflict back, and once the conflict is adoptable
  // (its chat has gone quiet) any idle pane takes it. Never a pane that is mid-turn -
  // that job waits for a free one rather than landing in the middle of someone's answer.
  useEffect(() => {
    for (const lane of board?.lanes ?? []) {
      if (!lane.conflicted || lane.resolver) continue
      const key = `${lane.lane}:${lane.conflictSince ?? 0}`
      if (handed.current.has(key)) continue
      const own = laneOwner(lane, sessions)
      const target =
        own ??
        (lane.adoptable ? sessions.find((s) => s.status !== 'exited' && s.status !== 'working') : undefined)
      if (!target || target.status === 'working') continue
      handed.current.add(key)
      api.write(target.id, fixPrompt(lane) + '\r')
    }
  }, [board, sessions])

  // Whatever a session card already says is not repeated here.
  const orphans = (board?.lanes ?? []).filter((l) => !laneOwner(l, sessions))
  if (!board || !orphans.length) return null
  const stuck = orphans.filter((l) => l.conflicted).length

  return (
    <>
      <div className="section">
        <span className="section-title">Lanes elsewhere ({orphans.length})</span>
        {stuck > 0 && (
          <span className="badge stuck" title="Finished work that will not merge into master, so no release includes it">
            {stuck} stuck
          </span>
        )}
        {board.releasing !== null && (
          <span className="badge run" title="A release is being cut right now">
            releasing
          </span>
        )}
      </div>
      <div className="lanes">
        {orphans.map((l) => (
          <LaneRow key={l.lane} lane={l} sessions={sessions} onFocus={onFocus} />
        ))}
      </div>
    </>
  )
}

function LaneRow({
  lane,
  sessions,
  onFocus
}: {
  lane: LaneBoardEntry
  sessions: Session[]
  onFocus: (id: string) => void
}): JSX.Element {
  // The automatic hand-over waits for a pane that is not mid-turn, and leaves a conflict
  // whose own chat is still alive to that chat. This is the same job for someone who does
  // not want to wait for either, which is why it may land in a busy pane.
  const handOver = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const target = laneOwner(lane, sessions) ?? sessions.find((s) => s.status !== 'exited')
    if (!target) return
    onFocus(target.id)
    // Typed in, not sent: this one is a click, so the chat it lands in may be mid-thought.
    api.write(target.id, fixPrompt(lane))
  }

  return (
    <div
      className={'row lane-row' + (lane.conflicted ? ' stuck' : '') + (lane.ready ? ' done' : '')}
      title={laneTip(lane)}
    >
      <span className={'lane-tag' + (lane.conflicted ? ' stuck' : '')}>{lane.lane}</span>
      <div className="row-text">
        <div className="row-title">{lane.branch}</div>
        <div className="row-sub">
          {laneState(lane)}
          {lane.conflicted && lane.resolver ? ' - a chat has it' : ''}
        </div>
      </div>
      {lane.conflicted && !lane.resolver && (
        <button className="ghost small lane-fix" onClick={handOver} title="Hand the job to a pane now">
          fix
        </button>
      )}
    </div>
  )
}
