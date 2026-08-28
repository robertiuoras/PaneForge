// How many panes this machine can actually hold, and what to give up first when it cannot.
//
// The app had no idea how heavy it was. `freemem`, `totalmem`, `getSystemMemoryInfo`,
// `pressure` - none of them appeared anywhere in src/main or src/renderer, so a desk with
// six panes on a 16 GB laptop hit the wall silently and the app got the blame. Measured
// 2026-08-14 on an M4/16 GB while that was happening:
//
//   load average 105.77 while 32.73% of the CPU sat IDLE
//   PhysMem 15G used, 122M unused, 6321M in the compressor, pressure level 2
//
// Load that high with a third of the CPU doing nothing is not a busy machine, it is a
// machine whose threads are all blocked on page faults. That is the shape of the problem
// this module exists for, and it is worth being precise about who was actually eating the
// memory, because the intuitive answer was wrong on both counts:
//
//   PaneForge itself     248 MB across 5 processes   (the whole app, 6 panes mounted)
//   one agent CLI       ~190 MB each                 (26x the app's per-pane cost)
//   one full scrollback  ~7.2 MB                     (measured, see PANE_BUFFER_MB)
//   the browsers         ~4 GB before any work       (Chrome 44 procs, Safari 45)
//   one `next build`    1442 MB at 118% CPU          (what a pane RAN, not the pane)
//
// So the pane is cheap and the app is cheap. What is expensive is the agent inside the
// pane and the build that agent starts. A capacity model that only counted panes would
// cheerfully promise fifty of them on the machine that was already thrashing at six.
// Everything below is therefore driven by a LIVE pressure reading, with the per-pane
// costs used only to say how much a given action would add.
//
// Pure on purpose: no `os`, no `sysctl`, no Electron. The platform-specific probe lives in
// src/main/memory.ts and hands its findings in here, so the policy can be tested by
// arithmetic instead of by filling a real machine's RAM. `npm run test:capacity`.

/**
 * Resident cost of one agent CLI, in MB.
 *
 * Measured 2026-08-14 across 7 live `claude` processes on this desk: 1160-1836 MB total,
 * 176-244 MB each depending on how long the session had been running and how much context
 * it held. 190 is the middle of that, and it is the number that matters most here - it is
 * an order of magnitude above everything else the app spends per pane.
 */
export const SESSION_MB = 190

/**
 * Heap cost of one pane's scrollback when the ring is full, in MB per 1000 lines.
 *
 * Measured with @xterm/headless (the buffer the app actually ships) at 200x50, writing
 * 20050 full-width coloured lines into each of 12 terminals and reading heapUsed after a
 * forced GC between each. Growth was linear across the whole range: 12.3 MB at one pane,
 * 48.2 at six, 91.1 at twelve - 7.2 MB per pane at the shipped scrollback of 20000, and
 * 1.0 MB per pane at 2000. Hence 7.2/20 per 1000 lines.
 *
 * RSS was NOT used for this: it moved non-monotonically (297 MB at 6 panes, 299 at 12) as
 * the allocator returned pages between samples. Heap after an explicit GC is the only
 * figure here that is reproducible run to run.
 */
export const BUFFER_MB_PER_1K = 7.2 / 20

/** What the app costs before any pane exists. Measured: 248 MB over 5 processes. */
export const APP_BASE_MB = 250

/** The shipped per-pane scrollback. Kept here so the cost model and the pane agree. */
export const FULL_SCROLLBACK = 20000

/**
 * What a background pane is trimmed to when the machine is under pressure.
 *
 * Not zero, and not a token amount: 2000 lines is ~40 screenfuls, which covers reading
 * back over the turn you just missed, and costs 1.0 MB instead of 7.2. The pane you are
 * actually looking at is never trimmed - see `trimPlan`.
 */
export const TRIMMED_SCROLLBACK = 2000

/**
 * The kernel's own verdict, normalised across platforms by src/main/memory.ts.
 *
 * Deliberately NOT a free-memory percentage. On macOS `freemem` reports 122 MB on a
 * perfectly healthy machine because the OS keeps every page it can, and swap-used% sits
 * near 100% at idle because the swap file is never shrunk - both have caused real
 * automation on this desk to kill healthy processes. Windows and Linux do publish an
 * honest available figure, so the probe maps each platform's trustworthy signal onto
 * these three levels rather than pretending one number means the same thing everywhere.
 */
export type Pressure = 'normal' | 'warn' | 'critical'

export interface Machine {
  /** Physical RAM in MB. The one number every platform reports honestly. */
  totalMb: number
  /** The kernel's pressure verdict right now. */
  pressure: Pressure
  /** Panes with a live agent process on THIS device. Mirrored panes cost nothing here. */
  localPanes: number
  /** Panes mirrored from a paired device: a buffer and a socket, no agent. */
  remotePanes?: number
  /** Is there a paired device that could host the next pane? Enables the offload advice. */
  peerAvailable?: boolean
  /**
   * The 1-minute load average divided by the core count, when the platform reports one.
   *
   * Memory pressure is the kernel admitting it has already lost, and it arrives LATE: the
   * desk this was measured on sat at pressure 2 for a whole afternoon while nine agent CLIs
   * and their dev servers held 1.4 GB and the load average ran at 8.7 on 10 cores. What a
   * person calls "my laptop is lagging" is that second number, not the first, and it moves
   * a long time before the memory verdict does - so it is read here and the WORSE of the
   * two decides. `os.loadavg()` is 0 on Windows, which is why 0 means "no reading" rather
   * than "idle": an absent signal must never be the thing that triggers a move.
   */
  load?: number
  /**
   * How many panes with a live agent this desk is willing to run itself. 0 = no budget.
   *
   * The readings above answer "is this machine in trouble NOW". This answers the question
   * before it: a laptop that is meant to be the SCREEN for work running elsewhere should
   * stop collecting agents long before the kernel objects, because each one is ~190 MB
   * doing nothing and the build it starts is worse. Everything past the budget belongs on
   * a paired device, mirrored back here to watch - which is what makes a hundred sessions
   * a question about sockets rather than about RAM.
   */
  keepLocal?: number
  /**
   * Is the ladder going to act on this by itself - the automatic handoff switched on, with
   * somewhere to move a pane to?
   *
   * It changes nothing about the verdict and only decides whether the verdict is SAID. A
   * strip that reports "memory is tight, each pane costs ~190 MB" on a desk whose next
   * move is already being made is narrating rather than helping: the reading is true, the
   * advice in it ("start the next one on the paired device") is a job the app is about to
   * do, and the person reading it has nothing to do about either. What the ladder DID
   * still gets a sentence - that one is not a reading, it is an action somebody's panes
   * were subject to.
   */
  willMove?: boolean
}

export type Level = 'ok' | 'tight' | 'over'

export interface Verdict {
  level: Level
  /** What the panes on this device are costing right now, in MB. */
  usedMb: number
  /** What one more local pane would add, in MB. */
  nextPaneMb: number
  /**
   * How many more local panes before this machine is expected to thrash. Null when the
   * pressure reading says it already is - at that point the honest answer is "none", and
   * a number computed from total RAM would be arguing with the kernel.
   */
  roomFor: number | null
  /** One sentence for a human. Never blames the machine or the app without a number. */
  advice: string
  /** Should the renderer trim background panes? */
  trim: boolean
  /** Should the next pane be offered on the paired device instead? */
  offload: boolean
  /**
   * How many local panes are beyond `Machine.keepLocal`, or 0.
   *
   * This is the number the automatic handoff moves, and it is deliberately separate from
   * `level`: being over budget is not a claim that the machine is in trouble, it is the
   * desk's own policy about where work runs. A budget of two with five panes open says
   * "three of these belong on the other machine" whatever the kernel thinks.
   */
  over: number
  /** Which reading is the binding one, for the sentence and for the log line. */
  why: 'ok' | 'memory' | 'lag' | 'budget'
  /**
   * Should `advice` be put in front of a person, or only logged?
   *
   * False exactly when the ladder is about to act on this reading anyway (`Machine.willMove`
   * with a peer online) AND the machine is not yet out of memory. Out of memory keeps its
   * sentence whatever else is happening: that one is not advice, it is the state the desk
   * is in, and finding out afterwards from a pane that is no longer there is the failure
   * the strip exists to prevent.
   */
  say: boolean
}

/** Cost in MB of one pane holding this many scrollback lines, agent included. */
export function paneCostMb(scrollback: number, hasAgent = true): number {
  const buffer = (Math.max(0, scrollback) / 1000) * BUFFER_MB_PER_1K
  return Math.round((hasAgent ? SESSION_MB : 0) + buffer)
}

/**
 * The share of RAM the app is willing to plan for.
 *
 * A quarter, and the first draft of this said 0.4 - which the test caught promising room
 * for 33 panes on a 16 GB laptop. The rest is not a safety margin, it is what was actually
 * measured sitting beside the app on the desk this came from: ~4 GB of browser (Chrome 44
 * processes, Safari 45) plus 3.7-4.4 GB wired before a single pane opened, and then
 * whatever the agents compile on top - one `next build` worker alone held 1442 MB.
 *
 * The number is deliberately conservative because it is only the SECONDARY guard. What a
 * fraction of total RAM can never know is what else the user is running, so the live
 * pressure reading outranks it whenever the two disagree - see `assess`.
 */
const PLANNABLE = 0.25

/**
 * Load per core that reads as "this desk is lagging", and as "it is on its knees".
 *
 * Measured on the machine this was written for (M4, 10 cores, 16 GB) while nine agent CLIs
 * and their dev servers were up: load 8.70 with memory pressure still only at warn. One
 * runnable thread per core is the point where every new pane is waiting for a core rather
 * than getting one, which is exactly what typing into a terminal feels like going treacly;
 * nearly two per core is a machine that will not accept a keystroke promptly whatever the
 * memory says.
 *
 * Deliberately NOT a percentage of CPU: a busy machine and a THRASHING one both read near
 * 100%, and the desk that produced this had 32.73% of its CPU idle while the load average
 * was over a hundred. Load counts threads that are ready and cannot run, which is the thing
 * being complained about.
 */
export const LAG_WARN = 1.0
export const LAG_HARD = 1.8

/** The lag reading as a pressure level. 0, absent, or a nonsense value is `normal`. */
export function lagLevel(loadPerCore: number | undefined): Pressure {
  const n = typeof loadPerCore === 'number' && Number.isFinite(loadPerCore) ? loadPerCore : 0
  if (n >= LAG_HARD) return 'critical'
  if (n >= LAG_WARN) return 'warn'
  return 'normal'
}

const PRESSURE_RANK = { normal: 0, warn: 1, critical: 2 }

/** Whichever of two readings is the worse news. */
export function worstPressure(a: Pressure, b: Pressure): Pressure {
  return PRESSURE_RANK[b] > PRESSURE_RANK[a] ? b : a
}

/**
 * The local-pane budget, hardened the same way `offloadMinutes` is and for the same reason:
 * this value comes off config.json and, since `pf-ctl call config:set` exists, off a
 * script. `true` is not a budget of one, it is somebody writing a switch where a number
 * goes, and reading it as a number would move every pane on the desk.
 */
export function keepLocalOf(keepLocal: number | undefined): number {
  return typeof keepLocal === 'number' && Number.isFinite(keepLocal) && keepLocal > 0
    ? Math.floor(keepLocal)
    : 0
}

export function assess(m: Machine): Verdict {
  const localCost = m.localPanes * paneCostMb(FULL_SCROLLBACK)
  const remoteCost = (m.remotePanes ?? 0) * paneCostMb(FULL_SCROLLBACK, false)
  const usedMb = Math.round(APP_BASE_MB + localCost + remoteCost)
  const nextPaneMb = paneCostMb(FULL_SCROLLBACK)
  const peer = m.peerAvailable === true
  // The ladder can only act where there is somewhere to act TO, so a switched-on handoff
  // with no peer online is silence that fixes nothing - which is why this is both halves.
  const ladder = m.willMove === true && peer

  // The lag reading and the memory reading answer the same question a few minutes apart,
  // so the worse of the two decides. A machine at load 2 per core with memory to spare is
  // in trouble now; a machine the kernel is reclaiming from is in trouble now as well.
  const lag = lagLevel(m.load)
  const pressure = worstPressure(m.pressure, lag)
  const budget = keepLocalOf(m.keepLocal)
  const over = budget ? Math.max(0, m.localPanes - budget) : 0
  // Which reading is doing the work, for the sentence and for the log. Memory outranks lag
  // when both are objecting, because it is the one with a kernel behind it.
  const why: Verdict['why'] =
    pressure !== 'normal'
      ? m.pressure !== 'normal'
        ? 'memory'
        : 'lag'
      : over > 0
        ? 'budget'
        : 'ok'
  const lagWords = `load is ${(m.load ?? 0).toFixed(1)} per core`

  if (pressure === 'critical') {
    const head = why === 'lag' ? `This machine is struggling - ${lagWords}.` : 'This machine is out of memory.'
    return {
      level: 'over',
      usedMb,
      nextPaneMb,
      roomFor: null,
      trim: true,
      offload: peer,
      over,
      why,
      // Out of memory always says so, ladder or not.
      say: true,
      advice: peer
        ? `${head} Panes here hold ~${usedMb} MB; start the next one on the paired device.`
        : `${head} Panes here hold ~${usedMb} MB and background scrollback is being trimmed.`,
    }
  }

  // The budget line, used only while the kernel is not already objecting. Past that point
  // the reading wins: a machine can be thrashing at 40% of its RAM because of what is
  // running beside the app, which is exactly what happened on the desk this was measured on.
  const budgetMb = m.totalMb * PLANNABLE
  const roomFor = Math.max(0, Math.floor((budgetMb - usedMb) / nextPaneMb))

  if (pressure === 'warn') {
    const head = why === 'lag' ? `This machine is lagging - ${lagWords}.` : 'Memory is tight.'
    return {
      level: 'tight',
      usedMb,
      nextPaneMb,
      roomFor: Math.min(roomFor, 1),
      trim: true,
      offload: peer,
      over,
      why,
      say: !ladder,
      advice: peer
        ? `${head} Each pane here costs ~${nextPaneMb} MB - the paired device can take the next one.`
        : `${head} Each pane here costs ~${nextPaneMb} MB; background panes are trimmed to keep this responsive.`,
    }
  }

  if (roomFor === 0) {
    return {
      level: 'tight',
      usedMb,
      nextPaneMb,
      roomFor: 0,
      trim: false,
      offload: peer,
      over,
      why: why === 'ok' ? 'memory' : why,
      say: !ladder,
      advice: `${m.localPanes} panes here hold ~${usedMb} MB of ${Math.round(m.totalMb / 1024)} GB. Another one will start swapping.`,
    }
  }

  // Nothing is objecting yet, and the budget still decides where the next pane goes: this
  // desk asked to run `budget` agents and is running more. Said as a policy rather than as
  // a warning, because the machine is genuinely fine.
  if (over > 0) {
    return {
      level: 'ok',
      usedMb,
      nextPaneMb,
      roomFor,
      trim: false,
      offload: peer,
      over,
      why: 'budget',
      say: !ladder,
      advice: peer
        ? `${m.localPanes} panes here, ${over} past the ${budget} this machine keeps - moving ${over === 1 ? 'it' : 'them'} to the paired device.`
        : `${m.localPanes} panes here, ${over} past the ${budget} this machine keeps. No paired device is online to take ${over === 1 ? 'it' : 'them'}.`,
    }
  }

  return {
    level: 'ok',
    usedMb,
    nextPaneMb,
    roomFor,
    trim: false,
    offload: false,
    over: 0,
    why: 'ok',
    say: true,
    advice: `${m.localPanes} panes, ~${usedMb} MB. Room for about ${roomFor} more here.`,
  }
}

export interface PaneRef {
  id: string
  /** Is this the pane the user is looking at? Never trimmed. */
  focused: boolean
  /** Is it visible in the grid at all? Visible-but-unfocused is trimmed last. */
  visible: boolean
  /**
   * The depth this pane is on RIGHT NOW, when the caller tracks it per pane.
   *
   * One number for the whole desk was wrong the moment a plan carried two depths - which
   * is every plan under pressure, since the focused pane is restored in the same pass that
   * trims the rest. The caller then wrote back whichever depth happened to be last, and
   * compared every pane against it next time: panes that were already at that depth were
   * skipped, and panes that were not never got their scrollback back.
   */
  current?: number
  /**
   * When the keyboard last left this pane (`focusLeftAt`, the same reading `reclaim.ts`
   * uses). Optional: a caller that does not supply it, and every existing test, gets the
   * behaviour this had before the grace window existed.
   */
  lastFocus?: number
}

export interface Trim {
  id: string
  scrollback: number
}

/**
 * How long after the keyboard leaves a pane its scrollback is still held at full depth.
 *
 * Five minutes is "the pane I am working in and the one I keep flicking back to". Held
 * panes cost `paneCostMb(FULL_SCROLLBACK)` each, so the set is bounded by how many panes a
 * person actually visits in five minutes, not by how many are open.
 */
export const TRIM_GRACE_MS = 5 * 60_000

/**
 * How long a trimming verdict must HOLD before any pane gives lines up.
 *
 * Longer than the 15s pressure poll, so a reading that flaps across a threshold never
 * reaches a pane. A genuinely full machine waits a minute for the first trim, which is the
 * cheaper mistake: trimming is a delete, and the recovery is a full re-render.
 */
export const TRIM_SETTLE_MS = 60_000

/** The two clock readings `trimPlan` needs; every field optional, absent = old behaviour. */
export interface TrimClock {
  now?: number
  /** When the verdict last BECAME one that trims (level and trim flag together). */
  trimmingSince?: number
}

/**
 * Which panes give up scrollback, and how much.
 *
 * The rule that matters: the focused pane keeps everything, always. Scrollback is the
 * user's record of what an agent did, and silently shortening the one they are reading
 * would be destroying the thing they opened the app for. Off-screen panes go first,
 * visible-but-unfocused only once the machine is critical.
 *
 * Returns only the panes whose depth CHANGES, so the caller can skip a no-op.
 */
export function trimPlan(
  panes: PaneRef[],
  v: Verdict,
  current = FULL_SCROLLBACK,
  clock?: TrimClock
): Trim[] {
  const depth = (p: PaneRef): number => p.current ?? current
  const now = clock?.now
  /**
   * A pane the keyboard has only just left keeps its lines.
   *
   * Without this the pair "trim, then re-render from main's log" fires on every PANE
   * SWITCH while the desk is pinned at `over` - which this machine is for hours at a time
   * (load 2.70 per core against `LAG_HARD` 1.8, measured 2026-08-28). Switching A -> B
   * trimmed A (a delete) and regrew B (`redrawHistory`: `t.reset()`, a resize, and up to
   * `BUFFER_LIMIT` 400 kB written back through xterm - 45-147 ms of pure parse in a
   * headless terminal, before the renderer draws any of it, on the UI thread). Switching
   * back paid it again, for ever. With the grace window a pane is re-rendered at most once
   * per window instead of once per visit.
   */
  const justRead = (p: PaneRef): boolean =>
    now !== undefined && p.lastFocus !== undefined && now - p.lastFocus < TRIM_GRACE_MS
  /**
   * A trim waits for the verdict to HOLD.
   *
   * The level is re-read every `SAMPLE_MS` (15s) and `lagLevel` has bare thresholds, so a
   * load average hovering at `LAG_HARD` flips over <-> tight indefinitely - and the target
   * for a VISIBLE pane differs between those two, so every flip deleted every visible
   * pane's lines and re-rendered them 15 seconds later. Growth is left immediate: it is
   * what gives a reader their history back, and a pane already at full depth never appears
   * in a plan twice.
   */
  const settling =
    clock?.trimmingSince !== undefined &&
    now !== undefined &&
    now - clock.trimmingSince < TRIM_SETTLE_MS
  if (!v.trim) {
    // Restoring is part of the plan: pressure passes, and a pane that was trimmed while
    // the user was elsewhere must be allowed to grow back rather than staying short forever.
    const back = panes.filter((p) => depth(p) < FULL_SCROLLBACK)
    return back.map((p) => ({ id: p.id, scrollback: FULL_SCROLLBACK }))
  }
  const out: Trim[] = []
  for (const p of panes) {
    if (p.focused) {
      if (depth(p) < FULL_SCROLLBACK) out.push({ id: p.id, scrollback: FULL_SCROLLBACK })
      continue
    }
    if (justRead(p)) {
      if (depth(p) < FULL_SCROLLBACK) out.push({ id: p.id, scrollback: FULL_SCROLLBACK })
      continue
    }
    const target = p.visible && v.level !== 'over' ? FULL_SCROLLBACK : TRIMMED_SCROLLBACK
    if (target === depth(p)) continue
    if (target < depth(p) && settling) continue
    out.push({ id: p.id, scrollback: target })
  }
  return out
}

/** MB freed by a plan, for the log line that says whether it was worth doing. */
export function savingMb(plan: Trim[], from = FULL_SCROLLBACK): number {
  let mb = 0
  for (const t of plan) mb += ((from - t.scrollback) / 1000) * BUFFER_MB_PER_1K
  return Math.round(mb)
}

/** A paired device that should host the next pane instead of this one. */
export interface Offload {
  device: string
  deviceName: string
  /** THAT device's path for the same project. Never this machine's path. */
  cwd: string
}

/** One paired device, as much of it as the decision below needs. */
export interface OffloadCandidate {
  device: string
  deviceName: string
  online: boolean
  /** Every project that device can open, by its own name and its own path. */
  projects: { name: string; path: string }[]
}

/**
 * Where the next pane should start.
 *
 * `Verdict.offload` has existed since the capacity work landed and said, in the very
 * sentence shown to the user - "the paired device can take the next one" - what ought to
 * happen. Nothing consumed it, so the advice was a chore handed to the person at the exact
 * moment the machine was too busy to be pleasant to use. This is that sentence executed.
 *
 * Three refusals, all of them load-bearing:
 *
 *   - **A path is not portable.** `/Users/robertiuoras/Projects/toolstash` does not exist
 *     on Windows, so a pane started over there with this machine's cwd opens nothing, or
 *     worse, something else. The peer is asked what IT calls the project and the pane is
 *     started on the peer's own path; no name match, no offload. This is why the match is
 *     on `Project.name` rather than on the path or a basename parsed out of it.
 *   - **Only an online peer.** A paired-but-off device would swallow the launch.
 *   - **Only when the policy says so**, which is `Verdict.offload` and not the level. That
 *     used to be the same sentence - a machine at `ok` kept its own panes - and it is no
 *     longer, because the budget is a policy about where work runs rather than a reading
 *     of how bad things are. A desk that says it keeps two agents is at `ok` with five
 *     open and still wants three of them elsewhere.
 */
export function offloadTarget(
  v: Verdict,
  candidates: OffloadCandidate[],
  projectName: string,
  enabled = true
): Offload | null {
  if (!enabled || !v.offload || !projectName) return null
  for (const c of candidates) {
    if (!c.online) continue
    const hit = c.projects.find((p) => p.name === projectName)
    if (!hit) continue
    return { device: c.device, deviceName: c.deviceName, cwd: hit.path }
  }
  return null
}

/** What a person answered when the launch asked where the pane should go. */
export type OffloadAnswer = 'remote' | 'local'

/** ...and what the launch does: the two answers, or put the question on screen. */
export type OffloadPlan = OffloadAnswer | 'ask'

/** An answer kept for a while, so a busy stretch is not one dialog per pane. */
export interface OffloadStick {
  answer: OffloadAnswer
  /**
   * The device the answer was given ABOUT.
   *
   * "Yes, send it to the PC" is not "yes, send it anywhere". Two paired devices and two
   * projects is enough for a remembered answer about one machine to move a pane onto a
   * machine nobody was asked about - which is the silent move this whole feature exists
   * to stop, wearing the user's own approval. A remembered "keep it here" carries no
   * device: it is a statement about THIS desk and holds whoever was offering.
   */
  device: string
  /** ms epoch after which the question is asked again */
  until: number
}

/**
 * How long an answer holds. Ten minutes because the thing it is answering about is a
 * burst - a few panes opened in a row while the machine is already full - and not a
 * setting. Anything longer and a choice made once quietly becomes the policy; anything
 * shorter and opening three panes asks three times, which is the nag this replaces.
 */
export const OFFLOAD_STICK_MS = 10 * 60_000

export function stickFor(
  answer: OffloadAnswer,
  device: string,
  now: number,
  ms = OFFLOAD_STICK_MS
): OffloadStick {
  return { answer, device, until: now + ms }
}

/**
 * Where the launch goes, and whether the person is asked at all.
 *
 * `offloadTarget` decides whether a peer COULD take the pane. This decides who says so.
 * Until this existed the launch moved the pane on its own and printed a sentence after
 * the fact, which is right for a machine that is thrashing and wrong for the person who
 * wanted THIS pane on THIS desk - the files are here, the browser is here, and a pane
 * that landed on the other machine has to be handed back by hand.
 *
 * A stuck answer beats the question, and never beats "there is nowhere to send it": a
 * remembered `remote` with no online peer holding the project is still local.
 */
export function offloadPlan(
  target: Offload | null,
  /** config: ask before moving, rather than moving and saying so */
  ask: boolean,
  stick: OffloadStick | null,
  now: number
): OffloadPlan {
  if (!target) return 'local'
  // A stuck answer is an answer to a QUESTION. With asking turned off no question was
  // put, so the setting decides and a leftover answer from before the switch was flipped
  // may not quietly outvote it.
  if (ask && stick && stick.until > now) {
    if (stick.answer === 'local') return 'local'
    if (stick.device === target.device) return 'remote'
  }
  return ask ? 'ask' : 'remote'
}

/** What a launch may bring back from the saved desk, and why it is fewer than all of it. */
export interface RestorePlan {
  /** How many of the saved panes are ticked to start. Never 0 while there is one to offer. */
  fits: number
  /**
   * How many of those come back with their AGENT RUNNING. The rest come back asleep -
   * card, screen and conversation, no process - and a press wakes one.
   *
   * This is the number the restore lag was ever about. Measured on this desk 2026-08-28
   * with `npm run boot-timing --panes 7`: every pane back on screen with its old output
   * in 1.3-2.6s, but a composer you can type into at 4.1-14.3s, against 1.4s for one
   * `claude` alone - and the app's own main process spends under 0.5s of CPU in the whole
   * first 30s. The wait is N agent CLIs starting in one tick, so the fix is to start one.
   *
   * Never 0 while there is a pane to offer: an app that comes back with nothing running
   * at all reads as an app that failed to start.
   */
  awake: number
  /** The sentence under the list. Empty when everything fits and nothing needs saying. */
  note: string
}

/**
 * How much of the last desk to bring back at once.
 *
 * Restoring is the one moment the app starts N agent CLIs in a single tick, and each one
 * is ~190 MB before it has compiled anything (measured on this desk: one `next build`
 * worker held 1442 MB on its own). On a machine the kernel is already reclaiming from,
 * six of them at once is the difference between a desk and a laptop that will not accept
 * a keystroke - reported here on 2026-08-17, at pressure 2, with six panes restored.
 *
 * So the pressure reading decides, and it decides small. The budget arithmetic is not the
 * binding constraint on the machines this happens to: a quarter of 16 GB divides into ~19
 * panes, which is not an answer anybody could use. What makes a small number safe rather
 * than lossy is that nothing is lost - the panes left unticked keep their conversation and
 * their screen, and come back from History with one click each.
 *
 * It is a PRESELECT, never a cap: the list is ticked this way and the person may tick the
 * rest. A restore they asked for whole is theirs to have.
 */
export function restorePlan(saved: number, m: Machine): RestorePlan {
  const offered = Math.max(0, saved)
  if (offered <= 1) return { fits: offered, awake: offered, note: '' }
  const v = assess({ ...m, localPanes: m.localPanes })
  const each = v.nextPaneMb

  // "The rest are in History" is only true when some were held back. Said unconditionally
  // it is a sentence about panes that do not exist, on the one screen whose whole job is
  // to say which panes there are - the review of v0.8.93 caught it for two saved panes at
  // warn, where all of them fit and the note still sent the reader to look for more.
  const rest = (fits: number): string =>
    fits < offered ? ' The rest are in History, one click each.' : ''

  // One agent starts, whatever else is true. Everything below decides how many CARDS come
  // back; this decides how many PROCESSES, and the answer is the pane about to be looked
  // at. A sleeping pane costs the machine nothing but the row it sits in.
  const awake = 1

  if (m.pressure === 'critical') {
    return {
      fits: 1,
      awake,
      note: `This machine is out of memory right now, and each pane brings back an agent costing ~${each} MB. One is ticked.${rest(1)}`,
    }
  }
  if (m.pressure === 'warn') {
    const fits = Math.min(offered, 2)
    return {
      fits,
      awake,
      note: `Memory is tight - each pane brings back an agent costing ~${each} MB, and starting ${offered} at once is what makes typing lag.${rest(fits)}`,
    }
  }
  // Not under pressure: the only limit left is the arithmetic, and on any machine that
  // saved this many panes it will not bite. Said plainly rather than silently applied.
  const room = v.roomFor ?? offered
  const fits = Math.max(1, Math.min(offered, room))
  const asleep = `The first one starts its agent; the rest come back asleep - the card, the screen and the conversation, with no process behind them. Press one to wake it.`
  return {
    fits,
    awake,
    note:
      fits < offered
        ? `${offered} panes would hold about ${offered * each} MB of this machine's ${Math.round(m.totalMb / 1024)} GB. ${fits} are ticked. ${asleep}${rest(fits)}`
        : asleep,
  }
}

/**
 * The project name a path belongs to, on either platform's separator.
 *
 * The launcher hands this a cwd that came from THIS machine, and the peer is matched on
 * the name, so both separators have to be understood wherever the path was made.
 */
export function projectNameOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}
