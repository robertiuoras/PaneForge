// Which conversation a pane is in.
//
// Reopening a desk used to mean `claude --continue` in each folder: the right agent in
// the right place, carrying on with whatever the NEWEST conversation in that directory
// happens to be. That is the same thing right up until it is not - two panes open on one
// repo both continue the same chat, and a conversation you had in that folder from
// another window an hour later wins over the one that was actually on screen.
//
// Claude Code writes one JSONL per conversation under
// ~/.claude/projects/<path-with-every-non-alphanumeric-as-a-dash>/<session-id>.jsonl, so
// the pane's own conversation can be named rather than guessed: the transcript in that
// folder that has been written to since the pane started and that no other pane has
// claimed. Claiming is what keeps two panes on one repo apart. Nothing is cached for
// long, because /clear starts a whole new transcript mid-pane and the pane should follow
// it - the newest unclaimed file IS the answer, every time it is asked.
//
// The same file answers the other half of "put me back where I was": the last thing you
// typed. A folder name and an agent logo do not tell you what a pane was for; the prompt
// does, which is why the restore dialog shows it.

import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Only Claude Code keeps per-directory transcripts we can name a session from. */
const SUPPORTED = new Set(['claude'])

/** A transcript touched before this much slack around the pane's start is not its own. */
const START_SLACK_MS = 60_000

/** The tail of a transcript that has to hold the last prompt. Some are tens of MB. */
const TAIL_BYTES = 256 * 1024

/** Enough of a prompt to recognise the work, short enough for one line of a dialog. */
const PROMPT_CHARS = 220

interface Started {
  cwd: string
  agent: string
  at: number
}

const started = new Map<string, Started>()
/** paneId -> transcript file it has taken, so two panes on one repo never share one. */
const claimed = new Map<string, string>()

/** Claude Code's folder name for a working directory. */
function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
}

/** The transcripts in a folder, newest write first. */
function transcripts(dir: string): { file: string; at: number }[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        try {
          return { file: join(dir, f), at: statSync(join(dir, f)).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { file: string; at: number } => Boolean(x))
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

/** A pane started (or restarted): from here on it owns one conversation. */
export function noteSession(id: string, cwd: string, agent: string): void {
  started.set(id, { cwd, agent, at: Date.now() })
  claimed.delete(id)
}

export function forgetSession(id: string): void {
  started.delete(id)
  claimed.delete(id)
}

/**
 * The transcript file this pane is writing, or null while it has not written one yet.
 *
 * A claim, once made, sticks until the file is deleted or the pane says it has moved
 * (noteSession again - what `/clear`, `/resume` and a restart all do). The rule that
 * looks more natural, "whichever is newest that nobody else has", is wrong in a way a
 * test caught: two panes on one repo, the second one clears, and the FIRST pane then
 * drifts onto the conversation the second one just abandoned, because it is newer than
 * its own and no longer claimed. It would then be offered back under the wrong pane's
 * name, with the wrong work in it.
 */
export function transcriptFor(id: string): string | null {
  const s = started.get(id)
  if (!s || !SUPPORTED.has(s.agent)) return null
  const dir = projectDir(s.cwd)
  if (!existsSync(dir)) return null
  const mine = claimed.get(id)
  if (mine && existsSync(mine)) return mine
  const taken = new Set([...claimed].filter(([k]) => k !== id).map(([, v]) => v))
  // Newest first, and only files written since this pane started: an older conversation
  // in the same folder belongs to whoever had it, not to whoever opened a pane last.
  const pick = transcripts(dir).find((t) => t.at >= s.at - START_SLACK_MS && !taken.has(t.file))
  if (!pick) return null
  claimed.set(id, pick.file)
  return pick.file
}

/** The conversation id to resume this pane with - the transcript's own file name. */
export function resumeIdFor(id: string): string | undefined {
  const file = transcriptFor(id)
  return file ? basename(file, '.jsonl') : undefined
}

/** Where a remembered conversation id lives, if it is still on disk. */
export function transcriptPath(cwd: string, resumeId: string): string | null {
  if (!cwd || !resumeId || /[\\/]/.test(resumeId)) return null
  const file = join(projectDir(cwd), `${resumeId}.jsonl`)
  return existsSync(file) ? file : null
}

/** True while a remembered conversation can still be resumed. */
export function resumable(cwd: string, resumeId?: string): boolean {
  return Boolean(resumeId && transcriptPath(cwd, resumeId))
}

/**
 * The last thing the user actually typed into a conversation.
 *
 * Only the tail is read: transcripts run to tens of megabytes and every one of them
 * would be read on the launch that shows the restore dialog. A prompt longer than the
 * window is the one case this gives up on, and the answer there is a truncated line
 * anyway.
 */
export function lastPrompt(cwd: string, resumeId?: string): string | undefined {
  const file = resumeId ? transcriptPath(cwd, resumeId) : null
  if (!file) return undefined
  return promptFromTail(tail(file))
}

function tail(file: string): string {
  try {
    const size = statSync(file).size
    if (size <= TAIL_BYTES) return readFileSync(file, 'utf8')
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(TAIL_BYTES)
      const read = readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES)
      // The first line is half a record - the read started mid-file.
      return buf.subarray(0, read).toString('utf8').split('\n').slice(1).join('\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * The last human turn in a stretch of JSONL. Exported for the test: the shapes worth
 * being sure about are the ones the CLI writes as `user` and means something else -
 * a tool result coming back, a slash command, the harness's own caveats, and a
 * subagent's conversation, which is not something the user typed at all.
 */
export function promptFromTail(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.includes('"type":"user"')) continue
    let rec: {
      type?: string
      isSidechain?: boolean
      message?: { role?: string; content?: unknown }
    }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'user' || rec.isSidechain) continue
    const typed = plainText(rec.message?.content)
    if (typed) return typed
  }
  return undefined
}

/** The typed part of a message: a string, or the text blocks of a content array. */
function plainText(content: unknown): string | undefined {
  if (typeof content === 'string') return clean(content)
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    // A tool result is a user-role message nobody typed. One in the array means the
    // whole record is the harness talking back, not a turn.
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'tool_result') {
      return undefined
    }
  }
  const text = content
    .filter((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text')
    .map((p) => String((p as { text?: string }).text ?? ''))
    .join(' ')
  return clean(text)
}

/**
 * Strip the wrappers a turn arrives in and decide whether anything is left. A pane whose
 * last user record was `/clear` should say nothing rather than say "/clear".
 */
function clean(raw: string): string | undefined {
  let s = raw
    // The command wrapper: <command-name>/clear</command-name> and friends.
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, ' ')
    .replace(/<local-command-[\s\S]*?>[\s\S]*?<\/local-command-[a-z]+>/g, ' ')
    // Injected context the app or a hook added around what was typed.
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/^Caveat:[\s\S]*?<\/local-command-caveat>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.startsWith('/')) return undefined
  if (!s || s.length < 2) return undefined
  if (s.length > PROMPT_CHARS) s = s.slice(0, PROMPT_CHARS - 1).trimEnd() + '…'
  return s
}
