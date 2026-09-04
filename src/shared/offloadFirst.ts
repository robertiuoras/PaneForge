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
// Then `auto` answers LOCAL, always. It used to read the desk - a pane count and the
// battery (2026-09-02), then the kernel's memory verdict (2026-09-03) - and every reading
// sent a pane the person had just opened to the other screen, so they worked in mirrors
// ("i need to open in local mac"; 2026-09-04: "i dont want them to start remote unless i
// tell it to"). Starting is the one moment somebody is certainly at this desk. The pressure
// reading still exists and is still used, on panes already running: shared/autoHandoff.ts
// moves the dearest finished pane and shared/reclaim.ts pauses idle ones, each with a card.
// `always` is the switch for somebody who wants new work over there regardless.
//
// Pure. `npm run test:offloadfirst`.

/**
 * The switch. `auto` is the default and is the only value that reads the desk.
 *
 * `always` still obeys every refusal above it - it means "whenever it can go, send it",
 * not "send it regardless", because the refusals are the things that would lose the work
 * rather than merely move it.
 */
import type { Pressure } from './capacity'

export type PreferRemote = 'auto' | 'always' | 'never'

/**
 * How many agents the OTHER machine is allowed to be running before it stops being a
 * destination. Above this, a new pane stays here: the point of the feature is that the
 * work runs where there is room, and the peer being full makes this desk the one with room.
 */
export const PEER_FULL_PANES = 8

/**
 * How many agents a NAMED device may run before an explicit `pf open ... --on <device>` (or
 * the dialog's own device pick) stops adding more. Robert asking for a machine by name is a
 * decision, not a suggestion `auto` can second-guess at `PEER_FULL_PANES` - the whole point
 * of "10s, 20+ at a time" is a batch past the soft cap that still stops somewhere.
 */
export const PEER_HARD_PANES = 24

/** How long the far end has to say it started the pane before this desk opens it here. */
export const REMOTE_START_ACK_MS = 8000

/**
 * How long the corner card waits before an app-decided move goes ahead.
 *
 * A pane the APP decided to start on the other machine is announced first - "starting X
 * on PC in 8s", with a button that keeps it here - because a pane appearing on another
 * screen with nothing said is the app taking the desk away from the person at it
 * (2026-09-03: "it should at least have popup saying it will move the session over to
 * remote and allow me to stop it"). Doing nothing lets the decision stand, so a launch
 * from the phone or a script with nobody at the screen is never held up by a card nobody
 * will press. A pane the PERSON sent there (`where: 'remote'`) gets no card: they chose.
 */
export const OFFLOAD_ASK_MS = 8000

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
  /**
   * A NAMED device asked for (id or Devices name) - `pf open --on <device>` or the New
   * session dialog's own pick. Beats `where`: it is checked before every other rule below,
   * and it never falls back to this machine. See `deviceOnline`/`deviceHasProject`.
   */
  device?: string
  /** Whether the named `device` is online right now. */
  deviceOnline?: boolean
  /**
   * Whether the named `device` holds this project. `undefined` reads as no - nobody has
   * confirmed it, and a device asked for by name is refused rather than guessed onto.
   */
  deviceHasProject?: boolean
  /**
   * What this machine says about itself right now: the memory verdict and the lag band,
   * worse of the two (`worstPressure`). Absent reads as `normal` - an unmeasured desk is
   * not a desk in trouble.
   */
  pressure?: Pressure
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
  mode: PreferRemote
}

export interface Placement {
  where: 'remote' | 'local'
  /** Plain words, written to `offload.log` and shown in a toast when a start falls back. */
  reason: string
  /**
   * Set only when a NAMED device (`PlaceInput.device`) could not be used. `where` still
   * reads `'local'` for callers that only check that field, but a device asked for by name
   * never falls back to this machine - a caller seeing `refused` opens no pane at all and
   * says why, by name, instead of silently landing here.
   */
  refused?: string
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

  // A device asked for BY NAME beats everything, including `where` - see the field's own
  // doc comment on `StartSessionRequest`. It never falls back to this machine: a refusal
  // here means no pane opens anywhere, decided by the caller reading `refused`.
  if (i.device) {
    const name = i.device
    if (!i.deviceOnline) {
      const why = `${name} is not online`
      return { where: 'local', reason: why, refused: why }
    }
    if (i.deviceHasProject !== true) {
      const why = `${name} does not have this project`
      return { where: 'local', reason: why, refused: why }
    }
    if ((i.peerBusyPanes ?? 0) >= PEER_HARD_PANES) {
      const why = `${name} is already running ${i.peerBusyPanes} panes`
      return { where: 'local', reason: why, refused: why }
    }
    return { where: 'remote', reason: `asked for ${name}` }
  }

  // A pick made by hand outranks every rule about the person, and nothing below may
  // second-guess it: the dialog offered the choice, so the choice is the answer.
  if (i.where === 'local') return local('you chose this machine')
  if (i.where !== 'remote') {
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

  if (i.where === 'remote') return { where: 'remote', reason: 'you chose the other machine' }
  if (i.mode === 'always') return { where: 'remote', reason: 'set to always start this work on the other machine' }
  // `auto` never moves a pane at START. Every earlier cut of this rule - pane count,
  // battery (2026-09-02), then the memory verdict at 'warn' (2026-09-03), then only at
  // 'critical' - put a pane the person had just asked for on the other screen, and each
  // time the report was the same: "i dont want them to start remote unless i tell it to"
  // (2026-09-04). The moment of starting is the one moment the person is certainly at
  // this desk, so the pane opens here. Pressure is answered where it is measured, on a
  // pane that is already running: the ladder in shared/autoHandoff.ts and shared/reclaim.ts
  // pauses finished panes and moves the dearest one, mid-session, with its countdown card.
  // Remote at start is only ever asked for: the dialog's pick, `always`, or `pf open`.
  const pressure = i.pressure ?? 'normal'
  if (pressure === 'critical') return local('this machine is short of memory, but a new pane still starts here; running panes are what get paused or moved')
  if (pressure === 'warn') return local('this machine is getting low on memory, but idle panes are being paused to make room')
  return local('this machine has room for it')
}
