/**
 * Writing and removing the tour's example chats - the disk half of `shared/tourSample.ts`.
 *
 * They are written as ordinary History metadata files, so History reads them with the
 * same code it reads a real chat with, and `remove()` takes them away the same way.
 * Refused outside a dev copy, exactly like the rest of the tour.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileName } from './profile'
import { list, remove } from './history'
import { tourAllowed } from '../shared/tour'
import { SAMPLE_CHATS, needsSample, sampleIds, sampleLog, sampleRows } from '../shared/tourSample'

function dir(): string {
  const d = join(app.getPath('userData'), 'history')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

/**
 * Put the example chats in History if there is nothing there worth looking at.
 * Answers how many rows it added - 0 is the ordinary answer on a desk that has been used.
 */
export function addSample(): number {
  if (!tourAllowed(profileName())) return 0
  try {
    if (!needsSample(list())) return 0
    const rows = sampleRows(Date.now())
    for (const r of rows) {
      const chat = SAMPLE_CHATS.find((c) => c.id === r.id)
      writeFileSync(join(dir(), `${r.id}.json`), JSON.stringify(r), 'utf8')
      if (chat) writeFileSync(join(dir(), `${r.id}.log`), sampleLog(chat), 'utf8')
    }
    return rows.length
  } catch {
    // An unwritable profile is not worth failing a tour step for - the list is simply empty.
    return 0
  }
}

/** Take them away again. Called when the tour ends, and safe to call when there are none. */
export function dropSample(): number {
  if (!tourAllowed(profileName())) return 0
  try {
    const ids = sampleIds(list())
    for (const id of ids) remove(id)
    return ids.length
  } catch {
    return 0
  }
}
