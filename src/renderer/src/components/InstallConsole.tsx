import { useEffect, useRef, useState } from 'react'

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
 */
export default function InstallConsole({ agentId, onDone, start }: Props): JSX.Element | null {
  const [text, setText] = useState('')
  const [running, setRunning] = useState(true)
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

  return (
    <div className="install-console">
      <div className="ic-head">
        <span className={'ic-dot' + (running ? ' spin' : '')} />
        {running ? 'Installing...' : 'Finished'}
      </div>
      <pre ref={box}>{clean(text) || 'Starting...'}</pre>
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
