// A copy of a project is not a folder anybody is meant to open.
//
// Every extra checkout this app (or scripts/lane.mjs) makes sits beside the project it is
// a copy of: `clients-a`, `PaneForge-b`, `assistant-c`. In a terminal that is invisible
// noise; in Finder it is four rows of near-identical names above the one folder a person
// actually wants, and picking the wrong one means editing work that a merge will throw
// away. macOS has the answer already - the `hidden` file flag, which Finder respects and
// git, `ls`, `cd` and every path in this app ignore completely.
//
// So a copy is marked hidden the moment it is created, and again whenever the lane engine
// reports on one, so copies made before this existed catch up without anybody typing.
// Setting the flag twice is a no-op, which is what makes "again, every time" safe.
//
// The refusals are what keep this from hiding somebody's project: the folder name must
// carry a copy suffix (`-a`, `-w2`) AND a sibling by the un-suffixed name must be a git
// repository. `service-a` on its own is a real project and stays visible - the same
// two-legged proof `ensureLaneFolder` and `detectLane` use before touching a folder.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { trunkBeside } from './projectRoot'

/**
 * Take a copy folder out of Finder, on macOS. Silent, never awaited, never throws: a flag
 * that could not be set is a folder somebody can still see, not a broken lane.
 */
export function hideCopyFolder(dir: string): void {
  if (process.platform !== 'darwin' || !dir) return
  if (!existsSync(dir) || !trunkBeside(dir)) return
  try {
    execFile('chflags', ['hidden', dir], { timeout: 10_000 }, () => {})
  } catch {
    /* no chflags, or a folder that went away between the two lines above */
  }
}
