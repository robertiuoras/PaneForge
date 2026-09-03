// Where a NEW pane starts, decided before anything is spawned.
//
// `shared/autoHandoff.ts` is the whole ladder for a pane that already exists: it trims,
// it moves, it closes, and every rung of it waits for a reading that says this machine is
// in trouble - the kernel's memory verdict, the load average, or a budget counting agents
// that are already running. That is the right shape for a pane somebody opened here on
// purpose, and once it is running it has a countdown and a Keep-it-here button, so a move
// mid-session is never a surprise.
//
// A pane that has not started yet is a different case, and 2026-09-03 is the second time
// Robert had to say so: "its automatically starting session remote when i want to start it
// on this laptop. if load is a lot then it can handoff mid session running with the
// countdown, but at the start i need to be able to start sessions here no matter what if i
// want to." A pane started from this desk - the + button, a shortcut, the composer, `pf
// open`, a route, a split, a swarm - starts on this desk. Always. Nothing this machine can
// measure about itself (memory, load, battery, how many panes are already open) moves it,
// and neither does whether the work looks "self-contained" enough for the other machine to
// run alone. The only automatic move left in the whole app is the mid-session ladder above.
//
// The one exception is the person's own pick: the New session dialog can send a pane to
// the other machine on purpose (`where: 'remote'`), and that still works, because the
// person chose it rather than the app guessing on their behalf.
//
// Every refusal names itself, because the whole feature is a pane appearing somewhere the
// person did not choose, and "why did this open on the PC" has to be answerable from
// `offload.log` without reading this file.
//
// Two things decide, in this order:
//
//   1. Was this a deliberate pick? `where === 'local'` is final. `where === 'remote'` is
//      the only path that can leave this desk at start, and even it still has to clear
//      the refusals below - a pick cannot send work to a machine that does not have it.
//   2. Everything else stays LOCAL. `machineBound` (a browser being driven on this desk),
//      `keepHere` (the project list on the pressure card), a bare pane with no prompt yet
//      (somebody about to type into it), a resumed conversation stored on this disk, and a
//      prompt about something only this machine has (`pinnedByPrompt`) all stay for the
//      same reason a pane with none of those reasons stays: nobody asked for it to move.
//
// A `where: 'remote'` pick still has to GET there: `shareable` (main/handoff.ts) is a git
// repo under the projects root with an origin remote (`undefined` means nobody has asked
// yet, and that is LOCAL - never guess remote, because guessing wrong opens the pane on a
// machine where the folder does not exist), the other machine has to be alive, and it has
// to have room (a peer already running a desk full of agents is not a destination; it is
// the next machine to fall over).
//
// Pure. `npm run test:offloadfirst`.

/**
 * The switch that used to decide whether an unpicked pane could leave this desk on its
 * own. Kept only because it is still written to disk from an older build and still read
 * by `preferRemoteOf` below (a value on disk is never assumed gone) - `placeNewPane` no
 * longer looks at it: 2026-09-03, nothing but a deliberate `where: 'remote'` pick moves a
 * pane at start any more.
 */
export type PreferRemote = 'auto' | 'always' | 'never'

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
  /**
   * The person's own pick, from the New session dialog. `local` is final. `remote` beats
   * every refusal that is about THEM (no brief, a switch, a kept project) but not one
   * about whether the work can get there at all - a pane cannot be sent to a machine that
   * does not have the folder, whoever asked.
   */
  where?: 'local' | 'remote'
  /** The script name of a dev server already serving this project from THIS machine. */
  devServer?: string
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

  // A pick made by hand outranks every rule about the person, and nothing below may
  // second-guess it: the dialog offered the choice, so the choice is the answer.
  if (i.where === 'local') return local('you chose this machine')
  if (i.where !== 'remote') {
    if (i.keepHere) return local('this project is kept on this machine')
    if (i.machineBound) return local(`this work is driving ${i.machineBound} on this screen`)
    // The person's own pane. No brief means somebody is about to type into it, and a pane
    // that appears on another screen the moment + is pressed is the app taking the desk
    // away from the one working at it.
    if (!i.prompt?.trim()) return local('you opened this pane to work in it yourself')
    if (i.resumes) return local('it continues a conversation stored on this machine')
    const pinned = pinnedByPrompt(i.prompt, i.cwd)
    if (pinned) return local(pinned)
    if (i.devServer) return local(`this project's dev server (${i.devServer}) is already serving from this machine`)
    // 2026-09-03 (Robert): "at the start i need to be able to start sessions here no
    // matter what if i want to." A pane opened on this desk stays on this desk unless the
    // person picked the other machine in the dialog - never because this desk measured
    // itself full, and never because the work looked self-contained. The only automatic
    // move left in the app is the mid-session handoff in autoHandoff.ts, which only ever
    // touches a pane that already exists and already has something to lose.
    return local('a pane you start here starts here')
  }
  // Not `!== true` written as a truthiness check on purpose: `undefined` and `false` are
  // both local, and they are different sentences. One is a folder nobody has measured, the
  // other is a folder that was measured and cannot be reached from the other machine.
  if (i.shareable === undefined) return local('nobody has checked whether this project is on GitHub yet')
  if (!i.shareable) return local('this folder is not a GitHub project the other machine has')
  if (!i.peerAlive) return local('no other machine is online with this project')
  if ((i.peerBusyPanes ?? 0) >= PEER_FULL_PANES) {
    return local(`the other machine is already running ${i.peerBusyPanes} panes`)
  }

  return { where: 'remote', reason: 'you chose the other machine' }
}
