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

export interface Watch {
  /** When Chromium last said the renderer stopped answering input. 0 = it is answering. */
  unresponsiveSince: number
  /** When the outstanding liveness probe was sent. 0 = none outstanding. */
  probeSentAt: number
  /** The renderer process died (`render-process-gone`) and there is nothing to reload. */
  gone: boolean
  reloads: number
  lastReloadAt: number
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
  if (w.unresponsiveSince && now - w.unresponsiveSince >= GRACE_MS) return 'reload'
  if (w.probeSentAt && now - w.probeSentAt >= PROBE_DEAD_MS) return 'reload'
  return 'wait'
}

/** A fresh watch, and what a reload leaves behind. */
export function fresh(): Watch {
  return { unresponsiveSince: 0, probeSentAt: 0, gone: false, reloads: 0, lastReloadAt: 0 }
}

export function afterAct(w: Watch, now: number): Watch {
  return { ...w, unresponsiveSince: 0, probeSentAt: 0, gone: false, reloads: w.reloads + 1, lastReloadAt: now }
}
