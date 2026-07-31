// The words the lane strip puts on screen about a lane, and nothing else.
//
// Split out of LaneStrip.tsx so they can be checked without React, an Electron window, or a
// visible one: the strip polls only while the window is on screen (appVisible.ts), so on a
// machine with a game running - which is when PaneForge opens no window at all - there is no
// DOM to read the strings out of. scripts/lane-holder-test.mjs compiles this one file and
// asserts the sentences directly.

// Relative, where the rest of the renderer says `@shared/types`: the alias is a tsconfig
// path, and the test compiles this one file with `tsc` on its own, which knows nothing about
// it. The import is type-only, so nothing survives into the build either way.
import type { LaneBoardEntry } from '../../shared/types'

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
 * Who holds this lane, in the shortest form that names somebody.
 *
 * "a chat has it" was true and useless: the lane a window can see least about is the one held
 * by a chat that is not a pane in it, and that is exactly the lane the strip draws - a lane
 * held by a pane on screen is named by that pane already. The lane file records the folder
 * the holder started in and its session id, so a lane held from another project reads as that
 * project. The folder is the useful half - "taskdriver's chat" answers why PaneForge's lane a
 * is busy - and the session id is the fallback for a hold that recorded no folder.
 */
export function holderName(lane: LaneBoardEntry): string {
  if (lane.from) return `${folderName(lane.from)}'s chat`
  return lane.session ? `chat ${lane.session.slice(0, 8)}` : 'a chat'
}

/**
 * What the lane is doing, in the words a human would use.
 *
 * `mine` is the pane's own chip, where naming the holder would be the pane telling itself who
 * it is.
 */
export function laneState(lane: LaneBoardEntry, mine = false, now = Date.now()): string {
  // "conflicts with master" was written for the person who wrote the release script.
  // What a reader needs is what it means (this work is being left out) and what ends it
  // (somebody picks between two versions) - the tooltip carries the git specifics.
  if (lane.conflicted) return `won't merge - needs a decision, ${ago(lane.conflictSince ?? now, now)}`
  if (lane.ready) return 'done - ships with the next update'
  if (!lane.held) return 'free'
  // "working" was a lie the strip told about every lane: a chat claims one the moment it
  // starts, so four chats that had typed nothing all read as busy. What the lane file
  // actually knows is who holds it and when that chat was last heard from.
  const who = mine ? '' : `${holderName(lane)} has it, `
  return now - lane.seen < 5 * 60 * 1000 ? `${who}busy now` : `${who}quiet ${ago(lane.seen, now)}`
}

/** The holder, spelled out in full: the tooltip is where the whole path and id belong. */
export function heldByTip(lane: LaneBoardEntry): string {
  if (!lane.held) return ''
  const where = lane.from ? `\nStarted in ${lane.from}` : ''
  const who = lane.session ? `\nChat ${lane.session}` : ''
  return where || who ? `Held by ${holderName(lane)}${where}${who}` : ''
}

export function laneTip(lane: LaneBoardEntry): string {
  const held = heldByTip(lane)
  if (!lane.conflicted) return `${lane.dir} (${lane.branch})${held ? `\n${held}` : ''}`
  return (
    `${lane.dir}\nWill not merge: ${lane.conflictDetail ?? 'see the lane'}\n` +
    (lane.resolver
      ? 'A chat has taken this over.'
      : lane.adoptable
        ? 'Its own chat has gone quiet, so any chat can finish it.'
        : 'Its own chat is still around and should fix it.') +
    (held ? `\n${held}` : '')
  )
}
