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
  try {
    const child = spawn(bin, args, opts)
    // The listener is the whole point: without it node re-raises this as an uncaught
    // exception in main. It is attached before `unref` so nothing can fire in between.
    child.on('error', (err) => {
      logProblem('spawn failed', `${what}: ${bin} - ${err instanceof Error ? err.message : String(err)}`)
    })
    child.unref()
    return child
  } catch (err) {
    // A synchronous throw is still possible (a bad options object), and is still not
    // worth taking the app down for.
    logProblem('spawn failed', `${what}: ${bin} - ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
