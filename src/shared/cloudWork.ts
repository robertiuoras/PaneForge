// Work this pane started that is NOT running on this machine.
//
// Every other "is there anything left going on in here" reading in this app is a reading
// of the local process table: `shared/paneJob.ts` asks the tty for its foreground
// command, `shared/paneBackJobs.ts` walks the pty's descendants for a shell subtree. A
// cloud session has neither. `/code-review ultra` hands the work to an agent running on
// somebody else's computer, returns to its composer, and the pane goes quiet with a
// review still in flight - so `job` is null, `backJob` is null, the card reads finished,
// and five minutes later the idle clock closes the pane the answer was going to land in.
// Robert, 2026-09-04: "theres still a cloud session running so probably shouldnt close
// the session".
//
// The only evidence that exists is the line the CLI prints in its own finished footer:
//
//   ✻ Cogitated for 2s · done 3:37 PM · ◇ 1 cloud session still running
//
// So this is a screen read, in the same family as `shared/busy.ts` and read off the same
// frame - the wide one that already travels to main with every "the turn ended" report.
//
// **It is a HOLD, not a fact, and the cap is the load-bearing part.** A pane that ends a
// turn and then sits there is never sent another finished frame, so nothing in this app
// reads the line going away when the cloud session finishes. A refusal keyed on "the line
// is on screen" would therefore be permanent, and a pane that can never be closed is a
// worse bug than a pane closed early - it is the idle clock switched off by accident, on
// whichever pane happened to run a review. So a sighting buys a bounded hold, refreshed
// by each new sighting, and the pane goes back on its clock when the hold runs out
// whatever the screen still says.
//
// `npm run test:cloudwork`.

/**
 * How long one sighting of the line holds the pane off the idle clock.
 *
 * Long enough to outlast the thing it is protecting: a `/code-review ultra` over a branch
 * runs in the tens of minutes, and the idle clock it is competing with is five. Short
 * enough that a pane whose screen keeps a stale footer for the rest of the day is back on
 * its clock within the hour.
 */
export const CLOUD_HOLD_MS = 45 * 60_000

/**
 * The CLI's own count of what it left running somewhere else, or null.
 *
 * Deliberately narrow. It must match the count and the noun and the word `running`
 * together on one line, because "cloud" on its own is a word that turns up in any
 * conversation about infrastructure, and a pane discussing cloud sessions must not become
 * a pane that cannot be closed.
 */
const CLOUD_LINE = /\b(\d+)\s+(cloud\s+session|shell)s?\s+(?:still\s+)?running\b/i

/**
 * ...and the SHELL half of that same footer, which was left out of this reader on the day
 * it was written on the grounds that a local shell is in the local process table where
 * `shared/paneBackJobs.ts` walks for it. It is not always: Robert, 2026-09-04, showed a
 * pane wearing `✻ Cogitated for 2m 56s · done 5:12 PM · 1 shell still running` AND a red
 * `closes 5min` chip at the same time - the render was going, the tree walk had not
 * attributed it, and the app was counting down on the pane that was doing the work.
 *
 * A sighting buys the same `CLOUD_HOLD_MS`, but a shell hold is also ENDED early by the
 * next finished footer that comes back without the line - see `holdAfterFinish`.
 */
const NOUNS: Record<string, string> = { 'cloud session': 'cloud session', shell: 'shell' }

/**
 * The finished footer itself: `✻ Crunched for 13m 2s · done 6:50 PM`. The spinner that
 * runs during a turn wears the same glyph (`✻ Cooking… (30s · …)`) but never `for 32s`.
 */
const FINISHED = /^[^\S\n]*✻[^\S\n]+\S+[^\S\n]+for[^\S\n]+\d+[hms]\b[^\n]*$/gm

/**
 * The newest finished footer and everything below it, or null when the frame has none.
 * A 44-row frame can hold an older turn's footer too, and only the newest one is news.
 */
function lastFooter(text: string): string | null {
  let at = -1
  for (const m of text.matchAll(FINISHED)) at = m.index
  return at < 0 ? null : text.slice(at)
}

/** `1 shell`, `3 cloud sessions` - what the card says, in the reader's words. */
export function readsCloudWork(text: string): string | null {
  const m = CLOUD_LINE.exec(lastFooter(text) ?? text)
  if (!m) return null
  const n = Number(m[1])
  if (!(n > 0)) return null
  const noun = NOUNS[m[2].replace(/\s+/g, ' ').toLowerCase()]
  if (!noun) return null
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Is a sighting still worth a refusal?
 *
 * `since` is when the line was LAST seen, not when it was first: a pane that keeps
 * reprinting it keeps the hold. No sighting at all is `undefined`, which is not 0 - a
 * pane that has never run one must never be held by an arithmetic accident.
 */
export function cloudHeld(since: number | undefined, now: number): boolean {
  return since !== undefined && since > 0 && now - since < CLOUD_HOLD_MS
}

const SHELL_RUNNING = /\b[1-9]\d*\s+shells?\s+(?:still\s+)?running\b/i

export type CloudHold = { work?: string; since?: number }

/**
 * The hold after one finished frame, the one main is sent with every `false` reading.
 *
 * A sighting starts or refreshes it. A SHELL hold is also ended by a later finished
 * footer drawn without its running line: the CLI appends that count to the finished
 * footer while a background shell is alive, so its absence means they all ended.
 * Measured on pane s91, 2026-09-24: `✻ Crunched for 13m 2s · done 6:50 PM · 1 shell
 * still running`, the shell ended, then `✻ Baked for 32s · done 6:51 PM` - and without
 * this the pane kept `1 shell` for another 44 minutes, refusing close, sleep and handoff.
 * A cloud session keeps the full hold: nobody has measured the CLI reprinting that line.
 * No finished footer in the frame (an interrupt, a question) says nothing either way.
 */
export function holdAfterFinish(held: CloudHold, frame: string, now: number): CloudHold {
  const work = readsCloudWork(frame)
  if (work) return { work, since: now }
  const foot = lastFooter(frame)
  if (held.work && /\bshells?$/.test(held.work) && foot !== null && !SHELL_RUNNING.test(foot)) return {}
  return held
}
