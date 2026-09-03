/**
 * "Facebook needs you to sign in on the PC."
 *
 * A job somewhere hit a password box and stopped. The card is the only thing that says
 * so, and it is written for somebody who has never opened a terminal: a website, a
 * computer, and a button. No address, no port, no machine name.
 *
 * It lives in `.corner-stack` with every other card the app puts in that corner, so two
 * of them stack rather than drawing on top of each other (see App.tsx's note there).
 */

import { loginCardText, type LoginRequest } from '../../../shared/remoteLogin'

export default function LoginCard({
  reqs,
  onOpen,
  onDismiss
}: {
  reqs: LoginRequest[]
  onOpen: (id: string) => void
  onDismiss: (id: string) => void
}): React.JSX.Element | null {
  // One card at a time. Two jobs stuck on two sites is a real thing, but two cards is a
  // pile and the second one is still there after the first is dealt with.
  const req = reqs.find((r) => r.state === 'waiting' || r.state === 'failed')
  if (!req) return null
  const words = loginCardText(req)
  return (
    <div className="login-card" role="status">
      <div className="login-card-title">{words.title}</div>
      <div className="login-card-body">
        {req.state === 'failed'
          ? `PaneForge could not reach the browser on ${req.machine}. ${req.error ?? ''}`
          : words.body}
      </div>
      <div className="login-card-row">
        <button className="login-btn primary" onClick={() => onOpen(req.id)}>
          {req.state === 'failed' ? 'Try again' : words.open}
        </button>
        <button className="login-btn" onClick={() => onDismiss(req.id)}>
          Not now
        </button>
      </div>
    </div>
  )
}
