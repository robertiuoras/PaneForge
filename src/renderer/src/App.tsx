import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project, Session } from '@shared/types'
import TerminalPane from './components/TerminalPane'
import NewSessionDialog from './components/NewSessionDialog'
import StatusDot from './components/StatusDot'

const api = window.api

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [grid, setGrid] = useState(false)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    api.listSessions().then(setSessions)
    api.listProjects().then(setProjects)
    return api.onSessions(setSessions)
  }, [])

  // Keep a sane selection as sessions come and go.
  useEffect(() => {
    if (sessions.length === 0) setActiveId(null)
    else if (!sessions.some((s) => s.id === activeId)) setActiveId(sessions[0].id)
  }, [sessions, activeId])

  const start = useCallback(
    async (req: Parameters<typeof api.startSession>[0]) => {
      const s = await api.startSession(req)
      setActiveId(s.id)
      setPicking(false)
    },
    []
  )

  // Ctrl+T opens the picker, Ctrl+W closes the focused session: the two things you
  // otherwise reach for the mouse for. Terminal keystrokes go to the pty, so these
  // are captured on the window before xterm sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setPicking(true)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'w' && activeId) {
        e.preventDefault()
        api.killSession(activeId)
      } else if (e.key === 'Escape') {
        setPicking(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeId])

  const visible = useMemo(
    () => (grid ? sessions.slice(0, 4) : sessions.filter((s) => s.id === activeId)),
    [grid, sessions, activeId]
  )
  const visibleIds = new Set(visible.map((s) => s.id))

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">PaneForge</div>
        <button className="primary" onClick={() => setPicking(true)}>
          + New session <span className="kbd">Ctrl T</span>
        </button>

        <div className="section">Running ({sessions.length})</div>
        <div className="list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={'row' + (s.id === activeId ? ' active' : '')}
              onClick={() => {
                setActiveId(s.id)
                setGrid(false)
              }}
            >
              <StatusDot status={s.status} />
              <div className="row-text">
                <div className="row-title">{s.title}</div>
                <div className="row-sub">
                  {s.agent}
                  {s.status === 'exited' ? ` - exited ${s.exitCode ?? ''}` : ''}
                </div>
              </div>
              <button
                className="x"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation()
                  api.killSession(s.id)
                }}
              >
                x
              </button>
            </div>
          ))}
          {sessions.length === 0 && <div className="empty">No sessions. Ctrl T to start one.</div>}
        </div>

        <label className="grid-toggle">
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />
          Grid view (first 4)
        </label>
      </aside>

      <main className={'panes' + (grid ? ' grid' : '')}>
        {sessions.map((s) => (
          // Every pane stays mounted so its scrollback survives tab switches;
          // unmounting the xterm instance would blank the session.
          <div key={s.id} className={'pane' + (visibleIds.has(s.id) ? '' : ' hidden')}>
            {grid && <div className="pane-title">{s.title}</div>}
            <TerminalPane sessionId={s.id} visible={visibleIds.has(s.id)} />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="placeholder">
            <h1>PaneForge</h1>
            <p>Start only the sessions you need. Ctrl T.</p>
          </div>
        )}
      </main>

      {picking && (
        <NewSessionDialog
          projects={projects}
          onCancel={() => setPicking(false)}
          onStart={start}
        />
      )}
    </div>
  )
}
