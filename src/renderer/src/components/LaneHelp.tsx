import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { paneRef } from '@shared/place'
import { holderName, laneChipLabel, laneProject, laneState } from '../laneWords'

/**
 * What lanes are, for someone who never read the release script.
 *
 * It used to be five paragraphs of general theory, and the report on it was "way too much
 * content, hard to understand" - immediately followed by the question the theory does not
 * answer: *why are there two lanes for this project right now?* A card explaining a system
 * cannot answer that; only the board can. So the explanation is one sentence and the rest
 * of the card is **this project at this moment**, one row per lane that is actually held,
 * saying who has it and whether they are working. The three states that need a person are
 * one line each underneath, and everything else - worktrees, branches, the release
 * cooldown - is gone, because none of it is something to do.
 */
interface Props {
  onClose: () => void
  /** the lanes of every open project, one board each, when the window has polled them */
  boards: LaneBoard[]
  /** to name a lane by the pane holding it - "pane 3" is a key you can press */
  sessions: Session[]
}

/** Lanes worth a row: somebody is in it, or it is waiting on a person. */
function shown(lanes: LaneBoardEntry[]): LaneBoardEntry[] {
  return lanes.filter((l) => l.held || l.ready || l.conflicted)
}

export default function LaneHelp({ onClose, boards, sessions }: Props): JSX.Element {
  const rows = shown(boards.flatMap((b) => b.lanes))
  // One project name in the heading only when every row is that project; a mixed list's
  // rows each name their own (laneChipLabel with no project drops nothing).
  const projects = new Set(rows.map((l) => laneProject(l)))
  const project = projects.size === 1 ? (rows.length ? laneProject(rows[0]) : '') : ''
  const paneOf = (l: LaneBoardEntry): number | undefined => {
    const i = sessions.findIndex((s) => s.id === l.ownerPane)
    return i >= 0 ? i + 1 : undefined
  }

  return (
    <div className="overlay confirm-overlay" onMouseDown={onClose}>
      <div className="dialog confirm lane-help" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Lanes</strong>
        </div>
        <div className="confirm-body">
          <p>
            Two chats cannot edit one folder without overwriting each other, so each chat
            gets its own copy of the project. That copy is a <b>lane</b>. You never make
            one, and finished lanes merge back and ship on their own.
          </p>

          {rows.length > 0 && (
            <>
              {/* The whole reason the card exists now: "why are there two?" is a question
                  about this minute, and the answer is a list of who is in there. */}
              <div className="lane-help-when">
                {project ? `${project} right now` : 'Right now'} — {rows.length} lane
                {rows.length === 1 ? '' : 's'} in use
              </div>
              <ul className="lane-help-now">
                {rows.map((l) => (
                  <li key={l.dir}>
                    <span
                      className={
                        'chip pf-lane' +
                        (l.conflicted ? ' stuck' : l.ready ? ' done' : l.held ? ' busy' : '')
                      }
                    >
                      {laneChipLabel(l, project || undefined)}
                    </span>
                    <span className="lane-help-who">
                      {l.conflicted || l.ready
                        ? laneState(l)
                        : paneOf(l)
                          ? `${paneRef(paneOf(l) as number)} has it, ${laneState(l, true)}`
                          : `${holderName(l)}, ${laneState(l, true)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Only the states somebody may have to act on. Everything the app handles by
              itself is deliberately not described - a chore list of non-chores is what
              made the old card long. */}
          <ul className="lane-help-states">
            <li>
              <b>busy now</b> — a chat is typing in that copy. Nothing to do.
            </li>
            <li>
              <b>done</b> — finished; it merges back with the next update.
            </li>
            <li>
              <b>stuck</b> — two lanes changed the same lines, so someone has to pick. That
              lane waits; everything else still ships.
            </li>
          </ul>
        </div>
        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
