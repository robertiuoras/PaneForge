// What the other chats editing PaneForge are doing, read straight off disk.
//
// PaneForge is built from several chats at once, each holding one checkout ("lane" -
// see scripts/lane.mjs). That system already works; what it had no way of doing was
// telling a human. A lane that finished but conflicts with master is left out of every
// release until someone resolves it, and the only place that was ever said was inside
// the text a hook prints into whichever chat happens to send the next prompt. Lane b sat
// conflicted for a day that way. So the app shows it: the lanes are on screen, and a
// stuck one glows until it is not.
//
// This reads the lane state file (in the repo's shared .git, written by lane.mjs) and
// nothing else - no git, no child process, a few hundred bytes every few seconds. On a
// machine that has no PaneForge checkout there is no file, this returns null, and the
// renderer draws nothing.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { LaneBoard, LaneBoardEntry } from '../shared/types'

/** Same order as the POOL in scripts/lane.mjs, so the strip reads like the lane list. */
const POOL = ['main', 'a', 'b', 'c']
/** Matches ADOPT_MS in scripts/lane.mjs: a conflict this stale is anyone's to fix. */
const ADOPT_MS = 45 * 60 * 1000
/** The state file changes at most a few times a minute; polling is cheap but not free. */
const TTL = 4000

interface RawLane {
  session?: string
  cwd?: string | null
  claimed?: number
  seen?: number
}
interface RawConflict {
  at?: number
  since?: number
  detail?: string
  resolver?: string | null
}
interface RawState {
  lanes?: Record<string, RawLane>
  ready?: Record<string, { at?: number; commits?: number }>
  conflicts?: Record<string, RawConflict>
  release?: { session: string; at: number } | null
  lastShip?: { version: string; at: number; lanes: string[] } | null
}

let repo: string | null | undefined
let cache: { at: number; board: LaneBoard | null } = { at: 0, board: null }

/**
 * The main checkout, which is where the shared .git (and so the lane state) lives.
 *
 * A lane worktree is a sibling folder named `<repo>-a`, and the app usually runs from
 * one of those in development, so "the folder I am in" is not the answer. The env var is
 * the escape hatch for a checkout somewhere else entirely.
 */
function findRepo(): string | null {
  if (repo !== undefined) return repo
  const candidates = [
    process.env.PANEFORGE_REPO,
    join(homedir(), 'Desktop', 'Projects', 'claude-orchestrator'),
    join(homedir(), 'Projects', 'claude-orchestrator')
  ].filter(Boolean) as string[]
  repo = candidates.find((p) => existsSync(join(p, '.git', 'paneforge-lanes.json'))) ?? null
  return repo
}

const laneDir = (main: string, id: string): string =>
  id === 'main' ? main : join(dirname(main), `${basename(main)}-${id}`)

/**
 * One line per lane worth showing. A lane nobody holds, with nothing in it, is not a
 * fact about today's work - it is an empty slot, and it stays off the strip.
 */
export function laneBoard(): LaneBoard | null {
  const now = Date.now()
  if (now - cache.at < TTL) return cache.board
  cache = { at: now, board: read() }
  return cache.board
}

function read(): LaneBoard | null {
  const main = findRepo()
  if (!main) return null
  const file = join(main, '.git', 'paneforge-lanes.json')
  let state: RawState
  try {
    // A half-written file is impossible (lane.mjs writes then renames), so a parse
    // failure means something else wrote there - drawing nothing is the right answer.
    if (!statSync(file).isFile()) return null
    state = JSON.parse(readFileSync(file, 'utf8')) as RawState
  } catch {
    return null
  }

  const lanes: LaneBoardEntry[] = []
  const now = Date.now()
  for (const id of POOL) {
    const held = state.lanes?.[id]
    const conflict = state.conflicts?.[id]
    const ready = Boolean(state.ready?.[id])
    if (!held && !conflict && !ready) continue
    const seen = held?.seen ?? held?.claimed ?? 0
    lanes.push({
      lane: id,
      dir: laneDir(main, id),
      branch: id === 'main' ? 'master' : `lane-${id}`,
      from: held?.cwd ?? null,
      held: Boolean(held),
      seen,
      ready,
      conflicted: Boolean(conflict),
      conflictSince: conflict?.since ?? conflict?.at,
      conflictDetail: conflict?.detail,
      // The same rule lane.mjs applies: a conflict whose chat has gone quiet can be
      // taken over by any other chat, which is the thing worth telling a human.
      adoptable: Boolean(conflict) && (!held || now - seen > ADOPT_MS),
      resolver: conflict?.resolver ?? null
    })
  }

  return {
    repo: main,
    lanes,
    releasing: state.release?.at ?? null,
    lastShip: state.lastShip ?? null
  }
}
