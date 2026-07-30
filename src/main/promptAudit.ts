// What an improvement cost and what happened to it - and nothing about what it said.
//
// `audit.ts`'s rotation applied to improvement events. The difference is the content
// rule: an attention audit line records a terminal frame, which is the user's own screen.
// A prompt is the user's source code, their unpublished plans and occasionally their
// credentials, so this records **hashes and counts, never text**.
//
// Off by default. Nothing is written until it is asked for, and a log line is refused
// outright if anything in it looks like a live credential - a log is not read before it is
// kept, so "substitute" is the wrong answer there and "refuse" is the right one.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ImproveMetrics } from '../shared/promptBudget'
import { looksSecret } from '../shared/redact'

const MAX_BYTES = 256 * 1024

function logPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'prompt-audit.log')
}

/** Short, non-reversible, and enough to tell two events about the same draft apart. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

export interface PromptAuditEvent extends ImproveMetrics {
  draftHash: string
  improvedHash: string
  /** Characters the user edited after accepting. The honest quality signal. */
  editedChars?: number
  /** Only when the user has ticked "keep the text of prompts I improve". */
  draftText?: string
  improvedText?: string
}

export function recordImprovement(
  metrics: ImproveMetrics,
  draft: string,
  improved: string,
  options: { enabled: boolean; keepText: boolean; editedChars?: number }
): void {
  if (!options.enabled) return
  try {
    const event: PromptAuditEvent = {
      ...metrics,
      draftHash: digest(draft),
      improvedHash: digest(improved)
    }
    if (typeof options.editedChars === 'number') event.editedChars = options.editedChars
    if (options.keepText) {
      // Even with the box ticked: a draft that still looks like it carries a credential is
      // not written. The envelope already held secrets back from the model, but the
      // ORIGINAL is what would be logged here, and that is the copy that still has them.
      if (!looksSecret(draft) && !looksSecret(improved)) {
        event.draftText = draft.slice(0, 4000)
        event.improvedText = improved.slice(0, 4000)
      }
    }

    const line = JSON.stringify({ t: new Date().toISOString(), ...event })
    if (looksSecret(line)) return

    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* first run, or the rotate lost a race */
    }
    appendFileSync(file, line + '\n')
  } catch {
    // Diagnostics must never be the thing that breaks the app they are diagnosing.
  }
}

/** The log, newest last, for Settings' "Show log". Empty when there is none. */
export function readAudit(limit = 200): PromptAuditEvent[] {
  try {
    const text = readFileSync(logPath(), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as PromptAuditEvent)
  } catch {
    return []
  }
}

export function clearAudit(): void {
  for (const p of [logPath(), logPath() + '.1']) {
    try {
      if (existsSync(p)) rmSync(p, { force: true })
    } catch {
      /* nothing to do */
    }
  }
}

export function auditPath(): string {
  return logPath()
}
