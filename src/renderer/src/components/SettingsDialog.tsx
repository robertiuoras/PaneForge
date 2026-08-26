import { useCallback, useEffect, useRef, useState } from 'react'
import { findSettings } from '@shared/settingsIndex'
import { DEFAULT_AUTO_ANSWER } from '@shared/autoAnswer'
import { DEFAULT_AUTO_HANDOFF, IDLE_OFFLOAD_MINUTES } from '@shared/autoHandoff'
import { DEFAULT_MASCOT, HIDE_SECONDS } from '@shared/mascot'
import { DEFAULT_TIPS } from '@shared/tips'
import PetPicker from './PetPicker'
import { DEFAULT_RECLAIM, IDLE_CLOSE_MINUTES } from '@shared/reclaim'
import { pickVoiceEngine } from '@shared/voicePick'
import { MODEL_MB } from '@shared/voiceModels'
import type { AgentInfo, AgentSpec } from '@shared/agents'
import {
  KEY_PROVIDERS,
  installCommand,
  keyProviderFor,
  modelGroup,
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
  RestoreMode,
  UpdateState,
  VoiceStatus,
  VoiceConfig
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
import SoundsTab from './SoundsTab'
import InstallConsole from './InstallConsole'
import { BLURBS } from '@shared/blurbs'
import Select from './Select'
import { Segmented, Switch } from './Controls'
// Hints below name shortcuts; on a Mac those live on Cmd, so print them through this.
import { isMac, isWindows, keyLabel } from '../platform'

const api = window.api

interface Props {
  config: Config
  agents: AgentInfo[]
  /** the page to open on, when the button pressed was about one page (the Stash gear) */
  initial?: Tab
  onChange: (patch: Partial<Config>) => void
  onClose: () => void
}

type Tab = 'general' | 'appearance' | 'sounds' | 'agents' | 'stash' | 'voice' | 'discord' | 'system'

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
  { id: 'sounds', label: 'Sounds', note: 'What the alerts play', find: 'sound audio chime bell alert volume mute noise cat meow dog bark animal arcade coin laser upload custom mp3 wav file ringtone notification' },
  { id: 'agents', label: 'Agents', note: 'The CLIs you run', find: 'claude codex antigravity copilot cursor install uninstall model custom cli path' },
  { id: 'stash', label: 'Stash', note: 'Clipboard history', find: 'clipboard copy paste history overlay pin float peek images files' },
  { id: 'voice', label: 'Voice', note: 'Dictation', find: 'microphone mic speech whisper dictate push to talk language model' },
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
/**
 * The sentence to print instead of the path when this agent authenticates with a key
 * Settings does not hold, or '' when it is fine. Only the agents whose AUTH is the key:
 * one that merely passes a key along runs on its own login without it and is not blocked.
 */
function missingKeyFor(spec: AgentSpec, config: Config): string {
  const id = keyProviderFor(spec)
  if (!id || config.providerKeys?.[id]?.trim()) return ''
  const label = KEY_PROVIDERS.find((p) => p.id === id)?.label ?? id
  // No article in front of the name: "a OpenRouter key" is what writing one produces.
  return `No ${label} key yet - paste one below, or this pane's first turn comes back 401`
}

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

export default function SettingsDialog({ config, agents, initial, onChange, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>(initial ?? 'general')
  const [find, setFind] = useState('')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [admin, setAdmin] = useState<AdminStatus | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [voiceStatus, setVoice] = useState<VoiceStatus | null>(null)
  // The same pure ladder the hook runs, so Settings states the engine that will
  // actually be used rather than a second opinion about it.
  const voiceChoice = pickVoiceEngine({
    hasSystem: !!voiceStatus?.available,
    isElectron: /electron/i.test(navigator.userAgent),
    hasSpeechRecognition:
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window,
    hasWasm: typeof WebAssembly !== 'undefined',
    touch: matchMedia('(pointer: coarse)').matches,
    prefer: config?.voice.engine ?? 'auto'
  })
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

  // The settings themselves that the query hits, best first, and the tabs they are on.
  // The rail alone could only ever say WHICH PAGE a thing is on, so finding a switch still
  // meant reading a page of switches; these are what get highlighted on the right.
  const settingHits = findSettings(find)
  const settingTabs = new Set(settingHits.map((s) => s.tab))
  const here = settingHits.filter((s) => s.tab === tab).length
  const elsewhere = settingHits.length - here

  // The current tab is never filtered away, however badly it matches: a rail that removes
  // the entry you are reading leaves a panel on screen with nothing selected beside it.
  const keyword = matches(find)
  const hits = find.trim()
    ? TABS.filter((t) => keyword.includes(t) || settingTabs.has(t.id))
    : TABS
  const shown = hits.length && !hits.some((t) => t.id === tab)
    ? TABS.filter((t) => t.id === tab || hits.includes(t))
    : hits

  /**
   * Put the accent on every setting the query hit, and bring the best one into view.
   *
   * It is done to the DOM rather than by passing a `highlight` prop down through nine
   * tab bodies and two child components: the thing being marked is a row somebody is
   * looking at, and every one of them already draws its own name. Matching is by that
   * name - a label the index took verbatim out of this same file - and a reading in
   * brackets ("Terminal font size (14px)") is why it is a prefix test and not equality.
   *
   * Nothing is HIDDEN. Filtering the settings would strip controls out of the groups that
   * explain them, which is how a search turns a settings page into orphaned switches.
   */
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    for (const el of body.querySelectorAll('.found')) el.classList.remove('found', 'found-top')
    if (!settingHits.length) return

    const wanted = settingHits.filter((s) => s.tab === tab)
    if (!wanted.length) return
    const rows = [...body.querySelectorAll<HTMLElement>('.sw-label, .setting > label')]
    let top: HTMLElement | null = null
    for (const hit of wanted) {
      const row = rows.find((r) => {
        const text = (r.textContent ?? '').replace(/\s+/g, ' ').trim()
        return text === hit.label || text.startsWith(hit.label)
      })
      if (!row) continue
      const mark = row.closest<HTMLElement>('.sw-row, .setting') ?? row
      mark.classList.add('found')
      if (!top) top = mark
    }
    // `nearest` rather than `center`: a match already on screen must not scroll the page
    // out from under somebody who is reading it.
    if (top) {
      top.classList.add('found-top')
      top.scrollIntoView({ block: 'nearest' })
    }
  }, [tab, find, config])

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
                // click it is a second action for a decision already made. A hit on a
                // SETTING wins over one on a tab's keyword list - the query named a
                // control, so the page holding that control is the one to open.
                if (!q.trim()) return
                const best = findSettings(q)[0]
                const hit = matches(q)
                const page = best ? (best.tab as Tab) : hit.length ? hit[0].id : null
                if (page && page !== tab) setTab(page)
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
            {!!settingHits.length && (
              // Only the settings on THIS page are marked, so only those may be counted as
              // marked: saying "5 marked on the right" over two visible rings reads as
              // three results having gone missing. The rest are named as being elsewhere,
              // and the rail beside this line is where they are.
              <div className="hint nav-count">
                {here === 0
                  ? `${elsewhere} on the other pages.`
                  : `${here === 1 ? '1 setting' : `${here} settings`} marked on the right${
                      elsewhere ? `, ${elsewhere} more on the other pages` : ''
                    }.`}
              </div>
            )}
          </div>

        <div className="tab-body" ref={bodyRef}>
          {tab === 'appearance' && (
            <AppearanceTab
              theme={config.theme ?? DEFAULT_THEME}
              onChange={(theme) => onChange({ theme })}
            />
          )}
          {tab === 'sounds' && <SoundsTab config={config} onChange={onChange} />}
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
                  checked={config.clickMovesCursor}
                  onChange={(v) => onChange({ clickMovesCursor: v })}
                  label="Click moves the cursor"
                  hint={
                    'A CLI’s prompt is drawn text, so a click cannot place a caret there - it is sent as the arrow keys that would have reached the same spot. A plain click works along the line you are typing, wrapped rows included, and sends left and right only. ' +
                    (isMac ? 'Option-click' : 'Alt-click') +
                    ' reaches other lines too, and is held behind the modifier because in a plain shell an up-arrow recalls the last command instead of moving.'
                  }
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
                  hint="Plays even while PaneForge is focused - a pane you are not reading can still finish. Which sound it makes, and the sound for the other two alerts, is on the Sounds tab."
                />
                <Switch
                  checked={config.telegramAsk}
                  onChange={(v) => onChange({ telegramAsk: v })}
                  label="Send a pane's question to Telegram"
                  hint="A question stops the run until somebody presses a row, and the pane looks finished while it waits - so this one alert leaves the machine. Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment or in ~/.claude/usage-notify.env; without them nothing is sent. Message only: answering is still a press here or on the phone."
                />
                <Switch
                  checked={config.bellAlert}
                  onChange={(v) => onChange({ bellAlert: v })}
                  label="Say something when a pane rings its bell"
                  hint="A CLI that rings the terminal bell is asking for a person - a prompt it needs answered, a build that failed. The pane marks itself and plays its sound. Its own switch because a chatty CLI must be mutable without muting the turn chime."
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
                <div className="setting">
                  <label>Feature notes</label>
                  <div className="setting-row">
                    <span className="hint">
                      {config.hiddenBlurbs?.length
                        ? `${config.hiddenBlurbs.length} of ${BLURBS.length} hidden. Each one is the line at the top of a feature saying what it is.`
                        : `All ${BLURBS.length} showing. Each is the line at the top of a feature saying what it is - close one with its × and it stays closed.`}
                    </span>
                    <button
                      className="ghost small"
                      disabled={!config.hiddenBlurbs?.length}
                      onClick={() => onChange({ hiddenBlurbs: [] })}
                    >
                      Show them all again
                    </button>
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
                  checked={config.offloadWhenFull !== false}
                  onChange={(v) => onChange({ offloadWhenFull: v })}
                  label="Start a pane on a paired device when this machine is full"
                  hint="Only once panes here already cost more memory than the machine has, and only for a project that device also has. The launch says where it went."
                />
                <Switch
                  checked={config.offloadAsk === true}
                  onChange={(v) =>
                    onChange({ offloadAsk: v, offloadDefaultsV2: true, offloadDefaultsV3: true })
                  }
                  label="Ask first, rather than moving it"
                  hint="On, and on is the default: a pane starting on the other machine is something you can say no to in the moment, rather than something the app decides and reports afterwards. It recommends the paired device, and remembers your answer for ten minutes so a burst of panes asks once. Off restores the silent move, decided by the budget below."
                />
                <Switch
                  checked={config.autoHandoff?.enabled !== false}
                  onChange={(v) =>
                    onChange({
                      autoHandoff: { ...DEFAULT_AUTO_HANDOFF, ...config.autoHandoff, enabled: v }
                    })
                  }
                  label="Move a finished pane to a paired device when this machine is full"
                  hint="The setting above stops it getting worse by starting the NEXT pane over there; this moves one that is already open, with its conversation, its branch, its screen and the dev server it had running. It fires on the budget below, and on either sign of a machine in trouble - the kernel saying it is out of memory, or the load average saying this desk is lagging, whichever comes first (memory says so late: nine agents here once read as merely tight while the load ran at 8.7 on 10 cores). Only to a device that is online and has the same project. A pane mid-turn is never killed - it is queued and goes the moment its turn ends, because killing a pty mid-answer loses the answer. A pane holding a question on screen is never moved at all. If nothing can take it, the pane is closed instead, which keeps its conversation and its screen in History."
                />
                {config.autoHandoff?.enabled !== false && (
                  <div className="setting">
                    <label>Panes this machine runs itself</label>
                    <input
                      className="search"
                      type="number"
                      min={0}
                      max={64}
                      step={1}
                      value={config.autoHandoff?.keepLocal ?? DEFAULT_AUTO_HANDOFF.keepLocal}
                      onChange={(e) =>
                        onChange({
                          autoHandoff: {
                            ...DEFAULT_AUTO_HANDOFF,
                            ...config.autoHandoff,
                            keepLocal: Number(e.target.value)
                          }
                        })
                      }
                    />
                    <p className="hint">
                      The budget, and the only rule here that does not wait for something to
                      go wrong. Past this many agents running on this machine, the rest move
                      to a paired device and come straight back as mirrors - so they are all
                      still on this screen, still typed into from here, and the memory and
                      the CPU are over there. It is the one rule allowed to move a pane that
                      is on screen and a pane that is mid-turn (that one is queued and goes
                      the moment the turn ends, never killed); the pane you are typing in,
                      one holding a question, and the last pane on the desk are refused as
                      always. 0 turns the budget off and leaves the two readings below. With
                      nothing paired and online it does nothing at all.
                    </p>
                  </div>
                )}
                {config.autoHandoff?.enabled !== false &&
                  (config.autoHandoff?.keepHere ?? []).length > 0 && (
                    <div className="setting">
                      <label>Projects that never leave this machine</label>
                      <div className="keephere">
                        {(config.autoHandoff?.keepHere ?? []).map((name) => (
                          <button
                            key={name}
                            className="chip keephere-chip"
                            title={`Stop holding ${name} here - it may be moved to a paired machine again`}
                            onClick={() =>
                              onChange({
                                autoHandoff: {
                                  ...DEFAULT_AUTO_HANDOFF,
                                  ...config.autoHandoff,
                                  keepHere: (config.autoHandoff?.keepHere ?? []).filter(
                                    (n) => n !== name
                                  )
                                }
                              })
                            }
                          >
                            {name} <span className="keephere-x">✕</span>
                          </button>
                        ))}
                      </div>
                      <p className="hint">
                        Added by &quot;Keep it here&quot; on the memory card, for work only this
                        device can do - its own Keychain, its own scheduled jobs, a browser on
                        this screen. A project listed here is refused by every rule above: the
                        budget, the pressure sweep and the idle clock. Press one to take it off
                        the list. The list is empty, and this row is hidden, until something is
                        on it.
                      </p>
                    </div>
                  )}
                {config.autoHandoff?.enabled !== false && (
                  <Switch
                    checked={(config.autoHandoff?.offloadIdleMinutes ?? 0) > 0}
                    onChange={(v) =>
                      onChange({
                        autoHandoff: {
                          ...DEFAULT_AUTO_HANDOFF,
                          ...config.autoHandoff,
                          offloadIdleMinutes: v ? IDLE_OFFLOAD_MINUTES : 0
                        }
                      })
                    }
                    label="...and move a quiet one over there even when there is still room"
                    hint={`The setting above only fires once the machine says it is out of memory, and it refuses any pane that is on screen - which with the grid on is every pane, so on a one-window desk it can never fire at all. This is the clock instead: a pane nobody has typed into for ${IDLE_OFFLOAD_MINUTES} minutes moves to the paired device whatever the memory says, because an idle agent costs its ~190 MB the whole time it sits there and the lag arrives long before the kernel admits to it. Every other refusal is unchanged - never the pane you are in, never one mid-turn, never one holding a question, never the last pane - and the pane comes straight back as a mirror, so you keep watching it and typing into it from here.`}
                  />
                )}
                <Switch
                  checked={(config.mascot?.enabled ?? DEFAULT_MASCOT.enabled)}
                  onChange={(v) =>
                    onChange({ mascot: { ...DEFAULT_MASCOT, ...config.mascot, enabled: v } })
                  }
                  label="Let the little one keep an eye on this machine"
                  hint="Everything above happens silently - panes are trimmed, moved and closed by three timers whose only output is a line in a console nobody has open. This is the face on them: it walks to the pane it is talking about, says what was done in a bubble, and offers a press before anything is closed. It answers typed questions about this window too - 'what are the two biggest', 'close the idle ones', 'what is pane 3' - out of readings the app already holds, with no model and no request to anywhere. It never takes focus, never opens a dialog, and it is silent until you press the speaker on its bubble."
                />
                {(config.mascot?.enabled ?? DEFAULT_MASCOT.enabled) && (
                  <Switch
                    checked={config.mascot?.roam !== false}
                    onChange={(v) =>
                      onChange({ mascot: { ...DEFAULT_MASCOT, ...config.mascot, roam: v } })
                    }
                    label="...and let it wander over to the pane it means, and run about now and then"
                    hint="Walking to the card is how it says WHICH pane without you reading an id, and every nine minutes or so it chases a ball along the bottom of the window - only ever while it has nothing to say, is where the app put it, and somebody is looking at this window. Off parks it in the bottom-left corner; the bubble and everything you can ask it are unchanged."
                  />
                )}
                {(config.mascot?.enabled ?? DEFAULT_MASCOT.enabled) && (
                  <div className="setting">
                    <label>Which pet</label>
                    <PetPicker
                      value={config.mascot?.pet ?? DEFAULT_MASCOT.pet ?? 'bot'}
                      onChange={(pet) =>
                        onChange({ mascot: { ...DEFAULT_MASCOT, ...config.mascot, pet } })
                      }
                    />
                    <p className="hint">
                      Ten of them, and they cost the same: one drawing, in layers, where the
                      movement is which layer is showing rather than anything being redrawn.
                      Only the one you pick is ever on screen, and all of it stops while the
                      window is minimised.
                    </p>
                  </div>
                )}
                {(config.mascot?.enabled ?? DEFAULT_MASCOT.enabled) && (
                  <div className="setting">
                    <label>Take what it says away after</label>
                    <input
                      className="search"
                      type="number"
                      min={0}
                      max={3600}
                      step={5}
                      value={config.mascot?.hideSeconds ?? HIDE_SECONDS}
                      onChange={(e) =>
                        onChange({
                          mascot: {
                            ...DEFAULT_MASCOT,
                            ...config.mascot,
                            hideSeconds: Number(e.target.value)
                          }
                        })
                      }
                    />
                    <p className="hint">
                      Seconds. Everything it says is a reading - which pane closed, what it
                      was working on, how long ago - and a reading left on screen stops being
                      one: it becomes a box over the corner of the window saying something
                      that was true a while ago. The clock restarts while you are typing at
                      it, and a countdown before a pane is closed is never taken away early,
                      because the press that stops the close is on it. 0 leaves everything up
                      until you press it away.
                    </p>
                  </div>
                )}
                <Switch
                  checked={config.tips?.enabled ?? DEFAULT_TIPS.enabled}
                  onChange={(v) => onChange({ tips: { ...DEFAULT_TIPS, ...config.tips, enabled: v } })}
                  label="Show the occasional tip about what this app can do"
                  hint="A small card in the bottom-right corner, about once every forty minutes, naming one thing that is genuinely hard to find - deleting a highlighted prompt, driving this desk from a phone, handing a pane to another machine mid-turn. It costs nothing: every line is a fixed sentence, there is no model and no request. It stays quiet while a dialog is open, while an update card is up and while any pane is holding a question, and every few tips it carries its own off switch."
                />
                <Switch
                  checked={(config.reclaim?.idleCloseMinutes ?? 0) > 0}
                  onChange={(v) =>
                    onChange({
                      reclaim: {
                        ...DEFAULT_RECLAIM,
                        ...config.reclaim,
                        enabled: true,
                        idleCloseMinutes: v ? IDLE_CLOSE_MINUTES : 0
                      }
                    })
                  }
                  label="Close a pane nobody has touched for a while"
                  hint={`Off, a pane is only ever closed when this machine is genuinely out of memory - which is why a desk with room keeps every pane open for ever, however quiet they are. On, a pane nobody has typed into for ${config.reclaim?.idleCloseMinutes ?? IDLE_CLOSE_MINUTES} minutes is closed whatever the memory says, because an idle agent costs its ~190 MB the whole time it sits there. Nothing is lost: a closed pane keeps its conversation and what was on its screen, and reopening it from History puts both back. The refusals are the same either way - never the pane you are in, never one that is working or starting, never one holding a question, never another device's pane, and never the last one open.`}
                />
                {(config.reclaim?.idleCloseMinutes ?? 0) > 0 && (
                  <div className="setting">
                    <label>Close after (minutes)</label>
                    <input
                      className="search"
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      value={config.reclaim?.idleCloseMinutes ?? IDLE_CLOSE_MINUTES}
                      onChange={(e) =>
                        onChange({
                          reclaim: {
                            ...DEFAULT_RECLAIM,
                            ...config.reclaim,
                            enabled: true,
                            idleCloseMinutes: Number(e.target.value)
                          }
                        })
                      }
                    />
                  </div>
                )}
                <Switch
                  checked={config.autoAnswer?.enabled === true}
                  onChange={(v) =>
                    onChange({
                      autoAnswer: { ...DEFAULT_AUTO_ANSWER, ...config.autoAnswer, enabled: v }
                    })
                  }
                  label="Answer an agent's question for me when the answer is obvious"
                  hint="A CLI that asks 'may I do this?' stops until somebody presses return, and at the desk that press is usually a formality. This reads the options and presses the one that plainly means go on - a single 'Yes'-shaped answer and nothing else. It never picks an option that widens permission ('and don't ask again'), never picks one that stops or asks for a sentence back, and leaves anything with no obvious answer on screen as buttons. A question is only answered after it has sat still for a moment, so you can still reach it first, and only once - a press that does not take is left alone rather than repeated."
                />
                {config.autoAnswer?.enabled === true && (
                  <Switch
                    checked={config.autoAnswer?.anyQuestion === true}
                    onChange={(v) =>
                      onChange({
                        autoAnswer: {
                          ...DEFAULT_AUTO_ANSWER,
                          ...config.autoAnswer,
                          anyQuestion: v
                        }
                      })
                    }
                    label="...and take the CLI's own default for the rest"
                    hint="A question with several real answers ('which of these three shapes?') is a decision you are being asked to make, so by default it waits for you. On, the app takes the row the CLI's own arrow is already on - its preference, not one invented here - and keeps the run moving. The two refusals above still hold."
                  />
                )}
                {config.autoAnswer?.enabled === true && (
                  <Switch
                    checked={config.autoAnswer?.holdWhileWatching !== false}
                    onChange={(v) =>
                      onChange({
                        autoAnswer: {
                          ...DEFAULT_AUTO_ANSWER,
                          ...config.autoAnswer,
                          holdWhileWatching: v
                        }
                      })
                    }
                    label="...but never while you are looking at this window"
                    hint="The wait exists so somebody who disagrees can reach the pane first, which only means anything while nobody is here. On, nothing is pressed for as long as this window has the keyboard - the pane says which option it would press and that it is holding - and the full wait starts from the moment you look away. That is also what makes the Telegram message answerable: the question only ever reaches a phone with this window in the background."
                  />
                )}
                {config.autoAnswer?.enabled === true && (
                  <div className="setting">
                    <label>Wait before answering</label>
                    <Select
                      value={String(config.autoAnswer?.waitMs ?? DEFAULT_AUTO_ANSWER.waitMs)}
                      onChange={(v) =>
                        onChange({
                          autoAnswer: {
                            ...DEFAULT_AUTO_ANSWER,
                            ...config.autoAnswer,
                            waitMs: Number(v)
                          }
                        })
                      }
                      menuWidth={260}
                      options={[
                        { value: '1200', label: '1.2 seconds', hint: 'barely a pause' },
                        { value: '3000', label: '3 seconds' },
                        { value: '5000', label: '5 seconds' },
                        { value: '10000', label: '10 seconds' },
                        { value: '30000', label: '30 seconds', hint: 'plenty of time to disagree' }
                      ]}
                    />
                    <span className="hint">
                      The pane counts this down on the question itself and names the option it is
                      about to press, so an answer never arrives out of nowhere. Pressing any
                      button, or arrowing at the desk, cancels it.
                    </span>
                  </div>
                )}
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
                  hint="Re-applied on every launch, not only when this is switched. The Windows Run entry is exactly the kind of thing an installer or a cleanup tool removes, and its absence reads as 'it did not reopen after a restart' with this switch still showing On."
                />
                {isWindows && (
                  <Switch
                    checked={config.desktopShortcut !== false}
                    onChange={(v) => onChange({ desktopShortcut: v })}
                    label="Keep a PaneForge shortcut on the Desktop"
                    hint="A launch that finds the shortcut missing puts it back. Our own installer used to delete it on every update, and Windows' maintenance task removes desktop shortcuts it decides are broken - either way the app looks uninstalled. An existing shortcut is never rewritten."
                  />
                )}
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
                  <Switch
                    checked={config.stashSummon}
                    onChange={(v) => onChange({ stashSummon: v })}
                    label="Only when I ask for it"
                    disabled={!config.clipboardShelf || !config.clipboardOverlay}
                    hint={keyLabel(
                      'Nothing on screen until you press Ctrl+Alt+V, and then the Stash opens where your pointer already is and puts itself away again. Everything you copy is still captured either way - this is only about whether a pill sits over your other windows waiting to be hovered.'
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
                <label>Never remember</label>
                {/* One rule per LINE, not comma-separated: `{2,3}` is a quantifier and
                    `[a,b]` is a class, so a comma is a character a rule may contain and
                    can never be the separator. */}
                <textarea
                  rows={3}
                  defaultValue={config.stashDeny}
                  placeholder={'one rule per line\nstaging.example.com\n/^ghp_[A-Za-z0-9]{20,}$/'}
                  // On blur rather than per keystroke: every write recompiles the rules,
                  // and half a pattern typed so far is a rule that means something else.
                  onBlur={(e) => onChange({ stashDeny: e.currentTarget.value })}
                />
                <span className="hint">
                  A clip matching any of these is never written to disk at all. Plain words match
                  anywhere, any case; a line wrapped in slashes is a regular expression. A password
                  copied out of 1Password, Bitwarden or KeePassXC is already excluded without
                  this - they mark it, and the Stash honours the mark.
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
                      {/*
                        An agent whose AUTH is a key nobody has pasted starts perfectly:
                        the binary is there, the base URL is set, and the first turn comes
                        back 401 with the pane looking healthy. The key is dropped rather
                        than sent (resolveEnv), but the base URL cannot be - dropping that
                        too would run plain Claude Code inside a pane whose card says GLM,
                        which is worse than an error. So the card says it here instead.
                      */}
                      <span className="hint">
                        {missingKeyFor(a, config) ||
                          (a.available ? a.path : a.note || `${a.bin} not on PATH`)}
                      </span>
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
                {/*
                  One field per provider, drawn off KEY_PROVIDERS rather than written out
                  here: a provider added to the catalogue has to reach this screen by
                  itself, or an agent ships with nowhere to authenticate from and fails as
                  a 401 inside a pane that looks healthy.

                  Password fields because these are read over somebody's shoulder in a
                  room, not because they are secret from the machine - they are in
                  config.json beside the pairing code, same as every other credential here.
                */}
                {KEY_PROVIDERS.map((p) => (
                  <div className="setting" key={p.id}>
                    <label>{p.label} key</label>
                    <input
                      type="password"
                      className="search"
                      placeholder={p.hint}
                      value={config.providerKeys?.[p.id] ?? ''}
                      onChange={(e) =>
                        onChange({ providerKeys: { ...(config.providerKeys ?? {}), [p.id]: e.target.value } })
                      }
                    />
                    <span className="hint">
                      {p.note} Left blank, the agents that ask for it start on whatever login this
                      machine already has.{' '}
                      <button className="ghost small" onClick={() => api.openExternal(p.url)}>
                        Get a key
                      </button>
                    </span>
                  </div>
                ))}
                {/*
                  The key fields above are what a pane authenticates WITH. This is the other
                  half: what it may read. An agent pointed at another provider posts every
                  file it opens to that provider, and a stealth model's provider states that
                  it RETAINS what it is sent - so the control that matters is the folder, and
                  it has to be decided before the pty exists. shared/paneTrust.ts.

                  An allowlist rather than a denylist: a list of forbidden places is wrong
                  the day a new repo is cloned, and it fails silently - the pane opens and
                  the secret leaves. This fails the other way, with a named refusal.
                */}
                <div className="setting">
                  <Switch
                    label="Confine a third-party model to certain folders"
                    hint="An agent on OpenRouter, DeepSeek, Z.ai or Grok posts every file it opens to that provider - and a stealth model's provider keeps what it is sent. With this on, such a pane will only open inside the folders below."
                    checked={!!config.paneTrust?.restrictThirdParty}
                    onChange={(v) =>
                      onChange({ paneTrust: { ...(config.paneTrust ?? {}), restrictThirdParty: v } })
                    }
                  />
                  <textarea
                    className="search"
                    rows={4}
                    spellCheck={false}
                    placeholder={'~/Projects/PaneForge\n~/Projects/toolstash'}
                    value={(config.paneTrust?.allowedRoots ?? []).join('\n')}
                    onChange={(e) =>
                      onChange({
                        paneTrust: {
                          ...(config.paneTrust ?? {}),
                          allowedRoots: e.target.value
                            .split('\n')
                            .map((r) => r.trim())
                            .filter(Boolean)
                        }
                      })
                    }
                  />
                  <span className="hint">
                    One folder per line; everything under it counts. Leave the switch off and
                    nothing is confined - which is what every desk that has not asked for this
                    gets. First-party panes are never confined.
                  </span>
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
                              hint: modelHint(m),
                              group: modelGroup(m)
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
                  anywhere. On a phone, or any narrow window, the mic takes the whole screen instead: a
                  32-pixel target beside a terminal is not a thing you can hit at arm's length.
                </span>
              </div>

              <div className="setting">
                <label>Transcriber</label>
                <Select
                  value={config.voice.engine}
                  onChange={(v) =>
                    onChange({ voice: { ...config.voice, engine: v as VoiceConfig['engine'] } })
                  }
                  menuWidth={320}
                  options={[
                    { value: 'auto', label: 'Pick for me', hint: 'the ladder below' },
                    {
                      value: 'inapp',
                      label: 'Whisper in this window',
                      hint: `nothing to install; ${MODEL_MB[config.voice.model] ?? MODEL_MB.base} MB downloaded once`
                    },
                    {
                      value: 'system',
                      label: 'Whisper on this machine',
                      hint: voiceStatus?.available ? `found: ${voiceStatus.engine}` : 'needs an install'
                    },
                    {
                      value: 'browser',
                      label: "The browser's speech service",
                      hint: 'instant; sends audio off the device'
                    }
                  ]}
                />
                <span className="hint">{voiceChoice.why}</span>
              </div>

              <div className="setting">
                <div className="setting-row">
                  <span className="hint">
                    {voiceStatus?.available
                      ? `A whisper CLI is on PATH (${voiceStatus.engine}), so dictation uses it - it is faster than the in-window model and needs no download.`
                      : 'No whisper CLI on PATH. Dictation runs Whisper in this window instead, which needs nothing installed. Installing one is optional and makes it faster.'}
                  </span>
                  {!voiceStatus?.available && (
                    <button
                      className="ghost"
                      onClick={() => {
                        setInstalling('__voice__')
                        api.installVoice()
                      }}
                    >
                      Install one anyway
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
                  menuWidth={300}
                  options={[
                    { value: 'tiny', label: 'tiny', hint: `fastest, roughest - ${MODEL_MB.tiny} MB` },
                    { value: 'base', label: 'base', hint: `good default - ${MODEL_MB.base} MB` },
                    { value: 'small', label: 'small', hint: `slower, better - ${MODEL_MB.small} MB` }
                  ]}
                />
                <span className="hint">
                  The size is the download the in-window transcriber makes the first time you use it, and
                  never again. A whisper CLI on PATH ignores it and uses its own weights.
                </span>
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
                    checked={!!config.devUpdates}
                    onChange={(v) => onChange({ devUpdates: v })}
                    label="Dev channel: take every build the moment it is cut"
                    hint="New releases start as dev builds and everyone else updates only when one is promoted. On, this install is the proving ground - newer, sooner, less proven."
                  />
                  <Switch
                    checked={config.restoreAfterUpdate}
                    onChange={(v) => onChange({ restoreAfterUpdate: v })}
                    label="Reopen my panes after an update restart"
                    hint="On, an update feels like the app blinked and every pane resumes its conversation. Off, a restart is a clean desk."
                  />
                  <Switch
                    checked={!!config.askAfterUpdate}
                    onChange={(v) => onChange({ askAfterUpdate: v })}
                    disabled={!config.restoreAfterUpdate}
                    label="…and ask first, like every other restart"
                    hint="Off, an update restart is the one restart that never asks - it was the app's own idea, so it hands the desk straight back. On, it offers the panes exactly as a quit or a crash does."
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
