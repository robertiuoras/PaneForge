import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentModelLabel, type AgentInfo } from '@shared/agents'
import { stripAnsi } from '@shared/ansi'
import type {
  Config,
  DiffScope,
  HistoryEntry,
  Preset,
  Project,
  RecentItem,
  PhoneState,
  RemotePaneInfo,
  RemoteState,
  RestoreOffer,
  Session,
  StartSessionRequest,
  SwarmRole
} from '@shared/types'
import AgentPicker from './components/AgentPicker'
import AgentLogo, { AppLogo } from './components/AgentLogo'
import BoardDialog from './components/BoardDialog'
import CommandPalette, { type Command } from './components/CommandPalette'
import ConfirmDialog from './components/ConfirmDialog'
import DiffDialog from './components/DiffDialog'
import LaneDialog from './components/LaneDialog'
import LaneHelp from './components/LaneHelp'
import { PaneMenu } from './components/PaneMenu'
import SessionMenu from './components/SessionMenu'
import SessionInfo from './components/SessionInfo'
import HandoffDialog, { type HandoffTarget } from './components/HandoffDialog'
import Mascot, { type CloseSoon } from './components/Mascot'
import MoveSoon from './components/MoveSoon'
import { TextSheet } from './components/TextSheet'
import { Segmented } from './components/Controls'
import Elapsed, { formatElapsed, kb, useNow } from './components/Elapsed'
import GitBadge from './components/GitBadge'
import HistoryDialog from './components/HistoryDialog'
import { fleetRow, fleetWaiting } from '@shared/fleet'
import { deskGroups, deskRows as buildDeskRows, type DeskRow } from '@shared/desk'
import {
  BoardIcon,
  FleetIcon,
  HistoryIcon,
  LinkIcon,
  SearchIcon,
  RemoteIcon,
  SwarmIcon,
  TrashIcon
} from './components/Icons'
import RemoteDialog from './components/RemoteDialog'
import { PairAsk } from './components/PairAsk'
import { PhoneAsk } from './components/PhoneAsk'
import { isPhoneClient, viewerName } from './client'
import { linkLost, linkNote, linkWords, type LinkState } from '@shared/linkState'
import { HandheldType } from './components/HandheldType'
import TerminalPane, {
  paneCopyMode,
  paneDraft,
  paneFind,
  paneFocus,
  paneTerms,
  paneArmClear,
  paneInsert,
  paneRepair,
  paneRedraw,
  syncedPanes
} from './components/TerminalPane'
import {
  FULL_SCROLLBACK,
  OFFLOAD_STICK_MS,
  offloadPlan,
  offloadTarget,
  projectNameOf,
  savingMb,
  stickFor,
  trimPlan,
  TRIM_SETTLE_MS,
  type OffloadCandidate,
  type OffloadStick,
  type Verdict
} from '../../shared/capacity'
import {
  CLOSE_COUNTDOWN_MS,
  DEFAULT_MASCOT,
  KEEP_MINUTES,
  paneWord,
  type ActedPane,
  type MascotConfig,
  type MascotPane
} from '../../shared/mascot'
import type { RunningDev } from '../../shared/devList'
import {
  DEFAULT_RECLAIM,
  idleClosePlan,
  idleCloseAt,
  quietSince,
  reclaimPlan,
  reclaimedMb,
  type Reclaim,
  type ReclaimPane
} from '../../shared/reclaim'
import { deskNow } from '../../shared/away'
import {
  autoHandoffPlan,
  idleOffloadPlan,
  offloadMinutes,
  movable as handoffMovable,
  queueable as handoffQueueable,
  DEFAULT_AUTO_HANDOFF,
  staysHere,
  suggestMove,
  type AutoHandoff,
  type AutoPane
} from '../../shared/autoHandoff'
import { fleetState } from '../../shared/fleet'
import { canSleep, sleepRefusal, sleepWords, type SleepPane } from '../../shared/sleep'
import { idleQuitVerdict } from '../../shared/idlequit'
import { formatCpu, formatMb, type UsageReport } from '../../shared/usage'
import { jobWords } from '../../shared/paneBackJobs'
import { describePlace } from '@shared/place'
import { applyTheme, terminalTheme } from './theme'
import { keyLabel, modKey, isMac } from './platform'
import MicIcon from './components/MicIcon'
import NewSessionDialog from './components/NewSessionDialog'
import RecentsFlyout from './components/RecentsFlyout'
import RestoreDialog from './components/RestoreDialog'
import { measureRefreshRate } from './refreshRate'
import SettingsDialog from './components/SettingsDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import LaneStrip, {
  LaneChip,
  laneOfSession,
  useLaneBoards,
  useLanesByPane
} from './components/LaneStrip'
import { laneBusy, samePath } from './laneWords'
import StatusDot from './components/StatusDot'
import SwarmDialog, { type SwarmStart } from './components/SwarmDialog'
import SplitDialog from './components/SplitDialog'
import AutoClearToast from './components/AutoClearToast'
import UpdateToast from './components/UpdateToast'
import Tips from './components/Tips'
import { DEFAULT_TIPS } from '../../shared/tips'

/**
 * When this window opened.
 *
 * Module level rather than state: it is the age of the WINDOW, and a state initialiser
 * would be re-read on a remount and hand the tips clock a fresh start it has not had.
 */
const OPENED_AT = Date.now()
import VersionBadge from './components/VersionBadge'
import { playAction, playEvent, playTick } from './useChime'
import { BlurbContext, type BlurbState } from './components/Blurb'
import { useVoice } from './useVoice'
import { useHandheld } from './handheld'
import { VoiceOverlay } from './components/VoiceOverlay'
import {
  drag as dragTrack,
  dividerPx,
  equal,
  isLayout,
  LAYOUT_LABEL,
  LAYOUTS,
  layoutDefaults,
  moveInOrder,
  nextLayout,
  planGrid,
  shapeKey,
  template,
  trackPx,
  usable,
  type LayoutKind
} from './gridLayout'

/**
 * "3s" on the card of a pane whose question is about to be answered for you.
 *
 * The countdown itself is drawn in the PANE (`AskCountdown` in TerminalPane.tsx), which is
 * the right place for it and is very often not the place being looked at: with the grid
 * off, or the window on another desktop, the one pane holding a question is the one pane
 * not on screen. The sidebar is where somebody looks to find WHICH pane is owed an answer,
 * so the seconds belong here too - beside the "asks you" chip the same glow already earned.
 *
 * Its own component so the second timer runs only while a countdown is live: `useNow` is
 * one shared tick, and subscribing the list itself would re-render every card once a
 * second for a clock almost no desk is showing.
 */
function AskClock({ at }: { at: number }): React.JSX.Element | null {
  // Ticked against the DEADLINE, not the wall clock: `at` is an arbitrary millisecond, so
  // wall-aligned buckets made the last step a random fraction of a second - a chip that
  // sat on one number and then skipped one. Same fix as `AskCountdown` in the pane, and
  // they have to agree because they are two readings of one press.
  const now = useNow(1000, at)
  const left = Math.ceil((at - now) / 1000)
  // Nothing is drawn once the clock has run out: the keys are landing, and a chip stuck at
  // 0s reads as a timer that jammed.
  if (left < 0) return null
  // Inside the red "asks you" chip, not beside it. Two chips on the title line were two
  // marks for one fact, and the seconds - the half that is actually moving - read as a
  // separate reading about something else. One red box that says what is happening and
  // how long is left is the same shape the pane's own card already uses
  // (`.pane-ask-auto`: a danger-bordered row with the seconds as a solid pill in it).
  return <span className="asks-in">{left > 0 ? `${left}s` : 'now'}</span>
}

/**
 * The chip a sleeping pane wears where its clock would be, and the press that wakes it.
 *
 * Its own component for the reason every other clock here has one: the shared tick is
 * subscribed to only while something is drawing a duration, and this one is drawn at a
 * MINUTE - `sleepWords` says nothing finer, and a pane asleep overnight would otherwise
 * wake the app 3600 times an hour to redraw the same string (see `shared/elapsed.ts`).
 */
function AsleepChip({ at, id }: { at: number; id: string }): React.ReactElement {
  const now = useNow(60_000, at)
  return (
    <button
      className="chip asleep"
      title="Asleep: this pane's agent was stopped and its memory given back. Press to start it again in the same conversation - the screen is still here."
      onClick={(e) => {
        e.stopPropagation()
        void api.wakeSession(id)
      }}
    >
      {sleepWords(at, now)}
    </button>
  )
}

/** One pane as `shared/sleep.ts` reads it - see `reclaimPaneOf` for why this is shared. */
function sleepPaneOf(s: Session, backJob?: string | null): SleepPane {
  return {
    status: s.status,
    asleep: s.asleep,
    mirror: !!s.remote,
    busy: s.runSince !== undefined || s.status === 'working' || s.status === 'starting',
    asking: !!s.ask,
    job: s.job,
    // The one refusal main cannot make for itself: this is a reading of the process
    // table that rides on the usage sample, and the sampler lives on this side.
    backJob: backJob ?? undefined
  }
}

/**
 * One pane as the reclaim sweeps read it.
 *
 * Extracted so the sweep that CLOSES a pane and the chip that says when it will are built
 * from the same object. Two copies of this mapping is how a card ends up counting down on
 * a pane the sweep would never touch - a threat the app does not carry out.
 */
function reclaimPaneOf(
  s: Session,
  activeId: string | null,
  lastFocus?: number,
  pinned?: boolean,
  /** what the sampler saw this pane still running, when it has an answer */
  backJob?: string | null
): ReclaimPane {
  return {
    id: s.id,
    state: fleetState(s),
    lastKeyboard: s.lastKeyboard,
    // Reading a pane is using it. Only the renderer knows which pane had the keyboard, so
    // the moment focus LEFT is threaded in here - see `ReclaimPane.lastFocus` for the
    // report this answers: a pane read for six minutes was overdue the instant it was
    // switched away from, and its card's first word about it was a red `closes 0:01`.
    lastFocus,
    // Quiet means quiet: `lastKeyboard` alone calls a pane whose agent has been printing
    // for two hours "idle for two hours".
    lastOutput: s.lastOutput,
    // A shell pane running `npm run build` is BUSY, and looks identical to a finished one
    // in the sidebar. `paneJob.ts` is what tells them apart, through `runSince`.
    busy: s.runSince !== undefined,
    // ...and the job itself, which is set by a different reading than `runSince` is. See
    // `ReclaimPane.job`: a BACKGROUND command is exactly the case the run clock missed.
    job: s.job ?? null,
    // ...and what the AGENT left running in the background, which no other reading here
    // can see: the turn ended, so `busy` is false and `job` refuses to speak about an
    // agent pane at all. See `ReclaimPane.backJob`.
    backJob: backJob ?? null,
    focused: s.id === activeId,
    // Only the pressure sweep refuses a pane for being on screen; the clock deliberately
    // does not, or a desk with the grid on could never close anything.
    visible: false,
    remote: !!s.remote,
    asking: !!s.ask,
    handingOff: !!s.handingOff,
    // "Keep this pane open" from the card's right-click. See `ReclaimPane.pinned`.
    pinned,
    // A sleeping pane has already given its agent back and the card is the thing being
    // kept - closing it buys nothing and loses the pane. See `shared/sleep.ts`.
    asleep: s.asleep
  }
}

/**
 * How long this pane has before the idle clock closes it, and the press that stops it.
 *
 * The app already closes idle panes and already counts down on the mascot - which is in a
 * corner, takes itself away after a minute, and is behind whatever window is on top. So
 * the one place somebody is looking to decide what is still worth keeping - the card -
 * said nothing at all until the pane was gone. Robert, 2026-08-23: "so i know how long
 * until it closes".
 *
 * Its own component for the reason `AskClock` is: `useNow` is one shared second tick, and
 * subscribing the ROW to it would re-render every card once a second. Here only the chip
 * re-draws, which matters far more than it does for a question - with the clock on by
 * default, most cards on a quiet desk are showing one of these.
 *
 * `onKeep` is absent for a pane on another machine: that desk owns the pty and the
 * decision, and a button here that cannot reach it would be a promise this window cannot
 * keep. The number is still worth drawing - it is why the pane will be gone.
 */
function CloseClock({ at, onKeep }: { at: number; onKeep?: () => void }): React.JSX.Element | null {
  const now = useNow()
  const left = Math.max(0, Math.ceil((at - now) / 1000))
  const mins = Math.floor(left / 60)
  // Minutes and seconds only where the seconds are worth reading. A pane somebody has just
  // pressed "keep it open" on is an hour away, and `60:01` ticking down on a card for an
  // hour is a clock demanding attention it does not need.
  // `now`, not `0:00`. The sweep that does the closing runs on a MINUTE timer, so a pane
  // that is due sits at its deadline for up to a minute before anything happens - measured
  // live at 10+ seconds of `closes 0:00`, which reads as a clock that has jammed. Due is
  // the honest word for it.
  const words =
    left === 0 ? 'now' : mins >= 10 ? `${mins}m` : `${mins}:${String(left % 60).padStart(2, '0')}`
  const why = onKeep
    ? `This pane has been quiet, so it is being closed to give its memory back in ${words}. Nothing is lost - the conversation and what was on the screen both come back from History. Press to keep it open for an hour.`
    : `The machine it runs on will close it in ${words} for being idle. Its desk decides that, not this one.`
  // The last minute is RED, on the same argument the card's own glow is: this is the app
  // about to do something to somebody's pane, and the moment it stops being a clock and
  // starts being an alert is the moment it is nearly out of time.
  const cls = 'chip closing' + (left <= 60 ? ' soon' : '')
  if (!onKeep) return <span className={cls} title={why}>{`closes ${words}`}</span>
  return (
    <button
      type="button"
      className={cls}
      title={why}
      onClick={(e) => {
        // The card underneath is a switch-to-this-pane button, and keeping a pane open is
        // not a request to go and look at it.
        e.stopPropagation()
        onKeep()
      }}
    >
      {`closes ${words}`}
    </button>
  )
}

const api = window.api

/** How long a card stays lit after its turn ends - long enough to look, short enough
 *  that a room of finished panes is not a wall of glowing cards. */
/**
 * How often this client re-states which panes are on its screen. Well inside the
 * pump's `CLAIM_TTL_MS` (90s), so an ordinary refresh is never late enough to make
 * the desk's own panes look hidden - and a client that has gone away expires within
 * one and a half minutes rather than never.
 */
const VISIBILITY_REFRESH_MS = 30_000

/**
 * How long the memory notice stays on screen.
 *
 * Long enough to read two sentences and a figure, short enough that it is gone before it
 * becomes furniture - which is the whole complaint the strip it replaces collected.
 */
const CAPACITY_NOTE_MS = 12_000

/* One pass of `doneGlow` (1.9s in styles.css) plus a beat, and nothing more: the class has
   to come off when the flash ends or the card keeps the last frame's tint for another
   three seconds. Was 5200, which was three passes - a card that flickers while you read
   it. Keep this and the CSS duration in step. */
const DONE_GLOW_MS = 2100

/** How far a press has to travel before it is a drag rather than a click. Measured on
 *  the real window: a press that drifted 6px selected nothing, because 5px was inside
 *  the noise of an ordinary mouse click. */
const DRAG_SLOP = 9
/**
 * How far a finger may travel and still be a tap. Under the drag threshold on purpose:
 * this one only decides whether a touch OPENS the card it was pressed on, and a gesture
 * that wandered this far was somebody starting to scroll the list.
 */
const TAP_SLOP = 6

/** How long a press has to be HELD before the card shows the grab cursor. Purely the
 *  cursor - the drag itself still starts on DRAG_SLOP of movement, so a fast grab is
 *  never delayed. A click is a press of ~80-120ms, so anything under ~150ms would still
 *  flash a hand on every selection; 220ms reads as "I am holding this". */
const HOLD_CURSOR_MS = 220


/** A pending question for the in-app confirm/prompt dialog. */
interface AskState {
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
  input?: { placeholder?: string; defaultValue?: string }
  check?: { label: string }
  cancelLabel?: string
  onConfirm: (value: string, checked: boolean) => void
  /** Only for a question whose two answers are both real choices. Esc means cancel. */
  onCancel?: (checked: boolean) => void
}

/**
 * "The desk is not answering" - the one thing a phone cannot read off its own screen.
 *
 * Every pane a phone draws comes from the last session list it was sent, and that list
 * carries no clock. So a sleeping Mac changes nothing on the phone: the rows keep the
 * status they had when the link died and a desk of finished turns reads as a desk of dead
 * sessions. This says the rows are a photograph and how old it is. See shared/linkState.ts
 * for why it never claims the machine is asleep - this screen cannot tell that from a
 * dropped tunnel or from a handset with no signal.
 *
 * Drawn only on a phone: the desk window is looking at its own machine.
 */
function LinkBanner(): JSX.Element | null {
  const [link, setLink] = useState<LinkState>({ up: true, lastSeen: Date.now() })
  useEffect(() => window.api.onLinkState((s: LinkState) => setLink(s)), [])
  // One second while the gap is short, so the first "12s" moves; a minute past that, which
  // is the unit the string actually draws. Same rule as every other clock here.
  const now = useNow(link.lastSeen && Date.now() - link.lastSeen > 60_000 ? 60_000 : 1000)
  if (!isPhoneClient() || !linkLost(link, now)) return null
  return (
    <div className="link-down" role="status">
      <span className="link-down-head">{linkWords(link, now)}</span>
      <span className="link-down-note">{linkNote()}</span>
    </div>
  )
}

/**
 * The tick under the soonest auto-answer countdown.
 *
 * Its own component for the reason `AskClock` is, and this one was the expensive miss: the
 * clock it needs was read at the TOP of App, so the whole desk - sidebar, every card, the
 * grid - re-rendered once a second for ever, whether or not any pane was counting down.
 * Measured in a real window on an empty desk: 6 whole-window renders in 6 seconds before
 * this, 0 after. On a full, already-lagging desk that is the difference between a
 * countdown that draws and one that stalls.
 *
 * It is also phased on the DEADLINE, not the wall clock, which is what the number in the
 * pane is phased on (`AskCountdown`). Two clocks a second apart is why the sound landed
 * off the digit it was meant to be counting.
 */
function AutoTick({ at, tick }: { at: number; tick: () => void }): null {
  const now = useNow(at ? 1000 : Infinity, at)
  // The second last ticked FOR THIS countdown. Keyed by the deadline as well as by the
  // number, so a new question that happens to start at the same reading is still heard.
  const last = useRef('')
  useEffect(() => {
    if (!at) {
      last.current = ''
      return
    }
    const left = Math.ceil((at - now) / 1000)
    // Nothing before the last minute: a wait somebody lengthened to five minutes in
    // Settings is a clock, not an alarm, and ticking through all of it is a metronome.
    if (left <= 0 || left > 60) return
    const key = `${at}:${left}`
    if (last.current === key) return
    last.current = key
    tick()
  }, [at, now, tick])
  return null
}

/** Whole-window render counter, exposed for probes. See the component body. */
const deskRenders = { n: 0 }
;(window as unknown as { __pfDeskRenders?: { n: number } }).__pfDeskRenders = deskRenders

export default function App(): JSX.Element {
  // How many times the WHOLE window has re-rendered, for probes. The sidebar, every card
  // and the grid hang off this component, so a subscription taken out here costs a render
  // of the desk - which is how a one-second clock read at the top of App turned into the
  // most expensive timer in the app. `scripts/desk-render-test.mjs` reads it.
  deskRenders.n++
  const [rawSessions, setSessions] = useState<Session[]>([])
  /** Which device's panes the sidebar is showing. `all` remains the default desk view. */
  const [deviceFilter, setDeviceFilter] = useState('all')
  // The order the sidebar was dragged into, by id. Main is told about it too (so the
  // grid, the Ctrl-N keys and a restore after an update all agree), but the list is
  // sorted here as well: a drop has to land the instant the mouse comes up, not one
  // IPC round trip later, and a mirrored pane can be moved in this window even though
  // the machine that owns it keeps its own order.
  const [order, setOrder] = useState<string[]>([])
  const sessions = useMemo(() => {
    if (!order.length) return rawSessions
    const rank = new Map(order.map((id, i) => [id, i]))
    // Stable sort: a pane that started after the last drag has no rank and stays put
    // at the end, in the order main gave it.
    return [...rawSessions].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [rawSessions, order])
  const shownSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          deviceFilter === 'all' ||
          (deviceFilter === 'local' ? !session.remote : session.remote?.device === deviceFilter)
      ),
    [sessions, deviceFilter]
  )
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [config, setConfigState] = useState<Config | null>(null)
  // The live config for the two async paths that read it long after their effect closed
  // over it - the pressure card's move suggestion is one. A stale `autoHandoff` there would
  // offer a pane the current settings refuse.
  const configRef = useRef<Config | null>(null)
  configRef.current = config
  const [activeId, setActiveId] = useState<string | null>(null)
  /**
   * When the keyboard last LEFT each pane, which is when its idle clock may start.
   *
   * A ref, not state: nothing draws it, and every sweep that reads it already runs off a
   * timer or off a session broadcast. Written once per focus change and never persisted -
   * after a restart a pane's own `lastKeyboard`/`lastOutput` are the launch moment anyway,
   * so there is nothing for a remembered blur to correct.
   */
  const focusLeftAt = useRef<Record<string, number>>({})
  const hadFocus = useRef<string | null>(null)
  useEffect(() => {
    if (hadFocus.current && hadFocus.current !== activeId)
      focusLeftAt.current[hadFocus.current] = Date.now()
    // ...and the pane being ARRIVED at, which is the half that was missing. Reading the
    // blur alone means a pane's clock only restarts on the way OUT, so a pane picked up
    // while its chip said `closes 1:12` kept that deadline for as long as the keyboard sat
    // in it without producing a keystroke or a byte, and the card went straight back to
    // 1:12 on the way out. Robert, 2026-08-24: "when you click on session the 5min closing
    // timer doesnt reset". Touching a pane is using it, at both ends of the visit.
    if (activeId) focusLeftAt.current[activeId] = Date.now()
    hadFocus.current = activeId
  }, [activeId])
  /**
   * Panes somebody has said are never to be closed for being idle - see
   * `ReclaimPane.pinned`. State rather than a ref because the card's menu draws which way
   * the switch is, and the chip has to go the moment it is pressed.
   */
  const [pinned, setPinned] = useState<Record<string, true>>({})
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  const [picking, setPicking] = useState(false)
  const [settings, setSettings] = useState(false)
  // Which page Settings should open on, when a button somewhere IS about one page - the
  // Stash panel's gear. null is "wherever it opens by default".
  const [settingsFrom, setSettingsFrom] = useState<'stash' | null>(null)
  const [help, setHelp] = useState(false)
  const [palette, setPalette] = useState(false)
  /** the folder whose changes are being read, and how it was opened */
  const [diff, setDiff] = useState<{ cwd: string; lane?: string; pane?: number; scope: DiffScope } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [swarm, setSwarm] = useState(false)
  /** The "split one long ask into panes" dialog. Opened from a press, never on its own. */
  const [splitting, setSplitting] = useState(false)
  const [board, setBoard] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const [devices, setDevices] = useState(false)
  /** The pane (or its one worktree lane) that is about to move to a paired machine. */
  const [handoff, setHandoff] = useState<HandoffTarget | null>(null)
  /** The card a right-click landed on, and where the pointer was when it did. */
  const [cardMenu, setCardMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  /** The pane whose details are open - "how long has this been sitting here" and the rest. */
  const [info, setInfo] = useState<string | null>(null)
  /** the pane whose ⋯ sheet is open, which is the only way to its actions at phone width */
  const [paneMenu, setPaneMenu] = useState<string | null>(null)

  /**
   * Take a pane off the move queue, from the card, the context menu or the phone's sheet.
   *
   * `remote:handoffCancel` has existed for as long as the queue has and nothing in this
   * window ever called it: a pane could be put on that list from three places and taken
   * off it only by a script. A queued pane waits for its own agent, which runs for as long
   * as it runs - 13 and 18 minutes for the two that produced this - so "waiting" is a
   * state somebody watches for minutes with no way to change their mind.
   *
   * It reports the one case it cannot serve rather than claiming it: a move already in
   * flight is past the queue and cannot be called back.
   */
  const stopMove = (s: { id: string; title: string }): void => {
    // ...and it HOLDS the pane, which taking it off the queue does not.
    //
    // `cancelHandoff` empties the queue entry and nothing else, so the sweep that put it
    // there was free to pick the same pane on its very next pass - the budget rung runs on
    // every session change and the idle one every minute. Reported 2026-08-23: "i press
    // keep it here but it still comes up again later to move it not even a minute later".
    // The mascot's own "Keep it here" always did this (`keepOpen`); the chip, the card menu
    // and the phone's sheet reached the cancel without it, which made the visible control
    // the one that did not work.
    keepHere([s.id])
    void api
      .cancelHandoff(s.id)
      .then((stopped) =>
        flash(
          stopped
            ? `${s.title} stays here for ${KEEP_MINUTES} minutes`
            : `${s.title} is already moving - too late to stop it`
        )
      )
  }
  /** the pane whose output is being read as text (and therefore selected with a finger) */
  const [textPane, setTextPane] = useState<string | null>(null)
  /**
   * On a phone (or any window under 720px) the list and the panes take turns rather than
   * sharing the width - see handheld.ts. Nothing else in here has to know: the classes go
   * on `<html>` and styles.css does the layout.
   */
  const handheld = useHandheld(activeId)
  // A swipe in from the left edge is the phone's Back, same gesture as iOS. Only armed
  // while a pane holds the screen, and only from the first 28px so a terminal's own
  // horizontal scrolls and selections never trigger it.
  const swipeFrom = useRef<{ x: number; y: number } | null>(null)
  // Null until the main process has answered once. The dialog draws a placeholder
  // rather than an empty machine, which reads as "you have no devices".
  const [remote, setRemote] = useState<RemoteState | null>(null)
  const deviceChoices = useMemo(() => {
    const seen = new Map<string, string>()
    for (const session of sessions) {
      if (session.remote) seen.set(session.remote.device, session.remote.name)
    }
    // ...and every device that is merely CONNECTED, whether or not a pane of its is being
    // mirrored. Built from mirrored sessions alone, the filter could not name the one
    // machine somebody opens this list to look at: a PC running everything and mirroring
    // nothing was absent from its own dropdown.
    for (const peer of remote?.peers ?? [])
      if (peer.status === 'online') seen.set(peer.id, peer.name)
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [sessions, remote])
  useEffect(() => {
    if (deviceFilter !== 'all' && deviceFilter !== 'local' && !deviceChoices.some((d) => d.id === deviceFilter))
      setDeviceFilter('all')
  }, [deviceFilter, deviceChoices])
  const [phone, setPhone] = useState<PhoneState | null>(null)
  // The panes the last run left behind, when the launch decided to ask about them.
  const [restore, setRestore] = useState<RestoreOffer | null>(null)
  // One in-app dialog stands in for window.confirm and window.prompt. Both of those
  // draw Chromium's system box, which looks nothing like the app and blocks the
  // renderer while it is open.
  const [ask, setAsk] = useState<AskState | null>(null)
  // The clipboard shelf: what you last copied, and whether its corner panel is open
  // because you asked (pinned) or because something just landed (peek).
  const [recents, setRecents] = useState<RecentItem[]>([])
  // The overlay hands back an id, and the handler that resolves it must not be rebuilt
  // (and re-subscribed) every time something new is copied.
  const recentsRef = useRef<RecentItem[]>([])
  recentsRef.current = recents
  // Remembered across restarts: "leave the Stash on screen" is a state somebody chose,
  // and an app restart (most often the updater's) must not quietly undo it.
  const [shelfPinned, setShelfPinned] = useState(() => {
    try {
      return localStorage.getItem('pf.shelfPinned') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('pf.shelfPinned', shelfPinned ? '1' : '0')
    } catch {
      /* the shelf just forgets it was open */
    }
  }, [shelfPinned])
  const [shelfPeek, setShelfPeek] = useState(false)
  // The in-window Stash open for a search, which is the one thing the floating overlay
  // cannot do for itself: it is unfocusable by design, so there is no keyboard in it.
  const [shelfSearching, setShelfSearching] = useState(false)
  const peekTimer = useRef<number>()
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  // Read from inside listeners that outlive a render - the draft watcher below fires on
  // every keystroke and must not re-subscribe each time the session list changes.
  const sessionsRef = useRef<Session[]>([])
  /**
   * "pane 3" for a session id, numbered off the same list the sidebar numbers and
   * Ctrl+3 reaches. A ref because the sweeps that use it run from timers holding no
   * render's closure, and a stale name here would point at the wrong card.
   */
  const paneWordRef = useRef((id: string) => {
    const i = sessionsRef.current.findIndex((x) => x.id === id)
    if (i < 0) return 'a pane'
    const s = sessionsRef.current[i]
    // The project as well as the number: "closed pane 3" names a keystroke, and the thing
    // somebody wants back is a conversation. Same words the mascot uses everywhere else.
    const place = describePlace({ cwd: s.cwd, lane: s.lane })
    return paneWord({
      // The NAME on the card in the sidebar, ahead of the folder the pane happens to sit
      // in. A pane renamed `Sonia` because that is whose work it is was still announced as
      // `clients-a` by every countdown, which is the one sentence where the pane has to be
      // recognised in a hurry. `s.title` IS the project name until somebody renames it, so
      // this changes nothing on a pane nobody has named.
      name: s.title || projectNameOf(s.cwd),
      pane: i + 1,
      // Only a lane earns the extra words: `place.ts`'s rule is that a trunk checkout is
      // what a bare project name already means.
      where: place.kind === 'lane' ? place.role : ''
    })
  })
  /**
   * ...and the same pane with what it was in the middle of.
   *
   * `Session.gist` is History's own line, pushed onto the live session so a sentence about
   * a pane can be written while the pane still exists. Absent is said as nothing: a
   * confident wrong subject on a pane that has just been closed is worse than none.
   */
  const paneActedRef = useRef(
    (id: string): ActedPane => ({
      word: paneWordRef.current(id),
      doing: sessionsRef.current.find((x) => x.id === id)?.gist
    })
  )
  sessionsRef.current = sessions
  /**
   * Last input anywhere in the app that did NOT go into a pane's pty - a click, a drag,
   * the shelf, a settings toggle. Only the idle-quit clock reads it; without it, reading
   * the fleet board or watching a build scroll past looks identical to being out.
   */
  const lastAppInputRef = useRef<number>(Date.now())
  useEffect(() => {
    const touch = (): void => {
      lastAppInputRef.current = Date.now()
    }
    // Capture phase, because a pane's own handlers stop plenty of these from bubbling.
    const opts = { capture: true, passive: true } as const
    for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
      window.addEventListener(ev, touch, opts)
    }
    window.addEventListener('focus', touch)
    return () => {
      for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
        window.removeEventListener(ev, touch, opts)
      }
      window.removeEventListener('focus', touch)
    }
  }, [])

  /**
   * The keyboard belongs to the pane you are working in, and finds its own way back there.
   *
   * Everything you do to a pane is done from somewhere that is not the pane: a button in
   * its header, a row in the sidebar, a dialog, the palette. Every one of those takes the
   * keyboard - a `<button>` holds it and does nothing with it, a dialog that closes leaves
   * it on nothing at all - and the only way back was clicking into the terminal again.
   * That is the whole of "PaneForge broke my focus", and it is one rule rather than thirty
   * handlers: when nothing on screen genuinely wants the keys, the active pane has them.
   *
   * Two things are never interrupted, because in both the keys are exactly where they
   * should be: a real text field (a rename box, a search, a dialog's input - the pane's
   * own terminal is one of these too, so typing is never touched), and an open layer
   * (`.overlay` is every dialog in this app, `.select-menu` every dropdown).
   */
  const restoreFocus = useCallback(() => {
    const el = document.activeElement as HTMLElement | null
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
    if (document.querySelector('.overlay, .select-menu')) return
    const id = activeRef.current
    if (id) paneFocus.get(id)?.()
  }, [])

  // A click that ended on a button, an icon or a gap has nothing to type into. Deferred a
  // tick so React has finished opening whatever the click opened: a dropdown that is about
  // to take the keys legitimately is already in the DOM by the time this looks.
  // Escape is the other way out of a layer, and the dropdown's own Escape hands the
  // keyboard to the trigger button it came from - a place with nothing to type into.
  // Same rule, same guards: after the tick, anything still holding the keys keeps them.
  useEffect(() => {
    const give = (): void => void window.setTimeout(restoreFocus, 0)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') give()
    }
    // Both on the way DOWN: a dropdown's own Escape handler stops the event dead so the
    // global shortcuts cannot see it, and a bubble-phase listener here would never run.
    // Nothing is decided at this point anyway - the tick is what looks at the result.
    // Focus is also lost with no click and no key at all: a `pane:reset` tears down the
    // terminal that was holding the keys and the browser drops them on `document.body`,
    // where nothing can be typed and nothing will ever hand them back. Only that case is
    // caught - a null `relatedTarget` means the focus went nowhere, and the tick confirms
    // nothing has claimed it since - so a deliberate move into a field, a button or a
    // dialog somewhere else in the app is never pulled out from under it.
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget) return
      window.setTimeout(() => {
        const el = document.activeElement
        if (el && el !== document.body) return
        restoreFocus()
      }, 0)
    }
    document.addEventListener('click', give, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusout', onFocusOut, true)
    // Coming back to the app from somewhere else. Windows hands the keyboard to whatever
    // held it when you left, which after a click on a button is that button - so the first
    // thing typed after an alt-tab went nowhere.
    window.addEventListener('focus', give)
    return () => {
      document.removeEventListener('click', give, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('focus', give)
    }
  }, [restoreFocus])

  // Escape out of the palette, Enter in a dialog, a rename committed: a layer closing is
  // the other half of the same rule, and none of those arrive as a click.
  const layerOpen =
    picking ||
    settings ||
    help ||
    palette ||
    swarm ||
    history ||
    devices ||
    board !== null ||
    diff !== null ||
    ask !== null ||
    restore !== null ||
    renaming !== null
  useEffect(() => {
    if (layerOpen) return
    const t = window.setTimeout(restoreFocus, 0)
    return () => window.clearTimeout(t)
  }, [layerOpen, restoreFocus])

  /* The sidebar's decorations run forever by design - a key breathes for as long as its
     agent is running, and a run is hours. Chromium throttles a window it believes is
     hidden, but a window sitting visible behind the editor is not hidden, so all of that
     kept being composited while Robert was somewhere else entirely. This marks the
     document while the window is unfocused and styles.css uses that to hold every glow
     at full and stop animating: the state still reads from across the room, the frames
     stop being spent on it. */
  useEffect(() => {
    const sync = (): void => {
      const away = !document.hasFocus() || document.visibilityState !== 'visible'
      document.documentElement.classList.toggle('app-blurred', away)
      // Re-timed on the way back in, not only at startup: the window may have been
      // dragged to the other monitor, which is a different panel and a different budget.
      if (!away) measureRefreshRate()
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  // The window's own colours. Ahead of the pane list on purpose: this writes CSS
  // variables, so it costs one style recalculation and no React tree ever re-renders
  // for it - which is what lets a slider in Settings drag the whole app's palette.
  useEffect(() => applyTheme(config?.theme), [config?.theme])

  // Memoised because it is an object identity xterm compares against: a fresh one every
  // render would clear and repaint every pane's canvas on every keystroke.
  const termColors = useMemo(() => terminalTheme(config?.theme), [config?.theme])

  useEffect(() => {
    api.listSessions().then(setSessions)
    api.getConfig().then(setConfigState)
    // Pulled, not pushed: main decides what to do with the last run's panes while
    // this window is still loading, so it holds the question until we ask for it.
    api.pendingRestore().then(setRestore)
    api.remoteState().then(setRemote)
    // The phone's state is held HERE and not only inside the Devices dialog, for one
    // reason: a browser asking to be let in raises a card, and that request arrives while
    // somebody is standing in the hall with a phone, not while that dialog is open.
    api.phoneState().then(setPhone)
    const offS = api.onSessions(setSessions)
    const offC = api.onConfig(setConfigState)
    // Pushed rather than polled: a device coming or going, a guest attaching, a
    // reconnect finishing - all of them change what the sidebar says.
    const offR = api.onRemote(setRemote)
    const offP = api.onPhone(setPhone)
    return () => {
      offS()
      offC()
      offR()
      offP()
    }
  }, [])

  // The project list is derived from the root folder, so refresh it whenever the
  // root changes - and on every open of the picker, so a project folder created
  // while the app was running shows up without a restart. Without `picking` here
  // the list was read once at startup: a repo an agent created an hour into the
  // session was simply absent from New Session, with nothing to explain why.
  useEffect(() => {
    api.listProjects().then(setProjects)
  }, [config?.root, picking])

  // Re-probed whenever the custom list changes, and on every open of the picker, so
  // a CLI installed while the app was running shows up without a restart.
  useEffect(() => {
    api.listAgents().then(setAgents)
  }, [config?.customAgents, picking, settings])

  /**
   * Keep a sane selection as sessions come and go.
   *
   * `sessions[0]` was the fallback and it is the wrong pane in the one case anybody
   * notices: a HANDOFF. The local pane is killed the moment the far end acks and comes
   * straight back as a mirror under a different id (`@device/<their id>`), so the pane
   * being watched vanishes for a beat - and this effect ran first and threw the focus to
   * the top of the list. "I pressed hand off and it opens a different session." The same
   * jump happens on any close: the neighbour you were next to is the pane you meant, not
   * whatever happens to sort first.
   *
   * So two rules, in order. A mirror that ARRIVED in this same update wins, because the
   * only thing that makes a pane appear at the instant another disappears is that one
   * becoming the other. Otherwise the selection falls to the pane that took the old
   * one's PLACE - its index, clamped - which is where the eye already is.
   *
   * `openListed` (bringing a listed pane back) is untouched: it names the pane it wants
   * through `pendingOpen` and that is a stronger signal than either rule here.
   */
  const lastSessionIds = useRef<string[]>([])
  useEffect(() => {
    const ids = sessions.map((s) => s.id)
    const before = lastSessionIds.current
    lastSessionIds.current = ids
    if (sessions.length === 0) {
      if (activeId !== null) setActiveId(null)
      return
    }
    if (sessions.some((s) => s.id === activeId)) return
    const arrived = sessions.filter((s) => !before.includes(s.id))
    const mirror = arrived.find((s) => s.remote)
    if (mirror) {
      setActiveId(mirror.id)
      return
    }
    if (arrived.length === 1) {
      setActiveId(arrived[0].id)
      return
    }
    const was = activeId ? before.indexOf(activeId) : -1
    const at = was < 0 ? 0 : Math.min(was, sessions.length - 1)
    setActiveId(sessions[at].id)
  }, [sessions, activeId])

  // Looking at a pane counts as acknowledging it - but only while you are actually
  // looking. This used to acknowledge the focused pane on every session update no
  // matter what, so a minimised window silently marked the pane you happened to leave
  // selected as "seen", and the one alert that mattered (a turn finishing while you
  // were in another app) was the one that never fired.
  useEffect(() => {
    const ack = (): void => {
      if (!activeId || document.hidden || !document.hasFocus()) return
      api.clearAttention(activeId)
    }
    ack()
    window.addEventListener('focus', ack)
    document.addEventListener('visibilitychange', ack)
    return () => {
      window.removeEventListener('focus', ack)
      document.removeEventListener('visibilitychange', ack)
    }
  }, [activeId, sessions])

  // The chime is the one alert that fires even while the app has focus: a turn
  // ending in a pane you are not currently reading is exactly what the taskbar
  // flash cannot tell you. Read through a ref so toggling the setting does not
  // resubscribe (and so the listener is attached exactly once).
  const soundOn = useRef(true)
  soundOn.current = config?.soundOnIdle ?? true
  // Which sound each alert makes, read through a ref for the same reason: the listeners
  // below are attached once, and a picker change must reach the NEXT alert without
  // resubscribing to every session event.
  const soundSet = useRef<Config['sounds'] | undefined>(undefined)
  soundSet.current = config?.sounds
  // ...and the countdown is also a SOUND.
  //
  // A question answered for you is the one thing this app does on its own that somebody
  // may want to stop, and the window in which they can is the countdown - which is drawn
  // inside a pane. A pane that is not on screen (the grid off, another desktop, the window
  // minimised) had no way of saying so at all, which is why "I cannot even see the timer
  // counting down" is a real report about a feature that works. One tick a second says it
  // without needing a screen.
  //
  // The SOONEST countdown on the desk, not one per pane: two panes counting down together
  // would beat against each other twice a second, which reads as a fault rather than as a
  // clock.
  const soonestAuto = sessions.reduce(
    (min, s) => (s.autoAnswerAt && (!min || s.autoAnswerAt < min) ? s.autoAnswerAt : min),
    0
  )
  // Reads refs, so its identity never changes and the tick's effect is not re-run by this
  // component rendering for some other reason. The volume slider, and a picker pointed at
  // a file of your own, are honoured by `playTick` itself.
  const autoTick = useCallback(() => {
    if (soundOn.current) playTick(soundSet.current)
  }, [])

  // The pane already on screen is acknowledged the moment it raises its hand
  // (the effect above clears it), so chiming for it is noise about something you
  // are already watching.
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  // Which cards are lit because their turn JUST ended. The chime says a turn is over
  // but not whose, and with eight panes open the sidebar answers that far faster than
  // reading them - so the card that made the sound glows for a few seconds. It is a
  // fading flash, not the standing amber `attn` mark: that one stays until the pane is
  // read, this one answers "which one was that" and gets out of the way.
  const [justDone, setJustDone] = useState<string[]>([])
  const doneTimers = useRef(new Map<string, number>())
  useEffect(
    () =>
      api.onAttention((s) => {
        // Silent only for the pane you are demonstrably watching right now. With the
        // window in the background there is no such pane, so the selected one is as
        // worth announcing as any other.
        const watching = s.id === activeIdRef.current && !document.hidden && document.hasFocus()
        // A pane holding a question reaches this the same way a finished pane does - every
        // idle reading in the app says yes about it - and it has its own alert with its own
        // sound and its own red card. Chiming "finished" over it is the wrong word for a
        // run that has stopped and will not move again until it is answered.
        if (s.ask) return
        if (soundOn.current && !watching) playEvent('done', soundSet.current)
        if (watching) return
        setJustDone((cur) => (cur.includes(s.id) ? cur : [...cur, s.id]))
        window.clearTimeout(doneTimers.current.get(s.id))
        doneTimers.current.set(
          s.id,
          window.setTimeout(() => {
            doneTimers.current.delete(s.id)
            setJustDone((cur) => cur.filter((x) => x !== s.id))
          }, DONE_GLOW_MS)
        )
      }),
    []
  )
  // The two alerts that are not good news. Same glow, same "not for the pane you are
  // already reading" rule, different sounds - falling for a stalled turn, one bright
  // note for the bell - so which kind it was is answerable without looking up.
  //
  // The stall sound follows soundOnIdle for one reason: it is the same setting's
  // subject ("tell me about panes out loud"), and a second toggle for it would be a
  // preference nobody has an opinion about until it is wrong. The bell has its own,
  // because a CLI that rings constantly is a real thing and muting it must not mute
  // the turn chime as well.
  const bellOn = useRef(true)
  bellOn.current = config?.bellAlert ?? true
  useEffect(() => {
    const glow = (id: string): void => {
      setJustDone((cur) => (cur.includes(id) ? cur : [...cur, id]))
      window.clearTimeout(doneTimers.current.get(id))
      doneTimers.current.set(
        id,
        window.setTimeout(() => {
          doneTimers.current.delete(id)
          setJustDone((cur) => cur.filter((x) => x !== id))
        }, DONE_GLOW_MS)
      )
    }
    const watching = (s: Session): boolean =>
      s.id === activeIdRef.current && !document.hidden && document.hasFocus()
    const offStalled = api.onStalled((s) => {
      if (soundOn.current && !watching(s)) playEvent('stall', soundSet.current)
      if (!watching(s)) glow(s.id)
    })
    // A question is its own alert, and the loudest thing the app can say: the run is not
    // finished, it is stopped, and only a person restarts it.
    const offAsk = api.onAsk((s) => {
      if (soundOn.current && !watching(s)) playEvent('ask', soundSet.current)
      if (!watching(s)) glow(s.id)
    })
    const offBell = api.onBell((s) => {
      if (!bellOn.current) return
      if (soundOn.current && !watching(s)) playEvent('bell', soundSet.current)
      if (!watching(s)) glow(s.id)
    })
    return () => {
      offStalled()
      offAsk()
      offBell()
    }
  }, [])
  // Looking at the pane answers the question the glow was asking, however you got
  // there - the card, Ctrl-N or the palette.
  useEffect(() => {
    if (!activeId) return
    setJustDone((cur) => (cur.includes(activeId) ? cur.filter((x) => x !== activeId) : cur))
  }, [activeId])
  useEffect(() => {
    const timers = doneTimers.current
    return () => {
      for (const t of timers.values()) window.clearTimeout(t)
      timers.clear()
    }
  }, [])

  /**
   * Drag a session card to move it up or down the list.
   *
   * Pointer events rather than HTML5 drag and drop: the row is also a click target, a
   * double-click target and holds two buttons, and `draggable` steals all three. A press
   * that never moves 5px is still a plain click, so nothing is taken away from a card
   * that is only being selected.
   *
   * The list itself is reordered while the pointer moves - the card follows the cursor
   * because it IS in the new place - and every row is keyed by session id, so React
   * moves the existing DOM node instead of building a new one. That is what keeps the
   * turn clock ticking through a drag: `Elapsed` counts from an absolute timestamp on a
   * timer shared by the whole window, and neither of them is touched by a card changing
   * position. The Ctrl-N badge is the row's index, so it renumbers itself on the way.
   */
  const listRef = useRef<HTMLDivElement>(null)
  const idsRef = useRef<string[]>([])
  idsRef.current = sessions.map((s) => s.id)
  const [dragId, setDragId] = useState<string | null>(null)
  // A drag ends on the same element a click would, so the mouseup that finishes it must
  // not also select whatever card is now under the cursor.
  const draggedRef = useRef(false)

  const beginDrag = useCallback((e: React.PointerEvent, id: string, tap?: () => void) => {
    if (e.button !== 0) return
    // The close/restart buttons and the rename box own their own presses.
    if ((e.target as HTMLElement).closest('button, input')) return
    // A finger is never still. A touch that drifts even slightly makes a mobile browser
    // decide the gesture was a scroll and throw the `click` away, which is why opening a
    // pane on a phone took two taps: the first one was spent proving it was a tap. So a
    // touch that did not turn into a drag opens the row from `pointerup`, which no scroll
    // heuristic gets to veto. A click that does still arrive lands on the same two idempotent
    // calls. Mouse presses are left alone - a click is reliable there, and `onClick` also
    // catches keyboard activation.
    const finger = e.pointerType === 'touch'
    const startY = e.clientY
    const startX = e.clientX
    /** the finger travelled far enough that this was a scroll, not a tap */
    let drifted = false
    let dragging = false
    const startIds = idsRef.current
    let latest = startIds
    // The grab cursor is armed by TIME, not by the press. `currentTarget` is read now:
    // React nulls it the moment this handler returns, so the timer below would have
    // nothing to paint. The class is dropped again by `disarm` on release and when a
    // real drag starts - from there `body.dragging` owns the cursor for every element.
    const row = e.currentTarget as HTMLElement
    let armTimer: number | null = window.setTimeout(() => {
      armTimer = null
      row.classList.add('hold-arm')
    }, HOLD_CURSOR_MS)
    const disarm = (): void => {
      if (armTimer !== null) {
        clearTimeout(armTimer)
        armTimer = null
      }
      row.classList.remove('hold-arm')
    }
    // Captured on the list, which never moves, rather than on the row, which does: a
    // release outside the window has to end the drag too, or the list is left following
    // a mouse button nobody is holding.
    //
    // Taken only once a drag has actually started, NEVER on the press. Pointer capture
    // retargets the click that follows to the capturing element, so capturing here on
    // every pointerdown sent the click to `.list` instead of the card - measured: the
    // card's own onClick never ran and `document`'s click listener reported target
    // "list" - and selecting a pane by clicking it silently did nothing.
    const capture = listRef.current
    const grabPointer = (): void => {
      try {
        capture?.setPointerCapture(e.pointerId)
      } catch {
        /* a pointer that has already been released - the listeners below still clean up */
      }
    }
    const move = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) >= TAP_SLOP || Math.abs(ev.clientX - startX) >= TAP_SLOP)
          drifted = true
        if (Math.abs(ev.clientY - startY) < DRAG_SLOP) return
        dragging = true
        disarm()
        grabPointer()
        setDragId(id)
        document.body.classList.add('dragging')
      }
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.row[data-id]') ?? [])
      if (!rows.length) return
      // The card the pointer is over, clamped to the ends so dragging past the top or
      // the bottom of the list parks the card there instead of doing nothing.
      const first = rows[0].getBoundingClientRect()
      const last = rows[rows.length - 1].getBoundingClientRect()
      let over: HTMLElement | undefined
      if (ev.clientY <= first.top) over = rows[0]
      else if (ev.clientY >= last.bottom) over = rows[rows.length - 1]
      else
        over = rows.find((r) => {
          const box = r.getBoundingClientRect()
          return ev.clientY >= box.top && ev.clientY <= box.bottom
        })
      // Positions come from the order being built, never from the row's place in the
      // DOM: two moves can arrive in one frame (a fast drag, or coalesced pointer
      // events) and the second would then be measured against a list React has not
      // redrawn yet - which moved whichever card happened to be sitting in that slot
      // instead of the one being dragged.
      const targetId = over?.dataset.id
      if (!targetId) return
      const from = latest.indexOf(id)
      const to = latest.indexOf(targetId)
      if (from < 0 || to < 0 || to === from) return
      const next = latest.slice()
      next.splice(to, 0, next.splice(from, 1)[0])
      latest = next
      setOrder(next)
    }
    const up = (ev?: Event): void => {
      disarm()
      // A pointercancel is the browser taking the gesture away to scroll with it. That is
      // not a tap however still the finger was, so it never opens anything.
      const stolen = ev?.type === 'pointercancel'
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try {
        if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId)
      } catch {
        /* already gone */
      }
      if (!dragging) {
        // Never reordered, so this was a tap, and on touch that is the only signal that
        // reliably survives - see `finger` above.
        if (finger && !stolen && !drifted) tap?.()
        return
      }
      document.body.classList.remove('dragging')
      setDragId(null)
      // A gesture that ended with every card where it started is a click, however far
      // the hand wandered on the way. Only a real move eats the click that follows: a
      // press that drifted and came back used to select nothing at all, which is what
      // "I cannot click my sessions any more" was - a click is rarely perfectly still.
      const moved = latest.length !== startIds.length || latest.some((x, i) => x !== startIds[i])
      if (!moved) return
      // Main keeps the same order, so the grid, an update restart and the other
      // machine's view of these panes all agree with what the sidebar shows.
      api.reorderSessions(latest)
      // The click that follows this pointerup is the end of the drag, not a selection.
      draggedRef.current = true
      window.setTimeout(() => {
        draggedRef.current = false
      }, 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])

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

  // A main-process error used to be a modal box that took the keyboard off whatever you
  // were typing. It says so in the corner now; the stack is in paneforge-errors.log.
  useEffect(() => api.onAppError((message) => flash(`Something went wrong: ${message}`)), [flash])

  /**
   * The Stash. Anything copied - in this app or any other - shows itself in the bottom-left
   * corner for as long as Settings says, and stays on the Stash for later. A peek of 0 is
   * "never open by itself": the list is still filling, it just stops interrupting.
   */
  const peekMs = config?.stashPeekMs ?? 0
  /**
   * There is one Stash, not two. While the floating window is on it owns all of this -
   * the same copy showing up both there and in an in-window panel was the app talking
   * over itself. The in-window shelf is what you get when the floating one is turned off.
   */
  const shelfInWindow = !!config?.clipboardShelf && !config?.clipboardOverlay
  useEffect(() => {
    if (config?.clipboardShelf === false) {
      setRecents([])
      setShelfPinned(false)
      return
    }
    api.listRecents().then(setRecents)
    return api.onRecents((items) => {
      setRecents(items)
      if (!items.length || peekMs <= 0 || !shelfInWindow) return
      // A copy this app made itself is not an event worth interrupting for. Selecting
      // text in a pane copies it (copy-on-select is the terminal's whole contract), so
      // reading a log used to make the Stash announce itself every few seconds - the
      // "it keeps popping up randomly" this fixes. It is on the Stash either way; the
      // list simply does not open for it. See `own` in main/recents.ts.
      if (items[0]?.own) return
      setShelfPeek(true)
      window.clearTimeout(peekTimer.current)
      peekTimer.current = window.setTimeout(() => setShelfPeek(false), peekMs)
    })
  }, [config?.clipboardShelf, peekMs, shelfInWindow])

  /**
   * The other half of "one Stash": the overlay floats above this window, so while a list
   * is open HERE the overlay has to stay a pill. Main is told rather than asked, because
   * the overlay is a second BrowserWindow and cannot see this one's state.
   *
   * The peek is deliberately not counted - it is a strip that shows itself for a few
   * seconds and puts itself away, and gagging the overlay every time something is copied
   * would be the opposite of the point.
   */
  const stashOpenHere = shelfPinned || shelfSearching
  useEffect(() => {
    api.stashInWindow(stashOpenHere)
  }, [stashOpenHere])

  /**
   * Put a shelf item into the focused pane. Text goes in as text; an image goes in as the
   * path of the PNG the app saved, because a path is the only form of an image a CLI agent
   * can read. Nothing is sent - it lands at the prompt so it can be described first.
   */
  const sendRecent = useCallback(
    (it: RecentItem) => {
      const id = activeRef.current
      if (!id) return flash('Nothing focused - open a pane first.')
      if (it.kind === 'image' || it.kind === 'file') {
        const path = it.path ?? ''
        if (!path) return
        api.write(id, (/[\s"']/.test(path) ? `"${path}"` : path) + ' ')
        flash(it.kind === 'file' ? 'File path typed into the pane.' : 'Image path typed into the pane.')
      } else {
        // The list arrives without the clip bodies (383KB of a full history, none of it
        // ever drawn), so the one entry being typed is fetched here. `it.text` is still
        // honoured for anything that already has it.
        void Promise.resolve(it.text || api.recentText(it.id)).then((text) => {
          if (!text) return
          // As a paste, not as typing. Every agent here runs a TUI with bracketed paste on,
          // and a stash entry is usually several lines: written to the pty they arrive as
          // Enter after Enter and the first line is submitted on its own. The same route
          // dictation takes, for the same reason.
          const insert = paneInsert.get(id)
          if (insert) insert(text)
          else api.write(id, text)
        })
      }
      setShelfPeek(false)
    },
    [flash]
  )

  // The floating overlay can only ask by id: it is a separate window with no idea which
  // pane is focused, and the focused pane is a fact only this one has.
  useEffect(() => {
    return api.onRecentToPane((id) => {
      const it = recentsRef.current.find((r) => r.id === id)
      if (it) sendRecent(it)
    })
  }, [sendRecent])

  // The overlay's magnifier. Main has already raised this window by the time this lands -
  // a press on that button is a person asking for the app, which is the one kind of
  // reason allowed to take the screen.
  useEffect(() => api.onStashSearch(() => setShelfSearching(true)), [])

  /**
   * Dictation goes into the pane whose mic was clicked - the hotkey means the focused one -
   * and stops short of pressing Enter: a misheard word should be fixable before the agent
   * acts on it.
   *
   * It is inserted as a paste rather than written to the pty. Every agent here runs a TUI
   * with bracketed paste on, and that is the difference between one insertion the TUI puts
   * in its prompt box and a burst of characters it is free to read as keystrokes - which is
   * why this worked in a shell and not in the agents it was built for.
   */
  const voice = useVoice(
    useCallback(
      (text: string, target: string) => {
        const id = target || activeRef.current
        if (!id) return flash('Nothing focused - open a pane first.')
        const insert = paneInsert.get(id)
        if (insert) insert(text)
        else api.write(id, text)
      },
      [flash]
    ),
    {
      model: config?.voice.model ?? 'base',
      language: config?.voice.language ?? 'auto',
      engine: config?.voice.engine ?? 'auto'
    }
  )

  // The same hook the terminal panes use for probes: dictation cannot be driven by a
  // keystroke from outside the window, so this is how scripts/voice-test.mjs starts a
  // clip with a fake microphone and reads back what came out of the real path.
  useEffect(() => {
    const dbg = window as unknown as { __pfVoice?: unknown }
    dbg.__pfVoice = voice
  }, [voice])

  useEffect(() => {
    if (voice.error) flash(voice.error)
  }, [voice.error, flash])

  // A phone is not a small desktop. `pointer: coarse` catches a real touch screen and
  // the width catches a narrow window, which is also the only way to see this on a
  // desktop before the served renderer (B2) exists.
  const [smallScreen, setSmallScreen] = useState(
    () => matchMedia('(pointer: coarse), (max-width: 720px)').matches
  )
  useEffect(() => {
    const mq = matchMedia('(pointer: coarse), (max-width: 720px)')
    const on = (): void => setSmallScreen(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const bigVoice = voice.phase !== 'idle' && (smallScreen || voice.progress >= 0)

  const voiceWhere = useMemo(() => {
    const id = voice.target || activeId
    const i = sessions.findIndex((s) => s.id === id)
    if (i < 0) return 'Dictating'
    const s = sessions[i]
    return `Into ${describePlace({ cwd: s.cwd, lane: s.lane, pane: i + 1 }).full}`
  }, [voice.target, activeId, sessions])

  // Declared up here rather than beside the trim effect that also reads it: the launch
  // path below has to know whether this machine is full BEFORE it starts anything.
  const [capacity, setCapacity] = useState<Verdict | null>(null)
  /**
   * The memory notice on screen right now, or null - see the card in the JSX below.
   *
   * Armed by the verdict CHANGING into something worth saying, never by it being true:
   * `capacity` is recomputed every few seconds and a card that re-armed on each reading
   * would be the permanent strip again with an animation. `capacityShown` is the identity
   * of the thing already said, cleared when the desk goes back to ok, so a machine that
   * recovers and fills up again says so a second time.
   */
  const [capacityNote, setCapacityNote] = useState<
    {
      level: Verdict['level']
      advice: string
      numbers: string
      /**
       * The one pane worth moving, resolved a beat after the card arrives.
       *
       * Robert, 2026-08-26: the card told him the machine was tight and left him to work
       * out which of eleven panes to do something about - the half of the reading nobody
       * has. `suggestMove` names it and names the machine, so the card carries the move as
       * a press. Absent until the peers answer, and absent for good when nothing may go:
       * no paired device, nothing movable, or the only candidate is Mac-only work.
       */
      move?: { id: string; pane: string; deviceName: string; project: string }
    } | null
  >(null)
  const capacityShown = useRef('')
  const capacityTimer = useRef<number | undefined>(undefined)
  useEffect(() => api.onCapacity(setCapacity), [])

  /**
   * Since when nobody has been at this machine, or null while somebody is.
   *
   * A ref, not state: the only two things that read it are a minute timer and the closing
   * publisher, and re-rendering every pane because the mouse stopped moving would cost
   * more than the reading is worth. `publishClosingRef` is called on the change so the
   * cards' countdowns freeze at the same moment the sweep does - the two disagreeing is
   * the worst failure this feature has (see `idleCloseAt`).
   */
  const [awayAt, setAwayAt] = useState<number | null>(null)
  const awayRef = useRef<number | null>(null)
  awayRef.current = awayAt
  // Whether a person has been at THIS machine this run - see `Away.sawPerson`. It gates
  // the unread refusal in shared/reclaim.ts: on a desk nobody sits at, nothing is ever
  // read, so holding unread panes open would switch the idle clock off entirely.
  const [personHere, setPersonHere] = useState(false)
  const personRef = useRef(false)
  personRef.current = personHere
  useEffect(
    () =>
      api.onAway((a) => {
        setAwayAt(a.awaySince)
        setPersonHere(a.sawPerson)
      }),
    []
  )

  /**
   * Send what this machine cannot afford to a paired device, and hand back the rest.
   *
   * The capacity verdict has said "the paired device can take the next one" in the
   * sentence on screen since the feature landed, and nothing acted on it - so the advice
   * was a chore handed to the person at the exact moment the machine was too busy to be
   * pleasant to use. The decision itself is in shared/capacity.ts where it can be tested
   * without filling a real machine's RAM; this only does the asking and the telling.
   *
   * A pane that moved MUST say so. A session that appears on another machine without a
   * word is the same failure as one that never started: the person goes looking for it.
   */
  /**
   * The last answer to "start it over there?", while it still holds.
   *
   * A ref rather than state: nothing on screen reads it, and re-rendering the whole app
   * because a ten-minute window opened is work for nothing. It deliberately does not
   * outlive the window - a launch policy that survives a restart is a setting, and there
   * is one of those in Settings.
   */
  const offloadStick = useRef<OffloadStick | null>(null)
  /** The offload question currently on screen, so a second launch waits rather than
   * replacing its callbacks and stranding the first launch's promise for ever. */
  const offloadAsking = useRef<Promise<unknown> | null>(null)

  const offloadReqs = useCallback(
    async (reqs: StartSessionRequest[]): Promise<StartSessionRequest[]> => {
      if (!capacity?.offload || config?.offloadWhenFull === false) return reqs
      let candidates: OffloadCandidate[]
      try {
        const state = await api.remoteState()
        const online = state.peers.filter((p) => p.status === 'online')
        if (!online.length) return reqs
        candidates = await Promise.all(
          online.map(async (p) => ({
            device: p.id,
            deviceName: p.name,
            online: true,
            // What THAT machine calls its projects, and where they live over there.
            projects: await api.remoteProjects(p.id).catch(() => [] as { name: string; path: string }[])
          }))
        )
      } catch {
        // A peer that cannot be asked is a peer that cannot be used. Everything stays here.
        return reqs
      }
      // Pair every request with the device that could take it BEFORE anything is asked:
      // a question about a move that has nowhere to go is a question with one answer.
      const pairs = reqs.map((req) => ({
        req,
        target: offloadTarget(capacity, candidates, projectNameOf(req.cwd))
      }))
      const movable = pairs.filter((p) => p.target)
      if (!movable.length) return reqs
      // ONE device per question, and the question names it. A launch whose panes belong
      // to different projects can have two different peers offering, and a dialog saying
      // "Start 3 panes on Gamer-PC?" that then puts one of them on a second machine has
      // been answered about something the person was never shown. Panes for the other
      // device stay here; this machine being full is a poor reason to move a pane onto a
      // machine nobody agreed to.
      const device = movable[0].target?.device
      const forDevice = movable.filter((p) => p.target?.device === device)
      const plan = offloadPlan(
        movable[0].target,
        config?.offloadAsk !== false,
        offloadStick.current,
        Date.now()
      )
      if (plan === 'local') return reqs
      if (plan === 'ask') {
        // One question for the whole launch. Asked per pane, opening three panes at once
        // is three dialogs about the same machine being full.
        const name = movable[0].target?.deviceName ?? 'the paired device'
        const many = forDevice.length > 1 ? `${forDevice.length} panes` : 'this pane'
        // Two launches can be in flight - a second folder opened, or the command palette
        // run while this dialog is up - and `ask` holds ONE question. Without this the
        // second `setAsk` replaces the first dialog's callbacks, the first promise is
        // never resolved and that batch of panes never starts, silently. Whoever is
        // second waits for the answer and then re-reads the plan, which is usually a
        // remembered answer and no second dialog at all.
        while (offloadAsking.current) await offloadAsking.current.catch(() => undefined)
        const replan = offloadPlan(
          movable[0].target,
          config?.offloadAsk !== false,
          offloadStick.current,
          Date.now()
        )
        if (replan === 'local') return reqs
        let answered = { answer: 'remote' as 'remote' | 'local', remember: false }
        if (replan === 'ask') {
          const question = new Promise<{ answer: 'remote' | 'local'; remember: boolean }>(
            (resolve) => {
              setAsk({
                title: `Start ${many} on ${name}?`,
                body:
                  `This machine is out of memory - panes here hold about ${capacity.usedMb} MB ` +
                  `and another one costs about ${capacity.nextPaneMb} MB. ${name} has the same ` +
                  `project and can run it; you keep watching it from here. Keeping it here is ` +
                  `fine if this is the checkout you are working in - it will just be slower.`,
                confirmLabel: `Start on ${name}`,
                cancelLabel: 'Keep it here',
                check: { label: `Remember for ${Math.round(OFFLOAD_STICK_MS / 60000)} minutes` },
                onConfirm: (_v, checked) => {
                  setAsk(null)
                  resolve({ answer: 'remote', remember: checked })
                },
                onCancel: (checked) => resolve({ answer: 'local', remember: checked })
              })
            }
          )
          offloadAsking.current = question
          try {
            answered = await question
          } finally {
            offloadAsking.current = null
          }
          offloadStick.current = answered.remember
            ? stickFor(answered.answer, device ?? '', Date.now())
            : null
        }
        if (answered.answer === 'local') return reqs
      }
      const local: StartSessionRequest[] = []
      const sent: string[] = []
      for (const { req, target } of pairs) {
        if (!target || target.device !== device) {
          local.push(req)
          continue
        }
        try {
          await api.startRemote(target.device, { ...req, cwd: target.cwd })
          sent.push(target.deviceName)
        } catch (e) {
          // The remote start is the one that may fail for reasons this machine cannot see.
          // Falling back to local is always safe: it is what would have happened anyway -
          // but it must SAY so. The far end refuses an agent it has never heard of (an
          // older build over there), and silently opening a different agent here is how a
          // pane asked to run Antigravity came back running Claude Code with nothing on
          // screen to explain it.
          const why = String((e as Error)?.message ?? '').replace(/^Error:\s*/, '')
          if (why) flash(`${target.deviceName}: ${why} Opening it here instead.`)
          local.push(req)
        }
      }
      if (sent.length) {
        const names = [...new Set(sent)].join(', ')
        flash(
          `This machine is full - started ${sent.length} pane${sent.length === 1 ? '' : 's'} on ${names}.`
        )
      }
      return local
    },
    [capacity, config, flash]
  )

  const start = useCallback(
    async (reqs: StartSessionRequest[]) => {
      setPicking(false)
      const wanted = reqs
      reqs = await offloadReqs(reqs)
      if (!reqs.length) {
        // Everything went to a peer. Still remember the model, or the next launch forgets
        // what was picked purely because the machine happened to be busy.
        rememberModel(wanted[0]?.agent, wanted[0]?.model)
        return
      }
      const started = await api.startSessions(reqs)
      if (started.length) setActiveId(started[started.length - 1].id)
      if (started.length < reqs.length) {
        // Name it. "Some folders could not be opened" was true and unusable: the one thing
        // somebody needs is WHICH, and on this desk the answer is nearly always a folder
        // that has been deleted since - a temp folder from a test, or a swept lane.
        // Counted, not matched: a launch that lands in a lane comes back with a DIFFERENT
        // cwd (the worktree), so pairing requests to results by folder would report a pane
        // that opened perfectly as a failure. With one request there is nothing to pair.
        const missed = reqs.length - started.length
        flash(
          reqs.length === 1
            ? `Could not open ${reqs[0].cwd} - it may not be on this machine any more.`
            : `${missed} of ${reqs.length} folders could not be opened.`
        )
      }
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
    [flash, rememberModel, offloadReqs]
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
   * The end of a day's work in one click, next to the count it empties. Same prompt the
   * palette's "close all" puts up - one button and one command must not disagree about
   * how dangerous the same thing is.
   */
  const closeAll = useCallback(() => {
    if (!sessions.length) return
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
  }, [sessions])

  /**
   * Wipe the agent's context without ending the run - the /clear you would have typed,
   * typed for you. Written to the pty rather than pasted: a paste lands in the prompt box
   * as text and then waits for Enter, and not having to press it is the whole point.
   * The Enter is a beat late on purpose, so the CLI's slash menu has settled on /clear
   * before the key that accepts it arrives. A plain shell has no slash commands.
   */
  /**
   * Type a command into a pane's TUI and press Enter once it has actually arrived.
   *
   * This used to be two `setTimeout`s, at 320ms and 680ms. Those numbers were measured, and
   * they were measured on an idle machine - which is the one state a person never files a
   * bug from. On a box under real load (measured here at load average 131, 20 GB into swap)
   * Claude Code needs well past 360ms to draw its slash menu, so the Enter landed before the
   * menu existed: no popup, "/clear" left sitting in the box, and the pane keeping the
   * context it was asked to drop. A fixed delay cannot be right for both machines, so this
   * waits for the thing it was really waiting for - the command showing up on screen.
   *
   * The deadline is a backstop, not a schedule: if the echo never appears we still send
   * Enter (typing a command and abandoning it half-entered is worse than being early) but
   * we say so instead of reporting a clear that may not have happened.
   */
  const typeAndSubmit = useCallback(
    async (s: Session, cmd: string, say: (m: string) => void): Promise<void> => {
      const seen = (): boolean => {
        const t = paneTerms.get(s.id)
        if (!t) return false
        const b = t.buffer.active
        // Only the rows around the cursor: `/clear` scrolled up from an earlier turn is not
        // evidence that this one has been typed.
        const bottom = b.baseY + t.rows - 1
        for (let y = Math.max(0, b.baseY + b.cursorY - 2); y <= bottom; y++) {
          if (b.getLine(y)?.translateToString(true).includes(cmd)) return true
        }
        return false
      }
      const until = async (ok: () => boolean, deadlineMs: number): Promise<boolean> => {
        const stop = Date.now() + deadlineMs
        while (Date.now() < stop) {
          if (ok()) return true
          await new Promise((r) => window.setTimeout(r, 40))
        }
        return ok()
      }
      // The wipe has already been written. Give the box a frame to come back empty before
      // typing over it, or the first characters race the erase.
      await new Promise((r) => window.setTimeout(r, 60))
      api.write(s.id, cmd)
      const echoed = await until(seen, 5000)
      api.write(s.id, '\r')
      if (!echoed) {
        say(`${s.title}: sent ${cmd}, but the pane never showed it - check that pane.`)
        return
      }
      say(`${s.title}: cleared.`)
    },
    []
  )

  const clearPane = useCallback(
    (s: Session) => {
      const shell = s.agent === 'shell'
      const cmd = shell ? 'clear' : '/clear'
      // Empty the prompt box first, or a half-typed line ends up with /clear stuck on
      // the end of it and the whole mess submitted. Which key does that is not the same
      // in both, and sending both is worse than either: Escape empties PowerShell's line
      // but leaves Claude Code's box alone, Ctrl-U empties Claude Code's box (offered
      // back on Ctrl-Y) but arrives at a PowerShell prompt as a literal character that
      // turns the command into one it cannot find. One key each, both measured.
      //
      // One Ctrl-U is not enough, though, and that was the bug: measured against a real
      // Claude Code REPL, it empties a ONE-LINE box and leaves every earlier line of a
      // shift+Enter draft exactly where it was. "/clear" then landed on the end of line
      // one and the whole draft went to the model as a prompt - the run kept its context
      // and burned a turn saying so. The wipe is a loop now: Ctrl-K takes whatever the
      // cursor is sitting in front of, Ctrl-U the head behind it, Backspace joins the
      // emptied line to the one above. One round per line walks a draft of any shape
      // back to nothing, and a round that runs past the top is three no-ops on an empty
      // box - so overshooting is free and undershooting is the bug.
      const draft = paneDraft.get(s.id)
      // A draft the reconstruction has lost track of gets the flat budget rather than a
      // count derived from text already known to be wrong.
      const lines = draft?.certain && draft.text ? draft.text.split('\n').length : 0
      const rounds = Math.min(24, Math.max(4, lines + 2))
      const wipe = shell ? '\x1b' : '\x0b\x15\x7f'.repeat(rounds)
      // The pane keeps its screen off the keystrokes it relays, and these are not
      // keystrokes - so it is told directly, before a byte goes out. Without this the
      // button cleared the pane and took the conversation off the screen with it, which is
      // the half of the /clear report that survived every fix to the byte stream.
      paneArmClear.get(s.id)?.()
      api.write(s.id, wipe)
      void typeAndSubmit(s, cmd, flash)
    },
    [flash, typeAndSubmit]
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
      // ...and the scrollback, which no repaint can reach. Fix is the one thing anybody
      // presses when a pane looks wrong, and until this it could only fix the live frame -
      // mis-widthed history stayed broken however many times it was pressed.
      const redraw = paneRedraw.get(target)
      if (!redraw) return flash('Display repaired.')
      void redraw().then((did) => flash(did ? 'Display and history repaired.' : 'Display repaired.'))
    },
    [flash]
  )

  /** Copy readable terminal text, including scrollback no longer on screen. */
  const copyPaneOutput = useCallback(
    (session: Session) => {
      void api.getBuffer(session.id).then((raw) => {
        // xterm has already interpreted cursor movement, colours and redraw traffic. Its
        // buffer is therefore the copy a person expects, unlike raw pty bytes. A pane
        // can briefly be unmounted during a layout change, in which case stripping the
        // raw stream still leaves a useful, safe fallback.
        const terminal = paneTerms.get(session.id)
        const text = terminal
          ? Array.from({ length: terminal.buffer.active.length }, (_, i) => {
              const line = terminal.buffer.active.getLine(i)
              // xterm marks the *following* row as wrapped. That is the row which
              // decides whether this one gets a newline: using this row's flag splits
              // one long logical line and joins it to the next one.
              const next = terminal.buffer.active.getLine(i + 1)
              return (line?.translateToString(true) ?? '') + (next?.isWrapped ? '' : '\n')
            })
              .join('')
              .trimEnd()
          : stripAnsi(raw).trimEnd()
        if (!text) return flash(`${session.title} has no output to copy yet.`)
        api.copyText(text)
        flash(`Copied ${session.title}'s output.`)
      })
    },
    [flash]
  )

  const grid = config?.grid ?? false

  /**
   * One pane made full-window for a minute, without disturbing the grid.
   *
   * Ctrl G already toggles the whole grid, but coming back from it re-lays every pane out
   * and lands on whatever was focused - so "let me read this one properly" cost the
   * arrangement. A zoom is remembered as a session id and nothing else changes: the grid
   * setting, the sizes and the order are all exactly where they were when it ends.
   *
   * Only meaningful inside the grid, and dropped by itself when that pane closes - a
   * zoom pointing at a session that is gone would be a window showing nothing.
   */
  const [zoomId, setZoomId] = useState<string | null>(null)
  const zoom = grid && zoomId && sessions.some((s) => s.id === zoomId) ? zoomId : null
  useEffect(() => {
    if (zoomId && !sessions.some((s) => s.id === zoomId)) setZoomId(null)
  }, [zoomId, sessions])
  // A zoomed pane is drawn by the same path as focus mode - one pane, absolutely
  // positioned over the whole area - so it needs no layout of its own.
  const tiled = grid && !zoom

  const visibleIds = useMemo(
    () =>
      new Set(
        zoom
          ? [zoom]
          : grid
            ? sessions.map((s) => s.id)
            : sessions.filter((s) => s.id === activeId).map((s) => s.id)
      ),
    [grid, zoom, sessions, activeId]
  )

  /**
   * Tell main which panes are on screen, so output for the others is gathered for
   * longer before it is sent (dataPump.ts). Only this side knows: a pane stays
   * mounted for its whole life, so nothing in main can tell a pane being read from
   * one behind a tab. A hint only - see `paneVisibility`.
   *
   * Re-stated on a timer as well as on every change, because the claim expires on
   * the other side - which is what makes a phone that was closed, locked or carried
   * out of range stop counting without ever having to say goodbye. Nothing is sent
   * before there is a pane to talk about: an empty claim at mount would mark the
   * whole desk hidden for the moment before the session list arrives.
   */
  const clientId = useRef(`c${Math.random().toString(36).slice(2)}`)
  useEffect(() => {
    if (!sessions.length) return
    const say = (): void => window.api.paneVisibility(clientId.current, [...visibleIds], viewerName())
    say()
    const t = setInterval(say, VISIBILITY_REFRESH_MS)
    return () => clearInterval(t)
  }, [visibleIds, sessions.length])

  /**
   * Giving back scrollback when the machine has run out of memory.
   *
   * Every pane stays mounted for as long as it exists (see the grid below), which is what
   * makes tab switching instant and is also what makes a full desk expensive: measured
   * 2026-08-14 with @xterm/headless, a pane holding the shipped 20000 lines costs 7.2 MB
   * of heap and the growth is linear - 91 MB across twelve panes. Small next to the
   * ~190 MB agent behind each pane, which is why this is the SECOND thing that happens
   * under pressure and never the first, but it is the part the app can give back
   * instantly and without killing anything.
   *
   * The pane being read is never trimmed, at any pressure. Scrollback is the record of
   * what an agent did, and quietly shortening the one somebody is looking at would
   * destroy that with no undo and no message. Off-screen panes go first; a visible but
   * unfocused pane only once the kernel says critical.
   */
  /**
   * What each pane is really costing, four seconds at a time (src/shared/usage.ts).
   *
   * Asked for once as well as subscribed to: the push only fires on the next sample, so a
   * window that just opened would draw no figures for a few seconds and read as "nothing
   * is running" rather than "not measured yet".
   */
  const [usage, setUsage] = useState<UsageReport | null>(null)

  /**
   * Put the memory notice on screen when the reading BECOMES worth saying, and take it
   * away again a few seconds later. `usage` is read here rather than in the card so the
   * figure is the one that was true when the card armed - a number that goes on moving
   * inside a card nobody is looking at is a second reading, not the one being reported.
   */
  useEffect(() => {
    if (!capacity || capacity.level === 'ok' || !capacity.say) {
      capacityShown.current = ''
      return
    }
    const key = `${capacity.level}|${capacity.why}`
    if (capacityShown.current === key) return
    capacityShown.current = key
    const u = usageRef.current
    const numbers = u && u.totalMb > 0
      ? `${formatMb(u.totalMb)} in ${sessionsRef.current.length} pane` +
        `${sessionsRef.current.length === 1 ? '' : 's'} plus PaneForge itself, of ` +
        `${formatMb(u.machineMb)} on this machine` +
        (u.cpuPct === null ? '' : ` - ${u.cpuPct}% of one CPU core`)
      : ''
    setCapacityNote({ level: capacity.level, advice: capacity.advice, numbers })
    window.clearTimeout(capacityTimer.current)
    capacityTimer.current = window.setTimeout(() => setCapacityNote(null), CAPACITY_NOTE_MS)
    // ...and which pane, and where. Asked here rather than on a timer: the peers have to be
    // asked over the link and their project lists fetched, which is the reason this is not
    // computed in the same tick as the card. `key` is re-checked on the way back so a slow
    // answer cannot land on a card about a different reading, and a card the reader has
    // already dismissed takes the answer with it (`prev` is null).
    void (async () => {
      try {
        const state = await api.remoteState()
        const online = state.peers.filter((p) => p.status === 'online')
        if (!online.length) return
        const candidates = await Promise.all(
          online.map(async (p) => ({
            device: p.id,
            deviceName: p.name,
            online: true,
            projects: await api
              .remoteProjects(p.id)
              .catch(() => [] as { name: string; path: string }[])
          }))
        )
        const pick = suggestMove(
          handoffPanesRef.current(),
          candidates,
          configRef.current?.autoHandoff ?? DEFAULT_AUTO_HANDOFF,
          handoffBlocked.current,
          Date.now()
        )
        if (!pick) return
        if (capacityShown.current !== key) return
        const project = projectNameOf(sessionsRef.current.find((x) => x.id === pick.id)?.cwd ?? '')
        setCapacityNote((prev) =>
          prev
            ? {
                ...prev,
                move: {
                  id: pick.id,
                  pane: paneWordRef.current(pick.id),
                  deviceName: pick.deviceName,
                  project
                }
              }
            : prev
        )
      } catch {
        /* a peer that cannot be asked is one that cannot be offered - the card stands alone */
      }
    })()
  }, [capacity])
  /**
   * What the ladder did on its own, for the mascot to say. It is a fact with a timestamp
   * rather than a message queue: the mascot keys off `at`, so the same sweep is announced
   * once however often this component re-renders.
   */
  const [acted, setActed] = useState<
    | { what: 'closed' | 'moved' | 'trimmed'; panes: ActedPane[]; mb?: number; at: number; where?: string }
    | undefined
  >(undefined)
  /**
   * How a sweep asks for panes to be closed.
   *
   * It is a ref rather than a callback because the machinery behind it (the countdown, the
   * "keep it open" holds, the mascot's own switch) is declared further down beside the rest
   * of the mascot's props, and a sweep is an effect whose dependency list is evaluated at
   * render. Through a ref there is no ordering to get wrong and no dependency to forget.
   *
   * Neither sweep kills a pane itself any more. They used to, into a `console.info` in a
   * devtools window nobody has open, which is why "I have never seen an idle pane close"
   * was true even on a desk where the clock was doing its job.
   */
  const armCloseRef = useRef<(plan: Reclaim[], why: 'idle' | 'pressure', log: string) => void>(() => {})
  /**
   * The same, for the rung above closing: moving a pane to another machine.
   *
   * Both handoff sweeps used to move panes into a `console.info`, so a pane could leave
   * this desk with nothing on screen saying so - while a CLOSE, the more recoverable of
   * the two, counted down and could be stopped. A ref for the same reason `armCloseRef`
   * is one: the sweeps are effects, and the countdown state lives further down beside the
   * mascot's own props.
   */
  const armMoveRef = useRef<(plan: AutoHandoff[], why: string, cooldownMinutes: number) => void>(
    () => {}
  )
  useEffect(() => {
    void api.usage().then((u) => u && setUsage(u))
    return api.onUsage(setUsage)
  }, [])

  /**
   * The depth each pane is on, BY PANE.
   *
   * One number for the whole desk could not describe a plan that carries two of them, and
   * every plan under pressure does: the focused pane is restored in the same pass that
   * trims the rest. See `PaneRef.current`.
   */
  const depths = useRef(new Map<string, number>())
  /**
   * When the verdict last BECAME one that trims - the stamp `TRIM_SETTLE_MS` is measured
   * from. The shape, not the object: `assess` returns a fresh Verdict on every sample, and
   * what decides a pane's target is the trim flag together with the level (a VISIBLE pane
   * is kept full at `tight` and trimmed at `over`).
   */
  const trimShape = useRef<{ key: string; since: number }>({ key: '', since: 0 })
  /** Re-runs the sweep once a suppressed trim has settled. Nothing else reads it. */
  const [settleTick, setSettleTick] = useState(0)
  useEffect(() => {
    if (!capacity) return
    const now = Date.now()
    const key = capacity.trim ? `trim:${capacity.level}` : 'off'
    if (key !== trimShape.current.key) trimShape.current = { key, since: now }
    const refs = sessions.map((s) => ({
      id: s.id,
      focused: s.id === activeId,
      visible: visibleIds.has(s.id),
      current: depths.current.get(s.id) ?? FULL_SCROLLBACK,
      // The same focus reading the idle clock uses - see `ReclaimPane.lastFocus`.
      lastFocus: focusLeftAt.current[s.id]
    }))
    for (const id of depths.current.keys()) if (!sessions.some((s) => s.id === id)) depths.current.delete(id)
    const trims = trimPlan(refs, capacity, FULL_SCROLLBACK, {
      now,
      trimmingSince: trimShape.current.since
    })
    if (!trims.length) {
      // A trim held back by the settle window has to be re-asked for, or a desk that has
      // been quiet since the verdict changed never trims at all.
      if (capacity.trim && now - trimShape.current.since < TRIM_SETTLE_MS) {
        const t = setTimeout(
          () => setSettleTick((n) => n + 1),
          TRIM_SETTLE_MS - (now - trimShape.current.since) + 50
        )
        return () => clearTimeout(t)
      }
      return
    }
    let applied = 0
    const regrown: string[] = []
    for (const t of trims) {
      const term = paneTerms.get(t.id)
      // A pane whose terminal has not been created yet gets the depth when it is: the
      // constructor reads the same FULL_SCROLLBACK, and the next change re-plans anyway.
      if (!term) continue
      const was = depths.current.get(t.id) ?? FULL_SCROLLBACK
      term.options.scrollback = t.scrollback
      depths.current.set(t.id, t.scrollback)
      if (t.scrollback > was) regrown.push(t.id)
      applied++
    }
    /**
     * Raising the number back does NOT bring the lines back.
     *
     * Measured against a real headless xterm, 501 lines at depth 20000: lowering the option
     * to 200 leaves 210 lines and the first one reads `line 291`, and putting 20000 back
     * leaves the buffer exactly as short. xterm DISCARDS on the way down, so a trim is not
     * a cap - it is a delete, and this ladder was doing it to every pane nobody was looking
     * at. Robert, 2026-08-27: "i cant scroll up and see the history of the chat".
     *
     * The bytes are still in main (`main/history.ts` keeps every pane's raw output), and
     * `redrawHistory` is the path that re-renders a pane from them - so a pane that grows
     * back is re-rendered rather than merely permitted to be tall.
     *
     * The focused pane is in this list too, and skipping it was the other half of the same
     * bug. A focused pane is never trimmed, so it can only be HERE if its lines were
     * deleted while it was in the background - which is exactly the pane somebody has just
     * switched to and is about to scroll up in. Measured 2026-08-28 on this desk: load
     * 2.51-3.17 per core pins `assess` at `over` for hours, so every unfocused pane sits
     * at TRIMMED_SCROLLBACK, and the pane you switch to got its option back and none of
     * its lines. Nothing is repainted under a reader by this: the redraw runs on the
     * transition, and a pane already at full depth never appears in `regrown` again.
     */
    for (const id of regrown) void paneRedraw.get(id)?.()
    if (applied) {
      console.info(
        `capacity: ${capacity.level}, trimmed ${applied} pane(s), freed ~${savingMb(trims)} MB` +
          (regrown.length ? `, ${regrown.length} re-rendered from history` : '')
      )
    }
  }, [capacity, sessions, activeId, visibleIds, settleTick])

  /**
   * And giving back the part that scrollback never could: the agent.
   *
   * Trimming twelve panes on this desk returned ~74 MB of the ~1.5 GB they were holding,
   * because the cost is the CLI inside the pane (~190 MB each) and not the pane. The only
   * way to return one is to close it, which every terminal refuses to do for a good reason
   * - except that closing a pane HERE keeps its History row, its `resumeId` and its
   * `scrollbackId`, so reopening restores the conversation and the screen. That is what
   * makes this defensible, and `shared/reclaim.ts` holds every refusal that keeps it timid:
   * pressure is the trigger, never a clock, and a pane waiting on a person is never touched.
   *
   * Runs beside the trim rather than inside it: they answer to the same reading but they
   * are not the same promise, and the trim must keep working if this is switched off.
   */
  /**
   * ...and the rung ABOVE closing: move the pane to the machine that has room.
   *
   * Same reading, same refusals, one better answer. `reclaim` gives the memory back by
   * ending the work; a handoff gives the memory back and the work carries on over there,
   * with its conversation, its branch and its screen. So this runs first and marks what it
   * takes (`handingOff`), which is the flag the sweep below refuses to close.
   *
   * The peers are asked only once something is actually eligible: `remoteProjects` is a
   * round trip per device over the link, and a machine under memory pressure is the last
   * place to spend one finding out there was nothing to move.
   */
  const handoffBlocked = useRef<Record<string, number>>({})
  const handoffSweeping = useRef(false)

  /**
   * Which folders' code could reach another machine, keyed by folder.
   *
   * A checkout with no origin remote, or one outside the projects root, has no way to
   * arrive over there - and until this was asked FIRST, that was discovered by attempting
   * the move: the pane was picked, a machine was named, fifteen seconds were counted down
   * at somebody, and the only outcome available was a failure and a cooldown.
   *
   * A ref rather than state: it is read inside the sweeps' intervals, and a state update
   * every minute would re-arm the timers built on them. A folder with no answer yet is
   * `undefined`, which does not refuse - the first answer lands within a minute, and the
   * cost of refusing on silence is the whole ladder switched off on a slow first read.
   */
  const shareableRef = useRef<Record<string, boolean>>({})
  // The folders on the desk, as one string: this must re-ask when a pane opens in a repo
  // nobody has asked about, and must NOT re-ask on every byte a pane prints.
  const localCwdsKey = useMemo(
    () => [...new Set(sessions.filter((s) => !s.remote && s.cwd).map((s) => s.cwd))].sort().join('\u0000'),
    [sessions]
  )
  useEffect(() => {
    let live = true
    const ask = (): void => {
      const cwds = [...new Set(sessionsRef.current.filter((s) => !s.remote && s.cwd).map((s) => s.cwd))]
      if (!cwds.length) return
      void api
        .handoffReady(cwds)
        .then((map) => {
          if (live) shareableRef.current = { ...shareableRef.current, ...map }
        })
        .catch(() => {
          /* an older main, or a git that did not answer: leave every folder unmeasured */
        })
    }
    ask()
    // Main caches each folder for five minutes, so this is a cheap re-ask that mostly
    // exists to pick up a repo that has just been given a remote.
    const t = setInterval(ask, 60_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [localCwdsKey])

  /**
   * What every pane looks like to both sweeps. Read fresh through `sessionsRef` rather
   * than closed over: these run on a timer, and a desk that is full and quiet emits no
   * session events at all.
   */
  // Through a ref, so `handoffPanes` is stable. It is read inside two intervals, and a
  // callback that changes identity whenever the grid is toggled re-arms the timer built on
  // it - the clock sweep does not consult `visible` at all, so that would be a 60s counter
  // reset by something it has no opinion about.
  const visibleRef = useRef(visibleIds)
  visibleRef.current = visibleIds
  // The sampler's own figures, through a ref for the same reason as `visibleRef`: the
  // sweeps live inside intervals, and a callback that changes identity every four seconds
  // would re-arm the 60s timer built on it and it would never fire.
  const usageRef = useRef<UsageReport | null>(null)
  usageRef.current = usage
  // Read from the pressure card's async suggestion, which is created in an effect that ran
  // long before this callback existed on that render.
  const handoffPanesRef = useRef<() => AutoPane[]>(() => [])
  const handoffPanes = useCallback(
    (): AutoPane[] =>
      sessionsRef.current.map((s) => ({
        id: s.id,
        state: fleetState(s),
        lastKeyboard: s.lastKeyboard,
        lastOutput: s.lastOutput,
        // Looking at a pane is using it, for a move exactly as for a close.
        lastFocus: focusLeftAt.current[s.id],
        focused: s.id === activeRef.current,
        visible: visibleRef.current.has(s.id),
        remote: !!s.remote,
        handingOff: !!s.handingOff,
        // A live question is drawn on a screen and lives in no transcript: resuming over
        // there comes back with the question gone and nobody asked. Never moved.
        asking: !!s.ask || !!s.bell,
        // Only the budget rule reads this, and only to pick a busy pane LAST. When one is
        // picked, main queues it and moves it the moment the turn ends.
        busy: s.runSince !== undefined,
        // The device that handed it here, so the budget never hands it straight back.
        arrivedFrom: s.arrivedFrom,
        projectName: projectNameOf(s.cwd),
        // What it is actually costing. `undefined` when the sampler has no answer - it
        // does not read the process table behind a hidden window - and `expensive` reads
        // that as small, so an unmeasured pane is never moved for a number nobody took.
        memMb: usageRef.current?.panes[s.id]?.rssMb,
        cpuPct: usageRef.current?.panes[s.id]?.cpuPct ?? undefined,
        // A shell pane's live command (`shared/paneJob.ts`): a dev server that has just
        // started holds nothing yet and is still the pane worth moving.
        job: s.job,
        // ...and what an agent left running, which is the opposite: never move it, because
        // the move kills the pty and the work with it. See `AutoPane.backJob`.
        backJob: usageRef.current?.panes[s.id]?.jobs?.[0]?.label,
        // ...and what could not follow it AT ALL: a browser being driven on this desk.
        // See `AutoPane.machineBound`.
        machineBound: usageRef.current?.panes[s.id]?.bound,
        // Whether the code could get there. `undefined` until the first answer for that
        // folder lands, and undefined does not refuse - see `AutoPane.shareable`.
        shareable: shareableRef.current[s.cwd]
      })),
    []
  )
  handoffPanesRef.current = handoffPanes

  /**
   * Ask the peers, run `make` against them, and carry out whatever it returns.
   *
   * The peers are asked only once something is actually eligible - `remoteProjects` is a
   * round trip per device over the link, and a machine under memory pressure is the last
   * place to spend one finding out there was nothing to move. Both sweeps share the one
   * `handoffSweeping` guard, so the pressure sweep and the clock can never both be moving
   * the same pane.
   */
  const runHandoffs = useCallback(
    (
      panes: AutoPane[],
      make: (candidates: OffloadCandidate[], now: number) => AutoHandoff[],
      why: string,
      cooldownMinutes: number
    ) => {
      if (handoffSweeping.current) return
      handoffSweeping.current = true
      // Prune here rather than only after a failure. The cooldown map is written when a
      // move is refused and was swept in the same branch, so one failure on a desk that
      // then runs for weeks without another left its entry for ever - harmless (it is only
      // read through `> now`) and still a map that only grows.
      for (const [id, until] of Object.entries(handoffBlocked.current)) {
        if (until <= Date.now()) delete handoffBlocked.current[id]
      }
      // Set once a countdown is armed: from there the sweep lock belongs to the countdown,
      // and is given back when the move runs, is refused, or is called off.
      let armed = false
      void (async () => {
        try {
          const state = await api.remoteState()
          const online = state.peers.filter((p) => p.status === 'online')
          if (!online.length) return
          const candidates = await Promise.all(
            online.map(async (p) => ({
              device: p.id,
              deviceName: p.name,
              online: true,
              projects: await api
                .remoteProjects(p.id)
                .catch(() => [] as { name: string; path: string }[])
            }))
          )
          const plan = make(candidates, Date.now())
          if (!plan.length) return
          // Nothing moves silently. The loop that used to run the moves here is `doMove`
          // now, behind the same countdown a close gets: named pane, named machine, and
          // `Keep it here` on it.
          armed = true
          armMoveRef.current(plan, why, cooldownMinutes)
        } catch {
          /* a peer that cannot be asked is a peer that cannot be used - the sweeps below still run */
        } finally {
          if (!armed) handoffSweeping.current = false
        }
      })()
    },
    []
  )

  const sweepHandoff = useCallback(() => {
    const cfg = config?.autoHandoff ?? DEFAULT_AUTO_HANDOFF
    if (!capacity || !cfg.enabled) return
    // Past the budget the desk has already said where these panes belong, so this runs at
    // `ok` too - and it is then the only sweep that will, since both of the others are
    // readings about a machine in trouble.
    const over = Math.max(0, capacity.over ?? 0)
    if (!over && capacity.level === 'ok') return
    const now = Date.now()
    const panes = handoffPanes()
    // The same eligibility the plan applies, asked here first so the peers are not called
    // over the link to find out there was nothing to move. Two shapes, because the budget
    // rule drops the idle wait and the on-screen refusal and takes busy panes as well.
    const worthAsking = panes.some((p) => {
      if (p.focused || p.remote || p.handingOff) return false
      if ((handoffBlocked.current[p.id] ?? 0) > now) return false
      if (over) return handoffQueueable(p)
      return (
        !p.visible &&
        handoffMovable(p) &&
        now - quietSince(p) >= Math.max(0, cfg.minIdleMinutes) * 60_000
      )
    })
    if (!worthAsking) return
    runHandoffs(
      panes,
      (candidates, at) => autoHandoffPlan(panes, capacity, candidates, cfg, handoffBlocked.current, at),
      over ? `budget: ${over} pane(s) past ${cfg.keepLocal}` : `capacity: ${capacity.level}`,
      cfg.cooldownMinutes
    )
  }, [capacity, handoffPanes, runHandoffs, config?.autoHandoff])

  // Twice: on a reading changing, and on a clock. A desk that is full and quiet emits no
  // session events at all - which is exactly the desk this exists for, and the one a
  // change-driven effect would never sweep.
  useEffect(() => {
    sweepHandoff()
    const timer = window.setInterval(sweepHandoff, 60_000)
    return () => window.clearInterval(timer)
    // Deliberately NOT `sessions`: that changes on every byte a pane prints, and an
    // interval re-armed on every change is an interval that never fires. The reading
    // (`capacity`) re-arms it, and everything else is read fresh through `sessionsRef`.
  }, [sweepHandoff])

  /**
   * The same move on a clock, and the only sweep that can fire on a single-window desk.
   *
   * The one above refuses anything `visible`, which with the grid on is every pane - so on
   * the desk that is actually lagging its eligible list is always empty. This is the opt-in
   * answer to that (`autoHandoff.offloadIdleMinutes`, 0 = off), and it mirrors
   * `reclaim.idleCloseMinutes` exactly: its own minute timer, because the thing it watches
   * is time passing and nothing about a quiet pane changes to announce it.
   */
  const handoffCfgRef = useRef(DEFAULT_AUTO_HANDOFF)
  handoffCfgRef.current = config?.autoHandoff ?? DEFAULT_AUTO_HANDOFF
  const offloadOn = (config?.autoHandoff?.enabled ?? true) ? offloadMinutes(handoffCfgRef.current) : 0
  useEffect(() => {
    if (!offloadOn) return
    const sweep = (): void => {
      // Read through the ref, never through a dependency. Every config broadcast from main
      // is a fresh object - a setting anywhere in the dialog gives `config.autoHandoff` a
      // new identity - and an interval re-armed on each of those is an interval that never
      // reaches 60s. Only the two numbers this effect actually branches on are dependencies.
      const cfg = handoffCfgRef.current
      const minutes = offloadMinutes(cfg)
      if (!cfg.enabled || !minutes) return
      // The same frozen clock the idle CLOSE reads. This sweep mirrors `idleClosePlan`
      // deliberately (see shared/autoHandoff.ts), and the two reading different clocks is
      // the same bug in a quieter place: a pane moved to the other machine while somebody
      // was making coffee is a pane that vanished off this desk for the same reason.
      const now = deskNow(Date.now(), awayRef.current)
      const panes = handoffPanes()
      const worthAsking = panes.some(
        (p) =>
          !p.focused &&
          !p.remote &&
          !p.handingOff &&
          handoffMovable(p) &&
          now - quietSince(p) >= minutes * 60_000 &&
          !((handoffBlocked.current[p.id] ?? 0) > now)
      )
      if (!worthAsking) return
      runHandoffs(
        panes,
        (candidates, at) => idleOffloadPlan(panes, candidates, cfg, handoffBlocked.current, at),
        `idle-offload: quiet ${minutes} min`,
        cfg.cooldownMinutes
      )
    }
    const timer = window.setInterval(sweep, 60_000)
    return () => window.clearInterval(timer)
  }, [handoffPanes, runHandoffs, offloadOn])

  useEffect(() => {
    if (!capacity) return
    const cfg = config?.reclaim ?? DEFAULT_RECLAIM
    const plan = reclaimPlan(
      sessions.map((s) => ({
        id: s.id,
        state: fleetState(s),
        lastKeyboard: s.lastKeyboard,
        // The same focus reading the clock uses - see `ReclaimPane.lastFocus`.
        lastFocus: focusLeftAt.current[s.id],
        // Quiet means quiet. `lastKeyboard` alone called a pane whose agent had been
        // printing for two hours "idle for two hours" - see ReclaimPane.lastOutput.
        lastOutput: s.lastOutput,
        busy: s.runSince !== undefined,
        focused: s.id === activeId,
        visible: visibleIds.has(s.id),
        remote: !!s.remote,
        // The real refusal, and not the pane's STATE: `fleetState` says `needsYou` for a
        // finished turn and for a live question alike, so reading it alone refused every
        // finished pane and this sweep had never closed anything on this desk.
        asking: !!s.ask,
        // A pane already on its way to the other machine is not this sweep's to close:
        // the same memory comes back either way, and closing it loses the move.
        handingOff: !!s.handingOff,
        pinned: pinnedRef.current[s.id],
        asleep: s.asleep
      })),
      capacity,
      cfg,
      Date.now()
    )
    if (!plan.length) return
    armCloseRef.current(plan, 'pressure', `capacity: ${capacity.level}`)
  }, [capacity, sessions, activeId, visibleIds, config?.reclaim])

  /**
   * The same thing on a clock, for a desk with nobody at it.
   *
   * Off unless `reclaim.idleCloseMinutes` is set, which is the whole reason it is allowed
   * to exist beside the paragraph above: the pressure sweep is what a machine somebody is
   * using may do by itself, and this is what a machine driven from somewhere else may be
   * TOLD to do. It runs on its own minute timer rather than off `sessions`, because the
   * thing it is watching is time passing and nothing about a quiet pane changes to say so.
   */
  useEffect(() => {
    const cfg = config?.reclaim ?? DEFAULT_RECLAIM
    if (!cfg.enabled || !(cfg.idleCloseMinutes > 0)) return
    const sweep = (): void => {
      const plan = idleClosePlan(
        sessionsRef.current.map((s) =>
          reclaimPaneOf(
            s,
            activeRef.current,
            focusLeftAt.current[s.id],
            pinnedRef.current[s.id],
            usageRef.current?.panes[s.id]?.jobs?.[0]?.label
          )
        ),
        cfg,
        // Frozen while nobody is at this machine: the clock counts time a person could
        // have acted in, not wall time. See src/shared/away.ts.
        deskNow(Date.now(), awayRef.current),
        personRef.current
      )
      // ...and out loud, and not yet. This sweep has closed panes into a console nobody
      // has open since it shipped; now it counts down on the mascot first, and a press
      // stops it.
      if (plan.length) armCloseRef.current(plan, 'idle', 'idle-close')
    }
    const timer = window.setInterval(sweep, 60_000)
    return () => window.clearInterval(timer)
  }, [config?.reclaim])

  /**
   * The same clock for the whole app: quit when nobody has used PaneForge for a while.
   *
   * Robert's reason is resources - an Electron window and a few live ptys do not need to
   * be open all night. The refusals live in shared/idlequit.ts and are tested there; this
   * only supplies the two signals the renderer is the sole owner of, focus and input that
   * did not go into a pane. `lastAppInputRef` is a ref rather than state on purpose: it is
   * written on every click and keystroke, and re-rendering the grid for that would cost
   * more than the feature saves.
   */
  useEffect(() => {
    const minutes = config?.idleQuitMinutes ?? 0
    if (!(minutes > 0)) return
    const tick = (): void => {
      const v = idleQuitVerdict({
        panes: sessionsRef.current.map((s) => ({
          state: fleetState(s),
          lastKeyboard: s.lastKeyboard,
          remote: !!s.remote,
          asking: !!s.ask
        })),
        minutes,
        focused: document.hasFocus(),
        lastAppInput: lastAppInputRef.current,
        now: Date.now()
      })
      if (v.quit) void api.quitIdle(v.reason)
    }
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [config?.idleQuitMinutes])

  // Which of the five arrangements the grid is in. Anything unknown on disk - a config
  // from a later build, a hand-edited file - reads as tiled rather than as no grid at all.
  const layout: LayoutKind = isLayout(config?.gridLayout ?? '')
    ? (config?.gridLayout as LayoutKind)
    : 'tiled'
  const plan = useMemo(
    () => planGrid(layout, tiled ? sessions.length : 1),
    [layout, tiled, sessions.length]
  )
  const cols = plan.cols
  const rows = plan.rows

  const cycleLayout = useCallback(() => {
    const next = nextLayout(layout)
    // Turned on in the same write, not a second one: arranging the grid while looking at
    // one pane is asking to see it, and two patches would race each other to the file.
    patchConfig({ gridLayout: next, grid: true })
    setZoomId(null)
    flash(`Layout: ${LAYOUT_LABEL[next]}`)
  }, [layout, grid, patchConfig, flash])

  const toggleZoom = useCallback(
    (id?: string | null) => {
      const target = id ?? activeRef.current
      if (!target) return flash('Nothing focused - open a pane first.')
      if (!grid) return flash('Zoom is for the grid - Ctrl G shows every pane at once.')
      setZoomId((z) => (z === target ? null : target))
      setActiveId(target)
    },
    [grid, flash]
  )

  /**
   * Start or stop a live copy of a pane's output going into a file (tmux's pipe-pane).
   *
   * One toggle rather than a start and a stop item, because the state is visible on the
   * pane header the whole time it is on - and because "start" on a pane that is already
   * teed would silently retire a file something else is tailing.
   *
   * The path is asked for in main (a save dialog needs a window), which is also where a
   * cancel turns into "nothing happened": a cancelled dialog and a stop both answer
   * null, so the only thing to say here is what the answer was.
   */
  const togglePipe = useCallback(
    async (s: Session | undefined, text: boolean) => {
      if (!s) return flash('Nothing focused - open a pane first.')
      if (s.remote)
        return flash('That pane runs on the other machine - tee it from the window it lives in.')
      if (s.piping) {
        await api.pipePane(s.id, null)
        return flash('Stopped writing that pane to a file.')
      }
      const info = await api.pipePane(s.id, { text })
      if (info) flash(`Writing ${s.title} to ${info.path}`)
    },
    [flash]
  )

  /**
   * Move the focused pane one slot along the grid, by keyboard.
   *
   * Same order the drag writes and the same swap it performs (`moveInOrder`), so a pane
   * moved with the arrows and a pane dragged end up in the same list - which is what main
   * is told, what the Ctrl-1..9 keys count and what a restore after an update reads back.
   */
  const movePane = useCallback(
    (delta: number) => {
      const target = activeRef.current
      if (!target) return flash('Nothing focused - open a pane first.')
      const ids = sessions.map((s) => s.id)
      if (ids.length < 2) return
      const next = moveInOrder(ids, target, delta)
      if (next === ids) return flash(delta < 0 ? 'Already first.' : 'Already last.')
      setOrder(next)
      api.reorderSessions(next)
    },
    [sessions, flash]
  )

  /**
   * Walk the focus to the next pane. One function because two chords reach it on a Mac -
   * Mod+Tab, and Ctrl+Tab because the OS eats the first one - and two copies of a wrap
   * calculation is how they drift apart.
   */
  const cyclePane = useCallback(
    (delta: number) => {
      if (sessions.length < 2) return
      const i = sessions.findIndex((s) => s.id === activeRef.current)
      setActiveId(sessions[(i + delta + sessions.length) % sessions.length].id)
    },
    [sessions]
  )

  /**
   * Synchronised typing: every keystroke into every open pane at once.
   *
   * Kept as an app-level flag rather than a per-pane one because the question is always
   * "all of you" - four agents that have to be interrupted, or told the same correction.
   * The group is every open session, and it is rebuilt whenever the session list changes
   * so a pane opened while it is on joins, and a closed one leaves (`TerminalPane` drops
   * its own id too, in case the pane goes away between renders).
   */
  const [syncTyping, setSyncTyping] = useState(false)
  useEffect(() => {
    syncedPanes.clear()
    if (!syncTyping) return
    for (const s of sessions) syncedPanes.add(s.id)
    return () => syncedPanes.clear()
  }, [syncTyping, sessions])

  const toggleSyncTyping = useCallback(() => {
    if (sessions.length < 2 && !syncTyping)
      return flash('Synchronised typing needs a second pane to type into.')
    setSyncTyping((on) => {
      flash(on ? 'Synchronised typing off.' : `Synchronised typing ON - ${sessions.length} panes.`)
      return !on
    })
  }, [sessions.length, syncTyping, flash])

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
        // The shelf is the lightest layer on screen, so Escape closes it before it
        // starts closing dialogs underneath.
        if (shelfPinned || shelfSearching) {
          // A search in progress owns the first Escape - it empties the box, and the
          // second one closes the shelf. This test is HERE rather than a stopPropagation
          // in the input, because this listener is a capture-phase one on the window and
          // so runs before the field ever sees the key: measured against a real window,
          // the shelf closed and the query survived, which is both halves backwards.
          const el = document.activeElement as HTMLInputElement | null
          if (el?.closest('.shelf-search') && el.value) return
          // Same reason, for the editor: Escape there throws the correction away and
          // leaves the shelf up, which is what somebody who mistyped one line meant.
          if (el?.closest('.shelf-edit')) return
          setShelfPinned(false)
          setShelfSearching(false)
          return
        }
        // Changes opened FROM the fleet list sit on top of it, so Escape closes the diff
        // and leaves you in the list you picked that pane out of.
        if (diff) {
          setDiff(null)
          return
        }
        setPicking(false)
        setSettings(false)
        setHelp(false)
        setSwarm(false)
        setBoard(null)
        setHistory(false)
        setDevices(false)
        setRenaming(null)
        return
      }
      if (e.key === 'F1') {
        e.preventDefault()
        setHelp((h) => !h)
        return
      }
      // Ctrl+/ (and Ctrl+? on the same physical key) is where everything else puts help,
      // and it is the one people try before F1. A bare "?" cannot have it: that character
      // is typed into agents all day.
      // `modKey` is Cmd on a Mac and Ctrl everywhere else - every shortcut below reads it
      // rather than ctrlKey, so a Mac's Ctrl keeps belonging to the shell.
      if (modKey(e) && !e.altKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault()
        e.stopPropagation()
        setHelp((h) => !h)
        return
      }
      /**
       * Cycling panes needs a chord the OS will actually hand over, and on a Mac the one
       * this app claimed is not one.
       *
       * Every shortcut below reads `modKey`, which is Cmd on a Mac so that Ctrl stays the
       * shell's - correct, and it made Mod+Tab into Cmd+Tab, which macOS takes for the
       * application switcher before any app sees the key. So walking the panes from the
       * keyboard has never worked on this platform, and it was invisible from inside a
       * test: a synthetic KeyboardEvent bypasses the OS entirely, so Cmd+Tab moved the
       * focus in a probe and nothing at all under a finger.
       *
       * Ctrl+Tab is the one exception the shell rule can afford. Ctrl belongs to the
       * terminal here, but no shell, readline binding or agent CLI binds Ctrl+Tab - it is
       * "cycle" in every browser and editor on the machine, which is where the hand goes
       * anyway. On Windows and Linux Mod+Tab already IS Ctrl+Tab, so this changes nothing.
       */
      if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        cyclePane(e.shiftKey ? -1 : 1)
        return
      }
      if (!modKey(e) || e.altKey) return
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
      } else if (k === 'v' && e.shiftKey) {
        // Claimed here, and stopped from going any further: the pane's own handler
        // treats every Ctrl+V as a paste, so without stopPropagation this would open
        // the shelf and paste the clipboard into the agent at the same time.
        e.preventDefault()
        e.stopPropagation()
        // One Stash: while the floating one is on, this key opens that, not a second
        // list drawn inside the window.
        if (shelfInWindow) {
          // Open by ANY hold - pinned or a search - and the key means hide. Flipping
          // only the pin left a searching shelf on screen, which read as a dead key.
          if (shelfPinned || shelfSearching) {
            setShelfPinned(false)
            setShelfSearching(false)
          } else setShelfPinned(true)
        } else api.toggleStash()
      } else if (k === 'd' && e.shiftKey) {
        e.preventDefault()
        setDevices(true)
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
      } else if (k === 'g' && e.shiftKey) {
        // Shift is the grid's own arrangement: same key as the grid, one level in.
        e.preventDefault()
        cycleLayout()
      } else if (k === 'g') {
        e.preventDefault()
        patchConfig({ grid: !grid })
      } else if (k === 'z' && e.shiftKey) {
        // Not a bare Ctrl+Z: that is SIGTSTP in a shell and undo in every agent's
        // prompt, and this app does not get to take either of them.
        e.preventDefault()
        toggleZoom()
      } else if (k === 'u' && e.shiftKey) {
        // U for "up the scrollback". C is copy, and tmux's own `[` needs a modifier this
        // app cannot claim on every keyboard layout - on a German one it is AltGr+8.
        e.preventDefault()
        e.stopPropagation()
        const enter = activeId ? paneCopyMode.get(activeId) : null
        if (enter) enter()
        else flash('Open a pane first - there is nothing to copy from.')
      } else if (k === 'y' && e.shiftKey) {
        // Y for sYnc: B (broadcast) is tmux's own prefix key and the one chord people
        // press by muscle memory expecting nothing to happen here.
        e.preventDefault()
        toggleSyncTyping()
      } else if (e.key.startsWith('Arrow') && e.shiftKey && !typing) {
        // Move the focused pane, not the focus. Shift is the difference from Ctrl+Tab,
        // which walks the focus and leaves the grid alone.
        e.preventDefault()
        movePane(e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)
      } else if (k === 'f' && e.shiftKey) {
        // Fleet is always grouped by state; this shortcut is no longer needed.
        // Shift is reserved in case we need to add another fleet-level command in the future.
      } else if (k === 'f' &&(!typing || (e.target as HTMLElement)?.classList.contains('find-input'))) {
        // Find inside the pane's scrollback. Claimed from the terminal deliberately -
        // Ctrl+F is readline's "forward one character", which nobody has ever pressed on
        // purpose, and it is where every other program on the machine puts search.
        e.preventDefault()
        e.stopPropagation()
        const open = activeId ? paneFind.get(activeId) : null
        if (open) open()
        else flash('Open a pane first - there is nothing to search.')
      } else if (k === ',') {
        e.preventDefault()
        setSettings(true)
      } else if ((k === '+' || k === '=' || k === '-') && config) {
        e.preventDefault()
        const delta = k === '-' ? -1 : 1
        patchConfig({ fontSize: Math.min(22, Math.max(9, config.fontSize + delta)) })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        cyclePane(e.shiftKey ? -1 : 1)
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
  }, [
    activeId,
    sessions,
    grid,
    config,
    close,
    patchConfig,
    agents,
    switchAgent,
    palette,
    flash,
    ask,
    // Escape now has to know whether a diff is open on top of the fleet list, so the
    // handler reads it and must be rebuilt when it changes.
    diff,
    fixUi,
    shelfPinned,
    shelfSearching,
    shelfInWindow,
    cycleLayout,
    toggleZoom,
    movePane,
    cyclePane,
    toggleSyncTyping
  ])

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
        id: 'changes',
        group: 'Actions',
        title: 'Review changes in this pane',
        hint: 'every line the agent in this folder has written',
        run: () => {
          const s = sessions.find((x) => x.id === activeRef.current)
          if (s) setDiff({ cwd: s.cwd, lane: s.lane, scope: s.lane ? 'all' : 'working' })
        }
      },
      {
        id: 'grid',
        group: 'Actions',
        title: grid ? 'Show one pane at a time' : 'Show every pane in a grid',
        keys: 'Ctrl G',
        run: () => patchConfig({ grid: !grid })
      },
      // One entry per arrangement rather than one "cycle" entry: the palette is where
      // you go when you know what you want, and cycling four times through a dialog to
      // reach it is the opposite of that. The cycle key is Ctrl Shift G.
      ...LAYOUTS.map((kind) => ({
        id: `layout:${kind}`,
        group: 'Actions',
        title: `Grid layout: ${LAYOUT_LABEL[kind]}`,
        hint:
          kind === 'tiled'
            ? 'every pane the same size'
            : kind === 'columns'
              ? 'side by side, one row'
              : kind === 'rows'
                ? 'stacked, one column'
                : kind === 'main-left'
                  ? 'one big pane on the left, the rest stacked beside it'
                  : 'one big pane on top, the rest along the bottom',
        keys: kind === layout ? 'current' : 'Ctrl Shift G',
        run: () => {
          patchConfig({ gridLayout: kind, grid: true })
          setZoomId(null)
        }
      })),
      {
        id: 'zoom',
        group: 'This pane',
        title: zoom ? 'Unzoom: back to the grid' : 'Zoom this pane to the whole window',
        hint: 'the grid and its sizes are left exactly as they are',
        keys: 'Ctrl Shift Z',
        run: () => toggleZoom()
      },
      {
        id: 'copy-mode',
        group: 'This pane',
        title: 'Copy from this pane without the mouse',
        hint: 'move with hjkl, v to select, y to copy - the scrollback, keyboard only',
        keys: 'Ctrl Shift U',
        run: () => {
          const enter = activeRef.current ? paneCopyMode.get(activeRef.current) : null
          if (enter) enter()
          else flash('Open a pane first - there is nothing to copy from.')
        }
      },
      {
        id: 'pipe-pane',
        group: 'This pane',
        title: active?.piping ? 'Stop writing this pane to a file' : 'Write this pane to a file as it runs',
        hint: active?.piping
          ? `going to ${active.piping.path}`
          : 'a live copy of the output, for tail -f, a log viewer, or another agent watching the run',
        run: () => togglePipe(active, false)
      },
      {
        id: 'pipe-pane-text',
        group: 'This pane',
        title: 'Write this pane to a file as plain text',
        hint: 'the same, with the colour and cursor codes taken out - readable rather than exact',
        run: () => togglePipe(active, true)
      },
      {
        id: 'move-pane-back',
        group: 'This pane',
        title: 'Move this pane one slot earlier',
        hint: 'swaps with the pane before it - the same move a drag makes',
        keys: 'Ctrl Shift ←',
        run: () => movePane(-1)
      },
      {
        id: 'move-pane-on',
        group: 'This pane',
        title: 'Move this pane one slot later',
        hint: 'swaps with the pane after it',
        keys: 'Ctrl Shift →',
        run: () => movePane(1)
      },
      {
        id: 'sync-typing',
        group: 'Actions',
        title: syncTyping ? 'Stop typing into every pane' : 'Type into every pane at once',
        hint: syncTyping
          ? 'back to typing in one pane'
          : 'every keystroke, including Ctrl+C and arrows, goes to all of them',
        keys: 'Ctrl Shift Y',
        run: () => toggleSyncTyping()
      },
      {
        id: 'shelf',
        group: 'Actions',
        title: 'Stash: copied text, screenshots and dropped files',
        hint: 'click one into the focused pane',
        keys: 'Ctrl Shift V',
        run: () => (shelfInWindow ? setShelfPinned((p) => !p) : api.toggleStash())
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
        id: 'split',
        group: 'Actions',
        title: 'Split a long ask into panes',
        hint: 'one request, one pane per part that can run alone',
        run: () => setSplitting(true)
      },
      {
        id: 'history',
        group: 'Actions',
        title: 'Search past sessions',
        hint: 'everything every agent has printed',
        keys: 'Ctrl H',
        run: () => setHistory(true)
      },
      {
        id: 'devices',
        group: 'Actions',
        title: 'Devices: pick up work on another machine',
        hint: 'its panes appear here, still running over there',
        keys: 'Ctrl Shift D',
        run: () => setDevices(true)
      },
      { id: 'settings', group: 'Actions', title: 'Settings', keys: 'Ctrl ,', run: () => setSettings(true) },
      {
        id: 'keys',
        group: 'Actions',
        title: 'Keyboard shortcuts',
        hint: 'every key the app answers to',
        keys: 'F1',
        run: () => setHelp(true)
      }
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
          hint: 'the project folder - to reach the agent, drag files onto the pane',
          run: () =>
            void api.revealProject(active.cwd).then((p) => p || flash('That folder is gone.'))
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
          run: closeAll
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
    closeAll,
    flash,
    fixUi,
    saveRunningAsWorkspace,
    layout,
    zoom,
    toggleZoom,
    movePane,
    syncTyping,
    toggleSyncTyping
  ])


  /**
   * Moving and sizing panes in the grid.
   *
   * Both gestures were missing entirely: the grid was `repeat(n, 1fr)` in session order,
   * so the pane you were actually reading got the same quarter of the window as the three
   * you were only keeping an eye on, and the only way to move one was to drag its card in
   * the sidebar - which is a list, in a different place, and does not look like the thing
   * being arranged.
   *
   * Pointer events and a 9px slop, the same as the sidebar, for the same reason: a pane
   * title is also a click target, a double-click target and holds buttons, and `draggable`
   * would take all three.
   */
  const panesRef = useRef<HTMLElement>(null)
  // The grid's own box and the gap between panes, remeasured when the window changes.
  // Needed because a divider drag is in pixels and the sizes it edits are fractions.
  // The tracks live inside the padding, so this is the content box and where it starts -
  // clientWidth would be 18px too wide and put every divider half a pane out of place.
  const [box, setBox] = useState({ w: 0, h: 0, gap: 9, padX: 0, padY: 0 })
  useEffect(() => {
    const el = panesRef.current
    if (!el || !tiled) return
    const measure = (): void => {
      const cs = getComputedStyle(el)
      const gap = parseFloat(cs.columnGap) || 0
      const padX = parseFloat(cs.paddingLeft) || 0
      const padY = parseFloat(cs.paddingTop) || 0
      const w = el.clientWidth - padX - (parseFloat(cs.paddingRight) || 0)
      const h = el.clientHeight - padY - (parseFloat(cs.paddingBottom) || 0)
      setBox((b) =>
        b.w === w && b.h === h && b.gap === gap && b.padX === padX && b.padY === padY
          ? b
          : { w, h, gap, padX, padY }
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tiled])

  const key = shapeKey(cols, rows, layout)
  const saved = config?.gridSizes?.[key]
  // What the tracks are worth before anybody has dragged them. Equal shares everywhere
  // except the two layouts with a main pane, where equal shares would make "big left"
  // indistinguishable from tiled.
  const base = useMemo(() => layoutDefaults(layout, cols, rows), [layout, cols, rows])
  // While a divider is being dragged the fractions live here rather than in the config:
  // a pointermove is not a settings change, and writing the file sixty times a second to
  // find out where somebody is going to let go would be absurd.
  const [live, setLive] = useState<{ key: string; cols: number[]; rows: number[] } | null>(null)
  const sizes = useMemo(() => {
    if (live && live.key === key) return { cols: live.cols, rows: live.rows }
    return { cols: usable(saved?.cols, cols, base.cols), rows: usable(saved?.rows, rows, base.rows) }
  }, [live, key, saved, cols, rows, base])

  const dividerDrag = useCallback(
    (e: React.PointerEvent, axis: 'cols' | 'rows', i: number) => {
      if (e.button !== 0) return
      e.preventDefault()
      const total = axis === 'cols' ? box.w : box.h
      const start = axis === 'cols' ? e.clientX : e.clientY
      const from = sizes[axis]
      const other = axis === 'cols' ? sizes.rows : sizes.cols
      let latest = from
      // The divider itself captures the pointer, for the same reason the session list
      // does: without it, a button let go outside the window never delivers pointerup,
      // `up` never runs, and everything it undoes stays undone - `body.sizing` keeps
      // `user-select: none` over the whole app and the pointermove listener below lives
      // on, re-rendering the grid on every mouse move for the rest of the session. That
      // is a window that has stopped answering the mouse while nothing looks wrong.
      // Capturing on the handle is safe here where capturing on a press is not: this
      // element is the double-click target too, so retargeting the click to it is where
      // the click was going anyway.
      const handle = e.currentTarget as HTMLElement
      let done = false
      const move = (ev: PointerEvent): void => {
        const delta = (axis === 'cols' ? ev.clientX : ev.clientY) - start
        latest = dragTrack(from, total, box.gap, i, delta)
        setLive({ key, ...(axis === 'cols' ? { cols: latest, rows: other } : { cols: other, rows: latest }) })
      }
      const up = (): void => {
        // Releasing the capture below fires lostpointercapture, which is this handler.
        if (done) return
        done = true
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        handle.removeEventListener('lostpointercapture', up)
        try {
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
        } catch {
          /* already gone */
        }
        document.body.classList.remove('sizing')
        setLive(null)
        // Saved on release, so an interrupted drag leaves the layout exactly as it was.
        const next = axis === 'cols' ? { cols: latest, rows: other } : { cols: other, rows: latest }
        patchConfig({ gridSizes: { ...(config?.gridSizes ?? {}), [key]: next } })
      }
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* a pointer already released - the listeners below still clean up */
      }
      handle.addEventListener('lostpointercapture', up)
      document.body.classList.add('sizing')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [box, sizes, key, config, patchConfig]
  )

  /**
   * Double-click a divider: that axis goes back to what the layout starts at - equal
   * shares in three of the five, and the main pane's 62% in the two that have one. Going
   * back to equal there would be a reset that leaves the layout looking like a different
   * one, which is not what "put it back" means.
   */
  const dividerReset = useCallback(
    (axis: 'cols' | 'rows') => {
      const next =
        axis === 'cols' ? { cols: base.cols, rows: sizes.rows } : { cols: sizes.cols, rows: base.rows }
      patchConfig({ gridSizes: { ...(config?.gridSizes ?? {}), [key]: next } })
    },
    [base, sizes, key, config, patchConfig]
  )

  // The pane being dragged, and the one it would change places with. An outline rather
  // than a live reshuffle: every pane that moves refits its terminal and resizes a pty,
  // and doing that to four agents on every pointermove is visible as a stutter. The
  // outline says where it will land and nothing moves until it does.
  const [movingId, setMovingId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)

  const beginPaneMove = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0 || !tiled) return
      if ((e.target as HTMLElement).closest('button, input')) return
      const startX = e.clientX
      const startY = e.clientY
      let dragging = false
      let over: string | null = null
      let done = false
      // Captured on the pane container, which never moves, and only once the drag has
      // really started - the same rule the session list follows, and for the same two
      // reasons. Capturing on the press would retarget the click that follows to the
      // container and stop a pane being selected by clicking it; not capturing at all
      // means a button let go outside the window delivers no pointerup, so `up` never
      // runs. Everything it undoes then stays: `body.dragging` paints `cursor: grabbing`
      // over every element, the moved pane keeps `.moving`, and the listener below runs
      // a hit test across every pane and a React render on every mouse move, forever.
      // That is an app that has stopped answering the mouse with nothing on screen to
      // say why, and it only ends when the window is reloaded.
      const capture = panesRef.current
      const move = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) < DRAG_SLOP && Math.abs(ev.clientY - startY) < DRAG_SLOP) return
          dragging = true
          try {
            capture?.setPointerCapture(ev.pointerId)
          } catch {
            /* a pointer already released - the listeners below still clean up */
          }
          capture?.addEventListener('lostpointercapture', up)
          setMovingId(id)
          document.body.classList.add('dragging')
        }
        // The pane under the pointer, found by box rather than by elementFromPoint: the
        // terminal canvas swallows hit-testing and would report itself, not the pane.
        const panes = Array.from(panesRef.current?.querySelectorAll<HTMLElement>('.pane[data-id]') ?? [])
        const hit = panes.find((p) => {
          const b = p.getBoundingClientRect()
          return ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top && ev.clientY <= b.bottom
        })
        over = hit?.dataset.id && hit.dataset.id !== id ? hit.dataset.id : null
        setDropId(over)
      }
      const up = (): void => {
        // Releasing the capture below fires lostpointercapture, which is this handler.
        if (done) return
        done = true
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        capture?.removeEventListener('lostpointercapture', up)
        try {
          if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId)
        } catch {
          /* already gone */
        }
        setMovingId(null)
        setDropId(null)
        if (!dragging) return
        document.body.classList.remove('dragging')
        if (!over) return
        // Swapped, not inserted. In a list, inserting is what a reader expects; in a grid
        // it shuffles every pane after the drop point into a different cell, and the three
        // panes nobody touched all move. Two panes changing places is what the outline
        // showed and the only thing that happens.
        const ids = idsRef.current.slice()
        const a = ids.indexOf(id)
        const b = ids.indexOf(over)
        if (a < 0 || b < 0) return
        ;[ids[a], ids[b]] = [ids[b], ids[a]]
        setOrder(ids)
        api.reorderSessions(ids)
        draggedRef.current = true
        window.setTimeout(() => {
          draggedRef.current = false
        }, 0)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [tiled]
  )
  const waiting = sessions.filter((s) => s.attention).length
  // Devices in either direction: ones whose panes are in this list, and ones watching
  // this machine's. Both are "a link is up", which is all the sidebar dot claims.
  const remoteLive =
    (remote?.peers.filter((p) => p.status === 'online').length ?? 0) + (remote?.guests.length ?? 0)
  // "Working" is now the agent's own on-screen state rather than "something was printed
  // in the last four seconds", so it stays honest through a long silent tool call and
  // does not claim a pane sitting at an empty prompt is busy.
  const working = sessions.filter((s) => s.status === 'working').length
  // The other half of that number, and the more useful one: how many panes are waiting on
  // a PERSON. `working` is the app being busy, which nobody has to do anything about, and
  // `waiting` above is narrower than this - it clears the moment you LOOK at the pane,
  // where this keeps counting until the pane is actually answered.
  // The dev lanes of every repo an open pane is in - one board per repo. Empty on a
  // machine with no lane-using checkout, and then nothing below draws anything.
  const laneBoards = useLaneBoards()
  const lanesByPane = useLanesByPane(laneBoards)
  // The worktree lane whose contents are open on screen, by folder.
  const [laneCwd, setLaneCwd] = useState<string | null>(null)
  const [laneHelp, setLaneHelp] = useState(false)
  // A pane that was cleared in an empty lane is moved back to the project folder by the
  // main process; that is a thing happening to your window, so it says so.
  useEffect(() => api.onLaneMoved((_id, message) => flash(message)), [flash])
  // A pane that leaves for another device must say so here. Without this the queued
  // move (the mid-turn case, and every move asked for from the phone) simply closed the
  // pane, which looks exactly like a session that froze.
  useEffect(() => api.onHandoffMoved((message) => flash(message)), [flash])

  /**
   * Bring a mirrored pane back to this machine, in one press.
   *
   * Handing a pane OUT has been one press for a long time and handing it back was not a
   * press at all: the button is drawn only for a local pane, so the way back was to walk
   * to the other machine. It cannot be a pull - the pty, the repo and the transcript are
   * over there - so this asks that device to run its own handoff at us, and every answer
   * below is its report rather than a guess made here. A pane mid-turn is QUEUED by the
   * far end and comes back when the turn ends; nothing is killed to make it travel.
   */
  const bringHere = useCallback(
    (s: Session) => {
      const where = s.remote?.name ?? 'that machine'
      flash(`Asking ${where} to send ${s.title} back…`)
      void api
        .bringPaneHere(s.id)
        .then((items) => {
          const item = items[0]
          if (!item) {
            flash(`${where} has no such pane any more`)
            return
          }
          if (item.ok) {
            flash(`${s.title} is back on this machine`)
            return
          }
          // Not a failure: the pane is mid-turn and the far end is holding it. Saying so
          // in the far end's own words keeps this from reading as "it refused".
          if (item.pending) {
            flash(item.error || `${s.title} comes back when its turn ends`)
            return
          }
          flash(item.error || `${where} would not send it back`)
        })
        .catch((err: Error) => flash(err.message))
    },
    [flash]
  )

  // The "what is this feature" notes, and the × that retires one. Held here rather than
  // passed down because eight dialogs would otherwise each grow a config prop to draw
  // one sentence - see components/Blurb.tsx.
  const blurbs = useMemo<BlurbState>(
    () => ({
      hidden: config?.hiddenBlurbs ?? [],
      hide: (id: string) =>
        patchConfig({
          hiddenBlurbs: [...new Set([...(config?.hiddenBlurbs ?? []), id])]
        })
    }),
    [config?.hiddenBlurbs, patchConfig]
  )

  /**
   * What the mascot is allowed to know: the sidebar's own numbering, the words `place.ts`
   * already worked out, the state `fleet.ts` already decided, and the memory the sampler
   * already read. Nothing here is computed for it, which is why it costs no request and
   * cannot disagree with the rest of the window.
   */
  /**
   * The countdown between the ladder deciding and the pane closing.
   *
   * Everything below this app's memory line - trim, move, close - used to happen and then
   * be reported, at best. A count is the smallest thing that turns a report into a
   * decision somebody is part of: the mascot names the pane, says when, and takes one
   * press either way. It is not a confirmation dialog, because a dialog would take the
   * screen and this app never does that on its own initiative; it is a sentence with a
   * clock in it, and doing nothing still closes the pane.
   */
  const [closeSoon, setCloseSoon] = useState<CloseSoon | undefined>(undefined)
  // Debug handle, the same one `window.__pf` is for a pane: a probe cannot wait for this
  // machine to run out of memory, and a countdown that is only ever drawn by a sweep is a
  // card no test can read. An empty `ids` is deliberately safe - the outcome of running it
  // is a loop over no panes - so a probe arms the CARD without arming a move.
  ;(window as unknown as { __pfSoon?: (s?: CloseSoon) => void }).__pfSoon = setCloseSoon
  const closeSoonRef = useRef<CloseSoon | undefined>(undefined)
  closeSoonRef.current = closeSoon
  /**
   * The panes a live countdown names. A Set because the sidebar asks this per row, and the
   * list is redrawn on every session broadcast.
   */
  const alarmIds = useMemo(() => new Set(closeSoon?.ids ?? []), [closeSoon])
  /** What the pending close is expected to give back, for the sentence afterwards. */
  const pendingMb = useRef(0)
  /**
   * Panes somebody said "keep it open" about, and until when.
   *
   * Without this, "keep it" is the same question sixty seconds later for ever, because the
   * sweeps run on a minute timer and nothing about the pane has changed. That is the exact
   * shape that gets a feature switched off.
   */
  const keptUntil = useRef<Record<string, number>>({})
  const mascotOnRef = useRef(DEFAULT_MASCOT.enabled)
  mascotOnRef.current = config?.mascot?.enabled ?? DEFAULT_MASCOT.enabled

  /**
   * Is this pane STILL one this app may close - asked at the moment of the kill, not when
   * the plan was made.
   *
   * A plan is a snapshot and the countdown is fifteen seconds long, so between the two the
   * pane can start a turn, be asked a question, or be handed off. Killing off the snapshot
   * closes a pane that is working, which is exactly the report this exists for: "the
   * countdown started before the session even ended". Every refusal here is `reclaim.ts`'s
   * own, read live: a live question, a run clock that is going, a move in flight, and any
   * state that is not one of the three the sweeps may reach.
   */
  const stillCloseable = useCallback((id: string): boolean => {
    const s = sessionsRef.current.find((x) => x.id === id)
    if (!s) return false
    if (s.ask || s.bell) return false
    if (s.runSince !== undefined) return false
    if (s.handingOff) return false
    const st = fleetState(s)
    return st === 'ready' || st === 'exited' || st === 'needsYou'
  }, [])

  const doClose = useCallback(
    (ids: string[], mb: number) => {
      setCloseSoon(undefined)
      const live = ids.filter((id) => stillCloseable(id))
      if (!live.length) {
        console.info(`reclaim: nothing left to close - ${ids.join(', ')} woke up during the countdown`)
        return
      }
      if (live.length !== ids.length) {
        console.info(
          `reclaim: sparing ${ids.filter((id) => !live.includes(id)).join(', ')} - woke up during the countdown`
        )
        mb = Math.round((mb * live.length) / ids.length)
      }
      for (const id of live) {
        // The line that answers "what closed my pane" after the fact. `armed` says a sweep
        // picked it; this says it actually went.
        api.logReclaim({ event: 'closed', id, name: paneWordRef.current(id) })
        void api.killSession(id)
      }
      setActed({ what: 'closed', panes: live.map((id) => paneActedRef.current(id)), mb, at: Date.now() })
    },
    [stillCloseable]
  )

  /**
   * The plan a countdown is currently holding, and the cooldown it was armed with.
   *
   * A ref rather than state: the countdown that draws it is `closeSoon`, and holding the
   * same fact twice in state is how the two get out of step - the bubble would say one
   * pane and the timer move another.
   */
  const moveSoonRef = useRef<{ plan: AutoHandoff[]; cooldownMinutes: number }>({
    plan: [],
    cooldownMinutes: 15
  })

  /**
   * Run an armed move. This is the loop that used to sit inside the sweep itself.
   *
   * A pane that went away or was mirrored from elsewhere during the count is skipped
   * rather than chased. A refusal puts that pane on the sweeps' own cooldown, because a
   * repo that cannot be pushed will not become pushable in fifteen seconds - and a pane
   * the far end QUEUED is a success here: it is mid-turn, and it travels when the turn
   * ends rather than being killed.
   */
  const doMove = useCallback((plan: AutoHandoff[], cooldownMinutes: number) => {
    setCloseSoon(undefined)
    void (async () => {
      try {
        for (const move of plan) {
          const live = sessionsRef.current.find((x) => x.id === move.id)
          if (!live || live.remote) continue
          const items = await api.handoffToDevice(move.device, [move.id], false, true)
          const item = items[0]
          if (item?.ok || item?.pending) {
            setActed({
              what: 'moved',
              panes: [paneActedRef.current(move.id)],
              at: Date.now(),
              where: move.deviceName
            })
          } else {
            handoffBlocked.current[move.id] = Date.now() + Math.max(1, cooldownMinutes) * 60_000
            console.info(`handoff: ${move.id} stayed here - ${item?.error ?? 'refused over there'}`)
          }
        }
      } finally {
        handoffSweeping.current = false
      }
    })()
  }, [])

  armMoveRef.current = (plan, why, cooldownMinutes) => {
    const now = Date.now()
    const fresh = plan.filter((p) => (keptUntil.current[p.id] ?? 0) <= now)
    // One countdown at a time - a second would replace the first mid-count - and the sweep
    // lock goes straight back whenever this decides not to run.
    if (!fresh.length || closeSoonRef.current) {
      handoffSweeping.current = false
      return
    }
    for (const move of fresh)
      console.info(
        `${why}: moving ${move.id} to ${move.deviceName} - quiet ${Math.round(move.idleMs / 60000)} min`
      )
    moveSoonRef.current = { plan: fresh, cooldownMinutes }
    // The mascot is no longer the only face this has: `MoveSoon` draws the same countdown
    // as a plain card when there is no sprite, which matters because the mascot ARRIVES
    // OFF - so this used to move a pane off the desk of anybody who had never gone looking
    // for an animal with nothing at all on screen.
    setCloseSoon({
      ids: fresh.map((p) => p.id),
      names: fresh.map((p) => paneWordRef.current(p.id)),
      deadline: now + CLOSE_COUNTDOWN_MS,
      why: why.startsWith('idle') ? 'idle' : 'pressure',
      // The machine, named. Every move in one plan goes to the device the plan picked.
      move: { device: fresh[0].device, deviceName: fresh[0].deviceName }
    })
  }

  armCloseRef.current = (plan, why, log) => {
    const now = Date.now()
    const keep = plan.filter((p) => (keptUntil.current[p.id] ?? 0) <= now)
    if (!keep.length) return
    // One countdown at a time. Two would be two bubbles for one bubble's worth of space,
    // and the second would silently replace the first mid-count.
    if (closeSoonRef.current) return
    const mb = reclaimedMb(keep)
    for (const p of keep) {
      const line =
        `${log}: closing ${p.id} - quiet ${Math.round(p.idleMs / 60000)} min` +
        `${p.hadAgent ? '' : ' (already exited)'}; reopen from History`
      console.info(line)
      // ...and on disk. The console line above is a DevTools window nobody has open, so
      // every pane this sweep has ever taken went without leaving a trace to read after.
      api.logReclaim({
        event: 'armed',
        why,
        id: p.id,
        name: paneWordRef.current(p.id),
        idleMin: Math.round(p.idleMs / 60000),
        hadAgent: p.hadAgent,
        log
      })
    }
    const ids = keep.map((p) => p.id)
    pendingMb.current = mb
    // Same as the move above: with no sprite the count is drawn by `MoveSoon` instead.
    setCloseSoon({ ids, names: ids.map((id) => paneWordRef.current(id)), deadline: now + CLOSE_COUNTDOWN_MS, why })
  }

  /**
   * A countdown that nobody can see is a countdown nobody can stop.
   *
   * The bubble is drawn beside the mascot in a corner, takes itself away after a minute,
   * and is behind whatever window is on top - so on 2026-08-23 two panes went to the PC
   * with nothing on screen at the moment it mattered, and the report was "randomly 2
   * sessions moved". The alert plays once when the countdown arms, and the last five
   * seconds tick, which is exactly the shape `AskCountdown` already uses for the other
   * thing this app decides on somebody's behalf.
   *
   * `playTick` deliberately bypasses the 900ms alert throttle - see `useChime` - or the
   * ticks would swallow each other and the alert above them.
   */
  useEffect(() => {
    if (!closeSoon) return
    if (!soundOn.current) return
    // `playAction`, never `playEvent`: the pane a sweep picks is usually the one that just
    // finished, so the `done` chime lands a moment before this and the 900ms guard ate it.
    playAction('move', soundSet.current)
    const ticks: number[] = []
    for (let left = 5; left >= 1; left--) {
      const at = closeSoon.deadline - left * 1000 - Date.now()
      if (at > 0) ticks.push(window.setTimeout(() => playTick(soundSet.current), at))
    }
    return () => ticks.forEach((t) => window.clearTimeout(t))
  }, [closeSoon])

  /**
   * The same thing for the countdown in front of an automatic /clear.
   *
   * That card is drawn in a corner of a window that is regularly behind something else,
   * and the whole point of it is the button underneath - so a countdown nobody hears is a
   * countdown nobody stops. Robert, 2026-08-27: "make sure sound effects come and
   * countdown you can actually hear it".
   *
   * Same shape as the sweep's countdown above: `playAction` once when it arms, then a tick
   * a second through the last ten. Ten rather than five because this clock is fifteen
   * seconds by default, and five would put the first sound past the two-thirds mark of the
   * thing it is announcing. Nothing at all before the last ten, or a wait somebody set to
   * five minutes in Settings becomes a metronome.
   */
  const clearSoonAt = sessions.reduce(
    (min, s) => (s.autoClearAt && (!min || s.autoClearAt < min) ? s.autoClearAt : min),
    0
  )
  // A countdown held off by an unsent line re-arms every few seconds (`DRAFT_RETRY_MS`),
  // which moves the deadline and re-runs this effect. The TICKS should follow it - the
  // clear really is still coming - but the arrival alert must not sound again every five
  // seconds, so it plays only when there was no countdown a moment ago.
  const hadClearSoon = useRef(false)
  useEffect(() => {
    if (!clearSoonAt) {
      hadClearSoon.current = false
      return
    }
    if (!soundOn.current) return
    const first = !hadClearSoon.current
    hadClearSoon.current = true
    if (first) playAction('move', soundSet.current)
    const ticks: number[] = []
    for (let left = 10; left >= 1; left--) {
      const at = clearSoonAt - left * 1000 - Date.now()
      if (at > 0) ticks.push(window.setTimeout(() => playTick(soundSet.current), at))
    }
    return () => ticks.forEach((t) => window.clearTimeout(t))
  }, [clearSoonAt])

  useEffect(() => {
    if (!closeSoon) return
    const t = window.setTimeout(
      () =>
        closeSoon.move
          ? doMove(moveSoonRef.current.plan, moveSoonRef.current.cooldownMinutes)
          : doClose(closeSoon.ids, pendingMb.current),
      Math.max(0, closeSoon.deadline - Date.now())
    )
    return () => window.clearTimeout(t)
  }, [closeSoon, doClose, doMove])

  /**
   * A pane that wakes up mid-countdown takes the countdown down with it.
   *
   * The kill re-checks too, but only at the deadline: without this the app draws "closing
   * pane 1 in 9s" over a pane that has just started answering, which is a sentence saying
   * it is about to do something it will not do. `sessions` is the dependency because that
   * is what changes when a pane goes busy or is asked something.
   */
  useEffect(() => {
    if (!closeSoon) return
    // Not for a move: a pane going back to work is exactly what a move is allowed to
    // carry - the far end QUEUES a mid-turn pane rather than killing it - so dropping the
    // countdown here would make the one pane worth moving the one that never moves.
    if (closeSoon.move) return
    if (closeSoon.ids.every((id) => stillCloseable(id))) return
    console.info('reclaim: countdown dropped - a pane it named went back to work')
    setCloseSoon(undefined)
  }, [closeSoon, sessions, stillCloseable])

  /**
   * Put each local pane's closing deadline on the session, where the card reads it.
   *
   * The decision has to be made HERE - it needs which pane has focus and the config this
   * window is already holding - but it is drawn in two places that are not here: this
   * desk's own cards, and the cards of every paired device listing this machine's panes.
   * Publishing it once, onto the session, is what makes those two agree; a viewer working
   * it out for itself would be guessing at another machine's settings.
   *
   * Only on a real change (`closingRef`), because this runs on every session broadcast and
   * `setClosingAt` emits one when the number moves.
   */
  const closingRef = useRef<Record<string, number | undefined>>({})
  const publishClosingRef = useRef<() => void>(() => {})
  useEffect(() => {
    const run = (): void => {
      const cfg = config?.reclaim ?? DEFAULT_RECLAIM
      // The same frozen clock the sweep reads, or a card counts down to a close that is
      // not coming.
      const now = deskNow(Date.now(), awayRef.current)
      const live = new Set<string>()
      for (const s of sessions) {
        if (s.remote) continue
        live.add(s.id)
        const due = idleCloseAt(
          reclaimPaneOf(
            s,
            activeId,
            focusLeftAt.current[s.id],
            pinned[s.id],
            usage?.panes[s.id]?.jobs?.[0]?.label
          ),
          cfg,
          now,
          personHere
        )
        // A pane somebody pressed "keep it open" on is held by that, not by the clock -
        // and the card must say so rather than counting down to a close that will not
        // happen for another hour.
        const kept = keptUntil.current[s.id] ?? 0
        const at = due === null ? undefined : Math.max(due, kept)
        if (closingRef.current[s.id] === at) continue
        closingRef.current[s.id] = at
        api.setClosing(s.id, at ?? null)
      }
      for (const id of Object.keys(closingRef.current)) if (!live.has(id)) delete closingRef.current[id]
    }
    publishClosingRef.current = run
    run()
    // `awayAt` is in here because the deadline it publishes is computed from the frozen
    // clock: a card must stop counting down the moment the sweep stops counting.
  }, [sessions, config?.reclaim, activeId, pinned, awayAt, personHere])

  /**
   * Hold these panes where they are, for an hour.
   *
   * Both holds, always together: `keptUntil` is what the two arming functions filter on,
   * and `handoffBlocked` is what the handoff PLANS filter on. Setting one and not the
   * other leaves a control that appears to work and is undone by the next sweep, which is
   * exactly what `stopMove` shipped as.
   */
  const keepHere = useCallback((ids: string[]) => {
    const until = Date.now() + KEEP_MINUTES * 60_000
    for (const id of ids) {
      keptUntil.current[id] = until
      handoffBlocked.current[id] = until
    }
    publishClosingRef.current()
  }, [])

  const keepOpen = useCallback((ids: string[]) => {
    const until = Date.now() + KEEP_MINUTES * 60_000
    for (const id of ids) keptUntil.current[id] = until
    // A move called off needs the handoff sweeps' OWN hold as well, or the next minute
    // tick arms the identical countdown again - which is the shape that gets a feature
    // switched off. The sweep lock goes back with it.
    if (closeSoonRef.current?.move) {
      for (const id of ids) handoffBlocked.current[id] = until
      handoffSweeping.current = false
    }
    setCloseSoon(undefined)
    // `keptUntil` is a ref, so nothing about this reaches the effect that publishes the
    // deadline. Without this the chip goes on counting down to a close an hour away.
    publishClosingRef.current()
  }, [])

  /**
   * This pane was just used by a person - restart its idle clock and say so on the card.
   *
   * The focus effect above covers switching BETWEEN panes; this covers the press itself,
   * so the chip goes the instant the card is clicked rather than on the next session
   * broadcast. `publishClosingRef` because `focusLeftAt` is a ref and nothing else would
   * notice that it moved.
   */
  const touchPane = useCallback((id: string) => {
    focusLeftAt.current[id] = Date.now()
    // ...and a person arriving at a pane a countdown NAMED is the answer that countdown
    // was asking for. Nothing dropped it: the sweeps' own "went back to work" effect keys
    // on `stillCloseable`, which a click does not change - so clicking the pane restarted
    // its idle clock, published a new deadline on its card, and left the 15s count running
    // underneath, closing or moving the pane somebody was in the middle of reading.
    //
    // Only the countdown goes, not the pane's turn at the sweep: the press above is what
    // keeps it from being picked again (`quietSince` reads `lastFocus`). Any OTHER pane in
    // the same plan is re-decided by the next sweep rather than closed on a count that is
    // no longer on screen - that is the honest half, because nobody arrived at those.
    const soon = closeSoonRef.current
    if (soon?.ids.includes(id)) {
      console.info(`reclaim: countdown dropped - somebody came to ${id}`)
      // The move sweep holds a lock for as long as its countdown is up. Dropping the
      // countdown without giving it back is how `stopMove` shipped as a control that
      // appeared to work and then let nothing move ever again.
      if (soon.move) handoffSweeping.current = false
      setCloseSoon(undefined)
    }
    publishClosingRef.current()
  }, [])

  /** "Keep this pane open" / "Let it close when idle", off the card's right-click. */
  const togglePin = useCallback((id: string) => {
    setPinned((was) => {
      const next = { ...was }
      if (next[id]) delete next[id]
      else next[id] = true
      return next
    })
  }, [])

  // What is serving on this machine, for the mascot's "what dev servers are running" and
  // for stopping one by name. Held rather than polled: the reading costs a whole process
  // table with full command lines, so it is refreshed when the ask box opens and after
  // anything is stopped, and never on a timer.
  const [devs, setDevs] = useState<RunningDev[]>([])

  const mascotPanes: MascotPane[] = useMemo(
    () =>
      sessions.map((s, i) => ({
        id: s.id,
        pane: i + 1,
        name: projectNameOf(s.cwd) || s.title,
        // Which COPY of that project. Three lanes of one repo were three panes with the
        // same name, so every sentence about one of them named the other two as well.
        where: (() => {
          const place = describePlace({ cwd: s.cwd, lane: s.lane })
          return place.kind === 'lane' ? place.role : ''
        })(),
        state: fleetState(s),
        memMb: usage?.panes[s.id]?.rssMb ?? null,
        idleMs: Math.max(0, Date.now() - (Math.max(s.lastKeyboard, s.lastOutput ?? 0) || s.createdAt || Date.now())),
        remote: !!s.remote,
        asking: !!s.ask,
        // What this pane was asked to do, so every sentence about it can say which
        // conversation it is rather than only which key reaches it.
        doing: s.gist
      })),
    [sessions, usage]
  )

  const refreshDevs = useCallback(() => {
    void api
      .listDevServers(mascotPanes.map((p) => ({ id: p.id, pane: p.pane, name: p.name })))
      .then((list) => setDevs(list ?? []))
      .catch(() => setDevs([]))
  }, [mascotPanes])

  /**
   * Whether the list is grouped by who needs a person, or left in the order it was
   * dragged into.
   *
   * Grouped by state is the only view. Sessions are always organized by who needs you
   * first (Your move), then active work (Running), ready-to-use panes (Ready), and
   * finished ones (Ended). This replaced the Fleet dialog and the toggle between views.
   * Kept in this window rather than in config.json - it is a view, not a setting, and
   * two machines have no reason to agree about how to display the same panes.
   */
  // Sessions are always grouped by state; the toggle is removed in favor of permanent grouping.
  const byState = true

  /**
   * Every pane on the desk, this machine's and every paired machine's, as one list.
   *
   * A pane on the PC used to be invisible here until somebody picked it for mirroring in
   * Devices, so "is anything running over there" was a question you had to go and ask -
   * which is no way to watch a machine that is meant to be doing the work. Everything
   * needed to answer it already crosses the link (`RemotePaneInfo` rides the
   * `remote:changed` message), so the sidebar draws them all and mirrors none of them.
   *
   * That split is the whole design. LISTING a remote pane costs a few fields in a message
   * that is already sent whenever anything over there moves; MIRRORING one costs a live
   * byte stream and an xterm buffer on this laptop, per pane. Pressing the row is what
   * turns one into the other, so a desk showing fifty PC panes costs what showing none
   * used to.
   *
   * A listed row has no pane NUMBER: there is nothing on this machine for Ctrl+N to
   * switch to until it has been opened.
   */
  const deskRows = useMemo(
    () => buildDeskRows(sessions, shownSessions, remote?.peers ?? [], deviceFilter),
    [sessions, shownSessions, remote, deviceFilter]
  )

  const groups = useMemo(() => deskGroups(deskRows, byState), [deskRows, byState])

  /**
   * How many panes want a person - on EITHER machine.
   *
   * It counted this desk's own panes, which is backwards for a laptop whose agents run
   * on the other box: the number would sit at zero all day while the PC piled up
   * finished turns. A listed pane is ranked by the same `fleet.ts` rules as a local one,
   * so counting it is the same call over a longer list.
   */
  const needsYou = fleetWaiting(deskRows)

  /**
   * Open a pane that is running on another machine: mirror it, then switch to it.
   *
   * `remote:watch` takes the whole list rather than a delta, so the ones already being
   * mirrored are re-sent with this one added. The row leaves the listed half the instant
   * the mirror arrives, because it is a session from then on - which is why the focus is
   * deferred to an effect rather than done here: the session it wants does not exist yet.
   */
  const pendingOpen = useRef<{ device: string; remoteId: string } | null>(null)
  const openListed = useCallback(
    (deviceId: string, remoteId: string) => {
      const peer = remote?.peers.find((p) => p.id === deviceId)
      const watched = (peer?.panes ?? []).filter((p) => p.watched).map((p) => p.id)
      if (!watched.includes(remoteId)) watched.push(remoteId)
      pendingOpen.current = { device: deviceId, remoteId }
      void api.watchRemote(deviceId, watched, false)
    },
    [remote]
  )
  useEffect(() => {
    const want = pendingOpen.current
    if (!want) return
    const arrived = rawSessions.find(
      (s) => s.remote?.device === want.device && s.id.endsWith(want.remoteId)
    )
    if (!arrived) return
    pendingOpen.current = null
    setActiveId(arrived.id)
    handheld.showPane()
  }, [rawSessions])

  /**
   * A pane running on another machine, drawn without being mirrored.
   *
   * Deliberately thinner than a local row: there is no git badge (the repo is on that
   * disk), no resource chip (the agent is that machine's process), no close button (it
   * is not ours to end from a list) and no rename. What it keeps is the four things that
   * make it worth pressing - which machine, what it is, what it is doing, and for how
   * long.
   */
  const listedRow = (row: DeskRow): JSX.Element => {
    const { pane, device } = row.listed!
    const place = describePlace({ cwd: pane.cwd, lane: pane.lane })
    const state = fleetRow(row)
    const agent = agents.find((a) => a.id === pane.agent)
    return (
      <div
        key={row.key}
        className={'row listed' + (pane.asking ? ' asking' : '')}
        title={
          `${pane.title} - running on ${device.name}.\n\n` +
          'Nothing of it is on this machine yet. Click to watch it here; the agent, the ' +
          'folder and the transcript stay over there.'
        }
        onClick={() => openListed(device.id, pane.id)}
      >
        <StatusDot status={pane.status} engaged={pane.engaged} />
        <div className="row-text">
          <div className="row-title has-key">
            <span className="row-remote">
              <RemoteIcon size={13} />
            </span>
            <span className="row-name">{pane.title}</span>
            {pane.asking ? (
              <span
                className="chip asks"
                title="The CLI over there is sitting on a question. Open the pane to see it and press an answer."
              >
                asks you
              </span>
            ) : state.since !== undefined ? (
              <Elapsed since={state.since} title={state.label} />
            ) : null}
            {/* That desk's own number, forwarded. No press: this window does not own the
                pty and cannot call the close off. */}
            {row.closingAt ? <CloseClock at={row.closingAt} /> : null}
          </div>
          <div className="row-sub">
            <AgentLogo id={pane.agent} spec={agent} size={12} />
            <span className="row-agent">{agent?.label ?? pane.agent}</span>
            <span className="chip" title={`Running on ${device.name}`}>
              {device.name}
            </span>
            {place.short.trim() === pane.title.trim() ? null : (
              <span className="chip place" title={place.full}>
                {place.short}
              </span>
            )}
          </div>
        </div>
        {/* Not an icon: this is the one row in the list whose click does something other
            than switch to a pane, and a word is the cheapest way to say so. */}
        <span className="row-open" aria-hidden="true">
          watch
        </span>
      </div>
    )
  }

  const sessionRow = (s: Session, paneNumber: number): JSX.Element => (
            <div
              key={s.id}
              data-id={s.id}
              className={
                'row' +
                (s.id === activeId ? ' active' : '') +
                (s.attention ? ' attn' : '') +
                // Red, and only for a live question (`shared/choices.ts` reads it off the
                // pane's own frame, so it covers every CLI here). It carries the "asks you"
                // chip on the title line - see the note there for why a ring never travels
                // without a word.
                (s.ask ? ' asking' : '') +
                // ...and the same red for the OTHER thing this app does on somebody's
                // behalf: a pane about to be closed or moved. The countdown was drawn
                // beside the mascot in a corner, which is behind whatever window is on top
                // and takes itself away after a minute - so the card, the one place
                // somebody is already looking, said nothing at all. Reported 2026-08-23:
                // "no red glow just like a question asked on the left side of session
                // card ... for any alert it should turn red glow". Same class, because it
                // is the same fact: this pane needs you NOW or something happens to it.
                (alarmIds.has(s.id) ? ' asking' : '') +
                (justDone.includes(s.id) ? ' just-done' : '') +
                (dragId === s.id ? ' dragging' : '')
                // There WAS a blue ring around the whole card here, for a pane that held a
                // lane and was mid-turn. It was the third thing on one card saying one
                // fact - the number key is already lit green while the agent runs, and the
                // lane chip below already turns blue and breathes while that checkout is
                // being typed into - and it was the only one of the three with no word or
                // tooltip attached to it. The report was "why blue glow around taskdriver
                // but not others, it's confusing", and the honest answer was that the glow
                // meant nothing the card was not already saying twice. The chip keeps the
                // colour, because the chip can be hovered and can say why.
              }
              onPointerDown={(e) => {
                const pick = (): void => {
                  touchPane(s.id)
                  setActiveId(s.id)
                  handheld.showPane()
                }
                // Dragging reorders `order`, and `order` decides nothing while the list is
                // grouped by state - the row would follow the pointer and snap back to
                // wherever its state puts it, which reads as a list that is broken.
                if (byState) pick()
                else beginDrag(e, s.id, pick)
              }}
              onClick={() => {
                if (draggedRef.current) return
                touchPane(s.id)
                setActiveId(s.id)
                // On a phone the tap has to hand over the screen even when that pane was
                // ALREADY the active one - which is the normal case, because the list is
                // what you come back to. Watching activeId change cannot see this tap.
                handheld.showPane()
              }}
              onDoubleClick={() => setRenaming(s.id)}
              // A list row's actions belong on its right-click, which is where every
              // desktop hand looks for them first. The pane is made active on the way in,
              // so the menu is never acting on a card other than the one being pointed at.
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setCardMenu({ id: s.id, x: e.clientX, y: e.clientY })
              }}
            >
              <StatusDot status={s.status} engaged={s.engaged} />
              <div className="row-text">
                {renaming === s.id ? (
                  <input
                    className="rename"
                    defaultValue={s.title}
                    // The box opens with the whole name SELECTED: a rename is almost
                    // always a replacement, so the first keystroke should clear it.
                    // Done from the ref rather than `autoFocus` + `onFocus`, because
                    // React focuses an autoFocus field during the commit, before its
                    // own onFocus listener can see that first focus - measured at
                    // selectionStart === selectionEnd === title.length.
                    ref={(el) => {
                      if (el && document.activeElement !== el) {
                        el.focus()
                        el.select()
                      }
                    }}
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
                  <div className="row-title has-key">
                    {/* The switch key, and the fastest place to read the pane's state:
                        lit green while its agent is running, amber when a turn finished
                        while you were looking somewhere else. */}
                    {paneNumber <= 9 && (
                      /* The wrapper exists only to carry the breathing halo. The key
                         itself is `overflow: hidden` so its sheen stays inside the
                         pill, and that clips a pseudo-element halo too - so the halo
                         has to hang off something outside the key. It is here rather
                         than on the key because the alternative, animating the key's
                         own box-shadow, re-rasters a blurred shadow every frame:
                         measured at 64% of a core on its own (styles.css, `.num-wrap`). */
                      <span className="num-wrap">
                        <span
                          className={
                            'num' + (s.status === 'working' ? ' live' : s.attention ? ' attn' : '')
                          }
                          title={keyLabel(`Ctrl ${paneNumber}`)}
                        >
                          {paneNumber}
                        </span>
                      </span>
                    )}
                    {/* Which MACHINE this pane's agent is running on, when it is not this
                        one. The pane header has said so since mirroring shipped, and that
                        is one click too far: the list is where you decide which pane to
                        open, so the list is where "this one is not on this laptop" has to
                        be readable.

                        An icon and not a chip, and up here rather than on the line below.
                        The sub-line is 190px and is already one fact short of what it is
                        asked to carry - measured with card-fit-test at that width, the
                        place chip and a lane chip together squeezed `.row-agent` to 0px
                        and the card stopped saying which agent it was running. A device
                        NAME is the longest string on either line (`DESKTOP-CMSUCM1`), so
                        putting it there would cost the same fact again. The title line
                        holds a key, a name and a right-aligned clock, and 14px between the
                        key and the name is room it already has. The name is on the hover,
                        with what mirroring does and does not move. */}
                    {s.remote && (
                      <span
                        className="row-remote"
                        title={`Running on ${s.remote.name}. Keystrokes go there; the agent, the folder and the transcript stay there too.`}
                      >
                        <RemoteIcon size={13} />
                      </span>
                    )}
                    {/* The whole place, on the name, so hiding the chip below (when it
                        would only repeat this name) loses no fact - the folder, the
                        branch and the pane number are all still one hover away. */}
                    <span
                      className="row-name"
                      title={describePlace({ cwd: s.cwd, lane: s.lane, pane: paneNumber }).full}
                    >
                      {s.title}
                    </span>
                    {/* The clock lives up HERE, at the far end of the name, because this
                        line has spare room and the line below it has none: a lane card's
                        sub-line wanted 214px of the 190px it has, and every arrangement
                        that fits five facts into 190px destroys one of them. The title
                        line holds a key, a name and nothing else, and a right-aligned
                        clock is where every mail client has put one for thirty years.
                        Counts only while the agent is working: a clock that ran from
                        launch ticked through an idle night and read as "still busy". */}
                    {/* A question on screen is the one quiet pane that is quiet because it
                        is owed something, and every "is it idle" reading in the app says
                        yes about it - so it looked exactly like a pane that finished. The
                        card glows red (`asking` below) and this is the word that glow is
                        allowed to have: the ring on its own is what made the old blue lane
                        glow "confusing", so the colour never travels without a word and a
                        hover carrying the question itself.

                        On the TITLE line, not the sub-line: the sub-line already wanted
                        214px of 190px on a lane card (card-fit-test.mjs) and this line has
                        room to spare. */}
                    {s.ask && (
                      <span
                        className="chip asks"
                        title={
                          `${s.ask.question}\n\n` +
                          s.ask.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') +
                          (s.autoAnswerAt
                            ? '\n\nThis is about to be answered for you. Press an answer, or arrow at the pane, to cancel it. Settings -> Answer an agent’s question for me.'
                            : s.autoAnswerHeld
                              ? '\n\nThis would be answered for you, and nothing is pressed while you are looking at this window. Look away and the wait starts. Settings -> Answer an agent’s question for me.'
                              : '\n\nNothing runs until this is answered. Open the pane and press one.')
                        }
                      >
                        asks you
                        {/* ...and, when it is about to be answered for you, how long is
                            left - INSIDE this box rather than in a second one beside it.
                            "asks you" and the seconds are one fact a step apart, and two
                            red boxes on a 190px title line read as two readings. */}
                        {s.autoAnswerAt ? (
                          <AskClock at={s.autoAnswerAt} />
                        ) : s.autoAnswerHeld ? (
                          // A held question has no deadline to draw - `refreshAutoPlan`
                          // writes `autoAnswerAt = 0` while the desk has focus, and
                          // leaving the window starts the whole wait again - so a number
                          // here would be a second that never arrives. But the card is
                          // only ever LOOKED at from this window, which is exactly when
                          // the hold is on, so "asks you" with an empty box beside it was
                          // the only state Robert ever saw and it read as a broken timer.
                          // The word goes in the same box the seconds use, not in a
                          // second chip: two red boxes on the title line are two readings.
                          <span className="asks-in">hold</span>
                        ) : null}
                      </span>
                    )}
                    {/* ...and when this pane is on its way OUT rather than waiting for
                        anybody: how long is left, and the press that stops it. Never
                        beside a question or a move - a pane holding either is refused by
                        `idleCloseAt` outright, so the three can never be true at once. */}
                    {s.closingAt ? (
                      <CloseClock at={s.closingAt} onKeep={() => keepOpen([s.id])} />
                    ) : pinned[s.id] ? (
                      // A switch with no reading is a switch nobody can tell they pressed:
                      // pinning a pane removes the only thing on the card that was about
                      // the idle clock, so it takes that place rather than leaving a gap.
                      <button
                        type="button"
                        className="chip kept"
                        title="This pane is never closed for being idle. Press to put it back on the clock."
                        onClick={(e) => {
                          e.stopPropagation()
                          togglePin(s.id)
                        }}
                      >
                        kept open
                      </button>
                    ) : null}
                    {/* A pane on its way out says so, and says it here for the same reason
                        the chip above is here: the sub-line has no room and this is
                        transient - it takes the clock's place for the few seconds a move
                        lasts, or for as long as a queued pane's turn runs. It cannot appear
                        beside "asks you": a pane holding a question is never moved. */}
                    {s.handingOff ? (
                      s.handoffQueuedAt ? (
                        // Waiting for its own turn to end, which is as long as the agent
                        // takes. Drawn as a clock rather than as the word `moving`: a
                        // ten-minute build under a chip that says moving reads as a broken
                        // handoff, which is exactly how three of these were reported.
                        // ...and it is the control that undoes it. The wait is minutes
                        // long by construction, so the chip that reports it is the one
                        // place somebody is already looking when they change their mind.
                        <button
                          type="button"
                          className="chip"
                          title="Waiting for this turn to end, then it moves to the paired device. Nothing is killed to make it happen, and it gives up rather than interrupting. Press to keep it here."
                          onClick={(e) => {
                            e.stopPropagation()
                            stopMove(s)
                          }}
                        >
                          waiting <Elapsed since={s.handoffQueuedAt} title="Queued for a move" />
                        </button>
                      ) : (
                        <span
                          className="chip"
                          title="Moving to a paired device now."
                        >
                          moving
                        </span>
                      )
                    ) : s.asleep ? (
                      // Before the exited chip, and a BUTTON: a sleeping pane wears
                      // `status: 'exited'` (see `Session.asleep`), and the one thing
                      // anybody wants to do to it is the press that gives it back.
                      <AsleepChip at={s.asleep} id={s.id} />
                    ) : s.status === 'exited' ? (
                      <span className="chip dead">exited {s.exitCode ?? ''}</span>
                    ) : s.runSince ? (
                      <Elapsed since={s.runSince} title="This turn" />
                    ) : s.lastRunMs !== undefined ? (
                      <span className="elapsed done" title="Last turn">
                        {formatElapsed(s.lastRunMs)}
                      </span>
                    ) : null}
                    {/* What the pane is still RUNNING with its turn over. This is the one
                        card state Robert reported as a lie: an agent that started work in
                        the background goes quiet, the clock stops, and the card reads
                        finished while a build or a tail is going. It sits on the clock's
                        own line rather than in `.row-sub`, which is already three chips
                        deep at 190px (see the notes there) - and it is drawn only when
                        there IS something, which on an ordinary card is never.
                        Cosmetic: `shared/paneBackJobs.ts` feeds no busy reading. */}
                    {(() => {
                      const jobs = usage?.panes[s.id]?.jobs
                      if (!jobs?.length) return null
                      return (
                        <span
                          className="chip jobs"
                          title={
                            'Still running with the turn over:\n' +
                            jobs
                              .map(
                                (j) =>
                                  `  ${j.label}` +
                                  (j.elapsed ? `, ${formatElapsed(j.elapsed * 1000)}` : '')
                              )
                              .join('\n')
                          }
                        >
                          {jobWords(jobs)}
                        </span>
                      )
                    })()}
                  </div>
                )}
                <div className="row-sub">
                  <AgentLogo id={s.agent} spec={agents.find((a) => a.id === s.agent)} size={12} />
                  {/* The one thing on this line that may be cut short. A bare text node is
                      an anonymous flex item with no min-width of its own, so it held the
                      line at its full width and pushed the clock out of the clipped box
                      instead - measured: 51px pill, 15px of it on screen. */}
                  <span className="row-agent">
                    {agents.find((a) => a.id === s.agent)?.label ?? s.agent}
                  </span>
                  {s.model ? (
                    <span className="chip" title={s.model}>
                      {agentModelLabel(agents.find((a) => a.id === s.agent), s.model)}
                    </span>
                  ) : null}
                  {/* Which project this pane is in, which the card never said.
                      The title is whatever the pane was named - `basename(cwd)` by
                      default, which for a worktree copy is `PaneForge-w2`, and anything
                      at all once somebody renames it. So the project is stated rather
                      than inferred from the title, and a copy carries the number that
                      switches to it. No branch here: the sidebar has no git poll of its
                      own, and adding one per card to print `master` would be a `git
                      status` per pane for a word that says nothing. The pane header's
                      badge, which already polls, carries the branch. */}
                  {(() => {
                    const place = describePlace({ cwd: s.cwd, lane: s.lane, pane: paneNumber })
                    const inLane = place.kind === 'lane'
                    // Usually the lane this chat HOLDS and the lane this pane is OPEN in
                    // are one checkout, and then two chips were drawn for it. This one is
                    // the useful half - it opens the lane's dialog - so it takes the other
                    // one's colour and its word, and the other one is not drawn at all.
                    const held = laneOfSession(lanesByPane, s.id)
                    const heldHere = held ? samePath(held.dir, s.cwd) : false
                    const laneMark = !heldHere
                      ? ''
                      : held!.conflicted
                        ? ' stuck'
                        : held!.ready
                          ? ' done'
                          : laneBusy(held!)
                            ? ' busy'
                            : ''
                    // A chip that repeats the line above it, and costs the line below it a
                    // word. A pane is named `basename(cwd)` by default, so on an ordinary
                    // card the title already IS the project - `taskdriver.ai` written
                    // twice, once as the name and once as a chip. Measured at the real
                    // 260px list width with the shipped stylesheet: that chip plus a lane
                    // chip squeezed `.row-agent` to 0px, so the card said which project it
                    // was in twice and which agent it was running not at all. Dropping it
                    // gives the name 67.4px back, which is "Claude Code" in full.
                    //
                    // Kept whenever it is saying something new: a renamed pane, a lane
                    // (whose label is not the folder name and whose chip is also the way
                    // into the lane dialog), a copy. The full sentence is on the title
                    // either way, so nothing is lost, only unrepeated.
                    if (!inLane && place.short.trim() === s.title.trim()) return null
                    // In a lane the project name is on this line for the THIRD time - the
                    // pane's own title says it, this chip said `PaneForge · lane a`, and
                    // the lane chip beside it said `lane a` again. Measured with
                    // scripts/card-fit-test.mjs at the real 190px sub-line: the line wanted
                    // 313px, so the place chip was drawn 34px wide out of 99 and the agent's
                    // name 46px out of 67 - Robert's "Claude Code text is hidden when a lane
                    // is being used", reported for the second time. The project is dropped
                    // whenever the title above has already printed it, which is the ordinary
                    // case; it comes straight back on a renamed pane.
                    const named = s.title.trim().includes(place.project)
                    return (
                      <button
                        className={'chip place' + (inLane ? ' lane-chip' : '') + laneMark}
                        title={
                          place.full +
                          (inLane
                            ? '\n\nIts own checkout, so this pane cannot clash with the other one open on this project.\nClick to see what is in it, or to merge it back.'
                            : '')
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          if (inLane) {
                            // This button sits inside the session card and names the
                            // checkout that session is running in. Opening its details
                            // without selecting the session made the most explicit
                            // PaneForge-a target feel dead whenever another pane was up.
                            setActiveId(s.id)
                            handheld.showPane()
                            setLaneCwd(s.cwd)
                          }
                        }}
                      >
                        {inLane && named ? place.role : place.short}
                        {laneMark === ' done' ? ' done' : laneMark === ' stuck' ? ' stuck' : ''}
                      </button>
                    )
                  })()}
                  {/* The dev lane this chat holds, if it holds one. Same fact the sidebar
                      used to repeat in a second list of the same sessions.

                      `paneProject` is why the chip beside it does not say the project name
                      a second time: the button above has just printed it, and two chips in
                      a row reading `taskdriver.ai` then `taskdriver.ai · lane b` read as
                      two facts about two things. It comes back the moment the lane is a
                      copy of some OTHER project than the one this pane is open in, which
                      happens: a chat opened in `assistant` can hold Toolstash's lane c. */}
                  {/* ...and only when it is a DIFFERENT checkout from the one this pane is
                      open in. A chat in `assistant` can hold Toolstash's lane c, and that
                      is the case this chip exists for; the ordinary case - the pane sitting
                      in the very lane its chat holds - is one fact, and the place chip
                      above now carries it, colour and all. */}
                  {(() => {
                    const held = laneOfSession(lanesByPane, s.id)
                    if (!held || samePath(held.dir, s.cwd)) return null
                    return (
                      <LaneChip
                        lane={held}
                        paneProject={describePlace({ cwd: s.cwd, lane: s.lane }).project}
                        onHelp={() => setLaneHelp(true)}
                      />
                    )
                  })()}
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
                title={keyLabel('Close session (Ctrl W)')}
                onClick={(e) => {
                  e.stopPropagation()
                  close(s.id)
                }}
              >
                x
              </button>
            </div>
  )

  return (
    <BlurbContext.Provider value={blurbs}>
    <AutoTick at={soonestAuto} tick={autoTick} />
    <div className="app">
      <aside className="sidebar">
        <LinkBanner />
        <div className="brand">
          <span className="brand-name">
            <AppLogo size={17} />
            PaneForge
          </span>
          <span className="icons">
            <button className="icon" title={keyLabel('Settings (Ctrl ,)')} onClick={() => setSettings(true)}>
              ⚙
            </button>
            <button
              className="icon help"
              title={keyLabel('Every shortcut and what it does (F1 or Ctrl /)')}
              onClick={() => setHelp(true)}
            >
              ?
            </button>
          </span>
        </div>

        <button className="primary" onClick={() => setPicking(true)}>
          <span className="plus">+</span> New session <span className="kbd">{keyLabel('Ctrl T')}</span>
        </button>
        <button className="ghost search-btn" onClick={() => setPalette(true)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Search sessions and actions <span className="kbd">{keyLabel('Ctrl K')}</span>
        </button>

        {/* Icons, not words. Three labels already wrapped on a narrow sidebar and a
            fourth would not have fitted at all; a fixed-width row has room to grow and
            reads faster once you know it. Every one keeps its full sentence on hover. */}
        <div className="quick">
          {/* Sessions are always grouped by state, so the fleet icon shows waiting panes. */}
          <span
            className={'ghost quick-btn' + (needsYou ? ' live' : '')}
            title={
              (needsYou
                ? `${needsYou} ${needsYou === 1 ? 'pane wants' : 'panes want'} you. `
                : '') + 'Sessions are grouped by state in the list below.'
            }
          >
            <FleetIcon />
            {needsYou > 0 && <span className="quick-dot" />}
          </span>
          <button
            className="ghost quick-btn"
            title={keyLabel('Swarm: several agents on one mission (Ctrl Shift S)')}
            onClick={() => setSwarm(true)}
          >
            <SwarmIcon />
          </button>
          <button
            className="ghost quick-btn"
            title={keyLabel("Board: tasks and shared memory for the focused pane's folder (Ctrl Shift K)")}
            disabled={!activeId}
            onClick={() => {
              const s = sessions.find((x) => x.id === activeId)
              if (s) setBoard(s.cwd)
            }}
          >
            <BoardIcon />
          </button>
          <button
            className="ghost quick-btn"
            title={keyLabel('History: search past sessions (Ctrl H)')}
            onClick={() => setHistory(true)}
          >
            <HistoryIcon />
          </button>
          <button
            className={'ghost quick-btn' + (remoteLive ? ' live' : '')}
            title={
              remoteLive
                ? keyLabel(`Devices: ${remoteLive} connected (Ctrl Shift D)`)
                : keyLabel('Devices: work on another machine’s panes from here (Ctrl Shift D)')
            }
            onClick={() => setDevices(true)}
          >
            <RemoteIcon />
            {remoteLive > 0 && <span className="quick-dot" />}
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

        {/* Only the lanes no open pane accounts for, across every open repo; the rest are
            chips on the session cards below. Renders nothing without a lane-using repo. */}
        <LaneStrip
          boards={laneBoards}
          sessions={sessions}
          onFocus={setActiveId}
          onHelp={() => setLaneHelp(true)}
        />

        <div className="section">
          {/* "Running" read as "these are all busy" on a list of idle panes. */}
          <span className="section-title">
            Sessions ({shownSessions.length}{shownSessions.length === sessions.length ? '' : `/${sessions.length}`})
          </span>
          {/* Badges and the empty-everything button travel together, hard right. One
              wrapper rather than three margin rules: whichever of them are showing, the
              rest keep their place. */}
          <span className="section-tail">
            {/* The desk's total, beside the pane count it belongs to: panes plus the app
                itself, which is the figure that answers "what would quitting give me
                back". The per-pane chips say which one to close; this says whether to
                bother. Only once something is running - a total of "250 MB" over an
                empty desk is a number about nothing. */}
            {usage && usage.totalMb > 0 && sessions.length > 0 && capacity && capacity.level !== 'ok' && (
              <span
                className="badge res"
                title={
                  `${formatMb(usage.panesMb)} in ${sessions.length} pane${sessions.length === 1 ? '' : 's'}, ` +
                  `${formatMb(usage.appMb)} in PaneForge itself, of ${formatMb(usage.machineMb)} on this machine` +
                  (usage.cpuPct === null ? '' : `. ${usage.cpuPct}% of one CPU core in total.`)
                }
              >
                {formatMb(usage.totalMb)}
                {formatCpu(usage.cpuPct) && <span className="res-cpu">{formatCpu(usage.cpuPct)}</span>}
              </span>
            )}
            {working > 0 && (
              <span className="badge run" title="Agents whose own footer says they are still running">
                {working} working
              </span>
            )}
            {waiting > 0 && (
              <span className="badge" title="Turns that finished while you were looking elsewhere">
                {waiting} waiting
              </span>
            )}
            {/* Closing a workspace one Ctrl-W at a time was the tedious half of a day
                ending. Only there when there is something to empty. */}
            {sessions.length > 0 && (
              <button
                className="icon danger section-btn"
                title={
                  sessions.length === 1
                    ? 'Close the last pane - the transcript stays in history'
                    : `Close all ${sessions.length} panes - every run ends, the transcripts stay in history`
                }
                aria-label="Close every session"
                onClick={closeAll}
              >
                <TrashIcon size={13} />
              </button>
            )}
          </span>
        </div>
        {deviceChoices.length > 0 && (
          <label className="device-filter">
            <span>Show</span>
            <select value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)}>
              <option value="all">All devices</option>
              <option value="local">This device</option>
              {deviceChoices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="list" ref={listRef}>
          {groups.map((g) => (
            <Fragment key={g.key}>
              {g.title && (
                <div className={`list-sec sec-${g.key}`}>
                  {g.title}
                  <span className="n">{g.rows.length}</span>
                </div>
              )}
              {g.rows.map((row) => (row.session ? sessionRow(row.session, row.number) : listedRow(row)))}
            </Fragment>
          ))}
          {deskRows.length === 0 && (
            <div className="empty">{keyLabel('No sessions. Ctrl T to start one.')}</div>
          )}
        </div>

        <div className="foot">
          <Segmented
            value={grid ? 'grid' : 'single'}
            onChange={(v) => patchConfig({ grid: v === 'grid' })}
            options={[
              { value: 'single', label: 'Focus', title: keyLabel('One pane at a time (Ctrl G)') },
              { value: 'grid', label: 'Grid', title: keyLabel('Every pane at once (Ctrl G)') }
            ]}
          />
          <button className="ghost small" onClick={saveRunningAsWorkspace} disabled={!sessions.length}>
            Save workspace
          </button>
        </div>
        <VersionBadge />
      </aside>

      <main
        ref={panesRef}
        onTouchStart={(e) => {
          if (!handheld.handheld || handheld.listOpen) return
          const t = e.touches[0]
          // Anywhere in the pane, not the left 28px. That edge is the one strip of the
          // screen a phone browser has already taken for its OWN back gesture, so the
          // swipe this app was listening for was the swipe it was least likely to be
          // given - "swipe left doesn't always work". A gesture starting further in is
          // nobody else's, and the pane underneath has no horizontal scroll to lose:
          // a terminal scrolls up and down.
          swipeFrom.current = { x: t.clientX, y: t.clientY }
        }}
        onTouchEnd={(e) => {
          const from = swipeFrom.current
          swipeFrom.current = null
          if (!from) return
          const t = e.changedTouches[0]
          const dx = t.clientX - from.x
          const dy = Math.abs(t.clientY - from.y)
          // Clearly sideways, and clearly more sideways than up: a drift-heavy diagonal is
          // somebody scrolling the buffer, and closing the pane under them is worse than
          // making them swipe again.
          if (dx > 60 && dy < 70 && dx > dy * 1.6) handheld.showList()
        }}
        className={'panes' + (tiled ? ' grid' : '')}
        style={
          tiled
            ? { gridTemplateColumns: template(sizes.cols), gridTemplateRows: template(sizes.rows) }
            : undefined
        }
      >
        {/* The way back to the list on a phone. Rendered rather than styled into
            existence because it has to sit above the pane's own overlays, and it is the
            only control on the screen while a pane has the whole display. */}
        {handheld.handheld && !handheld.listOpen && (
          <button className="handheld-back" onClick={handheld.showList} aria-label="Back to panes">
            <span aria-hidden="true">‹</span> Panes
          </button>
        )}
        {/* And the way to talk to it: a phone keyboard composes a line better than
            xterm's hidden textarea ever lets it. */}
        {handheld.handheld && !handheld.listOpen && activeId && <HandheldType id={activeId} />}
        {/* One grab strip per line between two tracks, laid over the gap. Absolutely
            positioned rather than made of grid cells, because a CSS grid gap is not
            addressable - and it means the strip can be wider than the 9px gap it sits in
            without taking a single pixel away from any pane. */}
        {tiled &&
          box.w > 0 &&
          sizes.cols.slice(0, -1).map((_, i) => (
            <div
              key={`c${i}`}
              className="grid-divider col"
              // In "big top" the first row is one pane across the whole width, so a column
              // divider drawn the full height of the grid would be a grab strip lying over
              // it that resizes nothing it is touching. It starts below that pane instead.
              style={{
                left: box.padX + dividerPx(sizes.cols, box.w, box.gap, i),
                top: layout === 'main-top' ? box.padY + trackPx(sizes.rows, box.h, box.gap)[0] : undefined
              }}
              onPointerDown={(e) => dividerDrag(e, 'cols', i)}
              onDoubleClick={() => dividerReset('cols')}
              title="Drag to resize these columns. Double-click to put them back."
            />
          ))}
        {tiled &&
          box.h > 0 &&
          sizes.rows.slice(0, -1).map((_, i) => (
            <div
              key={`r${i}`}
              className="grid-divider row"
              // Same, the other way round: "big left" has one pane down the whole left
              // column, and these lines only divide the stack to the right of it.
              style={{
                top: box.padY + dividerPx(sizes.rows, box.h, box.gap, i),
                left:
                  layout === 'main-left' ? box.padX + trackPx(sizes.cols, box.w, box.gap)[0] : undefined
              }}
              onPointerDown={(e) => dividerDrag(e, 'rows', i)}
              onDoubleClick={() => dividerReset('rows')}
              title="Drag to resize these rows. Double-click to put them back."
            />
          ))}
        {sessions.map((s, i) => (
          // Every pane stays mounted so its scrollback survives tab switches;
          // unmounting the xterm instance would blank the session.
          <div
            key={s.id}
            data-id={s.id}
            className={
              'pane' +
              (visibleIds.has(s.id) ? '' : ' hidden') +
              (tiled && s.id === activeId ? ' focused' : '') +
              (s.id === movingId ? ' moving' : '') +
              (s.id === dropId ? ' drop-target' : '') +
              // Every pane in the group is outlined while synchronised typing is on.
              // A mode that silently sends your keys somewhere else has to be visible
              // from the pane you are looking at, not from a menu.
              (syncTyping ? ' synced' : '')
            }
            // The agent's brand colour drives this pane's accent, so a grid of four
            // panes is readable without checking the labels. The cell is set explicitly
            // rather than left to auto-placement, because two of the five layouts have a
            // pane that spans a whole axis and auto-placement cannot say so.
            style={
              {
                '--agent': agents.find((a) => a.id === s.agent)?.color ?? '#8b8b99',
                ...(tiled && plan.cells[i]
                  ? {
                      gridColumn: `${plan.cells[i].col} / span ${plan.cells[i].colSpan}`,
                      gridRow: `${plan.cells[i].row} / span ${plan.cells[i].rowSpan}`
                    }
                  : null)
              } as React.CSSProperties
            }
            onMouseDown={() => {
              touchPane(s.id)
              setActiveId(s.id)
            }}
          >
            <div
              className={'pane-title' + (tiled ? ' draggable' : '')}
              onPointerDown={(e) => beginPaneMove(e, s.id)}
            >
              <StatusDot status={s.status} engaged={s.engaged} />
              <AgentLogo id={s.agent} spec={agents.find((a) => a.id === s.agent)} size={14} />
              <span className="pt-name" onDoubleClick={() => setRenaming(s.id)}>
                {s.title}
              </span>
              {s.remote && (
                <span
                  className="chip remote"
                  title={`Running on ${s.remote.name}. Keystrokes go there; the agent, the folder and the transcript stay there too.`}
                >
                  <LinkIcon size={11} />
                  {s.remote.name}
                </span>
              )}
              {s.role && <span className="chip role">{s.role}</span>}
              {/* What this pane costs, measured off its pty's whole process tree - so a
                  pane that started a build reports the build, which is the whole point.
                  Memory always, CPU only above 1%: a row of live-looking 0% is the same
                  noise as a status line that never changes. Absent for a mirrored pane,
                  whose agent is a process on the other machine. */}
              {usage?.panes[s.id] && (
                <span
                  className={
                    'chip res' +
                    ((usage.panes[s.id].cpuPct ?? 0) >= 90 ? ' hot' : '') +
                    (usage.panes[s.id].rssMb >= 2048 ? ' heavy' : '')
                  }
                  title={
                    `This pane holds ${formatMb(usage.panes[s.id].rssMb)} across ` +
                    `${usage.panes[s.id].procs} process${usage.panes[s.id].procs === 1 ? '' : 'es'}` +
                    (usage.panes[s.id].cpuPct === null
                      ? ''
                      : `, and is using ${usage.panes[s.id].cpuPct}% of one CPU core`) +
                    '. The agent and anything it started are both counted.'
                  }
                >
                  {formatMb(usage.panes[s.id].rssMb)}
                  {formatCpu(usage.panes[s.id].cpuPct) && (
                    <span className="res-cpu">{formatCpu(usage.panes[s.id].cpuPct)}</span>
                  )}
                </span>
              )}
              {/* The worktree chip used to live here, beside a git badge that printed
                  `master`: two chips about one place, neither of which named the place.
                  Both are the badge's job now - it is the thing that already knows the
                  branch. */}
              {/* The sound has already gone; this is the part that is still there when
                  you come back to the room. Both clear themselves the moment you look
                  at the pane, which is what `clearAttention` already meant. */}
              {s.bell && (
                <span className="chip bell" title="This pane rang the terminal bell - the CLI is asking for you">
                  🔔
                </span>
              )}
              {s.stalledSince !== undefined && (
                <span
                  className="chip stalled"
                  title="Still running, but it has printed nothing for a while - it may be stuck, or waiting for an answer"
                >
                  quiet <Elapsed since={s.stalledSince} />
                </span>
              )}
              {/* A tee is invisible by design - the file is somewhere else and nothing
                  about the pane changes - so the pane says it out loud, and the same
                  chip stops it. `dropped` is only ever non-zero when the thing reading
                  the file cannot keep up, which is worth knowing at a glance. */}
              {s.piping && (
                <button
                  className={'chip piping' + (s.piping.dropped ? ' behind' : '')}
                  title={
                    `Writing this pane's output to ${s.piping.path}` +
                    (s.piping.text ? ' (plain text)' : '') +
                    (s.piping.dropped
                      ? ` - ${kb(s.piping.dropped)} dropped: whatever is reading it cannot keep up`
                      : '') +
                    '. Click to stop.'
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    void togglePipe(s, false)
                  }}
                >
                  ⇥ {kb(s.piping.bytes)}
                </button>
              )}
              {/* A mirrored folder is on the other machine, so there is no repo here
                  to read a branch off - the badge would either be blank or, worse,
                  show this machine's checkout of a path that happens to match. */}
              {!s.remote && (
                <GitBadge
                  cwd={s.cwd}
                  active={visibleIds.has(s.id)}
                  lane={s.lane}
                  pane={sessions.findIndex((x) => x.id === s.id) + 1 || undefined}
                  onOpen={() =>
                    setDiff({
                      cwd: s.cwd,
                      lane: s.lane,
                      pane: sessions.findIndex((x) => x.id === s.id) + 1 || undefined,
                      // A lane is a whole piece of work and is read as one; a pane on the
                      // main checkout is being asked the narrower question, "what has this
                      // agent done that I have not committed".
                      scope: s.lane ? 'all' : 'working'
                    })
                  }
                />
              )}
              {/* What tmux puts in the pane border: the branch (above), the model (the
                  picker, to the right) and how long this has been going. The sidebar has
                  said the last of those for months, and the sidebar is the thing you are
                  not looking at in a grid of four - "which of these is still working" is
                  a question about the pane, asked at the pane. */}
              {/* How long this PANE has been open, which is a different question from the
                  clock beside it and the one nothing on screen answered. The turn clock
                  resets every time the agent finishes, and `/clear` throws the
                  conversation away without touching the pty - so a window somebody has
                  had open since yesterday morning read `12s` and there was nowhere to
                  find out otherwise but the info sheet.

                  It costs one render a minute per pane, not one a second: `Elapsed` asks
                  the shared timer for the step it actually draws (`stepFor`), and past an
                  hour that is a minute. Off the header on a phone, where the header is
                  404px and says only WHICH pane this is. */}
              {!handheld.handheld && s.status !== 'exited' && (
                <Elapsed
                  since={s.openedAt ?? s.createdAt}
                  className="elapsed pt-open"
                  title={`Open for - since ${new Date(s.openedAt ?? s.createdAt).toLocaleString()}. Not the turn, and a /clear does not reset it.`}
                />
              )}
              {s.asleep ? (
                <AsleepChip at={s.asleep} id={s.id} />
              ) : s.status === 'exited' ? (
                <span className="chip dead">exited {s.exitCode ?? ''}</span>
              ) : s.runSince ? (
                <Elapsed since={s.runSince} className="elapsed pt-clock" title="This turn" />
              ) : s.lastRunMs !== undefined ? (
                <span className="elapsed done pt-clock" title="Last turn">
                  {formatElapsed(s.lastRunMs)}
                </span>
              ) : null}
              <span className="pt-path">{s.cwd}</span>
              <span className="pt-actions">
                {/* The header is 404px on a phone and this picker alone is ~150 of it, so
                    on a touch-sized screen it moves into the ⋯ sheet with the actions -
                    where it is a labelled control rather than the reason Close is drawn
                    off the edge of the screen. */}
                {!handheld.handheld && (
                  <AgentPicker
                    small
                    agents={agents}
                    agent={s.agent}
                    model={s.model ?? ''}
                    onInstalled={() => void api.listAgents().then(setAgents)}
                    onChange={(a, m) => switchAgent(s, a, m)}
                  />
                )}
                {/* Search has been Ctrl/Cmd+F since it shipped, and a shortcut with nothing
                    on screen is a feature only the person who built it knows about. The
                    icon is the discoverable half of the same thing - it opens the pane's
                    own find bar, which already highlights every match, counts them (`3/10`)
                    and steps through them with ↑ ↓. On a phone it is in the ⋯ sheet instead,
                    where the header has room for the pane's name and nothing else. */}
                {!handheld.handheld && (
                  <button
                    className="icon pt-find"
                    title="Find in this pane (Ctrl/Cmd F)"
                    aria-label={`Find in ${s.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      // The pane has to be the active one first: the find bar is drawn in
                      // the pane it belongs to, and typing into it while another pane holds
                      // the keyboard is the "why is my search going somewhere else" bug.
                      setActiveId(s.id)
                      paneFind.get(s.id)?.()
                    }}
                  >
                    <SearchIcon size={13} />
                  </button>
                )}
                {/* One target instead of six. Everything below is still rendered on a
                    desktop window; on a phone the sheet is the only way to any of it. */}
                {handheld.handheld && (
                  <button
                    className="icon pt-more"
                    aria-label={`Actions for ${s.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPaneMenu(s.id)
                    }}
                  >
                    ⋯
                  </button>
                )}
                {/* Beside the runner and its model, because it is the same question asked
                    one step further out - WHERE this agent runs - and not another icon in
                    the row of six that all act on the pane in front of you. */}
                {!s.remote && s.status !== 'exited' && (
                  <button
                    className="ghost small desk-only pt-handoff"
                    title={
                      s.lane
                        ? `Hand off lane ${s.lane}: its pane moves to your paired PC, then that PC closes when this lane exits and it has no other local pane.`
                        : `Hand off ${s.title} to your paired PC. The PC closes only after this pane exits and it has no other local pane.`
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      const ids = s.lane
                        ? sessions.filter((x) => !x.remote && x.lane === s.lane && x.cwd === s.cwd).map((x) => x.id)
                        : [s.id]
                      setHandoff({
                        ids,
                        title: s.lane ? `lane ${s.lane}` : s.title,
                        busy: s.status === 'working' || s.status === 'starting',
                        asking: Boolean(s.ask)
                      })
                    }}
                  >
                    Hand off
                  </button>
                )}
                {/* The same question from the other side of it. Drawn in the same slot as
                    `Hand off` because it is the same decision - WHERE this agent runs -
                    and a mirrored pane had no answer to it at all until now. */}
                {s.remote && s.status !== 'exited' && (
                  <button
                    className="ghost small desk-only pt-handoff"
                    title={`Bring ${s.title} back from ${s.remote.name}: its repo goes up as an auto-sync commit, the conversation and screen come over the link, and the pane reopens here. Mid-turn it comes back when the turn ends.`}
                    onClick={(e) => {
                      e.stopPropagation()
                      bringHere(s)
                    }}
                  >
                    Bring here
                  </button>
                )}
                {/* Clears the agent's context and keeps the run. Where the mic used to
                    be, which is why the mic moved down to the prompt it dictates into:
                    the two got clicked for each other up here. */}
                <button
                  className="icon danger pt-clear"
                  title={`Clear ${s.title}: runs /clear in this pane. The run keeps going; its memory of this conversation does not.`}
                  aria-label="Clear this session"
                  onClick={(e) => {
                    e.stopPropagation()
                    clearPane(s)
                  }}
                >
                  <TrashIcon size={13} />
                </button>
                {/* Only in the grid, where it means something - and it stays on screen
                    while zoomed, because a button that vanishes once it has been used is
                    a window with no way back out of it except a shortcut. */}
                {grid && (
                  <button
                    className={'icon pt-zoom' + (zoom === s.id ? ' on' : '')}
                    title={keyLabel(
                      zoom === s.id
                        ? 'Back to the grid (Ctrl Shift Z)'
                        : 'Zoom this pane to the whole window (Ctrl Shift Z)'
                    )}
                    aria-label={zoom === s.id ? 'Back to the grid' : 'Zoom this pane'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleZoom(s.id)
                    }}
                  >
                    {zoom === s.id ? '⤡' : '⤢'}
                  </button>
                )}
                <button
                  className="icon pt-restart"
                  title={keyLabel('Restart agent (Ctrl Shift R)')}
                  onClick={() => api.restartSession(s.id)}
                >
                  ⟳
                </button>
                <button
                  className="icon fix"
                  title={keyLabel('Fix the display: refit and repaint, keeping the run (Ctrl Shift L)')}
                  onClick={() => fixUi(s.id)}
                >
                  Fix
                </button>
                {/* Both of these open something on THIS machine. For a mirrored pane
                    the folder is on the other one, so they would open the wrong thing
                    or nothing at all - better absent than quietly wrong. */}
                {/* `desk-only` because they are also useless at phone width, for the same
                    reason they are absent on a mirror: they open a window on the machine
                    you are not holding. Dropping them is what lets Close fit on screen. */}
                {!s.remote && (
                  <button
                    className="icon desk-only pt-reveal"
                    title={
                      /* A lane is a worktree and its untracked files are swept with it,
                         so this opens the PROJECT. Dropping a file where the agent can
                         read it is what dragging onto the pane is for. */
                      `Open this project in Explorer - to reach the agent, drag files onto this pane`
                    }
                    onClick={() =>
                      void api.revealProject(s.cwd).then((p) => p || flash('That folder is gone.'))
                    }
                  >
                    📁
                  </button>
                )}
                {!s.remote && (
                  <button
                    className="icon desk-only"
                    title="Open in editor"
                    onClick={() => api.openInEditor(s.cwd).then((err) => err && flash(err))}
                    data-pt="editor"
                  >
                    ✎
                  </button>
                )}
                <button
                  className="icon pt-close"
                  title={keyLabel('Close (Ctrl W)')}
                  aria-label={`Close ${s.title}`}
                  onClick={() => close(s.id)}
                >
                  ×
                </button>
              </span>
            </div>
            <TerminalPane
              sessionId={s.id}
              cwd={s.cwd}
              visible={visibleIds.has(s.id)}
              active={s.id === activeId}
              fontSize={config?.fontSize ?? 13}
              copyOnSelect={config?.copyOnSelect ?? true}
              clickMovesCursor={config?.clickMovesCursor ?? true}
              mouseSelect={config?.mouseSelect ?? true}
              autoFixUi={config?.autoFixUi ?? true}
              termTheme={termColors}
              // The question this pane is sitting on, read in the main process so the
              // desk, a phone and a bot are all answering the same reading of it.
              ask={s.ask}
              autoAnswerAt={s.autoAnswerAt}
              autoAnswerN={s.autoAnswerN}
              autoAnswerHeld={s.autoAnswerHeld}
              // Which CLI is in here, so a dropped image can be handed to the ones that
              // read an image off the clipboard and typed as a path to the ones that do not.
              agent={s.agent}
              // A copy out of a pane is silent by construction - the clipboard gives no
              // feedback - so the pane says so in the window's own toast rather than
              // growing a second one of its own.
              onToast={flash}
              // A mirrored pane is drawn at the far machine's grid, not fitted to this
              // window: two devices cannot both own one terminal's size.
              mirror={s.remote && s.cols && s.rows ? { cols: s.cols, rows: s.rows } : null}
              // ...and a LOCAL pane a phone is currently holding is drawn the same way,
              // at the pty's grid rather than at this window's width. The pty cannot be
              // both shapes, the phone is the screen being looked at, and a desk drawing
              // 157 columns into a 50-column pty wraps every line of the agent's frame.
              // Not `mirror`: this pane's pty is still ours, and everything else a mirror
              // implies (no busy reading, no local clipboard) is wrong for it.
              grid={!s.remote && s.borrowed && s.cols && s.rows ? { cols: s.cols, rows: s.rows } : null}
              // The pty's CONFIRMED grid, whoever owns it. A pane shrinking asks for a
              // narrower pty and waits to see it here before narrowing its own terminal -
              // going the other way round paints the agent's next frame at the old width
              // into the new grid, where every column move clamps. See shrinkFirst.ts.
              pty={!s.remote && s.cols && s.rows ? { cols: s.cols, rows: s.rows } : null}
              // A restored pane replays the screen of the pane it came back from, painted
              // in absolute column moves at THAT pane's width. See shared/replayWidth.ts.
              replayCols={s.replayCols}
              /* Its CLI has not said anything yet. A restored pane is never `blank`, so
                 without this it sat there wearing yesterday's screen and saying nothing
                 for the seconds the agent spends booting. */
              booting={!s.printed && !s.asleep && s.status !== 'exited'}
            />
            {/* The mic floats over the bottom-LEFT of the pane, next to the prompt box
                it types into, instead of hiding in a row of six header icons. Nothing
                is drawn there by any of these CLIs - the prompt box's outer edge is
                empty - and the button is the only thing in the pane that takes a click,
                so the terminal underneath keeps every one of its own. Left rather than
                right because "↓ Newest" owns the bottom-right whenever a pane is scrolled
                up, and the two were landing on the same pixels. */}
            {config?.voice.enabled && (
              <button
                className={
                  'mic-float' +
                  (voice.phase === 'recording' && voice.target === s.id ? ' rec' : '') +
                  (voice.phase === 'thinking' && voice.target === s.id ? ' busy' : '')
                }
                // Every pane owns a mic, so dictating into the third pane does not mean
                // clicking into it first and hoping the focus stuck.
                title={
                  voice.phase === 'recording' && voice.target === s.id
                    ? `Listening - click to transcribe into ${s.title}`
                    : voice.phase !== 'idle'
                      ? 'Already listening for another pane'
                      : keyLabel(`Dictate into ${s.title} (Ctrl Shift Space dictates into the focused pane)`)
                }
                aria-label="Dictate into this pane"
                disabled={voice.phase !== 'idle' && voice.target !== s.id}
                onClick={(e) => {
                  e.stopPropagation()
                  voice.toggle(s.id)
                }}
              >
                {voice.phase === 'thinking' && voice.target === s.id ? '…' : <MicIcon size={15} />}
              </button>
            )}
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="placeholder">
            <div className="ph-logo">
              <AppLogo size={44} />
            </div>
            <h1>PaneForge</h1>
            <p>{keyLabel('Start only the sessions you need. Ctrl T, tick a few projects, Enter.')}</p>
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
            <p className="hint">
              {keyLabel('Ctrl K to search everything. F1 or Ctrl / for every shortcut.')}
            </p>
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
          onDefaultsChange={(agent, model) =>
            patchConfig({
              defaultAgent: agent,
              defaultModels: { ...config.defaultModels, [agent]: model }
            })
          }
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
          initial={settingsFrom ?? undefined}
          onChange={patchConfig}
          onClose={() => {
            setSettings(false)
            setSettingsFrom(null)
          }}
        />
      )}
      {splitting && (
        <SplitDialog
          projects={projects}
          cwd={sessions.find((x) => x.id === activeId)?.cwd}
          onLaunch={(reqs) => {
            setSplitting(false)
            if (!reqs.length) return
            patchConfig({ grid: true })
            start(reqs)
          }}
          onClose={() => setSplitting(false)}
        />
      )}
      {swarm && config && (
        <SwarmDialog
          projects={projects}
          agents={agents}
          roles={config.swarmRoles}
          defaultModels={config.defaultModels}
          onSaveRoles={(swarmRoles: SwarmRole[]) => patchConfig({ swarmRoles })}
          onClose={() => {
            setSwarm(false)
          }}
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
      {devices && (
        <RemoteDialog
          state={remote}
          onState={setRemote}
          flash={flash}
          onClose={() => setDevices(false)}
        />
      )}
      {history && (
        <HistoryDialog
          agents={agents}
          onResume={(e: HistoryEntry) => {
            setHistory(false)
            // With the id, not just `resume: true`: without one the CLI resumes the newest
            // conversation in that folder, which after the pane closed is somebody else's.
            start([
              { cwd: e.cwd, title: e.title, agent: e.agent, model: e.model, resume: true, resumeId: e.resumeId }
            ])
          }}
          onClose={() => setHistory(false)}
        />
      )}
      {laneCwd && (
        <LaneDialog
          cwd={laneCwd}
          // The lanes this window already polls, so the dialog can list the OTHER copies
          // of the project without a poll of its own - see LaneDialog's own note.
          boards={laneBoards}
          sessions={sessions}
          onFocus={(id) => {
            setActiveId(id)
            handheld.showPane()
            setLaneCwd(null)
          }}
          onClose={() => setLaneCwd(null)}
          onHelp={() => setLaneHelp(true)}
          onReview={() => {
            const s = sessions.find((x) => x.cwd === laneCwd)
            setDiff({ cwd: laneCwd, lane: s?.lane, scope: 'all' })
          }}
        />
      )}
      {/* Drawn BEFORE the diff on purpose: both are `.overlay`, so the later one in the
          tree is the one on top, and reading a pane's changes has to open OVER the list
          you picked it from rather than under it. */}
      {diff && (
        <DiffDialog
          cwd={diff.cwd}
          lane={diff.lane}
          pane={diff.pane}
          scope={diff.scope}
          onClose={() => setDiff(null)}
        />
      )}
      {laneHelp && (
        <LaneHelp onClose={() => setLaneHelp(false)} boards={laneBoards} sessions={sessions} />
      )}
      {/* A pane's output as selectable text. Over the whole screen, for the same reason
          the action sheet is: what it is for is reading, and a phone's pane is 404px. */}
      {(() => {
        const s = textPane ? sessions.find((x) => x.id === textPane) : null
        if (!s) return null
        return (
          <TextSheet
            sessionId={s.id}
            title={s.title}
            cols={s.cols || 80}
            onToast={flash}
            onClose={() => setTextPane(null)}
          />
        )
      })()}
      {/* The pane header's six actions, at finger size. Rendered here rather than inside
          the pane so the sheet is over the whole screen and not clipped by it. */}
      {(() => {
        const s = paneMenu ? sessions.find((x) => x.id === paneMenu) : null
        if (!s) return null
        const shut = (): void => setPaneMenu(null)
        return (
          <PaneMenu
            title={s.title}
            onClose={shut}
            extra={
              <AgentPicker
                agents={agents}
                agent={s.agent}
                model={s.model ?? ''}
                onInstalled={() => void api.listAgents().then(setAgents)}
                onChange={(a, m) => switchAgent(s, a, m)}
              />
            }
            actions={[
              {
                key: 'copy',
                label: 'Copy output',
                hint: 'the whole terminal',
                icon: '⧉',
                run: () => copyPaneOutput(s)
              },
              {
                key: 'find',
                label: 'Find in this pane',
                hint: 'highlights every match, and steps through them',
                icon: '⌕',
                // The desk has the icon in the header and Ctrl/Cmd F; a phone has neither
                // a header with room in it nor those keys, so the sheet is the only way in.
                run: () => {
                  setActiveId(s.id)
                  paneFind.get(s.id)?.()
                }
              },
              {
                key: 'text',
                label: 'Select text',
                hint: 'read it back, pick out a line, copy it',
                icon: '≡',
                run: () => setTextPane(s.id)
              },
              ...(s.handoffQueuedAt
                ? [
                    {
                      key: 'stop-move',
                      label: 'Keep it here',
                      hint: 'stop the move it is queued for',
                      icon: '⤴',
                      run: () => stopMove(s)
                    }
                  ]
                : []),
              ...(s.remote && s.status !== 'exited'
                ? [
                    {
                      key: 'bring',
                      label: 'Bring it here',
                      hint: 'move it back from that machine',
                      icon: '⤵',
                      run: () => bringHere(s)
                    }
                  ]
                : []),
              ...(grid
                ? [
                    {
                      key: 'zoom',
                      label: zoom === s.id ? 'Back to the grid' : 'Zoom this pane',
                      icon: zoom === s.id ? '⤡' : '⤢',
                      run: () => toggleZoom(s.id)
                    }
                  ]
                : []),
              {
                key: 'fix',
                label: 'Fix the display',
                hint: 'refit and repaint, keeping the run',
                icon: '⌗',
                run: () => fixUi(s.id)
              },
              {
                key: 'restart',
                label: 'Restart agent',
                icon: '⟳',
                run: () => void api.restartSession(s.id)
              },
              {
                key: 'clear',
                label: 'Clear',
                hint: 'runs /clear; the run keeps going, its memory does not',
                icon: <TrashIcon size={14} />,
                danger: true,
                run: () => clearPane(s)
              },
              {
                key: 'close',
                label: 'Close pane',
                icon: '✕',
                danger: true,
                run: () => close(s.id)
              }
            ]}
          />
        )
      })()}
      {/* What the machine is up against, said at the moment it becomes true and then taken
          away. It was a strip in the sidebar that was on screen for as long as the reading
          held, which is most of a working day on a full desk - and a line that is always
          there is a line nobody reads. Robert, 2026-08-24: "i dont really like the message
          memory is tight ... because its showing at all times ... id rather some popup for
          short time with exact overloaded". The exact figure comes with it, which is why
          the total is no longer a permanent badge beside the pane count. */}
      {capacityNote && (
        <div
          className={'cap-pop ' + capacityNote.level}
          role="status"
          title="Press to dismiss"
          onClick={() => setCapacityNote(null)}
        >
          <div className="cap-pop-head">
            {capacityNote.level === 'over' ? 'Out of memory' : 'Memory is tight'}
          </div>
          <div className="cap-pop-body">{capacityNote.advice}</div>
          {capacityNote.numbers && <div className="cap-pop-num">{capacityNote.numbers}</div>}
          {/* The half the card was missing: WHICH pane, and where it would go. A press
              moves it through the same path the automatic sweep uses - named machine, the
              repo pushed as an `auto-sync:` commit, the pane back here as a mirror - and
              the other press says this project's work is Mac-only and never offers it
              again. Both stop the click from dismissing the card underneath them. */}
          {capacityNote.move && (
            <div className="cap-pop-move" onClick={(e) => e.stopPropagation()}>
              <span className="cap-pop-move-say">
                Move {capacityNote.move.pane} to {capacityNote.move.deviceName}?
              </span>
              <button
                className="ghost small"
                title={`Hand this pane to ${capacityNote.move.deviceName}. Its agent, folder and conversation go with it, and it comes straight back here as a mirror.`}
                onClick={() => {
                  const m = capacityNote.move
                  if (!m) return
                  setCapacityNote(null)
                  const cfg = configRef.current?.autoHandoff ?? DEFAULT_AUTO_HANDOFF
                  // Through `runHandoffs` and not through `handoffToDevice` directly: that
                  // is where the peers are re-asked, the sweep lock is taken, and a refusal
                  // is put on the pane's cooldown. Re-deciding on the way rather than
                  // trusting the id this card was drawn with is the point - the pane may
                  // have started a turn since, and then it is QUEUED rather than moved.
                  runHandoffs(
                    handoffPanesRef.current(),
                    (candidates, at) => {
                      const pick = suggestMove(
                        handoffPanesRef.current(),
                        candidates,
                        cfg,
                        handoffBlocked.current,
                        at
                      )
                      return pick && pick.id === m.id ? [pick] : []
                    },
                    'asked on the pressure card',
                    cfg.cooldownMinutes
                  )
                }}
              >
                Move it
              </button>
              <button
                className="ghost small"
                title={`Never move ${capacityNote.move.project} off this machine. For work only this device can do - its own Keychain, its own launchd jobs, a browser on this screen.`}
                onClick={() => {
                  const m = capacityNote.move
                  if (!m) return
                  setCapacityNote(null)
                  const cfg = configRef.current?.autoHandoff ?? DEFAULT_AUTO_HANDOFF
                  if (staysHere(cfg, m.project)) return
                  void api.setConfig({
                    autoHandoff: { ...cfg, keepHere: [...(cfg.keepHere ?? []), m.project] }
                  })
                  flash(`${m.project} stays on this machine now. Settings undoes it.`)
                }}
              >
                Keep it here
              </button>
            </div>
          )}
        </div>
      )}

      {/* Hand off asks one question - which machine - so it gets one box rather than the
          whole Devices screen with a banner over it. */}
      {handoff && (
        <HandoffDialog
          target={handoff}
          peers={remote?.peers ?? []}
          flash={flash}
          onPair={() => {
            setHandoff(null)
            setDevices(true)
          }}
          onClose={() => setHandoff(null)}
        />
      )}
      {/* Right-click on a session card. Same actions as the pane header and the phone's
          sheet, at the place a desktop hand looks for them. */}
      {(() => {
        const s = cardMenu ? sessions.find((x) => x.id === cardMenu.id) : null
        if (!s || !cardMenu) return null
        const paneNumber = sessions.indexOf(s) + 1
        const shut = (): void => setCardMenu(null)
        const local = !s.remote
        return (
          <SessionMenu
            title={s.title}
            x={cardMenu.x}
            y={cardMenu.y}
            onClose={shut}
            items={[
              {
                key: 'pin',
                label: pinned[s.id] ? 'Let it close when idle' : 'Keep this pane open',
                hint: pinned[s.id]
                  ? 'the idle clock may close it again'
                  : 'the idle clock never closes it'
                ,
                run: () => togglePin(s.id)
              },
              ...(local
                ? [
                    s.asleep
                      ? {
                          key: 'wake',
                          label: 'Wake this pane',
                          hint: 'start its agent again, in the same conversation',
                          run: () => void api.wakeSession(s.id)
                        }
                      : {
                          key: 'sleep',
                          label: 'Sleep this pane',
                          // The refusal is the hint, so a greyed row says which of the six
                          // reasons it is - see `sleepRefusal`.
                          hint:
                            sleepRefusal(sleepPaneOf(s, usage?.panes[s.id]?.jobs?.[0]?.label)) ||
                            'give the agent back, keep the card and the screen',
                          disabled: !canSleep(sleepPaneOf(s, usage?.panes[s.id]?.jobs?.[0]?.label)),
                          run: () => void api.sleepSession(s.id)
                        }
                  ]
                : []),
              { key: 'rename', label: 'Rename…', hint: 'or double-click the card', run: () => setRenaming(s.id) },
              { key: 'info', label: 'Session info', hint: 'how long it has been open, what it costs', run: () => setInfo(s.id) },
              ...(s.handoffQueuedAt
                ? [{ key: 'stop-move', label: 'Keep it here', hint: 'stop the move it is queued for', run: () => stopMove(s) }]
                : []),
              ...(local && s.status !== 'exited'
                ? [
                    {
                      key: 'handoff',
                      label: 'Hand off…',
                      hint: 'move it to another machine',
                      run: () =>
                        setHandoff({
                          ids: s.lane
                            ? sessions.filter((x) => !x.remote && x.lane === s.lane && x.cwd === s.cwd).map((x) => x.id)
                            : [s.id],
                          title: s.lane ? `lane ${s.lane}` : s.title,
                          busy: s.status === 'working' || s.status === 'starting',
                          asking: Boolean(s.ask)
                        })
                    }
                  ]
                : []),
              ...(!local && s.status !== 'exited'
                ? [
                    {
                      key: 'bring',
                      label: 'Bring it here',
                      hint: `move it back from ${s.remote?.name ?? 'that machine'}`,
                      run: () => bringHere(s)
                    }
                  ]
                : []),
              { key: 'copy', label: 'Copy output', hint: 'the whole terminal', run: () => copyPaneOutput(s) },
              { key: 'text', label: 'Select text', run: () => setTextPane(s.id) },
              { key: 'fix', label: 'Fix the display', hint: 'refit and repaint, keeping the run', run: () => fixUi(s.id) },
              ...(local
                ? [
                    { key: 'folder', label: 'Open in editor', run: () => void api.openInEditor(s.cwd).then((err) => err && flash(err)) },
                    { key: 'restart', label: 'Restart agent', run: () => void api.restartSession(s.id) }
                  ]
                : []),
              { key: 'clear', label: 'Clear', hint: 'runs /clear; the run keeps going, its memory does not', danger: true, run: () => clearPane(s) },
              { key: 'close', label: 'Close pane', hint: 'the transcript stays in history', danger: true, run: () => close(s.id) }
            ]}
          />
        )
      })()}
      {(() => {
        const s = info ? sessions.find((x) => x.id === info) : null
        if (!s) return null
        return (
          <SessionInfo
            session={s}
            paneNumber={sessions.indexOf(s) + 1}
            agents={agents}
            usage={usage?.panes[s.id]}
            onRename={() => {
              setInfo(null)
              setRenaming(s.id)
            }}
            onClose={() => setInfo(null)}
          />
        )
      })()}
      {ask && (
        <ConfirmDialog
          title={ask.title}
          body={ask.body}
          confirmLabel={ask.confirmLabel}
          cancelLabel={ask.cancelLabel}
          danger={ask.danger}
          input={ask.input}
          check={ask.check}
          onConfirm={ask.onConfirm}
          onCancel={(checked) => {
            setAsk(null)
            ask.onCancel?.(checked)
          }}
        />
      )}
      {(shelfInWindow || shelfSearching) && (
        <RecentsFlyout
          // Only drawn when the floating Stash is off, so a copy never appears in two
          // places at once. The whole lean list - the panel has tabs, search and a
          // scrollbar now, and "the last 12" was why it could never show everything.
          //
          // The exception is a search: the overlay is `focusable: false` and cannot be
          // typed into at all, so its magnifier hands the job here. That is a deliberate
          // press, not a peek, and it closes with the search it opened for.
          items={recents}
          pinned={shelfPinned || shelfSearching}
          searching={shelfSearching}
          peek={shelfPeek}
          onClose={() => {
            setShelfPinned(false)
            setShelfSearching(false)
          }}
          onSend={(it) => {
            sendRecent(it)
            setShelfSearching(false)
          }}
          onSettings={() => {
            setSettingsFrom('stash')
            setSettings(true)
          }}
        />
      )}
      {restore && (
        <RestoreDialog
          offer={restore}
          onRestore={(ids, always) => {
            setRestore(null)
            api.answerRestore({ accept: true, ids, always })
            if (always) setConfigState((c) => (c ? { ...c, restoreAfterRestart: 'always' } : c))
          }}
          onFresh={() => {
            setRestore(null)
            api.answerRestore({ accept: false, ids: [] })
          }}
          // Dismissed rather than answered: main is told nothing, keeps the desk and
          // offers it again next launch. Closing a dialog by accident must not be
          // the way a set of panes is lost.
          onDismiss={() => setRestore(null)}
        />
      )}
      {/* Dictation takes the whole screen on a touch or narrow window, and on any
          window while the model is downloading - a once-ever wait belongs somewhere
          it cannot be read as a hang. On a wide desktop with the model already there,
          the pane's own mic button is the whole UI, exactly as before. */}
      {config?.voice.enabled && bigVoice && <VoiceOverlay voice={voice} where={voiceWhere} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {/* A device asking to pair arrives while somebody is at the OTHER machine, so this
          is here rather than inside the Devices dialog - that dialog is almost never the
          thing on screen when the request lands. */}
      {remote?.asking && <PairAsk ask={remote.asking} />}
      {/* Same reasoning, one door along: a phone that scanned the picture is waiting on a
          press here, and the person holding it is not the person with this dialog open.
          Never on a phone: this UI also runs in that browser, so an unguarded card covered
          a signed-in phone with a full-screen veil the moment any device asked to get in,
          and offered Approve to the one screen that cannot check the digits against the
          desk. The desk decides. */}
      {phone?.ask && !isPhoneClient() && <PhoneAsk ask={phone.ask} />}
      {/* ...and the same countdown for a desk with no sprite to draw it beside. The
          mascot arrives off, so without this the commonest desk in the app gets no
          warning at all before a pane moves or closes. */}
      {!(config?.mascot?.enabled ?? DEFAULT_MASCOT.enabled) && (
        <MoveSoon
          soon={closeSoon}
          onKeep={keepOpen}
          onNow={(ids) =>
            closeSoon?.move
              ? doMove(moveSoonRef.current.plan, moveSoonRef.current.cooldownMinutes)
              : doClose(ids, pendingMb.current)
          }
        />
      )}
      {/* The face on the resource ladder. Everything it may do is in shared/mascot.ts;
          this passes it the readings and the two actions, and nothing else. */}
      <Mascot
        panes={mascotPanes}
        config={config?.mascot ?? DEFAULT_MASCOT}
        idleCloseOn={(config?.reclaim?.idleCloseMinutes ?? 0) > 0}
        willMove={(config?.autoHandoff ?? DEFAULT_AUTO_HANDOFF).enabled === true && capacity?.offload === true}
        acted={acted}
        closeSoon={closeSoon}
        devs={devs}
        onRefreshDevs={refreshDevs}
        onStopDev={(pids) => {
          // Stopped one at a time and re-read afterwards, because the answer that matters
          // is what is running NOW - a stop that silently failed (a pid already gone, a
          // pid that is no longer a dev server) must not leave a list saying otherwise.
          void Promise.all(pids.map((pid) => api.stopDevServer(pid))).then(() => refreshDevs())
        }}
        onKeep={keepOpen}
        onCloseNow={(ids) =>
          closeSoon?.move
            ? doMove(moveSoonRef.current.plan, moveSoonRef.current.cooldownMinutes)
            : doClose(ids, pendingMb.current)
        }
        onReveal={(id) => setActiveId(id)}
        onClose={(ids) => {
          for (const id of ids) void api.killSession(id)
        }}
        onHandoff={(ids) => {
          // It never picks WHICH machine - that is the one question the hand-off box
          // exists to ask, and a mascot guessing it would move a pane to a desk nobody
          // is at. It opens the box with the panes already chosen.
          const going = sessions.filter((x) => ids.includes(x.id))
          const first = going[0]
          if (!first) return
          // Every pane going, not just the first: the box's own words change on `busy` and
          // `asking`, and reading them off ids[0] alone promised "Hand off" over a set
          // whose second pane was mid-turn or holding a question. It is the answer that
          // would be wrong, not the move - `sendHandoff` still checks each pane - which is
          // the shape of wrong that is only found afterwards.
          setHandoff({
            ids,
            title: first.lane ? `lane ${first.lane}` : first.title,
            busy: going.some((x) => x.status === 'working' || x.status === 'starting'),
            asking: going.some((x) => Boolean(x.ask))
          })
        }}
        onConfig={(patch: Partial<MascotConfig>) =>
          void api.setConfig({ mascot: { ...DEFAULT_MASCOT, ...config?.mascot, ...patch } })
        }
      />
      {/* A session about to clear itself. Drawn for the window rather than per pane: the
          countdown is about a CONVERSATION, and the pane it belongs to is very often not
          the one on screen - which is the whole reason the silent version was a bug. */}
      <AutoClearToast panes={sessions} onKeep={(id) => void api.cancelAutoClear(id)} />
      <UpdateToast />
      {/* One quiet card in the corner, saying one thing this app can do. It is the only
          thing here that talks about the app rather than about the work, so every other
          card in this corner - and every dialog, and any pane holding a question - stands
          it down. shared/tips.ts owns every judgement in it. */}
      <Tips
        cfg={config?.tips ?? DEFAULT_TIPS}
        busy={
          !!ask ||
          settings ||
          help ||
          palette ||
          !!restore ||
          !!info ||
          !!handoff ||
          !!remote?.asking ||
          !!phone?.ask
        }
        asking={sessions.some((s) => Boolean(s.ask))}
        since={OPENED_AT}
        onConfig={(patch) => void api.setConfig({ tips: { ...DEFAULT_TIPS, ...config?.tips, ...patch } })}
      />
    </div>
    </BlurbContext.Provider>
  )
}
