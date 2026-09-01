// A dev server that is running and serving nothing, and the countdown in front of closing it.
//
// Measured on this desk, 2026-09-01: `next dev -p 3006` for taskdriver.ai had been up 19
// minutes on ppid 1, and port 3006 was answering from a DIFFERENT process - a launchd job
// that supervises the real one. The duplicate had lost the port race at startup, so it
// held a Next compiler, a file watcher and ~200 MB for nineteen minutes while being
// unreachable from any browser. Nothing on screen said so; `devList.ts` listed it exactly
// like the one that works, because "what is running" is all it was ever asked.
//
// Robert: "dev server uses resources and i said its important to manage properly".
//
// The judgement here is deliberately NOT "does a pane own it" and NOT "has it been quiet"
// - a supervised dev server has no pane and is quiet all day, and closing that is closing
// the thing somebody's site is served by. It is "is anything reachable on it": a dev
// server holding no listening socket cannot be what anyone is looking at, whoever started
// it. That is the one reading that separates the duplicate from the real one, and it is
// the same reading a person takes by hand with `lsof -iTCP -sTCP:LISTEN`.
//
// Everything here is arithmetic over readings somebody else took - `npm run test:deaddev`.

import type { RunningDev } from './devList'

/** One dev server that is serving nothing, with the sentence that says why. */
export interface DeadDev {
  pid: number
  /** `next`, `vite`, `dev` - what `devList.ts` already called it. */
  label: string
  /** The project it is in, or where its command line pointed. */
  where: string
  /** The port it was TOLD to serve on, which it is not serving. Usually the giveaway. */
  port: number | null
  /** How long it has been serving nothing, in whole minutes. */
  deadMin: number
}

/** A dead server picked out, plus the moment it will be stopped if nobody objects. */
export interface StopSoon {
  dev: DeadDev
  /** Epoch ms. `MoveSoon` draws the same shape from `deadline`. */
  deadline: number
}

export interface DeadDevConfig {
  /** Off turns the whole sweep off - nothing is measured and nothing is offered. */
  enabled: boolean
  /** Seconds on the countdown card before it is stopped. */
  countdownSeconds: number
}

export const DEFAULT_DEAD_DEV: DeadDevConfig = { enabled: true, countdownSeconds: 5 }

/**
 * How long a server has to be serving nothing before it counts.
 *
 * A dev server binds its port LATE: `next dev` spends several seconds compiling before it
 * listens, and a slow cold start on this Mac took 11s. A grace shorter than that turns
 * every start into a countdown, which is worse than the leak - the whole point is that
 * nobody has to watch this.
 */
export const DEAD_AFTER_MS = 90_000

/** How often the sweep looks. A leak costs memory by the minute, not by the second. */
export const SWEEP_MS = 60_000

/** After `Keep it running`, that pid is never offered again while it lives. */
export const KEPT_FOREVER = true

/**
 * Which of the running dev servers are serving nothing.
 *
 * `serving` is the set of dev-server pids that hold a listening socket, THEIR OWN OR A
 * DESCENDANT'S - `npm run dev` never holds the socket, the `next` it spawned does, and
 * `devList.ts` reports the ancestor. Resolving that belongs to whoever read the socket
 * table, because it needs the same process table the sockets were read against.
 *
 * `deadSince` is how long each pid has looked like this, kept by the caller across
 * sweeps. A pid absent from it is being seen for the first time and is never dead yet,
 * which is what gives a starting server its grace without a second timer.
 */
export function deadDevs(
  devs: RunningDev[],
  serving: Set<number>,
  deadSince: Map<number, number>,
  opts: { now: number; kept: Set<number>; supervised: Set<number> }
): DeadDev[] {
  const out: DeadDev[] = []
  for (const d of devs) {
    if (d.pid <= 1) continue
    if (serving.has(d.pid)) continue
    if (opts.kept.has(d.pid)) continue
    // A job something else restarts is not this app's to close: killing it wins nothing
    // (it comes back) and loses the log of why it went. Named, never guessed - the caller
    // reads launchd/Task Scheduler for it.
    if (opts.supervised.has(d.pid)) continue
    const since = deadSince.get(d.pid)
    if (!since || opts.now - since < DEAD_AFTER_MS) continue
    out.push({
      pid: d.pid,
      label: d.label,
      where: d.where,
      port: d.port,
      deadMin: Math.max(1, Math.round((opts.now - since) / 60_000))
    })
  }
  // Oldest first: the one that has been wasting memory longest is the one to offer.
  return out.sort((a, b) => b.deadMin - a.deadMin || a.pid - b.pid)
}

/**
 * Which pids are still dead-looking, with the moment each started looking that way.
 *
 * Returns a NEW map holding only pids seen this sweep, so a server that came back to life
 * or exited stops being remembered without anybody sweeping the memory separately. A pid
 * that was already dead keeps its ORIGINAL moment - resetting it on every sweep is how a
 * countdown never arrives.
 */
export function trackDead(
  devs: RunningDev[],
  serving: Set<number>,
  prev: Map<number, number>,
  now: number
): Map<number, number> {
  const next = new Map<number, number>()
  for (const d of devs) {
    if (serving.has(d.pid)) continue
    next.set(d.pid, prev.get(d.pid) ?? now)
  }
  return next
}

/**
 * The one to offer, and when it will happen - or nothing.
 *
 * One at a time on purpose. Two countdowns for two servers is two cards in a corner that
 * holds one, and a person who has just been told about a leak wants to read one sentence,
 * not audit a list. The next sweep offers the next one.
 *
 * A countdown already running is left exactly as it is: re-arming it every sweep would
 * make the number jump back up, which is the bug `MoveSoon` was fixed for on 2026-08-31.
 */
export function stopPlan(
  dead: DeadDev[],
  current: StopSoon | null,
  cfg: DeadDevConfig,
  now: number
): StopSoon | null {
  if (!cfg.enabled) return null
  if (current && dead.some((d) => d.pid === current.dev.pid)) return current
  const first = dead[0]
  if (!first) return null
  const secs = Math.max(1, Math.round(cfg.countdownSeconds || DEFAULT_DEAD_DEV.countdownSeconds))
  return { dev: first, deadline: now + secs * 1000 }
}

/** What the card says it is about to close. Plain: no pid, no ppid, no "orphan". */
export function stopSoonWords(dev: DeadDev): string {
  return `Closing the ${dev.label} server in ${dev.where}`
}

/**
 * Why, in one sentence a person who has never used git can act on.
 *
 * The port is the whole evidence when there is one - "it was told to serve 3006 and 3006
 * is not it" is checkable in a browser in two seconds, which is what makes this safe to
 * do automatically.
 */
export function stopSoonWhy(dev: DeadDev): string {
  const port = dev.port ? ` Nothing is answering on port ${dev.port}.` : ''
  return `It has been running ${dev.deadMin} min without serving anything.${port}`
}
