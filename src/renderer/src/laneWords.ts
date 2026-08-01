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
  if (lane.from) return `${folderName(lane.from)}'s chat`
  return lane.session ? `chat ${lane.session.slice(0, 8)}` : 'a chat'
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
  pane?: number
): string {
  // "conflicts with master" was written for the person who wrote the release script.
  // What a reader needs is what it means (this work is being left out) and what ends it
  // (somebody picks between two versions) - the tooltip carries the git specifics.
  if (lane.conflicted) return `won't merge - needs a decision, ${ago(lane.conflictSince ?? now, now)}`
  if (lane.ready) return 'done - ships with the next update'
  if (!lane.held) return 'free'
  // "working" was a lie the strip told about every lane: a chat claims one the moment it
  // starts, so four chats that had typed nothing all read as busy. What the lane file
  // actually knows is who holds it and when that chat was last heard from.
  const who = mine ? '' : `${holderName(lane, pane)} has it, `
  return now - lane.seen < FRESH_MS ? `${who}busy now` : `${who}quiet ${ago(lane.seen, now)}`
}

/** The holder, spelled out in full: the tooltip is where the whole path and id belong. */
export function heldByTip(lane: LaneBoardEntry, pane?: number): string {
  if (!lane.held) return ''
  const where = lane.from ? `\nStarted in ${lane.from}` : ''
  const who = lane.session ? `\nChat ${lane.session}` : ''
  return where || who ? `Held by ${holderName(lane, pane)}${where}${who}` : ''
}

export function laneTip(lane: LaneBoardEntry, pane?: number): string {
  const held = heldByTip(lane, pane)
  const where = `${laneLabel(lane)}\n${lane.dir} (${lane.branch})`
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
