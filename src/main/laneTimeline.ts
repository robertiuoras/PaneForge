// The disk and the clock behind `shared/laneTimeline.ts`.
//
// Main owns it for the same reason `main/activity.ts` does, and one more: the lane strip
// only polls while the window is ON SCREEN (appVisible.ts), so a renderer-side diff would
// see nothing at all during the hours the app runs minimised or with a game in front of it
// - which is exactly the stretch "what happened while I was away" is asking about. So the
// readings are taken here, on a timer, and the window is told.
//
// A reading is a few hundred bytes of JSON off disk per project (laneBoard.ts caches it for
// four seconds anyway); no git is spawned and scripts/lane.mjs is not changed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { describePlace } from '../shared/place'
import {
  addLaneEvent,
  laneChanges,
  MAX_LANE_EVENTS,
  type LaneEvent
} from '../shared/laneTimeline'
import type { LaneBoard, LaneBoardEntry } from '../shared/types'

/**
 * How often the ledger is re-read.
 *
 * Nothing here needs to be prompt - every one of these events is drawn live on the strip
 * the moment it happens, and this list is read minutes or hours later. Fifteen seconds is
 * slow enough to cost nothing and fast enough that two changes to one lane are not seen as
 * one. It is deliberately SLOWER than laneBoard.ts's own four-second cache, so a tick never
 * forces a re-read that the strip's poll has not already paid for.
 */
export const SWEEP_MS = 15_000

interface Store {
  /** Newest first. */
  items: LaneEvent[]
}

let store: Store | null = null
let path = ''
let onChange: ((items: LaneEvent[]) => void) | null = null
let timer: NodeJS.Timeout | null = null
/** The previous reading per project, so a change can be seen. Memory only, by design. */
const seen = new Map<string, LaneBoard>()

function file(): string {
  if (!path) {
    const dir = app.getPath('userData')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* it is the app's own data dir */
    }
    path = join(dir, 'lane-timeline.json')
  }
  return path
}

function load(): Store {
  if (store) return store
  let read: Store = { items: [] }
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>
    if (Array.isArray(raw.items)) read.items = raw.items.slice(0, MAX_LANE_EVENTS)
  } catch {
    // No file, or one half-written by a machine that lost power. An empty list is the
    // honest answer to "what has happened to this copy" when nothing can be read.
    read = { items: [] }
  }
  store = read
  return store
}

function save(): void {
  try {
    writeFileSync(file(), JSON.stringify(load()))
  } catch {
    // A log that cannot be written must never be the reason a reading is not taken.
  }
}

/** The copy in plain words, frozen into the event at the moment it is recorded. */
function nameCopy(_repo: string, lane: LaneBoardEntry): string {
  return describePlace({ cwd: lane.dir, branch: lane.branch, lane: lane.lane }).short
}

/** Tell the window whenever the log changes. Set once, from index.ts. */
export function onLaneTimelineChange(fn: (items: LaneEvent[]) => void): void {
  onChange = fn
}

/**
 * Fold one round of readings in.
 *
 * Exported so index.ts can call it straight after the strip's own poll as well as on the
 * timer: a change the window has already drawn should be in the log by the time somebody
 * presses the row, not fifteen seconds later.
 */
export function noteLaneBoards(boards: LaneBoard[], now = Date.now()): void {
  const s = load()
  let items = s.items
  for (const board of boards) {
    for (const e of laneChanges(seen.get(board.repo), board, nameCopy, now)) {
      items = addLaneEvent(items, e)
    }
    seen.set(board.repo, board)
  }
  if (items === s.items) return
  s.items = items
  save()
  onChange?.(items)
}

export function listLaneTimeline(): LaneEvent[] {
  return load().items
}

/** Start the sweep. `read` is index.ts's own board reader, so the pane list is its business. */
export function watchLaneTimeline(read: () => LaneBoard[]): void {
  if (timer) return
  const tick = (): void => {
    try {
      noteLaneBoards(read())
    } catch {
      // A reading that throws is a reading not taken; the next one is fifteen seconds away.
    }
  }
  tick()
  timer = setInterval(tick, SWEEP_MS)
  // Never the reason the app stays alive.
  timer.unref?.()
}

export function stopLaneTimeline(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
