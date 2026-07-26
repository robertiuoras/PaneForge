import { useEffect, useState } from 'react'
import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'

const api = window.api

interface Props {
  sessions: Session[]
  /** focus the pane that holds a lane, when one of the open panes does */
  onFocus: (id: string) => void
}

/**
 * PaneForge's own development lanes, in the sidebar.
 *
 * Several chats edit PaneForge at once, each in its own checkout, and the whole release
 * is automatic - which is fine until one lane's work will not merge into master. That
 * lane is then left out of every release, silently, until a human learns about it from a
 * sentence buried in another chat's hook output. Lane b sat like that for a day.
 *
 * So the state is on screen: who holds what, what is waiting to go out, and a conflicted
 * lane glowing red with the one action that clears it. Nothing here is shown on a machine
 * without a PaneForge checkout - the board is null and the strip does not render.
 */
export default function LaneStrip({ sessions, onFocus }: Props): JSX.Element | null {
  const [board, setBoard] = useState<LaneBoard | null>(null)
  const [help, setHelp] = useState(false)

  useEffect(() => {
    let live = true
    const poll = (): void => {
      if (document.hidden) return
      api.laneBoard().then((b) => live && setBoard(b))
    }
    poll()
    const t = window.setInterval(poll, 5000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      live = false
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [])

  if (!board || board.lanes.length === 0) return null
  const stuck = board.lanes.filter((l) => l.conflicted).length

  return (
    <>
      <div className="section">
        Lanes ({board.lanes.length})
        <button
          className={'help-dot' + (help ? ' on' : '')}
          onClick={() => setHelp((h) => !h)}
          title="What is a lane?"
          aria-label="What is a lane?"
          aria-expanded={help}
        >
          ?
        </button>
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
      {help && (
        <div className="lane-help">
          <p>
            Several chats edit PaneForge at once. A <b>lane</b> is one private copy of the
            repository for one chat, so two of them cannot overwrite each other&apos;s files or
            race the same build.
          </p>
          <p>
            You never make or delete one: a chat claims a lane the moment it starts work, and
            gives it back when it ends. The first chat gets the repository itself; the rest get
            their own checkouts beside it.
          </p>
          <p>
            When a chat finishes, its lane is merged and released with every other finished
            lane — one version, not one per chat. <b>Stuck</b> means a lane&apos;s work will not
            merge, so it is being left out of releases until someone fixes it; that is what the
            fix button hands to a pane.
          </p>
        </div>
      )}
      <div className="lanes">
        {board.lanes.map((l) => (
          <LaneRow key={l.lane} lane={l} sessions={sessions} onFocus={onFocus} />
        ))}
      </div>
    </>
  )
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

function LaneRow({ lane, sessions, onFocus }: Props & { lane: LaneBoardEntry }): JSX.Element {
  // The chat holding a lane started somewhere else (a lane is a checkout, not a cwd), so
  // the pane is found by the folder it was started in, which is what lane.mjs records.
  const pane = lane.from ? sessions.find((s) => s.cwd === lane.from) : undefined
  const where = lane.from ? lane.from.split(/[\\/]/).pop() : null

  // "working" was a lie the strip told about every lane: a chat claims one the moment it
  // starts, so four chats that had typed nothing all read as busy. What the lane file
  // actually knows is who holds it and when that chat was last heard from, so that is
  // what it says now - held, and how long since it did anything.
  const quiet = Date.now() - lane.seen
  const state = lane.conflicted
    ? `conflicts with master, ${ago(lane.conflictSince ?? Date.now())}`
    : lane.ready
      ? 'done, waiting for the release'
      : lane.held
        ? quiet < 5 * 60 * 1000
          ? 'a chat has it, busy now'
          : `a chat has it, quiet ${ago(lane.seen)}`
        : 'free'

  const tip = lane.conflicted
    ? `${lane.dir}\nWill not merge: ${lane.conflictDetail ?? 'see the lane'}\n` +
      (lane.resolver
        ? 'A chat has taken this over.'
        : lane.adoptable
          ? 'Its own chat has gone quiet, so any chat can finish it. Click "fix" to hand the job to a pane.'
          : 'Its own chat is still around and should fix it.')
    : `${lane.dir} (${lane.branch})${where ? `\nstarted in ${where}` : ''}`

  // Typed in, not sent: handing an agent a job is fine, pressing return for it is not.
  const handOver = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const target = pane && Date.now() - lane.seen < 45 * 60 * 1000 ? pane : sessions.find((s) => s.status !== 'exited')
    if (!target) return
    onFocus(target.id)
    api.write(
      target.id,
      `PaneForge lane ${lane.lane} is conflicted, so its finished work is left out of every release. ` +
        `Take it over: node scripts/lane.mjs resolve --session <this chat's session id> --lane ${lane.lane}, ` +
        `resolve the files it lists in ${lane.dir}, commit, then node scripts/lane.mjs ready --session <same id> --lane ${lane.lane}.`
    )
  }

  return (
    <div
      className={'row lane-row' + (lane.conflicted ? ' stuck' : '') + (lane.ready ? ' done' : '')}
      title={tip}
      onClick={() => pane && onFocus(pane.id)}
    >
      <span className={'lane-tag' + (lane.conflicted ? ' stuck' : '')}>{lane.lane}</span>
      <div className="row-text">
        <div className="row-title">{where ?? lane.branch}</div>
        <div className="row-sub">{state}</div>
      </div>
      {lane.conflicted && !lane.resolver && (
        <button className="ghost small lane-fix" onClick={handOver} title="Put the job into a chat pane">
          fix
        </button>
      )}
    </div>
  )
}
