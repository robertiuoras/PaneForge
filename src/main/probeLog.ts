// TEMPORARY instrumentation for the Stash-drag activation measurement. Delete after.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

let path: string | null = null

export function probeLog(label: string, extra: Record<string, unknown> = {}): void {
  try {
    if (!path) path = join(app.getPath('userData'), 'activation-probe.log')
    appendFileSync(path, JSON.stringify({ t: Date.now(), label, ...extra }) + '\n')
  } catch {
    /* a probe must never throw */
  }
}
