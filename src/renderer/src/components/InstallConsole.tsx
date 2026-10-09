import { useEffect, useRef, useState } from 'react'
import { signInAgent, signInLink, wantsCode } from '@shared/firstRun'

const api = window.api

interface Props {
  /** which install stream to show; '' hides the panel */
  agentId: string
  onDone: (ok: boolean) => void
  /**
   * Kicks the install off from inside this component, right after the listener is
   * attached. Callers that start it themselves before mounting the console lose the
   * first chunks of output, which is the part that says why nothing happened.
   */
  start?: (agentId: string) => void
}

/**
 * Live output of a one-click install. Deliberately a dumb log view rather than a
 * spinner: installers fail for boring reasons (no npm, no python, a proxy) and the
 * only useful thing to show is what the installer actually said.
 *
 * A sign-in row (`setup:signIn`) streams here too. The work then happens in the web
 * browser, so the box also offers the two things that can go wrong there: a browser that
 * never opened (a button to the address the sign-in printed) and Claude's copy-a-code
 * fallback (a box to paste the code into, which is typed into the waiting sign-in).
 */
export default function InstallConsole({ agentId, onDone, start }: Props): JSX.Element | null {
  const [text, setText] = useState('')
  const [running, setRunning] = useState(true)
  const [code, setCode] = useState('')
  const box = useRef<HTMLPreElement>(null)
  // Held in a ref so an inline arrow from the caller cannot re-trigger the effect,
  // which would start the same install a second time.
  const kick = useRef(start)
  kick.current = start
  const finish = useRef(onDone)
  finish.current = onDone

  useEffect(() => {
    setText('')
    setRunning(true)
    const off = api.onInstall((e) => {
      if (e.agentId !== agentId) return
      if (e.chunk) setText((t) => (t + e.chunk).slice(-20_000))
      if (e.done) {
        setRunning(false)
        finish.current(Boolean(e.ok))
      }
    })
    kick.current?.(agentId)
    return off
  }, [agentId])

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text])

  if (!agentId) return null

  const shown = clean(text)
  const signing = signInAgent(agentId)
  const link = signing && running ? signInLink(shown) : ''
  const send = (): void => {
    if (!signing || !code.trim()) return
    void api.signInType(signing, code.trim())
    setCode('')
  }

  return (
    <div className="install-console">
      <div className="ic-head">
        <span className={'ic-dot' + (running ? ' spin' : '')} />
        {!running ? 'Finished' : signing ? 'Signing in... finish in your web browser' : 'Installing...'}
      </div>
      <pre ref={box}>{shown || 'Starting...'}</pre>
      {link && (
        <button className="pill ic-link" onClick={() => api.openExternal(link)}>
          Open the sign-in page
        </button>
      )}
      {signing && running && wantsCode(shown) && (
        <form
          className="ic-code"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the code the sign-in page shows"
            aria-label="Sign-in code"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="pill" type="submit" disabled={!code.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  )
}

/** Installers paint colour and progress bars; the log view wants neither. */
function clean(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}
