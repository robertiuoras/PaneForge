import { readsBusy, composerHeld } from './busy'

/**
 * Whether a conversation handed to this machine actually came back up here.
 *
 * Until 2026-09-11 the receiver answered `ok` the moment the pane was SPAWNED, and the
 * sender - unable to tell a resumed conversation from a CLI that printed `No conversation
 * found` and quit - kept its own copy asleep "until the resume is confirmed". Nothing ever
 * confirmed it. So every agent move left two panes wearing one conversation: the asleep
 * original here and the running one over there, drawn as rows 12 and 15 on the same desk.
 * A press woke the original, the two transcripts diverged, and the budget rung sent it
 * again 24 s later - refused over there ("A different conversation file already exists")
 * every 15 minutes for the rest of the day.
 *
 * This is the missing confirmation, as a pure reading of what the started pane is doing:
 *
 * - the process has gone, or the screen names a failed resume -> `failed`; the sender keeps
 *   its pane and says so, because the far end has nothing.
 * - the CLI has printed, gone quiet at an idle composer, and is not mid-turn -> `ok`; the
 *   sender closes its copy, the same way a shell pane's already is.
 * - anything else is `pending` - still booting, still replaying the transcript.
 *
 * `main/sessions.ts` polls this against the live pane; `main/handoff.ts` turns `pending`
 * past `RESUME_CONFIRM_MS` into `unknown`, which is the old behaviour kept on purpose: a
 * slow machine may not cost somebody their conversation.
 */
export const RESUME_CONFIRM_MS = 20_000
export const RESUME_POLL_MS = 250

export type ResumeVerdict = 'ok' | 'failed' | 'pending'

/** What a CLI prints when `--resume <id>` finds nothing, or cannot start at all. */
const RESUME_FAILED = /No conversation found with session ID|no conversation found|Not logged in|session .* not found|could not be resumed/i

export interface ResumeReading {
  /** the pane still has a process behind it */
  alive: boolean
  /** the process has written its first byte */
  printed: boolean
  /** ms since the last byte was written */
  quietMs: number
  /** the newest screen text, ANSI stripped - what `queuePrompt` reads its busy verdict off */
  painted: string
}

export function resumeVerdict(r: ResumeReading, quietFloorMs = 900): ResumeVerdict {
  if (!r.alive) return 'failed'
  if (RESUME_FAILED.test(r.painted)) return 'failed'
  if (!r.printed) return 'pending'
  if (r.quietMs < quietFloorMs) return 'pending'
  if (readsBusy(r.painted) || composerHeld(r.painted)) return 'pending'
  return 'ok'
}
