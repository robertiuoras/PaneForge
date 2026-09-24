/**
 * "Keap needs you to sign in."
 *
 * A job somewhere hit a password box, a 2FA code or any other wall only a person can get
 * past, and stopped. The card is what says so, and it is written for somebody who has
 * never opened a terminal: a website, where to go, which computer, and who is waiting.
 * It opens nothing - the person signs in themselves, then presses Signed in, which tells
 * the pane that asked to carry on.
 *
 * It lives in `.corner-stack` with every other card the app puts in that corner, so two
 * of them stack rather than drawing on top of each other (see App.tsx's note there).
 */

import { loginCardText, type LoginRequest } from '../../../shared/signIn'

export default function LoginCard({
  reqs,
  onDone,
  onDismiss
}: {
  reqs: LoginRequest[]
  onDone: (id: string) => void
  onDismiss: (id: string) => void
}): React.JSX.Element | null {
  // One card at a time. Two jobs stuck on two sites is a real thing, but two cards is a
  // pile and the second one is still there after the first is dealt with.
  const req = reqs[0]
  if (!req) return null
  const words = loginCardText(req)
  return (
    <div className="login-card" role="status">
      <div className="login-card-title">{words.title}</div>
      {/* Who is stuck, before what is stuck: with four panes and two machines, the pane's
          own name is the only handle a person can act on. */}
      <div className="login-card-who">{words.who}</div>
      <div className="login-card-body">{words.body}</div>
      {words.why && <div className="login-card-why">Once you are in: {words.why}</div>}
      <div className="login-card-row">
        <button className="login-btn primary" onClick={() => onDone(req.id)}>
          {words.done}
        </button>
        <button className="login-btn" onClick={() => onDismiss(req.id)}>
          Not now
        </button>
      </div>
    </div>
  )
}
