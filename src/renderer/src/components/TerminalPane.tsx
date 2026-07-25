import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const api = window.api

interface Props {
  sessionId: string
  visible: boolean
  fontSize: number
  /** put a mouse selection straight on the clipboard, the way most terminals do */
  copyOnSelect: boolean
}

// On macOS the clipboard lives on Cmd, which leaves Ctrl+C free to interrupt the agent.
const isMac = navigator.userAgent.includes('Mac')

/**
 * Refit, and stay pinned to the bottom if that is where the view already was. A resize
 * changes how many rows fit while xterm leaves the viewport offset alone, which strands
 * the newest output below the fold until some keypress happens to scroll it back.
 * Someone reading scrollback is left where they are.
 */
function refit(t: Terminal, f: FitAddon): void {
  const buf = t.buffer.active
  const atBottom = buf.viewportY >= buf.baseY
  f.fit()
  if (atBottom) t.scrollToBottom()
}

/**
 * One xterm bound to one pty. Output arrives as a global 'pty:data' event, so each
 * pane filters by id rather than opening a channel per session.
 */
export default function TerminalPane({ sessionId, visible, fontSize, copyOnSelect }: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  // Read inside listeners that are attached once per session, so flipping the
  // setting takes effect without tearing the terminal down.
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
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

    // The last text this pane put on the clipboard from a *remembered* selection. Copying
    // a phantom selection twice would mean Ctrl+C never interrupts, so it happens once.
    const copied = { current: '' }

    const copySelection = (keepHighlight = false): boolean => {
      // A visible highlight always wins: Ctrl+C copies it and drops it, so the very next
      // Ctrl+C is an interrupt again. One extra keypress, never a lost prompt.
      const live = t.getSelection()
      if (live) {
        api.copyText(live)
        if (!keepHighlight) t.clearSelection()
        lastSelection.current = ''
        copied.current = live
        return true
      }
      const sel = lastSelection.current
      if (!sel || sel === copied.current) return false
      api.copyText(sel)
      copied.current = sel
      lastSelection.current = ''
      return true
    }

    const pasteClipboard = (): void => {
      api.readClipboard().then((text) => {
        if (text) {
          t.paste(text)
          return
        }
        // No text usually means an image on the clipboard. Claude Code reads the OS
        // clipboard itself when it sees a raw ^V, so forward the key rather than
        // swallowing it - otherwise pasting screenshots stops working.
        api.write(sessionId, '\x16')
      })
    }

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.altKey) return true
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod) return true
      const key = e.key.toLowerCase()

      if (key === 'c') {
        // Cmd+C and Ctrl+Shift+C are copy-only. A bare Ctrl+C copies when there is
        // a pending selection and otherwise stays the agent's interrupt, so nothing
        // can silently swallow SIGINT.
        const copied = copySelection()
        if (!copied && !e.shiftKey && !isMac) return true
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
      copied.current = ''
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) return
      lastSelection.current = ''
      copied.current = ''
    }
    // Copy on select, the way Windows Terminal and every Linux terminal do it: let go
    // of the mouse and the text is already on the clipboard, so Ctrl+C never has to
    // double as copy. Single stray characters are ignored - those are misclicks.
    const onMouseUp = (): void => {
      if (!copyOnSelectRef.current) return
      const sel = t.getSelection()
      if (sel.trim().length < 2) return
      // Keep the highlight: it is the only feedback that the copy happened, and a
      // following Ctrl+C should still copy rather than interrupt.
      copySelection(true)
    }
    // Right-click: copy when something is selected, paste when nothing is.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (!copySelection()) pasteClipboard()
    }
    const el = host.current
    el.addEventListener('keydown', onKeyClearsSelection, true)
    el.addEventListener('mousedown', onMouseDown, true)
    el.addEventListener('mouseup', onMouseUp)
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
        refit(t, f)
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
      el.removeEventListener('mouseup', onMouseUp)
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
      if (fit.current) refit(t, fit.current)
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
        if (term.current && fit.current) {
          refit(term.current, fit.current)
          api.resize(sessionId, term.current.cols, term.current.rows)
        }
        term.current?.focus()
      } catch {
        /* not laid out yet */
      }
    })
    return () => cancelAnimationFrame(id)
  }, [visible, sessionId])

  return <div className="xterm-host" ref={host} />
}
