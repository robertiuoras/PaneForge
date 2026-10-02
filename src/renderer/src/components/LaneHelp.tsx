import { useEffect } from 'react'
import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { paneRef } from '@shared/place'
import { holderName, laneChipLabel, laneProject, laneState } from '../laneWords'

/**
 * Why this project has more than one folder, for somebody who has never used git.
 *
 * It was five paragraphs of theory, then one sentence of theory plus the board. Both
 * versions had the same defect and it took a fresh reader to see it: the card was written
 * FOR somebody who had already met a copy and wanted the system explained. The person who
 * opens this has met a folder they did not create. So the top of the card is three
 * sentences about that folder - what it is, where it is, and that finished work comes back
 * on its own - and every row underneath carries its own PATH, because "which folder is
 * this row about" is the question a name cannot answer.
 *
 * The word "lane" is gone from the screen entirely (it is scripts/lane.mjs's word for a
 * slot in a pool, and `npm run test:laneplain` is what keeps it out); so are worktrees,
 * branches, merges and the release cooldown, none of which are things to do.
 */
interface Props {
  onClose: () => void
  /** the copies of every open project, one board each, when the window has polled them */
  boards: LaneBoard[]
  /** to name a copy by the pane working in it - "pane 3" is a key you can press */
  sessions: Session[]
}

/** Copies worth a row: somebody is in it, or it is waiting on a person. */
function shown(lanes: LaneBoardEntry[]): LaneBoardEntry[] {
  return lanes.filter((l) => l.held || l.ready || l.conflicted)
}

export default function LaneHelp({ onClose, boards, sessions }: Props): JSX.Element {
  const rows = shown(boards.flatMap((b) => b.lanes))
  // One project name in the heading only when every row is that project; a mixed list's
  // rows each name their own (laneChipLabel with no project drops nothing).
  const projects = new Set(rows.map((l) => laneProject(l)))
  const project = projects.size === 1 ? (rows.length ? laneProject(rows[0]) : '') : ''
  // Escape closes it, like every other dialog. This card opens on top of LaneDialog, whose
  // own handler stands down while `.lane-help` is on screen, so one press peels one layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const paneOf = (l: LaneBoardEntry): number | undefined => {
    const i = sessions.findIndex((s) => s.id === l.ownerPane)
    return i >= 0 ? i + 1 : undefined
  }

  return (
    <div className="overlay confirm-overlay" onMouseDown={onClose}>
      <div className="dialog confirm lane-help" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Copies of a project</strong>
        </div>
        <div className="confirm-body">
          {/* Three sentences, and the third is the one that stops somebody tidying up:
              a folder they did not make is a folder they will try to delete. */}
          <p>
            Two chats cannot edit one folder without overwriting each other, so the second
            chat to open a project works in its own copy of the folder, beside the original.
            You never make one and you never have to merge one - finished work comes back
            into the main copy by itself. Leave the copies where they are; the app reuses
            them.
          </p>

          {rows.length > 0 && (
            <>
              <div className="lane-help-when">
                {project ? `${project} right now` : 'Right now'}: {rows.length} cop
                {rows.length === 1 ? 'y' : 'ies'} in use
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
                    {/* The folder itself. A row named "copy 2" is a row somebody cannot
                        find on disk, and finding it is the whole reason this card is
                        opened the first time. */}
                    <span className="lane-help-where">{l.dir}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Only the states somebody may have to act on, plus the one that looks like a
              problem and is not. Everything the app handles by itself is left out. */}
          <ul className="lane-help-states">
            <li>
              <b>busy now</b>: a chat is typing in that copy. Nothing to do.
            </li>
            <li>
              <b>nobody has typed here for a while</b>: that chat may have finished. Once
              there is nothing left in the copy, the next chat is given it.
            </li>
            <li>
              <b>done</b>: finished; it comes back into the main copy with the next update.
            </li>
            <li>
              <b>stuck</b>: two copies changed the same lines, so someone has to pick. That
              copy waits; everything else still goes back.
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
