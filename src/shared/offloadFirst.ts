// Where a NEW pane starts, decided before anything is spawned.
//
// `shared/autoHandoff.ts` is the whole ladder for a pane that already exists: it trims,
// it moves, it closes, and every rung of it waits for a reading that says this machine is
// in trouble - the kernel's memory verdict, the load average, or a budget counting agents
// that are already running. That is the right shape for a pane somebody opened here on
// purpose, and it is the wrong shape for the desk Robert actually has: a MacBook that is
// the screen, and an i7 with an RTX 3080 Ti sitting idle three feet away. By the time the
// pressure sweep fires, this machine has already paid for the CLI, the build it started
// and the lag - and the move is then a recovery instead of a decision.
//
// So this is the decision, taken at the one moment it is free: the pane has no pty yet,
// no conversation, no screen, nothing to lose. If the work is on GitHub and the other
// machine is up, the agent starts THERE and this desk gets the mirror.
//
// Every refusal names itself, because the whole feature is a pane appearing somewhere the
// person did not choose, and "why did this open on the PC" has to be answerable from
// `offload.log` without reading this file.
//
// Three rules decide, in this order, and the refusals come first so that `always` cannot
// reach past them:
//
//   1. The work has to be able to GET there. `shareable` (main/handoff.ts) is a git repo
//      under the projects root with an origin remote. `undefined` is "nobody has asked
//      yet", and it is LOCAL - never guess remote, because guessing wrong opens the pane
//      on a machine where the folder does not exist.
//   2. Nothing may pin it here: `machineBound` (a browser being driven on this desk),
//      `keepHere` (the project list on the pressure card), or the switch set to `never`.
//   3. The other machine has to be alive AND have room. A peer already running a desk
//      full of agents is not an offload target; it is the next machine to fall over.
//
//   4. The pane has to be WORK, and work the other machine can do. A pane opened with no
//      prompt is a person about to type into it - Robert on the Mac pressing +, which is
//      how he works (2026-09-02: "my way of working is mainly on mac") - and it stays
//      under his hands. A pane continuing a conversation stored on this disk stays with
//      that conversation. A prompt naming a file outside the project, a dev server, a
//      port, a browser, a screenshot, or this machine by name is about things the other
//      machine does not have (`pinnedByPrompt`), and so is a project whose dev server is
//      already serving from this desk.
//
// Then `auto` asks whether this desk should be collecting agents at all: past
// `REMOTE_FROM_PANES` running here, or on battery at any count, the answer is no.
//
// Pure. `npm run test:offloadfirst`.

/**
 * The switch. `auto` is the default and is the only value that reads the desk.
 *
 * `always` still obeys every refusal above it - it means "whenever it can go, send it",
 * not "send it regardless", because the refusals are the things that would lose the work
 * rather than merely move it.
 */
export type PreferRemote = 'auto' | 'always' | 'never'

/**
 * How many agents this machine runs before `auto` starts sending new work over.
 *
 * Two, the same number as `AutoHandoffConfig.keepLocal`, and deliberately the same: that
 * budget is already Robert's answer to "how many agents belong on the laptop", and having
 * a new pane start locally only to be moved by the budget sweep a minute later would be
 * the app doing the expensive thing first and then undoing it.
 *
 * The first two panes stay here on purpose. Opening a folder and having its agent appear
 * on another machine before this desk is under any load at all is the app being clever at
 * somebody, and the first pane of the day is nearly always the one being worked in.
 */
export const REMOTE_FROM_PANES = 2

/**
 * How many agents the OTHER machine is allowed to be running before it stops being a
 * destination. Above this, a new pane stays here: the point of the feature is that the
 * work runs where there is room, and the peer being full makes this desk the one with room.
 */
export const PEER_FULL_PANES = 8

/** How long the far end has to say it started the pane before this desk opens it here. */
export const REMOTE_START_ACK_MS = 8000

export interface PlaceInput {
  /**
   * Whether the folder's code can reach the other machine at all - a git repo under the
   * projects root with an origin remote. `undefined` means nobody has asked yet, and it
   * is treated as no: this decision happens once, at launch, and there is no second
   * reading to correct a guess.
   */
  shareable?: boolean
  /** What pins this work to this desk - a browser being driven here. See shared/paneBound.ts. */
  machineBound?: string
  /** A paired device that is online, holds this project, and answered a liveness probe. */
  peerAlive: boolean
  /** How many agents that device is already running, when it said. */
  peerBusyPanes?: number
  /** Agents running on THIS machine right now. Mirrors cost nothing and are not counted. */
  localPanes: number
  /** On battery, where an agent CLI and the build it starts are the expensive thing. */
  onBattery?: boolean
  /** This project is on the "never leaves this machine" list. */
  keepHere?: boolean
  /**
   * The brief typed into the agent once it is ready. Absent for a pane a person opened to
   * work in themselves, which is the one pane that must never appear on another screen.
   */
  prompt?: string
  /** The pane's own folder, so a path the prompt names can be told inside from outside. */
  cwd?: string
  /** Continuing a conversation that lives on this disk (`resume`, `resumeId`, a restore). */
  resumes?: boolean
  /** The script name of a dev server already serving this project from THIS machine. */
  devServer?: string
  mode: PreferRemote
}

export interface Placement {
  where: 'remote' | 'local'
  /** Plain words, written to `offload.log` and shown in a toast when a start falls back. */
  reason: string
}

/**
 * The switch, read off config.json, where it may be anything.
 *
 * `preferRemote` reaches disk through `pf-ctl call config:set` as well as the dialog, and
 * a value that is not one of the three is not a policy anybody chose - so it reads as
 * `auto`, which is the default rather than the loudest answer. Same reason
 * `offloadMinutes` exists in autoHandoff.ts: a boolean written by hand where a string was
 * expected must never become "send everything to the other machine".
 */
export function preferRemoteOf(cfg?: { preferRemote?: unknown }): PreferRemote {
  const m = cfg?.preferRemote
  return m === 'always' || m === 'never' || m === 'auto' ? m : 'auto'
}

/**
 * A path the other machine cannot have: outside this pane's folder. Mac and Windows homes,
 * a tilde, a volume, a temp dir. A path INSIDE the project is in git and travels; the
 * others are the person's own files on this disk, which no push carries over.
 */
const LOCAL_PATH = /(?:^|[\s"'`(=])(?:~\/|\$HOME\/|\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|[A-Za-z]:\\)[^\s"'`)]*/g
/** Something serving on this machine, or the shape of a port on it. */
const LOCAL_SERVER =
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|dev[- ]server|npm run (?:dev|start|serve)|(?:on |at )?port \d{2,5}|:\d{4,5}\b)/i
/** This screen: a browser or a picture of something drawn on it. */
const LOCAL_SCREEN = /\b(?:screenshot|screen ?shot|browser|chrome|safari|cdp|devtools|on (?:the )?screen)\b/i
/** The person naming this machine. */
const LOCAL_WORD = /\b(?:on (?:my|this) (?:mac|macbook|machine|laptop|computer)|locally|local(?:ly)? only|here)\b/i

/**
 * Why this brief is about things the other machine does not have, or undefined.
 *
 * Pinning local is the cheap mistake - it is what the app did all along - so every rule
 * here errs that way. The expensive one is a pane on the PC told to open a file that is
 * only on the Mac, or to look at a dev server that is serving on it.
 */
export function pinnedByPrompt(prompt: string | undefined, cwd?: string): string | undefined {
  const p = (prompt ?? '').trim()
  if (!p) return undefined
  const inside = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const m of p.matchAll(LOCAL_PATH)) {
    const path = m[0].trim().replace(/^["'`(=]/, '').replace(/\\/g, '/')
    if (inside && path.toLowerCase().startsWith(inside + '/')) continue
    return `it names a file on this machine (${path.length > 40 ? path.slice(0, 37) + '...' : path})`
  }
  const server = LOCAL_SERVER.exec(p)
  if (server) return `it is about something serving on this machine (${server[0]})`
  const screen = LOCAL_SCREEN.exec(p)
  if (screen) return `it is about this screen (${screen[0]})`
  const word = LOCAL_WORD.exec(p)
  if (word) return `it asks for this machine (${word[0]})`
  return undefined
}

export function placeNewPane(i: PlaceInput): Placement {
  const local = (reason: string): Placement => ({ where: 'local', reason })

  if (i.mode === 'never') return local('set to always start work on this machine')
  if (i.keepHere) return local('this project is kept on this machine')
  if (i.machineBound) return local(`this work is driving ${i.machineBound} on this screen`)
  // The person's own pane. No brief means somebody is about to type into it, and a pane
  // that appears on another screen the moment + is pressed is the app taking the desk
  // away from the one working at it. Above `always`: the switch is about WORK.
  if (!i.prompt?.trim()) return local('you opened this pane to work in it yourself')
  if (i.resumes) return local('it continues a conversation stored on this machine')
  const pinned = pinnedByPrompt(i.prompt, i.cwd)
  if (pinned) return local(pinned)
  if (i.devServer) return local(`this project's dev server (${i.devServer}) is already serving from this machine`)
  // Not `!== true` written as a truthiness check on purpose: `undefined` and `false` are
  // both local, and they are different sentences. One is a folder nobody has measured, the
  // other is a folder that was measured and cannot be reached from the other machine.
  if (i.shareable === undefined) return local('nobody has checked whether this project is on GitHub yet')
  if (!i.shareable) return local('this folder is not a GitHub project the other machine has')
  if (!i.peerAlive) return local('no other machine is online with this project')
  if ((i.peerBusyPanes ?? 0) >= PEER_FULL_PANES) {
    return local(`the other machine is already running ${i.peerBusyPanes} panes`)
  }

  if (i.mode === 'always') return { where: 'remote', reason: 'set to always start this work on the other machine' }
  if (i.onBattery) return { where: 'remote', reason: 'this machine is on battery' }
  if (i.localPanes >= REMOTE_FROM_PANES) {
    return { where: 'remote', reason: `this machine is already running ${i.localPanes} panes` }
  }
  return local(`this machine is only running ${i.localPanes} pane${i.localPanes === 1 ? '' : 's'}`)
}
