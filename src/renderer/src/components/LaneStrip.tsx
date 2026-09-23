import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { appVisible, onAppVisible } from '../appVisible'
import type { CopiesNotice } from '../laneWords'
import { copiesNotice, laneProject } from '../laneWords'

const api = window.api

interface Props {
  boards: LaneBoard[]
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
 * None of that is drawn as a list of copies any more (copiesNotice in ../laneWords says
 * why): the only lines left are the ones that need a person, so on an ordinary day this
 * is not on screen at all.
 */
export function useLaneBoards(): LaneBoard[] {
  const [boards, setBoards] = useState<LaneBoard[]>([])

  useEffect(() => {
    let live = true
    const poll = (): void => {
      // Not `document.hidden`: it never turns true in this window. See appVisible.ts.
      void appVisible().then((v) => {
        if (!v || !live) return
        api.laneBoard().then((b) => live && setBoards(b ?? []))
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

  return boards
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
  return sessions.find((s) => s.id === lane.ownerPane && (s.status !== 'exited' || s.asleep))
}

/** Lanes keyed by the pane holding them, for the chip on a session card - every repo's. */
export function useLanesByPane(boards: LaneBoard[]): Map<string, LaneBoardEntry> {
  return useMemo(() => {
    const m = new Map<string, LaneBoardEntry>()
    for (const b of boards) for (const l of b.lanes) if (l.ownerPane) m.set(l.ownerPane, l)
    return m
  }, [boards])
}

/** The lane a pane holds, if any. Callers hold the map from useLanesByPane. */
export function laneOfSession(
  lanes: Map<string, LaneBoardEntry>,
  sessionId: string
): LaneBoardEntry | undefined {
  return lanes.get(sessionId)
}

// The sentences themselves live in ../laneWords, which imports nothing: the strip only polls
// while the window is on screen, so what it would say is checked there rather than by reading
// a DOM that may not exist. See scripts/lane-holder-test.mjs.

/** The job handed to a chat to unstick a lane, in the form lane.mjs expects back. */
function fixPrompt(lane: LaneBoardEntry, repo: string): string {
  return (
    `${laneProject(lane)} lane ${lane.lane} is conflicted, so its finished work is left out of every release. ` +
    `Take it over: node scripts/lane.mjs resolve --repo ${repo} --session <this chat's session id> --lane ${lane.lane} ` +
    `(lane.mjs lives in the PaneForge checkout), ` +
    `resolve the files it lists in ${lane.dir}, commit, then node scripts/lane.mjs ready --repo ${repo} --session <same id> --lane ${lane.lane}.`
  )
}

export default function LaneStrip({ boards, sessions, onFocus }: Props): JSX.Element | null {
  // A job is handed over once. Keyed by when the conflict started, so a lane that gets
  // stuck again later is a new job and not one this ref has already forgotten about.
  const handed = useRef(new Set<string>())

  // Unsticking a lane never needed a human to decide anything - the button only ever
  // typed the same paragraph into whichever pane was free. So the app does that itself:
  // the lane's own chat gets its own conflict back, and once the conflict is adoptable
  // (its chat has gone quiet) any idle pane takes it. Never a pane that is mid-turn -
  // that job waits for a free one rather than landing in the middle of someone's answer.
  useEffect(() => {
    for (const board of boards)
      for (const lane of board.lanes) {
        if (!lane.conflicted || lane.resolver) continue
        const key = `${board.repo}:${lane.lane}:${lane.conflictSince ?? 0}`
        if (handed.current.has(key)) continue
        const own = laneOwner(lane, sessions)
        const target =
          own ??
          (lane.adoptable ? sessions.find((s) => s.status !== 'exited' && s.status !== 'working') : undefined)
        if (!target || target.asleep || target.status === 'exited' || target.status === 'working') continue
        handed.current.add(key)
        // Not `write(text + '\r')`. That is the shape measured failing on 2026-08-11 for
        // launch prompts and found failing here on 2026-08-17: the CLIs run with bracketed
        // paste on, so a paragraph written to the pty arrives as pasted text and the CR
        // glued to its end is one more character of the paste, not Enter. The job then sits
        // in the chat's prompt box until a person notices and presses Enter - which is the
        // whole point of an automatic hand-over, missed. `sendPrompt` waits for an idle
        // composer, then sends the return as its own keystroke and confirms it took.
        api.sendPrompt(target.id, fixPrompt(lane, board.repo))
      }
  }, [boards, sessions])

  // The copies themselves are never listed: see copiesNotice for what was here and why.
  const notices = boards.map((b) => copiesNotice(b)).filter((n): n is CopiesNotice => n !== null)
  if (!notices.length) return null

  // The automatic hand-over waits for a pane that is not mid-turn, and leaves a conflict
  // whose own chat is still alive to that chat. This is the same job for someone who does
  // not want to wait for either, which is why it may land in a busy pane.
  const handOver = (lane: LaneBoardEntry, repo: string): void => {
    const target = laneOwner(lane, sessions) ?? sessions.find((s) => s.status !== 'exited')
    if (!target) return
    onFocus(target.id)
    // Typed in, not sent: this one is a click, so the chat it lands in may be mid-thought.
    api.write(target.id, fixPrompt(lane, repo))
  }

  return (
    <div className="lanes">
      {notices.map((n) => (
        <div key={n.repo} className={'row lane-row readable' + (n.fix ? ' stuck' : '')}>
          <div className="row-text">
            <div className="row-title">{n.text}</div>
          </div>
          {n.fix && (
            <button
              className="ghost small lane-fix"
              onClick={() => n.fix && handOver(n.fix, n.repo)}
              title="A chat picks which version of the lines to keep"
            >
              Fix it
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
