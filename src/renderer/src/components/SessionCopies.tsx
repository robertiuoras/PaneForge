import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { describePlace } from '@shared/place'
import { laneBusy } from '../laneWords'

/**
 * The card's place line: the PROJECT, always, then which copy of it this chat works in.
 *
 * Robert, 2026-09-23: "how do i know what lane im on? and even worse what happens if
 * session renamed then i dont know what project im in?" The card's name is whatever the
 * pane was called or renamed to (`shared/clientName.ts` renames it after the topic), so the
 * project cannot ride on the name. It has its own line, drawn from the folder the chat
 * actually holds on the lane board - the hook moves a chat into `PaneForge-c` while the
 * pane was opened in `PaneForge`, and the folder the pane opened in would name the wrong
 * copy. Plain text, not a button: the copy dialog it used to open is gone.
 */
export default function SessionCopies({ session, boards }: {
  session: Session
  boards: LaneBoard[]
}): JSX.Element {
  const within = (path: string, root: string): boolean => {
    const clean = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const p = clean(path), r = clean(root)
    return p === r || p.startsWith(r + '/')
  }
  let primary: LaneBoardEntry | undefined
  const other: LaneBoardEntry[] = []
  for (const board of boards) {
    const held = board.lanes.find(lane => lane.ownerPane === session.id && !lane.peer)
    if (!held) continue
    if (within(session.cwd, board.repo) ||
        board.lanes.some(lane => !lane.peer && within(session.cwd, lane.dir)) ||
        (session.lane && session.lane !== 'main' && within(session.cwd, `${board.repo}-${session.lane}`))) {
      primary = held
    } else other.push(held)
  }
  const cwd = primary?.dir ?? session.cwd
  const lane = primary?.lane ?? session.lane
  const place = describePlace({ cwd, lane })
  // "main copy" only when copies exist to tell it apart from; one folder is just the project.
  const hasCopies = place.kind === 'lane' || lane === 'main' ||
    boards.some(b => within(cwd, b.repo) && b.lanes.some(l => !l.peer && l.lane !== 'main'))
  const role = place.kind === 'lane' || hasCopies ? place.role : ''
  const mark = primary?.conflicted ? ' stuck' : primary?.ready ? ' done' : primary && laneBusy(primary) ? ' busy' : ''
  const state = mark === ' stuck' ? '\nStuck: its changes clash with the main copy.'
    : mark === ' done' ? '\nFinished: waiting to be merged into the main copy.'
    : mark === ' busy' ? '\nBeing worked on.' : ''
  const elsewhere = other.map(held => describePlace({ cwd: held.dir, lane: held.lane }).short).join('\n')
  const opened = describePlace({ cwd: session.cwd, lane: session.lane })
  return (
    <span
      className={'row-lane' + mark}
      title={`${place.full}${state}\n${cwd}` +
        (primary && !within(session.cwd, cwd) ? `\nSession opened in ${opened.short}: ${session.cwd}.` : '') +
        (role && place.kind === 'lane' ? '\nCopy numbers name folders, not how many sessions are open.' : '') +
        (elsewhere ? `\n\nThis chat is also holding a work folder in:\n${elsewhere}` : '')}
    >
      {mark ? <i className="lane-dot" aria-hidden="true" /> : null}
      <span className="row-project">{place.project}</span>
      {role ? <span className="row-copy">{role}</span> : null}
    </span>
  )
}
