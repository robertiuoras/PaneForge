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
 * How long a stretch of wedge-and-recover cycles counts as ONE bad renderer.
 *
 * 2026-09-09 log review, this Mac: pid 5075 went unresponsive and came back six times
 * between 01:03 and 03:11, the gaps growing 19s -> 55s, its working set climbing 205MB ->
 * 286MB and its cumulative CPU time 1:32 -> 23:13. Not one of those cycles reached
 * `GRACE_MS`, because `responsive` fires first and clears `unresponsiveSince` - so the
 * watchdog wrote twelve log lines about a renderer it never once acted on, while three
 * OTHER pids that missed a probe outright were reloaded within 20s of the first miss.
 *
 * A renderer that answers eventually is not healthy; it is a renderer with something
 * spinning behind it that keeps finishing just in time. Counting the cycles is the only
 * reading that tells it apart from a window that was briefly busy once.
 */
export const FLAP_WINDOW_MS = 30 * 60_000

/**
 * How many of those cycles inside the window before it is treated as a wedge.
 *
 * Three, not two: a machine under real load (a `npm test` fan-out, a video export) can
 * make one window miss its input hang monitor twice in half an hour with nothing at all
 * wrong with the page. Three inside thirty minutes is the shape above, and no other.
 */
export const MAX_FLAPS = 3

export interface Watch {
  /** When Chromium last said the renderer stopped answering input. 0 = it is answering. */
  unresponsiveSince: number
  /** When the outstanding liveness probe was sent. 0 = none outstanding. */
  probeSentAt: number
  /** The renderer process died (`render-process-gone`) and there is nothing to reload. */
  gone: boolean
  reloads: number
  lastReloadAt: number
  /** The window itself has already been rebuilt once. There is nothing left to escalate to. */
  recreated: boolean
  /** Wedge-and-recover cycles inside the current window. See `FLAP_WINDOW_MS`. */
  flaps: number
  /** When the current flap window opened. 0 = there is none. */
  flapSince: number
}

export type Act = 'wait' | 'reload' | 'recreate' | 'give-up'

export function decide(w: Watch, now: number): Act {
  const spent = w.reloads >= MAX_RELOADS
  // Reloads spent is not the end of what can be tried. A reload hands the same window a
  // fresh page; rebuilding the window hands the app a fresh window, which is the recovery
  // a person gets by quitting and reopening - and panes come back from desk.json and
  // `--resume` either way. Only once THAT has been spent is there nothing left.
  if (spent) return w.recreated ? 'give-up' : 'recreate'
  // A dead renderer is not a slow one: there is no page left to reload, so the window has
  // to be rebuilt. Said before the cooldown, because a process that is GONE is not going
  // to answer during it.
  if (w.gone) return 'recreate'
  if (w.lastReloadAt && now - w.lastReloadAt < RELOAD_COOLDOWN_MS) return 'wait'
  // Said AFTER the cooldown, because a reload leaves a renderer briefly unresponsive and
  // that recovery must never be counted as the fault it was the cure for.
  if (w.flaps >= MAX_FLAPS) return 'reload'
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
    recreated: false,
    flaps: 0,
    flapSince: 0
  }
}

export function afterAct(w: Watch, now: number, act?: Act): Watch {
  // The flap count goes with the act: the window that was flapping has just been taken
  // out from under the spin, so the next cycle is the first of a NEW stretch. Keeping the
  // old count would reload again the moment the fresh page blinked once.
  return {
    ...w,
    unresponsiveSince: 0,
    probeSentAt: 0,
    gone: false,
    reloads: w.reloads + 1,
    lastReloadAt: now,
    recreated: w.recreated || act === 'recreate',
    flaps: 0,
    flapSince: 0
  }
}

/**
 * A renderer that stopped answering has started answering again. Count it.
 *
 * The window is anchored on the FIRST cycle rather than the last, so a renderer that
 * flaps once an hour for a day never accumulates - only a stretch of them close together
 * reaches `MAX_FLAPS`.
 */
export function noteFlap(w: Watch, now: number): Watch {
  if (!w.flapSince || now - w.flapSince > FLAP_WINDOW_MS) return { ...w, flaps: 1, flapSince: now }
  return { ...w, flaps: w.flaps + 1 }
}
