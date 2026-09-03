/**
 * The change list, read into `shared/tour.ts`'s steps - the main-process half.
 *
 * Only a dev copy ever asks for this (`profileName()` is not the installed app - the
 * same reading `faultNotify.ts` uses to keep a test copy from paging anybody), so the
 * installed app never shells out to git at all: `tour()` refuses before `diffLines` runs.
 */

import { app } from 'electron'
import { profileName } from './profile'
import { diffLines } from '../../scripts/try-diff.mjs'
import { makeTour, tourAllowed, type TourState } from '../shared/tour'

export function tour(): TourState | null {
  if (!tourAllowed(profileName())) return null
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const { lines } = diffLines(root)
  return makeTour(lines)
}
