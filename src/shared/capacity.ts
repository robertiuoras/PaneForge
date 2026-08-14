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

export function assess(m: Machine): Verdict {
  const localCost = m.localPanes * paneCostMb(FULL_SCROLLBACK)
  const remoteCost = (m.remotePanes ?? 0) * paneCostMb(FULL_SCROLLBACK, false)
  const usedMb = Math.round(APP_BASE_MB + localCost + remoteCost)
  const nextPaneMb = paneCostMb(FULL_SCROLLBACK)
  const peer = m.peerAvailable === true

  if (m.pressure === 'critical') {
    return {
      level: 'over',
      usedMb,
      nextPaneMb,
      roomFor: null,
      trim: true,
      offload: peer,
      advice: peer
        ? `This machine is out of memory. Panes here hold ~${usedMb} MB; start the next one on the paired device.`
        : `This machine is out of memory. Panes here hold ~${usedMb} MB and background scrollback is being trimmed.`,
    }
  }

  // The budget line, used only while the kernel is not already objecting. Past that point
  // the reading wins: a machine can be thrashing at 40% of its RAM because of what is
  // running beside the app, which is exactly what happened on the desk this was measured on.
  const budgetMb = m.totalMb * PLANNABLE
  const roomFor = Math.max(0, Math.floor((budgetMb - usedMb) / nextPaneMb))

  if (m.pressure === 'warn') {
    return {
      level: 'tight',
      usedMb,
      nextPaneMb,
      roomFor: Math.min(roomFor, 1),
      trim: true,
      offload: peer,
      advice: peer
        ? `Memory is tight. Each pane here costs ~${nextPaneMb} MB - the paired device can take the next one.`
        : `Memory is tight. Each pane here costs ~${nextPaneMb} MB; background panes are trimmed to keep this responsive.`,
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
      advice: `${m.localPanes} panes here hold ~${usedMb} MB of ${Math.round(m.totalMb / 1024)} GB. Another one will start swapping.`,
    }
  }

  return {
    level: 'ok',
    usedMb,
    nextPaneMb,
    roomFor,
    trim: false,
    offload: false,
    advice: `${m.localPanes} panes, ~${usedMb} MB. Room for about ${roomFor} more here.`,
  }
}

export interface PaneRef {
  id: string
  /** Is this the pane the user is looking at? Never trimmed. */
  focused: boolean
  /** Is it visible in the grid at all? Visible-but-unfocused is trimmed last. */
  visible: boolean
}

export interface Trim {
  id: string
  scrollback: number
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
export function trimPlan(panes: PaneRef[], v: Verdict, current = FULL_SCROLLBACK): Trim[] {
  if (!v.trim) {
    // Restoring is part of the plan: pressure passes, and a pane that was trimmed while
    // the user was elsewhere must be allowed to grow back rather than staying short forever.
    if (current >= FULL_SCROLLBACK) return []
    return panes.map((p) => ({ id: p.id, scrollback: FULL_SCROLLBACK }))
  }
  const out: Trim[] = []
  for (const p of panes) {
    if (p.focused) {
      if (current < FULL_SCROLLBACK) out.push({ id: p.id, scrollback: FULL_SCROLLBACK })
      continue
    }
    const target = p.visible && v.level !== 'over' ? FULL_SCROLLBACK : TRIMMED_SCROLLBACK
    if (target !== current) out.push({ id: p.id, scrollback: target })
  }
  return out
}

/** MB freed by a plan, for the log line that says whether it was worth doing. */
export function savingMb(plan: Trim[], from = FULL_SCROLLBACK): number {
  let mb = 0
  for (const t of plan) mb += ((from - t.scrollback) / 1000) * BUFFER_MB_PER_1K
  return Math.round(mb)
}
