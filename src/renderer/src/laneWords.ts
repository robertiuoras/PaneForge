// The words the lane strip puts on screen about a lane, and nothing else.
//
// Split out of LaneStrip.tsx so they can be checked without React, an Electron window, or a
// visible one: the strip polls only while the window is on screen (appVisible.ts), so on a
// machine with a game running - which is when PaneForge opens no window at all - there is no
// DOM to read the strings out of. scripts/lane-holder-test.mjs compiles this one file and
// asserts the sentences directly.

// Relative, where the rest of the renderer says `@shared/types`: the alias is a tsconfig
// path, and the test builds this file on its own, which knows nothing about it.
import type { LaneBoardEntry } from '../../shared/types'
import { describePlace, paneRef } from '../../shared/place'

/** How long since `ms`, in the roughest unit that is still true. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.round((now - ms) / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/**
 * Two paths naming one checkout, whichever way their separators lean.
 *
 * The lane file records a lane's folder as the engine built it and a pane records the
 * folder it was opened in; on Windows those routinely differ by a drive-letter case or a
 * trailing slash and are the same directory.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** The last segment of a path, whichever way its separators lean. */
export function folderName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * The lane, named by the PROJECT it is a copy of.
 *
 * This is the line the whole file was rewritten for. The strip used to print
 * `lane.branch`, so a row read `master` - and once lanes stopped being a PaneForge-only
 * thing, several rows read `master` at once, for different repositories, with nothing on
 * any of them saying which. The report was exactly that: "lanes main master, I have no
 * idea which project that is."
 */
export function laneLabel(lane: LaneBoardEntry): string {
  return describePlace({ cwd: lane.dir, branch: lane.branch, lane: lane.lane }).short
}

/** The project a lane is a copy of, on its own. */
export function laneProject(lane: LaneBoardEntry): string {
  return describePlace({ cwd: lane.dir, branch: lane.branch, lane: lane.lane }).project
}

/**
 * The same lane, named for a card that has ALREADY said which project it is in.
 *
 * `laneLabel` names the project because the lane strip draws lanes belonging to chats that
 * are not panes here, and nothing else on those rows says which repository they are. A
 * session card is the opposite case: the chip beside this one is the pane's project, so
 * the full label printed it twice in a row - `taskdriver-ai` then `taskdriver-ai · lane a`
 * - which reads as two different facts and is one. Robert's report was exactly that:
 * "why we have extra tag with project name".
 *
 * The project comes BACK the moment it disagrees, which is a real case and the whole
 * reason the name was added: a chat opened in `assistant` can hold Toolstash's lane c, and
 * a bare `lane c` on that card would be a lie by omission.
 */
export function laneChipLabel(lane: LaneBoardEntry, paneProject?: string): string {
  const place = describePlace({ cwd: lane.dir, branch: lane.branch, lane: lane.lane })
  if (paneProject && paneProject === place.project) return place.role
  return place.short
}

/**
 * Who holds this lane, in the shortest form that names somebody.
 *
 * "a chat has it" was true and useless: the lane a window can see least about is the one held
 * by a chat that is not a pane in it, and that is exactly the lane the strip draws - a lane
 * held by a pane on screen is named by that pane already. The lane file records the folder
 * the holder started in and its session id, so a lane held from another project reads as that
 * project. The folder is the useful half - "taskdriver's chat" answers why PaneForge's lane a
 * is busy - and the session id is the fallback for a hold that recorded no folder.
 *
 * `pane` beats both. A hold whose chat IS a pane in this window is named by the number on
 * that pane's card, which is also the Ctrl key that switches to it - so "pane 3 has it" is
 * a fact you can act on, where eight characters of a session id is one you cannot.
 */
export function holderName(lane: LaneBoardEntry, pane?: number): string {
  if (pane) return paneRef(pane)
  // A claim published by the other desk. There is no folder to name and its session id is
  // eight characters of a chat this machine has never hosted, so the desk IS the answer -
  // "mac-nbn has it" is the sentence the row existed to say and never could.
  if (lane.peer && lane.device) return lane.device
  if (lane.from) return `${folderName(lane.from)}'s chat`
  return lane.session ? `chat ${lane.session.slice(0, 8)}` : 'a chat'
}

/**
 * The desk a lane is on, for the tag beside it.
 *
 * Printed on every row that knows, not only the foreign ones. Showing it only when it
 * disagrees means "no tag" carries the fact instead - and no tag is also what an old
 * record with no stamp on it looks like, so the reader cannot tell "here" from "nobody
 * wrote it down". The report was the plain version of that: "why shows main lanes
 * elsewhere, can we say which device".
 */
export function deviceTip(lane: LaneBoardEntry, here?: string | null): string {
  if (!lane.device) return ''
  if (here && lane.device === here) return `On this machine (${lane.device}).`
  return (
    `On ${lane.device}, another machine sharing this repo's remote.\n` +
    'Nothing here can free it - that checkout is being typed in over there.'
  )
}

/** A hold is "now" for five minutes after the chat was last heard from. */
const FRESH_MS = 5 * 60 * 1000

/**
 * Somebody is working in this lane at this moment.
 *
 * The words already said so ("busy now" against "quiet 14m"); the colour did not, and the
 * colour is what is read from across the room. Held-and-quiet stays grey on purpose - a
 * chat claims a lane the moment it starts, so colouring every hold would light up four
 * lanes that have had nothing typed into them all day, which is the same lie the strip
 * used to tell in words.
 *
 * Conflicted and ready outrank it: both are states somebody has to do something about, and
 * a lane cannot be finished and mid-turn at once as far as a reader is concerned.
 */
export function laneBusy(lane: LaneBoardEntry, now = Date.now()): boolean {
  return lane.held && !lane.conflicted && !lane.ready && now - lane.seen < FRESH_MS
}

/**
 * What the lane is doing, in the words a human would use.
 *
 * `mine` is the pane's own chip, where naming the holder would be the pane telling itself who
 * it is.
 */
export function laneState(
  lane: LaneBoardEntry,
  mine = false,
  now = Date.now(),
  pane?: number,
  hold: { reason: string; at: number } | null = null
): string {
  // "conflicts with master" was written for the person who wrote the release script.
  // What a reader needs is what it means (this work is being left out) and what ends it
  // (somebody picks between two versions) - the tooltip carries the git specifics.
  if (lane.conflicted) return `won't merge - needs a decision, ${ago(lane.conflictSince ?? now, now)}`
  // "done - ships with the next update" on its own is a promise, and it was on screen
  // unchanged for hours while the release was refusing for a reason the app already had
  // on disk. The promise is still made when nothing is holding it up; when something is,
  // that is what the row says instead.
  if (lane.ready) {
    const why = holdWords(hold, now)
    return why ? `done, ${why}` : 'done - ships with the next update'
  }
  if (!lane.held) return 'free'
  // "working" was a lie the strip told about every lane: a chat claims one the moment it
  // starts, so four chats that had typed nothing all read as busy. What the lane file
  // actually knows is who holds it and when that chat was last heard from.
  const who = mine ? '' : `${holderName(lane, pane)} has it, `
  return now - lane.seen < FRESH_MS ? `${who}busy now` : `${who}quiet ${ago(lane.seen, now)}`
}

/**
 * How long a release may be "running" before that stops being an explanation.
 *
 * The same window lane.mjs clears its own lock after (LOCK_MS): past it, a release is not
 * running, it is a machine that went away mid-release. The badge said "releasing" either
 * way, which is the one word that makes somebody wait instead of looking.
 */
export const RELEASE_STUCK_MS = 20 * 60 * 1000

/**
 * The release gate's own reason, in the words a row has space for.
 *
 * The gate writes a paragraph, because its reader is usually an agent about to do
 * something rash with a version number. A person reading a sidebar needs the half that
 * says what is being waited on. Nothing is decided here - an unrecognised reason is
 * printed as it stands rather than dropped, since a reason this has never seen is exactly
 * the one worth reading.
 */
export function holdWords(hold: { reason: string; at: number } | null, now = Date.now()): string {
  const r = hold?.reason?.trim()
  if (!r) return ''
  if (/^another chat is mid-release/i.test(r)) return 'a release is running'
  const busy = r.match(/^waiting on chats still working:\s*(.+)$/i)
  if (busy) return `waiting for the chats still working in ${busy[1]}`
  const soon = r.match(/about (\d+)m\)/)
  if (soon) return `releases batch - the next one is about ${soon[1]}m away`
  if (/test suite/i.test(r)) return `held back ${ago(hold!.at, now)}: master fails its own tests`
  if (/typecheck|does not compile/i.test(r)) return `held back ${ago(hold!.at, now)}: master does not compile`
  // The first sentence, whole. Cutting mid-sentence is how a reason becomes a riddle.
  return r.split('. ')[0].slice(0, 140)
}

/** The holder, spelled out in full: the tooltip is where the whole path and id belong. */
export function heldByTip(lane: LaneBoardEntry, pane?: number): string {
  if (!lane.held) return ''
  const where = lane.from ? `\nStarted in ${lane.from}` : ''
  const who = lane.session ? `\nChat ${lane.session}` : ''
  return where || who ? `Held by ${holderName(lane, pane)}${where}${who}` : ''
}

/**
 * What is actually being done in a checkout, in one line.
 *
 * The lane dialog used to answer "what is in here?" with two counts, which is how much and
 * not what - and the report was the plain version of that: "see other lanes and what they
 * are working on, didn't I say before needed like a summary each lane what its doing".
 *
 * Everything here is free and already in the repository: the newest commit's subject is
 * what the lane has finished saying, and the uncommitted filenames are what it has open
 * right now. Nothing is summarised by a model and nothing is guessed - a lane that has
 * neither says so, because "no commits of its own yet" is a fact somebody can act on and
 * an invented sentence about somebody else's work is not.
 */
export function laneDoing(
  work: { subject: string | null; at: number | null; touching: string[]; dirty: number } | null,
  now = Date.now()
): string {
  if (!work) return ''
  const bits: string[] = []
  if (work.touching.length) {
    const shown = work.touching.map((p) => folderName(p))
    const more = work.dirty - shown.length
    bits.push(`editing ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`)
  }
  if (work.subject) {
    bits.push(`last commit${work.at ? ` ${ago(work.at, now)} ago` : ''}: "${work.subject}"`)
  }
  return bits.join(' · ')
}

export function laneTip(lane: LaneBoardEntry, pane?: number): string {
  const held = heldByTip(lane, pane)
  // A peer row is a claim on the other machine's trunk, and the two lines a normal row
  // shows are both this machine's: `dir` is where OUR checkout of that repo would be and
  // `branch` is what OUR .git/HEAD calls the trunk. Printing them under a row that names
  // another desk reads as that desk's path and that desk's branch, and the claim carries
  // neither - `refs/paneforge/claims/<device>/<slot>/<session>/<millis>` has no room for
  // them. So the row says the true thing it does know and stops there.
  const where = lane.peer
    ? `${laneLabel(lane)}\nThe trunk, on ${lane.device ?? 'another machine'}`
    : `${laneLabel(lane)}\n${lane.dir} (${lane.branch})`
  if (!lane.conflicted) return `${where}${held ? `\n${held}` : ''}`
  return (
    `${where}\nWill not merge: ${lane.conflictDetail ?? 'see the lane'}\n` +
    (lane.resolver
      ? 'A chat has taken this over.'
      : lane.adoptable
        ? 'Its own chat has gone quiet, so any chat can finish it.'
        : 'Its own chat is still around and should fix it.') +
    (held ? `\n${held}` : '')
  )
}
