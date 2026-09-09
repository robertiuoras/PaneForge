// When a wedged renderer is worth reloading, and when reloading it again is the bug.
//
// 2026-08-28: the renderer pegged one thread at 100% for ~14 minutes while its main thread
// sat in `mach_msg`. Every pty, every session and the whole desk were fine - the main
// process never missed a beat - and the only way back was killing the app by hand. Nothing
// in `src/main` watched the window at all.
//
// The arithmetic is here, with no Electron in it, because the interesting half is the
// REFUSALS: a renderer is briefly unresponsive every time it is reloaded, so a watchdog
// that acts on that reloads for ever, and a renderer that spins again the moment it comes
// back is a bug this cannot fix by repeating itself. `npm run test:renderwatch`.

/** How long Chromium's own `unresponsive` verdict must stand before the window is reloaded. */
export const GRACE_MS = 10_000

/**
 * How often the JS thread is asked to answer, and how long an unanswered ask means a spin.
 *
 * Chromium raises `unresponsive` off its input hang monitor, so a renderer nobody is typing
 * into can spin indefinitely without it ever firing - which is exactly the shape of the
 * incident this was written for: the UI was dead and no event was emitted. The probe is a
 * trivial `executeJavaScript`, which queues on the renderer's own task queue: a healthy one
 * answers in single-digit ms whatever else it is doing, and a `while (true)` never answers.
 */
export const PROBE_EVERY_MS = 5_000
export const PROBE_DEAD_MS = 20_000

/** A reload takes a moment to become responsive again; that moment is not a second fault. */
export const RELOAD_COOLDOWN_MS = 60_000

/**
 * How many times this is allowed to fix the same window before it stops and says so.
 *
 * A renderer that wedges again within the cooldown is not being rescued by the reload, and
 * a watchdog that keeps trying turns one wedged window into a window that never finishes
 * loading. Past this it logs and leaves the app exactly as it was - which is the state the
 * app shipped in before any of this, and is recoverable by a person.
 */
export const MAX_RELOADS = 3

/**
 * How many self-healing wedges make a leak rather than a busy moment.
 *
 * 2026-09-05: one renderer went unresponsive eight times between 01:03 and 03:11, each
 * time answering again 19-55s later, with cpu pinned at 10.1-10.4% the whole while and
 * its working set climbing 161MB -> 286MB. Every single cycle read as "it came back", so
 * nothing was ever done about it. A renderer that recovers on its own once was busy; one
 * that does it twice is a stuck event loop with a growing heap behind it, and waiting for
 * the third is waiting for the machine.
 */
export const STUCK_WEDGES = 2

/**
 * Two wedges further apart than this are two incidents, not one leak.
 *
 * The cadence that produced the rule was one wedge every ~27 minutes for three hours, so
 * the window has to be wider than that or the count is reset before it can ever reach two.
 */
export const WEDGE_WINDOW_MS = 60 * 60 * 1000

export interface Watch {
  /** When Chromium last said the renderer stopped answering input. 0 = it is answering. */
  unresponsiveSince: number
  /** When the outstanding liveness probe was sent. 0 = none outstanding. */
  probeSentAt: number
  /** The renderer process died (`render-process-gone`) and there is nothing to reload. */
  gone: boolean
  reloads: number
  lastReloadAt: number
  /** Wedges seen since the last reload, within `WEDGE_WINDOW_MS` of each other. */
  wedges: number
  /** When the most recent wedge started, so a stale count can be dropped. */
  lastWedgeAt: number
}

export type Act = 'wait' | 'reload' | 'recreate' | 'give-up'

export function decide(w: Watch, now: number): Act {
  const spent = w.reloads >= MAX_RELOADS
  // A dead renderer is not a slow one: there is no page left to reload, so the window has
  // to be rebuilt. Said before the cooldown, because a process that is GONE is not going
  // to answer during it.
  if (w.gone) return spent ? 'give-up' : 'recreate'
  if (spent) return 'give-up'
  if (w.lastReloadAt && now - w.lastReloadAt < RELOAD_COOLDOWN_MS) return 'wait'
  // A renderer wedging again after healing itself is not waited out: the grace period is
  // there to let a busy frame finish, and this one has already proved it does not.
  if (w.unresponsiveSince && w.wedges >= STUCK_WEDGES) return 'reload'
  if (w.unresponsiveSince && now - w.unresponsiveSince >= GRACE_MS) return 'reload'
  if (w.probeSentAt && now - w.probeSentAt >= PROBE_DEAD_MS) return 'reload'
  return 'wait'
}

/** A fresh watch, and what a reload leaves behind. */
export function fresh(): Watch {
  return {
    unresponsiveSince: 0,
    probeSentAt: 0,
    gone: false,
    reloads: 0,
    lastReloadAt: 0,
    wedges: 0,
    lastWedgeAt: 0
  }
}

/**
 * Chromium said the renderer stopped answering. Counts it, and forgets a count that is
 * older than one incident - so a window that wedges once a day is never reloaded for it.
 */
export function noteWedge(w: Watch, now: number): Watch {
  const stale = w.lastWedgeAt !== 0 && now - w.lastWedgeAt > WEDGE_WINDOW_MS
  return {
    ...w,
    unresponsiveSince: w.unresponsiveSince || now,
    wedges: (stale ? 0 : w.wedges) + 1,
    lastWedgeAt: now
  }
}

export function afterAct(w: Watch, now: number): Watch {
  // The wedge count goes with it: the reload is the answer to those wedges, and the next
  // two are what say whether it worked.
  return {
    ...w,
    unresponsiveSince: 0,
    probeSentAt: 0,
    gone: false,
    reloads: w.reloads + 1,
    lastReloadAt: now,
    wedges: 0,
    lastWedgeAt: 0
  }
}
