import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const api = window.api

interface Props {
  sessionId: string
  visible: boolean
  fontSize: number
}

/**
 * One xterm bound to one pty. Output arrives as a global 'pty:data' event, so each
 * pane filters by id rather than opening a channel per session.
 */
export default function TerminalPane({ sessionId, visible, fontSize }: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 20000,
      theme: { background: '#0c0c10', foreground: '#e6e6e6', cursor: '#7dd3fc' }
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f

    t.onData((d) => api.write(sessionId, d))

    // Replay whatever the pty printed before this pane existed (new pane on an
    // existing session, or a remount).
    api.getBuffer(sessionId).then((b) => {
      if (b) t.write(b)
    })

    const off = api.onData((id, data) => {
      if (id === sessionId) t.write(data)
    })

    // A hidden pane has zero size; fitting it would resize the pty to 1x1 and wrap
    // the agent's output permanently, so resizes only run while the pane is shown.
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return
      try {
        f.fit()
        api.resize(sessionId, t.cols, t.rows)
      } catch {
        /* element detached mid-measure */
      }
    })
    ro.observe(host.current)

    return () => {
      off()
      ro.disconnect()
      t.dispose()
    }
  }, [sessionId])

  // Font size is a live setting: change it and every pane re-lays out immediately.
  useEffect(() => {
    const t = term.current
    if (!t || t.options.fontSize === fontSize) return
    t.options.fontSize = fontSize
    try {
      fit.current?.fit()
      api.resize(sessionId, t.cols, t.rows)
    } catch {
      /* hidden pane - the visibility effect will refit it */
    }
  }, [fontSize, sessionId])

  // Re-fit when this pane becomes visible again: the terminal was not measurable
  // while hidden, so its cols/rows can be stale.
  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        fit.current?.fit()
        if (term.current) api.resize(sessionId, term.current.cols, term.current.rows)
        term.current?.focus()
      } catch {
        /* not laid out yet */
      }
    })
    return () => cancelAnimationFrame(id)
  }, [visible, sessionId])

  return <div className="xterm-host" ref={host} />
}
