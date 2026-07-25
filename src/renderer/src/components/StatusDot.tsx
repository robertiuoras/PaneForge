import type { SessionStatus } from '@shared/types'

const LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'waiting for you',
  exited: 'exited'
}

export default function StatusDot({ status }: { status: SessionStatus }): JSX.Element {
  return <span className={`dot ${status}`} title={LABEL[status]} />
}
