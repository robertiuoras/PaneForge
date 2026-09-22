// Reads the model ids the installed Claude CLI knows, straight out of its binary.
//
// The CLI ships every id it can launch as a string, and it updates itself, so this is
// the one source that is never behind the CLI the pane will actually run. The binary is
// ~200 MB, so it is STREAMED once per (path, size, mtime) - a CLI update is a new file
// and gets a fresh read - and never on the main thread's clock: the first call answers
// [] and starts the read, the answer reaches the next `listAgents` through `onNew`, the
// same contract `codexModels.ts` and `orModels.ts` keep. Every failure leaves the
// hand-written list exactly as it was.

import { createReadStream, realpathSync, statSync } from 'node:fs'
import { claudeIdsIn } from '../shared/claudeCatalogue'

let key = ''
let ids: string[] = []
let reading = ''

/** Ids named in the binary at `bin`, or [] until the first read lands. Never throws. */
export function claudeCliModels(bin: string, onNew?: () => void): string[] {
  let path: string
  let stamp: string
  try {
    path = realpathSync(bin)
    const st = statSync(path)
    stamp = `${path}:${st.size}:${st.mtimeMs}`
  } catch {
    return ids
  }
  if (stamp === key || stamp === reading) return ids
  reading = stamp
  const found = new Set<string>()
  let tail = ''
  createReadStream(path, { encoding: 'latin1', highWaterMark: 4 * 1024 * 1024 })
    .on('data', (chunk) => {
      // A 32-char overlap so an id split across two chunks is still seen whole.
      const text = tail + chunk
      for (const id of claudeIdsIn(text)) found.add(id)
      tail = text.slice(-32)
    })
    .on('error', () => {
      if (reading === stamp) reading = ''
    })
    .on('end', () => {
      if (reading !== stamp) return
      reading = ''
      key = stamp
      ids = [...found]
      onNew?.()
    })
  return ids
}
