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
  // Full-screen TUIs (Claude Code, vim) repaint constantly and xterm drops the
  // selection on the next buffer change, so the highlight vanishes before the user
  // can hit Ctrl+C. Remember the last real selection and copy that instead.
  const lastSelection = useRef('')

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 20000,
      theme: {
        background: '#0c0c10',
        foreground: '#e6e6e6',
        cursor: '#7dd3fc',
        selectionBackground: '#2f5d8a',
        selectionForeground: '#ffffff'
      }
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f

    t.onData((d) => api.write(sessionId, d))

    t.onSelectionChange(() => {
      const s = t.getSelection()
      if (s) lastSelection.current = s
    })

    const copySelection = (): boolean => {
      const sel = t.getSelection() || lastSelection.current
      if (!sel) return false
      api.copyText(sel)
      // One-shot: after a copy, the next bare Ctrl+C must reach the agent as SIGINT.
      lastSelection.current = ''
      t.clearSelection()
      return true
    }

    const pasteClipboard = (): void => {
      api.readClipboard().then((text) => {
        if (text) t.paste(text)
      })
    }

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true
      const key = e.key.toLowerCase()

      if (key === 'c') {
        // Ctrl+Shift+C always copies. Bare Ctrl+C copies only when there is a
        // pending selection, otherwise it stays an interrupt.
        if (!copySelection()) return true
        e.preventDefault()
        return false
      }

      if (key === 'v') {
        // Handled here rather than by Chromium: preventDefault stops the native
        // paste so the text cannot be inserted twice.
        e.preventDefault()
        pasteClipboard()
        return false
      }

      return true
    })

    // Typing invalidates a stale selection, so Ctrl+C goes back to interrupting.
    const onKeyClearsSelection = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      lastSelection.current = ''
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) return
      lastSelection.current = ''
    }
    // Right-click: copy when something is selected, paste when nothing is.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (!copySelection()) pasteClipboard()
    }
    const el = host.current
    el.addEventListener('keydown', onKeyClearsSelection, true)
    el.addEventListener('mousedown', onMouseDown, true)
    el.addEventListener('contextmenu', onContextMenu)

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
      el.removeEventListener('keydown', onKeyClearsSelection, true)
      el.removeEventListener('mousedown', onMouseDown, true)
      el.removeEventListener('contextmenu', onContextMenu)
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
