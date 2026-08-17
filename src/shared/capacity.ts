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
 *   - **Only when the policy says so.** At `level: 'ok'` this returns null however many
 *     peers are up: a machine with room should keep its own panes, where the agent can
 *     see the files being edited.
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
  if (offered <= 1) return { fits: offered, note: '' }
  const v = assess({ ...m, localPanes: m.localPanes })
  const each = v.nextPaneMb

  if (m.pressure === 'critical') {
    return {
      fits: 1,
      note: `This machine is out of memory right now, and each pane brings back an agent costing ~${each} MB. One is ticked; the rest are in History whenever you want them.`,
    }
  }
  if (m.pressure === 'warn') {
    return {
      fits: Math.min(offered, 2),
      note: `Memory is tight - each pane brings back an agent costing ~${each} MB, and starting ${offered} at once is what makes typing lag. The rest are in History, one click each.`,
    }
  }
  // Not under pressure: the only limit left is the arithmetic, and on any machine that
  // saved this many panes it will not bite. Said plainly rather than silently applied.
  const room = v.roomFor ?? offered
  const fits = Math.max(1, Math.min(offered, room))
  return {
    fits,
    note:
      fits < offered
        ? `${offered} panes would hold about ${offered * each} MB of this machine's ${Math.round(m.totalMb / 1024)} GB. ${fits} are ticked; the rest are in History.`
        : '',
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
