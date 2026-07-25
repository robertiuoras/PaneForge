import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import type { Config, HistoryEntry, Preset, Project, Session, StartSessionRequest, SwarmRole } from '@shared/types'
import AgentPicker from './components/AgentPicker'
import AgentLogo, { AppLogo } from './components/AgentLogo'
import BoardDialog from './components/BoardDialog'
import CommandPalette, { type Command } from './components/CommandPalette'
import ConfirmDialog from './components/ConfirmDialog'
import { Segmented } from './components/Controls'
import Elapsed, { formatElapsed } from './components/Elapsed'
import GitBadge from './components/GitBadge'
import HistoryDialog from './components/HistoryDialog'
import TerminalPane, { paneRepair } from './components/TerminalPane'
import NewSessionDialog from './components/NewSessionDialog'
import SettingsDialog from './components/SettingsDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import StatusDot from './components/StatusDot'
import SwarmDialog from './components/SwarmDialog'
import UpdateToast from './components/UpdateToast'
import VersionBadge from './components/VersionBadge'
import { playChime } from './useChime'
import { useVoice } from './useVoice'

const api = window.api

/** A pending question for the in-app confirm/prompt dialog. */
interface AskState {
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
  input?: { placeholder?: string; defaultValue?: string }
  onConfirm: (value: string) => void
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [config, setConfigState] = useState<Config | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [settings, setSettings] = useState(false)
  const [help, setHelp] = useState(false)
  const [palette, setPalette] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [swarm, setSwarm] = useState(false)
  const [board, setBoard] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  // One in-app dialog stands in for window.confirm and window.prompt. Both of those
  // draw Chromium's system box, which looks nothing like the app and blocks the
  // renderer while it is open.
  const [ask, setAsk] = useState<AskState | null>(null)
  const broadcastBox = useRef<HTMLInputElement>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

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

  // Re-probed whenever the custom list changes, and on every open of the picker, so
  // a CLI installed while the app was running shows up without a restart.
  useEffect(() => {
    api.listAgents().then(setAgents)
  }, [config?.customAgents, picking, settings])

  // Keep a sane selection as sessions come and go.
  useEffect(() => {
    if (sessions.length === 0) setActiveId(null)
    else if (!sessions.some((s) => s.id === activeId)) setActiveId(sessions[0].id)
  }, [sessions, activeId])

  // Looking at a pane counts as acknowledging it.
  useEffect(() => {
    if (activeId) api.clearAttention(activeId)
  }, [activeId, sessions])

  // The chime is the one alert that fires even while the app has focus: a turn
  // ending in a pane you are not currently reading is exactly what the taskbar
  // flash cannot tell you. Read through a ref so toggling the setting does not
  // resubscribe (and so the listener is attached exactly once).
  const soundOn = useRef(true)
  soundOn.current = config?.soundOnIdle ?? true
  // The pane already on screen is acknowledged the moment it raises its hand
  // (the effect above clears it), so chiming for it is noise about something you
  // are already watching.
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  useEffect(
    () =>
      api.onAttention((s) => {
        if (soundOn.current && s.id !== activeIdRef.current) playChime()
      }),
    []
  )

  const patchConfig = useCallback((patch: Partial<Config>) => {
    // Apply locally first so sliders and checkboxes feel instant; main echoes back.
    setConfigState((c) => (c ? { ...c, ...patch } : c))
    api.setConfig(patch)
  }, [])

  /** Last model chosen for an agent becomes that agent's default next time. */
  const rememberModel = useCallback(
    (agent?: string, model?: string) => {
      if (!agent || !config) return
      if ((config.defaultModels[agent] ?? '') === (model ?? '')) return
      patchConfig({ defaultModels: { ...config.defaultModels, [agent]: model ?? '' } })
    },
    [config, patchConfig]
  )

  const flash = useCallback((msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote(null), 4000)
  }, [])

  /**
   * Dictation types straight into the focused pane, exactly as if you had typed
   * it, and stops short of pressing Enter: a misheard word should be fixable
   * before the agent acts on it.
   */
  const voice = useVoice(
    useCallback(
      (text: string) => {
        const id = activeRef.current
        if (!id) return flash('Nothing focused - open a pane first.')
        api.write(id, text)
      },
      [flash]
    )
  )

  useEffect(() => {
    if (voice.error) flash(voice.error)
  }, [voice.error, flash])

  const start = useCallback(
    async (reqs: StartSessionRequest[]) => {
      setPicking(false)
      const started = await api.startSessions(reqs)
      if (started.length) setActiveId(started[started.length - 1].id)
      if (started.length < reqs.length) flash('Some folders could not be opened.')
      // A launch that quietly moved folder has to say so once - the pane header and
      // the sidebar chip show where it landed, but only if you go looking.
      const noted = started.filter((s) => s.laneNote)
      if (noted.length === 1) {
        const s = noted[0]
        flash(s.lane ? `${s.cwd.split(/[\\/]/).pop()} - ${s.laneNote}` : (s.laneNote as string))
      } else if (noted.length > 1) {
        flash(`${noted.length} sessions moved into their own worktree lanes.`)
      }
      rememberModel(reqs[0]?.agent, reqs[0]?.model)
    },
    [flash, rememberModel]
  )

  const launchPreset = useCallback(
    (p: Preset) => {
      start(
        p.items.map((i) => ({
          cwd: i.path,
          title: i.title,
          agent: i.agent,
          model: i.model,
          resume: i.resume
        }))
      )
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
          model: r.model,
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
    setAsk({
      title: 'Save these sessions as a workspace',
      body: `${sessions.length} panes, reopened together next time you launch it.`,
      confirmLabel: 'Save',
      input: {
        placeholder: 'Workspace name',
        defaultValue: sessions.map((s) => s.title).join(' + ').slice(0, 40)
      },
      onConfirm: (name) => {
        setAsk(null)
        saveWorkspace(
          name,
          sessions.map((s) => ({ cwd: s.cwd, title: s.title, agent: s.agent, model: s.model }))
        )
      }
    })
  }, [config, sessions, saveWorkspace])

  /**
   * Swapping a live pane to another CLI kills the running agent, so it asks first
   * unless the pane already exited. The new model is remembered for that agent.
   */
  const switchAgent = useCallback(
    (s: Session, agent: string, model: string) => {
      if (s.agent === agent && (s.model ?? '') === model) return
      const label = agents.find((a) => a.id === agent)?.label ?? agent
      const go = (): void => {
        api.switchAgent(s.id, agent, model || undefined)
        rememberModel(agent, model)
        flash(`${s.title} → ${label}${model ? ` · ${model}` : ''}`)
      }
      if (s.status === 'exited') return go()
      setAsk({
        title: `Switch ${s.title} to ${label}${model ? ` (${model})` : ''}?`,
        body: 'The run in this pane ends and the new CLI starts in the same folder.',
        confirmLabel: 'Switch',
        danger: true,
        onConfirm: () => {
          setAsk(null)
          go()
        }
      })
    },
    [agents, flash, rememberModel]
  )

  const close = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) return
      if (!config?.confirmClose || s.status === 'exited') return api.killSession(id)
      setAsk({
        title: `Close ${s.title}?`,
        body: `${s.agent} is still running in ${s.cwd}. Closing ends it - the conversation stays in history.`,
        confirmLabel: 'Close session',
        danger: true,
        onConfirm: () => {
          setAsk(null)
          api.killSession(id)
        }
      })
    },
    [sessions, config]
  )

  /**
   * Put a pane's drawing back together without losing the run: refit, make the agent
   * repaint its whole frame, and land on the newest line. The pane does the work; this
   * only says which one.
   */
  const fixUi = useCallback(
    (id?: string | null) => {
      const target = id ?? activeRef.current
      if (!target) return flash('Nothing focused - open a pane first.')
      const repair = paneRepair.get(target)
      if (!repair) return flash('That pane is not ready yet.')
      repair()
      flash('Display repaired.')
    },
    [flash]
  )

  const grid = config?.grid ?? false

  // Ctrl-based shortcuts are captured on the window: xterm would otherwise swallow
  // them as terminal input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')
      if (e.key === 'Escape') {
        // An open dropdown owns Escape: closing the dialog under it would be a
        // surprise. Same for the palette, which is always the topmost layer.
        if (document.querySelector('.select-menu')) return
        // A question sits on top of whatever asked it, so Escape answers that first
        // and leaves the dialog underneath alone.
        if (ask) {
          setAsk(null)
          return
        }
        if (palette) {
          setPalette(false)
          return
        }
        setPicking(false)
        setSettings(false)
        setHelp(false)
        setSwarm(false)
        setBoard(null)
        setHistory(false)
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
      } else if ((k === 'k' && !e.shiftKey) || (k === 'p' && e.shiftKey)) {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (k === 's' && e.shiftKey) {
        e.preventDefault()
        setSwarm(true)
      } else if (k === 'k' && e.shiftKey) {
        e.preventDefault()
        const s = sessions.find((x) => x.id === activeId)
        if (s) setBoard(s.cwd)
        else flash('Open a pane first - the board belongs to its folder.')
      } else if (k === 'h' && !typing) {
        e.preventDefault()
        setHistory(true)
      } else if (k === 'w' && activeId && !typing) {
        e.preventDefault()
        close(activeId)
      } else if (k === 'l' && e.shiftKey) {
        e.preventDefault()
        fixUi(activeId)
      } else if (k === 'r' && e.shiftKey && activeId) {
        e.preventDefault()
        api.restartSession(activeId)
      } else if (k === 'a' && e.shiftKey && activeId) {
        // Cycle the focused pane through the CLIs that are actually installed.
        e.preventDefault()
        const s = sessions.find((x) => x.id === activeId)
        const usable = agents.filter((a) => a.available)
        if (!s || usable.length < 2) return
        const next = usable[(usable.findIndex((a) => a.id === s.agent) + 1) % usable.length]
        switchAgent(s, next.id, config?.defaultModels[next.id] ?? '')
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
  }, [activeId, sessions, grid, config, close, patchConfig, agents, switchAgent, palette, flash, ask, fixUi])

  /**
   * Everything the app can do, as one searchable list. The sidebar only scales to a
   * handful of sessions and the project list lives behind a dialog, so this is the
   * fast path once more than a couple of things are open.
   */
  const commands = useMemo<Command[]>(() => {
    const active = sessions.find((s) => s.id === activeId)
    const logo = (id: string): JSX.Element => (
      <AgentLogo id={id} spec={agents.find((a) => a.id === id)} size={15} />
    )
    const out: Command[] = []

    for (const s of sessions)
      out.push({
        id: `focus:${s.id}`,
        group: 'Open sessions',
        title: s.title,
        hint: s.cwd,
        icon: logo(s.agent),
        run: () => setActiveId(s.id)
      })

    for (const p of config?.presets ?? [])
      out.push({
        id: `preset:${p.id}`,
        group: 'Workspaces',
        title: `Launch ${p.name}`,
        hint: `${p.items.length} projects`,
        run: () => launchPreset(p)
      })

    const dflt = config?.defaultAgent ?? 'claude'
    for (const p of projects.slice(0, 40))
      out.push({
        id: `start:${p.path}`,
        group: 'Start a project',
        title: p.name,
        hint: p.path,
        icon: logo(dflt),
        run: () =>
          start([
            { cwd: p.path, title: p.name, agent: dflt, model: config?.defaultModels[dflt] || undefined }
          ])
      })

    if (active)
      for (const a of agents.filter((x) => x.available && x.id !== active.agent))
        out.push({
          id: `swap:${a.id}`,
          group: 'This pane',
          title: `Run ${a.label} here`,
          hint: active.title,
          icon: logo(a.id),
          run: () => switchAgent(active, a.id, config?.defaultModels[a.id] ?? '')
        })

    out.push(
      { id: 'new', group: 'Actions', title: 'New session', keys: 'Ctrl T', run: () => setPicking(true) },
      {
        id: 'grid',
        group: 'Actions',
        title: grid ? 'Show one pane at a time' : 'Show every pane in a grid',
        keys: 'Ctrl G',
        run: () => patchConfig({ grid: !grid })
      },
      {
        id: 'broadcast',
        group: 'Actions',
        title: 'Send a line to every session',
        keys: 'Ctrl B',
        run: () => broadcastBox.current?.focus()
      },
      {
        id: 'swarm',
        group: 'Actions',
        title: 'Launch a swarm on one mission',
        hint: 'several agents, one folder, one role each',
        keys: 'Ctrl Shift S',
        run: () => setSwarm(true)
      },
      {
        id: 'history',
        group: 'Actions',
        title: 'Search past sessions',
        hint: 'everything every agent has printed',
        keys: 'Ctrl H',
        run: () => setHistory(true)
      },
      { id: 'settings', group: 'Actions', title: 'Settings', keys: 'Ctrl ,', run: () => setSettings(true) },
      { id: 'keys', group: 'Actions', title: 'Keyboard shortcuts', keys: 'F1', run: () => setHelp(true) }
    )

    if (active)
      out.push(
        {
          id: 'restart',
          group: 'This pane',
          title: `Restart ${active.title}`,
          keys: 'Ctrl Shift R',
          run: () => api.restartSession(active.id)
        },
        {
          id: 'fix-ui',
          group: 'This pane',
          title: 'Fix the display',
          hint: 'refit and make the agent repaint - keeps the run',
          keys: 'Ctrl Shift L',
          run: () => fixUi(active.id)
        },
        {
          id: 'editor',
          group: 'This pane',
          title: 'Open folder in editor',
          hint: active.cwd,
          run: () => api.openInEditor(active.cwd).then((err) => err && flash(err))
        },
        {
          id: 'reveal',
          group: 'This pane',
          title: 'Open folder in Explorer',
          hint: 'drop files there, or drag them straight onto the pane',
          run: () => api.reveal(active.cwd)
        },
        {
          id: 'board',
          group: 'This pane',
          title: 'Tasks and shared memory for this folder',
          keys: 'Ctrl Shift K',
          run: () => setBoard(active.cwd)
        },
        { id: 'close', group: 'This pane', title: `Close ${active.title}`, keys: 'Ctrl W', run: () => close(active.id) }
      )

    if (sessions.length)
      out.push(
        {
          id: 'save-ws',
          group: 'Actions',
          title: 'Save running sessions as a workspace',
          run: saveRunningAsWorkspace
        },
        {
          // Closing a workspace one Ctrl-W at a time is the tedious half of a day's
          // work ending; one command with one prompt is the whole thing.
          id: 'close-all',
          group: 'Actions',
          title: sessions.length === 1 ? 'Close the last pane' : `Close all ${sessions.length} panes`,
          hint: 'ends every run - the transcripts stay in history',
          run: () =>
            setAsk({
              title: sessions.length === 1 ? 'Close the last pane?' : `Close all ${sessions.length} panes?`,
              body: 'Every agent still running ends. The conversations stay in history.',
              confirmLabel: 'Close them all',
              danger: true,
              onConfirm: () => {
                setAsk(null)
                for (const s of sessions) api.killSession(s.id)
              }
            })
        }
      )

    return out
  }, [
    sessions,
    activeId,
    agents,
    projects,
    config,
    grid,
    patchConfig,
    launchPreset,
    start,
    switchAgent,
    close,
    flash,
    fixUi,
    saveRunningAsWorkspace
  ])

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
          <span className="brand-name">
            <AppLogo size={17} />
            PaneForge
          </span>
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
          <span className="plus">+</span> New session <span className="kbd">Ctrl T</span>
        </button>
        <button className="ghost search-btn" onClick={() => setPalette(true)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Search sessions and actions <span className="kbd">Ctrl K</span>
        </button>

        <div className="quick">
          <button className="ghost small" title="Several agents on one mission (Ctrl Shift S)" onClick={() => setSwarm(true)}>
            Swarm
          </button>
          <button
            className="ghost small"
            title="Tasks and shared memory for the focused pane's folder (Ctrl Shift K)"
            disabled={!activeId}
            onClick={() => {
              const s = sessions.find((x) => x.id === activeId)
              if (s) setBoard(s.cwd)
            }}
          >
            Board
          </button>
          <button className="ghost small" title="Search past sessions (Ctrl H)" onClick={() => setHistory(true)}>
            History
          </button>
        </div>

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
          {/* "Running" read as "these are all busy" on a list of idle panes. */}
          Sessions ({sessions.length})
          {waiting > 0 && <span className="badge">{waiting} waiting</span>}
        </div>
        <div className="list">
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={'row' + (s.id === activeId ? ' active' : '') + (s.attention ? ' attn' : '')}
              onClick={() => setActiveId(s.id)}
              onDoubleClick={() => setRenaming(s.id)}
            >
              <StatusDot status={s.status} engaged={s.engaged} />
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
                  <AgentLogo id={s.agent} spec={agents.find((a) => a.id === s.agent)} size={12} />
                  {agents.find((a) => a.id === s.agent)?.label ?? s.agent}
                  {s.model ? <span className="chip">{s.model}</span> : null}
                  {s.lane ? (
                    <span className="chip lane" title={`Worktree lane - ${s.cwd}`}>
                      {s.lane}
                    </span>
                  ) : null}
                  {s.status === 'exited' ? (
                    <span className="chip dead">exited {s.exitCode ?? ''}</span>
                  ) : s.runSince ? (
                    // Counts only while the agent is working on something. A clock
                    // that ran from launch kept ticking through an idle night and
                    // read as "still busy" at a glance.
                    <Elapsed since={s.runSince} title="This turn" />
                  ) : s.lastRunMs !== undefined ? (
                    <span className="elapsed done" title="Last turn">
                      {formatElapsed(s.lastRunMs)}
                    </span>
                  ) : null}
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

        <div className="broadcast-row">
          <input
            ref={broadcastBox}
            className="search broadcast"
            placeholder="Send a line to every session (Ctrl B)"
            onKeyDown={sendBroadcast}
          />
          {config?.voice.enabled && (
            <button
              className={'icon mic' + (voice.phase === 'recording' ? ' rec' : '') + (voice.phase === 'thinking' ? ' busy' : '')}
              title={
                voice.phase === 'recording'
                  ? 'Listening - click to transcribe (Ctrl Shift Space)'
                  : 'Dictate into the focused pane (Ctrl Shift Space)'
              }
              onClick={voice.toggle}
            >
              {voice.phase === 'thinking' ? '…' : '🎤'}
            </button>
          )}
        </div>

        <div className="foot">
          <Segmented
            value={grid ? 'grid' : 'single'}
            onChange={(v) => patchConfig({ grid: v === 'grid' })}
            options={[
              { value: 'single', label: 'Focus', title: 'One pane at a time (Ctrl G)' },
              { value: 'grid', label: 'Grid', title: 'Every pane at once (Ctrl G)' }
            ]}
          />
          <button className="ghost small" onClick={saveRunningAsWorkspace} disabled={!sessions.length}>
            Save workspace
          </button>
        </div>
        <VersionBadge />
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
            // The agent's brand colour drives this pane's accent, so a grid of four
            // panes is readable without checking the labels.
            style={{ '--agent': agents.find((a) => a.id === s.agent)?.color ?? '#8b8b99' } as React.CSSProperties}
            onMouseDown={() => setActiveId(s.id)}
          >
            <div className="pane-title">
              <StatusDot status={s.status} engaged={s.engaged} />
              <AgentLogo id={s.agent} spec={agents.find((a) => a.id === s.agent)} size={14} />
              <span className="pt-name" onDoubleClick={() => setRenaming(s.id)}>
                {s.title}
              </span>
              {s.role && <span className="chip role">{s.role}</span>}
              {s.lane && (
                <span className="chip lane" title="Own git worktree, so this pane cannot clash with the other session in this project">
                  lane {s.lane}
                </span>
              )}
              <GitBadge cwd={s.cwd} active={visibleIds.has(s.id)} />
              <span className="pt-path">{s.cwd}</span>
              <span className="pt-actions">
                <AgentPicker
                  small
                  agents={agents}
                  agent={s.agent}
                  model={s.model ?? ''}
                  onChange={(a, m) => switchAgent(s, a, m)}
                />
                <button className="icon" title="Restart agent (Ctrl Shift R)" onClick={() => api.restartSession(s.id)}>
                  ⟳
                </button>
                <button
                  className="icon fix"
                  title="Fix the display: refit and repaint, keeping the run (Ctrl Shift L)"
                  onClick={() => fixUi(s.id)}
                >
                  Fix
                </button>
                <button
                  className="icon"
                  title={`Open ${s.cwd} in Explorer - drop files there, or drag them onto this pane`}
                  onClick={() => api.reveal(s.cwd)}
                >
                  📁
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
              copyOnSelect={config?.copyOnSelect ?? true}
              mouseSelect={config?.mouseSelect ?? true}
              autoFixUi={config?.autoFixUi ?? true}
            />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="placeholder">
            <div className="ph-logo">
              <AppLogo size={44} />
            </div>
            <h1>PaneForge</h1>
            <p>Start only the sessions you need. Ctrl T, tick a few projects, Enter.</p>
            <div className="ph-agents">
              {agents
                .filter((a) => a.available && a.id !== 'shell')
                .map((a) => (
                  <button
                    key={a.id}
                    className="ph-agent"
                    title={`New session with ${a.label}`}
                    onClick={() => {
                      patchConfig({ defaultAgent: a.id })
                      setPicking(true)
                    }}
                  >
                    <AgentLogo id={a.id} spec={a} size={26} tile />
                    <span>{a.label}</span>
                  </button>
                ))}
            </div>
            <p className="hint">Ctrl K to search everything. F1 for every shortcut.</p>
          </div>
        )}
      </main>

      {note && <div className="toast">{note}</div>}

      {picking && config && (
        <NewSessionDialog
          projects={projects}
          agents={agents}
          defaultAgent={config.defaultAgent}
          defaultModels={config.defaultModels}
          onCancel={() => setPicking(false)}
          onStart={start}
          onSaveWorkspace={(name, reqs) => {
            saveWorkspace(name, reqs)
            setPicking(false)
          }}
        />
      )}
      {settings && config && (
        <SettingsDialog
          config={config}
          agents={agents}
          onChange={patchConfig}
          onClose={() => setSettings(false)}
        />
      )}
      {swarm && config && (
        <SwarmDialog
          projects={projects}
          agents={agents}
          roles={config.swarmRoles}
          defaultModels={config.defaultModels}
          onSaveRoles={(swarmRoles: SwarmRole[]) => patchConfig({ swarmRoles })}
          onClose={() => setSwarm(false)}
          onLaunched={(n) => {
            setSwarm(false)
            patchConfig({ grid: true })
            flash(`${n} agents started on the mission.`)
          }}
        />
      )}
      {board && (
        <BoardDialog
          cwd={board}
          onSend={(text) => {
            if (activeId) api.write(activeId, text)
            setBoard(null)
          }}
          onClose={() => setBoard(null)}
        />
      )}
      {history && (
        <HistoryDialog
          agents={agents}
          onResume={(e: HistoryEntry) => {
            setHistory(false)
            start([{ cwd: e.cwd, title: e.title, agent: e.agent, model: e.model, resume: true }])
          }}
          onClose={() => setHistory(false)}
        />
      )}
      {ask && (
        <ConfirmDialog
          title={ask.title}
          body={ask.body}
          confirmLabel={ask.confirmLabel}
          danger={ask.danger}
          input={ask.input}
          onConfirm={ask.onConfirm}
          onCancel={() => setAsk(null)}
        />
      )}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      <UpdateToast />
    </div>
  )
}
