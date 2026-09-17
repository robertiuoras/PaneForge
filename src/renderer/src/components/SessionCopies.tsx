import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { describePlace } from '@shared/place'
import { laneBusy, samePath } from '../laneWords'

/** Show the assigned work folder once per project, keeping the launch folder in its tooltip. */
export default function SessionCopies({ session, boards, onOpen }: {
  session: Session
  boards: LaneBoard[]
  onOpen: (cwd: string) => void
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
  const opened = describePlace({ cwd: session.cwd, lane: session.lane })
  // ONE chip per card, whatever else this chat happens to be holding.
  //
  // A chat that has visited three other projects holds a work folder in each, and each
  // used to get its own chip. Four chips wrap the card onto extra rows, and a sidebar of
  // those fits three cards on a 16-inch screen (Robert, 2026-09-17: "theres too many
  // other copies 4 ... i can barely see even 3 sessions cards on the left"). The other
  // holds are still worth knowing about, so they move into this chip's tooltip, where
  // they cost no height. Releasing them is the lane board's job, not a card's.
  const copies = [
    { cwd: primary?.dir ?? session.cwd, lane: primary?.lane ?? session.lane, held: primary, primary: true }
  ]
  const elsewhere = other
    .map(held => describePlace({ cwd: held.dir, lane: held.lane }).short)
    .join('\n')
  return <>{copies.map(copy => {
    const place = describePlace({ cwd: copy.cwd, lane: copy.lane })
    const mark = copy.held?.conflicted ? ' stuck' : copy.held?.ready ? ' done' : copy.held && laneBusy(copy.held) ? ' busy' : ''
    const moved = copy.primary && !samePath(copy.cwd, session.cwd)
    const label = copy.primary && session.title.includes(place.project) ? place.role : place.short
    const Tag = place.kind === 'lane' ? 'button' : 'span'
    return <Tag key={copy.cwd}
      className={'chip place' + (place.kind === 'lane' ? ' lane-chip' : '') + mark}
      title={`${copy.held ? 'Assigned work folder: ' : ''}${place.full}\n${copy.cwd}` +
        (moved ? `\nSession opened in ${opened.role}: ${session.cwd}. Its assigned work folder is shown here.` : '') +
        '\nCopy numbers identify folders, not the number of open sessions.' +
        (copy.primary && elsewhere ? `\n\nThis chat is also holding a work folder in:\n${elsewhere}` : '') +
        (place.kind === 'lane' ? '\nClick to inspect saved commits and uncommitted files.' : '')}
      onClick={event => {
        event.stopPropagation()
        if (place.kind === 'lane') onOpen(copy.cwd)
      }}>
      {label}{mark === ' stuck' || mark === ' done' ? mark : ''}
    </Tag>
  })}</>
}
