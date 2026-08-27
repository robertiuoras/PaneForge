// Moving panes to the other machine by itself, when this one is full.
//
// `capacity.ts` already knew when a desk was in trouble and already knew a paired device
// could help - `offloadTarget` sends the NEXT pane over there. But the pane that is eating
// the machine is one that is already open, and the only lever this app had for those was
// `reclaim.ts`, which CLOSES them. Closing is cheap to undo here and it is still the wrong
// answer while another machine is sitting idle with room: the work stops.
//
// So the ladder, cheapest and least destructive first, and each rung only runs when the one
// above it did not solve it:
//
//   1. trim scrollback            (capacity.ts)  - gives back ~5%, costs nothing
//   2. start the NEXT pane there  (capacity.ts)  - stops it getting worse
//   3. MOVE a finished pane there (this file)    - the work continues, on the other desk
//   4. close a finished pane      (reclaim.ts)   - the last resort, and only with no peer
//
// Rung 3 is only defensible because of what a handoff already is: the conversation, the
// code and the screen all travel, the sender's pane only closes once the far end says its
// replacement is running, and a pane whose repo cannot be pushed fails BY NAME and stays
// open. Nothing here can lose work that the manual button could not already lose.
//
// Two refusals decide whether this is safe rather than merely clever:
//
//   - **A pane mid-turn is never moved.** A handoff kills the pty, and killing a pty
//     mid-turn throws away the answer being written - the far end resumes from the
//     transcript, which only holds turns the CLI has already flushed. So a busy pane is
//     QUEUED and moved the instant its turn ends. That is what makes "hand off mid-turn"
//     mean the move happens as soon as it can rather than the turn being lost.
//   - **A pane holding a live question is never moved**, queued or otherwise. The chooser
//     is drawn on a screen, not in the transcript; resuming over there comes back with the
//     question gone and the agent waiting for something nobody was asked.
//
// Everything else is the same shape as `reclaim.ts`: pressure is the trigger; the focused
// pane and anything on screen are left alone; a failure puts that pane on a cooldown so a
// repo that cannot be pushed is not retried every fifteen seconds.
//
// ...and it is the same shape down to the exception. `idleOffloadPlan` is the opt-in clock
// beside all of that, mirroring `reclaim.idleClosePlan` exactly, because the two refusals
// above have a cost nobody saw until a desk was actually lagging: with the grid on every
// pane is `visible`, so the pressure sweep's eligible list is empty on a single-window
// desk and the feature could never once fire there. The clock drops `visible` and the
// pressure gate and NOTHING else.
//
// Pure. `npm run test:autohandoff`.

import type { OffloadCandidate, Verdict } from './capacity'
export { keepLocalOf } from './capacity'
import type { FleetState } from './fleet'
import { quietSince } from './reclaim'

export interface AutoHandoffConfig {
  /** Move finished panes to a paired device when this machine runs out of memory. */
  enabled: boolean
  /** How long a pane must have been quiet first, in minutes. */
  minIdleMinutes: number
  /** How many to move per reading. The next reading decides again. */
  maxPerSweep: number
  /** How long a pane that failed to move is left alone, in minutes. */
  cooldownMinutes: number
  /**
   * How long a pane queued mid-turn waits for its turn to end before the move is given up
   * on and said so. Never killed instead: the whole point of the queue is that a turn is
   * worth more than a megabyte.
   */
  waitMinutes: number
  /**
   * Move a quiet pane to a paired device on a CLOCK, whatever the memory says. Minutes; 0
   * is off, which is every desk that has not asked.
   *
   * The pressure sweep above can never fire on a single-window desk, and that is not a bug
   * in it - `visible` is a refusal there because moving something off somebody's screen
   * while their machine is busy is theft. But with the grid on, every pane is "on screen",
   * so the eligible list is empty on exactly the desk that is lagging. Same shape as
   * `reclaim.idleCloseMinutes`: a separate, opt-in clock, with `visible` as the ONLY
   * refusal dropped - because the clock has already established nobody has typed into this
   * pane for a long time, which is the fact the screen was standing in for.
   *
   * Longer than `minIdleMinutes` when it is turned on at all. Under pressure the app is
   * choosing between moving a pane and the machine falling over; here it is choosing to
   * move somebody's work while there is room, so the evidence has to be stronger.
   */
  offloadIdleMinutes: number
  /**
   * How many panes with a live agent this machine keeps for itself. 0 = no budget.
   *
   * The two clocks above are both reactive: one waits for the kernel to complain, the other
   * waits for a pane to go quiet for half an hour. Both are answers to "this desk is full
   * NOW", and neither can express the thing a laptop driving a second machine actually
   * wants - that it is the SCREEN, and past a couple of agents the work belongs on the
   * machine that is plugged in.
   *
   * So this is the budget, and it is the one rule allowed to move a pane that is on screen
   * and a pane that is mid-turn (queued, then moved the moment the turn ends). That is not
   * a relaxation of the refusals: everything that could lose work is still refused - the
   * pane you are typing in, one holding a question, one already moving, a mirror, the last
   * pane on the desk. What it drops is the two gates that only ever meant "there is no
   * emergency", because past the budget there is no emergency and the move is still right.
   *
   * `keepLocalOf` in capacity.ts hardens it, for the same reason `offloadMinutes` exists.
   */
  keepLocal: number
  /**
   * The memory a pane must actually be holding before the BUDGET rung will move it.
   *
   * The budget on its own counts panes, and a count is not a cost: five idle Claude Code
   * panes at ~190 MB apiece are three panes over a budget of two and are costing this
   * machine nothing anybody can feel. Moving one of those is the app rearranging somebody's
   * desk for a number - which is exactly what was reported on 2026-08-23, two panes gone to
   * the PC while the machine was fine.
   *
   * So past the budget the question stops being "how many" and becomes "which of these is
   * EXPENSIVE": a dev server, a build, a shell mid-command, an agent that has grown. A pane
   * under every threshold here is left alone however far over the budget the desk is, and
   * the desk simply stays over - there is nothing to save by moving it.
   *
   * 500 MB, because a fresh agent pane measures ~190 MB here and a Codex one 16-17 MB: the
   * floor has to sit above an ordinary pane doing nothing and below a pane running a build.
   */
  budgetMinMb: number
  /** ...or this much of one core, which is what a build or a dev server looks like. */
  budgetMinCpu: number
  /**
   * Projects that never leave this machine, by name.
   *
   * Robert, 2026-08-26: "automated windows need to keep on this laptop though since pc
   * cant do it". Some work is only correct HERE - a pane driving the Mac's own Keychain,
   * a browser probe against a local display, anything wired to this device's launchd - and
   * a move that is otherwise perfect breaks it silently, because the far end starts a
   * healthy-looking pane that cannot do the job.
   *
   * By PROJECT and not by session id, deliberately: a pane's id dies with the pane and this
   * has to survive a restart, and "this project's work is Mac-only" is the fact somebody
   * actually holds. Read by every rung - the two automatic sweeps and the suggestion on the
   * pressure card - so there is one answer to "may this leave", not three.
   */
  keepHere: string[]
}

export const DEFAULT_AUTO_HANDOFF: AutoHandoffConfig = {
  // On by default, because the refusals above are what make it safe and they hold whether
  // or not anybody read a setting. It still cannot fire without a paired device that is
  // online AND holds the same project by name, which is a desk that was set up on purpose.
  enabled: true,
  minIdleMinutes: 10,
  maxPerSweep: 2,
  cooldownMinutes: 30,
  waitMinutes: 30,
  offloadIdleMinutes: 0,
  // Two. It cannot fire without a paired device that is online and holds the same project,
  // so on a laptop with nothing paired this is the behaviour it always had; on a desk with
  // the other machine up it is the answer to opening a third pane. Everything moved comes
  // straight back as a mirror, so the number is about where agents RUN, never about how
  // many sessions can be watched from here.
  keepLocal: 2,
  budgetMinMb: 500,
  budgetMinCpu: 50,
  // Empty: nothing is Mac-only until somebody says so, and the only thing that says so is
  // "Keep it here" on the pressure card.
  keepHere: []
}

/**
 * What the switch sets `offloadIdleMinutes` to when it is turned on.
 *
 * Three times `minIdleMinutes`, on purpose. That one runs while the machine is falling
 * over, where being a few minutes early costs a reopen; this runs while there is still
 * room, where being early moves work somebody was about to come back to.
 */
export const IDLE_OFFLOAD_MINUTES = 30

/**
 * How long the clock waits, or 0 for off. The ONE reader of `offloadIdleMinutes`.
 *
 * A plain `> 0` is not enough here and TypeScript does not cover it: this value comes off
 * config.json and, since `pf-ctl call config:set` exists, off a script. `true > 0` is true
 * and `true * 60_000` is one minute, so a switch written as a boolean by hand would silently
 * turn into "move anything quiet for a minute" - the opposite of the conservative default,
 * arrived at through a value nobody typed as a number.
 */
export function offloadMinutes(cfg: Pick<AutoHandoffConfig, 'offloadIdleMinutes'>): number {
  const m = cfg.offloadIdleMinutes
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 0
}

export interface AutoPane {
  id: string
  state: FleetState
  /** epoch ms of the last thing a person typed into it */
  lastKeyboard: number
  /**
   * epoch ms the pty last printed anything, when the caller knows it.
   *
   * Same reading, and the same reason, as `ReclaimPane.lastOutput`: a person types one
   * prompt and the agent works for two hours, so keystrokes alone call a pane that has
   * never stopped working "quiet for two hours". Quiet means nobody has typed AND the
   * pane has printed nothing.
   */
  lastOutput?: number
  /** epoch ms the keyboard last left it - see `ReclaimPane.lastFocus`, same reading */
  lastFocus?: number
  focused: boolean
  visible: boolean
  /** another device's pty, mirrored here - moving it frees nothing on this machine */
  remote: boolean
  /** already on its way somewhere, from an earlier sweep or the button */
  handingOff: boolean
  /**
   * The pane is sitting on a question the agent drew on screen: a chooser, or a rung bell.
   *
   * Separated from `state` on purpose. `fleetState` calls a pane `needsYou` both when a
   * turn simply ENDED and when a question is live, and those are opposites here: a finished
   * turn is the best possible moment to move a pane, and a live question is the one moment
   * that must not be.
   */
  asking: boolean
  /**
   * A turn is in flight right now.
   *
   * Only the budget rule reads it, and it reads it to ORDER rather than to refuse: a busy
   * pane is the last one picked, and when it is picked the move is queued and happens the
   * moment the turn ends. The other two rules never see a busy pane at all, because
   * `movable` refuses it outright.
   */
  busy?: boolean
  /**
   * The device that handed this pane here, when one did.
   *
   * The budget rule refuses to send it back there, and that refusal is what stops the one
   * failure mode a policy has that a pressure reading does not: two desks each keeping two
   * agents are each correct about their own budget, and between them they would pass one
   * pane back and forth for ever. A pressure sweep cannot do this - the other machine has
   * to be genuinely out of memory for its half of the loop, and the move fixes that.
   */
  arrivedFrom?: string
  /** what this pane's folder is called as a project - the only portable name for it */
  projectName: string
  /**
   * What this pane is really holding, in MB, when the sampler has an answer for it.
   *
   * `undefined` is "not measured", never "cheap": the sampler does not read the process
   * table while the window is hidden, so a desk that has been minimised for an hour has no
   * figures at all. An absent reading may not make a pane movable - the same rule
   * `os.loadavg()` returning 0 on Windows already has - so `expensive` treats it as small
   * and the pane stays. Being wrong the other way moves somebody's work for a number
   * nobody took.
   */
  memMb?: number
  /** the same reading for CPU, as a percentage of ONE core, or undefined for unmeasured */
  cpuPct?: number
  /**
   * A command this pane is running right now that is not the agent itself: `npm run dev`,
   * a build, anything `shared/paneJob.ts` found in a shell pane's foreground.
   *
   * It outranks both numbers. A dev server that has just started is holding little and
   * doing nothing measurable, and is still the pane worth moving - it is about to be the
   * expensive one, and it is the case Robert named.
   */
  job?: string
  /**
   * Something the agent left running in the background (`shared/paneBackJobs.ts`).
   *
   * A REFUSAL, and deliberately not another `job`. `job` means "worth moving": a dev
   * server that has just started costs nothing yet and is the pane to move. A background
   * job is the opposite - moving a pane kills its pty and starts a fresh one on the other
   * machine, so a build three minutes into twenty dies with it, and unlike a turn there is
   * nothing to queue behind: the work is not going to announce that it finished.
   */
  backJob?: string
  /**
   * Why this pane's WORK cannot follow it to another machine (`shared/paneBound.ts`).
   *
   * A refusal, and a different one from `backJob`. A background job is work that would be
   * killed by the move and could have been waited for; this is work that would not exist
   * over there however long anybody waited - a browser being driven on this desk, against
   * this machine's window server and this machine's logged-in profile, with nothing about
   * it in a commit. Robert named the case (2026-08-28): automated Chrome stays here.
   */
  machineBound?: string
  /**
   * Whether the far end could get this pane's CODE, or undefined for "nobody asked".
   *
   * A move only works because the repo travels: the sender commits what is dirty under an
   * `auto-sync:` subject and pushes, and the receiver pulls that branch. A checkout with
   * no origin remote, or one outside the projects root, has no such path - and until now
   * that was discovered by ATTEMPTING the move, which killed nothing but did count the
   * pane down, name a machine, and fail. Read first instead.
   *
   * `undefined` is deliberately permissive, and this is the one place in this file where
   * an unmeasured reading does not refuse: every caller in the app feeds it, so undefined
   * only happens in a test that is asking about something else, and treating it as false
   * there would switch the whole ladder off for a fact nobody was testing.
   */
  shareable?: boolean
}

export interface AutoHandoff {
  id: string
  device: string
  deviceName: string
  /** THAT device's path for the same project, so the far end opens the right folder */
  cwd: string
  idleMs: number
}

/** States a pane may be moved out of. Everything else is a turn in flight. */
export function movable(p: Pick<AutoPane, 'state' | 'asking' | 'backJob' | 'machineBound' | 'shareable'>): boolean {
  if (p.asking) return false
  // Killing the pty takes the background work with it, and there is no turn boundary to
  // wait for. See `AutoPane.backJob`.
  if (p.backJob) return false
  // The work itself does not exist on the other machine. See `AutoPane.machineBound`.
  if (p.machineBound) return false
  // ...and neither does the code. See `AutoPane.shareable`.
  if (p.shareable === false) return false
  // `exited` is left to reclaim: there is no agent to move, only a row to close.
  return p.state === 'ready' || p.state === 'needsYou'
}

/**
 * States a pane may be QUEUED out of, which is a wider set than `movable`.
 *
 * The difference is what happens next. `movable` is asked by the two rules that move a
 * pane on the spot, so a turn in flight has to be refused: the kill that ends a handoff
 * would throw the unfinished answer away. The budget rule hands the pane to the queue
 * instead, and the queue's whole job is to wait for that turn to end - so `working` and
 * `stalled` are eligible here and the answer is never at risk.
 *
 * Still refused: a live question (drawn on a screen, in no transcript, so it arrives over
 * there with nobody asked), a pane that has exited (nothing to move), and one that has
 * not printed yet - `starting` has no transcript to resume from and no screen to carry.
 */
export function queueable(p: Pick<AutoPane, 'state' | 'asking' | 'backJob' | 'machineBound' | 'shareable'>): boolean {
  if (p.asking) return false
  if (p.backJob) return false
  if (p.machineBound) return false
  if (p.shareable === false) return false
  return p.state === 'ready' || p.state === 'needsYou' || p.state === 'working' || p.state === 'stalled'
}

/** The peer that can take this project, or null. Same rules as `offloadTarget`. */
export function hostFor(
  peers: OffloadCandidate[],
  projectName: string,
  /** a device this pane may not go to - the one it was handed here from */
  avoid?: string
): { device: string; deviceName: string; cwd: string } | null {
  if (!projectName) return null
  for (const c of peers) {
    if (!c.online) continue
    if (avoid && c.device === avoid) continue
    const hit = c.projects.find((p) => p.name === projectName)
    if (hit) return { device: c.device, deviceName: c.deviceName, cwd: hit.path }
  }
  return null
}

/**
 * Which panes to move, and where, or an empty list.
 *
 * `blocked` is id -> epoch ms until which that pane is not to be retried, which is how a
 * repo with an unpushable checkout stops being asked about on every reading.
 */
export function autoHandoffPlan(
  panes: AutoPane[],
  v: Verdict,
  peers: OffloadCandidate[],
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  blocked: Record<string, number> = {},
  now = 0
): AutoHandoff[] {
  if (!cfg.enabled) return []
  // The budget first, and it does not consult the level at all: `Verdict.over` is this
  // desk's own statement about where agents run, and it is true at `ok`. When it is set,
  // the reading that follows is about a machine that is ALREADY past what it agreed to
  // hold, so waiting ten quiet minutes and skipping every pane on screen would be waiting
  // for permission that has already been given.
  const over = Math.max(0, v.over ?? 0)
  if (over > 0) return budgetPlan(panes, peers, cfg, blocked, now, over)
  // Otherwise the same trigger as every other rung: `ok` means the kernel is content, and
  // moving somebody's pane to another machine while there is room here is not a tidy-up,
  // it is the app deciding where they work.
  if (v.level === 'ok') return []
  if (!(cfg.maxPerSweep > 0)) return []
  return pick(panes, peers, cfg, blocked, now, Math.max(0, cfg.minIdleMinutes), true)
}

/**
 * The panes that are past the budget, moved now.
 *
 * `over` comes from `Verdict.over` - `localPanes - keepLocal` - and is exactly how many
 * this returns, rather than `maxPerSweep`. That cap is there so a machine under pressure
 * re-reads its own recovery between moves instead of emptying itself on one reading; here
 * the number is not a guess about how much would help, it IS the overshoot, and moving two
 * of five per minute while a build session opens panes faster than that never converges.
 * The moves are carried out one at a time by the caller either way.
 *
 * Two gates are dropped and only two. `visible`, because with the grid on every pane is on
 * screen and keeping it means the rule can never fire on the one-window desk it exists for
 * - and because a moved pane comes straight back as a mirror, so what is on screen stays
 * on screen. And the idle wait, because a budget is not a statement about idleness.
 *
 * Busy panes are eligible and are picked LAST: the sort walks quiet-and-offscreen first,
 * then quiet-and-visible, then whatever is mid-turn. A busy one that does get picked is
 * queued by main and moves when its turn ends - nothing is ever killed mid-answer.
 */
/**
 * What this pane costs, as one number, for ordering only.
 *
 * MB and % of a core are not the same unit and this does not pretend they are: it is a
 * sort key, and the only claim it makes is "more of either is more expensive". A pane with
 * a job of its own is lifted above every measured pane, for the reason on `AutoPane.job`.
 */
export function paneCost(p: Pick<AutoPane, 'memMb' | 'cpuPct' | 'job'>): number {
  return (p.job ? 1_000_000 : 0) + (p.memMb ?? 0) + (p.cpuPct ?? 0) * 20
}

/**
 * Whether moving this pane would actually give the machine something back.
 *
 * The whole point of the budget rung after 2026-08-23: past the budget a pane is moved
 * because of what it COSTS, never because of where it sits in a count. An unmeasured pane
 * is not expensive - see `AutoPane.memMb`.
 */
export function expensive(
  p: Pick<AutoPane, 'memMb' | 'cpuPct' | 'job'>,
  cfg: Pick<AutoHandoffConfig, 'budgetMinMb' | 'budgetMinCpu'> = DEFAULT_AUTO_HANDOFF
): boolean {
  if (p.job) return true
  if ((p.memMb ?? 0) >= thresholdOf(cfg.budgetMinMb, DEFAULT_AUTO_HANDOFF.budgetMinMb)) return true
  return (p.cpuPct ?? 0) >= thresholdOf(cfg.budgetMinCpu, DEFAULT_AUTO_HANDOFF.budgetMinCpu)
}

/**
 * A cost threshold off config.json, which is also what `pf-ctl call config:set` writes.
 *
 * `Math.max(0, NaN)` is NaN and every `>=` against NaN is false, so a non-numeric value
 * did not fall back to the default - it silently switched BOTH cost gates off and left the
 * budget rung deciding on `job` alone. Same hardening as `keepLocalOf`, and for the same
 * reason: a value nobody validated on the way in must not disable a rule on the way out.
 */
function thresholdOf(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : fallback
  // `Number(null)` and `Number('')` are BOTH 0, not NaN - so a coercion-only guard turns a
  // missing value into a threshold of zero, which every pane clears. That is not the safe
  // direction: it moves work off the machine on a value nobody set. Only a non-empty
  // numeric string is believed.
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.max(0, n)
  }
  return fallback
}

export function budgetPlan(
  panes: AutoPane[],
  peers: OffloadCandidate[],
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  blocked: Record<string, number> = {},
  now = 0,
  over = 0
): AutoHandoff[] {
  if (!cfg.enabled || over <= 0) return []
  const eligible = panes
    .filter((p) => !p.focused && !p.remote && !p.handingOff && queueable(p))
    // Mac-only work, per `AutoHandoffConfig.keepHere`. Before the cost gate on purpose: the
    // dearest pane on the desk is exactly the one this list exists to hold back.
    .filter((p) => !staysHere(cfg, p.projectName))
    .filter((p) => !((blocked[p.id] ?? 0) > now))
    // The cost gate. A desk five panes over its budget with nothing expensive on it moves
    // NOTHING and stays over - which is the honest answer, because there is nothing here
    // to give back. See `AutoHandoffConfig.budgetMinMb`.
    .filter((p) => expensive(p, cfg))
    // Dearest first, and only then the old ordering. Cost is why this rung exists now, so
    // it decides; `rank` still keeps a mid-turn pane behind a quiet one of the same size,
    // and `quietSince` still breaks the tie after that.
    .sort(
      (a, b) => paneCost(b) - paneCost(a) || rank(a) - rank(b) || quietSince(a) - quietSince(b)
    )

  // Never the last pane, exactly as above: a desk with nothing on it has not been helped.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  // The cap is on how many are MOVED, never on how many are looked at. `slice(0, room)`
  // reads the same and is not: a pane whose project no peer has fails `hostFor` and is
  // skipped, but it has already spent one of the slots, so a desk whose quietest panes
  // belong to a project the other machine does not hold moves one pane instead of three
  // and is still over budget on the next sweep, for ever - a plan that cannot converge.
  const cap = Math.min(over, room)
  const out: AutoHandoff[] = []
  for (const p of eligible) {
    if (out.length >= cap) break
    // Never back where it came from. The desk over there runs this same rule.
    const host = hostFor(peers, p.projectName, p.arrivedFrom)
    if (!host) continue
    out.push({ id: p.id, ...host, idleMs: now - quietSince(p) })
  }
  return out
}

/**
 * Is this pane's project one that may not leave this machine?
 *
 * Compared case-insensitively on the trimmed name, because the list is written from a card
 * that prints the project as `place.ts` words it, and a stored `PaneForge ` that never
 * matches `PaneForge` is a refusal that silently stops refusing.
 */
export function staysHere(cfg: Pick<AutoHandoffConfig, 'keepHere'>, projectName: string): boolean {
  const want = (projectName ?? '').trim().toLowerCase()
  if (!want) return false
  return (cfg.keepHere ?? []).some((n) => n.trim().toLowerCase() === want)
}

/**
 * The one pane worth moving right now, named, or null - what the pressure card OFFERS.
 *
 * The card said "memory is tight" and left the reader to work out which of eleven panes to
 * do something about, which is the half of the reading nobody has. This answers it with the
 * pane and the machine, so the card can carry the move as a press.
 *
 * It is `budgetPlan`'s eligibility with two deliberate differences and no others. The cost
 * gate is dropped, because a card that appears BECAUSE memory is tight has already made the
 * statement `expensive()` exists to make, and refusing to name anything on a desk of eleven
 * unmeasured panes would be a card that says there is nothing to do while the machine
 * swaps. And nothing is capped or moved here: this returns one suggestion, and a person
 * presses it.
 *
 * Every refusal that protects work is `budgetPlan`'s, verbatim: never the focused pane,
 * never a mirror, never one already moving, never one holding a live question, never the
 * last pane on the desk, never back where it came from, and never a project marked
 * `keepHere`.
 */
export function suggestMove(
  panes: AutoPane[],
  peers: OffloadCandidate[],
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  blocked: Record<string, number> = {},
  now = 0
): AutoHandoff | null {
  if (!cfg.enabled) return null
  const eligible = panes
    .filter((p) => !p.focused && !p.remote && !p.handingOff && queueable(p))
    .filter((p) => !staysHere(cfg, p.projectName))
    .filter((p) => !((blocked[p.id] ?? 0) > now))
    .sort(
      (a, b) => paneCost(b) - paneCost(a) || rank(a) - rank(b) || quietSince(a) - quietSince(b)
    )
  // The window is never emptied, here either.
  if (panes.length - eligible.length < 1 && eligible.length <= 1) return null
  for (const p of eligible) {
    const host = hostFor(peers, p.projectName, p.arrivedFrom)
    if (!host) continue
    return { id: p.id, ...host, idleMs: now - quietSince(p) }
  }
  return null
}

/** Cheapest to move first: quiet and off-screen, then quiet, then mid-turn. */
function rank(p: AutoPane): number {
  return (p.busy ? 2 : 0) + (p.visible ? 1 : 0)
}

/**
 * The same move on a CLOCK, for the desk the sweep above can never reach.
 *
 * Off unless `offloadIdleMinutes` says otherwise, which is the whole reason it is allowed
 * to exist beside `autoHandoffPlan`: that one is what a machine may do while it is falling
 * over, and this is what a machine may be TOLD to do while it is merely busy.
 *
 * Two gates are dropped and nothing else. Pressure, because the clock is the trigger here -
 * lag arrives long before the kernel admits to it, and a pane quiet for half an hour costs
 * its ~190 MB the whole time. And `visible`, for the reason written on `offloadIdleMinutes`
 * and already settled by `idleClosePlan`: with the grid on, every pane is on screen, so
 * keeping it means the feature can never fire on the desk it was built for.
 *
 * Everything that makes this safe is kept verbatim: never the focused pane, never a mirror,
 * never one already moving, never one mid-turn or holding a live question, never the last
 * pane, the failure cooldown, and `maxPerSweep`.
 */
export function idleOffloadPlan(
  panes: AutoPane[],
  peers: OffloadCandidate[],
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  blocked: Record<string, number> = {},
  now = 0
): AutoHandoff[] {
  if (!cfg.enabled) return []
  const minutes = offloadMinutes(cfg)
  if (!minutes) return []
  if (!(cfg.maxPerSweep > 0)) return []
  return pick(panes, peers, cfg, blocked, now, minutes, false)
}

/** The body both plans share. `screen` is whether a pane on screen is refused. */
function pick(
  panes: AutoPane[],
  peers: OffloadCandidate[],
  cfg: AutoHandoffConfig,
  blocked: Record<string, number>,
  now: number,
  minIdleMinutes: number,
  screen: boolean
): AutoHandoff[] {
  const minIdle = minIdleMinutes * 60_000

  const out: AutoHandoff[] = []
  const eligible = panes
    .filter((p) => !p.focused && !p.remote && !p.handingOff && movable(p))
    .filter((p) => !staysHere(cfg, p.projectName))
    .filter((p) => !(screen && p.visible))
    .filter((p) => now - quietSince(p) >= minIdle)
    .filter((p) => !((blocked[p.id] ?? 0) > now))
    .sort((a, b) => quietSince(a) - quietSince(b))

  // Never the last pane, for the same reason reclaim never empties the window: a desk with
  // nothing on it has not been helped.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  // Same shape as `budgetPlan`: the cap is on moves, not on candidates examined. A pane
  // no peer can host is skipped rather than spending a slot, or a desk whose quietest pane
  // belongs to a project the other machine does not have moves nothing at all.
  const cap = Math.min(Math.max(0, cfg.maxPerSweep), room)
  for (const p of eligible) {
    if (out.length >= cap) break
    const host = hostFor(peers, p.projectName)
    if (!host) continue
    out.push({ id: p.id, ...host, idleMs: now - quietSince(p) })
  }
  return out
}

// ---------------------------------------------------------------------------
// The queue: a pane asked for mid-turn, moved when the turn ends

export interface Queued {
  id: string
  device: string
  /** epoch ms it was asked for */
  since: number
  closeReceiverWhenDone?: boolean
}

/** What to do with a queued pane on this tick. */
export type QueueVerdict =
  /** its turn has ended and no question is on screen: move it now */
  | 'go'
  /** still working, or holding a question: leave it queued */
  | 'wait'
  /** it waited longer than the budget: give up and say so, never kill it */
  | 'expired'
  /** the pane is gone - closed, or exited on its own */
  | 'drop'

export function queueVerdict(
  q: Queued,
  pane: Pick<AutoPane, 'state' | 'asking'> | undefined,
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  now = 0
): QueueVerdict {
  if (!pane || pane.state === 'exited') return 'drop'
  if (movable(pane)) return 'go'
  if (now - q.since >= Math.max(1, cfg.waitMinutes) * 60_000) return 'expired'
  return 'wait'
}

/** The line the pane's report prints while it is waiting. */
export function queuedNote(deviceName: string): string {
  return `Working - moving to ${deviceName} as soon as this turn ends`
}
