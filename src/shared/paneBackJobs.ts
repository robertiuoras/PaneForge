// What an AGENT pane is still running when its turn is over.
//
// `shared/paneJob.ts` answers this for a SHELL pane and refuses to answer it for an agent
// one, and that refusal is load-bearing: it feeds `busyOnScreen`, so a false job there is a
// pane the idle sweep never closes, the budget never hands off, and whose clock is a lie
// that ticks. This file is the cosmetic half of the same question and feeds NOTHING - a
// chip on the card and a sentence on its hover. Being wrong here costs a glance.
//
// The reading exists because an agent pane that started work in the background reads as
// finished: `run_in_background` shells and Monitor loops outlive the turn, the CLI's footer
// has gone quiet, `engaged` is false, and the card says the pane is done while a build, a
// tail or a poller is still going.
//
// **A count of the pty's descendants is NOT the reading, and the measurement is why.**
// Every `claude` pane on this desk holds, permanently and from the moment it starts:
// `/usr/bin/safaridriver --mcp`, `chrome-devtools-mcp` (with a node child), `codegraph
// serve --mcp` (with three), and `caffeinate -i -t 300`. Measured 2026-08-24 over four live
// panes: tree sizes 5, 7, 9 and 9 with nothing whatever running. So "descendants minus the
// CLI" is 3-8 for an idle pane and a chip built on it is on for ever, which is a chip
// nobody reads.
//
// What separates the two is HOW the process was started, not what it is. Every command an
// agent CLI runs goes through a shell it spawns with `-c` - on this machine
// `/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-*.sh ... && <the command>` - while
// an MCP server and `caffeinate` are spawned directly, with no shell anywhere. So a job is
// a SHELL SUBTREE under the pty, and the machinery is everything else. Measured against
// the same four panes: the two real background tasks (`tail -f` at 39:10, `tail -f` at
// 00:02) are the only shell subtrees in the whole set, and all seven MCP/caffeinate
// processes are excluded by the rule rather than by a name.
//
// The age floor is `shared/backJobs.ts`'s and for its reason: a foreground Bash call is a
// shell subtree too, and this repo fires several per prompt - measured at 00:00 and 00:02
// against the 39:10 of the real one. A list that flickers once a second is one nobody
// trusts. A foreground command that outlives the floor is counted and that is correct: the
// pane IS running it, and while the turn is live the card already says so anyway.
//
// `npm run test:panebackjobs`.

import { SHELLS, commandName, programName } from './paneJob'

/**
 * How long a shell subtree has to have been alive before it is called a job.
 *
 * The same 30s `backJobs.LOOP_MIN_SECONDS` uses, kept as its own constant rather than
 * imported so this module pulls in nothing (that one reaches the agent catalogue, the dev
 * server rules and the port parser, all of which would then be in the renderer's chunk for
 * a number).
 */
export const JOB_MIN_SECONDS = 30

/** One process, reduced to what the rule below asks about. */
export interface JobRow {
  pid: number
  ppid: number
  /** the whole command line - the executable name alone cannot see the `-c` */
  cmd?: string
  /** seconds alive, when the table gave one */
  elapsed?: number
}

/** One thing a pane is still running. */
export interface PaneBackJob {
  pid: number
  /** what to print: the command the shell was told to run, never the shell */
  label: string
  /** seconds alive, when the table gave one */
  elapsed?: number
}

/**
 * A shell invoked to run something, rather than to sit at a prompt.
 *
 * The flag rather than the presence of arguments: a login shell is `-zsh` and an
 * interactive one started with `--no-rcs` has arguments and no command.
 */
export function isCommandShell(cmd: string | undefined): boolean {
  if (!cmd) return false
  const name = commandName(cmd)
  if (!name || !SHELLS.has(name.toLowerCase())) return false
  return /(?:^|\s)(?:-c|\/c|\/k|-Command|-EncodedCommand)(?:\s|$)/i.test(cmd)
}

/**
 * What a CLI does to a shell before it runs anything in it, which is not the job.
 *
 * The measured prelude is `source <snapshot> 2>/dev/null || true && <command>`; without
 * this list the answer is `source`.
 */
const HOUSEKEEPING = new Set([
  'source',
  '.',
  'true',
  ':',
  'export',
  'cd',
  'set',
  'setopt',
  'unset',
  'unalias',
  'shopt',
  'alias'
])

/**
 * Words that stand IN FRONT of the job rather than instead of it.
 *
 * These are the other half of HOUSEKEEPING and they must not be treated the same way. A
 * housekeeping word owns its whole segment - `source <snapshot>` is followed by the
 * snapshot path, and skipping the word instead of the segment answers
 * `snapshot-zsh-<n>.sh`. A PREFIX word is followed by the real command, so skipping the
 * segment throws away the one thing being looked for.
 *
 * Measured on this desk 2026-08-28, a live pane's card read `running builtin`. Claude
 * Code's shell prelude here is
 *
 *     source <snapshot> 2>/dev/null || true
 *       && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true
 *       && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true
 *       && eval <the actual script> < /dev/null
 *       && pwd -P >| /tmp/claude-<n>-cwd
 *
 * so two defects compounded: `\builtin` was in neither set and won, and `eval` was
 * housekeeping, which discarded the only segment naming the job.
 */
const PREFIX = new Set(['eval', 'env', 'exec', 'command', 'builtin', 'nohup', 'time', 'nice', 'sudo'])

/**
 * Shell grammar, which is never the name of anything.
 *
 * `eval` is a PREFIX, so the word after it is taken as the job - and when the thing being
 * evaluated is a loop rather than a command, that word is the loop. Measured live
 * 2026-08-29 against a real background poller in a pane on this desk, the card read
 * `'for`: the quote survived the strip and the loop word was in no list. Both halves
 * are fixed here - the quote comes off with the braces, and a keyword is stepped OVER
 * rather than owning its segment the way a housekeeping word does, because the job is
 * further along the same line.
 */
/**
 * A keyword that HEADS a control structure, and so owns the rest of its line.
 *
 * `for i in $(seq 1 120)` names a counter and a range; there is no job anywhere in it, and
 * stepping over the keyword answers `i`, which is what this printed before the split.
 */
const KEYWORD_HEADS = new Set([
  'for',
  'while',
  'until',
  'if',
  'case',
  'select',
  'function'
])

/**
 * A keyword that is only punctuation between the header and the work.
 *
 * `do bash <script>` is the job with a marker in front of it, so this half is stepped over
 * the way a PREFIX word is.
 */
const KEYWORD_MARKS = new Set([
  'do',
  'done',
  'then',
  'else',
  'elif',
  'fi',
  'esac',
  'in',
  'return',
  'break',
  'continue'
])

/**
 * Runtimes whose own name says nothing about the work.
 *
 * `node /Users/.../next dev -p 3009` printed as `node` is the same non-answer as printing
 * a shell: the script is the job. Measured on this desk, a dev server three processes deep
 * is exactly this shape.
 */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python2', 'python3', 'ruby', 'perl', 'php'])

/**
 * The program a command line is really running: the script rather than the interpreter.
 */
export function workName(cmd: string): string {
  const first = commandName(cmd)
  if (!first || !RUNTIMES.has(first.toLowerCase())) return first
  const rest = (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).slice(1).map((w) => w.replace(/^["']|["']$/g, ''))
  const arg = rest.find((w) => w && !w.startsWith('-'))
  return arg ? programName(arg) : first
}

/**
 * The words a shell subtree should be printed as.
 *
 * The `-c` STRING first, because it is what somebody actually typed and the live leaf often
 * is not: `npm run dev` is three processes deep by the time it is serving and its leaf is
 * `node .../next dev`, which prints as `node` - a word that names nothing on a card.
 *
 * The FIRST segment that is not shell housekeeping, never the last. The measured prelude is
 * `source ~/.claude/shell-snapshots/snapshot-zsh-<n>.sh 2>/dev/null || true && <the
 * command>`, so taking the last segment is right there and wrong the moment the command
 * itself has more than one part: `sleep 400; true` measured live as a job called `true`.
 *
 * The oldest non-shell descendant is the fallback, for a `-c` string that is nothing but
 * that prelude. Its own children are somebody else's reading.
 */
export function jobLabel(rows: JobRow[], shell: JobRow): string {
  const cmd = shell.cmd ?? ''
  const at = cmd.search(/(?:^|\s)(?:-c|\/c|\/k|-Command|-EncodedCommand)(?:\s|$)/i)
  if (at >= 0) {
    const script = cmd.slice(at).replace(/^\s*\S+\s*/, '')
    // A newline separates statements exactly as `;` does - and `ps` prints one as the four
    // characters `\012`, which is the shape this reading actually arrives in. An `eval` of a shell
    // script is routinely several lines - without this the whole body is one segment.
    for (const seg of script.split(/&&|\|\||;|\n|\\012/)) {
      // `env FOO=1 cmd` and a bare assignment are the two shapes that lead with something
      // that is not the program.
      // Walk the segment's words rather than taking only the first: a PREFIX word is
      // followed by the job, so stopping at the first word answers `eval`. A leading
      // backslash is a shell asking for the builtin rather than a function of the same
      // name (`\builtin`), and a brace is grouping, not a program.
      const words = seg
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/^[\\{}('"]+/, '').replace(/['"]+$/, ''))
        // A redirection is not a program. `} >/dev/null 2>&1` is a whole segment of the
        // measured prelude and `programName('>/dev/null')` is the word `null` - which is
        // what a live card actually printed before this filter existed.
        .filter(
          (w) =>
            w &&
            !w.startsWith('-') &&
            !/^\d/.test(w) &&
            /[A-Za-z]/.test(w) &&
            !w.includes('=') &&
            !/[<>|&]/.test(w)
        )
      let hit = ''
      for (const word of words) {
        const name = programName(word)
        if (!name) continue
        const low = name.toLowerCase()
        // A shell or a housekeeping word owns the rest of its segment: whatever follows
        // is that word's argument, not the job.
        if (SHELLS.has(low) || HOUSEKEEPING.has(low)) break
        // A prefix word is in front of the job. Keep reading the same segment.
        if (PREFIX.has(low)) continue
        // A keyword heading a control structure owns its line - a loop header names a
        // counter and a range, never a program.
        if (KEYWORD_HEADS.has(low)) break
        // A marker is punctuation between the header and the work, like a PREFIX word.
        if (KEYWORD_MARKS.has(low)) continue
        hit = name
        break
      }
      if (!hit) continue
      return hit
    }
  }
  const byParent = new Map<number, JobRow[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r)
    else byParent.set(r.ppid, [r])
  }
  let best: JobRow | null = null
  const seen = new Set<number>([shell.pid])
  const queue = [shell.pid]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      queue.push(kid.pid)
      const name = workName(kid.cmd ?? '')
      if (!name || SHELLS.has(name.toLowerCase())) continue
      if (!best || (kid.elapsed ?? 0) > (best.elapsed ?? 0)) best = kid
    }
  }
  return best ? workName(best.cmd ?? '') : commandName(cmd)
}

/**
 * Everything this pane is still running that the app cannot otherwise see.
 *
 * A shell subtree nested inside another one is NOT a second job: `npm run x` that spawns a
 * sub-shell is one thing somebody started, and counting both would double every build.
 */
export function paneBackJobs(
  rows: JobRow[],
  ptyPid: number,
  minSeconds = JOB_MIN_SECONDS
): PaneBackJob[] {
  const floor = minSeconds
  if (!Number.isInteger(ptyPid) || ptyPid <= 0) return []
  const byParent = new Map<number, JobRow[]>()
  const byPid = new Map<number, JobRow>()
  for (const r of rows) {
    byPid.set(r.pid, r)
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r)
    else byParent.set(r.ppid, [r])
  }
  const out: PaneBackJob[] = []
  const seen = new Set<number>([ptyPid])
  // Depth-first from the pty, and a shell subtree is not walked into: everything below one
  // belongs to that job.
  const queue = [ptyPid]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      if (isCommandShell(kid.cmd)) {
        if ((kid.elapsed ?? 0) >= floor) {
          out.push({ pid: kid.pid, label: jobLabel(rows, kid), elapsed: kid.elapsed })
          continue
        }
        // Under the floor: still not walked into. A hook's own children are a hook.
        continue
      }
      queue.push(kid.pid)
    }
  }
  return out.sort((a, b) => (b.elapsed ?? 0) - (a.elapsed ?? 0))
}

/**
 * The chip's words, or '' when there is nothing to say.
 *
 * One job is named, several are counted: `tail` says which, and `3 jobs` on a card 190px
 * wide is the only shape three names fit into.
 *
 * **The verb is not decoration.** The words were the bare program name, so a card whose
 * turn had finished carried a chip reading `build` next to a stopped clock, and it was
 * reported twice as "I still don't know what it's for" - a word with no verb beside it
 * reads as a label for the pane, not as something happening now. `running <name>` is the
 * sentence a SHELL pane's own row already uses for the same fact (`paneJob`), so the two
 * readings of "this pane is running something" say it the same way rather than inventing
 * a second vocabulary. The hover carries the rest, and this stays short because the card
 * is 190px: two words for one job, two for many.
 */
export function jobWords(jobs: PaneBackJob[]): string {
  if (!jobs.length) return ''
  if (jobs.length === 1) return `running ${jobs[0].label || 'a job'}`
  return `running ${jobs.length}`
}
