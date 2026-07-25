import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Config, Preset, Project, Session, StartSessionRequest } from '@shared/types'
import TerminalPane from './components/TerminalPane'
import NewSessionDialog from './components/NewSessionDialog'
import SettingsDialog from './components/SettingsDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import StatusDot from './components/StatusDot'

const api = window.api

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [config, setConfigState] = useState<Config | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [settings, setSettings] = useState(false)
  const [help, setHelp] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const broadcastBox = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listSessions().then(setSessions)
    api.getConfig().then(setConfigState)
    const offS = api.onSessions(setSessions)
    const offC = api.onConfig(setConfigState)
    return () => {
      offS()
      offC()
    }
  }, [])

  // The project list is derived from the root folder, so refresh it whenever the
  // root changes (and once at startup).
  useEffect(() => {
    api.listProjects().then(setProjects)
  }, [config?.root])

  // Keep a sane selection as sessions come and go.
  useEffect(() => {
    if (sessions.length === 0) setActiveId(null)
    else if (!sessions.some((s) => s.id === activeId)) setActiveId(sessions[0].id)
  }, [sessions, activeId])

  // Looking at a pane counts as acknowledging it.
  useEffect(() => {
    if (activeId) api.clearAttention(activeId)
  }, [activeId, sessions])

  const patchConfig = useCallback((patch: Partial<Config>) => {
    // Apply locally first so sliders and checkboxes feel instant; main echoes back.
    setConfigState((c) => (c ? { ...c, ...patch } : c))
    api.setConfig(patch)
  }, [])

  const flash = useCallback((msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote(null), 4000)
  }, [])

  const start = useCallback(async (reqs: StartSessionRequest[]) => {
    setPicking(false)
    const started = await api.startSessions(reqs)
    if (started.length) setActiveId(started[started.length - 1].id)
    if (started.length < reqs.length) flash('Some folders could not be opened.')
  }, [flash])

  const launchPreset = useCallback(
    (p: Preset) => {
      start(p.items.map((i) => ({ cwd: i.path, title: i.title, agent: i.agent, resume: i.resume })))
    },
    [start]
  )

  const saveWorkspace = useCallback(
    (name: string, reqs: StartSessionRequest[]) => {
      if (!config) return
      const preset: Preset = {
        id: `w${Date.now().toString(36)}`,
        name,
        items: reqs.map((r) => ({
          path: r.cwd,
          title: r.title ?? r.cwd,
          agent: r.agent ?? config.defaultAgent,
          resume: r.resume
        }))
      }
      patchConfig({ presets: [...config.presets, preset] })
      flash(`Workspace "${name}" saved.`)
    },
    [config, patchConfig, flash]
  )

  const saveRunningAsWorkspace = useCallback(() => {
    if (!config || sessions.length === 0) return
    const name = window.prompt('Workspace name', sessions.map((s) => s.title).join(' + ').slice(0, 40))
    if (!name?.trim()) return
    saveWorkspace(
      name.trim(),
      sessions.map((s) => ({ cwd: s.cwd, title: s.title, agent: s.agent }))
    )
  }, [config, sessions, saveWorkspace])

  const close = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) return
      if (config?.confirmClose && s.status !== 'exited' && !window.confirm(`Close "${s.title}"?`)) return
      api.killSession(id)
    },
    [sessions, config]
  )

  const grid = config?.grid ?? false

  // Ctrl-based shortcuts are captured on the window: xterm would otherwise swallow
  // them as terminal input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')
      if (e.key === 'Escape') {
        setPicking(false)
        setSettings(false)
        setHelp(false)
        setRenaming(null)
        return
      }
      if (e.key === 'F1') {
        e.preventDefault()
        setHelp((h) => !h)
        return
      }
      if (!e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()

      if (k === 't') {
        e.preventDefault()
        setPicking(true)
      } else if (k === 'w' && activeId && !typing) {
        e.preventDefault()
        close(activeId)
      } else if (k === 'r' && e.shiftKey && activeId) {
        e.preventDefault()
        api.restartSession(activeId)
      } else if (k === 'g') {
        e.preventDefault()
        patchConfig({ grid: !grid })
      } else if (k === 'b') {
        e.preventDefault()
        broadcastBox.current?.focus()
      } else if (k === ',') {
        e.preventDefault()
        setSettings(true)
      } else if ((k === '+' || k === '=' || k === '-') && config) {
        e.preventDefault()
        const delta = k === '-' ? -1 : 1
        patchConfig({ fontSize: Math.min(22, Math.max(9, config.fontSize + delta)) })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        if (sessions.length < 2) return
        const i = sessions.findIndex((s) => s.id === activeId)
        const next = (i + (e.shiftKey ? -1 : 1) + sessions.length) % sessions.length
        setActiveId(sessions[next].id)
      } else if (/^[1-9]$/.test(k)) {
        const target = sessions[Number(k) - 1]
        if (target) {
          e.preventDefault()
          setActiveId(target.id)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeId, sessions, grid, config, close, patchConfig])

  const visibleIds = useMemo(
    () => new Set(grid ? sessions.map((s) => s.id) : sessions.filter((s) => s.id === activeId).map((s) => s.id)),
    [grid, sessions, activeId]
  )
  // Near-square layout, same rule the old .bat grid used, but for whatever N is open.
  const cols = grid ? Math.max(1, Math.ceil(Math.sqrt(sessions.length))) : 1
  const waiting = sessions.filter((s) => s.attention).length

  const sendBroadcast = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return
    const text = e.currentTarget.value.trim()
    if (!text) return
    api.broadcast(text)
    e.currentTarget.value = ''
    flash(`Sent to ${sessions.filter((s) => s.status !== 'exited').length} sessions.`)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span>PaneForge</span>
          <span className="icons">
            <button className="icon" title="Settings (Ctrl ,)" onClick={() => setSettings(true)}>
              ⚙
            </button>
            <button className="icon" title="Keyboard (F1)" onClick={() => setHelp(true)}>
              ?
            </button>
          </span>
        </div>

        <button className="primary" onClick={() => setPicking(true)}>
          + New session <span className="kbd">Ctrl T</span>
        </button>

        {config && config.presets.length > 0 && (
          <>
            <div className="section">Workspaces</div>
            <div className="presets">
              {config.presets.map((p) => (
                <div key={p.id} className="row preset" onClick={() => launchPreset(p)}>
                  <div className="row-text">
                    <div className="row-title">{p.name}</div>
                    <div className="row-sub">{p.items.length} projects</div>
                  </div>
                  <button
                    className="x"
                    title="Delete workspace"
                    onClick={(e) => {
                      e.stopPropagation()
                      patchConfig({ presets: config.presets.filter((x) => x.id !== p.id) })
                    }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section">
          Running ({sessions.length}){waiting > 0 && <span className="badge">{waiting} waiting</span>}
        </div>
        <div className="list">
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={'row' + (s.id === activeId ? ' active' : '') + (s.attention ? ' attn' : '')}
              onClick={() => setActiveId(s.id)}
              onDoubleClick={() => setRenaming(s.id)}
            >
              <StatusDot status={s.status} />
              <div className="row-text">
                {renaming === s.id ? (
                  <input
                    className="rename"
                    autoFocus
                    defaultValue={s.title}
                    onBlur={(e) => {
                      api.renameSession(s.id, e.target.value)
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="row-title">
                    {i < 9 && <span className="num">{i + 1}</span>}
                    {s.title}
                  </div>
                )}
                <div className="row-sub">
                  {s.agent}
                  {s.status === 'exited' ? ` - exited ${s.exitCode ?? ''}` : ''}
                </div>
              </div>
              {s.status === 'exited' && (
                <button
                  className="x"
                  title="Restart"
                  onClick={(e) => {
                    e.stopPropagation()
                    api.restartSession(s.id)
                  }}
                >
                  ⟳
                </button>
              )}
              <button
                className="x"
                title="Close session (Ctrl W)"
                onClick={(e) => {
                  e.stopPropagation()
                  close(s.id)
                }}
              >
                x
              </button>
            </div>
          ))}
          {sessions.length === 0 && <div className="empty">No sessions. Ctrl T to start one.</div>}
        </div>

        <input
          ref={broadcastBox}
          className="search broadcast"
          placeholder="Send a line to every session (Ctrl B)"
          onKeyDown={sendBroadcast}
        />

        <div className="foot">
          <label className="grid-toggle">
            <input type="checkbox" checked={grid} onChange={(e) => patchConfig({ grid: e.target.checked })} />
            Grid view
          </label>
          <button className="ghost small" onClick={saveRunningAsWorkspace} disabled={!sessions.length}>
            Save as workspace
          </button>
        </div>
      </aside>

      <main
        className={'panes' + (grid ? ' grid' : '')}
        style={grid ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : undefined}
      >
        {sessions.map((s) => (
          // Every pane stays mounted so its scrollback survives tab switches;
          // unmounting the xterm instance would blank the session.
          <div
            key={s.id}
            className={
              'pane' + (visibleIds.has(s.id) ? '' : ' hidden') + (grid && s.id === activeId ? ' focused' : '')
            }
            onMouseDown={() => setActiveId(s.id)}
          >
            <div className="pane-title">
              <StatusDot status={s.status} />
              <span className="pt-name" onDoubleClick={() => setRenaming(s.id)}>
                {s.title}
              </span>
              <span className="pt-path">{s.cwd}</span>
              <span className="pt-actions">
                <button className="icon" title="Restart agent (Ctrl Shift R)" onClick={() => api.restartSession(s.id)}>
                  ⟳
                </button>
                <button className="icon" title="Open folder" onClick={() => api.reveal(s.cwd)}>
                  ▤
                </button>
                <button
                  className="icon"
                  title="Open in editor"
                  onClick={() => api.openInEditor(s.cwd).then((err) => err && flash(err))}
                >
                  ✎
                </button>
                <button className="icon" title="Close (Ctrl W)" onClick={() => close(s.id)}>
                  x
                </button>
              </span>
            </div>
            <TerminalPane
              sessionId={s.id}
              visible={visibleIds.has(s.id)}
              fontSize={config?.fontSize ?? 13}
            />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="placeholder">
            <h1>PaneForge</h1>
            <p>Start only the sessions you need. Ctrl T, tick a few projects, Enter.</p>
            <p className="hint">F1 for every shortcut.</p>
          </div>
        )}
      </main>

      {note && <div className="toast">{note}</div>}

      {picking && config && (
        <NewSessionDialog
          projects={projects}
          defaultAgent={config.defaultAgent}
          onCancel={() => setPicking(false)}
          onStart={start}
          onSaveWorkspace={(name, reqs) => {
            saveWorkspace(name, reqs)
            setPicking(false)
          }}
        />
      )}
      {settings && config && (
        <SettingsDialog config={config} onChange={patchConfig} onClose={() => setSettings(false)} />
      )}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </div>
  )
}
