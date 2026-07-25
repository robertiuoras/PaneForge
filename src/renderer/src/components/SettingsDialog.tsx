import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, AgentSpec } from '@shared/agents'
import { installCommand, modelHint, modelLabel, modelValue, supportsModel } from '@shared/agents'
import type { Agent, AdminStatus, Config, UpdateState, VoiceStatus } from '@shared/types'
import AgentLogo from './AgentLogo'
import InstallConsole from './InstallConsole'
import Select from './Select'
import { Segmented, Switch } from './Controls'

const api = window.api

interface Props {
  config: Config
  agents: AgentInfo[]
  onChange: (patch: Partial<Config>) => void
  onClose: () => void
}

type Tab = 'general' | 'agents' | 'voice' | 'system'

/**
 * Adding an agent is four prompts rather than a form: it happens once per CLI, and
 * a full editor would be more UI than the feature is worth. The stored shape is the
 * same AgentSpec the built-ins use, so a custom entry is a first-class agent.
 */
function addCustom(config: Config, onChange: (patch: Partial<Config>) => void): void {
  const label = window.prompt('Name (shown in the picker)')?.trim()
  if (!label) return
  const bin = window.prompt('Command to run (on PATH, or a full path)', label.toLowerCase())?.trim()
  if (!bin) return
  const args = window.prompt('Arguments for a fresh session (space separated, can be empty)', '') ?? ''
  const resume = window.prompt('Arguments that resume the last session (empty = not supported)', '') ?? ''
  const modelFlag = window.prompt('Flag that selects a model (e.g. --model, empty = none)', '')?.trim()
  const models = modelFlag
    ? (window.prompt('Model suggestions, comma separated (optional)', '') ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : []

  const spec: AgentSpec = {
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    bin,
    args: args.split(/\s+/).filter(Boolean),
    resumeArgs: resume.trim() ? resume.split(/\s+/).filter(Boolean) : undefined,
    modelFlag: modelFlag || undefined,
    models: models.length ? models : undefined,
    color: '#7dd3fc',
    custom: true
  }
  onChange({ customAgents: [...config.customAgents.filter((c) => c.id !== spec.id), spec] })
}

export default function SettingsDialog({ config, agents, onChange, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('general')
  const [admin, setAdmin] = useState<AdminStatus | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [installing, setInstalling] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [rescan, setRescan] = useState(0)

  useEffect(() => {
    api.adminStatus().then(setAdmin)
    api.updateState().then(setUpdate)
    api.voiceStatus().then(setVoice)
    return api.onUpdate(setUpdate)
  }, [rescan])

  const pickRoot = async (): Promise<void> => {
    const dir = await api.pickRoot()
    if (dir) onChange({ root: dir })
  }

  const onInstalled = useCallback((ok: boolean) => {
    setRescan((n) => n + 1)
    setMsg(ok ? 'Installed. It is available in the picker now.' : 'Install did not finish - see the log above.')
  }, [])

  const toggleAdmin = async (on: boolean): Promise<void> => {
    setBusy('admin')
    setMsg(on ? 'Approve the Windows prompt (once, ever)...' : 'Removing the task...')
    const r = on ? await api.adminEnable() : await api.adminDisable()
    setBusy('')
    setMsg(r.message)
    api.adminStatus().then(setAdmin)
  }

  const setModelFor = (id: Agent, model: string): void =>
    onChange({ defaultModels: { ...config.defaultModels, [id]: model } })

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Settings</strong>
          <span className="hint">saved instantly, no restart needed</span>
        </div>

        <Segmented
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'general', label: 'General' },
            { value: 'agents', label: 'Agents' },
            { value: 'voice', label: 'Voice' },
            { value: 'system', label: 'System' }
          ]}
        />

        <div className="tab-body">
          {tab === 'general' && (
            <>
              <div className="setting">
                <label>Projects folder</label>
                <div className="setting-row">
                  <input className="search" readOnly value={config.root} />
                  <button className="ghost" onClick={pickRoot}>
                    Browse
                  </button>
                </div>
              </div>

              <div className="setting">
                <label>Default agent</label>
                <Select
                  value={config.defaultAgent}
                  onChange={(v) => onChange({ defaultAgent: v as Agent })}
                  menuWidth={300}
                  options={agents.map((a) => ({
                    value: a.id,
                    label: a.label,
                    hint: a.available ? a.note : 'not installed',
                    disabled: !a.available,
                    group: a.custom ? 'Custom' : a.free ? 'Free' : 'Subscription',
                    icon: <AgentLogo id={a.id} spec={a} size={15} muted={!a.available} />
                  }))}
                />
              </div>

              <div className="setting">
                <label>Terminal font size ({config.fontSize}px)</label>
                <input
                  type="range"
                  min={9}
                  max={22}
                  value={config.fontSize}
                  onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
                />
              </div>

              <div className="switches">
                <Switch
                  checked={config.copyOnSelect}
                  onChange={(v) => onChange({ copyOnSelect: v })}
                  label="Selecting text in a pane copies it"
                  hint="Ctrl+C copies while something is highlighted and interrupts the agent once nothing is. Ctrl+V pastes."
                />
                <Switch
                  checked={config.mouseSelect}
                  onChange={(v) => onChange({ mouseSelect: v })}
                  label="The mouse always selects and scrolls"
                  hint="Claude Code and Codex ask for the mouse, which leaves a drag selecting nothing and the wheel scrolling the agent instead of the pane. Turn this off to give them the mouse back."
                />
                <Switch
                  checked={config.autoFixUi}
                  onChange={(v) => onChange({ autoFixUi: v })}
                  label="Repair a pane's display after a resize"
                  hint="Makes the agent repaint its whole frame once the size settles, so a resize cannot leave torn boxes behind. Ctrl+Shift+L does it on demand."
                />
                <Switch
                  checked={config.notifyOnIdle}
                  onChange={(v) => onChange({ notifyOnIdle: v })}
                  label="Notify me when a background session goes quiet"
                  hint="Taskbar flash plus a system notification, only while the app is not focused."
                />
                <Switch
                  checked={config.soundOnIdle}
                  onChange={(v) => onChange({ soundOnIdle: v })}
                  label="Chime when a session finishes its turn"
                  hint="A soft two-note bell, and it plays even while PaneForge is focused - a pane you are not reading can still finish."
                />
                <Switch
                  checked={config.confirmClose}
                  onChange={(v) => onChange({ confirmClose: v })}
                  label="Ask before closing a running session"
                  hint="Exited panes always close without a prompt."
                />
                <Switch
                  checked={config.launchAtLogin}
                  onChange={(v) => onChange({ launchAtLogin: v })}
                  label="Start PaneForge when the computer starts"
                />
                <Switch
                  checked={config.saveHistory}
                  onChange={(v) => onChange({ saveHistory: v })}
                  label="Keep a searchable transcript of every pane"
                  hint={`Stored on this machine only. Deleted after ${config.historyDays || '∞'} days.`}
                />
              </div>
            </>
          )}

          {tab === 'agents' && (
            <>
              <div className="setting">
                <div className="setting-row">
                  <label>Agents on this machine</label>
                  <button className="ghost small" onClick={() => setRescan((n) => n + 1)}>
                    Rescan
                  </button>
                </div>
                <div className="agent-grid">
                  {agents.map((a) => (
                    <div key={a.id} className={'agent-card' + (a.available ? '' : ' off')}>
                      <AgentLogo id={a.id} spec={a} size={22} tile muted={!a.available} />
                      <span className="agent-name">
                        {a.label}
                        {a.free && <span className="tag free">free</span>}
                        {a.custom && <span className="tag">custom</span>}
                      </span>
                      <span className="hint">{a.available ? a.path : a.note || `${a.bin} not on PATH`}</span>
                      <div className="agent-actions">
                        {!a.available && installCommand(a) && (
                          <button className="ghost small" onClick={() => setInstalling(a.id)}>
                            Install
                          </button>
                        )}
                        {!a.available && (
                          <button
                            className="ghost small"
                            title="Point PaneForge at a binary you already have"
                            onClick={() => api.locateAgent(a.id).then(() => setRescan((n) => n + 1))}
                          >
                            Locate
                          </button>
                        )}
                        {a.docs && (
                          <button className="ghost small" onClick={() => api.openExternal(a.docs as string)}>
                            Docs
                          </button>
                        )}
                        {a.custom && (
                          <button
                            className="ghost small"
                            onClick={() =>
                              onChange({ customAgents: config.customAgents.filter((c) => c.id !== a.id) })
                            }
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="setting-row">
                  <span className="hint">Any other CLI can be added - it runs in a real terminal pane.</span>
                  <button className="ghost" onClick={() => addCustom(config, onChange)}>
                    Add agent
                  </button>
                </div>
                {installing && (
                  <>
                    <InstallConsole agentId={installing} onDone={onInstalled} />
                    <div className="setting-row">
                      <span className="hint">{msg}</span>
                      <button className="ghost small" onClick={() => setInstalling('')}>
                        Hide log
                      </button>
                    </div>
                  </>
                )}
                {installing && <Installer id={installing} />}
              </div>

              <div className="setting">
                <label>Default model per agent</label>
                <span className="hint">
                  Used for every new pane. Pin an exact version (Opus 5, Opus 4.8) so &quot;latest&quot; cannot
                  change under you mid-project.
                </span>
                <div className="model-rows">
                  {agents
                    .filter((a) => a.available && supportsModel(a))
                    .map((a) => (
                      <div key={a.id} className="model-row">
                        <AgentLogo id={a.id} spec={a} size={15} />
                        <span className="mr-name">{a.label}</span>
                        <Select
                          size="sm"
                          menuWidth={260}
                          value={config.defaultModels[a.id] ?? ''}
                          onChange={(v) => setModelFor(a.id, v)}
                          options={[
                            { value: '', label: `${a.label} default` },
                            ...(a.models ?? []).map((m) => ({
                              value: modelValue(m),
                              label: modelLabel(m),
                              hint: modelHint(m)
                            }))
                          ]}
                        />
                      </div>
                    ))}
                </div>
              </div>
            </>
          )}

          {tab === 'voice' && (
            <>
              <div className="setting">
                <label>Dictation</label>
                <span className="hint">
                  Hold the mic button (or press Ctrl+Shift+Space anywhere) and talk. Audio is transcribed by a
                  Whisper model running on this machine - nothing is uploaded, and it costs nothing.
                </span>
              </div>

              <div className="setting">
                <div className="setting-row">
                  <span className="hint">
                    {voice?.available
                      ? `Using ${voice.engine} (${voice.path})`
                      : 'No local speech engine found yet.'}
                  </span>
                  {!voice?.available && (
                    <button
                      className="ghost"
                      onClick={() => {
                        setInstalling('__voice__')
                        api.installVoice()
                      }}
                    >
                      Install it
                    </button>
                  )}
                </div>
                {installing === '__voice__' && (
                  <InstallConsole
                    agentId="__voice__"
                    onDone={() => api.voiceStatus().then(setVoice)}
                  />
                )}
              </div>

              <div className="setting">
                <label>Model</label>
                <Select
                  value={config.voice.model}
                  onChange={(v) => onChange({ voice: { ...config.voice, model: v } })}
                  menuWidth={280}
                  options={[
                    { value: 'tiny', label: 'tiny', hint: 'fastest, roughest' },
                    { value: 'base', label: 'base', hint: 'good default' },
                    { value: 'small', label: 'small', hint: 'slower, better' },
                    { value: 'medium', label: 'medium', hint: 'slow, accurate' }
                  ]}
                />
              </div>

              <div className="setting">
                <label>Language</label>
                <Select
                  value={config.voice.language}
                  onChange={(v) => onChange({ voice: { ...config.voice, language: v } })}
                  menuWidth={240}
                  options={[
                    { value: 'auto', label: 'Detect automatically' },
                    { value: 'en', label: 'English' },
                    { value: 'ro', label: 'Romanian' },
                    { value: 'es', label: 'Spanish' },
                    { value: 'fr', label: 'French' },
                    { value: 'de', label: 'German' }
                  ]}
                />
              </div>

              <div className="switches">
                <Switch
                  checked={config.voice.enabled}
                  onChange={(v) => onChange({ voice: { ...config.voice, enabled: v } })}
                  label="Enable the mic button and the global push-to-talk key"
                />
              </div>
            </>
          )}

          {tab === 'system' && (
            <>
              <div className="setting">
                <label>Administrator</label>
                {admin?.supported ? (
                  <>
                    <span className="hint">
                      {admin.elevated
                        ? 'This window is running as administrator.'
                        : 'Running as a normal user. Agents cannot stop admin-owned processes (a service on port 8000, for example).'}
                    </span>
                    <div className="switches">
                      <Switch
                        checked={admin.taskInstalled}
                        onChange={toggleAdmin}
                        label="Always start as administrator, with no UAC prompt"
                        hint="Registers a Windows scheduled task once (one approval, ever) and points your shortcuts at it. Every agent pane then inherits admin rights."
                      />
                    </div>
                    {admin.taskInstalled && (
                      <span className="hint warn">
                        Anything PaneForge launches runs elevated. Drag and drop from Explorer into an elevated
                        window is blocked by Windows.
                      </span>
                    )}
                    <div className="setting-row">
                      <span className="hint">{busy === 'admin' ? 'Working...' : msg}</span>
                      {!admin.elevated && admin.taskInstalled && (
                        <button className="ghost" onClick={() => api.relaunchAsAdmin()}>
                          Restart elevated now
                        </button>
                      )}
                      {!admin.elevated && !admin.taskInstalled && (
                        <button className="ghost" onClick={() => api.relaunchAsAdmin()}>
                          Restart as admin (one prompt)
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="hint">
                    macOS does not have a no-prompt equivalent. Agents that need root ask for a password
                    themselves.
                  </span>
                )}
              </div>

              <div className="setting">
                <label>Updates</label>
                <div className="setting-row">
                  <span className="hint">
                    Version {update?.current ?? '?'}
                    {update?.phase === 'ready' && ` - ${update.version} downloaded and ready`}
                    {update?.phase === 'downloading' && ` - downloading ${update.version} (${update.percent ?? 0}%)`}
                    {update?.phase === 'none' && ' - up to date'}
                    {update?.phase === 'checking' && ' - checking...'}
                    {update?.phase === 'error' && ` - ${update.error}`}
                    {update?.phase === 'unsupported' && ' - dev build, updates disabled'}
                  </span>
                  {update?.phase === 'ready' ? (
                    <button className="primary" onClick={() => api.installUpdate()}>
                      Restart and update
                    </button>
                  ) : (
                    <button className="ghost" onClick={() => api.checkForUpdates()}>
                      Check now
                    </button>
                  )}
                </div>
                <div className="switches">
                  <Switch
                    checked={config.autoUpdate}
                    onChange={(v) => onChange({ autoUpdate: v })}
                    label="Check for updates in the background"
                    hint="Downloads quietly, then asks before restarting."
                  />
                </div>
              </div>

              <div className="setting">
                <label>Transcript retention</label>
                <Select
                  value={String(config.historyDays)}
                  onChange={(v) => onChange({ historyDays: Number(v) })}
                  menuWidth={220}
                  options={[
                    { value: '7', label: '7 days' },
                    { value: '30', label: '30 days' },
                    { value: '90', label: '90 days' },
                    { value: '0', label: 'Keep everything' }
                  ]}
                />
              </div>
            </>
          )}
        </div>

        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** Kicks the install off exactly once per agent id the console is opened for. */
function Installer({ id }: { id: string }): null {
  useEffect(() => {
    if (id && id !== '__voice__') api.installAgent(id)
  }, [id])
  return null
}
