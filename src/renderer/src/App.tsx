import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import type {
  Config,
  HistoryEntry,
  Preset,
  Project,
  RecentItem,
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
import { Segmented } from './components/Controls'
import Elapsed, { formatElapsed } from './components/Elapsed'
import GitBadge from './components/GitBadge'
import HistoryDialog from './components/HistoryDialog'
import { BoardIcon, HistoryIcon, LinkIcon, RemoteIcon, SwarmIcon, TrashIcon } from './components/Icons'
import RemoteDialog from './components/RemoteDialog'
import TerminalPane, { paneFocus, paneInsert, paneRepair } from './components/TerminalPane'
import MicIcon from './components/MicIcon'
import NewSessionDialog from './components/NewSessionDialog'
import RecentsFlyout from './components/RecentsFlyout'
import RestoreDialog from './components/RestoreDialog'
import SettingsDialog from './components/SettingsDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import LaneStrip, {
  LaneChip,
  LaneHelp,
  laneOfSession,
  useLaneBoard,
  useLanesByCwd
} from './components/LaneStrip'
import StatusDot from './components/StatusDot'
import SwarmDialog from './components/SwarmDialog'
import UpdateToast from './components/UpdateToast'
import VersionBadge from './components/VersionBadge'
import { playChime } from './useChime'
import { useVoice } from './useVoice'

const api = window.api

/** How long a card stays lit after its turn ends - long enough to look, short enough
 *  that a room of finished panes is not a wall of glowing cards. */
const DONE_GLOW_MS = 5200

/** How far a press has to travel before it is a drag rather than a click. Measured on
 *  the real window: a press that drifted 6px selected nothing, because 5px was inside
 *  the noise of an ordinary mouse click. */
const DRAG_SLOP = 9

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
  const [rawSessions, setSessions] = useState<Session[]>([])
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
  const [devices, setDevices] = useState(false)
  // Null until the main process has answered once. The dialog draws a placeholder
  // rather than an empty machine, which reads as "you have no devices".
  const [remote, setRemote] = useState<RemoteState | null>(null)
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
  const [shelfPinned, setShelfPinned] = useState(false)
  const [shelfPeek, setShelfPeek] = useState(false)
  const peekTimer = useRef<number>()
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

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
    document.addEventListener('click', give, true)
    document.addEventListener('keydown', onKey, true)
    // Coming back to the app from somewhere else. Windows hands the keyboard to whatever
    // held it when you left, which after a click on a button is that button - so the first
    // thing typed after an alt-tab went nowhere.
    window.addEventListener('focus', give)
    return () => {
      document.removeEventListener('click', give, true)
      document.removeEventListener('keydown', onKey, true)
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
    ask !== null ||
    restore !== null ||
    renaming !== null
  useEffect(() => {
    if (layerOpen) return
    const t = window.setTimeout(restoreFocus, 0)
    return () => window.clearTimeout(t)
  }, [layerOpen, restoreFocus])

  useEffect(() => {
    api.listSessions().then(setSessions)
    api.getConfig().then(setConfigState)
    // Pulled, not pushed: main decides what to do with the last run's panes while
    // this window is still loading, so it holds the question until we ask for it.
    api.pendingRestore().then(setRestore)
    api.remoteState().then(setRemote)
    const offS = api.onSessions(setSessions)
    const offC = api.onConfig(setConfigState)
    // Pushed rather than polled: a device coming or going, a guest attaching, a
    // reconnect finishing - all of them change what the sidebar says.
    const offR = api.onRemote(setRemote)
    return () => {
      offS()
      offC()
      offR()
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
        if (soundOn.current && !watching) playChime()
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

  const beginDrag = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    // The close/restart buttons and the rename box own their own presses.
    if ((e.target as HTMLElement).closest('button, input')) return
    const startY = e.clientY
    let dragging = false
    const startIds = idsRef.current
    let latest = startIds
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
        if (Math.abs(ev.clientY - startY) < DRAG_SLOP) return
        dragging = true
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
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try {
        if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId)
      } catch {
        /* already gone */
      }
      if (!dragging) return
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
  const peekMs = config?.stashPeekMs ?? 5000
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
      setShelfPeek(true)
      window.clearTimeout(peekTimer.current)
      peekTimer.current = window.setTimeout(() => setShelfPeek(false), peekMs)
    })
  }, [config?.clipboardShelf, peekMs, shelfInWindow])

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
        if (!it.text) return
        // As a paste, not as typing. Every agent here runs a TUI with bracketed paste on,
        // and a stash entry is usually several lines: written to the pty they arrive as
        // Enter after Enter and the first line is submitted on its own. The same route
        // dictation takes, for the same reason.
        const insert = paneInsert.get(id)
        if (insert) insert(it.text)
        else api.write(id, it.text)
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
      const wipe = shell ? '\x1b' : '\x15'
      api.write(s.id, wipe)
      // The gaps are measured too: at 40ms/120ms the Enter reached Claude Code before
      // its slash menu had drawn, and "/clear" sat in the box unsubmitted. It is a TUI
      // being typed at, and this is the price of not needing a second click.
      window.setTimeout(() => api.write(s.id, cmd), 320)
      window.setTimeout(() => api.write(s.id, '\r'), 680)
      flash(`${s.title}: cleared.`)
    },
    [flash]
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
        // The shelf is the lightest layer on screen, so Escape closes it before it
        // starts closing dialogs underneath.
        if (shelfPinned) {
          setShelfPinned(false)
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
      if (e.ctrlKey && !e.altKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault()
        e.stopPropagation()
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
      } else if (k === 'v' && e.shiftKey) {
        // Claimed here, and stopped from going any further: the pane's own handler
        // treats every Ctrl+V as a paste, so without stopPropagation this would open
        // the shelf and paste the clipboard into the agent at the same time.
        e.preventDefault()
        e.stopPropagation()
        // One Stash: while the floating one is on, this key opens that, not a second
        // list drawn inside the window.
        if (shelfInWindow) setShelfPinned((p) => !p)
        else api.toggleStash()
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
      } else if (k === 'g') {
        e.preventDefault()
        patchConfig({ grid: !grid })
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
    fixUi,
    shelfPinned,
    shelfInWindow
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
        id: 'grid',
        group: 'Actions',
        title: grid ? 'Show one pane at a time' : 'Show every pane in a grid',
        keys: 'Ctrl G',
        run: () => patchConfig({ grid: !grid })
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
    saveRunningAsWorkspace
  ])

  const visibleIds = useMemo(
    () => new Set(grid ? sessions.map((s) => s.id) : sessions.filter((s) => s.id === activeId).map((s) => s.id)),
    [grid, sessions, activeId]
  )
  // Near-square layout, same rule the old .bat grid used, but for whatever N is open.
  const cols = grid ? Math.max(1, Math.ceil(Math.sqrt(sessions.length))) : 1
  const waiting = sessions.filter((s) => s.attention).length
  // Devices in either direction: ones whose panes are in this list, and ones watching
  // this machine's. Both are "a link is up", which is all the sidebar dot claims.
  const remoteLive =
    (remote?.peers.filter((p) => p.status === 'online').length ?? 0) + (remote?.guests.length ?? 0)
  // "Working" is now the agent's own on-screen state rather than "something was printed
  // in the last four seconds", so it stays honest through a long silent tool call and
  // does not claim a pane sitting at an empty prompt is busy.
  const working = sessions.filter((s) => s.status === 'working').length
  // PaneForge's own dev lanes, on a machine that develops PaneForge. Null everywhere else,
  // and then nothing below draws anything.
  const laneBoard = useLaneBoard()
  const lanesByCwd = useLanesByCwd(laneBoard)
  // The lane explainer under the Sessions header, and whether there is anything to explain.
  const [laneHelp, setLaneHelp] = useState(false)
  const anyLane = sessions.some((s) => s.lane || laneOfSession(lanesByCwd, s.cwd))

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
            <button
              className="icon help"
              title="Every shortcut and what it does (F1 or Ctrl /)"
              onClick={() => setHelp(true)}
            >
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

        {/* Icons, not words. Three labels already wrapped on a narrow sidebar and a
            fourth would not have fitted at all; a fixed-width row has room to grow and
            reads faster once you know it. Every one keeps its full sentence on hover. */}
        <div className="quick">
          <button
            className="ghost quick-btn"
            title="Swarm: several agents on one mission (Ctrl Shift S)"
            onClick={() => setSwarm(true)}
          >
            <SwarmIcon />
          </button>
          <button
            className="ghost quick-btn"
            title="Board: tasks and shared memory for the focused pane's folder (Ctrl Shift K)"
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
            title="History: search past sessions (Ctrl H)"
            onClick={() => setHistory(true)}
          >
            <HistoryIcon />
          </button>
          <button
            className={'ghost quick-btn' + (remoteLive ? ' live' : '')}
            title={
              remoteLive
                ? `Devices: ${remoteLive} connected (Ctrl Shift D)`
                : 'Devices: work on another machine’s panes from here (Ctrl Shift D)'
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

        {/* Only the PaneForge lanes no open pane accounts for; the rest are chips on the
            session cards below. Renders nothing at all off a PaneForge machine. */}
        <LaneStrip board={laneBoard} sessions={sessions} onFocus={setActiveId} />

        <div className="section">
          {/* "Running" read as "these are all busy" on a list of idle panes. */}
          Sessions ({sessions.length})
          {/* A pane that was moved into a worktree says so with a chip nobody asked for
              and nothing explains. The "?" is only here while such a chip is on screen. */}
          {anyLane && (
            <button
              className={'help-dot' + (laneHelp ? ' on' : '')}
              onClick={() => setLaneHelp((h) => !h)}
              title="What is a lane?"
              aria-label="What is a lane?"
              aria-expanded={laneHelp}
            >
              ?
            </button>
          )}
          {/* Badges and the empty-everything button travel together, hard right. One
              wrapper rather than three margin rules: whichever of them are showing, the
              rest keep their place. */}
          <span className="section-tail">
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
        {anyLane && laneHelp && <LaneHelp devLanes={lanesByCwd.size > 0} />}
        <div className="list" ref={listRef}>
          {sessions.map((s, i) => (
            <div
              key={s.id}
              data-id={s.id}
              className={
                'row' +
                (s.id === activeId ? ' active' : '') +
                (s.attention ? ' attn' : '') +
                (justDone.includes(s.id) ? ' just-done' : '') +
                (dragId === s.id ? ' dragging' : '')
              }
              onPointerDown={(e) => beginDrag(e, s.id)}
              onClick={() => {
                if (draggedRef.current) return
                setActiveId(s.id)
              }}
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
                  <div className="row-title has-key">
                    {/* The switch key, and the fastest place to read the pane's state:
                        lit green while its agent is running, amber when a turn finished
                        while you were looking somewhere else. */}
                    {i < 9 && (
                      <span
                        className={'num' + (s.status === 'working' ? ' live' : s.attention ? ' attn' : '')}
                        title={`Ctrl ${i + 1}`}
                      >
                        {i + 1}
                      </span>
                    )}
                    <span className="row-name">{s.title}</span>
                  </div>
                )}
                <div className="row-sub">
                  <AgentLogo id={s.agent} spec={agents.find((a) => a.id === s.agent)} size={12} />
                  {agents.find((a) => a.id === s.agent)?.label ?? s.agent}
                  {s.model ? <span className="chip">{s.model}</span> : null}
                  {s.lane ? (
                    <span
                      className="chip lane"
                      title={`Worktree lane ${s.lane} - this pane has its own checkout of the project, so it cannot clash with the other pane open on it.\n${s.cwd}`}
                    >
                      {s.lane}
                    </span>
                  ) : null}
                  {/* The PaneForge dev lane this chat holds, if it holds one. Same fact the
                      sidebar used to repeat in a second list of the same sessions. */}
                  {laneOfSession(lanesByCwd, s.cwd) ? (
                    <LaneChip lane={laneOfSession(lanesByCwd, s.cwd)!} />
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
              {s.lane && (
                <span className="chip lane" title="Own git worktree, so this pane cannot clash with the other session in this project">
                  lane {s.lane}
                </span>
              )}
              {/* A mirrored folder is on the other machine, so there is no repo here
                  to read a branch off - the badge would either be blank or, worse,
                  show this machine's checkout of a path that happens to match. */}
              {!s.remote && <GitBadge cwd={s.cwd} active={visibleIds.has(s.id)} />}
              <span className="pt-path">{s.cwd}</span>
              <span className="pt-actions">
                <AgentPicker
                  small
                  agents={agents}
                  agent={s.agent}
                  model={s.model ?? ''}
                  onChange={(a, m) => switchAgent(s, a, m)}
                />
                {/* Clears the agent's context and keeps the run. Where the mic used to
                    be, which is why the mic moved down to the prompt it dictates into:
                    the two got clicked for each other up here. */}
                <button
                  className="icon danger"
                  title={`Clear ${s.title}: runs /clear in this pane. The run keeps going; its memory of this conversation does not.`}
                  aria-label="Clear this session"
                  onClick={(e) => {
                    e.stopPropagation()
                    clearPane(s)
                  }}
                >
                  <TrashIcon size={13} />
                </button>
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
                {/* Both of these open something on THIS machine. For a mirrored pane
                    the folder is on the other one, so they would open the wrong thing
                    or nothing at all - better absent than quietly wrong. */}
                {!s.remote && (
                  <button
                    className="icon"
                    title={`Open ${s.cwd} in Explorer - drop files there, or drag them onto this pane`}
                    onClick={() => api.reveal(s.cwd)}
                  >
                    📁
                  </button>
                )}
                {!s.remote && (
                  <button
                    className="icon"
                    title="Open in editor"
                    onClick={() => api.openInEditor(s.cwd).then((err) => err && flash(err))}
                  >
                    ✎
                  </button>
                )}
                <button className="icon" title="Close (Ctrl W)" onClick={() => close(s.id)}>
                  x
                </button>
              </span>
            </div>
            <TerminalPane
              sessionId={s.id}
              visible={visibleIds.has(s.id)}
              active={s.id === activeId}
              fontSize={config?.fontSize ?? 13}
              copyOnSelect={config?.copyOnSelect ?? true}
              mouseSelect={config?.mouseSelect ?? true}
              autoFixUi={config?.autoFixUi ?? true}
              // A mirrored pane is drawn at the far machine's grid, not fitted to this
              // window: two devices cannot both own one terminal's size.
              mirror={s.remote && s.cols && s.rows ? { cols: s.cols, rows: s.rows } : null}
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
                      : `Dictate into ${s.title} (Ctrl Shift Space dictates into the focused pane)`
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
            <p className="hint">Ctrl K to search everything. F1 or Ctrl / for every shortcut.</p>
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
      {shelfInWindow && (
        <RecentsFlyout
          // Only drawn when the floating Stash is off, so a copy never appears in two
          // places at once. The last handful, one click from a pane.
          items={recents.slice(0, 12)}
          pinned={shelfPinned}
          peek={shelfPeek}
          onClose={() => setShelfPinned(false)}
          onSend={sendRecent}
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
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      <UpdateToast />
    </div>
  )
}
