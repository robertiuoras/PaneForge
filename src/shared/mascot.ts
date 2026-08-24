// The face on the resource ladder.
//
// `capacity.ts`, `autoHandoff.ts` and `reclaim.ts` have watched this machine's memory and
// closed, trimmed and moved panes for weeks, and the entire output of all three is a
// `console.info` in a devtools window nobody has open. So the app's only automatic answer
// to a full machine was invisible, and the question it produced was "where IS the thing
// that manages resources" - the honest answer being that there is no agent, there are
// three timers with no mouth.
//
// This is the mouth. It is deliberately NOT a model: every sentence here is arithmetic
// over readings the app already holds (`usage.ts` per-pane memory, `fleet.ts` state,
// `place.ts` words), and every command is a small parser over that same list. A mascot
// that needed a token to say "pane 4 has been quiet two hours" would be off within a day,
// and one that guessed which pane you meant would close the wrong one.
//
// Pure: no DOM, no Electron. `npm run test:mascot`.

import type { FleetState } from './fleet'
import { devReport, mentionsDev, pickDevs, type RunningDev } from './devList'
import { formatMb } from './usage'

/** Turned on by default: silent, and it is the only thing that ever says the ladder acted. */
export interface MascotConfig {
  enabled: boolean
  /**
   * Say it out loud as well as drawing it.
   *
   * Off, and it stays off unless somebody presses the speaker on the bubble. The app's
   * standing law is that nothing it decides by itself may take the screen; a voice is the
   * same intrusion through the other sense, and it also carries into a room with other
   * people in it. The bubble is readable and ignorable, which is the right default.
   */
  voice: boolean
  /**
   * Wander between panes, rather than sitting in one corner.
   *
   * The walk is what makes it point AT the pane it is talking about, which is the whole
   * reason it beats a toast. Off parks it bottom-left for somebody who finds movement in
   * the corner of their eye expensive; the bubble and the commands are unchanged.
   */
  roam: boolean
  /**
   * Which of `shared/pets.ts` is drawn.
   *
   * A name rather than a number, because the list is ordered for the picker and a number
   * would silently re-point every existing config the day one is inserted. An id nothing
   * in the catalogue answers falls back to the robot rather than drawing nothing.
   */
  pet?: string
  /**
   * Where somebody PUT it, as a fraction of the window.
   *
   * Absent means the app places it: bottom-left, and walking to whichever pane it is
   * talking about. Present means a person dragged it there, and that beats every
   * automatic move - the walk would otherwise take the sprite straight back off the
   * corner it was just moved out of, which reads as the drag not having worked. A
   * fraction rather than pixels so a resize never strands it off screen, and the walk
   * to a pane is still allowed to point (`roam` decides that) once it is unpinned.
   */
  spot?: { x: number; y: number } | null
  /**
   * How long a bubble stays on screen before it takes itself away, in seconds.
   *
   * Everything the pet says used to sit there until somebody pressed it away, and what it
   * says is a READING - "closed pane 3 a moment ago" is true for a second and then it is a
   * sentence covering the corner of a window nobody is reading it in. A minute is long
   * enough to notice one and short enough that the corner is clear again by the time you
   * look back. 0 keeps the old behaviour: up until it is dismissed.
   *
   * A countdown is deliberately NOT covered by it - that bubble has a deadline of its own
   * and two named answers, and taking it away early would remove the press that stops it.
   */
  hideSeconds?: number
}

/** The default bubble life, and the bounds anything typed into the box is held to. */
export const HIDE_SECONDS = 60
const HIDE_MIN = 5
const HIDE_MAX = 3600

export const DEFAULT_MASCOT: MascotConfig = {
  enabled: false,
  voice: false,
  roam: true,
  pet: 'bot',
  spot: null,
  hideSeconds: HIDE_SECONDS
}

/**
 * How long this config wants a bubble kept, in ms. 0 means "until it is pressed away".
 *
 * An absent value is the default rather than 0: a config written before this existed is a
 * desk that never chose, and the choice it never made is the one everybody else gets.
 */
export function hideAfterMs(cfg: Partial<MascotConfig>): number {
  const raw = cfg.hideSeconds
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return HIDE_SECONDS * 1000
  if (raw <= 0) return 0
  return Math.min(HIDE_MAX, Math.max(HIDE_MIN, Math.round(raw))) * 1000
}

/**
 * How long a dash across the bottom of the window takes, and how often one happens.
 *
 * The run is the ONE thing the pet does that is not a reading, and it is why it is rare
 * and why it stands down so easily: a decoration moving in the corner of somebody's eye
 * while they are reading an agent's answer is a cost, not a feature. It stands down for a
 * bubble, the ask box, a countdown, a spot somebody dragged it to, `roam` off, and a
 * window nobody is looking at.
 */
export const DASH_MS = 2800
export const DASH_EVERY_MS = 9 * 60 * 1000

/** Everything that has to be true before the pet may run. Pure, so the test can say why. */
export interface DashContext {
  enabled: boolean
  roam: boolean
  /** A person put it somewhere. That beats every automatic move, including this one. */
  pinned: boolean
  /** Anything on screen from the mascot itself - a notice, the ask box, a countdown. */
  saying: boolean
  visible: boolean
  sinceMs: number
}

export function dueDash(ctx: DashContext): boolean {
  if (!ctx.enabled || !ctx.roam || ctx.pinned) return false
  if (ctx.saying || !ctx.visible) return false
  return ctx.sinceMs >= DASH_EVERY_MS
}

/** Keep a dropped sprite inside the window, whatever the pointer did on the way out. */
export function clampSpot(x: number, y: number): { x: number; y: number } {
  const c = (v: number): number => Math.min(0.98, Math.max(0.02, Number.isFinite(v) ? v : 0.5))
  return { x: c(x), y: c(y) }
}

/**
 * Where the bubble goes, given where the sprite is standing.
 *
 * It used to go nowhere at all: the bubble was a flex CHILD of the sprite's own box, and
 * that box is centred on the spot - so a bubble appearing widened the box by ~310px, moved
 * the fox ~155px sideways to keep the new box centred, and put the left half of the bubble
 * off the window whenever the fox was near the left edge, which is where it stands by
 * default. That is "the chatbox is bugged, it is off screen, and now the fox is too".
 *
 * So the bubble is not attached to the sprite at all any more - it is placed in the layer
 * in pixels, clamped into the window on both axes, and the sprite never moves because
 * something was said. Above the fox when there is room, below it when there is not, and
 * always fully on screen: a message that cannot be read is the same as no message, and a
 * button that cannot be reached is worse.
 */
export interface BubbleBox {
  left: number
  top: number
  /** What it was placed as. */
  width: number
  /** The widest it may be drawn - the window's own limit, not the message's. */
  max: number
  /** Which side of the sprite it ended up on. The tail of the bubble points the other way. */
  above: boolean
}

/** The most it may be, and the least gap it keeps from the window edge and the sprite. */
export const BUBBLE_MAX = 300
const BUBBLE_PAD = 10
const BUBBLE_GAP = 8

export function bubbleSpot(o: {
  /** The sprite's centre, in window pixels. */
  cx: number
  cy: number
  /** The sprite's drawn size - the bubble clears it rather than overlapping the fox. */
  sprite: number
  /** The bubble's own measured size. 0 before the first paint, which is still placeable. */
  width: number
  height: number
  vw: number
  vh: number
}): BubbleBox {
  // Unmeasured (the first paint) is treated as full width: centring a box whose size is
  // not known yet on its own guess is what puts it off the edge for one frame.
  const max = Math.max(80, Math.min(BUBBLE_MAX, o.vw - BUBBLE_PAD * 2))
  const width = o.width > 0 ? Math.min(o.width, max) : max
  const left = Math.max(BUBBLE_PAD, Math.min(o.cx - width / 2, o.vw - BUBBLE_PAD - width))
  const half = o.sprite / 2 + BUBBLE_GAP
  // Above unless there is no room for it, and above ANYWAY when there is no room either
  // way - a bubble clamped against the top edge is readable, one clamped over the sprite
  // it is pointing out of is not.
  const roomAbove = o.cy - half - o.height >= BUBBLE_PAD
  const roomBelow = o.cy + half + o.height <= o.vh - BUBBLE_PAD
  const above = roomAbove || !roomBelow
  const raw = above ? o.cy - half - o.height : o.cy + half
  const top = Math.max(BUBBLE_PAD, Math.min(raw, Math.max(BUBBLE_PAD, o.vh - BUBBLE_PAD - o.height)))
  return { left, top, width, max, above }
}

/** One pane, reduced to what the mascot is allowed to reason about. */
export interface MascotPane {
  id: string
  /** 1-based position in the sidebar - the number a person says out loud, and the Ctrl key. */
  pane: number
  /** The pane's own name, or the project it is in. What `place.ts` already worked out. */
  name: string
  /**
   * Which COPY of that project this pane is in - `place.ts`'s own `role`, and only when it
   * is not the project's own checkout.
   *
   * A desk running three lanes of one repo had three panes all called `PaneForge`, so
   * "Closed PaneForge pane 3" named a project and a keystroke and left out the one fact
   * that separates it from the pane beside it. Empty for a trunk pane, because "main
   * checkout" is what a bare project name already means (`place.ts`'s rule, verbatim).
   */
  where?: string
  state: FleetState
  /** This pane's whole process tree, MB. null when the sampler has not read it yet. */
  memMb: number | null
  /** How long since anybody typed into it, ms. */
  idleMs: number
  /** Another device's pty. Closing it here frees nothing here. */
  remote: boolean
  /**
   * What this pane was asked to do, in one line - History's own `gist`.
   *
   * A pane is a folder and a number until this is on it, and "closed pane 3" is then a
   * sentence nobody can judge: the whole question somebody has when a pane disappears is
   * WHICH conversation it was. Free by construction (`shared/gist.ts`) - keystrokes the
   * app already relays on their way to the pty, never a summary anything was paid for.
   * Absent for a pane nobody has typed into yet, and then it is simply not said.
   */
  doing?: string
  /**
   * The agent has a LIVE question on screen, right now.
   *
   * `fleetState` cannot answer this: it calls both a finished turn and an unanswered
   * question `needsYou`, which is the same word for the best moment to close a pane and
   * the one moment that must not be. Reading the state alone is why "close the idle ones"
   * answered "nothing quiet enough to close" on a desk full of finished panes - every one
   * of them had said something and was therefore `needsYou`. This is the real refusal, and
   * it is the pane's own `ask`, not a guess off its state.
   */
  asking: boolean
}

export type Intent =
  /** Close these panes. Destructive, so it is always confirmed before it runs. */
  | { kind: 'close'; ids: string[]; say: string }
  /** Move these panes to a paired device. Also confirmed. */
  | { kind: 'handoff'; ids: string[]; say: string }
  /** Show these panes' readings. Nothing happens to them. */
  | { kind: 'report'; ids: string[]; say: string }
  /**
   * Stop these dev servers. Destructive, and confirmed like every other one.
   *
   * By pid rather than by pane, because a dev server is routinely not a descendant of the
   * pane that started it - the one measured on this desk had been reparented onto pid 1 -
   * so "the pane's server" is not a thing that can be killed by closing the pane.
   */
  | { kind: 'stopDev'; pids: number[]; say: string }
  /** It understood the shape and found nothing, or did not understand at all. */
  | { kind: 'say'; say: string }

/** An intent that changes something, and therefore may not run on a guess. */
export function isDestructive(i: Intent): boolean {
  return i.kind === 'close' || i.kind === 'handoff' || i.kind === 'stopDev'
}

const MIN = 60_000

/** "pane 4", "session 4", "#4", "4" - the number a person actually says. */
function paneNumbers(text: string): number[] {
  const out: number[] = []
  // `(3)` is in the list because it is how the mascot itself names a pane now - reading
  // back its own sentence has to work, or "close (3) PaneForge lane a" is a pane it cannot
  // find in a message it wrote.
  const re = /(?:pane|session|tab|window)\s*#?\s*(\d{1,2})|#(\d{1,2})|\((\d{1,2})\)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(Number(m[1] ?? m[2] ?? m[3]))
  // A bare number is only a pane when the sentence is otherwise about closing one:
  // "close 4" is a pane, "close the 2 idle ones" is a count and must not be.
  if (!out.length) {
    const bare = /^\s*(?:close|kill|end|stop|move|hand\s*off|show|what(?:'s| is)?)\s+(\d{1,2})\s*$/i.exec(text)
    if (bare) out.push(Number(bare[1]))
  }
  return out
}

/**
 * Panes whose name the sentence names.
 *
 * Longest first, and a name CONTAINED in one already matched is dropped: "close service-a"
 * names `service` too, and answering it with both panes is either a refusal or - worse -
 * a close of somebody else's project for the price of a hyphen. `place.ts` has the same
 * hazard and resolves it the same way.
 */
function byName(text: string, panes: MascotPane[]): MascotPane[] {
  const low = text.toLowerCase()
  const hit: MascotPane[] = []
  for (const p of [...panes].sort((a, b) => b.name.length - a.name.length)) {
    const n = p.name.toLowerCase()
    if (p.name.length < 3 || !low.includes(n)) continue
    if (hit.some((h) => h.name.toLowerCase().includes(n))) continue
    hit.push(p)
  }
  return hit
}

/**
 * How the mascot refers to a pane in a sentence: the number in brackets, then the place.
 *
 * The number is the keystroke that reaches it (Ctrl+N) and the place is what a person has
 * in their head, so both halves are always there. It leads with the number in brackets
 * because a sentence naming several panes - "Closed (1) PaneForge lane a and (4) crypto" -
 * is otherwise a run of words with numbers buried inside it, and the numbers are the half
 * that is actionable. `where` is the lane, added only when the project name does not
 * already imply the checkout.
 */
export function paneWord(p: { name?: string; pane: number; where?: string }): string {
  const place = [p.name, (p.where ?? '').trim()].filter(Boolean).join(' ')
  return place ? `(${p.pane}) ${place}` : `pane ${p.pane}`
}

/** The most of a pane's ask that goes in a sentence. Longer than this is a paragraph. */
const SUBJECT_MAX = 64

/** One line of what a pane was asked to do, or '' when the app does not know. */
export function paneSubject(doing?: string): string {
  const t = (doing ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > SUBJECT_MAX ? `${t.slice(0, SUBJECT_MAX - 1).trimEnd()}\u2026` : t
}

/**
 * The pane, and what it was working on when there is an answer to that.
 *
 * Never invented: a pane with no recorded ask is named and nothing more. A confident
 * wrong sentence about which conversation just closed is worse than no sentence, which is
 * the same rule History's own row is written under.
 */
export function paneDoing(p: { name?: string; pane: number; doing?: string }, tense: 'is' | 'was' = 'was'): string {
  const word = paneWord(p as MascotPane)
  const s = paneSubject(p.doing)
  return s ? `${word} - ${tense} working on "${s}"` : word
}

export function paneLine(p: MascotPane): string {
  const mem = p.memMb === null ? 'not measured yet' : formatMb(p.memMb)
  const idle = p.idleMs >= MIN ? `, quiet ${humanMins(p.idleMs)}` : ''
  const s = paneSubject(p.doing)
  return `${paneWord(p)} - ${p.state}, ${mem}${idle}${s ? `\n   on "${s}"` : ''}`
}

/**
 * How long ago something happened, said the way somebody would say it.
 *
 * The pet's report of what the ladder did used to carry no time at all, so a bubble that
 * had been sitting in the corner for ten minutes read as something that had just happened
 * - which is the one thing about an automatic close somebody needs to place. Seconds
 * below a minute (rounded to five, because a number changing every second in the corner of
 * an eye is motion, not information), then minutes, then hours.
 */
export function agoWords(ms: number): string {
  if (!(ms > 0) || ms < 10_000) return 'just now'
  if (ms < MIN) return `${Math.round(ms / 5000) * 5}s ago`
  return `${humanMins(ms)} ago`
}

export function humanMins(ms: number): string {
  const m = Math.round(ms / MIN)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

/**
 * Panes it is willing to close on its own suggestion.
 *
 * The same refusals `reclaim.ts` runs under: never one that is working or starting, never
 * one holding a live question, and never another device's pty.
 *
 * A FINISHED TURN is closeable, and getting that wrong made the whole feature look blind.
 * `fleetState` says `needsYou` both for a pane whose agent asked something and for a pane
 * whose agent finished and is sitting at its composer - so a rule written as "ready or
 * exited" refused every pane anybody would ever want closed, and the mascot answered
 * "nothing quiet enough to close" on a desk of eleven finished ones. The question is not
 * what the state is called; it is whether somebody is owed an answer (`asking`).
 */
export function closeable(panes: MascotPane[]): MascotPane[] {
  return panes.filter(
    (p) => !p.remote && !p.asking && (p.state === 'ready' || p.state === 'exited' || p.state === 'needsYou')
  )
}

/** How a dev server is named back to somebody who is about to stop it. */
function devLineShort(d: RunningDev): string {
  return `${d.label}${d.port ? ` on ${d.port}` : ''} (${d.where})`
}

export function parse(text: string, panes: MascotPane[], devs: RunningDev[] = []): Intent {
  const t = text.trim()
  if (!t) return { kind: 'say', say: 'Ask me something - "what is pane 3", "what dev servers are running".' }
  const low = t.toLowerCase()

  const wantsClose = /\b(close|kill|end|quit|stop|shut)\b/.test(low)
  const wantsMove = /\b(hand\s*off|move|send|offload|push)\b/.test(low)
  const wantsBig = /\b(big|biggest|heavy|heaviest|largest|most memory|hog|eating|using most)\b/.test(low)
  const wantsIdle = /\b(idle|quiet|unused|finished|done|old|stale)\b/.test(low)

  // A set the sentence describes rather than names: "the idle ones", "the big ones".
  const described = (): MascotPane[] => {
    if (wantsIdle) return closeable(panes).filter((p) => p.idleMs >= 10 * MIN)
    if (wantsBig) {
      const known = panes.filter((p) => p.memMb !== null)
      const n = /\b(two|2)\b/.test(low) ? 2 : /\b(three|3)\b/.test(low) ? 3 : 1
      return [...known].sort((a, b) => (b.memMb as number) - (a.memMb as number)).slice(0, n)
    }
    return []
  }

  const nums = paneNumbers(t)
  const named = byName(t, panes)
  let hit: MascotPane[] = []
  if (nums.length) hit = panes.filter((p) => nums.includes(p.pane))
  else if (named.length) hit = named
  else hit = described()

  // Dev servers come first, because "close the dev" is a close with no pane in it and
  // would otherwise fall through to "nothing quiet enough to close" - an answer about
  // panes to a question about servers.
  //
  // A pane NUMBER in the sentence no longer hands it back to the pane branch. "stop the
  // dev server in pane 2" is a sentence about a server that happens to say where it is,
  // and answering it by offering to close pane 2 is the app doing the larger of the two
  // things somebody asked for. The number narrows the servers instead; a bare word "pane"
  // with no number still means the panes.
  if (mentionsDev(t) && (nums.length > 0 || !/\bpane\b/.test(low.replace(/\bpane\s*#?\s*\d/g, '')))) {
    const inPane = nums.length ? devs.filter((d) => d.pane && nums.includes(d.pane)) : []
    const named = inPane.length ? inPane : pickDevs(t, devs)
    if (wantsClose) {
      if (!devs.length) return { kind: 'say', say: 'No dev server running that I can see.' }
      if (!named.length)
        return {
          kind: 'say',
          say: `Which one?\n${devReport(devs)}\nSay "close the first one", its port, or "close both".`
        }
      return {
        kind: 'stopDev',
        pids: named.map((d) => d.pid),
        say: `Stop ${named.length === 1 ? devLineShort(named[0]) : `${named.length} dev servers (${named.map(devLineShort).join(', ')})`}? Whatever it was serving goes down until it is started again.`
      }
    }
    return { kind: 'say', say: devReport(devs) }
  }

  if (wantsClose) {
    if (!hit.length)
      return {
        kind: 'say',
        say: nums.length
          ? `No pane ${nums.join(' or ')} open - there ${panes.length === 1 ? 'is 1 pane' : `are ${panes.length} panes`}.`
          : 'Nothing quiet enough to close. Try "close pane 3".'
      }
    const refused = hit.filter((p) => p.remote)
    const ok = hit.filter((p) => !p.remote)
    if (!ok.length)
      return { kind: 'say', say: `${refused.map(paneWord).join(' and ')} lives on another machine - close it over there.` }
    return {
      kind: 'close',
      ids: ok.map((p) => p.id),
      say: `Close ${ok.map(paneWord).join(' and ')}? It keeps its conversation and its screen - History reopens both.`
    }
  }

  if (wantsMove) {
    if (!hit.length) return { kind: 'say', say: 'Which one? "hand off pane 2".' }
    const ok = hit.filter((p) => !p.remote)
    if (!ok.length) return { kind: 'say', say: 'That one is already on the other machine.' }
    return {
      kind: 'handoff',
      ids: ok.map((p) => p.id),
      say: `Move ${ok.map(paneWord).join(' and ')} to the paired device? Its branch, conversation and screen go with it.`
    }
  }

  if (hit.length) return { kind: 'report', ids: hit.map((p) => p.id), say: hit.map(paneLine).join('\n') }

  // A description that matched nothing is answered as itself. Falling through to the
  // catch-all made "what are the two biggest" on a desk with no panes read as "I did not
  // understand", which is the wrong half of the answer: it understood perfectly.
  if (wantsBig || wantsIdle)
    return {
      kind: 'say',
      say: panes.length ? 'Nothing on this desk fits that.' : 'No panes open here.'
    }

  // "what is open", "list the panes", "what is running" - the whole desk, in the order the
  // sidebar has it. It was the one question the pet could not answer: everything else here
  // needs a pane named or described first, so the most obvious opening sentence anybody
  // types fell through to "I only know this machine".
  if (/\b(list|everything|all)\b/.test(low) || /\bwhat(?:'s| is| are)?\b/.test(low)) {
    if (/\b(pane|panes|session|sessions|open|running|going on|desk|here)\b/.test(low)) {
      if (!panes.length) return { kind: 'say', say: 'No panes open here.' }
      const known = panes.filter((p) => p.memMb !== null)
      const total = known.reduce((n, p) => n + (p.memMb as number), 0)
      return {
        kind: 'report',
        ids: panes.map((p) => p.id),
        say: `${panes.length} ${panes.length === 1 ? 'pane' : 'panes'}${total ? `, about ${formatMb(total)} between them` : ''}.\n${panes.map(paneLine).join('\n')}`
      }
    }
  }

  if (/\b(memory|ram|total|how much|usage|resources)\b/.test(low)) {
    const known = panes.filter((p) => p.memMb !== null)
    const total = known.reduce((n, p) => n + (p.memMb as number), 0)
    const top = [...known].sort((a, b) => (b.memMb as number) - (a.memMb as number)).slice(0, 3)
    return {
      kind: 'report',
      ids: top.map((p) => p.id),
      say: `${panes.length} panes, about ${formatMb(total)} between them.\n${top.map(paneLine).join('\n')}`
    }
  }

  if (/\b(help|what can you|commands?)\b/.test(low))
    return {
      kind: 'say',
      say: [
        'Panes: "what is open", "what is pane 3", "what are the two biggest", "memory".',
        'Dev servers: "what dev servers are running", "stop the server on 3000", "close the dev server in pane 2".',
        'Doing things: "close the idle ones", "close (3) PaneForge", "hand off pane 2".'
      ].join('\n')
    }

  return {
    kind: 'say',
    say: `I only know this machine - panes, memory, dev servers and closing them. Try "what is open" or "help".`
  }
}

/** What the mascot volunteers, unasked, or nothing. */
export interface Notice {
  /** Stable across re-readings of the same situation, so it is said once. */
  key: string
  say: string
  /** The pane it is about, so it can walk over and point at it. */
  about?: string
  /** Offered as a button on the bubble. Never run without the press. */
  action?: Intent
}

/**
 * The one thing it says on its own.
 *
 * Deliberately a single notice at a time and deliberately rare: a mascot that pipes up
 * about every reading is a mascot that gets switched off, and the readings underneath it
 * change every four seconds. It speaks when idle panes are holding real memory and the
 * app is not already going to do something about it - which is the exact situation the
 * ladder is silent in on a desk with room to spare.
 */
export function notice(
  panes: MascotPane[],
  opts: { idleCloseOn: boolean; willMove?: boolean; idleMinutes?: number; minMb?: number }
): Notice | null {
  const mins = opts.idleMinutes ?? 45
  const minMb = opts.minMb ?? 400
  if (opts.idleCloseOn) return null // the clock is on; it will handle these itself
  // ...and so is the rung above it: with the automatic handoff on and a device online,
  // these panes are going to MOVE, so offering to close them is the app asking permission
  // to do the worse of the two things it was already going to do better. What the ladder
  // then did still gets said - that is `actedWords`, and it is a report rather than an
  // offer.
  if (opts.willMove) return null
  const stale = closeable(panes).filter((p) => p.idleMs >= mins * MIN && p.memMb !== null)
  // One is enough. Two was the old floor and it was set while `closeable` could not see a
  // finished pane at all, so between the two rules the notice had never once fired on this
  // desk: an agent sitting finished for an hour costs its ~190 MB whether it has company
  // or not, and the whole point of the sprite is that the ladder stops being invisible.
  if (stale.length < 1) return null
  const total = stale.reduce((n, p) => n + (p.memMb as number), 0)
  if (total < minMb) return null
  const ids = stale.map((p) => p.id)
  return {
    key: `stale:${ids.join(',')}`,
    about: ids[0],
    say:
      stale.length === 1
        ? `${paneDoing(stale[0])} - finished ${humanMins(stale[0].idleMs)} ago and is holding ${formatMb(total)}. Close it?`
        : `${stale.length} panes have been quiet over ${humanMins(mins * MIN)} and are holding ${formatMb(total)}. Close them?`,
    action: {
      kind: 'close',
      ids,
      say: `Close ${stale.map(paneWord).join(', ')}?`
    }
  }
}

/**
 * A pane the ladder acted on, as much of it as the sentence needs.
 *
 * A string was enough while the sentence was "closed a pane": it is not enough for "which
 * one, and what was it in the middle of", which is the only question anybody has when a
 * pane they were using is not there any more.
 */
export interface ActedPane {
  /** Already `paneWord`, worked out where the pane list lives. */
  word: string
  /** What it was asked to do, if the app knows. Never invented. */
  doing?: string
}

/**
 * What it says after the ladder acted by itself, so an invisible action stops being invisible.
 *
 * `agoMs` is passed rather than stored because the sentence is re-rendered while it is on
 * screen: a bubble saying "just now" that is still saying it four minutes later is the
 * bug this argument exists to close.
 */
export function actedWords(
  what: 'closed' | 'moved' | 'trimmed',
  panes: ActedPane[],
  mb?: number,
  agoMs = 0,
  /** Which machine it went to. Named, because "the paired device" is the one fact a
   *  person cannot get back from anywhere on screen once the pane has gone. */
  where?: string
): string {
  const subject = (p: ActedPane): string => {
    const s = paneSubject(p.doing)
    return s ? `${p.word} - was working on "${s}"` : p.word
  }
  const one = panes.length === 1
  const who = one ? subject(panes[0]) : `${panes.length} panes`
  const when = agoWords(agoMs)
  const back = mb ? `, about ${formatMb(mb)} back` : ''
  const head =
    what === 'trimmed'
      ? `Trimmed ${who} ${when}${mb ? `, about ${formatMb(mb)}` : ''} - this machine was short of memory.`
      : what === 'moved'
        ? `Moved ${who} to ${where || 'the paired device'} ${when} - it is mirrored here, so it is still on screen.`
        : `Closed ${who} ${when}${back} - reopen from History, nothing is lost.`
  // Several panes are listed under the sentence rather than folded into it: the whole
  // point is which conversations went, and a comma-joined run of four is unreadable.
  return one ? head : [head, ...panes.map(subject)].join('\n')
}


/**
 * How long a pane gets between the app deciding to close it and it closing.
 *
 * The sweeps used to close on the spot and write a line to a devtools console nobody has
 * open, so the only evidence a pane had been closed was the pane not being there. A count
 * is the smallest thing that turns that into a decision somebody is part of: it names the
 * pane, it says when, and it can be stopped by one press. Fifteen seconds is long enough
 * to read a sentence and reach a button and short enough that a machine that is genuinely
 * out of memory is not waiting on a person who left.
 */
export const CLOSE_COUNTDOWN_MS = 15_000

/**
 * How long a pane is left alone after somebody says "keep it open".
 *
 * The sweeps run every minute, so without this the answer to "keep it" is the same
 * question sixty seconds later, for ever - which is the exact behaviour that gets a
 * feature switched off. An hour, and the clock starts again from there.
 */
export const KEEP_MINUTES = 60

/**
 * The countdown, in words. `names` are already `paneWord` strings.
 *
 * `toDevice` turns it into the OTHER thing the ladder does by itself. A close counted
 * down and could be stopped; a move said nothing at all - `runHandoffs` reported into a
 * console nobody has open - so a pane simply left the machine. Same countdown, same
 * press, and the machine is named: where it went is the one fact that cannot be
 * recovered from the screen afterwards.
 */
export function countdownWords(
  names: string[],
  msLeft: number,
  why: 'idle' | 'pressure',
  toDevice?: string
): string {
  const secs = Math.max(0, Math.ceil(msLeft / 1000))
  const who = names.length === 1 ? names[0] : `${names.length} panes (${names.join(', ')})`
  const reason =
    why === 'pressure'
      ? 'this machine is out of memory'
      : 'nobody has typed there in a while'
  if (toDevice) {
    return `Moving ${who} to ${toDevice} in ${secs}s - ${reason}. The conversation and the screen go too, and it comes straight back as a mirror. A pane mid-turn travels when its turn ends.`
  }
  return `Closing ${who} in ${secs}s - ${reason}. Nothing is lost: History reopens the conversation and the screen.`
}
