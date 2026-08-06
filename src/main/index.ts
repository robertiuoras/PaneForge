import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  screen,
  shell
} from 'electron'
import { SessionManager, setSilenceAlert } from './sessions'
import { DataPump } from './dataPump'
import { DiscordPresence } from './discordPresence'
import type { PresenceCounts } from '../shared/discordRpc'
import { listProjects } from './projects'
import { routeCandidates } from './projectAliases'
import { routePrompt } from '../shared/projectRoute'
import type { RouteResult } from '../shared/projectRoute'
import { getConfig, setConfig } from './config'
import { addSound, pruneCustomSounds, removeSound, renameSound, soundData } from './sounds'
import { Remote } from './remote'
import { readInvite } from './remote/invite'
import { invalidateAgents, listAgents, specFor } from './agents'
import { gitInfo } from './git'
import { laneExtras, resolveLane } from './lanes'
import { laneWork, mergeLaneBack, repoOf, returnToBase, sweepLanes, trackTyped } from './laneWork'
import { attachLaneOwners, laneBoard, laneReclaim, laneRetry } from './laneBoard'
import type { LanePane } from './laneBoard'
import { resolveRevealTarget } from './revealPath'
import { which } from './which'
import { cancelImprove, improve, resolveEngine, runCli } from './improve'
import { laneBrief, parsePlan, splitPayload, SPLIT_DEADLINE_MS } from './split'
import { cancelResearch, research } from './researchRun'
import { buildContextPack } from './contextPack'
import { stage } from '../shared/capability'
import { firstExistingVault, loadCapabilities } from './knowledge'
import { priorPrompt, recordPrompt } from './promptArchive'
import { recordImprovement } from './promptAudit'
import { insertSequence } from '../shared/promptSchema'
import { adminStatus, disableAdminMode, enableAdminMode, relaunchViaTask } from './admin'
import {
  cancelDeferred,
  checkNow as checkGameNow,
  deferredCount,
  gameState,
  isGameActive,
  gameIsForeground,
  onGameState,
  setFocusProbe,
  refreshGameWatch,
  startGameWatch,
  whenClear
} from './gameMode'
import {
  initProfile,
  isQuietRelaunch,
  markQuietRelaunch,
  profileName,
  revealPlan,
  startMode,
  titleSuffix
} from './profile'
import { crashTestHook, installCrashGuard, onCrashReport } from './crash'
import {
  rememberAppPid,
  spawnDetachedNoWindow,
  sweepOldConsoles,
  sweepOwnConsolesOnExit
} from './consoles'
import { sweepOldStrays, sweepOwnStraysOnExit } from './strays'
import { lastPrompt, resumable, resumeIdFor } from './transcripts'
import {
  clearDesk,
  MAX_DESK_AGE_MS,
  MAX_RESTORE,
  paneMissing,
  readDesk,
  saveDesk,
  saveDeskOnExit,
  setDeskHold,
  startDeskAutosave
} from './restore'
import {
  addRecentFiles,
  clearRecents,
  configureRecents,
  copyRecent,
  flushRecents,
  getRecent,
  listRecents,
  pinRecent,
  recentPath,
  recentText,
  recentsDir,
  refreshRecents,
  removeRecent,
  startRecents,
  stopRecents
} from './recents'
import {
  beginShelfDrag,
  closeShelfWindow,
  dropShelfDrag,
  endShelfDrag,
  liftShelfDrag,
  moveShelfDrag,
  openShelfWindow,
  shownShelfDrag,
  setShelfHidden,
  setShelfQuiet,
  placeShelf,
  setShelfExpanded,
  setShelfTall,
  noteShelfTouch,
  shelfDraggedAt,
  shelfDragging,
  shelfTouchedAt,
  shelfWindowOpen,
  toggleShelf,
  updateShelfConfig,
  updateShelfItems
} from './shelfWindow'
import { ACTIVATION_SETTLE_MS, revealOnActivation } from '../shared/activation'
import { logActivation } from './activationLog'
import { ensurePrereq, onPath, refreshPath, runCommand, runOnce, stopInstalls } from './install'
import { swapAndRelaunch } from './macUpdate'
import {
  checkForUpdates,
  consumeInstallRetry,
  getUpdateState,
  initUpdater,
  installUpdate,
  setAutoCheck,
  updateLog,
  bootMs
} from './updater'
import * as history from './history'
import { readBoard, writeMemory, writeTasks } from './board'
import * as voice from './voice'
import { installCommand, uninstallCommand } from '../shared/agents'
import { installLaneHooks } from './laneHooks'
import { agentsMidTurn } from '../shared/updateHold'
import { STASH_CONFIG_KEYS } from '../shared/types'
import type {
  Config,
  GameModeStatus,
  ImproveOptions,
  ImproveOutcomeKind,
  ImproveResult,
  ImproveStatus,
  InstallOutcome,
  PipeInfo,
  RemoteState,
  ResearchReport,
  RestoreAnswer,
  RestoreOffer,
  RestorePane,
  Session,
  SplitPlan,
  SplitRequest,
  StartSessionRequest,
  StashConfig,
  SwarmRequest,
  TaskItem,
  TurnClock,
  UpdateState
} from '../shared/types'
import type { AgentSpec } from '../shared/agents'
import type { ImproveMetrics } from '../shared/promptBudget'

const manager = new SessionManager()
/** Keeps userData/desk.json in step with the panes on screen. See restore.ts. */
const noteDesk = startDeskAutosave(() => manager.snapshot())
let win: BrowserWindow | null = null
// True while the window is standing in for a maximized one: sized to the work area
// because a real maximize() would have taken focus. See createWindow.
let pseudoMax = false
// A window deliberately left off the screen must not be put back on it by the `activate`
// macOS emits for the launch itself. See the activate handler.
let quietUntil = 0

// First thing in the process: an uncaught error in the main process otherwise opens a
// modal message box that steals focus from whatever you are typing in. Logged instead.
installCrashGuard()
onCrashReport((message) => send('app:error', message))

// Runs before anything reads userData: a named profile (`--profile=dev`) moves the
// whole profile aside so a second PaneForge can run beside the live one. It also sets
// the Windows app id, which ties notifications and the taskbar entry to this app -
// without it the toasts show up as "electron.app.Electron".
const profile = initProfile()

// A second launch (double-clicked shortcut) should raise the window we already have,
// not start a second app with its own set of agents.
/*
 * What this launch was asked to open, worked out HERE, in the process whose argv it is.
 *
 * It cannot be worked out in the app that ends up doing it. Chromium rewrites the command
 * line it hands to `second-instance`: `--open <dir> --prompt <text>` arrives as
 * `[exe, --open, --prompt, <text?>, --allow-file-access-from-files, ., <dir>]` - switches
 * hoisted, values pushed past the positional `.`, one of Electron's own switches spliced
 * into the middle. Reading `argv[i + 1]` there gives `--prompt` where the folder should
 * be, which is why `--open` did nothing whenever PaneForge was already running: the copy
 * that could read the arguments was the copy that was quitting, and it started the pane
 * in itself a moment before it died.
 *
 * `additionalData` is the documented way across, and it carries the answer rather than
 * the question.
 */
const launchRequest = parseOpenArgs(process.argv)

if (!app.requestSingleInstanceLock(launchRequest)) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, _cwd, extra) => {
    // Mid-update the installer launches the new exe while this one is still holding the
    // lock, so that launch arrives here as a second instance. Raising the window then
    // would undo the whole point of the silent update: it pops a dying app to the front
    // over whatever the user is doing. Take the args, leave the focus alone.
    if (!installStarted) focusWindow(true)
    // The other copy's parse when it sent one; its raw argv only as a fallback for a
    // launcher that predates this and cannot pass anything across.
    openRequest(isOpenRequest(extra) ? extra : parseOpenArgs(argv))
  })
}

/** The usable area of whichever display the window was last on. */
function workAreaFor(cfg: Config): Electron.Rectangle {
  const { x, y, width, height } = cfg.window
  const display =
    x === undefined || y === undefined
      ? screen.getPrimaryDisplay()
      : screen.getDisplayMatching({ x, y, width, height })
  return display.workArea
}

function createWindow(): void {
  // Windows and Linux get no application menu: its default accelerators (Ctrl+R reload,
  // Ctrl+W close) fire before the app's own shortcuts and would reload the UI out from
  // under the agents; clipboard keys work in text fields there without one. macOS has no
  // clipboard at all without a menu, and Cmd there cannot collide with the terminal's
  // Ctrl+C, so it gets the standard edit menu.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      : null
  )
  const cfg = getConfig()
  const mode = startMode()
  // A copy that opens minimized keeps its clipboard overlay off the screen too. The
  // main window has always been careful here; the Stash was the one part of the app a
  // test launch still painted over your work. See setShelfQuiet.
  setShelfQuiet(mode === 'minimized')
  // maximize() shows the window as a side effect, and on Windows that show *activates* it:
  // it ends up as a ShowWindow(SW_MAXIMIZE), the exact focus steal showInactive exists to
  // avoid. So a launch that must not take the keyboard (the test copy an agent starts, an
  // update coming back) stands in for a maximized window by filling the display's work
  // area, and becomes a real maximized one the first time it is clicked.
  //
  // The size goes in the constructor, not a setBounds() after: sizing a window that has
  // never been shown makes Windows show and activate it, which measured as a focus steal
  // even with no maximize() left in the path.
  pseudoMax = cfg.window.maximized && mode !== 'normal'
  const area = pseudoMax ? workAreaFor(cfg) : null
  win = new BrowserWindow({
    width: area?.width ?? cfg.window.width,
    height: area?.height ?? cfg.window.height,
    x: area?.x ?? cfg.window.x,
    y: area?.y ?? cfg.window.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101014',
    // The suffix is the only thing separating two identical windows on the taskbar
    // when a test build is running next to the live one.
    title: `PaneForge${titleSuffix()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Chromium slows a hidden window's timers to about once a minute. Here that is the
      // timer that keeps saying "this agent is still running", and minimised is exactly
      // when the app is deciding whether to interrupt you - so the one state where the
      // status has to be right is the one Chromium was degrading. A terminal keeps
      // rendering pty output while minimised regardless, so there is little to save.
      backgroundThrottling: false
    }
  })

  // The page title wins over the BrowserWindow one the moment the renderer loads, so
  // a profile has to re-apply its suffix each time the document title changes.
  if (profile) {
    win.on('page-title-updated', (e, title) => {
      e.preventDefault()
      win?.setTitle(title.includes(titleSuffix()) ? title : `${title}${titleSuffix()}`)
    })
  }

  if (cfg.window.maximized && !pseudoMax) win.maximize()
  // Clicking it is permission to behave like a normal maximized window.
  if (pseudoMax)
    win.once('focus', () => {
      pseudoMax = false
      if (!win?.isMaximized()) win?.maximize()
    })
  win.on('ready-to-show', () => {
    // A person double-clicked the app. That is not an interruption and is never held
    // back, game or no game.
    if (mode === 'normal') {
      updateLog('window', 'shown (normal launch)', `+${bootMs()}ms`)
      return win?.show()
    }
    const plan = revealPlan(mode)
    const reveal = (): void => {
      if (!alive()) return
      // Nothing at all on a Mac: no window ordered front, no genie animation into the
      // Dock, no Dock bounce. The icon is the way back in and `activate` below opens it.
      if (plan === 'hidden') {
        quietUntil = Date.now() + 3000
        updateLog('window', 'held off screen (minimized, darwin)')
        return
      }
      updateLog('window', `shown (${mode})`, `+${bootMs()}ms`)
      // showInactive draws the window without pulling focus off the app you are typing
      // in. minimize() after it, rather than instead of it, because minimizing a window
      // that has never been shown leaves it in a state Windows will not restore from
      // the taskbar.
      win!.showInactive()
      if (plan === 'minimized') win!.minimize()
      // Back from an update: the window is there, on the taskbar, with the panes restored,
      // but it did not take the keyboard. Flash the taskbar button once so it is obvious
      // the app came back instead of silently dying.
      else if (isQuietRelaunch()) win!.flashFrame(true)
    }
    // With a game up, not even this runs: showInactive() measured as enough to drop CS2
    // out of exclusive fullscreen 5.3s into a `npm run try` launch, against a 20s idle
    // baseline that never moved. So the window stays built-but-never-shown until the
    // game exits, and appears on the taskbar then. Checked fresh rather than trusting
    // the poller, because a launch can easily beat the first poll to this line.
    // A reveal that never happens is an app with no window at all - running, on no
    // taskbar, looking exactly like an update that failed to restart. The game check is
    // allowed to hold it back; it is not allowed to lose it, so a failed check reveals
    // anyway and a deferred one says so in the log.
    void checkGameNow()
      .catch(() => undefined)
      .then(async () => {
        // The launch is the one moment the focus probe above is blind by construction: it
        // answers "is our window visible and focused", and the window being asked about is
        // the one that has not been shown yet. So a game merely left running held the
        // reveal back, and the reveal was the only thing that could ever have made the
        // probe true. Measured on this machine: a restart with cs2.exe idling in the
        // background produced a live app with no window and no taskbar button, which is
        // exactly what an update that failed to restart looks like. Ask Windows what is
        // actually on the screen before choosing to have no window at all.
        if (isGameActive() && !(await gameIsForeground())) {
          updateLog('window', `game not on screen (${gameState().game ?? 'unknown'})`, `+${bootMs()}ms`)
          return reveal()
        }
        if (!whenClear('window-reveal', reveal)) {
          updateLog(
            'window',
            `held back until the game exits (${gameState().game ?? 'unknown'})`,
            `+${bootMs()}ms`
          )
        }
      })
  })
  // Coming back to the window is when the image you copied in another app matters, and
  // reading the clipboard on focus is what keeps the shelf's polling cheap the rest of
  // the time. See recents.ts.
  win.on('focus', () => {
    win?.flashFrame(false)
    refreshRecents()
    // Focus is the fastest answer there is to "is a game holding the display" - it is
    // not - so do not make a held update or a held window wait up to 15s for the poller
    // to work that out. Blur is checked too, for the other direction.
    void checkGameNow().catch(() => undefined)
  })
  win.on('blur', () => void checkGameNow().catch(() => undefined))
  // The clipboard overlay lives in the corner of the display this window is on, so it
  // moves with it - to the second monitor, or back.
  win.on('move', placeShelf)
  win.on('restore', placeShelf)

  /**
   * Tell the page whether anyone can see it.
   *
   * The page cannot work this out for itself: `backgroundThrottling: false` (above) also
   * stops Chromium ever moving the document to the hidden state, so `document.hidden` is
   * false on a minimised window and `visibilitychange` never fires. Measured, not
   * assumed - which also means the `if (document.hidden) return` guards the polling
   * badges carry had never skipped a single poll. This is the signal they use instead.
   */
  const pushVisible = (): void => send('app:visible', !win?.isMinimized() && !!win?.isVisible())
  win.on('minimize', pushVisible)
  win.on('restore', pushVisible)
  win.on('show', pushVisible)
  win.on('hide', pushVisible)
  win.webContents.on('did-finish-load', pushVisible)
  // A test copy nobody ever looked at closes itself.
  //
  // An agent starts one minimized, measures something, and does not always get to run
  // `--close` - a session ends, a command fails, the turn moves on. What is left is a
  // second PaneForge sitting in alt-tab for the rest of the day, showing whatever state
  // the test left it in (including, once, a deliberate crash-drill message that read
  // exactly like the real app had broken). Only ever applies to a named profile that
  // was launched out of sight, and any sign of a human - showing it, focusing it,
  // restoring it - cancels it for good.
  if (profile && mode === 'minimized') {
    const idleQuit = setTimeout(() => {
      console.log('Test copy was never opened - closing itself so it does not linger.')
      app.quit()
    }, 30 * 60_000)
    // Not the `show` event: the launch itself calls showInactive() before minimizing,
    // so that fires for every test copy and would cancel this immediately.
    const keepAlive = (): void => clearTimeout(idleQuit)
    win.once('focus', keepAlive)
    win.once('restore', keepAlive)
  }
  // Same signal, for the overlay: once a human has the window on screen, this is an
  // app they are using and the Stash belongs on top again.
  const wanted = (): void => setShelfQuiet(false)
  win.once('focus', wanted)
  win.once('restore', wanted)
  win.on('close', rememberBounds)
  // Without this the module keeps a destroyed BrowserWindow, and every later
  // `win?.` call throws "Object has been destroyed" instead of no-opping.
  win.on('closed', () => {
    win = null
    // Output batched for a window that no longer exists has nowhere to go. send()
    // already no-ops on a dead window; this stops the pump holding the string and
    // waking a timer to deliver it to nobody.
    pump.discard()
    // The overlay is a window too, so leaving it open would make `window-all-closed`
    // never fire and the app would stay alive with nothing on screen but a pill.
    closeShelfWindow()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // The menu is gone, so devtools needs its own key.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The window can be gone (quit) or destroyed-but-still-referenced (teardown order)
// while pty output and session events are still in flight.
function alive(): boolean {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
}

function send(channel: string, ...args: unknown[]): void {
  if (!alive()) return
  win!.webContents.send(channel, ...args)
}

function rememberBounds(): void {
  if (!alive()) return
  const w = win!
  // A window still standing in for a maximized one (shown without focus, never clicked)
  // must save itself as maximized, or the next launch opens at work-area size instead.
  const maximized = w.isMaximized() || pseudoMax
  // getBounds() on a maximized window returns the screen size, which would make the
  // restored window unrestorable, so keep the normal bounds instead.
  const b = maximized ? w.getNormalBounds() : w.getBounds()
  setConfig({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

/**
 * Bring the window up. `asked` marks the paths where a person deliberately reached for
 * the app (double-clicking the shortcut, clicking a toast); those still work mid-game.
 * Everything else - a hotkey that only wanted the microphone, the app deciding it has
 * something to say - is dropped while a game is on screen rather than queued, because
 * a window that pops up half an hour later, for a reason that has passed, is its own
 * kind of interruption.
 */
function focusWindow(asked = false): void {
  if (!asked && isGameActive()) return
  if (!alive()) return createWindow()
  const w = win!
  if (w.isMinimized()) w.restore()
  // A quiet launch on macOS leaves the window built but never shown, and focus() on a
  // window that is not on screen does nothing at all - the app would come to the front
  // with no window in it. Every caller here is a person asking for the app.
  if (!w.isVisible()) w.show()
  w.focus()
}

// Fan pty output and session-list changes out to the renderer. A dead window drops
// them: send() checks first, because webContents.send() on a destroyed window throws.
//
// Output does NOT go straight down the wire. A pty streaming a real log measured at
// 7,359 chunks/second at a median of 41 bytes, and each one was its own IPC message;
// the pump gathers them per pane and sends at most one message per pane every 8ms.
// See dataPump.ts. Everything that would reorder or lose output flushes it first.
const pump = new DataPump((id: string, data: string) => send('pty:data', id, data))

manager.on('data', (id: string, data: string) => {
  pump.push(id, data)
})
manager.on('sessions', () => {
  // A pane's last output has to reach the renderer before the list says it exited,
  // or the final lines land after the pane has already been drawn as dead.
  pump.flush()
  send('sessions:changed', allSessions())
  // Every pane start, exit, rename and agent switch arrives here, which is the
  // whole of "the desk changed". Debounced inside: a swarm launch is six of these
  // in a second and they are worth one write.
  noteDesk()
  presence.update(presenceCounts())
})

// Discord Rich Presence: "3/6 sessions running" on the user's profile, refreshed as
// turns start and finish. Local panes only - a mirrored pane is counted by the device
// its agent actually runs on, which is already reading the same frame.
const appStartedAt = Date.now()
const presence = new DiscordPresence({
  enabled: getConfig().discordPresence,
  style: getConfig().discordStyle,
  // The Discord tab reports Discord's own answer rather than guessing from the switch,
  // so every change of that answer has to reach an open Settings dialog by itself.
  onStatus: (s) => send('discord:status', s)
})
function presenceCounts(): PresenceCounts {
  const live = manager.list().filter((s) => s.status !== 'exited')
  const running = live.filter((s) => s.status === 'working')
  const names: string[] = []
  for (const s of running) {
    const name = basename(s.cwd)
    if (name && !names.includes(name)) names.push(name)
  }
  const since = running.map((s) => s.runSince).filter((n): n is number => !!n)
  return {
    running: running.length,
    total: live.length,
    names,
    oldestRunSince: since.length ? Math.min(...since) : undefined,
    appStart: appStartedAt
  }
}
manager.on('attention', (s: Session) => raiseAttention(s))
manager.on('stalled', (s: Session) => raiseStalled(s))
manager.on('bell', (s: Session) => raiseBell(s))

/**
 * A running turn that has said nothing for minutes, and a terminal bell.
 *
 * Both go out on their own channel and neither reuses `raiseAttention`, because that
 * function's notification says "finished or needs input" - which is the one thing
 * these two know is NOT true. They share its manners: nothing while a game is on
 * screen, no toast while the window is focused (the pane is on screen and says it
 * itself), and the sound is left to the renderer.
 */
function raiseStalled(s: Session): void {
  send('sessions:stalled', s)
  if (!getConfig().notifyOnIdle || isGameActive()) return
  if (!alive() || win!.isFocused()) return
  win!.flashFrame(true)
  if (!Notification.isSupported()) return
  const mins = Math.round((Date.now() - (s.stalledSince ?? Date.now())) / 60_000)
  new Notification({
    title: `${s.title} has gone quiet`,
    body: `Still running after ${mins || 1} min with nothing printed. It may be stuck or waiting.`,
    silent: true
  })
    .on('click', () => focusWindow(true))
    .show()
}

function raiseBell(s: Session): void {
  send('sessions:bell', s)
  if (!getConfig().bellAlert || isGameActive()) return
  if (!alive() || win!.isFocused()) return
  win!.flashFrame(true)
}

function raiseAttention(s: Session): void {
  // The chime is the renderer's job (Web Audio gives a far nicer sound than the
  // Windows toast ding) and it plays whether or not the app has focus: the point
  // is to tell you a turn ended while you were reading something else on screen.
  send('sessions:attention', s)
  if (!getConfig().notifyOnIdle) return
  // A game is on screen: the chime above still plays (sound costs you nothing mid-round)
  // but the taskbar flash and the toast do not. Both are drawn by the shell on top of a
  // fullscreen game and both can take it off the display - the exact thing this is
  // meant to tell you about while you are busy with something else.
  if (isGameActive()) return
  // The toast and the taskbar flash only make sense when you are elsewhere.
  if (!alive() || win!.isFocused()) return
  win!.flashFrame(true)
  if (Notification.isSupported()) {
    new Notification({
      // A pane finishing on the other machine is the whole point of the feature, so
      // it gets told the same way - with the device named, because "which machine"
      // is the one thing you cannot tell from the pane title.
      title: s.remote ? `${s.title} is waiting on ${s.remote.name}` : `${s.title} is waiting`,
      body: `${s.agent} finished or needs input.`,
      // Our own chime already played; the system ding on top of it is noise.
      silent: true
    })
      .on('click', () => focusWindow(true))
      .show()
  }
}

// ---------------------------------------------------------------------------
// Other devices
//
// A paired device's panes are mirrored into this window and behave like local ones.
// The seam is the session id: anything namespaced `@device/id` is forwarded over the
// link instead of being handed to the pty manager, so every path above this line -
// the sidebar, the palette, the shortcuts, the grid - stays unaware there are two
// machines involved.

const remote = new Remote({
  list: () => manager.list(),
  buffer: (id) => manager.buffer(id),
  write: (id, data) => manager.write(id, data),
  resize: (id, cols, rows) => manager.resize(id, cols, rows),
  redraw: (id) => manager.redraw(id),
  setBusy: (id, busy, tail, clock) => manager.setBusyOnScreen(id, busy, tail, clock),
  clearAttention: (id) => manager.clearAttention(id),
  kill: (id) => manager.kill(id),
  restart: (id) => manager.restart(id),
  rename: (id, title) => manager.rename(id, title),
  switchAgent: (id, agent, model) => manager.switchAgent(id, agent, model),
  // A guest's launch goes through the same lane split a local one does: two agents
  // in one repo must not share a checkout just because one of them is remote.
  startSession: async (req) => manager.start(await laneFor(req)),
  projects: () => Promise.resolve(listProjects()),
  agents: () => Promise.resolve(listAgents()),
  onData: (cb) => {
    manager.on('data', cb)
    return () => manager.off('data', cb)
  },
  onSessions: (cb) => {
    manager.on('sessions', cb)
    return () => manager.off('sessions', cb)
  },
  onAttention: (cb) => {
    manager.on('attention', cb)
    return () => manager.off('attention', cb)
  }
})

/** Local panes and mirrored ones, as one list. This is what the renderer ever sees. */
function allSessions(): Session[] {
  return [...manager.list(), ...remote.sessions()]
}

remote.on('data', (id: string, data: string) => pump.push(id, data))
// The link came back and the whole scrollback arrived again: the pane has to start
// from scratch rather than append a second copy of what it was already showing.
// Anything still pending for that pane belongs to the old stream, so it goes out
// ahead of the reset rather than arriving after it and painting onto the fresh one.
remote.on('reset', (id: string) => {
  pump.flushOne(id)
  send('pane:reset', id)
})
remote.on('sessions', () => {
  pump.flush()
  send('sessions:changed', allSessions())
})
remote.on('attention', (s: Session) => raiseAttention(s))
remote.on('changed', (state: RemoteState) => send('remote:changed', state))

ipcMain.handle('projects:list', () => listProjects())
ipcMain.handle('projects:route', (_e, text: string) => routeText(text))
ipcMain.handle('agents:list', (_e, force?: boolean) => listAgents(force))
ipcMain.handle('sessions:list', () => allSessions())
/**
 * Move a second session in the same folder into its own git worktree, so two
 * agents in one project cannot overwrite each other's edits or race the index.
 * Folders already held by live sessions are what "in use" means, so a lane freed
 * by a closed session gets reused instead of a new one piling up.
 *
 * A swarm is deliberately exempt: its roles are briefed to share one checkout.
 */
async function laneFor(
  req: StartSessionRequest,
  extraTaken: string[] = []
): Promise<StartSessionRequest> {
  if (!getConfig().autoLane) return req
  const taken = [
    ...manager
      .list()
      .filter((s) => s.status !== 'exited')
      .map((s) => s.cwd),
    ...extraTaken
  ]

  // Reopening a pane that was in a lane, when the lane turned out to hold nothing and
  // the project folder is free again: the lane was only ever there to keep two agents
  // apart, and there is no second agent now. Without this, one busy afternoon leaves a
  // project permanently worked on from `-w2` while its own folder sits empty.
  const home = await returnToBase(req.cwd, taken)
  if (home) {
    return {
      ...req,
      cwd: home,
      lane: undefined,
      laneEnv: undefined,
      laneNote: `Lane was empty - back in ${basename(home)}`
    }
  }

  const lane = await resolveLane(req.cwd, taken)
  if (lane.cwd === req.cwd) {
    // Reopening a pane that is already in its lane (workspace restore, or after an
    // update): nothing to move, but it still needs its port and its shared memory.
    if (req.lane)
      return { ...req, laneEnv: req.laneEnv ?? (await laneExtras(req.cwd, req.lane)).env }
    return lane.note ? { ...req, laneNote: lane.note } : req
  }
  const memory = lane.sharedMemory ? ', sharing this project’s Claude memory' : ''
  return {
    ...req,
    cwd: lane.cwd,
    lane: lane.lane,
    laneEnv: lane.env,
    laneNote: `Opened lane ${lane.lane} on ${lane.branch} - PORT=${lane.port}${memory}`
  }
}

ipcMain.handle('sessions:start', async (_e, req: StartSessionRequest) =>
  manager.start(await laneFor(req))
)
ipcMain.handle('sessions:startMany', async (_e, reqs: StartSessionRequest[]) => {
  const out: Session[] = []
  // Folders claimed earlier in this same batch count as taken: two panes launched
  // together for one project must land in different lanes, and the session list
  // has not caught up mid-loop.
  const claimed: string[] = []
  for (const r of reqs) {
    try {
      const req = await laneFor(r, claimed)
      claimed.push(req.cwd)
      out.push(manager.start(req))
    } catch {
      // One missing folder should not abort the rest of a workspace launch.
    }
  }
  return out
})
ipcMain.handle('sessions:restart', (_e, id: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'restart' }), null
  return manager.restart(id)
})
ipcMain.handle('sessions:switchAgent', (_e, id: string, agent: string, model?: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'switch', agent, model }), null
  return manager.switchAgent(id, agent, model)
})
ipcMain.handle('sessions:rename', (_e, id: string, title: string) =>
  remote.owns(id) ? remote.send(id, { t: 'rename', title }) : manager.rename(id, title)
)
ipcMain.handle('sessions:kill', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'kill' }) : manager.kill(id)
)
ipcMain.handle('sessions:buffer', (_e, id: string) =>
  remote.owns(id) ? remote.buffer(id) : manager.buffer(id)
)
/**
 * Tee a pane's output to a file while it runs (tmux's `pipe-pane`), or stop.
 *
 * The save dialog is only ever reached from a click, which is what makes it allowed
 * here at all - nothing the app decided by itself may put a window on screen. A
 * mirrored pane is refused rather than teed: its bytes are produced on the other
 * machine and the file would be written on this one, half a frame behind, which is a
 * transcript of a link rather than of a run.
 */
ipcMain.handle(
  'sessions:pipe',
  async (
    e,
    id: string,
    opts: { path?: string; text?: boolean; append?: boolean } | null
  ): Promise<PipeInfo | null> => {
    if (remote.owns(id)) return null
    if (!opts) return manager.pipe(id, null)
    let path = opts.path
    if (!path) {
      const s = manager.list().find((x) => x.id === id)
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const r = await dialog.showSaveDialog(win as BrowserWindow, {
        title: 'Tee this pane to a file',
        defaultPath: join(app.getPath('downloads'), `${safeName(s?.title ?? id)}-${stamp}.log`),
        filters: [
          { name: 'Log', extensions: ['log', 'txt'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (r.canceled || !r.filePath) return null
      path = r.filePath
    }
    return manager.pipe(id, { path, text: opts.text, append: opts.append })
  }
)

/** A pane title is free text and ends up in a filename. */
function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pane'
}
/**
 * The sidebar was dragged into a new order. Only local panes can be moved here - a
 * mirrored pane belongs to the machine running it, and its place in that machine's
 * list is not this window's to change - so the ids are handed over as they come and
 * the manager keeps the ones it owns. The window that did the dragging holds the full
 * order (mirrors included) itself, so the drop looks the same either way.
 */
ipcMain.on('sessions:reorder', (_e, ids: string[]) => manager.reorder(ids))
ipcMain.on('sessions:bell', (_e, id: string) => manager.bell(id))
ipcMain.on('sessions:attention-clear', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'ack' }) : manager.clearAttention(id)
)
ipcMain.on('pty:write', (_e, id: string, data: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'write', data })
  watchForClear(id, data)
  manager.write(id, data)
})

/** What each pane has typed since its last Enter - only ever used to spot `/clear`. */
const typedLine = new Map<string, string>()

/**
 * Notice when a pane's conversation is cleared, so a pointless lane can be handed back.
 *
 * A lane exists to keep two agents in one project from overwriting each other. After
 * /clear there is no conversation left to protect, and if the lane is also empty - no
 * commits, nothing uncommitted - then the pane is sitting in a second checkout, on a
 * branch nobody will merge, with its own dev port, for no reason at all. So it goes home
 * to the project folder, and the empty lane is deleted behind it.
 *
 * Read from the keystrokes rather than from the CLI's output because output is a moving
 * target across agents and versions, while `/clear` + Enter is what the person typed. A
 * pane with real work in its lane is never moved, whatever it types.
 */
function watchForClear(id: string, data: string): void {
  if (!data || !getConfig().autoLane) return
  const { line, submitted } = trackTyped(typedLine.get(id) ?? '', data)
  typedLine.set(id, line)
  if (submitted.some((l) => l === '/clear')) void laneWentQuiet(id)
}

/** Every folder a live pane is sitting in - what "this lane is in use" means. */
function busyDirs(): string[] {
  return allSessions()
    .filter((s) => s.status !== 'exited')
    .map((s) => s.cwd)
}

async function laneWentQuiet(id: string): Promise<void> {
  const before = manager.list().find((s) => s.id === id)
  if (!before?.lane) return
  // The CLI needs a moment to actually clear, and the lane needs to still be empty
  // after whatever that pane was doing has settled.
  await new Promise((r) => setTimeout(r, 2000))
  const s = manager.list().find((x) => x.id === id)
  if (!s || s.status === 'exited' || !s.lane || s.cwd !== before.cwd) return
  const home = await returnToBase(
    s.cwd,
    busyDirs().filter((d) => d !== s.cwd)
  )
  if (!home) return

  const lane = s.lane
  const repo = home
  manager.moveTo(id, home, {
    lane: undefined,
    laneEnv: undefined,
    laneNote: `Cleared - back in ${basename(home)}`
  })
  send('lane:moved', id, `Cleared, and lane ${lane} was empty - this pane is back in ${basename(home)}`)
  // The pane has left, so the folder is free to go. Anything that was in it would have
  // stopped returnToBase() above.
  void sweepLanes(repo, busyDirs())
}
/**
 * A mirrored pane is never resized from here.
 *
 * Two windows on two machines cannot both own one pty's size: whichever resized last
 * would win, the other would refit, and the two would trade SIGWINCHes at each other
 * for as long as both were open - with a full-screen CLI redrawing its entire frame
 * every round. The device the agent runs on owns the size; the mirror is drawn at the
 * host's own cols/rows and scaled to fit whatever window is watching it.
 */
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  if (!remote.owns(id)) manager.resize(id, cols, rows)
})
ipcMain.on('pty:redraw', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'redraw' }) : manager.redraw(id)
)
/**
 * Same reasoning: "is the agent still running" is read off the rendered frame, and the
 * device the agent runs on is already reading it in its own window. A second opinion
 * arriving from a mirror that is a few frames behind could only ever contradict the
 * first one, and a false "finished" is the chime going off mid-turn.
 */
ipcMain.on(
  'sessions:busy',
  (_e, id: string, busy: boolean, tail?: string, clock?: TurnClock) => {
    if (!remote.owns(id)) manager.setBusyOnScreen(id, busy, tail, clock)
  }
)

ipcMain.handle('sessions:swarm', (_e, req: SwarmRequest) => manager.startSwarm(req))

// --- split one task across lanes -------------------------------------------
//
// A swarm shares a checkout because its roles interleave. A split does the opposite:
// every workstream is moved into its own git worktree, through the same `laneFor` the
// session list uses, so two agents cannot reach the same file rather than being asked
// not to. main/split.ts explains why that is the difference worth having.
ipcMain.handle(
  'sessions:planSplit',
  async (_e, req: { cwd: string; mission: string; agent?: string }): Promise<SplitPlan> => {
    const nothing = (refused: string): SplitPlan => ({ lanes: [], contracts: '', refused })
    if (!req.mission.trim()) return nothing('Describe the task first.')

    const cfg = getConfig().promptImprove
    const specs = listAgents(false).map((a) => a as AgentSpec)
    const engine = resolveEngine(cfg.engine, req.agent ?? '', specs, cfg.model)
    if (!engine) return nothing('No coding CLI on PATH to plan the split with.')

    // The top level of the repository, so the plan claims paths that exist. Only the
    // top level: a full tree is most of a context window and the planner is choosing
    // owners, not writing the code.
    let tree: string[] = []
    try {
      tree = readdirSync(req.cwd, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
    } catch {
      /* a folder we cannot list still gets a plan, just a blinder one */
    }

    const out = await runCli(engine, splitPayload(req.mission, tree), {
      key: `split:${req.cwd}`,
      // Its own deadline, not improvement's: a plan is a much longer answer than a
      // rewritten prompt, and 90s was measured to be under what it costs. See
      // SPLIT_DEADLINE_MS for the number that was measured.
      deadlineMs: SPLIT_DEADLINE_MS
    })
    return out ? parsePlan(out) : nothing('The planner produced no answer.')
  }
)

ipcMain.handle('sessions:split', async (_e, req: SplitRequest): Promise<Session[]> => {
  const lanes = req.plan.lanes.filter((l) => l.enabled !== false)
  if (!lanes.length) return []
  const plan: SplitPlan = { ...req.plan, lanes }
  const out: Session[] = []
  // Same claim list as a workspace launch: the session list has not caught up mid-loop,
  // so without this every lane would be handed the same free worktree.
  const claimed: string[] = []
  for (const [i, lane] of lanes.entries()) {
    try {
      const started = await laneFor(
        {
          cwd: req.cwd,
          title: lane.name,
          role: lane.name,
          agent: req.agent as StartSessionRequest['agent'],
          model: req.model,
          prompt: laneBrief(plan, i, req.mission),
          // Staggered like a swarm, and for a second reason here: each launch may have
          // to create a worktree, and N `git worktree add` on one repository at once
          // is a fight over one index lock.
          promptDelay: i * 900
        },
        claimed
      )
      claimed.push(started.cwd)
      out.push(manager.start(started))
    } catch {
      // One lane that could not be made must not cost the others their launch.
    }
  }
  return out
})

ipcMain.handle('config:get', () => getConfig())
ipcMain.handle('config:set', (_e, patch: Partial<Config>) => {
  const next = setConfig(patch)
  // An edited custom agent changes what is launchable, so the availability cache
  // must not outlive the edit.
  if (patch.customAgents) invalidateAgents()
  if (patch.saveHistory !== undefined) history.setHistoryEnabled(patch.saveHistory)
  if (patch.discordPresence !== undefined || patch.discordStyle !== undefined) {
    presence.configure(next.discordPresence, next.discordStyle)
    presence.update(presenceCounts())
  }
  if (patch.silenceAlertMin !== undefined) setSilenceAlert(patch.silenceAlertMin)
  if (patch.autoUpdate !== undefined) setAutoCheck(patch.autoUpdate)
  if (patch.voice !== undefined) applyVoiceHotkey(next)
  if (patch.gameMode !== undefined) refreshGameWatch(next)
  if (patch.clipboardShelf !== undefined) applyClipboardShelf(next)
  else if (patch.clipboardOverlay !== undefined) applyShelfOverlay(next)
  // The Stash caps apply to what is already on it, not only to the next thing added, so
  // they go through even when the watcher itself was not touched.
  if (
    patch.stashMaxItems !== undefined ||
    patch.stashMaxImages !== undefined ||
    patch.stashFileHours !== undefined ||
    patch.stashMaxFileMb !== undefined
  ) {
    applyStashCaps(next)
  }
  send('config:changed', next)
  // The overlay draws the same settings behind its gear, so it hears about them too.
  updateShelfConfig(stashConfig(next))
  return next
})
/**
 * What Discord itself last said about the presence.
 *
 * The settings tab used to describe what the app INTENDED to send, which is the one thing
 * that was never in doubt. This is the other end: the application name Discord resolved,
 * the lines it stored, or the reason it refused - all of it read back off the pipe.
 */
ipcMain.handle('discord:status', () => presence.status())

ipcMain.handle('config:pickRoot', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose the folder that holds your projects',
    defaultPath: getConfig().root,
    properties: ['openDirectory']
  })
  return r.canceled ? null : r.filePaths[0]
})

// The sound picker's four jobs. Everything that touches the sounds folder is here, so
// the renderer never learns where it is - it asks for bytes by id.
ipcMain.handle('sounds:add', () => addSound(win))
ipcMain.handle('sounds:data', (_e, id: string) => soundData(id))
ipcMain.handle('sounds:remove', (_e, id: string) => {
  const next = removeSound(id)
  send('config:changed', getConfig())
  return next
})
ipcMain.handle('sounds:rename', (_e, id: string, name: string) => {
  const next = renameSound(id, name)
  send('config:changed', getConfig())
  return next
})

ipcMain.on('shell:reveal', (_e, path: string) => {
  // A folder opens. A FILE gets its folder opened with the file already selected, which is
  // what "show me where this is" means for a path an agent just printed - openPath on a
  // file would launch it in whatever app owns the extension instead, and a .pdf or a .ts
  // suddenly opening in a viewer is not what the click asked for.
  let file = false
  try {
    file = statSync(path).isFile()
  } catch {
    return /* gone: pointing Explorer at it would just raise an error dialog */
  }
  if (file) shell.showItemInFolder(path)
  else shell.openPath(path)
})

/**
 * Is this string, printed in a pane running in `cwd`, a real path on this machine?
 *
 * The renderer asks per token before it draws a link, so this is on the hover path and has
 * to stay a single stat. Returns null for everything that is not there, which is most of
 * what a loose text matcher hands it.
 */
ipcMain.handle('shell:pathKind', (_e, cwd: string, token: string) =>
  resolveRevealTarget(cwd ?? '', token ?? '')
)
ipcMain.handle('shell:editor', (_e, path: string) => {
  // VS Code / Cursor ship a `code`-style launcher on PATH; without one, fall back to
  // Explorer so the button still does something useful.
  for (const bin of ['cursor', 'code']) {
    const exe = which(bin)
    if (exe === bin) continue
    try {
      // The code/cursor launcher is a console app: raw detached spawn = a visible
      // Terminal window on Win11 (see spawnDetachedNoWindow).
      spawnDetachedNoWindow(exe, [path])
      return null
    } catch {
      /* try the next one */
    }
  }
  shell.openPath(path)
  return 'No `cursor` or `code` on PATH - opened the folder instead.'
})

ipcMain.handle('git:info', (_e, path: string) =>
  // A folder with an agent mid-turn in it is the one that keeps the fast poll: it is the
  // only way the working tree changes while the app is looking at it.
  gitInfo(
    path,
    manager.list().some((s) => s.cwd === path && s.status === 'working')
  )
)
/**
 * The panes a lane hold can belong to. Local only: the lane state file is this machine's,
 * and a mirrored pane's conversation lives on the device that runs it.
 */
const lanePanes = (): LanePane[] =>
  manager
    .list()
    .filter((s) => s.status !== 'exited')
    .map((s) => ({ id: s.id, cwd: s.cwd, resumeId: resumeIdFor(s.id) }))

ipcMain.handle('lanes:board', () => {
  const panes = lanePanes()
  return attachLaneOwners(laneBoard(panes), panes)
})

// A worktree lane of the user's own project: what is in it, and putting it back.
ipcMain.handle('lanes:work', (_e, cwd: string) => laneWork(cwd))
ipcMain.handle('lanes:merge', async (_e, cwd: string) => {
  const result = await mergeLaneBack(cwd, { busy: busyDirs() })
  // A lane that merged while its own pane was still in it is now empty, and will be
  // swept the moment that pane closes or is cleared.
  if (result.ok) send('sessions:changed', allSessions())
  return result
})

/**
 * Delete the lanes that hold nothing, everywhere the desk is currently working.
 *
 * Lanes are created without being asked, so they have to disappear the same way. A lane
 * whose commits went back into main passes the "holds nothing" test by itself, which
 * makes this the auto-delete for merged lanes as well as for the ones that were never
 * used. Anything with a commit, an uncommitted file or a session in it is skipped, so
 * the worst case is a folder that lives one sweep longer than it needed to.
 */
let sweptAt = 0
async function sweepEmptyLanes(): Promise<void> {
  const now = Date.now()
  if (now - sweptAt < 5 * 60_000) return
  sweptAt = now
  const busy = busyDirs()
  for (const repo of await knownRepos()) {
    try {
      // A pane that ended in a lane keeps the folder on screen after the folder is
      // gone, and restarting it would fail on a path the user never typed. So each
      // removed lane hands its card back to the project it belongs to.
      for (const dir of await sweepLanes(repo, busy)) manager.relocate(dir, repo)
    } catch {
      /* a repo that vanished under us is not worth a crash on a tidy-up */
    }
  }
}
// A stuck lane is retried on a clock rather than only when some chat happens to run a
// lane command, so the ones that come unstuck by themselves do it overnight too. Both
// the interval and laneRetry are no-ops on a machine with no PaneForge checkout, and it
// returns immediately unless a lane is conflicted or waiting to go out.
setInterval(() => {
  laneRetry(lanePanes())
  // And the lanes held by chats that are not here any more: a killed pane never runs its
  // SessionEnd hook, so its lane sat held - and blocking the release - for twelve hours.
  laneReclaim(lanePanes())
  // Same clock, different lanes: the user's own worktree lanes, tidied when they are
  // empty. Throttled to five minutes inside, and a no-op for a repo with no lanes.
  void sweepEmptyLanes()
}, 60_000).unref()

/**
 * Every project this window knows about, as repository roots: the panes on screen, the
 * workspaces, and the projects folder itself. A lane is created beside a repo and can
 * outlive every pane that ever opened it, so the sweep below cannot only look at what
 * is open right now or a project's last lane would never be cleared.
 */
async function knownRepos(): Promise<string[]> {
  const folders = [
    ...manager.list().map((s) => s.cwd),
    ...getConfig().presets.flatMap((p) => p.items.map((i) => i.path)),
    ...listProjects().map((p) => p.path)
  ]
  // One `git rev-parse` per folder, and a desk with every project open has plenty of
  // them. They do not depend on each other, so they go out together rather than one
  // after another - this used to be the front half of an eight-second freeze.
  const found = await Promise.all([...new Set(folders.filter(Boolean))].map((f) => repoOf(f)))
  return [...new Set(found.filter((r): r is string => Boolean(r)))]
}

// A pane ending is when a lane most often stops being needed, and waiting up to five
// minutes to notice leaves a folder on screen that has nothing in it. Deferred so the
// sweep's git calls are never on the path of the pane list redrawing.
manager.on('sessions', () => {
  if (laneSweepQueued) return
  laneSweepQueued = true
  setTimeout(() => {
    laneSweepQueued = false
    sweptAt = 0
    void sweepEmptyLanes()
  }, 3000).unref()
})
let laneSweepQueued = false

// Other devices. Every one of these answers with the whole state, so the dialog never
// has to guess what a change did - it just redraws what it is handed.
ipcMain.handle('remote:state', () => remote.state())
ipcMain.handle('remote:host', (_e, on: boolean) => {
  remote.setHosting(!!on)
  return remote.state()
})
ipcMain.handle('remote:port', (_e, port: number) => {
  remote.setPort(Number(port))
  return remote.state()
})
ipcMain.handle('remote:rotate', () => {
  remote.rotateCode()
  return remote.state()
})
ipcMain.handle('remote:rename', (_e, name: string) => {
  remote.rename(String(name ?? ''))
  return remote.state()
})
ipcMain.handle(
  'remote:pair',
  async (_e, input: { address: string; port: number; code: string; name?: string }) => {
    const error = await remote.pair(input)
    return { ok: !error, error: error || undefined, state: remote.state() }
  }
)
/** One line to copy on the device you are leaving. */
ipcMain.handle('remote:invite', () => remote.invite())
/** ...and one paste on the device you are picking up. */
ipcMain.handle('remote:pairText', async (_e, text: string) => {
  const res = await remote.pairFromText(String(text ?? ''))
  return { ...res, state: remote.state() }
})
/**
 * Is there already an invite on this machine's clipboard?
 *
 * The whole point of the invite is that pairing is copy-then-paste; noticing the paste
 * has already happened removes the second half of that too - open Devices on the second
 * machine and the button is there. Only the parsed name and expiry cross into the
 * renderer: the clipboard's actual contents are none of its business, and the code
 * inside stays in the main process until pairing uses it.
 */
/** Pair straight from that clipboard invite, without the text passing through a window. */
ipcMain.handle('remote:pairClipboard', async () => {
  const res = await remote.pairFromText(clipboard.readText())
  return { ...res, state: remote.state() }
})
ipcMain.handle('remote:clipboardInvite', () => {
  const read = readInvite(clipboard.readText())
  if (read.kind !== 'invite') return null
  return { name: read.invite.name, expires: read.invite.expires }
})
ipcMain.handle('remote:forget', (_e, id: string) => {
  remote.forget(String(id))
  return remote.state()
})
ipcMain.handle('remote:connect', (_e, id: string, on: boolean) => {
  remote.setConnected(String(id), !!on)
  return remote.state()
})
ipcMain.handle('remote:scan', () => {
  remote.scan()
  return remote.state()
})
// Opening a pane on the other machine. The folder list has to come from there too -
// this machine's projects root says nothing about what is checked out over there.
ipcMain.handle('remote:projects', (_e, device: string) => remote.projectsOn(String(device)))
ipcMain.handle('remote:agents', (_e, device: string) => remote.agentsOn(String(device)))
ipcMain.handle('remote:start', (_e, device: string, req: StartSessionRequest) =>
  remote.startOn(String(device), req)
)
// The renderer runs from file:// in production, which is not a secure context, so
// navigator.clipboard is unavailable there. Terminal copy/paste goes through here.
ipcMain.on('clipboard:write', (_e, text: string) => {
  if (typeof text === 'string' && text.length) clipboard.writeText(text)
})
ipcMain.handle('clipboard:read', () => clipboard.readText())

// The clipboard shelf: the last things copied, one click from the focused pane.
ipcMain.handle('recents:list', () => listRecents())
// The clip bodies never ride along with the list (see `lean` in recents.ts): the window
// asks for the one it is about to type.
ipcMain.handle('recents:text', (_e, id: string) => recentText(id))
ipcMain.on('recents:copy', (_e, id: string) => copyRecent(id))
ipcMain.on('recents:clear', () => clearRecents())
ipcMain.on('recents:remove', (_e, id: string) => removeRecent(id))
ipcMain.on('recents:pin', (_e, id: string, on: boolean) => pinRecent(id, !!on))
// The overlay floats over other apps and has no idea which pane is focused, so "send it
// to the pane" is asked of the window that does know.
//
// Raising the window is opt-in. The overlay is deliberately unfocusable so a click can
// leave the keyboard exactly where it was - clicking a line and then pressing Ctrl+V in
// whatever you were already typing in is the reason it exists. Now that a plain click
// sends to the pane, doing that AND dragging PaneForge to the front would take the
// overlay's own point away from it. The pty does not care whether its window is in
// front: the text lands either way.
ipcMain.on('recents:toPane', (_e, id: string, focus = false) => {
  if (!getRecent(id)) return
  if (focus) focusWindow()
  send('recents:toPane', id)
})
ipcMain.on('shelf:focusApp', () => focusWindow())
ipcMain.on('shelf:touch', () => noteShelfTouch())
ipcMain.on('shelf:setExpanded', (_e, open: boolean) => setShelfExpanded(!!open))
ipcMain.on('shelf:setTall', (_e, tall: boolean) => setShelfTall(!!tall))
// Dragged by its own header. The overlay cannot move its window itself, and a pointer
// that leaves the window mid-drag stops sending it events, so it sends the screen point
// and main does the arithmetic against where the drag started.
ipcMain.on('shelf:dragStart', () => beginShelfDrag())
ipcMain.handle('shelf:dragLift', () => liftShelfDrag())
ipcMain.on('shelf:dragMove', (_e, dx: number, dy: number) => moveShelfDrag(dx, dy))
ipcMain.on('shelf:dragShown', () => shownShelfDrag())
ipcMain.handle('shelf:dragDrop', (_e, dx: number, dy: number) => dropShelfDrag(dx, dy))
ipcMain.on('shelf:dragEnd', () => endShelfDrag())

/** Just the Stash's own knobs, which is all of the config the overlay ever sees. */
function stashConfig(cfg: Config): StashConfig {
  return {
    stashPeekMs: cfg.stashPeekMs,
    stashAutoCloseMs: cfg.stashAutoCloseMs,
    stashMaxItems: cfg.stashMaxItems,
    stashMaxImages: cfg.stashMaxImages,
    stashFileHours: cfg.stashFileHours,
    stashMaxFileMb: cfg.stashMaxFileMb,
    clipboardOverlay: cfg.clipboardOverlay
  }
}

ipcMain.handle('shelf:config', () => stashConfig(getConfig()))
/**
 * The overlay's own settings panel. This window floats over every other app, so its
 * bridge writes through an allowlist rather than the whole config: a key that is not one
 * of the Stash's own is dropped here, not merged.
 */
ipcMain.handle('shelf:setConfig', (_e, patch: Partial<StashConfig>) => {
  const clean: Record<string, unknown> = {}
  const raw = (patch ?? {}) as Record<string, unknown>
  for (const k of STASH_CONFIG_KEYS) {
    const v = raw[k]
    if (k === 'clipboardOverlay') {
      if (typeof v === 'boolean') clean[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      clean[k] = v
    }
  }
  const next = setConfig(clean as Partial<Config>)
  applyStashCaps(next)
  if (clean.clipboardOverlay !== undefined) applyShelfOverlay(next)
  // Settings is a different window looking at the same numbers; it must not go stale.
  send('config:changed', next)
  const out = stashConfig(next)
  updateShelfConfig(out)
  return out
})
// Files dropped on the Stash, or chosen in its picker. The renderer only ever sees paths
// (webUtils in the preloads); the copying is main's, because it owns the folder.
ipcMain.handle('stash:add', (_e, paths: string[]) =>
  Array.isArray(paths) ? addRecentFiles(paths) : 0
)
ipcMain.handle('stash:pick', async () => {
  // A picker is a foreground dialog, which the app is not allowed to raise on its own -
  // this one only ever runs from a click, so it is the user asking for it.
  const r = await dialog.showOpenDialog({
    title: 'Add to the Stash',
    properties: ['openFile', 'multiSelections'],
    buttonLabel: 'Add'
  })
  return r.canceled ? 0 : addRecentFiles(r.filePaths)
})
ipcMain.on('stash:reveal', () => shell.openPath(recentsDir()))
// Ctrl+Shift+V from inside the app. There is one Stash, so this opens the floating one
// rather than a second list in the window.
ipcMain.on('shelf:toggle', () => toggleShelf())
// Dragging a shelf item into another app entirely. The renderer cannot start an OS drag
// with a real file in it - only the main process can, and only with a path it owns.
ipcMain.on('recents:drag', async (e, id: string) => {
  const file = recentPath(id)
  if (!file) return
  // A video or a zip has no bitmap to shrink, and startDrag with an empty icon throws,
  // which would leave the row looking broken rather than undraggable. Ask the OS for the
  // file's own shell icon and fall back to the app's.
  let icon = nativeImage.createFromPath(file)
  if (icon.isEmpty()) {
    try {
      icon = await app.getFileIcon(file, { size: 'normal' })
    } catch {
      /* handled by the emptiness check below */
    }
  }
  try {
    e.sender.startDrag({ file, icon: icon.isEmpty() ? appIcon() : icon.resize({ width: 96 }) })
  } catch {
    /* the file was cleared between the click and the drag */
  }
})

/**
 * A last-resort drag icon. Windows refuses a drag with no image at all, so a 1x1 is still
 * better than the drag never starting.
 */
function appIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    )
  )
}

/** How much the Stash keeps, and for how long. Settings owns these. */
function applyStashCaps(cfg: Config): void {
  configureRecents({
    maxItems: Math.max(1, cfg.stashMaxItems),
    maxImages: Math.max(0, cfg.stashMaxImages),
    fileHours: Math.max(0, cfg.stashFileHours),
    maxFileMb: Math.max(0, cfg.stashMaxFileMb)
  })
}

/** Watch the clipboard, or stop watching, to match the setting. */
function applyClipboardShelf(cfg: Config): void {
  applyStashCaps(cfg)
  if (cfg.clipboardShelf) {
    startRecents((items) => {
      send('recents:changed', items)
      updateShelfItems(items)
    })
  } else {
    stopRecents()
  }
  applyShelfOverlay(cfg)
}

/**
 * The floating overlay follows the shelf setting: watching the clipboard is what fills
 * it, so an overlay with the watcher off would be a permanently empty window on top of
 * everything.
 */
function applyShelfOverlay(cfg: Config): void {
  const wanted = cfg.clipboardShelf && cfg.clipboardOverlay
  if (wanted && !shelfWindowOpen()) {
    openShelfWindow(() => win)
    updateShelfItems(listRecents())
  } else if (!wanted && shelfWindowOpen()) {
    closeShelfWindow()
  }
  applyShelfHotkey(cfg)
}

/**
 * Ctrl+Alt+V opens the overlay from inside any application. Not Ctrl+Shift+V, which is
 * paste in every terminal on the machine (including PaneForge's own panes) and would be
 * taken away from all of them by a global registration - that combo stays as the
 * in-window shelf's key, where it only applies while the app has focus.
 */
function applyShelfHotkey(cfg: Config): void {
  const accel = 'CommandOrControl+Alt+V'
  globalShortcut.unregister(accel)
  // Registered whenever the clipboard is being watched at all, not only while the overlay
  // is showing: the overlay has a "hide" button on it, and a hidden window with no taskbar
  // entry and no tray icon would otherwise have no way back.
  if (!cfg.clipboardShelf) return
  try {
    globalShortcut.register(accel, () => {
      if (shelfWindowOpen()) return toggleShelf()
      // Hidden: bring it back, on the list rather than as a pill, since asking for it is
      // asking to look at it.
      const next = setConfig({ clipboardOverlay: true })
      applyShelfOverlay(next)
      send('config:changed', next)
      setShelfExpanded(true)
    })
  } catch {
    /* another app owns the combo - the pill in the corner still opens on hover */
  }
}

ipcMain.on('shell:external', (_e, url: string) => {
  // Only ever open real web links: a file:// or custom scheme from the renderer
  // would be a way to launch arbitrary local programs.
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
})

// --- elevation -------------------------------------------------------------

ipcMain.handle('admin:status', () => adminStatus())
ipcMain.handle('admin:enable', () => {
  const r = enableAdminMode()
  if (r.ok) setConfig({ adminMode: true })
  return r
})
ipcMain.handle('admin:disable', () => {
  const r = disableAdminMode()
  setConfig({ adminMode: false })
  return r
})
ipcMain.handle('app:profile', () => profileName())
ipcMain.on('app:relaunchAsAdmin', () => {
  // With admin mode set up, the scheduled task starts an elevated instance with no
  // prompt. Without it, fall back to the one-off UAC dialog.
  if (!relaunchViaTask()) {
    const args = process.argv.slice(1).filter((a) => !a.startsWith('--remote-debugging'))
    const list = args.length
      ? ` -ArgumentList ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}`
      : ''
    try {
      spawnDetachedNoWindow('powershell', [
        '-NoProfile',
        '-Command',
        `Start-Process -Verb RunAs -FilePath '${process.execPath.replace(/'/g, "''")}'${list}`
      ])
    } catch {
      return // user declined UAC - stay as we are
    }
  }
  // Same reasoning as the update restart: the elevated copy is already starting, so
  // getting this one out of the way quickly is the whole user-visible difference.
  rememberBounds()
  manager.shutdown()
  hardExit()
})

// --- one-click agent installs ---------------------------------------------

/** One install at a time per agent, so a double-click cannot run npm twice. */
const installing = new Set<string>()

ipcMain.handle('agents:install', async (_e, id: string) => {
  if (installing.has(id)) return
  const spec = specFor(id)
  const command = installCommand(spec)
  const say = (chunk: string): void => send('agents:install-event', { agentId: id, chunk })
  if (!command) {
    send('agents:install-event', {
      agentId: id,
      chunk: `${spec.label} has no scripted installer. Open its docs and install it, then hit Rescan.\r\n`,
      done: true,
      ok: false
    })
    return
  }
  installing.add(id)
  try {
    if (!(await ensurePrereq(command, say))) {
      send('agents:install-event', { agentId: id, chunk: '', done: true, ok: false })
      return
    }
    say(`> ${command}\r\n\r\n`)
    const code = await runOnce(command, say)
    // A brand new install folder is only on the PATH of new processes, so pull
    // the current PATH out of the registry before deciding it failed.
    refreshPath()
    invalidateAgents()
    const found = onPath(spec.bin)
    send('agents:install-event', {
      agentId: id,
      chunk: found
        ? `\r\n${spec.label} is ready.\r\n`
        : `\r\nInstaller exited with code ${code} and ${spec.bin} is still not on PATH.\r\n`,
      done: true,
      ok: found
    })
  } finally {
    installing.delete(id)
  }
})

/**
 * Take an agent back off the machine. The same console the install used reports it,
 * and the same one-at-a-time guard applies: installing and removing the same CLI at
 * once is how you end up with a half of each.
 */
ipcMain.handle('agents:uninstall', async (_e, id: string) => {
  if (installing.has(id)) return
  const spec = specFor(id)
  const command = uninstallCommand(spec)
  const say = (chunk: string): void => send('agents:install-event', { agentId: id, chunk })
  if (!command) {
    send('agents:install-event', {
      agentId: id,
      chunk: `${spec.label} has no scripted uninstaller - remove it the way you installed it.\r\n`,
      done: true,
      ok: false
    })
    return
  }
  installing.add(id)
  try {
    say(`> ${command}\r\n\r\n`)
    const code = await runOnce(command, say)
    refreshPath()
    invalidateAgents()
    // Success is the binary being GONE, which is the opposite test from an install and
    // the only one that survives an uninstaller exiting 0 without doing anything.
    const gone = !onPath(spec.bin)
    send('agents:install-event', {
      agentId: id,
      chunk: gone
        ? `\r\n${spec.label} has been removed.\r\n`
        : `\r\nUninstaller exited with code ${code} and ${spec.bin} is still on PATH.\r\n`,
      done: true,
      ok: gone
    })
  } finally {
    installing.delete(id)
  }
})

ipcMain.handle('agents:locate', async (_e, id: string) => {
  const spec = specFor(id)
  const r = await dialog.showOpenDialog({
    title: `Where is ${spec.label}?`,
    properties: ['openFile'],
    filters:
      process.platform === 'win32'
        ? [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'ps1'] }]
        : [{ name: 'All files', extensions: ['*'] }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  const bin = r.filePaths[0]
  // Stored as a custom override of the same id, so the agent keeps its colour,
  // model list and resume flags and only the binary changes.
  const cfg = getConfig()
  const next = [...cfg.customAgents.filter((c) => c.id !== id), { ...spec, bin, custom: true }]
  setConfig({ customAgents: next })
  invalidateAgents()
  send('config:changed', getConfig())
  return bin
})

// --- updates ---------------------------------------------------------------

ipcMain.handle('update:state', () => getUpdateState())
ipcMain.handle('update:check', () => checkForUpdates())
/** One restart is one restart: a second click must not run the teardown twice. */
let installStarted = false

/**
 * The restart is the loudest thing this app does: the installer takes the window away,
 * the new exe starts, and Windows hands the display around twice on the way through.
 * Mid-game that is a dropped round, and it happens several times a day because the app
 * updates itself that often. The download is already on disk by this point, so waiting
 * for the game to end costs nothing at all except the restart being later.
 */
ipcMain.handle('update:install', async (): Promise<InstallOutcome> => {
  if (installStarted) return { status: 'installing' }
  if (getUpdateState().phase !== 'ready') return { status: 'nothing-to-install' }
  // Asked fresh rather than read off the poller: a game started ten seconds ago is
  // exactly the case where this must not go ahead.
  await checkGameNow()
  if (whenClear('update-install', doInstall)) return { status: 'installing' }
  // Queued, not done. Say which, and what is holding it: the card is about to swap its
  // button for "Restart anyway", and a card that cannot name the reason reads as broken.
  const s = gameState()
  send('game:changed', gameStatus())
  return { status: 'held', game: s.game, manual: s.manual }
})

function doInstall(): void {
  if (installStarted) return
  installStarted = true

  // Get off the screen FIRST. Everything below is unavoidable work - snapshotting the
  // workspace, flushing transcripts, killing N ptys - and on Windows it adds up to a
  // moment during which the window sits there ignoring the mouse. That reads as
  // "Restart now hung, then crashed". Hiding is instant, so the app vanishes on the
  // click and does the teardown with nothing left to look at.
  if (alive()) {
    try {
      // Saved here rather than on the window's own close event: this path never gets
      // one, because the process is exited outright below.
      rememberBounds()
      win!.setSkipTaskbar(true)
      win!.hide()
    } catch {
      /* window already going away */
    }
  }
  // Remembered before the panes die, replayed on the next launch: an update should
  // feel like the app blinked, not like it wiped the desk. Unless the user turned
  // that off - the app updates itself several times a day, so an always-on restore
  // makes a set of panes impossible to be rid of by restarting. `update` is the one
  // reason that reopens without asking; every other restart asks.
  saveDeskOnExit(getConfig().restoreAfterUpdate ? manager.snapshot() : [], 'update')
  // Flushes transcripts, ends their metadata in one pass and hard-kills every agent
  // tree in a single taskkill instead of one blocking ConPTY teardown per pane.
  manager.shutdown()
  // Set before the installer starts, because once quitAndInstall() runs this process can
  // be gone before the next line. The new exe reads it and comes back without activating.
  markQuietRelaunch()
  if (!installUpdate()) {
    // Nothing was installable after all (state moved on, feed unsupported). Put the
    // window back rather than leaving an invisible app with no panes - inactive, since
    // by now the user has looked away and a failed update is no reason to interrupt.
    installStarted = false
    markQuietRelaunch(false)
    // Same rule as every other reveal: with a game up, the window that failed to update
    // stays hidden until the screen is free rather than reappearing over it.
    if (alive()) whenClear('update-failed-reveal', restoreAfterFailedInstall)
    return
  }
  // The installer is already running and its first job is to wait for this exe to let go
  // of its own files, so every millisecond spent on a graceful teardown is a millisecond
  // the user spends looking at no app at all. Nothing is left to save.
  hardExit()
}

/**
 * How often a held automatic restart looks again. A build that is downloaded and ready
 * stays ready, so this waits rather than giving up on it.
 */
const AUTO_INSTALL_RECHECK_MS = 60_000
let autoInstallTimer: NodeJS.Timeout | null = null

/**
 * The restart nobody asked for, held until it costs nothing.
 *
 * A restart is not a blink for the panes: `doInstall` tears down every pty, so an agent
 * mid-turn is killed along with the answer it was writing, and what comes back is a
 * fresh session whose run clock starts again from zero. That is the "why did the running
 * time reset" this app has now been asked about three times, and it is also why the desk
 * reopens over whatever was on screen.
 *
 * Measured 2026-08-02 in `updater.log`: an install that silently failed retried itself at
 * 18:53:34Z, 18:54:18Z and 18:56:24Z - three full teardowns inside three minutes - with
 * eight panes on the desk. Nothing on that path asked whether anything was running. The
 * user-clicked path at least goes through the game hold.
 *
 * So a click still goes straight through, because the user chose the interruption. Only
 * the automatic retry waits here, for a desk where no agent is mid-turn.
 */
function autoInstall(): void {
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer)
    autoInstallTimer = null
  }
  // The build stopped being installable while we waited - superseded, or already going.
  if (getUpdateState().phase !== 'ready') return
  const running = agentsMidTurn(manager.list())
  if (running > 0) {
    updateLog('install', `auto-restart held: ${running} agent(s) mid-turn - looking again in 60s`)
    autoInstallTimer = setTimeout(autoInstall, AUTO_INSTALL_RECHECK_MS)
    autoInstallTimer.unref?.()
    return
  }
  whenClear('update-install', doInstall)
}

/** The update did not happen: put the window back, inactive, once the screen is free. */
function restoreAfterFailedInstall(): void {
  if (!alive()) return
  win!.setSkipTaskbar(false)
  win!.showInactive()
  win!.flashFrame(true)
}

// --- do not disturb while gaming -------------------------------------------

function gameStatus(): GameModeStatus {
  const s = gameState()
  return { active: s.active, game: s.game, manual: s.manual, waiting: deferredCount() }
}

ipcMain.handle('game:status', () => gameStatus())
// Asked once on load: the page can come up either before or after the window is shown,
// so the push alone is a race the page loses on a cold start.
ipcMain.handle('app:visibleNow', () => !!win && !win.isMinimized() && win.isVisible())
/** The Settings switch, kept out of the config write path so it applies instantly. */
ipcMain.handle('game:manual', (_e, on: boolean) => {
  const next = setConfig({ gameMode: { ...getConfig().gameMode, manual: on } })
  refreshGameWatch(next)
  send('config:changed', next)
  return gameStatus()
})
/** "Restart now anyway" - the one way past a held update without ending the game. */
ipcMain.on('game:installAnyway', () => {
  cancelDeferred('update-install')
  doInstall()
})

// --- task board + shared memory -------------------------------------------

ipcMain.handle('board:get', (_e, path: string) => readBoard(path))
ipcMain.handle('board:tasks', (_e, path: string, tasks: TaskItem[]) => writeTasks(path, tasks))
ipcMain.handle('board:memory', (_e, path: string, memory: string) => writeMemory(path, memory))

// --- history ---------------------------------------------------------------

ipcMain.handle('history:list', () => history.list())
ipcMain.handle('history:search', (_e, q: string) => history.search(q))
ipcMain.handle('history:read', (_e, id: string) => history.read(id))
ipcMain.handle('history:delete', (_e, id: string) => history.remove(id))

// --- prompt improvement ----------------------------------------------------
//
// A mirrored pane improves ON THE HOST and never on the mirror - the same rule the busy
// footer follows. The mirror has neither the repository nor the project's memory, so an
// improvement computed here would be a brief about a folder this machine does not have.
// Rather than route the request over the link (stage 2 work), it is declined by name.

ipcMain.handle('improve:status', (): ImproveStatus => {
  const cfg = getConfig().promptImprove
  const specs = listAgents(false).map((a) => a as AgentSpec)
  const engine = resolveEngine(cfg.engine, '', specs, cfg.model)
  const providers: string[] = []
  if (cfg.indexScript) providers.push('vault-index')
  if (cfg.vaultPath) providers.push('markdown')
  if (cfg.capabilities) providers.push('catalogue')
  return {
    available: Boolean(engine),
    engine: engine?.id ?? '',
    install: 'npm i -g @anthropic-ai/claude-code',
    providers,
    vaultCandidate: firstExistingVault()
  }
})

async function runImprove(
  id: string,
  draft: string,
  answers: Array<{ question: string; answer: string }> | undefined,
  options: ImproveOptions | undefined
): Promise<ImproveResult> {
  const decline = (error: string): ImproveResult => ({
    ok: false,
    error,
    original: draft,
    sources: [],
    held: '',
    metrics: {
      originalTokens: 0,
      improvedTokens: 0,
      contextTokens: 0,
      knowledgeTokens: 0,
      knowledgeNotes: 0,
      ms: 0,
      questions: 0,
      taskType: 'other',
      engine: '',
      outcome: 'failed',
      secretsHeld: 0
    }
  })

  const cfg = getConfig().promptImprove
  if (cfg.mode === 'off') return decline('prompt improvement is off')
  if (remote.owns(id)) return decline('that pane runs on another device - improve it there')

  const session = allSessions().find((s) => s.id === id)
  if (!session) return decline('no such pane')

  const outcome = await improve({
    sessionId: id,
    cwd: session.cwd,
    agent: session.agent,
    draft,
    git: await gitInfo(session.cwd).catch(() => null),
    config: cfg,
    specs: listAgents(false).map((a) => a as AgentSpec),
    answers,
    includeUntrusted: options?.includeUntrusted,
    exclude: options?.exclude,
    tweak: options?.tweak
  })

  // The derived stage, for catalogue entries only. A vault note has a status but no
  // lifecycle - it was never a candidate that could be sandboxed - so it reports its
  // status and is not offered a Remove control it has nothing to re-run without.
  const byId = new Map(loadCapabilities().map((c) => [c.id, c]))

  return {
    ok: outcome.ok,
    error: outcome.error,
    original: outcome.original,
    improvement: outcome.improvement,
    // Provenance crosses the bridge as ids and titles, never as the note bodies: the
    // sheet cites, it does not re-display somebody's vault.
    sources: outcome.sources.map((n) => {
      const cap = byId.get(n.id)
      return {
        id: n.id,
        title: n.title,
        provider: n.provider,
        source: n.source,
        trusted: n.trusted,
        stage: cap ? stage(cap) : n.status,
        stale: n.stale,
        removable: Boolean(cap)
      }
    }),
    held: outcome.held,
    metrics: outcome.metrics
  }
}

/**
 * "Has this been asked before?" — see main/promptArchive.ts.
 *
 * A lookup, not a search: it scores the draft against an archive already in memory, so the
 * renderer may ask on every idle pause without this costing anything. It answers null far
 * more often than not, and null is the answer that must stay cheap.
 */
ipcMain.handle('prompt:prior', (_e, draft: string) => {
  const cfg = getConfig().promptRecall
  if (!cfg.enabled) return null
  try {
    return priorPrompt(draft, { extraArchives: cfg.extraArchives })
  } catch {
    // A feature that says "you asked this before" must never be the reason a pane stops
    // working. Nothing was found is the right failure.
    return null
  }
})

/**
 * A pane's draft was submitted. Fire-and-forget: the renderer is mid-keystroke and has
 * nothing to do with the answer.
 */
ipcMain.on('prompt:used', (_e, draft: string, meta: { cwd?: string; agent?: string }) => {
  if (!getConfig().promptRecall.enabled) return
  try {
    // The folder is turned into a project name here rather than in the renderer, because
    // splitting a path is a platform question and this side already knows the answer.
    const project = meta.cwd ? basename(meta.cwd) : null
    recordPrompt(draft, { project, agent: meta.agent ?? null })
  } catch {
    /* see above */
  }
})

ipcMain.handle('improve:run', (_e, id: string, draft: string, options?: ImproveOptions) =>
  runImprove(id, draft, undefined, options)
)
ipcMain.handle(
  'improve:answer',
  (
    _e,
    id: string,
    draft: string,
    answers: Array<{ question: string; answer: string }>,
    options?: ImproveOptions
  ) => runImprove(id, draft, answers, options)
)
ipcMain.on('improve:cancel', (_e, id: string) => cancelImprove(id))

// --- research this request -------------------------------------------------
//
// Never automatic, and never on a mirrored pane for the same reason improvement is not:
// the research is about the project in front of the person, and this device does not have
// that folder.
ipcMain.handle('research:run', async (_e, id: string, draft: string): Promise<ResearchReport> => {
  const nothing = (detail: string): ResearchReport => ({
    ok: false,
    outcome: 'failed',
    detail,
    kept: [],
    rejected: [],
    sources: [],
    duplicates: 0,
    ms: 0
  })

  const cfg = getConfig().promptImprove
  if (cfg.mode === 'off') return nothing('prompt improvement is off')
  if (remote.owns(id)) return nothing('that pane runs on another device - research it there')
  const session = allSessions().find((s) => s.id === id)
  if (!session) return nothing('no such pane')

  const engine = resolveEngine(
    cfg.engine,
    session.agent,
    listAgents(false).map((a) => a as AgentSpec),
    cfg.model
  )
  if (!engine) return nothing('no CLI on PATH that could run the research')

  const git = await gitInfo(session.cwd).catch(() => null)
  // The stack, so a finding that cannot work here is never fetched. Only the framework
  // ids leave this machine - not the context pack, not a path, not a dependency list.
  const context = buildContextPack(session.cwd, git, 200)
  return research({
    sessionId: id,
    // A sentence about the task, capped - never the draft verbatim, which is the thing
    // that may hold a secret and which the envelope exists to keep out of a request.
    task: draft.replace(/\s+/g, ' ').trim().slice(0, 300),
    stack: context.stack,
    engine
  })
})
ipcMain.on('research:cancel', (_e, id: string) => cancelResearch(id))

ipcMain.handle('improve:apply', async (_e, id: string, text: string) => {
  if (remote.owns(id)) return { ok: false, error: 'that pane runs on another device' }
  const session = allSessions().find((s) => s.id === id)
  if (!session) return { ok: false, error: 'no such pane' }

  const { wipe, payload, error } = insertSequence(text, session.agent)
  if (!payload) return { ok: false, error: error ?? 'nothing safe to insert' }

  // The same measured shape `clearPane()` uses: empty the box, wait for the CLI to settle,
  // then paste. 320ms is the measured settle - at 40ms the key arrived before the TUI had
  // redrawn. Bracketed paste so newlines land in the box instead of submitting it.
  manager.write(id, wipe)
  await new Promise((r) => setTimeout(r, 320))
  manager.write(id, payload)
  return { ok: true }
})

ipcMain.on(
  'improve:record',
  (_e, outcome: ImproveOutcomeKind, metrics: ImproveMetrics, editedChars?: number) => {
    const cfg = getConfig().promptImprove
    // Hashes and counts. The text is only kept when the user has ticked for it, and even
    // then a draft that still looks like it carries a credential is refused.
    recordImprovement({ ...metrics, outcome }, '', '', {
      enabled: cfg.telemetry,
      keepText: false,
      editedChars
    })
  }
)

// --- voice -----------------------------------------------------------------

ipcMain.handle('voice:status', () => voice.voiceStatus())
ipcMain.handle('voice:transcribe', (_e, wav: ArrayBuffer) => {
  const cfg = getConfig().voice
  return voice.transcribe(Buffer.from(wav), { model: cfg.model, language: cfg.language })
})
ipcMain.handle('voice:install', async () => {
  const command = voice.installCommand()
  const say = (chunk: string): void => send('agents:install-event', { agentId: '__voice__', chunk })
  // Whisper is a pip install, so on a machine with no Python this failed exactly the
  // way the agent installs did.
  if (!(await ensurePrereq(command, say))) {
    send('agents:install-event', { agentId: '__voice__', chunk: '', done: true, ok: false })
    return
  }
  say(`> ${command}\r\n\r\n`)
  await runOnce(command, say)
  refreshPath()
  const ok = voice.voiceStatus().available
  send('agents:install-event', {
    agentId: '__voice__',
    chunk: ok ? '\r\nVoice is ready.\r\n' : '\r\nStill no whisper binary on PATH.\r\n',
    done: true,
    ok
  })
})

/** Push-to-talk works even when another window has focus, so it needs a global key. */
function applyVoiceHotkey(cfg: Config): void {
  const accel = 'CommandOrControl+Shift+Space'
  globalShortcut.unregister(accel)
  if (!cfg.voice.enabled) return
  try {
    globalShortcut.register(accel, () => {
      focusWindow()
      send('voice:hotkey')
    })
  } catch {
    /* another app owns the combo - the in-app mic button still works */
  }
}

/** `PaneForge --open <path>` starts a session in that folder on launch. */
/**
 * Which project a message is about. Empty or near-empty text answers "no idea" without
 * touching the disk, because the renderer calls this on every keystroke of the first
 * message box.
 */
function routeText(text: string): RouteResult {
  if (!text || text.trim().length < 3) return { matches: [], confident: false }
  return routePrompt(text, routeCandidates(listProjects()))
}

/**
 * `--open <dir>` starts a session there. `--prompt <text>` sends that first message, and
 * `--route <text>` works out the folder from the message itself - which is how something
 * outside the app (a shell alias, a Claude Code hook that has spotted a chat in the wrong
 * project) hands a misplaced job to a session started in the right one.
 */
export interface OpenRequest {
  open?: string
  prompt?: string
  route?: string
}

/** Read from a command line that is still in the order it was typed. */
export function parseOpenArgs(argv: string[]): OpenRequest {
  const req: OpenRequest = {}
  const take = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    const value = i >= 0 ? argv[i + 1] : undefined
    return value && !value.startsWith('--') ? value : undefined
  }
  const open = take('--open')
  const prompt = take('--prompt')
  const route = take('--route')
  if (open) req.open = open
  if (prompt) req.prompt = prompt
  if (route) req.route = route
  return req
}

function isOpenRequest(value: unknown): value is OpenRequest {
  if (!value || typeof value !== 'object') return false
  const r = value as OpenRequest
  return typeof r.open === 'string' || typeof r.route === 'string'
}

/**
 * Routing only ever acts when it is confident. A guess would open a project nobody asked
 * for, which is a worse failure than doing nothing: the whole point of the feature is
 * that the folder a session opens in stops being a surprise.
 */
function openRequest(req: OpenRequest): void {
  const target = req.open ?? (req.route ? confidentRoute(req.route) : undefined)
  if (!target) return
  try {
    manager.start({ cwd: target, prompt: req.prompt ?? req.route ?? undefined })
  } catch {
    /* bad path on the command line - ignore rather than crash the launch */
  }
}

function confidentRoute(text: string): string | undefined {
  const r = routeText(text)
  return r.confident ? r.matches[0]?.path : undefined
}

/**
 * Bring panes back. Each one resumes the agent's own last conversation
 * (`claude --continue`), so a restart costs a redraw rather than the thread you were
 * in. Nothing is typed into them: a pane that comes back mid-turn must sit there
 * with the cursor in its prompt box, not re-send work the agent already did.
 *
 * The desk is dropped before the first pane starts, never after. A crash while
 * restoring would otherwise leave the app reopening the same panes on every launch,
 * for ever, with no way in the UI to say no.
 */
let restoredThisRun = false

function restorePanes(specs: StartSessionRequest[]): void {
  // One restore per launch. A second answer from a dialog that somehow sent twice
  // would otherwise open every pane again beside the first set.
  if (restoredThisRun) return
  clearDesk()
  restoredThisRun = true
  for (const req of specs.slice(0, MAX_RESTORE)) {
    try {
      manager.start({
        ...req,
        resume: true,
        // Reopen the conversation this pane was in by name, and fall back to "the newest
        // one here" if that transcript has been deleted since the desk was written.
        resumeId: resumable(req.cwd, req.resumeId) ? req.resumeId : undefined,
        prompt: undefined
      })
    } catch {
      // Folder moved or the agent is no longer installed - skip that pane only.
    }
  }
}

/**
 * The panes waiting to be offered back, pulled by the renderer once it is up. Held
 * in memory rather than pushed at launch, because the decision below happens while
 * the window is still loading its own JavaScript.
 */
let offer: RestoreOffer | null = null

/** A saved pane described for the dialog, with the reasons it cannot come back. */
function describe(spec: StartSessionRequest, i: number): RestorePane {
  const agent = spec.agent ?? 'claude'
  const installed = listAgents().find((a) => a.id === agent)?.available ?? false
  // A conversation deleted since the desk was written cannot be resumed by name, and
  // asking the CLI for one it does not have is worse than continuing the newest.
  const resumeId = resumable(spec.cwd, spec.resumeId) ? spec.resumeId : undefined
  return {
    id: String(i),
    cwd: spec.cwd,
    title: spec.title || basename(spec.cwd),
    agent,
    model: spec.model,
    resumeId,
    lastPrompt: lastPrompt(spec.cwd, resumeId),
    gone: paneMissing(spec) ? 'folder' : installed ? undefined : 'agent'
  }
}

/**
 * What a launch does with the last run's panes.
 *
 * An update restart reopens silently: the app decided on that restart, so being
 * handed the same desk back is the whole point. Every other restart asks, because a
 * cold boot is often a deliberate fresh start and a desk that reappears whatever you
 * do is a set of panes you cannot get rid of.
 */
function offerRestore(): void {
  const cfg = getConfig()
  // One launch only: the first run after updating from a version that wrote the
  // snapshot into config.json, which is exactly the launch that would lose it.
  const legacy = cfg.restoreSessions ?? []
  if (legacy.length) setConfig({ restoreSessions: [] })
  const desk = readDesk() ?? (legacy.length ? { specs: legacy, at: Date.now(), clean: true, reason: 'update' as const } : null)
  if (!desk?.specs.length) return
  // Panes from last week are not the desk anyone remembers leaving.
  if (desk.at && Date.now() - desk.at > MAX_DESK_AGE_MS) {
    clearDesk()
    return
  }
  if (desk.reason === 'update') {
    if (cfg.restoreAfterUpdate) restorePanes(desk.specs)
    else clearDesk()
    return
  }
  // Nobody is sitting in front of a test copy. An agent runs `npm run try` to measure
  // something and gets "restore your last session?" across the window instead - every
  // click after that lands on the dialog, which is the leftover scripts/focus-test.mjs
  // already writes a config file by hand to avoid. Unpackaged runs start fresh unless
  // told otherwise; PANEFORGE_RESTORE=ask brings the question back, =always reopens the
  // panes without asking. The installed app is untouched.
  // `||`, not `??`: a variable set to nothing at all is how a launcher says "I am not
  // choosing", and measured as the case that silently kept the dialog.
  const forced = (process.env.PANEFORGE_RESTORE || (app.isPackaged ? '' : 'fresh'))
    .trim()
    .toLowerCase()
  if (forced === 'fresh') {
    clearDesk()
    return
  }
  if (forced === 'always') {
    restorePanes(desk.specs)
    return
  }
  if (cfg.restoreAfterRestart === 'never') {
    clearDesk()
    return
  }
  if (cfg.restoreAfterRestart === 'always') {
    restorePanes(desk.specs)
    return
  }
  const all = desk.specs.map(describe)
  offer = {
    panes: all.slice(0, MAX_RESTORE),
    extra: all.slice(MAX_RESTORE),
    at: desk.at,
    clean: desk.clean
  }
  // Until the question is answered the desk stands, even though the app currently
  // has no panes: an unanswered offer must survive a second restart, and a mis-click
  // that closes the dialog must not delete the panes it was offering.
  setDeskHold(true)
}

ipcMain.handle('restore:pending', () => offer)

ipcMain.on('restore:answer', (_e, answer: RestoreAnswer) => {
  const pending = offer
  offer = null
  setDeskHold(false)
  if (answer?.always) setConfig({ restoreAfterRestart: 'always' })
  if (!pending) return
  if (!answer?.accept) {
    // Turned down on purpose - the desk goes. Dismissing the dialog instead sends
    // nothing at all, so those panes are offered again next launch.
    clearDesk()
    saveDesk(manager.snapshot(), 'live')
    return
  }
  const wanted = new Set(answer.ids ?? [])
  const specs = pending.panes
    .filter((p) => wanted.has(p.id) && !p.gone)
    .map((p) => ({
      cwd: p.cwd,
      title: p.title,
      agent: p.agent,
      model: p.model,
      resumeId: p.resumeId
    }))
  // `--open` and a restore are both allowed to have happened: whatever is already on
  // screen stays, the restored panes join it.
  restorePanes(specs)
})

/**
 * `stash://<id>` serves one Stash file to the two windows that draw it, and nothing else
 * on the machine. It exists so a dropped video can show its own first frame in the tile
 * instead of a generic film icon: a `<video>` needs a URL, and both windows load over
 * `file://` in a packaged build, where a second `file://` is blocked.
 *
 * The only thing it will hand over is a path already on the Stash list, looked up by id -
 * never a path from the URL. A renderer that asked for `stash://../../id_rsa` gets a 404,
 * because the id does not resolve.
 */
protocol.registerSchemesAsPrivileged([
  // `stream` is what lets the video element seek; without it Chromium has to download the
  // whole clip before it will draw a frame.
  { scheme: 'stash', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
  protocol.handle('stash', (req) => {
    const id = decodeURIComponent(new URL(req.url).hostname || new URL(req.url).pathname.slice(1))
    const file = id ? recentPath(id) : ''
    if (!file) return new Response('', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: req.headers, method: req.method })
  })
  const cfg = getConfig()
  // First line of this process's story: the one that was missing when an update came
  // back and nobody could tell whether it had.
  updateLog('launch', `v${app.getVersion()}`, `pid ${process.pid}`, `start=${startMode()}`, `+${bootMs()}ms`)
  // Lanes only ever worked on the machine they were hand-wired on. Installing the hooks
  // here is what makes several chats safe to run against one project for anybody else -
  // and repoints them when an upgrade moves the app. It never throws and never overrides
  // a registration somebody made themselves.
  updateLog('lanes', installLaneHooks())
  // Whatever the runs before this one left running. Delayed inside, and a no-op on a
  // machine that has never leaked one. See consoles.ts.
  sweepOldConsoles(rememberAppPid())
  // And what those runs' PANES left running - a dev server whose npm is long dead is not
  // reachable from any tree, so it is killed from what we wrote down. See strays.ts.
  sweepOldStrays()
  history.setHistoryEnabled(cfg.saveHistory)
  history.prune(cfg.historyDays)
  // An uploaded alert sound is a config line plus a file, and the two drift apart
  // silently - a copied profile brings one and not the other. Reconciled once, here,
  // because the alternative is finding out when an alert makes no sound.
  pruneCustomSounds()
  setSilenceAlert(cfg.silenceAlertMin)
  // Before the window: everything that opens, floats or flashes below asks this first,
  // and a launch that happens to land mid-game should be quiet on the way in rather
  // than one poll later.
  onGameState((s) => {
    setShelfHidden(s.active)
    send('game:changed', gameStatus())
  })
  // "A game is running" is not "a game is on screen": with our own window focused the
  // display is demonstrably ours, so do-not-disturb steps aside. Without this a game
  // left open in the background held every deferred restart forever.
  setFocusProbe(() => !!win && !win.isDestroyed() && win.isVisible() && win.isFocused())
  startGameWatch(cfg)
  createWindow()
  applyVoiceHotkey(cfg)
  applyClipboardShelf(cfg)
  crashTestHook()
  // After the window exists: a device that reconnects immediately would otherwise
  // push its session list at a renderer that is not listening yet.
  remote.start()
  initUpdater((s: UpdateState) => {
    send('update:changed', s)
    // A "Restart now" whose install never applied: the relaunch is the old version
    // with the same build downloaded and ready again. Finish the user's click instead
    // of showing them the same toast - once; updater.ts stops the loop at two tries.
    if (s.phase === 'ready' && consumeInstallRetry(s.version)) autoInstall()
  }, cfg.autoUpdate)
  offerRestore()
  // Only the copy that owns the window: a launch that lost the lock is on its way out,
  // and starting a pane in it puts an agent in a process that is about to exit.
  if (app.hasSingleInstanceLock()) openRequest(launchRequest)
  if (process.env['PANEFORGE_OPEN']) openRequest({ open: process.env['PANEFORGE_OPEN'] as string })
  // An activation is not acted on the moment it lands. It and the press that caused it
  // reach main by different routes - AppKit's notification, and the browser routing the
  // input to whichever window was clicked - and nothing promises which arrives first, so
  // the decision waits one settle for the other half of the gesture. An eighth of a
  // second before a window appears is not a wait; a window appearing when the Stash was
  // clicked is the bug (see shared/activation.ts).
  const onActivated = (reveal: () => void, from = '?'): void => {
    const activatedAt = Date.now()
    setTimeout(() => {
      const touched = shelfTouchedAt()
      const dragged = shelfDraggedAt()
      const dragging = shelfDragging()
      const result = revealOnActivation({
        activatedAt,
        quietUntil,
        shelfTouchedAt: touched,
        shelfDraggedAt: dragged,
        shelfDragging: dragging
      })
      // The deltas, not just the verdict: they are the only thing that distinguished a
      // click from a drag when this was finally measured, and they are what the next
      // report of it should be read against. See main/activationLog.ts.
      logActivation({
        from,
        result,
        sinceTouch: touched > 0 ? activatedAt - touched : null,
        sinceDrag: dragged > 0 ? activatedAt - dragged : null,
        dragging
      })
      if (result) reveal()
    }, ACTIVATION_SETTLE_MS)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) return createWindow()
    // Clicking the Dock icon (or Cmd-Tabbing in) is the macOS equivalent of clicking a
    // taskbar button, and it is the only way back into a copy that launched hidden -
    // which is what every `npm run try` on a Mac now does. Deliberate, so it focuses.
    //
    // Except at launch: macOS also emits `activate` for the launch itself, and a copy an
    // agent started must not answer that by showing itself. Anything this close to
    // startup is the launch, not a click. And except when the Stash was what was
    // clicked - the overlay is a window of this app too.
    onActivated(() => focusWindow(true), 'activate')
  })
  // Cmd-Tab into an app whose windows are all hidden does not always reach `activate`,
  // and an app you switched to that shows you nothing looks broken. Same guards: the
  // activation that comes with the launch itself is still ignored, and so is the one a
  // press on the Stash caused - which on macOS is every press on the Stash, because
  // clicking any window of an app activates the app.
  if (process.platform === 'darwin')
    app.on('did-become-active', () => {
      onActivated(() => {
        if (alive() && !win!.isVisible()) focusWindow(true)
      }, 'did-become-active')
    })
})

// Agents are child processes of this app: leaving them running after the window
// closes would strand invisible `claude` processes holding file locks.
app.on('window-all-closed', () => {
  // Before shutdown(), which is what kills the panes this is a record of.
  saveDeskOnExit(manager.snapshot())
  // Guests get their sockets closed rather than left to time out, so the other
  // device says "went away" straight away instead of a minute later.
  remote.stop()
  manager.shutdown()
  // An install running in Settings is a process tree of ours too, and its output goes to
  // a window that is already gone.
  stopInstalls()
  hardExit()
})

/**
 * Leave, now, and mean it.
 *
 * This is what "PaneForge takes a while to close" actually was, and it was not the
 * teardown above being slow - that measures at 80-120ms with eight panes open. Every
 * ConPTY session runs a worker thread draining the console output socket, and node-pty
 * only disposes that worker when one more byte arrives after the kill. A pane that goes
 * quiet at the wrong moment leaves the thread alive, a live worker thread keeps the Node
 * environment from finishing, and the process then sat there with no window and nothing
 * to do. Measured over ten quits with five panes: usually ~300ms, but 2 in 10 took four
 * to five seconds. On the update path those seconds are worse than wasted, because the
 * NSIS installer is already running and waiting for this exe to release its own files
 * before it can replace them.
 *
 * Everything worth keeping - window bounds, the session snapshot, transcripts - is
 * written synchronously before this is called, and the agent process trees are killed
 * outright by shutdown(), so there is nothing left for a graceful exit to do. Same ten
 * quits after this change: 250ms to 1.1s, no stalls, no orphaned agents.
 */
/**
 * A staged Mac update installs itself on the way out, like the Windows one does.
 *
 * `autoInstallOnAppQuit` is electron-updater's, and electron-updater is not what installs
 * a Mac update here (it cannot: Squirrel refuses an unsigned build). So the same promise -
 * ignore the card and the fix is there next time you start - is kept by moving the staged
 * bundle in from a detached script as this process exits. Without a relaunch: the user
 * closed the app, and an update is no reason to reopen it.
 */
let quitSwapDone = false
function installStagedMacUpdateOnQuit(): void {
  if (process.platform !== 'darwin' || quitSwapDone || installStarted) return
  if (getUpdateState().phase !== 'ready') return
  quitSwapDone = true
  if (swapAndRelaunch(false)) updateLog('exit', 'installing the staged mac update on quit')
}

function hardExit(): void {
  updateLog('exit', installStarted ? 'handing over to the installer' : 'window closed')
  installStagedMacUpdateOnQuit()
  // The one thing shutdown() cannot reach: the ConPTY console hosts are OUR children,
  // not the agents', so no taskkill of an agent tree names them. This runs after we are
  // gone and only touches consoles whose parent is gone with us. See consoles.ts.
  sweepOwnConsolesOnExit()
  // The other thing shutdown()'s taskkill cannot reach: whatever the panes started that is
  // no longer linked to them. Detached, so it runs once we are not here to be its parent.
  sweepOwnStraysOnExit()
  process.exit(0)
}

app.on('before-quit', () => {
  // Quitting by any other route than the last window closing - the tray, Cmd-Q, the
  // OS asking everyone to leave before a restart. Same record, same order: the desk
  // is written while the panes are still alive to be read.
  saveDeskOnExit(manager.snapshot())
  remote.stop()
  // shutdown() also flushes buffered transcript output, which would otherwise lose the
  // last 1.5 seconds of every pane. It runs once, so the two quit paths cannot double
  // the work between them.
  manager.shutdown()
  stopInstalls()
  installStagedMacUpdateOnQuit()
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Dropping the pipe is enough - Discord clears the presence when the client goes.
  presence.dispose()
  // The history is saved on a debounce now that the write is async; a copy made in the
  // last second of the app's life would otherwise never reach disk.
  flushRecents()
})
