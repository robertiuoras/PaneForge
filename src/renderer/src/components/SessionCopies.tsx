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
  const copies = [
    { cwd: primary?.dir ?? session.cwd, lane: primary?.lane ?? session.lane, held: primary, primary: true },
    ...other.map(held => ({ cwd: held.dir, lane: held.lane, held, primary: false }))
  ]
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
        (place.kind === 'lane' ? '\nClick to inspect saved commits and uncommitted files.' : '')}
      onClick={event => {
        event.stopPropagation()
        if (place.kind === 'lane') onOpen(copy.cwd)
      }}>
      {label}{mark === ' stuck' || mark === ' done' ? mark : ''}
    </Tag>
  })}</>
}
