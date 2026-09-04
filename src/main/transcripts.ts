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

import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Claude Code and Antigravity keep transcripts we can name a session from. */
const SUPPORTED = new Set(['claude', 'antigravity'])

/** Antigravity's own home. The env override exists for the test, which must not read
 * the real machine's history file. */
function agyHome(): string {
  return process.env.PF_GEMINI_HOME || join(homedir(), '.gemini')
}

function antigravityHistoryFile(): string {
  return join(agyHome(), 'antigravity-cli', 'history.jsonl')
}

function antigravityTranscriptFile(conversationId: string): string | null {
  if (!conversationId || /[\\/]/.test(conversationId)) return null
  const f = join(
    agyHome(),
    'antigravity-cli',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )
  if (existsSync(f)) return f
  const db = join(agyHome(), 'antigravity-cli', 'conversations', `${conversationId}.db`)
  if (existsSync(db)) return db
  return null
}

function sameCwd(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  }
}

/**
 * Lines a pane has actually submitted, newest last, so a conversation can be PROVED.
 *
 * Antigravity keeps one flat `history.jsonl` for the whole machine, so the only things a
 * row carries are the folder and the moment. That is not identity: anything else running
 * `agy` in that folder - a script, another pane, a cron job - writes rows that are newer
 * than the pane's own, and "newest row in this folder" hands the pane somebody else's
 * chat. Measured 2026-09-01: `clients-b/tools/backdrop-gen.mjs` runs `agy` headlessly in
 * `~/Projects/clients-b`, and the pane there adopted its conversation `96d46b7a` - three
 * asks, none of them the work the pane had done. History showed the script's transcript
 * and a restore would have resumed it.
 *
 * So a pane adopts a conversation only when one of that conversation's `display` rows is
 * a line this pane is known to have typed. The feed is the same keystroke path
 * `promptArchive` and History's one-line note run off, so it costs nothing new. A pane
 * that can prove nothing reports NO conversation, which is the honest answer: a plausible
 * wrong one is worse than none.
 */
const submitted = new Map<string, string[]>()

/** Enough recent lines to recognise a pane, few enough that a long pane costs nothing. */
const SUBMITTED_KEEP = 40

/** A line long enough that two panes agreeing on it is not a coincidence. */
const MIN_PROOF_CHARS = 8

function normalisePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A pane submitted a line. Fed from the same place History's note is. */
export function noteSubmittedPrompt(id: string, text: string): void {
  const line = normalisePrompt(text || '')
  if (line.length < MIN_PROOF_CHARS) return
  const lines = submitted.get(id) || []
  if (lines[lines.length - 1] === line) return
  lines.push(line)
  while (lines.length > SUBMITTED_KEEP) lines.shift()
  submitted.set(id, lines)
}

/**
 * Whether a `display` row is one of this pane's own lines.
 *
 * Not equality alone: an agent CLI may write back a shortened version of a long ask, so a
 * row that is a prefix of a line the pane typed (or the other way round) counts - but only
 * once it is long enough that the agreement means something.
 */
function saidByPane(display: string, lines: string[]): boolean {
  const row = normalisePrompt(display)
  if (row.length < MIN_PROOF_CHARS) return false
  for (const line of lines) {
    if (row === line) return true
    const short = row.length < line.length ? row : line
    const long = row.length < line.length ? line : row
    if (short.length >= MIN_PROOF_CHARS && long.startsWith(short)) return true
  }
  return false
}

function antigravityConversationFor(paneId: string, cwd: string, since: number): string | null {
  const lines = submitted.get(paneId)
  // Nothing typed yet is not "adopt whatever is there" - it is nothing to go on.
  if (!lines || !lines.length) return null
  const hFile = antigravityHistoryFile()
  if (!existsSync(hFile)) return null
  try {
    const text = tail(hFile)
    const rows = text.split('\n').filter(Boolean)
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(rows[i]) as {
          workspace?: string
          conversationId?: string
          timestamp?: number
          display?: string
        }
        if (!row.conversationId || !row.workspace || !sameCwd(row.workspace, cwd)) continue
        if (since && row.timestamp && row.timestamp < since - START_SLACK_MS) continue
        if (!row.display || !saidByPane(row.display, lines)) continue
        return row.conversationId
      } catch {
        continue
      }
    }
  } catch {
    /* fallback to null */
  }
  return null
}

/** A transcript touched before this much slack around the pane's start is not its own. */
const START_SLACK_MS = 60_000

/** The tail of a transcript that has to hold the last prompt. Some are tens of MB. */
const TAIL_BYTES = 256 * 1024

/** The head of a transcript that has to hold its opening records. */
const HEAD_BYTES = 256 * 1024

/**
 * How long a brand-new transcript is allowed to be undecided about how it began.
 *
 * `opening()` answers `unknown` for two different files: one written by a CLI with no
 * SessionStart hook, which will never say more, and one born a second ago whose hook
 * record has not been flushed yet. The second is the dangerous one - it is a chat
 * somebody has just LAUNCHED, and reading its silence as "not a startup" is how a pane
 * walks into it. Measured on this desk 2026-08-26: a pane opened at 12:50 in
 * `clients-b`, and the `clients-a` pane that had been running since 01:51 claimed its
 * conversation within the minute. So an undecided file younger than this is left alone
 * and asked again on the next sweep, by which time the head is written.
 */
const OPENING_GRACE_MS = 15_000

/** Enough of a prompt to recognise the work, short enough for one line of a dialog. */
const PROMPT_CHARS = 220

interface Started {
  cwd: string
  agent: string
  at: number
  /** the transcript this pane held when it last said it had moved, if it held one */
  prior?: string
}

const started = new Map<string, Started>()
/** paneId -> transcript file it has taken, so two panes on one repo never share one. */
const claimed = new Map<string, string>()
/**
 * Transcripts a pane has moved OFF, which nothing may drift onto.
 *
 * A claim being dropped is not the same as a conversation being free. When a pane
 * `/clear`s, the conversation it leaves behind is unclaimed and newer than whatever the
 * other pane on that folder is in - so without this the other pane would adopt it, which
 * is the exact drift `transcriptFor` was made sticky to prevent.
 */
const released = new Set<string>()
/**
 * Panes whose claim is known to be the conversation they are actually in.
 *
 * A pane is settled once it holds a conversation that BEGAN after the pane last said it
 * had moved. Until then its claim is a guess made in a gap: `/clear` re-notes the pane the
 * moment the command is submitted, seconds before the CLI has written a single line of the
 * new transcript, so at that instant the newest file in the folder is the one being
 * abandoned and the pane takes it straight back. Only an unsettled pane ever changes its
 * mind, which is what stops a settled one drifting onto a neighbour's chat.
 */
const settled = new Set<string>()

/** Claude Code's folder name for a working directory. Exported for handoff, which
 * writes a transcript from another machine where the CLI here will look for it.
 * The env override exists for the handoff test, which must not touch the real one. */
export function projectDir(cwd: string): string {
  const base = process.env.PF_CLAUDE_HOME || join(homedir(), '.claude')
  const dir = join(base, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  // ...through any symlink, because a lane's folder is routinely one.
  //
  // A worktree gets its own name here (`...-assistant-a`), and on this machine those are
  // SYMLINKS to the project's own folder, so a chat in a lane writes its transcript into
  // the same directory as one in the main checkout. That is fine and deliberate - it is
  // one project's history. What was not fine is that every claim below compares PATHS: the
  // same file reached through `-assistant`, `-assistant-a` and `-assistant-b` is three
  // different strings, so `taken` deduped nothing and all three panes claimed the newest
  // transcript at once. Measured on this desk: three `assistant` panes reporting one
  // conversation id (9994a3c5), which made the lane board pick a pane by array order and
  // would have reopened three panes into ONE conversation. Resolving here is enough,
  // because every path in this file is built from it.
  try {
    return realpathSync(dir)
  } catch {
    // Not there yet - a folder no chat has ever run in. The unresolved path is still the
    // right answer and existsSync below will say so.
    return dir
  }
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

/**
 * True while a transcript belongs to a session someone is sitting in front of.
 *
 * Headless runs (`claude -p ...`) file their transcript in the same per-cwd folder as
 * the real session, and they finish AFTER it: the /clear handoff writer, and the
 * app-driven runs, which are given the repo as their cwd because they have
 * to edit it. So the newest transcript in a folder is quite often a robot's, and it is
 * newest at exactly the moment a pane re-picks - which is what /clear makes it do.
 * Claiming one put the pane's resume id on a machine conversation: reopening the desk
 * brought the pane back up inside a Haiku handoff distill, on that run's model, which
 * is what "Claude Code keeps turning into Haiku" turned out to be.
 *
 * The marker is `"type":"mode"`. An interactive session writes one in its first lines
 * and again on every turn; a `-p` run never writes one at all. Only the head is read,
 * because transcripts run to tens of megabytes.
 */
function interactive(file: string): boolean {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.toString('utf8', 0, n).includes('"type":"mode"')
  } catch {
    // Unreadable is not evidence of anything. Falling back to "yes" keeps the old
    // behaviour rather than silently refusing to ever resume this pane.
    return true
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/**
 * The folder a conversation was actually held in, when the file says.
 *
 * Every timestamp rule below exists to tell apart panes that share a history folder, and
 * they share it far more often than the folder name suggests: a lane worktree's project
 * directory is a SYMLINK to the trunk's, so `clients`, `clients-a`, `clients-b` and
 * `clients-c` are one directory under four names. Four panes then disambiguate by clock
 * alone - and on 2026-08-26 they got it wrong in both directions at once: the desk was
 * written with the `clients` pane (`pizzasrus`) and the `clients-a` pane (`piateam`) both
 * holding transcripts recorded in `clients-b`, while the `clients-b` pane (`sonia`) held
 * none at all and came back on `--continue`, inside somebody else's work.
 *
 * Claude Code writes its own `cwd` into the first few records, which is the fact those
 * rules were guessing at. A file that states a different folder is not this pane's,
 * whatever the clocks say. A file that states nothing is left to the rules as before -
 * this refuses, it never elects.
 */
export function heldElsewhere(file: string, cwd: string): boolean {
  const said = wroteIn(file)
  if (!said || !cwd || said === cwd) return false
  // Narrow on purpose: the refusal is for a SIBLING sharing this history folder, which
  // is the whole failure. A transcript stating a path this machine files somewhere else
  // is a pane handed here from another device - the receiver writes that file into its
  // own folder deliberately, and refusing it would lose the conversation it came for.
  return projectDir(said) === projectDir(cwd)
}

function wroteIn(file: string): string | null {
  const hit = cwds.get(file)
  if (hit !== undefined) return hit
  let fd = -1
  let said: string | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n))
    if (m) said = m[1].replace(/\\(.)/g, '$1')
  } catch {
    said = null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
  // A file whose head has not been flushed yet says nothing, and it is about to. Only a
  // real answer is remembered: caching the silence would pin a newborn chat as anonymous
  // for the rest of the app's run, which is the one case this exists to decide.
  if (said) cwds.set(file, said)
  return said
}

/** What each transcript said its folder was. A conversation never changes folder. */
const cwds = new Map<string, string>()

/**
 * How a conversation began, when the file says: `clear` for one started by `/clear` or
 * `/compact` inside a pane nobody restarted, `startup` for a CLI somebody launched.
 *
 * The app watches for `/clear` being TYPED (sessions.ts, on submit) and re-notes the pane
 * so it may move. That misses the way the command is usually run: picking it out of the
 * CLI's completion menu submits a line whose letters the app never saw, so the pane stays
 * pinned to a conversation that stopped existing. It is not cosmetic - lane holds are
 * recorded against the CHAT id, so the pane went on publishing a dead id, the lane engine
 * went on believing that chat was alive, and the pane's own new chat was handed a WORKTREE
 * and told another chat was in the repo. It was itself, before the clear.
 *
 * A session with no SessionStart hook configured says nothing, which is `unknown` and
 * deliberately not read as either: the decision goes back to the quiet-gap rule in
 * `movedTo`, which is what every pane used before this existed. Only `startup` is a
 * refusal, and only that is worth a false negative - it is a second CLI launched in the
 * same folder, and adopting it would move a pane into somebody else's conversation.
 */
function opening(file: string): 'clear' | 'startup' | 'unknown' {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      const said = /"hookName":"SessionStart:(\w+)"/.exec(line)
      // `resume` is a launch like any other: it is a process somebody started, and the
      // pane that meant it passes its id through noteSession rather than being guessed at.
      if (said) return said[1] === 'clear' || said[1] === 'compact' ? 'clear' : 'startup'
      // Past the opening records, everything is the conversation's own text - and a chat
      // that PRINTS a hook name (this file's tests do, and so does any chat about lanes)
      // must not read as one. Attachments are hook output, so they are still opening.
      if (/"type":"(user|assistant)"/.test(line) && !line.includes('"attachment"')) break
    }
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/**
 * A pane started, restarted, or changed conversation: from here on it owns one.
 *
 * `resumeId` is the conversation it was started ON, and passing it settles the pane
 * immediately instead of leaving it to work out which file is its own. That matters for
 * a reopened desk: the resumed conversation was written yesterday, so every rule based on
 * "newer than this pane" would decide the pane had moved on the first new chat in that
 * folder - and take somebody else's.
 */
export function noteSession(id: string, cwd: string, agent: string, resumeId?: string): void {
  started.set(id, { cwd, agent, at: Date.now(), prior: claimed.get(id) })
  claimed.delete(id)
  settled.delete(id)
  const file = resumeId ? transcriptPath(cwd, resumeId) : null
  if (file) {
    claimed.set(id, file)
    settled.add(id)
    released.delete(file)
  }
}

export function forgetSession(id: string): void {
  started.delete(id)
  claimed.delete(id)
  settled.delete(id)
}

/**
 * The transcript file this pane is writing, or null while it has not written one yet.
 *
 * A claim sticks until the pane says it has moved (noteSession - a restart), the file is
 * deleted, or the pane is seen moving on its own: `/clear` starts a whole new conversation
 * inside a pty nobody restarted, so nothing tells us. The rule that looks more natural,
 * "whichever is newest that nobody else has", is wrong in a way a test caught: two panes on
 * one repo, the second one clears, and the FIRST pane then drifts onto the conversation the
 * second one just abandoned, because it is newer than its own and no longer claimed. It
 * would then be offered back under the wrong pane's name, with the wrong work in it.
 *
 * So the claim follows a clear, and an abandoned conversation is `released` rather than
 * freed - the drift the sticky rule existed to stop is stopped by naming it, not by
 * refusing to ever move. Staleness was not cosmetic: lane holds are recorded against the
 * CHAT id, so a pane one `/clear` old owned no lane at all. Its card said nothing, and its
 * lane was drawn under "lanes elsewhere" while the pane sat two inches below.
 */
export function transcriptFor(id: string): string | null {
  const s = started.get(id)
  if (!s || !SUPPORTED.has(s.agent)) return null
  if (s.agent === 'antigravity') {
    const mine = claimed.get(id)
    if (mine && existsSync(mine)) return mine
    const convId = antigravityConversationFor(id, s.cwd, s.at)
    if (convId) {
      const f = antigravityTranscriptFile(convId) || convId
      claimed.set(id, f)
      settled.add(id)
      return f
    }
    return null
  }
  const dir = projectDir(s.cwd)
  if (!existsSync(dir)) return null
  const mine = claimed.get(id)
  const taken = new Set([...claimed].filter(([k]) => k !== id).map(([, v]) => v))
  if (mine && existsSync(mine)) {
    // A settled pane is one that has been told nothing about moving, so it moves only on
    // the new conversation's own word that it is a clear. Without that word it stays put:
    // "newest unclaimed file in this folder" is any chat at all, which is the drift that
    // made this sticky in the first place.
    const next = movedTo(id, s, mine, taken, settled.has(id))
    if (!next) return mine
    // The old one is not handed to anybody: it is this pane's history, not a free chat.
    released.add(mine)
    claimed.set(id, next)
    settled.add(id)
    return next
  }
  // Newest first, and only conversations BORN since this pane started: an older one in
  // the same folder belongs to whoever had it, not to whoever opened a pane last.
  //
  // The gate reads `birth`, never the sort key. `transcripts()` sorts by mtime, which is
  // right for "newest activity first" and catastrophic as an eligibility test: a live chat
  // in that folder is rewritten on every turn, so its mtime is ALWAYS newer than a pane
  // that just opened. And `taken` only knows panes THIS app started - a chat running in
  // the installed copy is invisible to a dev copy, and vice versa. Measured 2026-08-23: a
  // fresh pane opened in /Users/robertiuoras/Projects/PaneForge claimed the transcript of
  // the Claude Code session that was driving it, and a hand-off then shipped that 309KB
  // file to the PC, where the pane resumed somebody else's conversation and sat frozen
  // mid-turn showing its tool output. `movedTo` had this right at the other call site.
  const pick = transcripts(dir).find(
    (t) =>
      birth(t.file) >= s.at - START_SLACK_MS &&
      !taken.has(t.file) &&
      !released.has(t.file) &&
      // A conversation somebody LAUNCHED is never a pane's continuation. `movedTo` has
      // refused one since the day it was written and this branch did not, so the pane
      // with no claim - a restored one, or one whose chat was deleted - took the newest
      // file in the folder whatever it was. That is the whole bug: on 2026-08-26 the
      // `clients-a` pane adopted the chat of a pane opened 11 hours later in `clients-b`,
      // and the desk snapshot then offered to reopen it inside somebody else's work.
      !launchedElsewhere(t.file, s) &&
      !heldElsewhere(t.file, s.cwd) &&
      !bornForAnotherPane(id, s, t.file) &&
      interactive(t.file)
  )
  if (!pick) return null
  claimed.set(id, pick.file)
  // A pane that has just cleared lands here and the only file to be had is the one it is
  // leaving: it is still the pane's conversation until the new one exists, so taking it
  // is right, but it is not the answer and the pane stays free to move once one appears.
  // Recognised by name rather than by age - the gap between the re-note and the CLI's
  // first line is however long the CLI takes, and a rule with a clock in it is a rule
  // that is right on a slow machine and wrong on a fast one.
  if (pick.file !== s.prior) settled.add(id)
  return pick.file
}

/** When a file was created, or its last write if the platform will not say. */
function birth(file: string): number {
  try {
    const st = statSync(file)
    return st.birthtimeMs || st.mtimeMs
  } catch {
    return 0
  }
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * True while a transcript is somebody ELSE's launch, rather than this pane's own.
 *
 * `opening()` reads the file's own SessionStart record. `clear` is a pane continuing
 * itself and is always adoptable. `startup` is a CLI somebody launched: it belongs to
 * the pane that was starting at that moment, so it is adoptable only inside this pane's
 * own launch window and is a flat refusal outside it - which is the bug, an 11-hour-old
 * pane taking a chat born a minute ago in another lane. `unknown` is the awkward one: a
 * CLI with no SessionStart hook says nothing ever, and a file born a second ago has not
 * flushed its record yet, so an undecided NEWBORN is read as a launch until it answers
 * (OPENING_GRACE_MS) and an undecided old file is left to the quiet-gap rules.
 */
function launchedElsewhere(file: string, s: Started): boolean {
  const said = opening(file)
  if (said === 'clear') return false
  const mine = birth(file) <= s.at + START_SLACK_MS
  if (said === 'startup') return !mine
  return !mine && Date.now() - birth(file) < OPENING_GRACE_MS
}

/**
 * True while another pane in the same project has a better claim on this file than we do.
 *
 * A pane that has started and holds no transcript yet is a pane whose conversation is
 * still being written. Anything born after it started in that project's folder is far
 * more likely to be its own than an older pane's, so it is not free to be adopted. This
 * is the guard that does not depend on a hook being configured.
 */
function bornForAnotherPane(id: string, s: Started, file: string): boolean {
  const born = birth(file)
  const dir = projectDir(s.cwd)
  for (const [other, o] of started) {
    if (other === id) continue
    if (projectDir(o.cwd) !== dir) continue
    if (claimed.has(other)) continue
    if (o.at <= born + START_SLACK_MS && o.at > s.at) return true
  }
  return false
}

/**
 * The conversation this pane has moved into since it claimed its own, or null.
 *
 * A `/clear` looks like exactly one thing on disk: the claimed transcript stops being
 * written, and a new one is born a moment later. Measured on a real pane - old chat last
 * written 10:45:49, new chat born 10:45:55.
 *
 * The only hard part is two panes on ONE folder, where that new file could belong to
 * either. It belongs to whichever of them stopped writing just before it appeared: a pane
 * that is still in its own conversation goes on writing, so its transcript's last write is
 * later than the newcomer's birth, while the pane that cleared froze a second before it.
 * So a rival whose transcript went quiet in that gap, later than mine did, is the one that
 * moved and this pane stays where it is.
 */
function movedTo(
  id: string,
  s: Started,
  mine: string,
  taken: Set<string>,
  said: boolean
): string | null {
  const mineAt = mtime(mine)
  const cand = transcripts(projectDir(s.cwd)).find(
    (t) =>
      t.file !== mine &&
      !taken.has(t.file) &&
      !released.has(t.file) &&
      // What the file says about how it began: proof for a pane that was never told it
      // moved, and a veto for every pane - no conversation a person launched is a pane's
      // continuation, however well the clocks line up.
      (said ? opening(t.file) === 'clear' : opening(t.file) !== 'startup') &&
      // Born after this pane said it had moved, and after the last line was written to the
      // conversation it is leaving. Both, because "newer" alone is any live chat in the
      // folder, and a pane is not allowed to walk into one of those.
      birth(t.file) >= s.at - START_SLACK_MS &&
      birth(t.file) >= mineAt &&
      // A `/clear` keeps the pane where it is standing, so the new conversation states
      // this pane's folder. One stating a sibling lane is another pane's clear.
      !heldElsewhere(t.file, s.cwd) &&
      interactive(t.file)
  )
  if (!cand) return null
  const born = birth(cand.file)
  // Two panes on one folder that both cleared are both looking at this file. It belongs
  // to whichever of them went quiet LAST before it was born.
  for (const [other, o] of started) {
    // Settled rivals count too, now that being settled no longer means a pane can never
    // have moved: the pane that went quiet in the gap is the one that cleared, whether or
    // not anybody told either of them about it.
    // Same PROJECT, not the same cwd string. A lane worktree's project folder is a
    // symlink to the trunk, so `clients`, `clients-a` and `clients-b` are one history
    // in three names, and comparing cwd left every cross-lane rival invisible - which is
    // exactly the pair this went wrong on.
    if (other === id || projectDir(o.cwd) !== projectDir(s.cwd)) continue
    const theirs = claimed.get(other)
    if (!theirs) continue
    const at = mtime(theirs)
    if (at > mineAt && at <= born) return null
  }
  return cand.file
}

/** The conversation id to resume this pane with - the transcript's own file name. */
export function resumeIdFor(id: string): string | undefined {
  const s = started.get(id)
  if (s?.agent === 'antigravity') {
    const claimedFile = claimed.get(id)
    if (claimedFile) {
      const m = /([0-9a-fA-F-]{36})/.exec(claimedFile)
      if (m) return m[1]
      return basename(claimedFile, '.jsonl')
    }
    const convId = antigravityConversationFor(id, s.cwd, s.at)
    if (convId) return convId
  }
  const file = transcriptFor(id)
  return file ? basename(file, '.jsonl') : undefined
}

/** Where a remembered conversation id lives, if it is still on disk. */
export function transcriptPath(cwd: string, resumeId: string): string | null {
  if (!cwd || !resumeId || /[\\/]/.test(resumeId)) return null
  const file = join(projectDir(cwd), `${resumeId}.jsonl`)
  if (existsSync(file)) return file
  const agy = antigravityTranscriptFile(resumeId)
  if (agy) return agy
  return null
}

/**
 * A transcript the CLI will agree to resume: one holding at least one assistant turn.
 *
 * `claude --resume <id>` answers `No conversation found with session ID` for a file
 * that exists but has no reply in it - a session whose first prompt was typed and never
 * sent. Measured 2026-09-04 (pane `Step Tick Doesnt Show`): an auto-clear typed `/clear`,
 * the resume prompt's six returns were swallowed while Remote Control re-bridged, and the
 * fresh conversation was written to disk as 5 user rows and 0 assistant rows. History's
 * `Open again` then handed that id to the CLI, which refused it on screen. The reading
 * is the file's own rows; cached on size+mtime because a restore asks about every pane.
 */
const replies = new Map<string, { size: number; mtimeMs: number; yes: boolean }>()
export function hasReply(file: string): boolean {
  let st: { size: number; mtimeMs: number }
  try {
    st = statSync(file)
  } catch {
    return false
  }
  const hit = replies.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.yes
  let yes = false
  try {
    yes = /"type":"assistant"/.test(readFileSync(file, 'utf8'))
  } catch {
    yes = false
  }
  replies.set(file, { size: st.size, mtimeMs: st.mtimeMs, yes })
  return yes
}

/** Where a conversation the CLI can resume lives - on disk AND answered at least once. */
export function resumableTranscript(cwd: string, resumeId: string): string | null {
  const file = transcriptPath(cwd, resumeId)
  return file && hasReply(file) ? file : null
}

/** True while a remembered conversation can still be resumed. */
export function resumable(cwd: string, resumeId?: string): boolean {
  return Boolean(resumeId && resumableTranscript(cwd, resumeId))
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
    if (!line.startsWith('{')) continue
    let rec: {
      type?: string
      isSidechain?: boolean
      message?: { role?: string; content?: unknown }
      content?: unknown
    }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type === 'USER_INPUT' && typeof rec.content === 'string') {
      const cleaned = rec.content
        .replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/, '$1')
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
        .trim()
      if (cleaned) return clean(cleaned)
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
