import type { SessionStatus } from '@shared/types'

const LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'waiting for you',
  exited: 'exited'
}

interface Props {
  status: SessionStatus
  /** false for a CLI that has only drawn its own prompt and been asked nothing */
  engaged?: boolean
}

export default function StatusDot({ status, engaged = true }: Props): JSX.Element {
  // "Waiting for you" on a pane that has done nothing yet reads as if it finished
  // work you never gave it, so an untouched CLI says "ready" instead.
  const label = status === 'idle' && !engaged ? 'ready - type to start' : LABEL[status]
  return <span className={`dot ${status}` + (status === 'idle' && !engaged ? ' ready' : '')} title={label} />
}
