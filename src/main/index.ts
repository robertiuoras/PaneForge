import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
import { countPresence, type PresenceCounts } from '../shared/discordRpc'
import { quitWhere } from '../shared/quitWords'
import { listProjects } from './projects'
import { routeCandidates } from './projectAliases'
import { routePrompt } from '../shared/projectRoute'
import type { RouteResult } from '../shared/projectRoute'
import { DEFAULT_PHONE_PORT, getConfig, projectsRoot, setConfig } from './config'
import { whatsNew } from './whatsNew'
import { addSound, pruneCustomSounds, removeSound, renameSound, soundData } from './sounds'
import { writeAttachments } from './attach'
import { AskNotifier, askMessage, postAsk, telegramCreds } from './askNotify'
import { askKeyOf } from '../shared/autoAnswer'
import type { AttachIn, AttachResult } from '../shared/attach'
import { CHOOSE_GAP_MS, keysForChoice, sameAsk } from '../shared/choices'
import { Remote } from './remote'
import { readInvite } from './remote/invite'
import { PhoneServer, newPhoneCode } from './phone'
import { Tunnel } from './tunnel'
import { callInvoke, callSend, tapIpc } from './ipcTap'
import { surfaceChannels } from '../shared/surface'
import { startDisplayAwake } from './awake'
import { invalidateAgents, listAgents, specFor } from './agents'
import { gitInfo } from './git'
import { projectRoot } from './projectRoot'
import { diffFiles, diffPatch } from './diff'
import type { DiffScope, PhoneState, ShelfEdge } from '../shared/types'
import { detectLane, laneExtras, resolveLane } from './lanes'
import { laneWork, mergeLaneBack, repoOf, returnToBase, sweepLanes, trackTyped } from './laneWork'
import { attachLaneOwners, laneBoards, laneReclaim, laneRetry } from './laneBoard'
import type { LanePane } from './laneBoard'
import { resolveRevealTarget } from './revealPath'
import { which } from './which'
import { ensureDesktopShortcut, syncLaunchAtLogin } from './winShortcut'
import { priorPrompt, recordPrompt } from './promptArchive'
import { splitPrompt } from './splitPrompt'
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
import { startAway, stopAway } from './away'
import {
  initProfile,
  isQuietRelaunch,
  markQuietRelaunch,
  profileName,
  revealPlan,
  startMode,
  titleSuffix
} from './profile'
import { snapPlan } from '../shared/deskSnap'
import { crashTestHook, installCrashGuard, onCrashReport } from './crash'
import { stopRenderWatch, watchRenderer } from './renderWatch'
import {
  rememberAppPid,
  spawnDetachedNoWindow,
  sweepOldConsoles,
  sweepOwnConsolesOnExit
} from './consoles'
import { sweepOldStrays, sweepOwnStraysOnExit } from './strays'
import {
  heldElsewhere,
  lastPrompt,
  projectDir,
  resumable,
  resumeIdFor,
  transcriptPath
} from './transcripts'
import { receiveHandoff, sendHandoff, shareable } from './handoff'
import { clearCommandFor, readAsk as readAutoClearAsk } from '../shared/autoclear'
import { startAutoClearWatch, stopAutoClearWatch } from './autoclearWatch'
import { handoffReceiverCanQuit, type HandoffItem, type HandoffRequest } from '../shared/handoff'
import { HandoffQueue } from './handoffQueue'
import { devServersOf, listRunningDevs, localDevCommand, stopDevServer } from './devServers'
import { listBackJobs, type BackJob } from './backJobs'
import { DEFAULT_AUTO_HANDOFF } from '../shared/autoHandoff'
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
  editRecent,
  flushRecents,
  getRecent,
  listRecents,
  noteOwnCopy,
  pinRecent,
  recentPath,
  recentText,
  recentsDir,
  refreshRecents,
  removeRecent,
  searchRecents,
  startRecents,
  stopRecents
} from './recents'
import {
  beginShelfDrag,
  beginShelfResize,
  closeShelfWindow,
  dropShelfDrag,
  endShelfDrag,
  endShelfResize,
  liftShelfDrag,
  moveShelfDrag,
  moveShelfResize,
  openShelfWindow,
  refreshShelfSummon,
  shownShelfDrag,
  setShelfHidden,
  setShelfQuiet,
  placeShelf,
  setShelfExpanded,
  setStashInWindow,
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
import { logActivation, logReclaim } from './activationLog'
import { ensurePrereq, onPath, refreshPath, runCommand, runOnce, stopInstalls } from './install'
import { swapAndRelaunch } from './macUpdate'
import {
  checkForUpdates,
  consumeInstallRetry,
  getUpdateState,
  initUpdater,
  installUpdate,
  setAutoCheck,
  setDevChannel,
  stagedInstallable,
  updateLog,
  bootMs
} from './updater'
import * as history from './history'
import { readBoard, writeMemory, writeTasks } from './board'
import * as voice from './voice'
import { installCommand, uninstallCommand } from '../shared/agents'
import { installLaneHooks } from './laneHooks'
import { assess, restorePlan, type Pressure } from '../shared/capacity'
import { restoreAsleep } from '../shared/restoreTurn'
import { DEFAULT_RECOVER } from '../shared/recover'
import type { UsageReport } from '../shared/usage'
import { loadPerCore, readPressure, totalMb, watchPressure } from './memory'
import { backJobOf, trackUsage } from './usage'
import { agentsMidTurn, deskBusy, decideInstall } from '../shared/updateHold'
import { STASH_CONFIG_KEYS } from '../shared/types'
import type {
  Config,
  GameModeStatus,
  InstallOutcome,
  PipeInfo,
  RemoteState,
  RestoreAnswer,
  RestoreOffer,
  RestorePane,
  Session,
  StartSessionRequest,
  StashConfig,
  SwarmRequest,
  TaskItem,
  TurnClock,
  UpdateState
} from '../shared/types'
import type { BusyReason } from '../shared/busy'
import type { AgentSpec } from '../shared/agents'

// Before a single handler registers: the phone client calls the same ipcMain bodies the
// window does, and the tap can only record registrations it was in place for.
tapIpc()

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

/*
 * Who asked the app to leave.
 *
 * 2026-08-17, "why was PaneForge closed automatically": no log on the machine could
 * answer it. The exit was recorded (`exit installing the staged mac update on quit`) and
 * the swap script ran, which proves the quit went through `before-quit` rather than
 * through the last window closing - and that was the whole of the evidence. Electron
 * never says what triggered a quit, so every path that quits ON PURPOSE names itself
 * here, and a quit that leaves this empty was a Cmd-Q, the app menu, or a signal from
 * the OS. Naming the absence is the point: "nothing in the app asked" is an answer, and
 * it is the one that was missing.
 */
let quitCause = ''
let quitLogged = false
let panesAtQuit = -1
/*
 * ...and when the app itself did not ask, WHICH of the three it was.
 *
 * 2026-08-21 the sentence below was read for real - nine panes closed with no cause - and
 * it named three possibilities and separated none of them, so the answer was still a
 * guess. A signal cannot be caught (Chromium takes SIGTERM below the JS layer; measured,
 * see `quitReason`), but the three are trivially told apart by WHERE THE SCREEN WAS. A
 * Cmd-Q or an app-menu Quit can only be typed at a frontmost window; a `pkill`, an
 * `osascript ... quit`, a launchd job or a logout all arrive while somebody is looking at
 * something else. So the last time a window of ours had focus is recorded, and the quit
 * line carries it. It is evidence, not a verdict - it says "not from this keyboard",
 * which is exactly the half that was missing.
 */
let lastFocusAt = 0
let focused = false
/**
 * How many panes were open when leaving started.
 *
 * Read at the FIRST sign of a quit, never at the log line: `doInstall` and the admin
 * relaunch both call `manager.shutdown()` and only then `hardExit()`, so a count taken
 * where it is printed is always 0 and the number stops meaning anything. Wrapped because
 * the single-instance loser quits from module scope, above where `manager` is built.
 */
function notePanes(): void {
  if (panesAtQuit >= 0) return
  try {
    panesAtQuit = manager.list().length
  } catch {
    panesAtQuit = 0
  }
}
function quitting(cause: string): void {
  notePanes()
  if (!quitCause) quitCause = cause
}
/**
 * The one quit line, wherever leaving started.
 *
 * Both handlers used to write one. On macOS Cmd-Q they are not alternatives: `before-quit`
 * runs, Electron then closes the windows, and `window-all-closed` runs too - so one press
 * logged twice, and the second line said "the last window was closed", which is the
 * CONSEQUENCE of the quit being reported as its cause. Found by the review of v0.8.93.
 */
function logQuit(): void {
  if (quitLogged) return
  quitLogged = true
  notePanes()
  updateLog('quit', quitReason(), `${panesAtQuit} pane(s) open`)
}
/** The words for the log line, including the case where nothing in the app fired. */
function quitReason(): string {
  // A signal is deliberately NOT separated out here, and it was tried: Chromium takes
  // SIGTERM below the JS layer, so `process.on('SIGTERM', ...)` in the main process never
  // runs - measured by SIGTERMing a test copy, which wrote this exact line with the
  // handler installed. `pkill`, a launchd job and Cmd-Q are one case from in here, and
  // saying so is better than a sentence that only names the fingers.
  if (quitCause) return quitCause
  // Where the screen was, so the three are no longer one case. Words: shared/quitWords.ts.
  return `nothing in the app asked - ${quitWhere(focused, lastFocusAt, Date.now())}`
}

if (!app.requestSingleInstanceLock(launchRequest)) {
  quitting('another copy already holds the single-instance lock')
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
  // Two copies of the app on one desk take a half of the external screen each - the live
  // app left, `npm run try` right - so a change can be looked at beside the thing it
  // changed without anybody dragging windows. Nothing happens on the laptop's own screen,
  // which is the common case: see shared/deskSnap.ts, where every rule is a refusal.
  const snap = snapPlan(
    screen.getAllDisplays().map((d) => ({ id: d.id, internal: d.internal, workArea: d.workArea })),
    profileName()
  )
  if (snap) updateLog('window', `snapped ${snap.side} half of the external screen`)
  // A snapped window is a placed window, so it must not also open filling a display.
  pseudoMax = cfg.window.maximized && mode !== 'normal' && !snap
  const area = snap?.bounds ?? (pseudoMax ? workAreaFor(cfg) : null)
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

  if (cfg.window.maximized && !pseudoMax && !snap) win.maximize()
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
    // A borrow that was never handed back is invisible until somebody drags the window,
    // because the desk only sends a resize when ITS OWN measurement moves - and it never
    // does: xterm still holds 157x57 while the pty sits at the phone's 120x30, so `fit()`
    // computes the same numbers it already has and returns without a word. Measured on a
    // live pane whose CLI addressed no row past 30 in a 57-row window: the space below the
    // composer was screen the agent had never been told about. Coming back to the desk is
    // a person at the desk, which is exactly who owns the size, so take it back here too
    // rather than waiting for the phone to close politely. No-op unless something is
    // actually borrowed.
    manager.returnSizes()
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
      quitting('an unopened test copy timed itself out')
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
    stopRenderWatch()
    // Output batched for a window that no longer exists has nowhere to go. send()
    // already no-ops on a dead window; this stops the pump holding the string and
    // waking a timer to deliver it to nobody.
    pump.discard()
    // The overlay is a window too, so leaving it open would make `window-all-closed`
    // never fire and the app would stay alive with nothing on screen but a pill.
    closeShelfWindow()
  })
  // A renderer that wedges or dies used to be the end of the app: the main process, every
  // pty and the whole desk stayed healthy behind a window that could not be drawn in, and
  // the only way out was killing PaneForge by hand (2026-08-28, ~14 min of renderer CPU
  // with the main thread parked in mach_msg). Reloading is safe here because a pane is
  // restored from desk.json and `--resume`, the same path a restart uses.
  watchRenderer(win, () => {
    const dead = win
    win = null
    try {
      dead?.destroy()
    } catch {
      /* it is already gone; the point was to stop referencing it */
    }
    createWindow()
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

/**
 * The phone client: this window's own UI, served over HTTP to a browser on this network.
 *
 * Every call lands in the ipcMain body the window's own would (`ipcTap.ts`), so there is
 * no second surface to keep in step - see `phone.ts` for why it is off by default and
 * what the code protects. Nothing about a pane moves; only the drawing happens elsewhere.
 *
 * Declared above `send()` because `send()` hands it every event, and a const read before
 * its declaration is a crash rather than an undefined.
 */
const phone = new PhoneServer({
  staticDir: join(__dirname, '../renderer'),
  code: () => getConfig().phone?.code ?? '',
  // The device id already exists and already survives an upgrade's config merge; the
  // cookie is derived from it and the code, so there is no token to store or to expire.
  secret: () => getConfig().remote.id,
  invoke: (channel, args) => callInvoke(channel, args),
  send: (channel, args) => callSend(channel, args),
  channels: surfaceChannels(),
  // Read and written through the config, like everything else that has to survive a
  // restart: a device approved on Friday is still approved on Monday, which is the whole
  // promise ("allow sign in for the future"), and a token held only in memory would break
  // it on the first update the app installs for itself.
  devices: () => getConfig().phone?.devices ?? [],
  saveDevices: (list) => {
    const cfg = getConfig()
    setConfig({ phone: { ...cfg.phone!, devices: list } })
  },
  canAsk: () => getConfig().phone?.ask !== false,
  // The passkey gate's two halves, stored the same way and for the same reason: an enrolled
  // authenticator has to survive a restart, and the counter has to move on with it or the
  // clone check would refuse the real phone after the first update.
  keys: () => getConfig().phone?.keys ?? [],
  saveKeys: (list) => {
    const cfg = getConfig()
    setConfig({ phone: { ...cfg.phone!, keys: list } })
  },
  typeGate: () => getConfig().phone?.typeGate !== false,
  onIdle: () => manager.returnSizes(),
  onChange: () => send('phone:changed', phoneState())
})

/**
 * A way in from a network that is not this one.
 *
 * Its own switch under the phone's, never implied by it: serving on the LAN and putting a
 * public https address in front of that are different promises, and only the second one
 * makes the pairing code the whole of the lock. See `tunnel.ts`.
 */
const tunnel = new Tunnel({
  dir: join(app.getPath('userData'), 'bin'),
  onChange: () => send('phone:changed', phoneState())
})

/**
 * Long enough to survive being on the open internet. Six characters is a LAN number; the
 * arithmetic that makes it one is in `newPhoneCode`. Nobody types either - the QR carries
 * it - so the only cost of the longer one is that it looks less friendly on screen.
 */
const LONG_CODE_LEN = 14

/** The code a public address needs, rotated in only when it is not already long enough. */
function ensureCodeFor(tunnelOn: boolean): void {
  const cfg = getConfig()
  const code = cfg.phone?.code ?? ''
  if (!tunnelOn || code.length >= LONG_CODE_LEN) return
  setConfig({ phone: { ...cfg.phone!, code: newPhoneCode(LONG_CODE_LEN) } })
}

// The window can be gone (quit) or destroyed-but-still-referenced (teardown order)
// while pty output and session events are still in flight.
function alive(): boolean {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
}

/**
 * Things that re-read the desk whenever it changes: the display-sleep hold and any
 * /clear countdown in flight. A mutable holder rather than a direct call because `send`
 * is defined above the things it pokes, and a startup broadcast would otherwise hit a
 * const that has not been initialised yet.
 */
let onDeskChanged: (() => void) | null = null

function send(channel: string, ...args: unknown[]): void {
  // Ahead of the window check on purpose: a phone watching this desk must keep getting
  // output while the window is minimized, hidden, or being rebuilt after a quiet restart.
  phone.broadcast(channel, args)
  if (channel === 'sessions:changed') onDeskChanged?.()
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

/** Receiver-only: a handoff asked to leave this PC clean after its transferred work ends. */
const closeAfterHandoff = new Set<string>()
let closingAfterHandoff = false
function closeReceiverWhenClear(): void {
  if (closingAfterHandoff || !handoffReceiverCanQuit(closeAfterHandoff, manager.list())) return
  closingAfterHandoff = true
  quitting('handoff receiver - every transferred pane has ended')
  app.quit()
}

manager.on('data', (id: string, data: string) => {
  pump.push(id, data)
})
manager.on('sessions', () => {
  // A pane's last output has to reach the renderer before the list says it exited,
  // or the final lines land after the pane has already been drawn as dead.
  pump.flush()
  send('sessions:changed', allSessions())
  // A queued handoff is waiting for a turn to END, and a turn ending is exactly this
  // event. On the 5s tick alone, "as soon as the turn ends" was up to five seconds of a
  // finished pane sitting under a `waiting` chip. Free when nothing is queued.
  handoffQueue.poke()
  // Every pane start, exit, rename and agent switch arrives here, which is the
  // whole of "the desk changed". Debounced inside: a swarm launch is six of these
  // in a second and they are worth one write.
  noteDesk()
  presence.update(presenceCounts())
  closeReceiverWhenClear()
})

// Discord Rich Presence: "3/6 sessions running" on the user's profile, refreshed as
// turns start and finish.
//
// The WHOLE desk, mirrored panes included. This counted local panes only, on the
// reasoning that a mirrored pane is counted by the device its agent actually runs on -
// which is never true in practice: a Discord account shows ONE presence, so the other
// device's PaneForge has nowhere to publish its half, and those panes went uncounted
// everywhere. Measured 2026-08-17: eight panes on screen with five running turns, and
// the profile said "4/5 sessions running" - the five being the local half of the desk.
// The mirrored view is what the user is looking at, so it is what the profile says.
const appStartedAt = Date.now()
const presence = new DiscordPresence({
  enabled: getConfig().discordPresence,
  style: getConfig().discordStyle,
  // The Discord tab reports Discord's own answer rather than guessing from the switch,
  // so every change of that answer has to reach an open Settings dialog by itself.
  onStatus: (s) => send('discord:status', s)
})
function presenceCounts(): PresenceCounts {
  return countPresence(allSessions(), appStartedAt)
}
manager.on('attention', (s: Session) => raiseAttention(s))
manager.on('stalled', (s: Session) => raiseStalled(s))
manager.on('bell', (s: Session) => raiseBell(s))
manager.on('ask', (s: Session) => raiseAsk(s))

/**
 * One phone message per question. The pane raises `ask` once per FRAME of a question and
 * a chooser arrives over several frames, so the notifier waits for the frames to stop.
 */
const askNotifier = new AskNotifier({
  post: (text: string) =>
    postAsk(text).then((sent) => {
      if (!sent && telegramCreds()) console.log("telegram: could not post a pane question")
      return sent
    })
})

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

/**
 * A pane is sitting on a question.
 *
 * Different from `raiseAttention` in the one way that matters: that one says "finished or
 * needs input", and this one KNOWS which. A question stops the run until somebody presses
 * a row, and every idle reading in the app calls that pane finished - so this is the one
 * alert worth sending off the machine, and it goes to Telegram (askNotify.ts) as well as
 * to the desk. The pane and its card also turn red, which is the part that works with no
 * credentials at all.
 *
 * The taskbar flash and the toast keep the app's manners: nothing while a game is on
 * screen, nothing while the window is focused. The Telegram message does NOT - a phone in
 * a pocket is the whole point, and the desk being focused says nothing about somebody
 * being at it. It is skipped for a mirror: that pane's own machine is raising it too, and
 * two messages for one question is how a notification stops being read.
 */
function raiseAsk(s: Session): void {
  // The renderer first and unconditionally: it owns the sound, and a question is the one
  // alert that must not be gated on the notification settings below - a run that has
  // stopped dead is not a notification preference.
  send('sessions:ask', s)
  if (!s.remote && getConfig().telegramAsk) {
    // Debounced, and resolved at the END of the wait rather than now: the option labels
    // stream in, so this same event fires several times for ONE question with a longer
    // label each time. Sending on the frame would put three messages on the phone for one
    // chooser, which is exactly what happened. See ASK_SETTLE_MS in askNotify.ts.
    askNotifier.schedule(s.id, () => {
      const live = allSessions().find((x) => x.id === s.id)
      // Answered at the desk while this was waiting: there is nothing left to ask about.
      if (!live?.ask) return null
      return { key: askKeyOf(live.ask), text: askMessage(live.title, live.ask, undefined) }
    })
  }
  if (!getConfig().notifyOnIdle || isGameActive()) return
  if (!alive() || win!.isFocused()) return
  win!.flashFrame(true)
  if (!Notification.isSupported()) return
  new Notification({
    title: `${s.title} is asking you something`,
    body: s.ask?.question?.slice(0, 180) ?? 'It is waiting on an answer.',
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
  // `viewer` is who is asking, and it MUST be forwarded rather than named here: this one
  // object is the phone's surface AND the remote host's backend, so hardcoding a name
  // filed every paired device's borrow under the phone's own slot - two viewers writing
  // one entry, which is exactly the last-writer-wins the borrow map replaced. Measured
  // 2026-08-23 with a real guest: `host-resize ... guest:1` arrived at the manager as
  // `viewer=phone`. The default stays 'phone' because only the host passes a name.
  resize: (id, cols, rows, borrowed, viewer) =>
    manager.resize(id, cols, rows, borrowed === true, typeof viewer === 'string' ? viewer : 'phone'),
  returnSize: (id, viewer) => manager.returnSize(id, viewer),
  redraw: (id) => manager.redraw(id),
  setBusy: (id, busy, tail, clock, reason) => manager.setBusyOnScreen(id, busy, tail, clock, reason),
  clearAttention: (id) => manager.clearAttention(id),
  kill: (id) => manager.kill(id),
  restart: (id) => manager.restart(id),
  rename: (id, title) => manager.rename(id, title),
  switchAgent: (id, agent, model) => manager.switchAgent(id, agent, model),
  // A guest's launch goes through the same lane split a local one does: two agents
  // in one repo must not share a checkout just because one of them is remote.
  startSession: async (req) => manager.start(await laneFor(req)),
  // A pane handed here from another device: pull its branch, drop its transcript
  // where the CLI will look, start it as an ordinary local pane. The lane split
  // applies exactly as it would to a local launch - two agents in one repo must
  // not share a checkout because one of them arrived by handoff.
  receiveHandoff: (payload, file) =>
    receiveHandoff(
      {
        root: projectsRoot,
        place: (req) => laneFor(req),
        start: (req) => manager.start(req),
        historyDir: () => join(app.getPath('userData'), 'history'),
        noteTailCols: (id, cols) => history.noteCols(id, cols),
        claudeProjectDir: projectDir,
        startDev: (dir, script) => startDevServer(dir, script)
      },
      payload,
      file
    ).then((result) => {
      if (payload.closeReceiverWhenDone && result.ok && result.session) {
        closeAfterHandoff.add(result.session.id)
        closeReceiverWhenClear()
      }
      return result
    }),
  // A device that mirrors one of our panes asking for it back. It is the ordinary
  // outward handoff, aimed at the device that asked - so a mid-turn pane is queued and
  // travels when its turn ends, exactly as it would had somebody pressed Hand off here.
  handBack: (id, device) => runHandoff(device, { ids: [id], waitForTurn: true }),
  projects: () => Promise.resolve(listProjects()),
  agents: () => Promise.resolve(listAgents()),
  jobs: () => ownJobs(),
  attachFiles: (files) => writeAttachments(files),
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
// The app is about to type a clear into a pane nobody pressed a key in. The screen has to
// be pushed into the scrollback before the CLI paints over it, and only the renderer can
// do that - see the arm in sessions.ts.
manager.on('armclear', (id: string) => send('pane:armClear', id))
remote.on('reset', (id: string) => {
  pump.flushOne(id)
  send('pane:reset', id)
})
remote.on('sessions', () => {
  pump.flush()
  send('sessions:changed', allSessions())
  // The other machine's turns start and end here and nowhere else. Without this the
  // presence only ever moved when a LOCAL pane changed, so a desk whose running work
  // was all on the other device sat on whatever frame the local half last produced.
  presence.update(presenceCounts())
})
remote.on('attention', (s: Session) => raiseAttention(s))
remote.on('changed', (state: RemoteState) => {
  send('remote:changed', state)
  publishCapacity()
})

/**
 * What this machine can still hold, pushed to the renderer whenever it changes.
 *
 * The app used to have no opinion about this at all - `freemem`, `totalmem` and
 * `pressure` appeared nowhere in the source - so a desk that ran out of memory looked
 * like an app that had got slow. Measured 2026-08-14 on an M4/16 GB with six panes open:
 * load average 105.77 while 32.73% of the CPU was IDLE, 6.3 GB in the compressor. The
 * panes were not the cost (PaneForge held 248 MB of it); the agents inside them were, at
 * ~190 MB each, and the builds those agents started were worse - one alone held 1442 MB.
 *
 * So this reports a verdict rather than a reading, and the renderer acts on it by
 * trimming the scrollback of panes nobody is looking at. `startOn` already lets a pane
 * run on a paired device, which is the real answer when a machine is full, so the
 * verdict says when to offer it.
 */
function publishCapacity(): void {
  const mirrored = remote.sessions().length
  const peers = remote.state().peers.filter((p) => p.status === 'online').length
  send(
    'capacity:changed',
    assess({
      totalMb: totalMb(),
      pressure: lastPressure,
      // What a person calls lagging, and it moves minutes before the memory verdict does.
      load: loadPerCore(),
      localPanes: manager.list().length,
      remotePanes: mirrored,
      peerAvailable: peers > 0,
      // How many agents this desk agreed to run itself. Read live rather than captured:
      // changing it in Settings has to reach the next reading, which is this one.
      keepLocal: (getConfig().autoHandoff ?? DEFAULT_AUTO_HANDOFF).keepLocal,
      // Whether the ladder is going to answer this reading itself. Only decides whether the
      // strip SAYS it - see `Verdict.say`.
      willMove: (getConfig().autoHandoff ?? DEFAULT_AUTO_HANDOFF).enabled === true
    })
  )
}

/**
 * What every pane is costing, measured, four seconds at a time.
 *
 * `capacity:changed` above is a VERDICT from a model - 190 MB an agent, whatever the agent
 * is doing. This is the reading, per pane and totalled, and it exists because the model
 * cannot answer the question a person asks with four panes open and the fans up: which one
 * of these is eating my machine. The sampler measures the pty's whole tree, so a pane that
 * started a build reports the build.
 *
 * Pushed rather than polled, and pushed only while a window can be looked at - the sampler
 * itself declines to read the process table when the app is hidden or minimized.
 */
let lastUsage: UsageReport | null = null
const stopUsage = trackUsage(
  () => manager.roots(),
  (r) => {
    lastUsage = r
    send('usage:changed', r)
  }
)
// A window opened after the last sample (a reload, a quiet restart) would otherwise draw
// no figures until the next tick.
ipcMain.handle('usage:get', () => lastUsage)

// The dev servers running on this machine, for the mascot's "what dev servers are
// running". The renderer supplies only the ORDER and the words - which pane is number 3,
// and what that project is called - because that is the sidebar's own arithmetic and main
// has never had it. Every FACT is read here: the folder off the pane's own record and the
// pty's pid off the manager, so a caller cannot point this at a folder it does not own.
ipcMain.handle('devs:list', async (_e, panes: Array<{ id: string; pane: number; name: string }>) => {
  const roots = manager.roots()
  const live = manager.list()
  const asked = Array.isArray(panes) ? panes : []
  const known = asked
    .map((p) => {
      const s = live.find((x) => x.id === p.id)
      if (!s) return null
      return {
        id: s.id,
        pane: Number(p.pane) || 0,
        name: String(p.name || s.title || ''),
        cwd: s.cwd,
        pid: roots.find((r) => r.id === s.id)?.pid ?? 0
      }
    })
    .filter(Boolean) as Array<{ id: string; pane: number; name: string; cwd: string; pid: number }>
  return listRunningDevs(known)
})

ipcMain.handle('devs:stop', (_e, pid: number) => stopDevServer(Number(pid)))

/**
 * What this machine is running that no pane owns - see `shared/backJobs.ts`.
 *
 * Every fact is read here: the pane ptys off the manager and the projects root off the
 * config, so neither a renderer nor a guest on the device link can point this at pids or
 * folders it does not own. It is one whole `ps -Ao command=`, so it is asked when a person
 * opens the panel and never on a timer.
 */
function ownJobs(): Promise<BackJob[]> {
  return listBackJobs(
    manager.roots().map((r) => r.pid),
    [projectsRoot()]
  )
}
ipcMain.handle('jobs:list', () => ownJobs())
// The same question asked of a paired machine, which is the whole reason this exists: a
// PC running scheduled agent turns and cron loops had no surface here at all. A device
// that is not connected REJECTS rather than answering an empty list - see `Remote.jobsOn`.
ipcMain.handle('jobs:remote', (_e, device: string) => remote.jobsOn(String(device)))

let lastPressure: Pressure = 'normal'
// Only fires on a CHANGE of level, so this is a handful of messages in a session rather
// than one every 15 seconds. Pane counts move far more often than pressure does, hence
// the extra publish calls where sessions and peers change.
const stopPressure = watchPressure((p) => {
  lastPressure = p
  publishCapacity()
})
manager.on('sessions', () => publishCapacity())

// Whether anybody is at this machine. The renderer's idle clock freezes while nobody is,
// so a pane is never closed during minutes a person had no chance to stop it in. Pushed on
// a CHANGE only - two messages per absence. See src/shared/away.ts.
startAway((a) => send('system:away', a))

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
  // A pane opened by hand in a lane folder - the lane hook, a terminal, a restored desk -
  // never went through resolveLane, so it carried no lane id and its card printed the raw
  // `taskdriver.ai-c` while a pane the app had moved itself said `assistant` + `lane a`.
  // The label is a reading of the folder, not a lane being created, so it is filled in
  // whether or not auto-laning is on. See detectLane: git proves it, the name never does.
  const known = async (r: StartSessionRequest): Promise<StartSessionRequest> =>
    r.lane ? r : { ...r, lane: await detectLane(r.cwd) }
  if (!getConfig().autoLane) return known(req)
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
    return known(lane.note ? { ...req, laneNote: lane.note } : req)
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
ipcMain.handle('sessions:sleep', (_e, id: string) => {
  // A mirrored pane's pty is the other machine's, and sleeping it there is that desk's
  // decision to make - `canSleep` refuses a mirror at the renderer end too.
  if (remote.owns(id)) return null
  return manager.sleep(id)
})
ipcMain.handle('sessions:wake', (_e, id: string) => {
  if (remote.owns(id)) return null
  return manager.wake(id)
})
ipcMain.handle('sessions:switchAgent', (_e, id: string, agent: string, model?: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'switch', agent, model }), null
  return manager.switchAgent(id, agent, model)
})
ipcMain.handle('sessions:rename', (_e, id: string, title: string) =>
  remote.owns(id) ? remote.send(id, { t: 'rename', title }) : manager.rename(id, title)
)
ipcMain.handle('sessions:kill', (_e, id: string) => {
  if (remote.owns(id)) {
    // The row goes at once on a live link; a link that could not carry the frame is said
    // out loud, because silence here is a button that looks broken and gets pressed again.
    if (!remote.closeOn(id)) send('app:error', 'That device is not connected - the pane was not closed.')
    return
  }
  // A client asking to close a pane this desk does not have is a client holding a STALE
  // list - a phone whose event stream was down while the pane was closed. `kill` on an
  // unknown id changes nothing, so nothing was broadcast, so the row it was pressing
  // could never go: the pane looked stuck and the button looked broken. Answer a stale
  // ask with the truth.
  const known = allSessions().some((s) => s.id === id)
  manager.kill(id)
  if (!known) send('sessions:changed', allSessions())
  return
})
ipcMain.handle('sessions:buffer', (_e, id: string) =>
  remote.owns(id) ? remote.buffer(id) : manager.buffer(id)
)
/**
 * The same pane, further back than the in-memory replay reaches - off its transcript.
 *
 * A mirrored pane's transcript is written on the machine that owns the pty, so there is
 * nothing here to read and the live replay is the whole of what this device has. Answered
 * with the buffer rather than with an error: the caller wants as much of this pane as can
 * be had, and "as much as exists here" is the honest answer to that.
 */
ipcMain.handle('app:whatsNew', () => whatsNew())
ipcMain.handle('sessions:log', (_e, id: string, bytes?: number) =>
  remote.owns(id)
    ? remote.buffer(id)
    : history.tail(id, Math.min(Math.max(Number(bytes) || 2_000_000, 1), 8 * 1024 * 1024)) ||
      manager.buffer(id)
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
/** Bytes into a pane, wherever that pane lives. The one path anything here types through. */
function writePane(id: string, data: string): void {
  if (remote.owns(id)) return remote.send(id, { t: 'write', data })
  watchForClear(id, data)
  // Nothing typed here stands a countdown down any more. It used to: a write carrying one
  // printable character cancelled the pane's own /clear outright, which meant the card
  // vanished the moment anybody touched the pane it was about - and touching the pane is
  // what a person does when a countdown appears on it. Robert, 2026-08-27: "it should
  // continue counting down no matter what for the clear unless i click on keep this
  // session". The one thing typing must still prevent is being typed OVER, and that is
  // handled where it can be handled honestly: `expiryDecision` returns 'wait' for an
  // unsent draft, so the timer asks again rather than the countdown disappearing.
  manager.write(id, data)
}

ipcMain.on('pty:write', (_e, id: string, data: string) => writePane(id, data))

// ---- and keeping the system awake while a pane works ---------------------------------
const displayAwake = startDisplayAwake({
  panes: () =>
    allSessions().map((s) => ({
      runSince: s.runSince,
      status: s.status,
      asking: !!s.ask,
      job: s.job,
      lastOutput: s.lastOutput,
      lastKeyboard: s.lastKeyboard
    })),
  enabled: () => getConfig().keepDisplayAwake !== false,
  log: (line) => console.log(`[awake] ${line}`)
})

onDeskChanged = (): void => {
  displayAwake.tick()
}

// A job the APP hands a chat, not bytes a person typed: the text goes in and the return is
// pressed for real. Never `notePaneInput` - that means a person took a dispatched pane
// over, and this is the opposite.
ipcMain.on('pty:prompt', (_e, id: string, text: string) => {
  if (!text) return
  if (remote.owns(id)) {
    // The link has no prompt op, so this is the separate-keystroke half only: two
    // messages rather than one write with the CR glued on. Timing on the other machine
    // is that machine's own composer, which this side cannot read.
    remote.send(id, { t: 'write', data: text })
    setTimeout(() => remote.send(id, { t: 'write', data: '\r' }), 600)
    return
  }
  manager.sendPrompt(id, text)
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
ipcMain.on(
  'pty:resize',
  (_e, id: string, cols: number, rows: number, borrowed?: boolean, viewer?: string) => {
    const who = typeof viewer === 'string' && viewer ? viewer : borrowed === true ? 'phone' : 'window'
  // A mirrored pane's resize is not dropped any more: it is sent to the machine that
  // owns the pty as a BORROW, so the far end draws at the grid this window has room for
  // and keeps its own desk size to go back to. See `mirrorFit` in TerminalPane.
    // The borrow is carried across the link under the name of the screen that asked, or
    // this whole device is ONE viewer over there: the desk window's 157 columns and a
    // phone's 50 land in the same slot on the far end and the last one to speak wins. That
    // is "the Mac shows the remote pane at phone size" - the phone's borrow overwrote the
    // window's and nothing ever put it back.
    if (remote.owns(id)) {
      if (borrowed === true) borrowedRemote(who).add(id)
      remote.resizeOn(id, cols, rows, who)
    }
    // A borrowed resize over this channel is a PHONE drawing the pane - the desk window
    // never borrows, it owns. Named so a mirror watching the same pane is a separate
    // borrower rather than the same one changing its mind.
    else manager.resize(id, cols, rows, borrowed === true, who)
  }
)
/**
 * Which mirrored panes each screen here is borrowing, so `pty:return` can hand back a
 * borrow that lives on ANOTHER machine. A local borrow is remembered by the session it
 * is on; a remote one is remembered by the far end, which never hears about a phone
 * being put down unless this side says so.
 */
const remoteBorrows = new Map<string, Set<string>>()
function borrowedRemote(viewer: string): Set<string> {
  const held = remoteBorrows.get(viewer)
  if (held) return held
  const made = new Set<string>()
  remoteBorrows.set(viewer, made)
  return made
}
/**
 * The phone has looked away, so the desk gets its shape back. A phone drawing a pane at
 * 50 columns is right for the phone and wrong for the 157-column window it is also drawn
 * in, and before this nothing ever undid it - see `resize` in sessions.ts.
 */
ipcMain.on('pty:return', (_e, viewer?: string) => {
  const who = typeof viewer === 'string' && viewer ? viewer : 'phone'
  manager.returnSizes(who)
  const held = remoteBorrows.get(who)
  if (!held) return
  for (const id of held) remote.returnSizeOn(id, who)
  held.clear()
})
/**
 * Which panes are on screen, so the pump can gather a background pane's output for
 * longer (dataPump.ts). Every screen watching this desk says for itself and carries
 * its OWN id - the desk window and each phone are different screens, and either one
 * showing a pane makes it visible. Identity comes from the client rather than from
 * anything about the transport: a phone's call arrives through `ipcTap` with a
 * stand-in event, so main cannot tell two phones apart, and telling them apart is
 * exactly what stops the second one erasing the first one's panes.
 *
 * A claim expires (see `CLAIM_TTL_MS`), so a phone that was closed, locked or driven
 * out of range stops counting on its own. Nothing here needs a disconnect.
 */
ipcMain.on('pty:visible', (_e, client: string, ids: string[], viewer?: string) => {
  if (typeof client !== 'string' || !client || !Array.isArray(ids)) return
  pump.setVisible(client, ids)
  // The same tick is the heartbeat under a pane's size borrow: a screen saying which
  // panes it has renews its lease on those, and every borrow whose screen has gone
  // quiet expires here. That is what gives the desk its pane back when a phone locks,
  // backgrounds or walks out of range without ever saying `pty:return`.
  manager.touchBorrows(typeof viewer === 'string' && viewer ? viewer : 'window', ids)
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
  (_e, id: string, busy: boolean, tail?: string, clock?: TurnClock, reason?: BusyReason) => {
    if (!remote.owns(id)) manager.setBusyOnScreen(id, busy, tail, clock, reason)
  }
)

// The idle clock's deadline, from the window that decides it. Refused for a mirrored id
// for the same reason the busy footer is: the pane lives on the other machine, and its
// own desk publishes when it will close it.
ipcMain.on('sessions:closing', (_e, id: string, at: number | null, kept?: boolean) => {
  if (!remote.owns(id)) manager.setClosingAt(id, typeof at === 'number' ? at : null, kept === true)
})

ipcMain.handle('sessions:swarm', (_e, req: SwarmRequest) => manager.startSwarm(req))

ipcMain.handle('config:get', () => getConfig())
ipcMain.handle('config:set', (_e, patch: Partial<Config>) => {
  const next = setConfig(patch)
  // An edited custom agent changes what is launchable, so the availability cache
  // must not outlive the edit.
  if (patch.customAgents) invalidateAgents()
  // A key pasted into Settings changes which models the picker may offer, and the
  // availability cache is 20s long - long enough that "I pasted the key and the models
  // are still not there" is the first thing anybody sees.
  if (patch.providerKeys || patch.openrouterKey !== undefined) invalidateAgents()
  if (patch.saveHistory !== undefined) history.setHistoryEnabled(patch.saveHistory)
  if (patch.discordPresence !== undefined || patch.discordStyle !== undefined) {
    presence.configure(next.discordPresence, next.discordStyle)
    presence.update(presenceCounts())
  }
  if (patch.silenceAlertMin !== undefined) setSilenceAlert(patch.silenceAlertMin)
  if (patch.autoUpdate !== undefined) setAutoCheck(patch.autoUpdate)
  if (patch.devUpdates !== undefined) {
    setDevChannel(patch.devUpdates)
    // Joining the dev channel means "there may already be a build for me": look now,
    // not at the next half-hour tick. Leaving it re-resolves to the promoted release.
    void checkForUpdates()
  }
  if (patch.voice !== undefined) applyVoiceHotkey(next)
  if (patch.gameMode !== undefined) refreshGameWatch(next)
  if (patch.clipboardShelf !== undefined) applyClipboardShelf(next)
  else if (patch.clipboardOverlay !== undefined) applyShelfOverlay(next)
  if (patch.stashSummon !== undefined) refreshShelfSummon()
  // The Stash caps apply to what is already on it, not only to the next thing added, so
  // they go through even when the watcher itself was not touched.
  if (
    patch.stashMaxItems !== undefined ||
    patch.stashMaxImages !== undefined ||
    patch.stashFileHours !== undefined ||
    patch.stashMaxFileMb !== undefined ||
    patch.stashDeny !== undefined
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

/**
 * "Open the folder" for a PANE, which is not the same question as "open this path".
 *
 * A pane running in a lane is running in a git worktree, and a worktree is scratch - its
 * untracked files are swept with it. Somebody pressing a folder button means the project,
 * so a lane resolves to its trunk checkout. Everything else, including a folder git will
 * not answer about, opens exactly what it was handed.
 *
 * Returns the folder actually opened, so the caller can say which one that was.
 */
ipcMain.handle('shell:revealProject', async (_e, cwd: string) => {
  const root = await projectRoot(cwd ?? '')
  try {
    if (!statSync(root).isDirectory()) return null
  } catch {
    return null /* gone: pointing Explorer at it would just raise an error dialog */
  }
  shell.openPath(root)
  return root
})
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
  return laneBoards(panes).map((b) => attachLaneOwners(b, panes))
})

// What the agent in a folder has actually changed. Read-only, and the file list and the
// patches are separate calls on purpose - a 300-file diff is 300 patches nobody opened.
ipcMain.handle('git:diffFiles', (_e, cwd: string, scope: DiffScope) => diffFiles(cwd, scope))
ipcMain.handle(
  'git:diffPatch',
  (_e, cwd: string, scope: DiffScope, path: string, untracked: boolean) =>
    diffPatch(cwd, scope, path, untracked)
)

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
// The phone client. `phone:changed` goes out from the server's own onChange, so a browser
// arriving or leaving updates Settings without anything polling.
/** Every phone answer carries the tunnel too: one state, one repaint, no second poll. */
function phoneState(): PhoneState {
  const cfg = getConfig()
  return {
    ...phone.state(),
    tunnel: tunnel.state(),
    typeGate: cfg.phone?.typeGate !== false,
    // The stored row minus its public key: the panel names it and takes it away, and
    // nothing in the window has any use for the key itself.
    keys: (cfg.phone?.keys ?? []).map((k) => ({ id: k.id, label: k.label, at: k.at }))
  }
}
ipcMain.handle('phone:typeGate', (_e, on: boolean) => {
  const cfg = getConfig()
  setConfig({ phone: { ...cfg.phone!, typeGate: !!on } })
  send('phone:changed', phoneState())
  return phoneState()
})
/**
 * Take a passkey away. `*` takes them all, matching how devices are signed out.
 *
 * Immediate, not eventual: the unlock cookie names the credential it was minted for, and
 * `checkUnlock` refuses one whose key is no longer in the list - so a window that was open
 * when this ran is shut by the next request, not by its expiry.
 */
ipcMain.handle('phone:forgetKey', (_e, id: string) => {
  const cfg = getConfig()
  const keys = id === '*' ? [] : (cfg.phone?.keys ?? []).filter((k) => k.id !== id)
  setConfig({ phone: { ...cfg.phone!, keys } })
  send('phone:changed', phoneState())
  return phoneState()
})
ipcMain.handle('phone:state', () => phoneState())
ipcMain.handle('phone:serve', async (_e, on: boolean) => {
  const cfg = getConfig()
  const port = cfg.phone?.port ?? DEFAULT_PHONE_PORT
  setConfig({ phone: { ...cfg.phone!, on: !!on } })
  if (!on) {
    // The tunnel points at a port that is about to stop answering; leaving it up would
    // publish an address that 502s, which reads as a broken app rather than a closed door.
    await tunnel.stop()
    await phone.stop()
    return phoneState()
  }
  await phone.start(port)
  if (cfg.phone?.tunnel) void tunnel.start(port)
  // Serving is the moment somebody is about to pair, and the tunnel switch is an inch
  // away: having the 20 MB binary already on disk is what makes that switch feel like a
  // switch instead of a download.
  tunnel.prefetch()
  return phoneState()
})
ipcMain.handle('phone:port', async (_e, port: number) => {
  const next = Math.max(1024, Math.min(65535, Math.round(Number(port) || DEFAULT_PHONE_PORT)))
  const cfg = getConfig()
  setConfig({ phone: { ...cfg.phone!, port: next } })
  if (!phone.running) return phoneState()
  await phone.start(next)
  // The tunnel is bound to the OLD port, so it is restarted rather than left pointing at
  // a door that moved. A new quick tunnel means a new address, which the panel redraws.
  if (tunnel.running) void tunnel.start(next)
  return phoneState()
})

/**
 * Reachable from anywhere, or not. The first `on` downloads cloudflared once (19-54 MB)
 * and can take a minute; the phases are reported rather than awaited silently.
 */
ipcMain.handle('phone:tunnel', async (_e, on: boolean) => {
  const cfg = getConfig()
  setConfig({ phone: { ...cfg.phone!, tunnel: !!on } })
  if (!on) {
    await tunnel.stop()
    return phoneState()
  }
  // Before the address exists, never after: a public URL that is live for even a second
  // in front of a six-character code is the window this is meant to close.
  ensureCodeFor(true)
  send('phone:changed', phoneState())
  const port = cfg.phone?.port ?? DEFAULT_PHONE_PORT
  if (!phone.running) await phone.start(port)
  void tunnel.start(port)
  return phoneState()
})
/**
 * The one press that lets a phone in.
 *
 * Nothing is granted by a browser asking - the card is a refusal until this is called with
 * `true` - and what `true` grants is that device and no other, because approving mints it
 * a secret of its own rather than handing it the shared derived cookie.
 */
ipcMain.handle('phone:answerAsk', (_e, ok: boolean) => {
  phone.answerAsk(!!ok)
  return phoneState()
})
ipcMain.handle('phone:forget', (_e, id: string) => {
  phone.forgetDevice(String(id ?? ''))
  return phoneState()
})
/**
 * Desk-only, and that is the whole point: a browser that can dismiss the warning raised
 * ABOUT it has not been warned about. `DESK_ONLY` in phone.ts refuses this over HTTP with
 * the same answer as a channel that does not exist.
 */
ipcMain.handle('phone:clearMark', (_e, id: string) => {
  phone.clearMark(String(id ?? ''))
  return phoneState()
})
ipcMain.handle('phone:asking', (_e, on: boolean) => {
  const cfg = getConfig()
  setConfig({ phone: { ...cfg.phone!, ask: !!on } })
  send('phone:changed', phoneState())
  return phoneState()
})
ipcMain.handle('phone:rotate', async () => {
  const cfg = getConfig()
  // A rotation while a public address is up must not shorten the code back down.
  setConfig({
    phone: {
      ...cfg.phone!,
      code: newPhoneCode(cfg.phone?.tunnel ? LONG_CODE_LEN : 6)
    }
  })
  // Every paired browser's cookie was derived from the old code, so they are already out;
  // this only tells Settings the new one.
  send('phone:changed', phoneState())
  return phoneState()
})
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
// Pairing by asking, which is the path with no code typed anywhere. The six digits reach
// the window through `remote:changed`, not through this call's answer: they are known long
// before somebody presses Approve, and the whole point is to compare them while waiting.
ipcMain.handle('remote:ask', async (_e, peer: { address: string; port: number; name?: string }) => {
  const error = await remote.askToPair({
    address: String(peer?.address ?? ''),
    port: Number(peer?.port ?? 0),
    name: peer?.name ? String(peer.name) : undefined
  })
  return { ok: !error, error: error || undefined, state: remote.state() }
})
ipcMain.handle('remote:answer', (_e, ok: boolean) => {
  remote.answerPair(ok === true)
  return remote.state()
})
ipcMain.handle('remote:cancelAsk', () => {
  remote.cancelAsk()
  return remote.state()
})
ipcMain.handle('remote:pairByAsking', (_e, on: boolean) => {
  remote.setPairByAsking(on === true)
  return remote.state()
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
// Which of a device's panes this window mirrors. Nothing is mirrored until this says so.
ipcMain.handle('remote:watch', (_e, device: string, ids: string[], all: boolean) => {
  remote.setWatch(String(device), Array.isArray(ids) ? ids.map(String) : [], !!all)
  return remote.state()
})
// Opening a pane on the other machine. The folder list has to come from there too -
// this machine's projects root says nothing about what is checked out over there.
ipcMain.handle('remote:projects', (_e, device: string) => remote.projectsOn(String(device)))
ipcMain.handle('remote:agents', (_e, device: string) => remote.agentsOn(String(device)))
ipcMain.handle('remote:start', (_e, device: string, req: StartSessionRequest) =>
  remote.startOn(String(device), req)
)
// Handing panes the OTHER way: this machine's live panes move to that device and
// keep going there. The push happens before anything is killed here, and a pane
// whose handoff fails stays open - see main/handoff.ts.
/**
 * Mid-turn, from the pty's point of view: an answer is being written, or a question is on
 * screen waiting for somebody. Either one makes killing the pane destructive, and a
 * handoff ends in a kill.
 */
function paneBusy(s: Session): boolean {
  return (
    s.status === 'working' ||
    s.status === 'starting' ||
    s.stalledSince !== undefined ||
    !!s.bell ||
    !!s.ask
  )
}

/**
 * Start a dev server a handoff brought over, in a pane of its own.
 *
 * The command is rebuilt HERE from this machine's package.json and lockfile - the payload
 * only ever named a script. It goes into an ordinary `shell` pane rather than being
 * spawned invisibly, so it is on screen, it is killed with the pane, and `strays.ts`
 * already knows how to sweep whatever it leaves behind.
 */
function startDevServer(dir: string, script: string): string | null {
  const cmd = localDevCommand(dir, script)
  if (!cmd) return `Dev server not restarted - this machine's copy has no "${script}" script`
  void manager.start({ cwd: dir, agent: 'shell', title: `dev: ${script}`, prompt: cmd })
  // What is TRUE at this point is that a pane exists with that command typed into it.
  // Whether the server came up is decided seconds later inside that shell - a port
  // already taken over here is an EADDRINUSE nothing on this side of the pty ever sees.
  // Saying "restarted" would be a success message shaped exactly like the failure, which
  // is the one thing a report may never be; the pane is on screen, so it can be looked at.
  return `Started a pane running ${cmd} - check it came up (a port in use here would not)`
}

/** One place both the button and the queue go through, so they cannot drift apart. */
function runHandoff(device: string, request: HandoffRequest): Promise<HandoffItem[]> {
  const wanted = request.ids ?? []
  // Paint them before anything starts, so nothing closes a pane mid-move - and with NO
  // third argument, which would clear the stamp on a pane that is already queued and turn
  // its honest `waiting 12m` into `moving`. See `setHandingOff`.
  for (const id of wanted) manager.setHandingOff(id, true)
  return sendHandoff(
    {
      root: projectsRoot,
      list: () => manager.list(),
      snapshot: () => manager.snapshot(),
      kill: (id) => manager.kill(id),
      tailOf: (id, bytes) => history.tail(id, bytes),
      tailColsOf: (id) => history.colsOf(id),
      transcriptFileFor: (cwd, resumeId) => transcriptPath(cwd, resumeId),
      deliver: (dev, payload, file) => remote.handoffTo(dev, payload, file),
      deviceName: (dev) => remote.peerName(dev),
      selfDevice: () => getConfig().remote.id,
      busy: paneBusy,
      queue: (id, dev, closeAfter) => handoffQueue.add(id, dev, closeAfter),
      devServersOf: (id, cwd) => {
        const root = manager.roots().find((r) => r.id === id)
        return root ? devServersOf(root.pid, cwd) : Promise.resolve({ servers: [], notes: [] })
      }
    },
    device,
    request
  ).then((items) => {
    // The mark survives only where something is still going to happen to the pane: a
    // queued one keeps it, and everything else - moved, refused, or never started - has
    // it taken off, or reclaim would never touch that pane again.
    for (const item of items) if (!item.pending) manager.setHandingOff(item.id, false)
    return items
  })
}

/**
 * The queue that makes a mid-turn handoff mean "as soon as the turn ends" rather than
 * "the turn is lost". Nothing here kills anything: see main/handoffQueue.ts.
 */
const handoffQueue = new HandoffQueue({
  list: () => manager.list(),
  busy: paneBusy,
  send: (id, device, closeAfter) =>
    runHandoff(device, { ids: [id], closeReceiverWhenDone: closeAfter, waitForTurn: false }),
  mark: (id, on, queuedAt) => manager.setHandingOff(id, on, queuedAt),
  deviceName: (dev) => remote.peerName(dev),
  config: () => getConfig().autoHandoff ?? DEFAULT_AUTO_HANDOFF,
  log: (line) => console.info(line),
  // The queue finishes long after the dialog closed, and from the phone there was no
  // dialog at all - so its outcome goes to the window too, or a pane disappears with
  // no reason on screen and the desk it left reads as a frozen session.
  notify: (line) => send('handoff:moved', line)
})

ipcMain.handle(
  'remote:handoff',
  (_e, device: string, ids?: string[], closeReceiverWhenDone?: boolean, waitForTurn?: boolean) =>
    runHandoff(String(device), {
      ids: Array.isArray(ids) && ids.length ? ids.map(String) : undefined,
      closeReceiverWhenDone: closeReceiverWhenDone === true,
      waitForTurn: waitForTurn !== false
    })
)
// One press on a mirrored pane's own card. The answer is the far end's report, so a
// refusal ("dirty checkout over there") arrives as a sentence naming the pane.
ipcMain.handle('remote:bringHere', (_e, id: string) => remote.bringHere(String(id)))
ipcMain.handle('remote:handoffPending', () =>
  handoffQueue.pending().map((q) => ({ id: q.id, device: q.device, deviceName: remote.peerName(q.device), since: q.since }))
)
// Which of these panes' repos could reach another machine at all. Asked by the automatic
// sweeps BEFORE they pick a pane, so a checkout with no origin is never counted down at.
// A folder that answers no is not retried for five minutes (`shareable` caches).
ipcMain.handle('remote:handoffReady', async (_e, cwds: unknown) => {
  const list = Array.isArray(cwds) ? cwds.map(String).slice(0, 64) : []
  const root = projectsRoot()
  const out: Record<string, boolean> = {}
  await Promise.all(
    [...new Set(list)].map(async (cwd) => {
      out[cwd] = await shareable(cwd, root).catch(() => false)
    })
  )
  return out
})
// False means nothing was waiting: the pane is already on its way, or was never queued.
ipcMain.handle('remote:handoffCancel', (_e, id: string) => handoffQueue.drop(String(id)))
// A session clearing ITSELF once it has grown too big and written its handoff. The decision
// is the Stop hook's (`claude-config/autoclear.mjs`); this end owns the countdown, which is
// the only part a person can stop. Payload is re-read here because the phone server reaches
// this channel too - see `readAutoClearAsk`.
ipcMain.handle('autoclear:ask', (_e, raw: unknown) => {
  const ask = readAutoClearAsk(raw)
  if (!ask) return { ok: false, reason: 'that is not an autoclear request' }
  if (remote.owns(ask.paneId)) return { ok: false, reason: 'that pane lives on another device' }
  // The hook says WHAT to type, this end says how this CLI spells "start again" - the same
  // ask from a codex pane has to send `/new`.
  //
  // An agent we cannot name is REFUSED here, never defaulted to `/clear`. Defaulting is
  // tempting - only Claude Code has a Stop hook, so only claude panes should ever ask - but
  // the phone server relays this same channel, which makes the paneId data from outside
  // that can name any pane on the desk. `/clear` typed into a CLI with no such command is
  // a prompt sent to a model. Same invariant as the watcher, in the one other place that
  // can type into a pane nobody is watching.
  const command = clearCommandFor(manager.list().find((s) => s.id === ask.paneId)?.agent)
  if (!command) return { ok: false, reason: 'nothing here knows how to clear that pane' }
  // A pane that left work running in the background reads as finished from every other
  // angle - the turn ended, the footer stopped, `engaged` dropped - and clearing it
  // restarts the CLI on top of a build that is still going. The hook asks again later.
  const job = backJobOf(ask.paneId)
  if (job) return { ok: false, reason: `that pane is still running ${job}` }
  return manager.armAutoClear(ask.paneId, { ...ask, command })
})
ipcMain.handle('autoclear:cancel', (_e, id: string) => manager.cancelAutoClear(String(id), 'cancelled'))
// The renderer runs from file:// in production, which is not a secure context, so
// navigator.clipboard is unavailable there. Terminal copy/paste goes through here.
// A disposable dev copy can set this to prove its clipboard path without replacing the
// real user's rich clipboard formats (images, files and custom app payloads).
const testClipboardFile = process.env.PF_TEST_CLIPBOARD_FILE?.trim()
const testClipboardDir = process.env.PF_TEST_CLIPBOARD_DIR?.trim()
function clipboardFixtureActive(): boolean {
  if (!testClipboardFile || !testClipboardDir) return false
  try {
    const dir = lstatSync(testClipboardDir)
    const file = lstatSync(testClipboardFile)
    return (
      dirname(resolve(testClipboardFile)) === resolve(testClipboardDir) &&
      dir.isDirectory() &&
      !dir.isSymbolicLink() &&
      file.isFile() &&
      !file.isSymbolicLink() &&
      (dir.mode & 0o077) === 0 &&
      (file.mode & 0o077) === 0
    )
  } catch {
    return false
  }
}
ipcMain.on('clipboard:write', (_e, text: string) => {
  if (typeof text === 'string' && text.length) {
    // A test launch with a bad fixture must fail closed, never fall through to the
    // user's clipboard. The probe first asks fixtureActive and refuses to click Copy.
    if (testClipboardFile || testClipboardDir) {
      if (clipboardFixtureActive()) writeFileSync(testClipboardFile!, text, 'utf8')
      return
    }
    // Every copy that starts inside this app comes through here - copy-on-select in a
    // pane most of all, which fires on a drag across two words. It is still stashed; it
    // is only marked as ours so the Stash does not announce it. See `noteOwnCopy`.
    noteOwnCopy(text)
    clipboard.writeText(text)
  }
})
ipcMain.handle('clipboard:read', () => {
  if (!testClipboardFile && !testClipboardDir) return clipboard.readText()
  if (!clipboardFixtureActive()) return ''
  try {
    return readFileSync(testClipboardFile!, 'utf8')
  } catch {
    return ''
  }
})
ipcMain.handle('clipboard:fixtureActive', () => clipboardFixtureActive())

/**
 * Put files in front of a pane's agent - the paste and the drop that carry bytes.
 *
 * Routed by `remote.owns` like every other pane message, and for the reason that bug
 * existed at all: the pty is on whichever machine opened it, so a mirrored pane's files
 * have to be written THERE. Writing them here and typing the path is what handed an agent
 * on the PC a screenshot path from a Mac.
 */
/**
 * Answer a pane's question by number, from a button anywhere - this window, a phone, or
 * a bot posting over the phone server.
 *
 * A MIRRORED pane is answered the same way a keystroke reaches one: the far end owns the
 * pty, and its own window is what read the question in the first place, so the arrows go
 * over the link as ordinary writes. The keys are derived HERE from the frame that came
 * with the session list, so a stale button on this side is refused by `keysForChoice`
 * rather than typed into whatever replaced the chooser.
 */
ipcMain.handle('pty:choose', (_e, id: string, n: number): boolean => {
  if (!remote.owns(id)) return manager.choose(id, n)
  const ask = remote.sessions().find((s) => s.id === id)?.ask
  const keys = ask ? keysForChoice(ask, n) : null
  if (!keys) return false
  // Re-read before every key, exactly as `SessionManager.choose` does: the question can
  // end inside the few hundred ms these are spread over, and the rest of the arrows
  // would then land in whatever replaced the chooser.
  keys.forEach((k, i) =>
    setTimeout(() => {
      const still = remote.sessions().find((s) => s.id === id)?.ask
      if (!sameAsk(still, ask)) return
      remote.send(id, { t: 'write', data: k })
    }, i * CHOOSE_GAP_MS)
  )
  return true
})

ipcMain.handle('pty:attach', (_e, id: string, files: AttachIn[]): Promise<AttachResult> => {
  if (remote.owns(id)) return remote.attachOn(id, files)
  return Promise.resolve(writeAttachments(files))
})

/**
 * The clipboard image, attached to a pane.
 *
 * The clipboard is read HERE - it belongs to the device the window is on - and only the
 * bytes travel. `readImage` answers an empty image for text or for nothing at all, which
 * is the caller's cue to let the raw ^V through to an agent that reads the clipboard by
 * itself.
 */
ipcMain.handle('pty:attachClipboard', (_e, id: string): Promise<AttachResult> => {
  const img = readClipboardImage()
  if (!img || img.isEmpty())
    return Promise.resolve({ paths: [], error: 'No image on the clipboard' })
  const png = img.toPNG()
  if (!png.length) return Promise.resolve({ paths: [], error: 'No image on the clipboard' })
  const files: AttachIn[] = [{ name: 'clipboard.png', data: png.toString('base64') }]
  if (remote.owns(id)) return remote.attachOn(id, files)
  return Promise.resolve(writeAttachments(files))
})

/**
 * Image bytes onto this device's clipboard, for the ^V that follows.
 *
 * The reverse of `pty:attachClipboard`, and it exists for the same reason that one does:
 * an agent that reads the clipboard sees a real image, and one that does not sees nothing
 * at all. So the renderer only calls this for the agents that do, and falls back to typing
 * a path when it answers false.
 *
 * This DOES overwrite what was on the clipboard - there is no way to hand an image to a
 * CLI through the clipboard without using the clipboard. Dropping a file is a deliberate
 * act, so the trade is made where the user made it.
 */
/**
 * The probe's private clipboard, for IMAGES.
 *
 * The text fixture beside it exists so a disposable dev copy can prove its clipboard path
 * without replacing the real user's clipboard, and an image write needs the same door for
 * the same reason - a test that hands a picture to an agent would otherwise throw away
 * whatever the person at the desk had copied, and land its own test image on their Stash.
 * A PNG beside the text file: same directory, same permission checks.
 */
function testClipboardImageFile(): string | null {
  return testClipboardFile ? testClipboardFile + '.png' : null
}

/** Whatever image the clipboard - real or fixture - is holding. Null when there is none. */
function readClipboardImage(): Electron.NativeImage | null {
  if (!testClipboardFile && !testClipboardDir) return clipboard.readImage()
  const file = testClipboardImageFile()
  if (!clipboardFixtureActive() || !file || !existsSync(file)) return null
  try {
    return nativeImage.createFromBuffer(readFileSync(file))
  } catch {
    return null
  }
}

ipcMain.handle(
  'clipboard:writeImage',
  (_e, src: { data?: string; path?: string; probe?: boolean }): boolean => {
    // EVERYTHING in here is inside the try. `createFromBuffer` throws on some corrupt
    // images rather than answering an empty one, and a throw here crosses the IPC as a
    // rejected promise in the renderer, where the drop path would swallow it and the drop
    // would appear to have done nothing. False is the answer that has a fallback behind
    // it; an exception is the answer that has none.
    try {
      // Two shapes because a drop arrives as two shapes: a browser drag and a mirrored
      // pane carry BYTES, while a Finder drag (and a macOS screenshot dragged off its own
      // preview thumbnail) carries only a path on this disk, with no File object behind it.
      let img: Electron.NativeImage
      if (src.data) img = nativeImage.createFromBuffer(Buffer.from(src.data, 'base64'))
      else if (src.path) {
        if (!statSync(src.path).isFile()) return false
        img = nativeImage.createFromPath(src.path)
      } else return false
  // An empty image is a format Chromium's decoder does not read (a PDF, an HEIC on some
  // builds, a .webp on old ones). Saying so is what keeps the pane from sending a ^V that
  // would paste whatever was on the clipboard BEFORE the drop.
      if (img.isEmpty()) return false
      // `probe` asks only whether this decodes. The pane checks a whole batch that way
      // before it sends any ^V, so a drop that turns out not to be all images leaves the
      // clipboard exactly as it was.
      if (src.probe) return true
      // A test launch fails CLOSED, exactly as the text path does: a probe must never
      // reach the real clipboard, and a half-configured fixture is a bug, not a fallback.
      if (testClipboardFile || testClipboardDir) {
        const file = testClipboardImageFile()
        if (!clipboardFixtureActive() || !file) return false
        writeFileSync(file, img.toPNG(), { mode: 0o600 })
        return true
      }
      clipboard.writeImage(img)
      return true
    } catch {
      return false
    }
  }
)

/** Remove the private clipboard fixture a disposable test app owns, never arbitrary paths. */
function removeTestClipboard(): void {
  if (!testClipboardFile || !testClipboardDir || dirname(resolve(testClipboardFile)) !== resolve(testClipboardDir)) return
  try {
    if (!clipboardFixtureActive()) return
    unlinkSync(testClipboardFile)
    rmSync(testClipboardDir, { recursive: true, force: true })
  } catch {
    /* a test fixture that is already gone is clean enough */
  }
}

// The clipboard shelf: the last things copied, one click from the focused pane.
ipcMain.handle('recents:list', () => listRecents())
// The clip bodies never ride along with the list (see `lean` in recents.ts): the window
// asks for the one it is about to type.
ipcMain.handle('recents:text', (_e, id: string) => recentText(id))
// Searching happens here because the bodies are here: `lean()` strips the text out of
// every list a window is handed, so a filter in a renderer could only ever match the
// first 140 characters of a clip.
ipcMain.handle('recents:search', (_e, q: string) => searchRecents(String(q ?? '')))
ipcMain.on('recents:edit', (_e, id: string, text: string) => editRecent(id, String(text ?? '')))
// The overlay cannot be typed into - it is `focusable: false`, which is the whole reason
// clicking a row leaves your keyboard where it was - so its magnifier hands the job to
// the window that CAN take a keyboard. `asked` is true because a click on that button is
// a person asking for the app, which is the one thing allowed to take the screen.
ipcMain.on('recents:openSearch', () => {
  // And it puts the overlay away as it goes. Without this there are two Stashes on the
  // screen at once - the overlay sits at the screen-saver level, one step above a normal
  // topmost window, so the list it is still showing covers the searchable one it just
  // asked the main window to open. One Stash, wherever it is being read from.
  setShelfExpanded(false)
  focusWindow(true)
  send('recents:openSearch')
})
ipcMain.on('recents:copy', (_e, id: string) => copyRecent(id))
ipcMain.on('recents:clear', () => clearRecents())
ipcMain.on('recents:inWindow', (_e, open: boolean) => setStashInWindow(!!open))
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
// Resized by its own edges, the same way it is moved: the page reports pointer travel,
// main owns the bounds. Only the eight edges the renderer names are ever accepted.
ipcMain.on('shelf:resizeStart', (_e, edge: string) => {
  if (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(edge))
    beginShelfResize(edge as ShelfEdge)
})
ipcMain.on('shelf:resizeMove', (_e, dx: number, dy: number) =>
  moveShelfResize(Number(dx) || 0, Number(dy) || 0)
)
ipcMain.on('shelf:resizeEnd', () => endShelfResize())

/** Just the Stash's own knobs, which is all of the config the overlay ever sees. */
function stashConfig(cfg: Config): StashConfig {
  return {
    stashSummon: cfg.stashSummon,
    stashPeekMs: cfg.stashPeekMs,
    stashAutoCloseMs: cfg.stashAutoCloseMs,
    stashMaxItems: cfg.stashMaxItems,
    stashMaxImages: cfg.stashMaxImages,
    stashFileHours: cfg.stashFileHours,
    stashMaxFileMb: cfg.stashMaxFileMb,
    stashDeny: cfg.stashDeny,
    clipboardOverlay: cfg.clipboardOverlay,
    // The overlay derives its own colours from this, the same way every other surface
    // does. It arrives on the same push as the knobs, so moving the accent slider
    // recolours the floating Stash on the same frame as the window behind it.
    theme: cfg.theme
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
    if (k === 'clipboardOverlay' || k === 'stashSummon') {
      if (typeof v === 'boolean') clean[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      clean[k] = v
    }
  }
  const next = setConfig(clean as Partial<Config>)
  applyStashCaps(next)
  if (clean.clipboardOverlay !== undefined) applyShelfOverlay(next)
  if (clean.stashSummon !== undefined) refreshShelfSummon()
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
/**
 * A drop that arrived as bytes rather than a path - an image dragged out of a browser
 * page, a file from an app that never touches the disk. The bytes are parked as a real
 * file (name sanitised, never trusted as a path) and stashed through the same door as
 * every other file, so the size cap and the file clock apply to it too.
 */
ipcMain.handle('stash:addData', (_e, name: string, data: unknown) => {
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.isBuffer(data) ? data : null
  if (!buf || !buf.length) return 0
  const safe =
    String(name ?? '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
      .slice(0, 120) || `dropped-${Date.now()}`
  // Its own scratch directory, so the file inside keeps the name it arrived with - that
  // basename is what the row shows and what a drag back out is called.
  const dir = mkdtempSync(join(tmpdir(), 'pf-stash-'))
  const tmp = join(dir, safe)
  try {
    writeFileSync(tmp, buf)
    return addRecentFiles([tmp])
  } catch {
    return 0
  } finally {
    // addRecentFiles copies into the Stash's own folder; the parked original is litter.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a temp file left behind is only a temp file */
    }
  }
})
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
    maxFileMb: Math.max(0, cfg.stashMaxFileMb),
    deny: cfg.stashDeny ?? ''
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
  quitting('relaunching as administrator')
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
  // Decided in shared/updateHold.ts, not here: this branch cannot be reached in dev at
  // all (no update metadata, so `phase` never says ready), and a rule that only runs in
  // production is a rule that ships untested. `npm run test:updatehold` holds it.
  //
  // The click used to go straight through, on the reasoning that the user chose the
  // interruption. They chose the restart; they did not choose to lose the answer a pane
  // was part-way through writing, and there is no way to tell the two apart from a
  // button that only says "Restart now". So the click now means "as soon as it is not
  // expensive", and the panes are the expensive part - `doInstall` hard-kills every pty,
  // and what comes back is a fresh session with the answer gone and its clock at zero.
  //
  // Held here rather than inside `whenClear` because the two holds are about different
  // things: the game hold protects the SCREEN, and is released by the game closing;
  // this one protects WORK, and is released by the panes going quiet.
  const decision = decideInstall({
    phase: getUpdateState().phase,
    installStarted,
    sessions: manager.list()
  })
  if (decision.act === 'wait') {
    installWhenIdle = true
    watchForIdlePanes(true)
    updateLog('install', `restart clicked, held: ${decision.busy} agent(s) mid-turn`)
    const g = gameState()
    return { status: 'held', busy: decision.busy, game: g.game, manual: g.manual }
  }
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
  quitting('installing an update')

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
 * A click waits too, in `installWhenIdle` below - on the same rule, released the same
 * way. This path is the one nobody asked for, so it also keeps the 60s recheck rather
 * than reacting to every pane event.
 */
function autoInstall(): void {
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer)
    autoInstallTimer = null
  }
  // The build stopped being installable while we waited - superseded, or already going.
  if (getUpdateState().phase !== 'ready') return
  // `deskBusy`, not `agentsMidTurn`: a turn boundary is not a safe moment to take somebody's
  // panes away, it is the pause in the middle of their work. See DESK_QUIET_MS.
  const running = deskBusy(manager.list(), Date.now())
  if (running > 0) {
    updateLog('install', `auto-restart held: ${running} pane(s) in use - looking again in 60s`)
    autoInstallTimer = setTimeout(autoInstall, AUTO_INSTALL_RECHECK_MS)
    autoInstallTimer.unref?.()
    return
  }
  whenClear('update-install', doInstall)
}

/**
 * A restart the user clicked while a pane was mid-turn, waiting for the panes to finish.
 *
 * The wait ends on the pane list changing, which is what a turn ending emits, so the
 * restart follows the last answer landing by a moment rather than by up to a minute.
 * The interval behind it is a backstop for the ending that changes nothing the list can
 * see, and costs one array filter while - and only while - a restart is queued.
 */
let installWhenIdle = false
let idlePaneTimer: NodeJS.Timeout | null = null
const IDLE_PANE_RECHECK_MS = 5_000

function watchForIdlePanes(on: boolean): void {
  if (on === Boolean(idlePaneTimer)) return
  if (on) {
    idlePaneTimer = setInterval(installOncePanesIdle, IDLE_PANE_RECHECK_MS)
    idlePaneTimer.unref?.()
    return
  }
  clearInterval(idlePaneTimer as NodeJS.Timeout)
  idlePaneTimer = null
}

function installOncePanesIdle(): void {
  if (!installWhenIdle || installStarted) return
  // Superseded, or the download went away underneath us. Stop waiting for a restart
  // that has nothing left to install.
  if (getUpdateState().phase !== 'ready') {
    installWhenIdle = false
    watchForIdlePanes(false)
    return
  }
  const busy = agentsMidTurn(manager.list())
  if (busy > 0) return
  installWhenIdle = false
  watchForIdlePanes(false)
  updateLog('install', 'panes idle - running the restart that was clicked')
  // Through the game hold, not around it: the panes being finished says nothing about
  // whether something is fullscreen on the screen right now.
  whenClear('update-install', doInstall)
}

manager.on('sessions', installOncePanesIdle)

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
/**
 * The renderer's idle clock ran out - see shared/idlequit.ts for every refusal that had
 * to pass first.
 *
 * The marker is the whole reason this is not just `app.quit()`: a scheduled keep-alive
 * task reopens PaneForge whenever it is not running, which would undo an intentional
 * quit within minutes and make the feature look broken rather than absent. The task reads
 * this file, so a crash (no marker) still gets restarted and a deliberate quit does not.
 * The desk snapshot that `window-all-closed` writes is what brings the panes back.
 */
ipcMain.handle('app:quitIdle', (_e, reason: string) => {
  console.info(`idle-quit: quitting - ${reason}`)
  try {
    writeFileSync(
      join(app.getPath('userData'), 'idle-quit.flag'),
      JSON.stringify({ at: Date.now(), reason })
    )
  } catch {
    // A marker we could not write only costs a keep-alive relaunch. Quitting still wins.
  }
  quitting(`idle - ${reason}`)
  app.quit()
})
/** The Settings switch, kept out of the config write path so it applies instantly. */
ipcMain.handle('game:manual', (_e, on: boolean) => {
  const next = setConfig({ gameMode: { ...getConfig().gameMode, manual: on } })
  refreshGameWatch(next)
  send('config:changed', next)
  return gameStatus()
})
/**
 * "Restart now anyway" - the one way past a held update without ending the game or
 * waiting for the panes. Both holds are dropped: whichever one the card was naming,
 * this is the user overriding it having been told the cost.
 */
ipcMain.on('game:installAnyway', () => {
  installWhenIdle = false
  watchForIdlePanes(false)
  cancelDeferred('update-install')
  doInstall()
})

// --- task board + shared memory -------------------------------------------

ipcMain.handle('board:get', (_e, path: string) => readBoard(path))
ipcMain.handle('board:tasks', (_e, path: string, tasks: TaskItem[]) => writeTasks(path, tasks))
ipcMain.handle('board:memory', (_e, path: string, memory: string) => writeMemory(path, memory))

// --- history ---------------------------------------------------------------

ipcMain.on('reclaim:log', (_e, entry: Record<string, unknown>) => logReclaim(entry))
ipcMain.handle('history:list', () => history.list())
ipcMain.handle('history:search', (_e, q: string) => history.search(q))
ipcMain.handle('history:read', (_e, id: string) => history.read(id))
ipcMain.handle('history:delete', (_e, id: string) => history.remove(id))

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
 * "Break this ask into panes" - see main/splitPrompt.ts.
 *
 * The one expensive thing on this surface: it starts an agent CLI, headlessly, and waits
 * for it. It is only ever reached from a press, never from typing, and every failure comes
 * back as `{ error }` rather than as an empty plan.
 */
ipcMain.handle('prompt:split', async (_e, text: string) => {
  try {
    return await splitPrompt(text)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

/**
 * A pane's draft was submitted. Fire-and-forget: the renderer is mid-keystroke and has
 * nothing to do with the answer.
 */
ipcMain.on('prompt:used', (_e, draft: string, meta: { cwd?: string; agent?: string; id?: string }) => {
  // Before the recall gate, and outside its try: History's one-line note is a different
  // feature with a different switch, and "you have asked this before" being off is not a
  // reason for a closed session to go back to being a folder name and a clock.
  if (meta.id) {
    try {
      history.noteAsk(meta.id, draft)
      // ...and onto the live session, so the app can say WHICH conversation a pane is in
      // while the pane still exists. See Session.gist.
      manager.noteGist(meta.id)
    } catch {
      /* a note is a nicety, never the reason a pane stops working */
    }
  }
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
  /** agent model to start the session with, same values as StartSessionRequest.model */
  model?: string
  /** pane title override, same as StartSessionRequest.title */
  title?: string
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
  const model = take('--model')
  const title = take('--title')
  if (open) req.open = open
  if (prompt) req.prompt = prompt
  if (route) req.route = route
  if (model) req.model = model
  if (title) req.title = title
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
    manager.start({
      cwd: target,
      prompt: req.prompt ?? req.route ?? undefined,
      model: req.model,
      title: req.title
    })
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

/**
 * Space the restore out, in milliseconds, or 0 for the one tick this has always used.
 *
 * `scripts/boot-timing.mjs --stagger N` has set `PF_RESTORE_STAGGER_MS` since it was
 * written and NOTHING read it, so every staggered run measured the unstaggered code and
 * the two sets of numbers differed only by how loaded the machine was that minute. A
 * knob that silently does nothing is worse than no knob: it produces evidence.
 *
 * It stays a measurement knob and not a setting - the default is unchanged, one tick -
 * because whether spacing the starts helps is a question about THIS machine's cores and
 * disk, and the honest answer is a number from `boot-timing`, not an opinion in here.
 */
function restoreStaggerMs(): number {
  const n = Number(process.env.PF_RESTORE_STAGGER_MS)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function restorePanes(specs: StartSessionRequest[]): void {
  // One restore per launch. A second answer from a dialog that somehow sent twice
  // would otherwise open every pane again beside the first set.
  if (restoredThisRun) return
  clearDesk()
  restoredThisRun = true
  const gap = restoreStaggerMs()
  // Started in order whatever the gap is: a pane's number is its place in this list, so
  // starting one out of turn renumbers the desk and every Ctrl+N with it.
  const recoverOn = (getConfig().recover ?? DEFAULT_RECOVER).enabled
  specs.slice(0, MAX_RESTORE).forEach((req, i) => {
    const open = (): void => {
      try {
        // Reopen the conversation this pane was in BY NAME, or open nothing.
        //
        // The fallback that used to sit here - resume with no id, which is `--continue`,
        // "the newest conversation in this folder" - is a pane adopting somebody else's
        // work, because a lane worktree's project folder is a SYMLINK to the trunk's:
        // `clients`, `clients-a`, `clients-b` and `clients-c` are one history in four
        // names. Measured 2026-08-26 on this desk: pane 4 (`sonia`, clients-b) was written
        // to disk with no resumeId, so the restart handed it `--continue`, which is the
        // newest file across all four lanes - pane 1's (`pizzasrus`) conversation. Two
        // panes then carried one chat under two names and both looked like they had been
        // switched round. A pane whose transcript is gone comes back EMPTY, which is a
        // thing the person can see, rather than silently inside another pane's work.
        // A desk written BEFORE the claim rules learned to read a transcript's own folder
        // can carry an id belonging to a sibling lane - this desk did, twice - so the saved
        // id is checked the same way a fresh claim now is, not trusted for being saved.
        const file = req.resumeId ? transcriptPath(req.cwd, req.resumeId) : null
        const named = Boolean(file && !heldElsewhere(file, req.cwd))
        manager.start({
          ...req,
          resume: named,
          resumeId: named ? req.resumeId : undefined,
          prompt: undefined,
          // Everything but the pane being looked at comes back with no agent in it. The
          // card, its place and its screen are all there; a press starts the CLI in the
          // conversation it was in. See `shared/restoreTurn.ts` for the measurement.
          asleep: req.asleep || restoreAsleep(req, i, recoverOn)
        })
      } catch {
        // Folder moved or the agent is no longer installed - skip that pane only.
      }
    }
    if (gap) setTimeout(open, i * gap)
    else open()
  })
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
  // Same reading as the restore itself, or the dialog offers a pane under a line of
  // somebody else's work and then opens it empty.
  const held = spec.resumeId ? transcriptPath(spec.cwd, spec.resumeId) : null
  const resumeId = held && !heldElsewhere(held, spec.cwd) ? spec.resumeId : undefined
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
    if (!cfg.restoreAfterUpdate) {
      clearDesk()
      return
    }
    // `askAfterUpdate` is the one rule for every restart, for a desk that would rather be
    // asked than handed its panes back. Off by default: the app updates itself several
    // times a day, so asking every time costs more than the inconsistency it removes.
    // On, this falls through to the same offer a quit or a crash gets.
    if (!cfg.askAfterUpdate) {
      restorePanes(desk.specs)
      return
    }
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
  const panes = all.slice(0, MAX_RESTORE)
  // Read here rather than off `lastPressure`: this runs during boot, before the sampler
  // has necessarily had its first tick, and a stale `normal` would tick every pane on the
  // one launch where that is the whole complaint.
  const plan = restorePlan(panes.filter((p) => !p.gone).length, {
    totalMb: totalMb(),
    pressure: readPressure(),
    localPanes: manager.list().length
  })
  offer = {
    panes,
    extra: all.slice(MAX_RESTORE),
    at: desk.at,
    clean: desk.clean,
    fits: plan.fits,
    memoryNote: plan.note
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
  // The app is open again, so the "closed on purpose" marker is stale: clear it, or the
  // keep-alive task would refuse to restart this copy after a genuine crash.
  try {
    unlinkSync(join(app.getPath('userData'), 'idle-quit.flag'))
  } catch {
    // Not there is the normal case.
  }
  const cfg = getConfig()
  // First line of this process's story: the one that was missing when an update came
  // back and nobody could tell whether it had.
  updateLog('launch', `v${app.getVersion()}`, `pid ${process.pid}`, `start=${startMode()}`, `+${bootMs()}ms`)
  // Two things Windows loses between restarts and neither of them announces itself: the
  // Desktop shortcut (which is the only way this desk opens the app) and the login entry
  // (whose absence reads as "it did not reopen"). Both are re-asserted from config here
  // rather than only when a setting is changed, because both are deleted by software that
  // has never heard of PaneForge. See src/main/winShortcut.ts.
  ensureDesktopShortcut(cfg.desktopShortcut !== false, (line) => updateLog('windows', line))
  syncLaunchAtLogin(!!cfg.launchAtLogin, (line) => updateLog('windows', line))
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
  // The other half of autoclear: the CLIs with no Stop hook of their own. Also the moment
  // the antigravity statusline tee is put in place, which is a no-op unless that CLI is
  // installed here. See autoclearWatch.ts.
  startAutoClearWatch(manager)
  createWindow()
  applyVoiceHotkey(cfg)
  applyClipboardShelf(cfg)
  crashTestHook()
  // After the window exists: a device that reconnects immediately would otherwise
  // push its session list at a renderer that is not listening yet.
  remote.start()
  // Same reason as remote.start(): a phone that reconnects the second the port opens
  // would otherwise be answered by handlers whose window is still loading.
  if (cfg.phone?.on) {
    void phone.start(cfg.phone.port).then(() => {
      // After the listener, never with it: a tunnel in front of a port that is not
      // answering yet publishes an address that 502s for its first few seconds.
      if (cfg.phone?.tunnel) void tunnel.start(cfg.phone.port)
    })
  }
  setDevChannel(!!cfg.devUpdates)
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
  if (process.env['PANEFORGE_OPEN'])
    openRequest({
      open: process.env['PANEFORGE_OPEN'] as string,
      model: process.env['PANEFORGE_MODEL'] || undefined,
      title: process.env['PANEFORGE_TITLE'] || undefined
    })
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
    // `alive()`, not `getAllWindows().length`: a window whose renderer died is still IN
    // that list, so the app was stranded with a window it could never draw in and no way
    // to ask for a new one. 2026-08-28.
    if (!alive()) return createWindow()
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
  // Only when this really IS the cause. On Cmd-Q `before-quit` has already run and
  // already said what it knew; the windows closing after it is what a quit DOES.
  if (!quitLogged) quitting('the last window was closed')
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
  // Deliberately NOT `phase === 'ready'`. See stagedInstallable(): the phase is a live flag
  // that a stalled download can hold for ever, and a staged bundle is a fact on disk. When
  // they disagree the fact wins, or quitting installs nothing and says nothing.
  if (!stagedInstallable()) return
  quitSwapDone = true
  if (swapAndRelaunch(false)) updateLog('exit', 'installing the staged mac update on quit')
}

function hardExit(): void {
  // The quit line first, for the paths that reach here without `before-quit` ever
  // running; a no-op when it already did.
  logQuit()
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

app.on('browser-window-focus', () => {
  focused = true
  lastFocusAt = Date.now()
})
app.on('browser-window-blur', () => {
  focused = false
  lastFocusAt = Date.now()
})
app.on('before-quit', () => {
  // Written FIRST, before anything below can throw: the whole value of this line is that
  // it exists for a quit nobody in the app asked for, which is the one that gets reported
  // as "it closed by itself".
  logQuit()
  // Quitting by any other route than the last window closing - the tray, Cmd-Q, the
  // OS asking everyone to leave before a restart. Same record, same order: the desk
  // is written while the panes are still alive to be read.
  saveDeskOnExit(manager.snapshot())
  remote.stop()
  // A bound port outlives this process on Windows for long enough that the next launch
  // reports it taken, so the listener is closed by hand rather than left to the exit.
  void phone.stop()
  // Not a pty, so `strays.ts` has never heard of it: without this line the app leaves a
  // cloudflared holding a public address open with nothing behind it.
  void tunnel.stop()
  // shutdown() also flushes buffered transcript output, which would otherwise lose the
  // last 1.5 seconds of every pane. It runs once, so the two quit paths cannot double
  // the work between them.
  manager.shutdown()
  stopInstalls()
  // A driven lane's agent is a detached process in its own group - nothing joins it to
  installStagedMacUpdateOnQuit()
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  displayAwake.stop()
  // Dropping the pipe is enough - Discord clears the presence when the client goes.
  presence.dispose()
  stopPressure()
  stopAway()
  stopAutoClearWatch()
  stopUsage()
  // The history is saved on a debounce now that the write is async; a copy made in the
  // last second of the app's life would otherwise never reach disk.
  flushRecents()
  removeTestClipboard()
})
