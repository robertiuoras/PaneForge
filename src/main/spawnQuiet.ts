// A fire-and-forget spawn cannot be guarded by a try/catch, and every one of them was.
//
// `spawn()` returns before the fork has happened, so a failure to start - ENOENT for a
// binary that is not on PATH, EAGAIN when the machine has run out of process slots -
// arrives LATER as an `error` EVENT on the child. A ChildProcess with no `error` listener
// re-emits it as an uncaught exception in the main process. So the synchronous
// `try { spawn(...) } catch { /* no taskkill on PATH */ }` written around five of these
// caught precisely nothing: the case each comment named was the case that crashed.
//
// Measured on this machine 2026-08-30 03:00:30 - two `uncaughtException: Error: spawn sh
// EAGAIN` a tenth of a second apart, out of `reapStrays` on a pane close, under load.
// `crash.ts` is why the app survived it, and with `faultNotify.ts` shipped that same
// throw now also buzzes a phone about a tidy-up that did not matter.
//
// These spawns are all tidy-ups and hand-offs whose failure is survivable BY DESIGN: a
// stray reaper, two `taskkill` sweeps that have a real kill behind them, the mac update
// swap. What they need is for the failure to be recorded rather than raised.

import { spawn, type SpawnOptions } from 'node:child_process'
import { logProblem } from './crash'

/**
 * Failures that are about the machine at this instant, not about the command.
 *
 * EAGAIN out of `fork` means the process table or the per-user process limit was full for
 * a moment - which on 2026-08-30 03:00:30 was two panes closing 74ms apart, each firing
 * its own stray reaper into a machine already carrying eight agent CLIs. Retrying is the
 * whole fix, because a tenth of a second later there is room. ENOMEM is the same shape.
 *
 * Everything else - ENOENT for a binary that is not there, EACCES for one that cannot be
 * run - is about the command, and will fail identically for ever. Those are logged once.
 */
const TRANSIENT = new Set(['EAGAIN', 'ENOMEM'])

/** Tries after the first. Three, spread over about two seconds. */
const RETRIES = 3

/** Backoff before try n (1-based), doubling. Kept small: these are all tidy-ups. */
function backoffMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1)
}

/**
 * Spawn something nobody waits for, and survive it failing to start.
 *
 * Returns the child so a caller that wants its pid still has one; a caller that does not
 * can ignore it. The child is `unref`'d here - every caller did that itself.
 */
export function spawnQuiet(
  bin: string,
  args: string[],
  opts: SpawnOptions,
  what: string
): ReturnType<typeof spawn> | null {
  return attempt(bin, args, opts, what, 0)
}

/**
 * The retry is asynchronous because the failure is: `spawn()` has already returned by the
 * time the machine says no. So a caller reading the returned child sees the FIRST one,
 * which is right - it exists, and a later try is what actually does the work.
 *
 * The one case a retry cannot reach is a spawn fired on the way out of the app, where
 * there is no later tick to be called back on. That is the mac update swap, and it is
 * why the swap is also re-attempted from scratch at the next launch (`adoptStaged`).
 */
function attempt(
  bin: string,
  args: string[],
  opts: SpawnOptions,
  what: string,
  tries: number
): ReturnType<typeof spawn> | null {
  const give = (err: unknown, retrying: boolean): void => {
    const code = (err as { code?: string })?.code ?? ''
    const message = err instanceof Error ? err.message : String(err)
    if (retrying) return logProblem('spawn retry', `${what}: ${bin} - ${message}, trying again in ${backoffMs(tries + 1)}ms`)
    logProblem('spawn failed', `${what}: ${bin} - ${message}${code && TRANSIENT.has(code) ? ` after ${tries + 1} tries` : ''}`)
  }
  const again = (err: unknown): boolean => {
    const code = (err as { code?: string })?.code ?? ''
    return TRANSIENT.has(code) && tries < RETRIES
  }
  const retry = (err: unknown): void => {
    give(err, true)
    const t = setTimeout(() => void attempt(bin, args, opts, what, tries + 1), backoffMs(tries + 1))
    t.unref?.()
  }
  try {
    const child = spawn(bin, args, opts)
    // The listener is the whole point: without it node re-raises this as an uncaught
    // exception in main. It is attached before `unref` so nothing can fire in between.
    child.on('error', (err) => (again(err) ? retry(err) : give(err, false)))
    child.unref()
    return child
  } catch (err) {
    // A synchronous throw is still possible (a bad options object), and is still not
    // worth taking the app down for.
    if (again(err)) {
      retry(err)
      return null
    }
    give(err, false)
    return null
  }
}
