import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, AgentSpec } from '@shared/agents'
import {
  installCommand,
  modelHint,
  modelLabel,
  modelValue,
  supportsModel,
  uninstallCommand
} from '@shared/agents'
import type {
  Agent,
  AdminStatus,
  Config,
  DiscordStyle,
  ImproveStatus,
  RestoreMode,
  UpdateState,
  VoiceStatus
} from '@shared/types'
import {
  DEFAULT_DETAILS,
  DEFAULT_DISCORD_STYLE,
  DEFAULT_IDLE_DETAILS,
  DEFAULT_LINK_LABEL,
  DEFAULT_LINK_URL,
  DEFAULT_STATE,
  DISCORD_TOKENS,
  NO_PRESENCE_STATUS,
  PRESENCE_IMAGE_TEXT,
  buildActivity,
  type PresenceCounts,
  type PresenceStatus
} from '@shared/discordRpc'
import { DEFAULT_THEME } from '@shared/theme'
import AgentLogo from './AgentLogo'
import AppearanceTab from './AppearanceTab'
import InstallConsole from './InstallConsole'
import Select from './Select'
import { Segmented, Switch } from './Controls'
// Hints below name shortcuts; on a Mac those live on Cmd, so print them through this.
import { keyLabel } from '../platform'

const api = window.api

interface Props {
  config: Config
  agents: AgentInfo[]
  onChange: (patch: Partial<Config>) => void
  onClose: () => void
}

type Tab = 'general' | 'appearance' | 'agents' | 'stash' | 'voice' | 'prompts' | 'discord' | 'system'

/**
 * The rail down the left of the dialog.
 *
 * Seven tabs in a horizontal segmented strip was already at the width of the dialog, and
 * an eighth would have wrapped. A vertical rail has room for the eighth and the ninth,
 * and - the actual reason - room for a WORD about each one, so "Prompts" and "Stash"
 * stop being nouns you have to click to understand.
 *
 * `find` is what each tab can be searched by. The box above the rail filters the rail
 * rather than the settings themselves: filtering the settings means hiding controls from
 * inside the groups that explain them, which is how a search feature turns a settings
 * page into a list of orphaned switches.
 */
const TABS: { id: Tab; label: string; note: string; find: string }[] = [
  { id: 'general', label: 'General', note: 'Folders, fonts, alerts', find: 'projects root folder agent font size copy select chime notify game mode worktree lane close startup transcript history' },
  { id: 'appearance', label: 'Appearance', note: 'Colours and density', find: 'theme colour color accent palette dark light preset tint contrast corners rounding density compact swatch' },
  { id: 'agents', label: 'Agents', note: 'The CLIs you run', find: 'claude codex gemini copilot cursor install uninstall model custom cli path' },
  { id: 'stash', label: 'Stash', note: 'Clipboard history', find: 'clipboard copy paste history overlay pin float peek images files' },
  { id: 'voice', label: 'Voice', note: 'Dictation', find: 'microphone mic speech whisper dictate push to talk language model' },
  { id: 'prompts', label: 'Prompts', note: 'Improving what you type', find: 'improve prompt rewrite clarify optimise vault knowledge capability telemetry engine' },
  { id: 'discord', label: 'Discord', note: 'What your profile shows', find: 'discord presence rich activity status application id template project elapsed idle' },
  { id: 'system', label: 'System', note: 'Updates and startup', find: 'update administrator admin uac restore restart reopen version download install' }
]

/**
 * The tabs a query hits, in rail order.
 *
 * Every word of the query has to appear somewhere in the tab's name, note or keyword
 * list - AND rather than OR, so "discord idle" narrows instead of widening. An empty
 * query is every tab, which is the case that runs on every render.
 */
function matches(query: string): typeof TABS {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return TABS
  return TABS.filter((t) => {
    const hay = `${t.label} ${t.note} ${t.find}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

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
  const [find, setFind] = useState('')
  const [admin, setAdmin] = useState<AdminStatus | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [improve, setImprove] = useState<ImproveStatus | null>(null)
  // Which agent the console below is for, and whether it is being put on or taken off.
  const [installing, setInstalling] = useState('')
  const [mode, setMode] = useState<'install' | 'uninstall'>('install')
  // Removing a CLI is one click away from being an accident, so the button asks once.
  // In-renderer rather than a message box: nothing here may pop a window.
  const [confirmOff, setConfirmOff] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [rescan, setRescan] = useState(0)
  // Which half of the Discord tab's preview is on screen. The idle wording is the half
  // nobody would otherwise see until the desk went quiet, which is too late to edit it.
  const [preview, setPreview] = useState<'busy' | 'idle'>('busy')

  useEffect(() => {
    api.adminStatus().then(setAdmin)
    api.updateState().then(setUpdate)
    api.voiceStatus().then(setVoice)
    api.improveStatus().then(setImprove)
    return api.onUpdate(setUpdate)
  }, [rescan])

  const pickRoot = async (): Promise<void> => {
    const dir = await api.pickRoot()
    if (dir) onChange({ root: dir })
  }

  const onInstalled = useCallback(
    (ok: boolean) => {
      setRescan((n) => n + 1)
      if (mode === 'uninstall') {
        setMsg(ok ? 'Removed. It is gone from the picker.' : 'Uninstall did not finish - see the log above.')
        return
      }
      setMsg(ok ? 'Installed. It is available in the picker now.' : 'Install did not finish - see the log above.')
    },
    [mode]
  )

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

  const setDiscord = (patch: Partial<DiscordStyle>): void =>
    onChange({ discordStyle: { ...config.discordStyle, ...patch } })

  // The current tab is never filtered away, however badly it matches: a rail that removes
  // the entry you are reading leaves a panel on screen with nothing selected beside it.
  const hits = matches(find)
  const shown = hits.length && !hits.some((t) => t.id === tab)
    ? TABS.filter((t) => t.id === tab || hits.includes(t))
    : hits

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Settings</strong>
          <span className="hint">saved instantly, no restart needed</span>
        </div>

        <div className="settings-shell">
          <div className="settings-nav">
            <input
              className="search nav-find"
              placeholder="Search settings"
              value={find}
              spellCheck={false}
              onChange={(e) => {
                const q = e.target.value
                setFind(q)
                // Jump as you type: with the rail filtered to one entry, having to then
                // click it is a second action for a decision already made.
                const hit = matches(q)
                if (q.trim() && hit.length && !hit.some((t) => t.id === tab)) setTab(hit[0].id)
              }}
            />
            {shown.map((t) => (
              <button
                key={t.id}
                className={'nav-item' + (tab === t.id ? ' on' : '')}
                onClick={() => setTab(t.id)}
              >
                <span className="nav-label">{t.label}</span>
                <span className="nav-note">{t.note}</span>
              </button>
            ))}
            {!shown.length && <div className="hint nav-empty">Nothing matches "{find}".</div>}
          </div>

        <div className="tab-body">
          {tab === 'appearance' && (
            <AppearanceTab
              theme={config.theme ?? DEFAULT_THEME}
              onChange={(theme) => onChange({ theme })}
            />
          )}
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
                  hint={keyLabel(
                    'Ctrl+C copies while something is highlighted and interrupts the agent once nothing is. Ctrl+V pastes.'
                  )}
                />
                <Switch
                  checked={config.mouseSelect}
                  onChange={(v) => onChange({ mouseSelect: v })}
                  label="A drag always selects text"
                  hint="Claude Code and Codex ask for the mouse, which leaves a drag selecting nothing. Turn this off to give them the drag back. The wheel scrolls this pane either way."
                />
                <Switch
                  checked={config.autoFixUi}
                  onChange={(v) => onChange({ autoFixUi: v })}
                  label="Repair a pane's display after a resize"
                  hint={keyLabel(
                    "Makes the agent repaint its whole frame once the size settles, so a resize cannot leave torn boxes behind. Ctrl+Shift+L does it on demand."
                  )}
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
                  checked={config.bellAlert}
                  onChange={(v) => onChange({ bellAlert: v })}
                  label="Say something when a pane rings its bell"
                  hint="A CLI that rings the terminal bell is asking for a person - a prompt it needs answered, a build that failed. The pane marks itself and plays one short note. Its own switch because a chatty CLI must be mutable without muting the turn chime."
                />
                <div className="setting">
                  <label>Warn me when a running turn goes silent</label>
                  <Select
                    value={String(config.silenceAlertMin)}
                    onChange={(v) => onChange({ silenceAlertMin: Number(v) })}
                    menuWidth={240}
                    options={[
                      { value: '2', label: 'after 2 minutes' },
                      { value: '5', label: 'after 5 minutes' },
                      { value: '10', label: 'after 10 minutes' },
                      { value: '30', label: 'after 30 minutes' },
                      { value: '0', label: 'never' }
                    ]}
                  />
                  <div className="hint">
                    Only ever about a pane whose clock is still running: the agent is supposed to be
                    working and has printed nothing at all. A pane sitting at an idle prompt is
                    silent all day and never counts.
                  </div>
                </div>
                <Switch
                  checked={config.gameMode.enabled}
                  onChange={(v) => onChange({ gameMode: { ...config.gameMode, enabled: v } })}
                  label="Stay out of the way while a game is running"
                  hint="Windows takes a fullscreen game off the screen whenever a window appears above it, so while one of the games below is running PaneForge opens no windows, floats no Stash, flashes nothing and holds its update restart until you are done. The chime still plays."
                />
                <Switch
                  checked={config.gameMode.manual}
                  onChange={(v) => onChange({ gameMode: { ...config.gameMode, manual: v } })}
                  label="Do not disturb, right now"
                  hint="The same silence, on until you turn it off, whether or not a game is running."
                />
                <Switch
                  checked={config.autoLane}
                  onChange={(v) => onChange({ autoLane: v })}
                  label="Give a second session in the same project its own lane"
                  hint="Two agents in one folder overwrite each other's edits, race git and fight over the dev server port. The second session in a repo opens in a lane instead - <project>-a on branch lane-a, then -b, then -c - carrying your .env files, your local settings, and the installed node_modules (hardlinked a few seconds after the pane opens, so it costs no disk and deleting the lane never touches the original). It also gets its own PORT (one past whatever the project's dev script uses, also in PF_LANE_PORT) and the original folder's Claude history, memory and permissions instead of a blank slate. Click the lane chip on the pane to see what is in it and merge it back when the work is done."
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

              {config.gameMode.enabled && (
                <div className="setting">
                  <label>Games to watch for</label>
                  <input
                    type="text"
                    defaultValue={config.gameMode.processes.join(', ')}
                    placeholder="cs2.exe, dota2.exe, valorant.exe - blank uses the built-in list"
                    // On blur, not per keystroke: every write restarts the watcher, and
                    // half a process name typed so far matches nothing.
                    onBlur={(e) =>
                      onChange({
                        gameMode: {
                          ...config.gameMode,
                          processes: e.target.value
                            .split(/[,\n]/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                        }
                      })
                    }
                  />
                  <span className="hint">
                    Process names as they appear in Task Manager. Leave it empty for the
                    built-in list (CS2, Dota, Valorant, Fortnite, Apex, Rust, GTA V, Elden Ring
                    and a few more).
                  </span>
                </div>
              )}
            </>
          )}

          {tab === 'stash' && (
            <>
              <div className="setting">
                <div className="setting-row">
                  <label>Stash</label>
                  <span className="hint">
                    everything you copied, screenshotted or dropped - one click from a pane, one
                    drag from any other app
                  </span>
                </div>
                <div className="switches">
                  <Switch
                    checked={config.clipboardShelf}
                    onChange={(v) => onChange({ clipboardShelf: v })}
                    label="Keep what I copy on the Stash"
                    hint={keyLabel(
                      'Anything you copy anywhere - text, or a screenshot - lands bottom-left and stays on a history that survives restarts. Click text to paste it into the focused pane, click an image to type the path of a saved PNG the agent can read, or drag it out to another app. Ctrl+Shift+V reopens it. Off stops the clipboard being watched at all.'
                    )}
                  />
                  <Switch
                    checked={config.clipboardOverlay}
                    onChange={(v) => onChange({ clipboardOverlay: v })}
                    label="Float the Stash over every other app"
                    disabled={!config.clipboardShelf}
                    hint={keyLabel(
                      'A small pill in the bottom-left corner of whichever screen PaneForge is on, on top of every window, whether or not the app is focused. Hover it, or press Ctrl+Alt+V from anywhere, for the whole Stash: click a line to put it back on the clipboard, → to send it to the focused pane, ✕ to forget it. It never takes the keyboard, so you can click a line and paste straight back into what you were typing in. Files can be dropped straight onto the pill.'
                    )}
                  />
                </div>
              </div>

              <div className="setting">
                <label>Show itself for</label>
                <Select
                  value={String(config.stashPeekMs)}
                  onChange={(v) => onChange({ stashPeekMs: Number(v) })}
                  menuWidth={260}
                  options={[
                    { value: '2000', label: '2 seconds' },
                    { value: '5000', label: '5 seconds' },
                    { value: '10000', label: '10 seconds' },
                    { value: '30000', label: '30 seconds' },
                    { value: '0', label: 'Never open by itself', hint: keyLabel('Ctrl+Shift+V only') }
                  ]}
                />
                <span className="hint">
                  How long the in-window Stash stays up when something new lands on it. It keeps
                  collecting either way - this is only whether it interrupts.
                </span>
              </div>

              <div className="setting">
                <label>Keep</label>
                <Select
                  value={String(config.stashMaxItems)}
                  onChange={(v) => onChange({ stashMaxItems: Number(v) })}
                  menuWidth={220}
                  options={[
                    { value: '25', label: '25 entries' },
                    { value: '50', label: '50 entries' },
                    { value: '200', label: '200 entries' },
                    { value: '1000', label: '1000 entries' }
                  ]}
                />
                <span className="hint">
                  Turning this down forgets the oldest entries straight away, not eventually.
                </span>
              </div>

              <div className="setting">
                <label>Screenshots kept</label>
                <Select
                  value={String(config.stashMaxImages)}
                  onChange={(v) => onChange({ stashMaxImages: Number(v) })}
                  menuWidth={220}
                  options={[
                    { value: '6', label: '6 images' },
                    { value: '24', label: '24 images' },
                    { value: '60', label: '60 images' },
                    { value: '0', label: 'None', hint: 'text only' }
                  ]}
                />
                <span className="hint">
                  Each one is a PNG on disk, so images get a shorter list of their own.
                </span>
              </div>

              <div className="setting">
                <div className="setting-row">
                  <label>Files you drop on it</label>
                  <span className="hint">
                    drop a clip, a recording, anything - it is copied here and draggable into any
                    app, then sweeps itself up
                  </span>
                </div>
                <Select
                  value={String(config.stashFileHours)}
                  onChange={(v) => onChange({ stashFileHours: Number(v) })}
                  menuWidth={260}
                  options={[
                    { value: '1', label: 'Keep for 1 hour' },
                    { value: '6', label: 'Keep for 6 hours' },
                    { value: '24', label: 'Keep for a day' },
                    { value: '168', label: 'Keep for a week' },
                    { value: '0', label: 'Until I clear it', hint: 'no clock' }
                  ]}
                />
                <span className="hint">
                  The copy is deleted when the time is up - the original is never touched. Change
                  it and the clocks already running move with it.
                </span>
              </div>

              <div className="setting">
                <label>Biggest file accepted</label>
                <Select
                  value={String(config.stashMaxFileMb)}
                  onChange={(v) => onChange({ stashMaxFileMb: Number(v) })}
                  menuWidth={220}
                  options={[
                    { value: '128', label: '128 MB' },
                    { value: '512', label: '512 MB' },
                    { value: '2048', label: '2 GB' },
                    { value: '0', label: 'No limit' }
                  ]}
                />
                <span className="hint">
                  Anything bigger is refused rather than copied - a Stash is not a backup.
                </span>
              </div>

              <div className="setting">
                <div className="setting-row">
                  <button
                    className="ghost"
                    onClick={() => {
                      void api.pickStashFiles()
                    }}
                  >
                    Add files…
                  </button>
                  <button className="ghost" onClick={() => api.revealStash()}>
                    Open the folder
                  </button>
                  <button className="ghost" onClick={() => api.clearRecents()}>
                    Clear the Stash
                  </button>
                </div>
                <span className="hint">
                  Clearing forgets every entry and deletes the copies on disk. It cannot be undone.
                </span>
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
                          <button
                            className="ghost small"
                            title={installCommand(a)}
                            onClick={() => {
                              setMode('install')
                              setConfirmOff('')
                              setMsg('')
                              setInstalling(a.id)
                            }}
                          >
                            Install
                          </button>
                        )}
                        {a.available && uninstallCommand(a) && (
                          <button
                            className={'ghost small' + (confirmOff === a.id ? ' danger' : '')}
                            title={uninstallCommand(a)}
                            onClick={() => {
                              if (confirmOff !== a.id) return setConfirmOff(a.id)
                              setConfirmOff('')
                              setMode('uninstall')
                              setMsg('')
                              setInstalling(a.id)
                            }}
                          >
                            {confirmOff === a.id ? 'Really remove?' : 'Uninstall'}
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
                {installing && <Installer id={installing} mode={mode} />}
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
                  Click the mic in any pane's header and talk - it goes into that pane, whichever agent is
                  running there. {keyLabel('Ctrl+Shift+Space')} does the same for the focused pane, from
                  anywhere. Audio is
                  transcribed by a Whisper model running on this machine - nothing is uploaded, and it costs
                  nothing.
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
                  label="Show a mic on every pane, and enable the global push-to-talk key"
                />
              </div>
            </>
          )}

          {tab === 'prompts' && (
            <>
              <div className="setting">
                <label>Prompt improvement</label>
                <span className="hint">
                  Before a prompt is sent, PaneForge can rewrite it into a shorter, more specific
                  brief - carrying this project's own context, asking at most one question, and
                  naming only what materially helps. It never sends anything: you read the
                  suggestion, edit it if you like, and press Enter yourself.
                </span>
                <Select
                  value={config.promptImprove.mode === 'off' ? 'off' : 'suggest'}
                  onChange={(v) =>
                    onChange({
                      promptImprove: {
                        ...config.promptImprove,
                        mode: v as 'off' | 'suggest'
                      }
                    })
                  }
                  menuWidth={340}
                  options={[
                    { value: 'off', label: 'Off', hint: 'nothing runs, nothing is spent' },
                    {
                      value: 'suggest',
                      label: 'Suggest',
                      hint: 'offer a chip when a draft goes quiet'
                    }
                  ]}
                />
              </div>

              <div className="setting">
                <div className="setting-row">
                  <span className="hint">
                    {improve?.available
                      ? `The improver runs through ${improve.engine}, headlessly, in an empty folder with no access to this repo. It counts against that CLI's plan.`
                      : 'No agent CLI on PATH to run the improver. Install one from the Agents tab.'}
                  </span>
                </div>
              </div>

              <div className="setting">
                <label>Questions</label>
                <span className="hint">
                  Only ever for what you alone know - your audience, the feeling you want, a
                  business requirement, an irreversible choice. Never which library to use.
                </span>
                <Select
                  value={config.promptImprove.clarify}
                  onChange={(v) =>
                    onChange({
                      promptImprove: {
                        ...config.promptImprove,
                        clarify: v as 'minimal' | 'balanced'
                      }
                    })
                  }
                  menuWidth={300}
                  options={[
                    { value: 'minimal', label: 'Minimal', hint: 'at most one, and only if it matters' },
                    { value: 'balanced', label: 'Balanced', hint: 'up to three' }
                  ]}
                />
              </div>

              <div className="setting">
                <label>Spend</label>
                <Select
                  value={config.promptImprove.optimise}
                  onChange={(v) =>
                    onChange({
                      promptImprove: {
                        ...config.promptImprove,
                        optimise: v as 'quality' | 'balanced' | 'tokens'
                      }
                    })
                  }
                  menuWidth={340}
                  options={[
                    { value: 'quality', label: 'Quality', hint: 'more context and references' },
                    { value: 'balanced', label: 'Balanced', hint: '~2500 tokens in, 700 out' },
                    { value: 'tokens', label: 'Fewest tokens', hint: 'drops references first' }
                  ]}
                />
              </div>

              <div className="setting">
                <label>Knowledge</label>
                <span className="hint">
                  Where researched capability knowledge is read from. Both are optional and both
                  are read-only. Only notes a human marked reviewed or verified are ever offered
                  as something to use; drafts, archives and restricted notes never leave the
                  vault. {improve?.providers.length
                    ? `Active: ${improve.providers.join(', ')}.`
                    : 'None configured - improvements still work, with no references.'}
                </span>
              </div>

              <div className="setting">
                <label>Obsidian vault folder</label>
                <input
                  className="text"
                  spellCheck={false}
                  placeholder={improve?.vaultCandidate || 'leave empty to use no vault'}
                  value={config.promptImprove.vaultPath}
                  onChange={(e) =>
                    onChange({
                      promptImprove: { ...config.promptImprove, vaultPath: e.target.value }
                    })
                  }
                />
                {improve?.vaultCandidate && !config.promptImprove.vaultPath && (
                  <button
                    className="ghost"
                    onClick={() =>
                      onChange({
                        promptImprove: {
                          ...config.promptImprove,
                          vaultPath: improve.vaultCandidate
                        }
                      })
                    }
                  >
                    Use {improve.vaultCandidate}
                  </button>
                )}
              </div>

              <div className="setting">
                <label>vaultindex.py (optional, preferred)</label>
                <span className="hint">
                  If you have the vault-index CLI, point at its `vaultindex.py` and it is used
                  instead of reading the folder directly - it enforces the sensitivity rules when
                  the index is built rather than when a query runs, which is the stronger
                  guarantee.
                </span>
                <input
                  className="text"
                  spellCheck={false}
                  placeholder="…/vault-index/vaultindex.py"
                  value={config.promptImprove.indexScript}
                  onChange={(e) =>
                    onChange({
                      promptImprove: { ...config.promptImprove, indexScript: e.target.value }
                    })
                  }
                />
              </div>

              <div className="switches">
                <Switch
                  checked={config.promptImprove.capabilities}
                  onChange={(v) =>
                    onChange({ promptImprove: { ...config.promptImprove, capabilities: v } })
                  }
                  label="Consult the capability catalogue (libraries, patterns and their trade-offs)"
                />
                <Switch
                  checked={config.promptImprove.telemetry}
                  onChange={(v) =>
                    onChange({ promptImprove: { ...config.promptImprove, telemetry: v } })
                  }
                  label="Record what improvements cost and whether they were accepted (counts and hashes, never the text)"
                />
              </div>
            </>
          )}

          {tab === 'discord' && (
            <>
              <Switch
                checked={config.discordPresence}
                onChange={(v) => onChange({ discordPresence: v })}
                label="Show what the desk is doing on Discord"
                hint="Rich presence on your profile, refreshed as turns start and finish. Counts and project folder names only, never a byte of what a pane says. Needs the Discord app running; off tells Discord nothing at all."
              />

              {config.discordPresence && (
                <>
                  <DiscordStatus />

                  <div className="setting">
                    <div className="setting-row">
                      <label>What Discord will show</label>
                      <Segmented
                        value={preview}
                        onChange={(v) => setPreview(v as 'busy' | 'idle')}
                        options={[
                          { value: 'busy', label: 'A turn running' },
                          { value: 'idle', label: 'Nothing running' }
                        ]}
                      />
                    </div>
                    <DiscordPreview style={config.discordStyle} when={preview} />
                  </div>

                  <div className="switches">
                    <Switch
                      checked={config.discordStyle.projects}
                      onChange={(v) => setDiscord({ projects: v })}
                      label="Name the projects being worked in"
                      hint="The second line. Folder names of the panes whose turn is running - off leaves only the numbers, which says you are busy without saying on what."
                    />
                    <Switch
                      checked={config.discordStyle.elapsed}
                      onChange={(v) => setDiscord({ elapsed: v })}
                      label="Show the elapsed clock"
                      hint="Discord counts up from the oldest running turn, or from when PaneForge started while everything is idle."
                    />
                    <Switch
                      checked={config.discordStyle.whileIdle}
                      onChange={(v) => setDiscord({ whileIdle: v })}
                      label="Keep showing something while nothing is running"
                      hint="Off clears the presence the moment the last turn finishes, so your profile only says PaneForge while there is actually work happening."
                    />
                  </div>

                  <div className="setting">
                    <label>First line, while a turn is running</label>
                    <input
                      className="search"
                      value={config.discordStyle.details}
                      placeholder={DEFAULT_DETAILS}
                      spellCheck={false}
                      onChange={(e) => setDiscord({ details: e.target.value })}
                    />
                  </div>

                  <div className="setting">
                    <label>Second line</label>
                    <input
                      className="search"
                      value={config.discordStyle.state}
                      placeholder={DEFAULT_STATE}
                      spellCheck={false}
                      disabled={!config.discordStyle.projects}
                      onChange={(e) => setDiscord({ state: e.target.value })}
                    />
                  </div>

                  <div className="setting">
                    <label>First line, while nothing is running</label>
                    <input
                      className="search"
                      value={config.discordStyle.idleDetails}
                      placeholder={DEFAULT_IDLE_DETAILS}
                      spellCheck={false}
                      disabled={!config.discordStyle.whileIdle}
                      onChange={(e) => setDiscord({ idleDetails: e.target.value })}
                    />
                  </div>

                  <div className="setting">
                    <Switch
                      checked={config.discordStyle.link}
                      onChange={(v) => setDiscord({ link: v })}
                      label="Put a clickable link under it"
                      hint="Discord draws the two lines above as plain text, so a URL written into them is not a link. A button is the only clickable thing a rich presence has - and Discord shows it to everyone except you, so your own profile will not have it."
                    />
                  </div>

                  {config.discordStyle.link && (
                    <>
                      <div className="setting">
                        <label>Button text</label>
                        <input
                          className="search"
                          value={config.discordStyle.linkLabel}
                          placeholder={DEFAULT_LINK_LABEL}
                          spellCheck={false}
                          maxLength={32}
                          onChange={(e) => setDiscord({ linkLabel: e.target.value })}
                        />
                      </div>
                      <div className="setting">
                        <label>Where it goes</label>
                        <input
                          className="search"
                          value={config.discordStyle.linkUrl}
                          placeholder={DEFAULT_LINK_URL}
                          spellCheck={false}
                          onChange={(e) => setDiscord({ linkUrl: e.target.value.trim() })}
                        />
                        <div className="hint">
                          Must start with http:// or https:// - Discord throws the whole presence
                          away over a malformed button, not just the button. Text is cut at 32
                          characters.
                        </div>
                      </div>
                    </>
                  )}

                  <div className="setting">
                    <div className="hint">
                      An empty line means the greyed-out wording in it. Write whatever you like
                      around these, which stand in for the numbers:
                    </div>
                    <div className="token-legend">
                      {DISCORD_TOKENS.map(([token, what]) => (
                        <div key={token}>
                          <code>{token}</code>
                          <span>{what}</span>
                        </div>
                      ))}
                    </div>
                    <div className="hint">
                      Discord cuts a line off past 128 characters, so a long project list drops
                      its tail for a "+2 more" rather than being chopped mid-word.
                    </div>
                    <div>
                      <button
                        className="ghost small"
                        onClick={() => onChange({ discordStyle: { ...DEFAULT_DISCORD_STYLE } })}
                      >
                        Back to the default wording
                      </button>
                    </div>
                  </div>
                </>
              )}
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
                    <button
                      className="ghost"
                      // Pressing this during a download used to start a second one and
                      // break both, which is what "check failed" really was.
                      disabled={update?.phase === 'checking' || update?.phase === 'downloading'}
                      onClick={() => api.checkForUpdates()}
                    >
                      {update?.phase === 'downloading' ? 'Downloading…' : 'Check now'}
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
                  <Switch
                    checked={config.restoreAfterUpdate}
                    onChange={(v) => onChange({ restoreAfterUpdate: v })}
                    label="Reopen my panes after an update restart"
                    hint="On, an update feels like the app blinked and every pane resumes its conversation. Off, a restart is a clean desk."
                  />
                </div>
              </div>

              <div className="setting">
                <label>After a restart or a crash</label>
                <Select
                  value={config.restoreAfterRestart}
                  onChange={(v) => onChange({ restoreAfterRestart: v as RestoreMode })}
                  menuWidth={260}
                  options={[
                    { value: 'ask', label: 'Ask me', hint: 'offers the panes you had open' },
                    { value: 'always', label: 'Reopen my panes', hint: 'no question, straight back' },
                    { value: 'never', label: 'Start with an empty desk' }
                  ]}
                />
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

/**
 * What Discord itself last said, rather than what the app meant to send.
 *
 * This tab used to show an application-id field and a name looked up from the public API,
 * which described the INTENT and never the outcome - the one question it could not answer
 * is the only one anyone ever asks, which is "is this actually on my profile". Discord
 * acknowledges every presence by echoing back what it stored, so that ack is the answer,
 * and a refused frame now says so instead of looking identical to an accepted one.
 *
 * The last line is the part that closes the real complaint: everything up to Discord can
 * be right and other people can still see nothing, because hiding it is Discord's own
 * switch and not something an application is allowed to read or set.
 */
function DiscordStatus(): JSX.Element {
  const [status, setStatus] = useState<PresenceStatus>(NO_PRESENCE_STATUS)
  useEffect(() => {
    void api.discordStatus().then(setStatus)
    return api.onDiscordStatus(setStatus)
  }, [])

  const at =
    status.acceptedAt !== null ? new Date(status.acceptedAt).toLocaleTimeString() : null
  const named = status.appName ? /paneforge/i.test(status.appName) : false

  return (
    <div className="setting">
      <label>Right now</label>
      {!status.connected ? (
        <div className="hint warn">
          No Discord to talk to. PaneForge looks for it again every minute, so starting
          Discord is enough - nothing here needs touching.
        </div>
      ) : status.error ? (
        <div className="hint warn">Discord refused the last presence: {status.error}</div>
      ) : status.cleared ? (
        <div className="hint">
          Connected{status.user ? <> as <b>{status.user}</b></> : null} - and told Discord to
          show nothing, because no pane is open{at ? `, at ${at}` : ''}.
        </div>
      ) : at ? (
        <div className={named ? 'hint' : 'hint warn'}>
          Discord accepted this at <b>{at}</b>
          {status.user ? (
            <>
              {' '}
              for <b>{status.user}</b>
            </>
          ) : null}
          , headed <b>{status.appName ?? 'nothing'}</b>
          {named ? '' : ' - which is not PaneForge'}
          {status.lines.length ? `: ${status.lines.join(' / ')}` : '.'}
        </div>
      ) : (
        <div className="hint">Connected to Discord, waiting to send the first presence.</div>
      )}
      <div className="hint">
        That is everything this app controls. If your friends still see nothing while the
        line above says accepted, it is one of Discord's own switches, and no application
        can read or change them: Discord → Settings → Activity Privacy, with both{' '}
        <b>Display current activity as a status message</b> and{' '}
        <b>Share your detected activities with others</b> on - and Activity Status on for
        the server they are looking at you in. A presence is desktop-only either way; the
        phone and browser apps never show one.
      </div>
    </div>
  )
}

/**
 * A desk that stands in for yours while you edit the wording. Fixed numbers rather than
 * the live ones on purpose: the point of the preview is that a template can be judged
 * with an empty desk and no Discord open, and real counts of 0/0 would render every
 * template as the same nothing.
 */
const SAMPLE_BUSY: PresenceCounts = {
  running: 2,
  total: 5,
  names: ['PaneForge', 'Toolstash', 'Manic-s-Auction-House'],
  oldestRunSince: 0,
  appStart: 0
}
const SAMPLE_IDLE: PresenceCounts = { running: 0, total: 5, names: [], appStart: 0 }

/**
 * The activity as Discord will draw it - the application's real name on top, then
 * exactly the lines `buildActivity` will send. It is the same pure function the main
 * process calls, so a preview that looks right cannot be a presence that reads wrong.
 */
function DiscordPreview({
  style,
  when
}: {
  style: DiscordStyle
  when: 'busy' | 'idle'
}): JSX.Element {
  const activity = buildActivity(when === 'busy' ? SAMPLE_BUSY : SAMPLE_IDLE, style) as {
    details?: string
    state?: string
    timestamps?: unknown
    buttons?: { label: string; url: string }[]
  } | null
  // The header is the application's name and the application is now a constant, so this
  // is not a lookup any more - it is the same literal the presence sends as its tooltip.
  const header = PRESENCE_IMAGE_TEXT
  return (
    <div className="discord-card">
      <div className="dc-art" aria-hidden="true">
        {header.slice(0, 1).toUpperCase()}
      </div>
      <div className="dc-lines">
        <div className="dc-name">{header}</div>
        {activity ? (
          <>
            {activity.details && <div className="dc-line">{activity.details}</div>}
            {activity.state && <div className="dc-line">{activity.state}</div>}
            {activity.timestamps && <div className="dc-line dim">12:34 elapsed</div>}
            {activity.buttons?.map((b) => (
              <div className="dc-button" key={b.url}>
                {b.label}
              </div>
            ))}
          </>
        ) : (
          <div className="dc-line dim">Nothing at all - your profile shows no activity.</div>
        )}
      </div>
    </div>
  )
}

/** Kicks the install (or removal) off exactly once per agent id the console opens for. */
function Installer({ id, mode }: { id: string; mode: 'install' | 'uninstall' }): null {
  useEffect(() => {
    if (!id || id === '__voice__') return
    if (mode === 'uninstall') void api.uninstallAgent(id)
    else void api.installAgent(id)
  }, [id, mode])
  return null
}
